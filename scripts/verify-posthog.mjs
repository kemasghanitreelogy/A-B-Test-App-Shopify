/**
 * Sanity check integrasi PostHog.
 *
 *   1. Taksonomi: flag key sah, uuid v5 deterministik dan sesuai RFC 4122
 *      (dicocokkan dengan vektor yang diverifikasi lawan uuid.uuid5 Python).
 *   2. Paritas storefront: literal variant key ("control"/"test"), awalan
 *      "$feature/", dan nama event exposure di tl-ab-core.liquid harus sama
 *      dengan taxonomy.ts — kalau berbeda, event dari browser dan dari server
 *      akan tercatat di variant yang berbeda tanpa error apa pun.
 *   3. Definisi metric: bentuk ExperimentMetric yang diterima Experiments API.
 *   4. Pembaca hasil: payload metrics_recalculation/latest (bentuk upstream)
 *      diterjemahkan ke nilai, uplift, dan verdict yang benar.
 */
import { readFileSync } from "node:fs";
import {
  EVENTS,
  FLAG_KEY_PATTERN,
  VARIANT_KEY,
  flagKeyFor,
  metricUuid,
  uuidV5,
} from "../app/lib/posthog/taxonomy.ts";
import { buildMetricPlan } from "../app/lib/posthog/metrics.ts";
import { windowClause } from "../app/lib/posthog/analytics-types.ts";
import { buildPostHogVerdict, exposureGap, parseRecalculation } from "../app/lib/posthog/results.ts";

const liquid = readFileSync("extensions/tl-ab-embed/snippets/tl-ab-core.liquid", "utf8");
const pixelServer = readFileSync("app/lib/pixel.server.ts", "utf8");
const experimentServer = readFileSync("app/lib/experiment.server.ts", "utf8");
const pixelToml = readFileSync("extensions/tl-ab-pixel/shopify.extension.toml", "utf8");
/** Isi file tanpa komentar — untuk pemeriksaan yang menyoal KODE, bukan penjelasannya. */
const code = liquid.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const expId = "cmfq1abcd000008l4h1x2y3z4";
const flagKey = flagKeyFor(expId);
const plan = buildMetricPlan(expId, "cvr");
const all = [...plan.primary, ...plan.secondary];

const fixture = {
  status: "completed",
  completed_at: "2026-09-17T03:00:00Z",
  query_to: "2026-09-17T00:00:00Z",
  results: [
    {
      metric_uuid: metricUuid(expId, "cvr"),
      status: "completed",
      error_message: null,
      result: {
        kind: "ExperimentQuery",
        baseline: { key: "control", number_of_samples: 20000, sum: 400, sum_squares: 400, step_counts: [20000, 400], validation_failures: [] },
        variant_results: [
          { key: "test", method: "bayesian", number_of_samples: 20000, sum: 480, sum_squares: 480, chance_to_win: 0.996, credible_interval: [0.06, 0.34], significant: true, validation_failures: [] },
        ],
      },
    },
    {
      metric_uuid: metricUuid(expId, "rpv"),
      status: "completed",
      result: {
        baseline: { key: "control", number_of_samples: 20000, sum: 40_000_000, sum_squares: 0 },
        variant_results: [{ key: "test", method: "bayesian", number_of_samples: 20000, sum: 44_000_000, sum_squares: 0, chance_to_win: 0.8, credible_interval: [-0.02, 0.22], significant: false }],
      },
    },
    {
      metric_uuid: metricUuid(expId, "aov"),
      status: "completed",
      result: {
        baseline: { key: "control", number_of_samples: 20000, sum: 40_000_000, sum_squares: 0, denominator_sum: 400 },
        variant_results: [{ key: "test", method: "bayesian", number_of_samples: 20000, sum: 44_000_000, sum_squares: 0, denominator_sum: 480 }],
      },
    },
    { metric_uuid: metricUuid(expId, "atc_rate"), status: "failed", error_message: "timeout", result: null },
  ],
};
const parsed = parseRecalculation(fixture, expId, metricUuid(expId, "cvr"));
const status = { configured: true, captureConfigured: true, linked: true, experimentId: 1, flagKey, url: "x", status: "running", startDate: null, endDate: null, conclusion: null, exposureEvent: null, syncedAt: null, syncError: null, results: parsed, outboxPending: 0, outboxOldestPendingAt: null };
const verdict = buildPostHogVerdict(parsed, status);
const cvr = parsed.metrics.find((m) => m.key === "cvr");
const rpv = parsed.metrics.find((m) => m.key === "rpv");
const aov = parsed.metrics.find((m) => m.key === "aov");
const atc = parsed.metrics.find((m) => m.key === "atc_rate");
const gap = exposureGap(21000, 20500, parsed);

const checks = [
  // taksonomi
  ["flag key sah untuk PostHog", FLAG_KEY_PATTERN.test(flagKey) && flagKey.startsWith("tl-ab-")],
  ["uuid v5 cocok vektor referensi (Python uuid5)", uuidV5("hello", "6ba7b811-9dad-11d1-80b4-00c04fd430c8") === "074171de-bc84-5ea4-b636-1135477620e1"],
  ["uuid v5 deterministik", uuidV5("a") === uuidV5("a") && uuidV5("a") !== uuidV5("b")],
  ["uuid v5 berformat RFC 4122", /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuidV5("x"))],
  ["uuid metric unik per key", new Set(all.map((m) => m.uuid)).size === all.length],
  // paritas storefront
  ['liquid memakai variant key "control"/"test" yang sama', liquid.includes(`"${VARIANT_KEY.B}" : "${VARIANT_KEY.A}"`)],
  ["liquid memakai awalan $feature/", liquid.includes('"$feature/" + flagKey')],
  ["kode liquid tidak menyebut nama event exposure sama sekali (itu urusan server)",
    !code.includes(EVENTS.EXPOSURE_DEFAULT) && !code.includes("$experiment_exposure")],
  ["browser tidak mengirim exposure (nama event hanya diketahui server)",
    !/\.capture\(\s*"\$feature_flag_called"/.test(code) && !/\.capture\(\s*"\$experiment_exposure"/.test(code)],
  ["liquid mendaftarkan properti variant untuk heatmap/replay", liquid.includes('reg["$feature/" + flagKey]')],
  ["liquid mengekspos __TL_AB_VID__", liquid.includes("window.__TL_AB_VID__ = vid")],
  ["liquid tetap tanpa tanda kurang-dari (aturan theme check)", !liquid.includes("<")],
  // posthog-js di storefront
  ["posthog-js: identitas dipaksa sama dengan _tl_vid", liquid.includes("bootstrap: { distinctID: vid")],
  ["posthog-js: pageview manual setelah register $feature/", liquid.includes("capture_pageview: false") && liquid.indexOf("phClient.register(phProps)") < liquid.indexOf('phClient.capture("$pageview")')],
  ["posthog-js: dimuat setelah keputusan redirect", liquid.indexOf("window.location.replace(withView(") < liquid.indexOf("function loadPostHog(")],
  ["posthog-js: personless (identified_only)", liquid.includes('person_profiles: "identified_only"')],
  // definisi metric
  ["primary tepat satu, sesuai metric lokal", plan.primary.length === 1 && plan.primary[0].uuid === metricUuid(expId, "cvr")],
  ["semua metric kind=ExperimentMetric", all.every((m) => m.kind === "ExperimentMetric" && m.uuid && m.name)],
  ["funnel punya series 1 langkah (exposure implisit)", all.filter((m) => m.metric_type === "funnel").every((m) => m.series?.length === 1 && m.series[0].kind === "EventsNode")],
  ["mean rpv = sum(revenue) dari order paid", all.find((m) => m.metric_type === "mean")?.source?.math === "sum" && all.find((m) => m.metric_type === "mean")?.source?.math_property === "revenue" && all.find((m) => m.metric_type === "mean")?.source?.event === EVENTS.ORDER_PAID],
  ["ratio aov = sum(revenue) / count(order paid)", all.find((m) => m.metric_type === "ratio")?.numerator?.math === "sum" && all.find((m) => m.metric_type === "ratio")?.denominator?.math === "total"],
  ["guardrail refund bertujuan decrease", all.find((m) => m.name.startsWith("Refund"))?.goal === "decrease"],
  // pembaca hasil
  ["cvr: A 2.0%, B 2.4%", Math.abs(cvr.baseline.value - 0.02) < 1e-9 && Math.abs(cvr.test.value - 0.024) < 1e-9],
  ["cvr: uplift +20%", Math.abs(cvr.upliftRelative - 0.2) < 1e-9],
  ["cvr: interval & P(B>A) terbaca", cvr.intervalLow === 0.06 && cvr.intervalHigh === 0.34 && cvr.chanceToWin === 0.996 && cvr.significant === true],
  ["cvr ditandai primary dan tampil pertama", cvr.primary && parsed.metrics[0].key === "cvr"],
  ["rpv: rata-rata per pengunjung", Math.abs(rpv.baseline.value - 2000) < 1e-9 && Math.abs(rpv.test.value - 2200) < 1e-9],
  ["aov: numerator / denominator", Math.abs(aov.baseline.value - 100000) < 1e-6 && Math.abs(aov.test.value - 44_000_000 / 480) < 1e-6],
  ["metric gagal tetap tampil dengan error", atc.status === "failed" && atc.error === "timeout" && atc.test === null],
  ["verdict: B menang", verdict.kind === "b_wins"],
  ["exposure gap terbaca", gap.a === 20000 && gap.b === 20000 && Math.abs(gap.ratioA - 20000 / 21000) < 1e-9],
  ["payload rusak -> null, bukan crash", parseRecalculation("bukan objek", expId, null) === null],
  ["belum tersambung -> verdict not_linked", buildPostHogVerdict(null, { ...status, linked: false }).kind === "not_linked"],
  /* Web pixel: men-deploy extension TIDAK mengaktifkannya. Tanpa webPixelCreate,
     pixel terdaftar di Settings tapi tidak pernah berjalan — dan satu-satunya
     gejalanya adalah langkah checkout di funnel yang selamanya nol. */
  ["app memanggil webPixelCreate", pixelServer.includes("webPixelCreate")],
  ["app bisa membetulkan settings pixel (webPixelUpdate)", pixelServer.includes("webPixelUpdate")],
  ["pixel diaktifkan saat eksperimen dijalankan", experimentServer.includes("ensureWebPixel(admin)")],
  ["settings pixel memakai field yang dideklarasikan extension",
    pixelToml.includes("collectEndpoint") && pixelServer.includes("collectEndpoint")],
  ["\"sudah ada\" tidak diperlakukan sebagai kegagalan", pixelServer.includes("TAKEN")],
  // jendela waktu
  ["eksperimen berjalan: hanya batas bawah",
    windowClause(new Date("2026-09-01T00:00:00Z"), null) === "timestamp >= toDateTime('2026-09-01 00:00:00')"],
  ["eksperimen SELESAI: ada batas atas (kalau tidak, angkanya berubah sendiri setelah test ditutup)",
    windowClause(new Date("2026-09-01T00:00:00Z"), new Date("2026-09-15T12:30:00Z")) ===
      "timestamp >= toDateTime('2026-09-01 00:00:00') AND timestamp <= toDateTime('2026-09-15 12:30:00')"],
  ["kolom bisa diganti (tabel replay memakai nama lain)",
    windowClause(new Date("2026-09-01T00:00:00Z"), null, "r.min_first_timestamp").startsWith("r.min_first_timestamp >=")],
];

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? "ok  " : "GAGAL"} ${label}`);
  if (!ok) failed++;
}
if (failed > 0) {
  console.error(`\n${failed} pemeriksaan gagal.`);
  process.exit(1);
}
console.log("\nOK — integrasi PostHog konsisten.");
