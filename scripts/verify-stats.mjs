/**
 * Sanity check fungsi statistik terhadap nilai yang bisa diverifikasi manual
 * (tabel normal standar dan kalkulator two-proportion umum).
 *
 * Dijalankan langsung terhadap sumber TypeScript-nya lewat type stripping Node,
 * supaya yang diuji benar-benar kode yang dipakai aplikasi.
 */
import { twoProportionTest, sampleSizePerArm, srmCheck, normalCdf, revenuePerVisitorTest } from "../app/lib/stats.ts";

const test = twoProportionTest({ n: 20000, x: 400 }, { n: 20000, x: 480 });
const nullTest = twoProportionTest({ n: 20000, x: 400 }, { n: 20000, x: 400 });
const sample = sampleSizePerArm(0.02, 0.2);
const srmOk = srmCheck(10000, 10000, 50);
const srmBad = srmCheck(11000, 9000, 50);

// RPV: B punya order sama banyak tapi nilai per order dua kali lipat
const rpv = revenuePerVisitorTest(
  { n: 10000, orders: 200, sum: 200 * 100000, sumSq: 200 * 100000 ** 2 },
  { n: 10000, orders: 200, sum: 200 * 200000, sumSq: 200 * 200000 ** 2 },
);

const checks = [
  ["normalCdf(0) = 0.5", Math.abs(normalCdf(0) - 0.5) < 1e-6],
  ["normalCdf(1.96) ~ 0.975", Math.abs(normalCdf(1.96) - 0.975) < 1e-3],
  ["2.0% vs 2.4% -> signifikan", test.significant && test.pValue < 0.01],
  ["uplift = +20%", Math.abs(test.upliftRelative - 0.2) < 1e-9],
  ["CI 95% mengurung uplift sebenarnya", test.ciLow < 0.2 && test.ciHigh > 0.2],
  ["P(B>A) tinggi saat B menang", test.probBBeatsA > 0.99],
  ["tanpa beda -> p-value = 1", Math.abs(nullTest.pValue - 1) < 1e-6],
  ["tanpa beda -> P(B>A) = 50%", Math.abs(nullTest.probBBeatsA - 0.5) < 1e-9],
  ["tanpa beda -> tidak signifikan", nullTest.significant === false],
  ["sample size 2% / MDE 20% di kisaran 20-22k", sample > 20000 && sample < 22000],
  ["split 50/50 pas -> tidak ada SRM", srmOk.mismatch === false],
  ["split 55/45 -> SRM terdeteksi", srmBad.mismatch === true],
  ["RPV naik 100% terdeteksi", Math.abs(rpv.upliftRelative - 1) < 1e-9 && rpv.significant],
  ["AOV ikut terhitung benar", Math.abs(rpv.aovB - 200000) < 1e-6],
];

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? "ok   " : "GAGAL"} ${label}`);
  if (!ok) failed++;
}
console.log(`\n  sample size 2% / MDE 20% : ${sample.toLocaleString("id-ID")} visitor per grup`);
console.log(`  p-value 2.0% vs 2.4%     : ${test.pValue.toExponential(3)}`);
if (failed) { console.error("\nGAGAL"); process.exit(1); }
console.log("\nOK");
