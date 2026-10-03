// ============================================================================
// FILE INI DIHASILKAN OTOMATIS — JANGAN DIEDIT DI SINI.
// Sumber: app/lib/posthog/results.ts
// Untuk mengubahnya: edit file sumber, lalu jalankan dari root repo:
//     node scripts/sync-dashboard.mjs
// ============================================================================

/**
 * Membaca hasil eksperimen dari PostHog menjadi bentuk yang bisa ditampilkan
 * berdampingan dengan hasil lokal.
 *
 * Sumber: GET /api/projects/:id/experiments/:id/metrics_recalculation/latest/
 *   {
 *     status, completed_at, query_to,
 *     results: [{ metric_uuid, status, error_message,
 *                 result: { baseline: ExperimentStatsBase, variant_results: [...] } }]
 *   }
 *
 * Bentuk `ExperimentStatsBase` / `ExperimentVariantResult{Bayesian,Frequentist}`
 * diambil dari posthog/schema.py (upstream) saat integrasi ini ditulis. Semua
 * field dibaca defensif: field yang tidak ada menghasilkan null, bukan crash —
 * halaman hasil harus tetap tampil walau PostHog mengubah bentuk responsnya.
 *
 * Bebas dependency dan efek samping; ikut disalin ke dashboard.
 */
import type { Bi } from "./i18n";
import { METRICS, VARIANT_KEY, type MetricKey, type MetricMeta } from "./posthog-taxonomy";
import { metricKeyByUuid } from "./posthog-metrics";

export interface PostHogArm {
  key: string;
  /** pengunjung terpapar yang masuk analisis metric ini */
  samples: number;
  /** funnel: jumlah yang konversi; mean: total nilai; ratio: total numerator */
  sum: number;
  denominatorSum: number | null;
  /** funnel: proporsi; mean: rata-rata per pengunjung; ratio: numerator/denominator */
  value: number | null;
  validationFailures: string[];
}

export interface PostHogMetricResult {
  key: MetricKey | null;
  uuid: string;
  meta: MetricMeta | null;
  name: string;
  primary: boolean;
  status: string;
  error: string | null;
  method: "bayesian" | "frequentist" | null;
  baseline: PostHogArm | null;
  test: PostHogArm | null;
  /** selisih relatif B terhadap A menurut PostHog (dari interval); null kalau belum dihitung */
  upliftRelative: number | null;
  /** interval kredibel (Bayesian) atau kepercayaan (frequentist), relatif */
  intervalLow: number | null;
  intervalHigh: number | null;
  /** Bayesian: P(test lebih baik); frequentist: null */
  chanceToWin: number | null;
  pValue: number | null;
  significant: boolean | null;
}

export interface PostHogResults {
  /** status recalculation: pending | running | completed | failed */
  status: string;
  computedAt: string | null;
  /** batas data yang ikut dihitung */
  queryTo: string | null;
  source: string | null;
  metrics: PostHogMetricResult[];
}

export interface PostHogStatus {
  /** POSTHOG_PERSONAL_API_KEY + POSTHOG_PROJECT_ID terpasang di app Fly */
  configured: boolean;
  /** POSTHOG_PROJECT_TOKEN terpasang, event dikirim */
  captureConfigured: boolean;
  linked: boolean;
  experimentId: number | null;
  flagKey: string | null;
  url: string | null;
  /** draft | running | paused | exposure_frozen | stopped */
  status: string | null;
  startDate: string | null;
  endDate: string | null;
  conclusion: string | null;
  exposureEvent: string | null;
  syncedAt: string | null;
  syncError: string | null;
  results: PostHogResults | null;
  /** antrean outbox yang belum terkirim; > 0 lama = PostHog tertinggal dari lokal */
  outboxPending: number;
  outboxOldestPendingAt: string | null;
}

type Json = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);

function parseArm(raw: unknown, metricType: MetricMeta["metricType"] | null): PostHogArm | null {
  const o = obj(raw);
  if (!o) return null;
  const samples = num(o.number_of_samples) ?? 0;
  const sum = num(o.sum) ?? 0;
  const denominatorSum = num(o.denominator_sum);
  let value: number | null = null;
  if (metricType === "ratio") value = denominatorSum ? sum / denominatorSum : null;
  else value = samples > 0 ? sum / samples : null;
  const failures = Array.isArray(o.validation_failures) ? o.validation_failures.map(String) : [];
  return { key: str(o.key) ?? "", samples, sum, denominatorSum, value, validationFailures: failures };
}

export function parseRecalculation(payload: unknown, experimentId: string, primaryUuid: string | null): PostHogResults | null {
  const p = obj(payload);
  if (!p) return null;
  const byUuid = metricKeyByUuid(experimentId);
  const rows = Array.isArray(p.results) ? p.results : [];

  const metrics: PostHogMetricResult[] = rows.map((rowRaw) => {
    const row = obj(rowRaw) ?? {};
    const uuid = str(row.metric_uuid) ?? "";
    const key = byUuid.get(uuid) ?? null;
    const meta = key ? METRICS[key] : null;
    const result = obj(row.result);
    const baseline = parseArm(result?.baseline, meta?.metricType ?? null);
    const variants = Array.isArray(result?.variant_results) ? result!.variant_results : [];
    const testRaw = variants.find((v) => obj(v)?.key === VARIANT_KEY.B) ?? variants[0];
    const testObj = obj(testRaw);
    const test = parseArm(testRaw, meta?.metricType ?? null);
    const interval = Array.isArray(testObj?.credible_interval)
      ? testObj!.credible_interval
      : Array.isArray(testObj?.confidence_interval)
        ? testObj!.confidence_interval
        : null;
    const low = interval ? num(interval[0]) : null;
    const high = interval ? num(interval[1]) : null;
    const uplift =
      baseline?.value != null && test?.value != null && baseline.value !== 0
        ? (test.value - baseline.value) / baseline.value
        : null;

    return {
      key,
      uuid,
      meta,
      name: meta?.name ?? str(obj(result?.metric)?.name) ?? uuid,
      primary: uuid === primaryUuid,
      status: str(row.status) ?? "unknown",
      error: str(row.error_message),
      method: testObj?.method === "frequentist" ? "frequentist" : testObj?.method === "bayesian" ? "bayesian" : null,
      baseline,
      test,
      upliftRelative: uplift,
      intervalLow: low,
      intervalHigh: high,
      chanceToWin: num(testObj?.chance_to_win),
      pValue: num(testObj?.p_value),
      significant: typeof testObj?.significant === "boolean" ? testObj.significant : null,
    };
  });

  // primary dulu, lalu urutan key lokal, lalu yang tidak dikenal
  const order = Object.keys(METRICS);
  metrics.sort((a, b) => {
    if (a.primary !== b.primary) return a.primary ? -1 : 1;
    const ia = a.key ? order.indexOf(a.key) : 99;
    const ib = b.key ? order.indexOf(b.key) : 99;
    return ia - ib;
  });

  return {
    status: str(p.status) ?? "unknown",
    computedAt: str(p.completed_at),
    queryTo: str(p.query_to),
    source: str(p.result_source),
    metrics,
  };
}

export type PostHogVerdictKind = "not_linked" | "waiting" | "b_wins" | "a_wins" | "inconclusive" | "invalid";

export interface PostHogVerdict {
  kind: PostHogVerdictKind;
  headline: Bi;
  detail: Bi;
  primary: PostHogMetricResult | null;
}

/**
 * Satu kalimat keputusan menurut PostHog, dari metric primary saja.
 * Aturannya sama dengan verdict lokal: signifikan menurut mesin PostHog, dan
 * arah selisihnya menentukan pemenang.
 */
export function buildPostHogVerdict(results: PostHogResults | null, status: PostHogStatus): PostHogVerdict {
  if (!status.linked) {
    return {
      kind: "not_linked",
      headline: { id: "Belum tersambung ke PostHog", en: "Not connected to PostHog yet" },
      detail: status.syncError
        ? { id: status.syncError, en: status.syncError }
        : { id: "Eksperimen belum dicerminkan ke PostHog. Jalankan eksperimen atau sinkronkan ulang.", en: "The experiment has not been mirrored to PostHog. Start the experiment or sync again." },
      primary: null,
    };
  }
  const primary = results?.metrics.find((m) => m.primary) ?? null;
  if (!results || !primary || !primary.test || !primary.baseline) {
    return {
      kind: "waiting",
      headline: { id: "PostHog belum menghitung", en: "PostHog hasn't calculated yet" },
      detail: {
        id: "Hasil dihitung terjadwal oleh PostHog setelah eksperimen berjalan beberapa waktu. Tekan “Hitung ulang” untuk memaksa perhitungan.",
        en: "PostHog calculates results on a schedule once the experiment has run for a while. Press “Recalculate” to force a calculation.",
      },
      primary,
    };
  }
  const failures = [...primary.baseline.validationFailures, ...primary.test.validationFailures];
  if (failures.length > 0) {
    /* Aturan validasi PostHog (docs/experiments/statistics-bayesian, "Step 2"):
     * semua metric butuh ≥ 50 exposure per variant; metric funnel (conversion
     * rate) juga butuh ≥ 5 konversi per variant dan n·p > 5; metric mean/ratio
     * butuh baseline bukan nol. Dijelaskan apa adanya supaya "belum cukup" tidak
     * disangka pipeline yang rusak. */
    const reasons = new Set(failures);
    const hintsId: string[] = [];
    const hintsEn: string[] = [];
    if (reasons.has("not-enough-exposures")) {
      hintsId.push("exposure di PostHog masih < 50 per variant");
      hintsEn.push("PostHog still has < 50 exposures per variant");
    }
    if (reasons.has("not-enough-metric-data")) {
      hintsId.push("metric funnel butuh ≥ 5 konversi (order) per variant");
      hintsEn.push("funnel metrics need ≥ 5 conversions (orders) per variant");
    }
    if (reasons.has("baseline-mean-is-zero")) {
      hintsId.push("nilai rata-rata variant A masih nol (mis. belum ada refund)");
      hintsEn.push("variant A's average is still zero (e.g. no refunds yet)");
    }
    return {
      kind: "invalid",
      headline: { id: "Data di PostHog belum cukup", en: "Not enough data in PostHog yet" },
      detail: {
        id: `PostHog belum mau menghitung metric utama: ${hintsId.length ? hintsId.join("; ") : failures.join(", ")}. Ini aturan sample minimum PostHog, bukan pipeline yang rusak — angka lokal di atas tetap dihitung.`,
        en: `PostHog won't calculate the primary metric yet: ${hintsEn.length ? hintsEn.join("; ") : failures.join(", ")}. This is PostHog's minimum-sample rule, not a broken pipeline — the local numbers above are still calculated.`,
      },
      primary,
    };
  }
  if (primary.significant === true && primary.upliftRelative != null) {
    const bWins = primary.meta?.goal === "decrease" ? primary.upliftRelative < 0 : primary.upliftRelative > 0;
    const pct = `${Math.abs(primary.upliftRelative * 100).toFixed(1)}%`;
    const higherId = primary.upliftRelative > 0 ? "lebih tinggi" : "lebih rendah";
    const higherEn = primary.upliftRelative > 0 ? "higher" : "lower";
    return bWins
      ? {
          kind: "b_wins",
          headline: { id: "PostHog: variant B menang", en: "PostHog: variant B wins" },
          detail: {
            id: `${primary.name} B ${higherId} ${pct} dari A dan intervalnya tidak melewati nol.`,
            en: `${primary.name} for B is ${pct} ${higherEn} than A and the interval does not cross zero.`,
          },
          primary,
        }
      : {
          kind: "a_wins",
          headline: { id: "PostHog: variant A menang", en: "PostHog: variant A wins" },
          detail: {
            id: `${primary.name} B ${higherId} ${pct} dari A, ke arah yang tidak diinginkan.`,
            en: `${primary.name} for B is ${pct} ${higherEn} than A, in the unwanted direction.`,
          },
          primary,
        };
  }
  return {
    kind: "inconclusive",
    headline: { id: "PostHog: belum ada pemenang", en: "PostHog: no winner yet" },
    detail:
      primary.chanceToWin != null
        ? {
            id: `Peluang B lebih baik ${(primary.chanceToWin * 100).toFixed(1)}%, tapi intervalnya masih melewati nol.`,
            en: `B has a ${(primary.chanceToWin * 100).toFixed(1)}% chance of being better, but the interval still crosses zero.`,
          }
        : { id: "Selisihnya belum signifikan menurut PostHog.", en: "The difference is not yet significant according to PostHog." },
    primary,
  };
}

/**
 * Perbandingan pengunjung terpapar lokal vs PostHog, per variant.
 * Selisih besar berarti pipeline event ke PostHog tertinggal atau exposure
 * disaring berbeda (mis. multiple-variant exclusion) — bukan berarti salah satu bohong.
 */
export function exposureGap(localA: number, localB: number, results: PostHogResults | null): { a: number | null; b: number | null; ratioA: number | null; ratioB: number | null } {
  const primary = results?.metrics.find((m) => m.primary) ?? results?.metrics[0];
  const a = primary?.baseline?.samples ?? null;
  const b = primary?.test?.samples ?? null;
  return {
    a,
    b,
    ratioA: a != null && localA > 0 ? a / localA : null,
    ratioB: b != null && localB > 0 ? b / localB : null,
  };
}
