import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { liveEntries } from "./component-variant.server";
import { componentOf } from "./components";
import type { Experiment } from "@prisma/client";
import db from "../db.server";
import { bi, type Bi } from "./i18n";
import { CRITICAL_CHECKS, type HealthCheckResult, type HealthReport, type HealthStatus, type SourceCoverage } from "./health-types";
import { computeResults } from "./results.server";
import { outboxBacklog } from "./posthog/client.server";
import { checkComponentReadiness, checksumOf, getMainTheme, productTemplateFilename, readThemeFile } from "./theme.server";
import { VARIANT_METAFIELD_KEY, VARIANT_METAFIELD_NAMESPACE } from "./order-variant.server";

/**
 * Invariant pipeline yang DIEKSEKUSI, bukan didokumentasikan.
 *
 * Tiga cacat yang ditemukan 2026-09-23 (pixel tidak pernah mengirim, productId
 * selalu null, test berjalan sebagai A/A) sama-sama tidak menghasilkan error —
 * hasilnya terlihat seperti data yang sah. Pemeriksaan di sini menjawab
 * pertanyaan "apakah nol itu benar-benar nol" secara terjadwal, dan menulis
 * jawabannya ke HealthSample supaya dashboard bisa menampilkannya.
 *
 * Setiap check tidak pernah melempar: kegagalan menghitung dilaporkan sebagai
 * status "warn" dengan alasannya. Satu check yang rusak tidak boleh menyembunyikan
 * check lain.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

type CheckFn = (ctx: Ctx) => Promise<Omit<HealthCheckResult, "id" | "label" | "critical" | "checkedAt">>;

interface Ctx {
  experiment: Experiment;
  admin: AdminApiContext | null;
  now: Date;
  since24h: Date;
  results: Awaited<ReturnType<typeof computeResults>> | null;
}

const fmtPct = (v: number) => `${(v * 100).toFixed(0)}%`;
const minutesAgo = (d: Date | null, now: Date) => (d ? Math.max(0, Math.round((now.getTime() - d.getTime()) / 60000)) : null);

const CHECKS: Array<{ id: string; label: Bi; run: CheckFn }> = [
  {
    id: "I1",
    label: bi("Konversi cocok dengan penugasan", "Conversions match assignments"),
    run: async ({ experiment }) => {
      const rows = await db.$queryRaw<Array<{ n: bigint }>>`
        SELECT COUNT(*) AS n FROM "Conversion" c
        LEFT JOIN "Assignment" a ON a."visitorId" = c."visitorId" AND a."experimentId" = c."experimentId"
        WHERE c."experimentId" = ${experiment.id} AND c."visitorId" IS NOT NULL
          AND (a."variant" IS NULL OR a."variant" <> c."variant")`;
      const n = Number(rows[0]?.n ?? 0);
      return { status: n === 0 ? "ok" : "fail", value: n, detail: n === 0 ? bi("semua order punya penugasan dengan variant yang sama", "every order has an assignment with the same variant") : bi(`${n} order variant-nya beda dari penugasan`, `${n} order${n === 1 ? "" : "s"} have a different variant than the assignment`) };
    },
  },
  {
    id: "I2",
    label: bi("Skrip storefront hidup", "Storefront script alive"),
    run: async ({ now }) => {
      const hb = await db.sourceHeartbeat.findUnique({ where: { source: "storefront" } });
      const ordersLastHour = await db.orderIntake.count({ where: { createdAt: { gte: new Date(now.getTime() - HOUR) }, status: { not: "excluded" } } });
      const ageMs = hb ? now.getTime() - hb.lastSeenAt.getTime() : Number.POSITIVE_INFINITY;
      const status: HealthStatus = ageMs <= HOUR ? "ok" : ordersLastHour > 0 ? "fail" : ageMs <= 6 * HOUR ? "warn" : "fail";
      const mins = minutesAgo(hb?.lastSeenAt ?? null, now);
      const stale = ordersLastHour > 0 && ageMs > HOUR;
      return {
        status,
        value: hb ? ageMs / 60000 : null,
        detail: bi(
          `terakhir terdengar ${mins == null ? "belum pernah" : `${mins} menit lalu`}${stale ? ` padahal ada ${ordersLastHour} order dalam sejam` : ""}`,
          `last heard ${mins == null ? "never" : `${mins} min ago`}${stale ? ` despite ${ordersLastHour} order${ordersLastHour === 1 ? "" : "s"} in the last hour` : ""}`,
        ),
      };
    },
  },
  {
    id: "I3",
    label: bi("Web pixel hidup (checkout ÷ order)", "Web pixel alive (checkouts ÷ orders)"),
    run: async ({ experiment, since24h }) => {
      const [starts, orders] = await Promise.all([
        db.$queryRaw<Array<{ n: bigint }>>`SELECT COUNT(DISTINCT "visitorId") AS n FROM "Event" WHERE "experimentId" = ${experiment.id} AND type = 'checkout_started' AND "occurredAt" >= ${since24h}`,
        db.conversion.count({ where: { experimentId: experiment.id, createdAt: { gte: since24h }, cancelledAt: null } }),
      ]);
      const s = Number(starts[0]?.n ?? 0);
      if (orders < 5) return { status: s > 0 ? "ok" : "info", value: s, detail: bi(`${s} checkout dimulai · ${orders} order (24 jam) — belum cukup order untuk menilai`, `${s} checkouts started · ${orders} orders (24h) — not enough orders to judge`) };
      const ratio = s / orders;
      return { status: s === 0 ? "fail" : ratio < 0.6 ? "warn" : "ok", value: ratio, detail: bi(`${s} checkout dimulai ÷ ${orders} order = ${ratio.toFixed(2)}×`, `${s} checkouts started ÷ ${orders} orders = ${ratio.toFixed(2)}×`) };
    },
  },
  {
    id: "I4",
    label: bi("Keterlambatan webhook", "Webhook delay"),
    run: async ({ since24h }) => {
      const rows = await db.$queryRaw<Array<{ p95: number | null }>>`
        SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM ("receivedAt" - "createdAt"))) AS p95
        FROM "OrderIntake" WHERE "receivedAt" >= ${since24h} AND status <> 'excluded'`;
      const p95 = rows[0]?.p95 == null ? null : Number(rows[0].p95);
      // Order COD dibayar berjam-jam setelah dibuat, jadi angka ini informatif —
      // ambang keras hanya untuk yang jelas macet.
      return { status: p95 == null ? "info" : p95 > 6 * 3600 ? "warn" : "ok", value: p95, detail: p95 == null ? bi("belum ada order 24 jam terakhir", "no orders in the last 24 hours") : bi(`p95 order dibuat → diterima: ${Math.round(p95 / 60)} menit`, `p95 order created → received: ${Math.round(p95 / 60)} min`) };
    },
  },
  {
    id: "I5",
    label: bi("Coverage atribusi order", "Order attribution coverage"),
    run: async ({ experiment }) => {
      const since = experiment.startedAt ?? experiment.createdAt;
      const g = await db.orderIntake.groupBy({ by: ["status"], where: { shop: experiment.shop, createdAt: { gte: since } }, _count: { _all: true } });
      const count = (s: string) => g.find((r) => r.status === s)?._count._all ?? 0;
      const attributed = count("attributed");
      const unattributed = count("unattributed");
      const notExposed = count("not_exposed");
      // Pengunjung yang tidak pernah membuka halaman produk memang bukan bagian
      // test; yang mengukur kesehatan hanya order yang jejaknya hilang sama sekali.
      const total = attributed + unattributed;
      const tailId = `${notExposed} tidak terpapar · ${count("excluded")} dikecualikan (POS/draft)`;
      const tailEn = `${notExposed} not exposed · ${count("excluded")} excluded (POS/draft)`;
      if (total < 5)
        return {
          status: "info",
          value: total ? attributed / total : null,
          detail: bi(
            `${attributed} beratribusi · ${unattributed} tanpa jejak · ${tailId} — belum cukup order`,
            `${attributed} attributed · ${unattributed} without trace · ${tailEn} — not enough orders yet`,
          ),
        };
      const ratio = attributed / total;
      return {
        status: ratio >= 0.9 ? "ok" : ratio >= 0.7 ? "warn" : "fail",
        value: ratio,
        detail: bi(`${attributed} / ${total} order dengan jejak = ${fmtPct(ratio)} · ${tailId}`, `${attributed} / ${total} traceable orders = ${fmtPct(ratio)} · ${tailEn}`),
      };
    },
  },
  {
    id: "I6",
    label: bi("Exposure per sesi", "Exposures per session"),
    run: async ({ experiment, since24h }) => {
      const rows = await db.$queryRaw<Array<{ exposures: bigint; sessions: bigint }>>`
        SELECT COUNT(*) FILTER (WHERE type = 'exposure') AS exposures, COUNT(DISTINCT "sessionId") AS sessions
        FROM "Event" WHERE "experimentId" = ${experiment.id} AND "occurredAt" >= ${since24h} AND "sessionId" IS NOT NULL`;
      const e = Number(rows[0]?.exposures ?? 0);
      const s = Number(rows[0]?.sessions ?? 0);
      if (s < 20) return { status: "info", value: null, detail: bi(`${s} sesi tercatat — belum cukup`, `${s} sessions recorded — not enough yet`) };
      const ratio = e / s;
      return { status: ratio <= 1.05 ? "ok" : "warn", value: ratio, detail: bi(`${e} exposure ÷ ${s} sesi = ${ratio.toFixed(2)}`, `${e} exposures ÷ ${s} sessions = ${ratio.toFixed(2)}`) };
    },
  },
  {
    id: "I7",
    label: bi("Bucketing browser = server", "Browser bucketing = server"),
    run: async ({ results }) => {
      const n = results?.bucketDrift ?? 0;
      return { status: n === 0 ? "ok" : "fail", value: n, detail: n === 0 ? bi("tidak ada drift", "no drift") : bi(`${n} pengunjung hash-nya berbeda`, `${n} visitor${n === 1 ? "" : "s"} hashed differently`) };
    },
  },
  {
    id: "I8",
    label: bi("Sample ratio (SRM)", "Sample ratio (SRM)"),
    run: async ({ results }) => {
      const srm = results?.srm;
      if (!srm) return { status: "info", value: null, detail: bi("belum cukup pengunjung", "not enough visitors yet") };
      return {
        status: srm.mismatch ? "fail" : "ok",
        value: srm.pValue,
        detail: bi(
          `teramati ${srm.observedPctB.toFixed(1)}% B dari target ${srm.expectedPctB}% · p = ${srm.pValue.toExponential(1)}`,
          `observed ${srm.observedPctB.toFixed(1)}% B vs target ${srm.expectedPctB}% · p = ${srm.pValue.toExponential(1)}`,
        ),
      };
    },
  },
  {
    id: "I9",
    label: bi("Template B berbeda dari A · tema siap", "Template B differs from A · theme ready"),
    run: async ({ experiment, admin }) => {
      if (!admin) return { status: "info", value: null, detail: bi("tidak bisa membaca theme (tanpa sesi admin)", "cannot read the theme (no admin session)") };
      const theme = await getMainTheme(admin);
      /* Eksperimen komponen tidak punya template B. Yang harus tetap benar
         sepanjang test adalah saklarnya: kalau seseorang menyunting theme live
         dan satu jalur render kehilangan saklar, grup B diam-diam melihat A. */
      if (experiment.kind === "component") {
        const component = componentOf(experiment.component);
        if (!component) return { status: "fail", value: null, detail: bi("komponen tidak dikenal", "unknown component") };
        const r = await checkComponentReadiness(admin, theme.id, component);
        /* Entry B di live harus tetap menunjuk B milik eksperimen INI — eksperimen
           lain yang dijalankan sesaat, atau suntingan manual, bisa memindahkannya. */
        if (r.ok) {
          const want = (experiment.variantBEntries as { shell?: string; content?: string } | null)?.shell
            ? (experiment.variantBEntries as { shell: string; content: string })
            : component.variantB.idle;
          const live = await liveEntries(admin, theme.id, component.key);
          if (live.shell !== want.shell || live.content !== want.content) {
            return {
              status: "fail",
              value: 1,
              detail: bi(
                `grup B melihat ${live.shell ?? "?"} / ${live.content ?? "?"}, bukan ${want.shell} / ${want.content} — jalankan ulang (pause → start) untuk memulihkan`,
                `group B sees ${live.shell ?? "?"} / ${live.content ?? "?"}, not ${want.shell} / ${want.content} — restart (pause → start) to restore`,
              ),
            };
          }
        }
        return r.ok
          ? { status: "ok", value: 0, detail: bi(`saklar ${component.attribute} terpasang di semua jalur render`, `switch ${component.attribute} wired into every render path`) }
          : {
              status: "fail",
              value: r.problems.length,
              detail: bi(
                `tema live tidak siap: ${r.problems.map((p) => p.file).join(", ")}`,
                `live theme not ready: ${r.problems.map((p) => p.file).join(", ")}`,
              ),
            };
      }
      const [a, b] = await Promise.all([
        readThemeFile(admin, theme.id, productTemplateFilename(null)),
        readThemeFile(admin, theme.id, productTemplateFilename(experiment.variantBSuffix)),
      ]);
      if (!a || !b) return { status: "warn", value: null, detail: bi("salah satu template tidak ditemukan di theme live", "one of the templates is missing from the live theme") };
      const same = checksumOf(a) === checksumOf(b);
      return { status: same ? "info" : "ok", value: same ? 1 : 0, detail: same ? bi("IDENTIK — ini A/A test; pengunjung B melihat halaman yang sama persis", "IDENTICAL — this is an A/A test; B visitors see exactly the same page") : bi("berbeda", "different") };
    },
  },
  {
    id: "I10",
    label: bi("Satu tipe event, satu sumber", "One event type, one source"),
    run: async ({ experiment, since24h }) => {
      const rows = await db.$queryRaw<Array<{ n: bigint }>>`
        SELECT COUNT(*) AS n FROM "Event" WHERE "experimentId" = ${experiment.id} AND "occurredAt" >= ${since24h}
          AND ((type IN ('exposure','product_viewed','add_to_cart','render_mismatch') AND source = 'pixel')
            OR (type IN ('checkout_started','checkout_completed') AND source = 'storefront'))`;
      const n = Number(rows[0]?.n ?? 0);
      return { status: n === 0 ? "ok" : "fail", value: n, detail: n === 0 ? bi("tidak ada event dari sumber yang salah", "no events from the wrong source") : bi(`${n} event datang dari sumber yang salah`, `${n} event${n === 1 ? "" : "s"} came from the wrong source`) };
    },
  },
  {
    id: "I11",
    label: bi("Antrean PostHog", "PostHog queue"),
    run: async ({ now }) => {
      const b = await outboxBacklog();
      const ageMin = b.oldestPendingAt ? (now.getTime() - b.oldestPendingAt.getTime()) / 60000 : 0;
      return { status: b.pending < 500 && ageMin < 15 ? "ok" : "warn", value: b.pending, detail: bi(
          `${b.pending} tertunda${b.oldestPendingAt ? ` · tertua ${Math.round(ageMin)} menit` : ""}${b.lastError ? ` · ${b.lastError.slice(0, 80)}` : ""}`,
          `${b.pending} pending${b.oldestPendingAt ? ` · oldest ${Math.round(ageMin)} min` : ""}${b.lastError ? ` · ${b.lastError.slice(0, 80)}` : ""}`,
        ),
      };
    },
  },
  {
    id: "I12",
    label: bi("Order bertanda variant di Shopify", "Orders tagged with variant in Shopify"),
    run: async ({ experiment, admin, since24h }) => {
      if (!admin) return { status: "info", value: null, detail: bi("tanpa sesi admin", "no admin session") };
      const conv = await db.conversion.findMany({ where: { experimentId: experiment.id, createdAt: { gte: since24h } }, select: { orderId: true }, take: 50 });
      if (conv.length === 0) return { status: "info", value: null, detail: bi("belum ada order 24 jam terakhir", "no orders in the last 24 hours") };
      const ids = [...new Set(conv.map((c) => c.orderId.split("#")[0]))];
      const res = await admin.graphql(ORDER_VARIANT_TAGS, { variables: { ids } });
      const json = await res.json();
      const nodes: Array<{ metafield?: { value?: string } | null } | null> = json?.data?.nodes ?? [];
      const tagged = nodes.filter((n) => n?.metafield?.value).length;
      const ratio = tagged / ids.length;
      return { status: ratio === 1 ? "ok" : "warn", value: ratio, detail: bi(`${tagged} / ${ids.length} order bertanda ${VARIANT_METAFIELD_NAMESPACE}.${VARIANT_METAFIELD_KEY}`, `${tagged} / ${ids.length} orders tagged ${VARIANT_METAFIELD_NAMESPACE}.${VARIANT_METAFIELD_KEY}`) };
    },
  },
  {
    /* Pengunjung yang membuka komponen tapi melihat varian yang salah (atribut
       keranjang belum tertulis). Mereka dikeluarkan dari hasil — dan karena
       hanya grup B yang butuh atribut, pengeluaran itu TIDAK merata antar
       varian. Di atas 5% hasilnya tidak boleh dipercaya. */
    id: "I15",
    label: bi("Varian komponen yang terlihat = penugasan", "Component arm shown = assigned"),
    run: async ({ experiment, since24h }) => {
      if (experiment.kind !== "component") return { status: "info", value: null, detail: bi("khusus eksperimen komponen", "component experiments only") };
      const rows = await db.$queryRaw<Array<{ type: string; n: bigint }>>`
        SELECT type, COUNT(DISTINCT "visitorId") AS n FROM "Event"
        WHERE "experimentId" = ${experiment.id} AND "occurredAt" >= ${since24h} AND type IN ('exposure', 'render_mismatch')
        GROUP BY type`;
      const exposed = Number(rows.find((r) => r.type === "exposure")?.n ?? 0);
      const mismatched = Number(rows.find((r) => r.type === "render_mismatch")?.n ?? 0);
      const total = exposed + mismatched;
      if (total === 0) return { status: "info", value: null, detail: bi("belum ada yang membuka komponen (24 jam)", "nobody opened the component yet (24h)") };
      const rate = mismatched / total;
      const pct = (rate * 100).toFixed(2);
      return {
        status: rate > 0.05 ? "fail" : rate > 0.01 ? "warn" : "ok",
        value: rate,
        detail: bi(`${mismatched} dari ${total} pengunjung melihat varian yang salah (${pct}%)`, `${mismatched} of ${total} visitors saw the wrong arm (${pct}%)`),
      };
    },
  },
];

const ORDER_VARIANT_TAGS = `#graphql
  query OrderVariantTags($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order {
        id
        metafield(namespace: "tl_ab", key: "variant") { value }
      }
    }
  }
`;

async function coverageFor(experiment: Experiment, now: Date, since24h: Date): Promise<SourceCoverage[]> {
  const [hb, exposures, starts, orders, intake, backlog] = await Promise.all([
    db.sourceHeartbeat.findMany(),
    db.assignment.count({ where: { experimentId: experiment.id, firstSeenAt: { gte: since24h } } }),
    db.$queryRaw<Array<{ n: bigint }>>`SELECT COUNT(DISTINCT "visitorId") AS n FROM "Event" WHERE "experimentId" = ${experiment.id} AND type = 'checkout_started' AND "occurredAt" >= ${since24h}`,
    db.conversion.count({ where: { experimentId: experiment.id, createdAt: { gte: since24h } } }),
    db.orderIntake.groupBy({ by: ["status"], where: { shop: experiment.shop, createdAt: { gte: experiment.startedAt ?? experiment.createdAt } }, _count: { _all: true } }),
    outboxBacklog(),
  ]);
  const seen = (s: string) => hb.find((h) => h.source === s)?.lastSeenAt.toISOString() ?? null;
  const count = (s: string) => intake.find((r) => r.status === s)?._count._all ?? 0;
  return [
    { source: "storefront", label: bi("Skrip storefront", "Storefront script"), lastSeenAt: seen("storefront"), figure: bi(`${exposures} pengunjung baru (24 jam)`, `${exposures} new visitors (24h)`) },
    {
      source: "pixel",
      label: bi("Web pixel", "Web pixel"),
      lastSeenAt: seen("pixel"),
      figure: bi(`${Number(starts[0]?.n ?? 0)} checkout dimulai ÷ ${orders} order (24 jam)`, `${Number(starts[0]?.n ?? 0)} checkouts started ÷ ${orders} orders (24h)`),
    },
    { source: "webhook", label: bi("Webhook order", "Order webhook"), lastSeenAt: seen("webhook"), figure: bi(`${orders} order (24 jam)`, `${orders} orders (24h)`) },
    {
      source: "attribution",
      label: bi("Atribusi order", "Order attribution"),
      lastSeenAt: null,
      figure: bi(
        `${count("attributed")} beratribusi · ${count("not_exposed")} tidak terpapar · ${count("unattributed")} tanpa jejak · ${count("excluded")} dikecualikan (sejak start)`,
        `${count("attributed")} attributed · ${count("not_exposed")} not exposed · ${count("unattributed")} without trace · ${count("excluded")} excluded (since start)`,
      ),
    },
    { source: "posthog", label: bi("Antrean PostHog", "PostHog queue"), lastSeenAt: null, figure: bi(`${backlog.pending} tertunda`, `${backlog.pending} pending`) },
  ];
}

/** Jalankan semua check untuk satu eksperimen, simpan, dan kembalikan laporannya. */
export async function runHealthChecks(experiment: Experiment, admin: AdminApiContext | null): Promise<HealthReport> {
  const now = new Date();
  const since24h = new Date(now.getTime() - DAY);
  let results: Ctx["results"] = null;
  try {
    results = await computeResults(experiment.id);
  } catch (error) {
    console.warn(`[health] computeResults gagal: ${error instanceof Error ? error.message : String(error)}`);
  }
  const ctx: Ctx = { experiment, admin, now, since24h, results };

  const checks: HealthCheckResult[] = await Promise.all(
    CHECKS.map(async ({ id, label, run }) => {
      try {
        const r = await run(ctx);
        return { id, label, critical: CRITICAL_CHECKS.has(id), checkedAt: now.toISOString(), ...r };
      } catch (error) {
        return { id, label, critical: CRITICAL_CHECKS.has(id), checkedAt: now.toISOString(), status: "warn" as const, value: null, detail: bi(`pemeriksaan gagal: ${error instanceof Error ? error.message : String(error)}`, `check failed: ${error instanceof Error ? error.message : String(error)}`) };
      }
    }),
  );

  await db.healthSample.createMany({
    data: checks.map((c) => ({ experimentId: experiment.id, check: c.id, status: c.status, value: c.value, detail: c.detail.id, detailEn: c.detail.en, checkedAt: now })),
  });

  return {
    experimentId: experiment.id,
    generatedAt: now.toISOString(),
    checks,
    coverage: await coverageFor(experiment, now, since24h),
    untrusted: checks.some((c) => c.critical && c.status === "fail"),
    aaTest: checks.some((c) => c.id === "I9" && c.status === "info" && c.value === 1),
  };
}

/** Laporan terakhir yang tersimpan; null kalau belum pernah diperiksa. */
export async function latestHealth(experiment: Experiment): Promise<HealthReport | null> {
  const last = await db.healthSample.findFirst({ where: { experimentId: experiment.id }, orderBy: { checkedAt: "desc" } });
  if (!last) return null;
  const rows = await db.healthSample.findMany({ where: { experimentId: experiment.id, checkedAt: last.checkedAt }, orderBy: { id: "asc" } });
  const byId = new Map(CHECKS.map((c) => [c.id, c.label] as const));
  const checks: HealthCheckResult[] = rows.map((r) => ({
    id: r.check,
    label: byId.get(r.check) ?? bi(r.check, r.check),
    status: r.status as HealthStatus,
    value: r.value,
    // Sampel lama (sebelum ada detailEn) hanya punya teks Indonesia.
    detail: bi(r.detail ?? "", r.detailEn ?? r.detail ?? ""),
    critical: CRITICAL_CHECKS.has(r.check),
    checkedAt: r.checkedAt.toISOString(),
  }));
  const now = new Date();
  return {
    experimentId: experiment.id,
    generatedAt: last.checkedAt.toISOString(),
    checks,
    coverage: await coverageFor(experiment, now, new Date(now.getTime() - DAY)),
    untrusted: checks.some((c) => c.critical && c.status === "fail"),
    aaTest: checks.some((c) => c.id === "I9" && c.status === "info" && c.value === 1),
  };
}

/* Penjadwal: tiap 10 menit untuk semua eksperimen yang berjalan. Hidup selama
 * proses server hidup, sama seperti pengirim ulang outbox PostHog. */
const INTERVAL_MS = 10 * 60_000;
let started = false;

export function startHealthScheduler(getAdmin: (shop: string) => Promise<AdminApiContext | null>): void {
  if (started) return;
  started = true;
  const tick = async () => {
    try {
      const running = await db.experiment.findMany({ where: { status: "running" } });
      for (const experiment of running) {
        let admin: AdminApiContext | null = null;
        try {
          admin = await getAdmin(experiment.shop);
        } catch {
          admin = null;
        }
        await runHealthChecks(experiment, admin);
      }
    } catch (error) {
      console.warn(`[health] tick gagal: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  setTimeout(tick, 20_000).unref();
  setInterval(tick, INTERVAL_MS).unref();
}
