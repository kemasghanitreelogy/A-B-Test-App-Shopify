import type { Experiment } from "@prisma/client";
import { api, experimentsApiConfigured, projectUrl } from "./experiments.server";
import { VARIANT_KEY, featureProperty, flagKeyFor } from "./taxonomy";
import {
  VIEWPORT_RANGE,
  type BreakdownRow,
  type DailyEngagementRow,
  type HeatmapPoint,
  type HeatmapReplay,
  type HeatmapReplayParams,
  type HeatmapType,
  type HeatmapWidth,
  type HeatmapViewport,
  type PostHogAnalytics,
  type PostHogHeatmap,
  type ProductPageRow,
  type ReplayRow,
  type ScrollBucket,
  type VariantEngagement,
  type VariantHeatmap,
  type VariantKey,
  type WidthBucket,
  widthBucketPx,
  windowClause,
} from "./analytics-types";

/**
 * Analitik perilaku per variant, dibaca dari PostHog lewat HogQL.
 *
 * Semua query di file ini diverifikasi langsung ke project PostHog saat ditulis
 * (tabel `events`, `heatmaps`, `raw_session_replay_events`, properti `session.*`).
 * Kalau PostHog mengubah skemanya, error-nya masuk `errors[]` per bagian dan
 * bagian lain tetap tampil.
 *
 * Variant ditentukan dari properti `$feature/<flag-key>` yang ditempelkan
 * posthog-js di storefront (lihat tl-ab-core.liquid) — bukan dari URL, supaya
 * heatmap dan replay variant B tetap benar walau ?view= hilang dari URL.
 */

const TO_LOCAL: Record<string, VariantKey> = { [VARIANT_KEY.A]: "A", [VARIANT_KEY.B]: "B" };

interface HogQLResponse {
  columns?: string[];
  results?: unknown[][];
}

async function hogql(query: string): Promise<Record<string, unknown>[]> {
  const res = await api<HogQLResponse>("POST", "/query/", { query: { kind: "HogQLQuery", query } });
  const cols = res.columns ?? [];
  return (res.results ?? []).map((row) => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

/** Literal string HogQL. Kutip tunggal digandakan, backslash di-escape. */
function lit(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

/** Nama properti `$feature/<key>` sebagai identifier HogQL (backtick). */
function featureCol(flagKey: string): string {
  return `properties.\`${featureProperty(flagKey).replace(/`/g, "")}\``;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string => (v == null ? "" : String(v));

function sinceOf(experiment: Experiment): Date {
  return experiment.startedAt ?? experiment.createdAt;
}

function windowOf(experiment: Experiment, column = "timestamp"): string {
  return windowClause(sinceOf(experiment), experiment.endedAt, column);
}

function variantFilter(col: string): string {
  return `${col} IN (${lit(VARIANT_KEY.A)}, ${lit(VARIANT_KEY.B)})`;
}

/* ------------------------------------------------------------------------- */

export async function analyticsFor(experiment: Experiment): Promise<PostHogAnalytics> {
  const flagKey = experiment.posthogFeatureFlagKey ?? flagKeyFor(experiment.id);
  const col = featureCol(flagKey);
  const since = sinceOf(experiment);
  /** Klausa jendela waktu lengkap, sudah termasuk batas akhir kalau test ditutup. */
  const s = windowOf(experiment);
  const errors: string[] = [];
  const out: PostHogAnalytics = { since: since.toISOString(), flagKey, engagement: [], devices: [], countries: [], daily: [], replays: [], pages: [], empty: true, errors };

  if (!experimentsApiConfigured()) {
    errors.push("PostHog Experiments API belum dikonfigurasi di app Fly.io.");
    return out;
  }

  const section = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      return fallback;
    }
  };

  const [engagement, sessions, devices, countries, daily, replays, pages] = await Promise.all([
    section("engagement", () => hogql(`
      SELECT ${col} AS variant,
             countIf(event = '$pageview') AS pageviews,
             uniqIf(distinct_id, event = '$pageview') AS visitors,
             uniqIf($session_id, event = '$pageview') AS sessions,
             countIf(event = '$autocapture' AND properties.$event_type = 'click') AS clicks,
             countIf(event = '$rageclick') AS rageclicks,
             -- $dead_swipe adalah padanan $dead_click di perangkat sentuh. Toko ini
             -- 100% mobile, jadi tanpa ini sinyal frustrasi utamanya tidak terhitung.
             countIf(event IN ('$dead_click', '$dead_swipe')) AS deadclicks,
             -- $prev_pageview_max_scroll_percentage adalah PECAHAN 0..1, bukan 0..100.
             -- Diverifikasi langsung ke data project: rata-ratanya 0,149 (= 14,9%).
             avgIf(toFloat(properties.$prev_pageview_max_scroll_percentage),
                   event = '$pageleave' AND isNotNull(properties.$prev_pageview_max_scroll_percentage)) * 100 AS avg_scroll,
             quantileIf(0.75)(toFloat(properties.$web_vitals_LCP_value), event = '$web_vitals' AND isNotNull(properties.$web_vitals_LCP_value)) AS lcp_p75,
             quantileIf(0.75)(toFloat(properties.$web_vitals_INP_value), event = '$web_vitals' AND isNotNull(properties.$web_vitals_INP_value)) AS inp_p75,
             quantileIf(0.75)(toFloat(properties.$web_vitals_CLS_value), event = '$web_vitals' AND isNotNull(properties.$web_vitals_CLS_value)) AS cls_p75
      FROM events
      WHERE ${s} AND ${variantFilter(col)}
      GROUP BY variant`), []),
    section("sessions", () => hogql(`
      SELECT variant, count() AS sessions, avg(dur) AS avg_duration, avg(bounce) AS bounce_rate
      FROM (
        SELECT $session_id AS sid, any(${col}) AS variant,
               any(session.$session_duration) AS dur, any(toFloat(session.$is_bounce)) AS bounce
        FROM events
        WHERE event = '$pageview' AND ${s} AND ${variantFilter(col)}
        GROUP BY sid
      )
      GROUP BY variant`), []),
    section("devices", () => hogql(`
      SELECT ${col} AS variant, coalesce(toString(properties.$device_type), 'Unknown') AS value, uniq(distinct_id) AS visitors
      FROM events WHERE event = '$pageview' AND ${s} AND ${variantFilter(col)}
      GROUP BY variant, value ORDER BY visitors DESC LIMIT 20`), []),
    section("countries", () => hogql(`
      SELECT ${col} AS variant, coalesce(toString(properties.$geoip_country_code), 'Unknown') AS value, uniq(distinct_id) AS visitors
      FROM events WHERE event = '$pageview' AND ${s} AND ${variantFilter(col)}
      GROUP BY variant, value ORDER BY visitors DESC LIMIT 30`), []),
    section("daily", () => hogql(`
      SELECT toDate(timestamp) AS date, ${col} AS variant, count() AS pageviews, uniq(distinct_id) AS visitors
      FROM events WHERE event = '$pageview' AND ${s} AND ${variantFilter(col)}
      GROUP BY date, variant ORDER BY date ASC`), []),
    section("replays", () => hogql(`
      SELECT r.session_id AS session_id, v.variant AS variant,
             min(r.min_first_timestamp) AS started_at, max(r.max_last_timestamp) AS ended_at,
             sum(r.click_count) AS clicks, sum(r.console_error_count) AS errors,
             any(v.rage) AS rageclicks, any(r.first_url) AS first_url
      FROM raw_session_replay_events r
      JOIN (
        SELECT $session_id AS sid, any(${col}) AS variant, countIf(event = '$rageclick') AS rage
        FROM events WHERE ${s} AND ${variantFilter(col)}
        GROUP BY sid
      ) v ON v.sid = r.session_id
      WHERE ${windowOf(experiment, "r.min_first_timestamp")}
      GROUP BY r.session_id, v.variant
      ORDER BY rageclicks DESC, started_at DESC
      LIMIT 40`), []),
    /* Pathname dikembalikan APA ADANYA, termasuk awalan locale (/id/...) dan garis
     * miring di akhir. Toko ini menyajikan halaman yang sama pada dua pathname
     * berbeda per bahasa, dan keduanya punya heatmap sendiri — menggabungkannya
     * membuat titik klik saling melenceng karena tinggi halamannya berbeda. */
    section("pages", () => hogql(`
      SELECT properties.$pathname AS path, uniq(distinct_id) AS visitors
      FROM events WHERE event = '$pageview' AND ${s} AND ${variantFilter(col)}
        AND properties.$pathname LIKE '%/products/%'
      GROUP BY path ORDER BY visitors DESC LIMIT 20`), []),
  ]);

  const sessionByVariant = new Map(sessions.map((r) => [TO_LOCAL[str(r.variant)], r]));
  out.engagement = (["A", "B"] as VariantKey[]).map((variant): VariantEngagement => {
    const e = engagement.find((r) => TO_LOCAL[str(r.variant)] === variant) ?? {};
    const sess = sessionByVariant.get(variant) ?? {};
    return {
      variant,
      pageviews: num(e.pageviews),
      visitors: num(e.visitors),
      sessions: num(sess.sessions ?? e.sessions),
      avgSessionDuration: numOrNull(sess.avg_duration),
      bounceRate: numOrNull(sess.bounce_rate),
      clicks: num(e.clicks),
      rageclicks: num(e.rageclicks),
      deadclicks: num(e.deadclicks),
      avgScrollDepth: numOrNull(e.avg_scroll),
      lcpP75: numOrNull(e.lcp_p75),
      inpP75: numOrNull(e.inp_p75),
      clsP75: numOrNull(e.cls_p75),
    };
  });

  const toBreakdown = (rows: Record<string, unknown>[]): BreakdownRow[] =>
    rows
      .filter((r) => TO_LOCAL[str(r.variant)])
      .map((r) => ({ variant: TO_LOCAL[str(r.variant)], value: str(r.value) || "Unknown", visitors: num(r.visitors) }));
  out.devices = toBreakdown(devices);
  out.countries = toBreakdown(countries);
  out.daily = daily
    .filter((r) => TO_LOCAL[str(r.variant)])
    .map((r): DailyEngagementRow => ({ date: str(r.date).slice(0, 10), variant: TO_LOCAL[str(r.variant)], pageviews: num(r.pageviews), visitors: num(r.visitors) }));
  out.replays = replays
    .filter((r) => TO_LOCAL[str(r.variant)])
    .map((r): ReplayRow => {
      const started = new Date(str(r.started_at));
      const ended = new Date(str(r.ended_at));
      return {
        sessionId: str(r.session_id),
        variant: TO_LOCAL[str(r.variant)],
        startedAt: Number.isNaN(started.getTime()) ? str(r.started_at) : started.toISOString(),
        duration: Number.isNaN(started.getTime()) || Number.isNaN(ended.getTime()) ? 0 : Math.max(0, (ended.getTime() - started.getTime()) / 1000),
        clicks: num(r.clicks),
        rageclicks: num(r.rageclicks),
        errors: num(r.errors),
        firstUrl: r.first_url ? str(r.first_url) : null,
        url: `${projectUrl()}/replay/${encodeURIComponent(str(r.session_id))}`,
      };
    });
  out.pages = pages.map((r): ProductPageRow => ({ path: str(r.path), visitors: num(r.visitors) }));
  out.empty = out.engagement.every((e) => e.pageviews === 0);
  return out;
}

/* ------------------------------------------------------------------------- */

/**
 * Daftar halaman produk yang tercatat, urut dari yang paling ramai.
 *
 * Satu query ringan — dipisahkan dari analyticsFor() supaya panel heatmap di
 * halaman hasil tidak perlu menjalankan semua query perilaku hanya untuk tahu
 * halaman mana yang bisa dipilih.
 */
export async function pagesFor(experiment: Experiment): Promise<ProductPageRow[]> {
  if (!experimentsApiConfigured()) return [];
  const col = featureCol(experiment.posthogFeatureFlagKey ?? flagKeyFor(experiment.id));
  const rows = await hogql(`
      SELECT properties.$pathname AS path, uniq(distinct_id) AS visitors
      FROM events WHERE event = '$pageview' AND ${windowOf(experiment)} AND ${variantFilter(col)}
        AND properties.$pathname LIKE '%/products/%'
      GROUP BY path ORDER BY visitors DESC LIMIT 20`);
  return rows.map((r) => ({ path: str(r.path), visitors: num(r.visitors) })).filter((r) => r.path);
}

export interface HeatmapParams {
  /** path produk storefront, mis. "/products/moringa-capsule" */
  path: string;
  type: HeatmapType;
  viewport: HeatmapViewport;
  /** lebar layar yang dipakai; default "auto" (paling umum) */
  width?: HeatmapWidth;
}

const SCROLL_BUCKET_PX = 100;

/**
 * Heatmap per variant dari tabel `heatmaps` PostHog, dipasangkan ke variant lewat
 * session yang membawa `$feature/<flag-key>`. Titik dikembalikan sebagai koordinat
 * relatif (x) dan piksel dokumen (y) supaya dashboard bisa menggambarnya sendiri di
 * atas snapshot halaman.
 */
export async function heatmapFor(experiment: Experiment, params: HeatmapParams): Promise<PostHogHeatmap> {
  const flagKey = experiment.posthogFeatureFlagKey ?? flagKeyFor(experiment.id);
  const col = featureCol(flagKey);
  const since = windowOf(experiment);
  const sinceHeat = windowOf(experiment);
  const range = VIEWPORT_RANGE[params.viewport] ?? VIEWPORT_RANGE.mobile;
  const path = params.path.startsWith("/") ? params.path : `/${params.path}`;
  const errors: string[] = [];
  const empty = (variant: VariantKey): VariantHeatmap => ({ variant, path: variant === "B" ? withView(path, experiment.variantBSuffix) : path, points: [], scroll: [], totalSessions: 0, maxCount: 0, foldY: null, elements: [], attention: [] });
  const out: PostHogHeatmap = { type: params.type, viewport: params.viewport, path, a: empty("A"), b: empty("B"), errors, widths: [], widthBucket: null, renderWidth: range.width };

  if (!experimentsApiConfigured()) {
    errors.push("PostHog Experiments API belum dikonfigurasi di app Fly.io.");
    return out;
  }

  /* Dicocokkan pada PATHNAME PERSIS, bukan LIKE.
   *
   * `?view=ab-b` ada di query string sehingga pathname variant A dan B identik —
   * yang memisahkan keduanya adalah properti $feature/, bukan URL. Sebaliknya
   * awalan locale (/id/...) MEMANG pathname berbeda dengan tinggi halaman
   * berbeda, jadi tidak boleh digabung: titik kliknya akan melenceng. */
  const pathEq = `path(current_url) = ${lit(path)}`;

  /* Tabel `heatmaps` menyimpan viewport_width, x, dan y yang SUDAH DIBAGI
   * scale_factor (16). Layar HP 390px tersimpan sebagai 24, desktop 1472px
   * sebagai 92. Diverifikasi langsung ke data project (2026-09-24): tanpa
   * pengali ini, filter "mobile 320–767" tidak pernah cocok dengan satu baris
   * pun — dan toko ini hampir 100% mobile, jadi heatmap selalu kosong tanpa
   * error apa pun. */
  const deviceIn = `viewport_width * scale_factor >= ${range.min} AND viewport_width * scale_factor <= ${range.max}`;

  /* Titik dari lebar layar berbeda TIDAK bisa digambar ke satu snapshot dengan
   * akurat: di HP 360px teks membungkus lebih panjang, jadi tombol yang sama ada
   * di y=1300, sementara di HP 414px ada di y=1200. Posisi horizontal bisa
   * diskalakan, vertikal tidak. Karena itu — seperti Hotjar/PostHog — titik
   * disaring ke SATU kelompok lebar (16px) dan snapshot dirender persis di lebar
   * itu. Default: kelompok yang paling umum. */
  try {
    const rows = await hogql(`
      SELECT viewport_width AS bucket, uniq(session_id) AS sessions FROM heatmaps
      WHERE ${sinceHeat} AND ${pathEq} AND ${deviceIn}
      GROUP BY bucket ORDER BY sessions DESC LIMIT 12`);
    const total = rows.reduce((sum, r) => sum + num(r.sessions), 0);
    out.widths = rows.map((r): WidthBucket => {
      const bucket = num(r.bucket);
      return { bucket, minPx: (bucket - 1) * 16 + 1, maxPx: bucket * 16, sessions: num(r.sessions), share: total > 0 ? num(r.sessions) / total : 0 };
    });
  } catch (error) {
    errors.push(`lebar layar: ${error instanceof Error ? error.message : String(error)}`);
  }
  const wanted = params.width ?? "auto";
  const chosen =
    wanted === "all" ? null : typeof wanted === "number" ? wanted : (out.widths[0]?.bucket ?? null);
  out.widthBucket = chosen;
  out.renderWidth = chosen ? widthBucketPx(chosen) : range.width;
  const viewportIn = chosen ? `viewport_width = ${chosen}` : deviceIn;
  // Event $pageleave menyimpan lebar dalam piksel, bukan ÷16.
  const pxMin = chosen ? (chosen - 1) * 16 + 1 : range.min;
  const pxMax = chosen ? chosen * 16 : range.max;

  const perVariant = async (variant: VariantKey): Promise<VariantHeatmap> => {
    const key = VARIANT_KEY[variant];
    /* Sesi yang sempat melihat DUA variant dikeluarkan: titiknya tidak bisa
     * dipastikan milik variant yang mana. Sama dengan multiple_variant_handling
     * "exclude" yang dipakai analisis eksperimen PostHog. */
    const sessionsSub = `
      SELECT sid FROM (
        SELECT $session_id AS sid, uniq(${col}) AS variants, any(${col}) AS v
        FROM events WHERE ${since} AND ${variantFilter(col)}
        GROUP BY sid
      ) WHERE variants = 1 AND v = ${lit(key)}`;
    const result = empty(variant);
    try {
      /* Tiga query yang tidak saling bergantung dijalankan bersamaan: total sesi,
       * garis lipatan (tinggi viewport rata-rata, dari baris scrolldepth), dan
       * daftar elemen yang paling diklik (autocapture, dipasangkan ke variant
       * lewat properti $feature/ yang sama). */
      const [totals, fold, clicked] = await Promise.all([
        hogql(`
          SELECT uniq(session_id) AS sessions FROM heatmaps
          WHERE ${sinceHeat} AND ${pathEq}
            AND ${viewportIn}
            AND session_id IN (${sessionsSub})`),
        hogql(`
          SELECT round(avg(viewport_height * scale_factor)) AS fold_px FROM heatmaps
          WHERE type = 'scrolldepth' AND ${sinceHeat} AND ${pathEq}
            AND ${viewportIn}
            AND session_id IN (${sessionsSub})`),
        /* Kolom array elements_chain_* gagal di-GROUP BY pada project ini
         * (error tidak dikenal dari ClickHouse), jadi tag/teks/label diekstrak
         * dari string elements_chain dengan regex. */
        hogql(`
          SELECT extract(elements_chain, '^([a-zA-Z0-9]+)') AS tag,
                 extract(elements_chain, 'text="([^"]{1,80})') AS text,
                 extract(elements_chain, 'attr__aria-label="([^"]{1,80})') AS aria,
                 extract(elements_chain, 'attr__alt="([^"]{1,80})') AS alt,
                 elements_chain_href AS href,
                 count() AS n
          FROM events
          WHERE event = '$autocapture' AND properties.$event_type = 'click'
            AND ${since} AND properties.$pathname = ${lit(path)} AND ${col} = ${lit(key)}
          GROUP BY tag, text, aria, alt, href ORDER BY n DESC LIMIT 12`),
      ]);
      result.totalSessions = num(totals[0]?.sessions);
      result.foldY = numOrNull(fold[0]?.fold_px);
      const totalClicks = clicked.reduce((sum, r) => sum + num(r.n), 0);
      result.elements = clicked
        .map((r) => {
          const tag = str(r.tag) || "elemen";
          const label = str(r.text) || str(r.aria) || str(r.alt) || str(r.href) || `<${tag}>`;
          return { label: label.slice(0, 80), tag, count: num(r.n), share: totalClicks > 0 ? num(r.n) / totalClicks : 0 };
        })
        .filter((e) => e.count > 0)
        .slice(0, 8);

      if (params.type === "attention") {
        /* Peta perhatian ala Hotjar: perkiraan berapa lama tiap area halaman
         * berada di layar, per pengunjung.
         *
         * Baris scrolldepth PostHog terlalu jarang (kebanyakan sesi hanya punya
         * satu baris) untuk mengukur waktu per posisi secara langsung. Yang
         * lengkap untuk SEMUA sesi adalah event $pageleave: lama halaman dibuka
         * ($prev_pageview_duration) dan kedalaman scroll maksimum
         * ($prev_pageview_max_scroll). Waktu itu dibagi rata ke area yang sempat
         * terlihat (0 .. max_scroll + tinggi viewport); area yang tidak pernah
         * digulir mendapat 0. Rata-ratanya per pengunjung = "detik area ini
         * terlihat". Sesi > 30 menit dibuang (tab ditinggalkan). */
        const rows = await hogql(`
          SELECT bucket * ${SCROLL_BUCKET_PX} AS y_bucket, sum(sec) AS total_sec, uniq(session_id) AS sessions
          FROM (
            SELECT session_id,
                   arrayJoin(range(0, intDiv(toInt(max_scroll + vh), ${SCROLL_BUCKET_PX}) + 1)) AS bucket,
                   dur * (vh / (max_scroll + vh)) AS sec
            FROM (
              SELECT $session_id AS session_id,
                     toFloat(properties.$prev_pageview_duration) AS dur,
                     toFloat(properties.$prev_pageview_max_scroll) AS max_scroll,
                     toFloat(properties.$viewport_height) AS vh
              FROM events
              WHERE event = '$pageleave' AND ${since}
                AND properties.$prev_pageview_pathname = ${lit(path)}
                AND ${col} = ${lit(key)}
                AND toFloat(properties.$viewport_width) >= ${pxMin} AND toFloat(properties.$viewport_width) <= ${pxMax}
            )
            WHERE dur > 0 AND dur < 1800 AND vh > 0 AND max_scroll >= 0
          )
          GROUP BY bucket ORDER BY bucket ASC LIMIT 400`);
        // Pembagi = semua pengunjung (pita teratas dilihat semua orang), supaya
        // area yang jarang digulir memang tampak "sebentar", bukan rata-rata
        // dari sedikit orang yang sampai ke sana.
        const visitors = rows.reduce((m, r) => Math.max(m, num(r.sessions)), 0);
        result.totalSessions = visitors;
        result.attention = rows.map((r) => ({
          y: num(r.y_bucket),
          seconds: visitors > 0 ? Math.round((num(r.total_sec) / visitors) * 10) / 10 : 0,
          sessions: num(r.sessions),
        }));
        result.maxCount = result.attention.reduce((m, b) => Math.max(m, b.seconds), 0);
        return result;
      }

      if (params.type === "scrolldepth") {
        /* PostHog menulis BANYAK baris scrolldepth per sesi selama pengunjung
         * terus menggulir (terverifikasi: sampai 7 baris untuk satu sesi). Kalau
         * dihitung per baris, satu sesi terhitung di banyak bucket sekaligus dan
         * kurvanya jadi omong kosong. Karena itu kedalaman diambil MAX per sesi
         * dulu, baru dikelompokkan. */
        const rows = await hogql(`
          SELECT intDiv(max_y, ${SCROLL_BUCKET_PX}) * ${SCROLL_BUCKET_PX} AS y_bucket, count() AS sessions
          FROM (
            SELECT session_id, max(toInt(y * scale_factor)) AS max_y
            FROM heatmaps
            WHERE type = 'scrolldepth' AND ${sinceHeat} AND ${pathEq}
              AND ${viewportIn}
              AND session_id IN (${sessionsSub})
            GROUP BY session_id
          )
          GROUP BY y_bucket ORDER BY y_bucket ASC LIMIT 400`);
        // "Mencapai kedalaman ini" = jumlah sesi yang kedalaman maksimumnya >= bucket,
        // jadi dijumlahkan kumulatif dari bawah ke atas.
        let reached = 0;
        const buckets: ScrollBucket[] = [];
        for (const r of [...rows].reverse()) {
          reached += num(r.sessions);
          buckets.push({ y: num(r.y_bucket), reached });
        }
        result.scroll = buckets.reverse();
        result.maxCount = result.scroll[0]?.reached ?? 0;
        return result;
      }

      const rows = await hogql(`
        -- x dan viewport_width sama-sama dalam satuan /scale_factor, jadi rasionya langsung.
        SELECT round(x / viewport_width, 3) AS rel_x, toInt(y * scale_factor) AS y_px,
               pointer_target_fixed AS fixed, count() AS n
        FROM heatmaps
        WHERE type = ${lit(params.type)} AND ${sinceHeat} AND ${pathEq}
          AND ${viewportIn}
          AND session_id IN (${sessionsSub})
        GROUP BY rel_x, y_px, fixed ORDER BY n DESC LIMIT 6000`);
      result.points = rows.map((r): HeatmapPoint => ({ relX: Math.min(1, Math.max(0, num(r.rel_x))), y: num(r.y_px), fixed: Boolean(r.fixed), count: num(r.n) }));
      result.maxCount = result.points.reduce((m, p) => Math.max(m, p.count), 0);
    } catch (error) {
      errors.push(`variant ${variant}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return result;
  };

  const [a, b] = await Promise.all([perVariant("A"), perVariant("B")]);
  out.a = a;
  out.b = b;
  return out;
}

/**
 * Rekaman sesi di sekitar satu titik heatmap — tombol "Lihat replay" ala Hotjar.
 *
 * Titik dipilih dari kanvas (x relatif, y dokumen); sesi yang punya interaksi
 * dalam radius ±6% lebar dan ±60px diurutkan dari yang paling sering. Tautan
 * menuju pemutar replay PostHog; rekaman hanya ada kalau session replay aktif
 * untuk sesi itu (sampling PostHog), jadi tautan bisa saja kosong.
 */
export async function heatmapReplaysFor(experiment: Experiment, params: HeatmapReplayParams): Promise<HeatmapReplay[]> {
  if (!experimentsApiConfigured()) return [];
  const flagKey = experiment.posthogFeatureFlagKey ?? flagKeyFor(experiment.id);
  const col = featureCol(flagKey);
  const since = windowOf(experiment);
  const range = VIEWPORT_RANGE[params.viewport] ?? VIEWPORT_RANGE.mobile;
  const path = params.path.startsWith("/") ? params.path : `/${params.path}`;
  const key = VARIANT_KEY[params.variant];
  const relX = Math.min(1, Math.max(0, Number(params.relX) || 0));
  const y = Math.max(0, Math.round(Number(params.y) || 0));
  const type = params.type === "attention" ? "scrolldepth" : params.type;
  const rows = await hogql(`
    SELECT session_id, count() AS n, min(timestamp) AS first_at
    FROM heatmaps
    WHERE type = ${lit(type)} AND ${since} AND path(current_url) = ${lit(path)}
      AND viewport_width * scale_factor >= ${range.min} AND viewport_width * scale_factor <= ${range.max}
      AND abs(x / viewport_width - ${relX}) <= 0.06
      AND abs(toInt(y * scale_factor) - ${y}) <= ${type === "scrolldepth" ? 400 : 60}
      AND session_id IN (
        SELECT sid FROM (
          SELECT $session_id AS sid, uniq(${col}) AS variants, any(${col}) AS v
          FROM events WHERE ${since} AND ${variantFilter(col)}
          GROUP BY sid
        ) WHERE variants = 1 AND v = ${lit(key)}
      )
    GROUP BY session_id ORDER BY n DESC LIMIT 6`);
  return rows.map((r) => ({
    sessionId: str(r.session_id),
    url: `${projectUrl()}/replay/${encodeURIComponent(str(r.session_id))}`,
    count: num(r.n),
    occurredAt: str(r.first_at),
  }));
}

function withView(path: string, suffix: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}view=${encodeURIComponent(suffix)}`;
}
