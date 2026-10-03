/**
 * Menerjemahkan hasil statistik menjadi satu kalimat keputusan.
 *
 * Halaman hasil sebelumnya menampilkan uplift, p-value, dan P(B>A) berdampingan
 * lalu menyerahkan penafsirannya ke pembaca. Itu tempat kesalahan paling mahal
 * terjadi: uplift +18% yang interval kepercayaannya masih melewati nol dibaca
 * sebagai kemenangan, lalu variant B diterapkan permanen berdasarkan kebisingan.
 *
 * File ini memusatkan aturan bacanya di satu tempat, dengan dua pemisahan yang
 * sengaja dipertahankan:
 *
 *   1. DIPERCAYA vs TIDAK. SRM atau bucket drift membatalkan semuanya. Angka yang
 *      dihitung dari pembagian grup yang rusak tidak jadi lebih benar hanya karena
 *      p-value-nya kecil, jadi pemenang tidak pernah diumumkan dalam keadaan itu.
 *
 *   2. MEMIMPIN vs MENANG. Signifikan sebelum sample dan durasi minimum terpenuhi
 *      hanyalah "memimpin" — mengintip hasil berkali-kali dan berhenti pada hari
 *      yang kebetulan signifikan menaikkan false positive jauh di atas 5%.
 */
import type { ArmTotals, ExperimentResults } from "./results";
import { normalCdf, normalQuantile } from "./stats";
import { pick, tr, type Bi, type Lang } from "./i18n";

export type MetricKey = "cvr" | "atc_rate" | "rpv" | "aov";

export interface MetricTest {
  key: MetricKey;
  label: string;
  /** cara membaca nilai A/B: proporsi (persen) atau nilai uang */
  format: "pct" | "idr";
  valueA: number;
  valueB: number;
  /** uplift relatif B terhadap A */
  upliftRelative: number;
  ciLow: number;
  ciHigh: number;
  pValue: number;
  significant: boolean;
  /** P(B lebih baik dari A) */
  probBBeatsA: number;
  /** kenapa metric ini tidak boleh dipakai sebagai bukti utama, kalau memang begitu */
  caveat?: string;
}

export const METRIC_META: Record<MetricKey, { label: Bi; format: "pct" | "idr"; caveat?: Bi }> = {
  cvr: { label: { id: "Conversion rate", en: "Conversion rate" }, format: "pct" },
  atc_rate: {
    label: { id: "Add-to-cart rate", en: "Add-to-cart rate" },
    format: "pct",
    caveat: {
      id: "Dihitung dari event browser, jadi ikut terpotong ad-blocker di kedua grup.",
      en: "Counted from browser events, so ad-blockers cut it in both groups.",
    },
  },
  rpv: { label: { id: "Revenue per visitor", en: "Revenue per visitor" }, format: "idr" },
  aov: {
    label: { id: "Nilai order rata-rata", en: "Average order value" },
    format: "idr",
    caveat: {
      id: "Denominatornya hanya pembeli, bukan seluruh pengunjung — kenaikannya bisa datang dari B yang menyaring pembeli kecil, bukan dari B yang lebih baik.",
      en: "Its denominator is buyers only, not all visitors — a lift can come from B filtering out small buyers rather than B being better.",
    },
  },
};

/** label, format, dan caveat metric dalam bahasa pembaca */
function metaFor(key: MetricKey, lang: Lang): { label: string; format: "pct" | "idr"; caveat?: string } {
  const m = METRIC_META[key];
  return {
    label: pick(lang, m.label),
    format: m.format,
    ...(m.caveat ? { caveat: pick(lang, m.caveat) } : {}),
  };
}

/**
 * Welch t-test untuk nilai order rata-rata.
 *
 * Tidak ikut di stats.ts karena AOV memakai denominator yang berbeda dari semua
 * uji lain di sana: rata-ratanya diambil atas ORDER, bukan atas visitor. Variance
 * per order direkonstruksi dari sum dan sum-of-squares yang sudah diagregasi SQL,
 * sehingga tidak perlu membaca ulang tiap baris order.
 */
function aovTest(a: ArmTotals, b: ArmTotals, lang: Lang, alpha = 0.05): MetricTest | null {
  if (a.orders < 2 || b.orders < 2) return null;

  const stat = (arm: ArmTotals) => {
    const mean = arm.revenue / arm.orders;
    const variance = Math.max(0, (arm.revenueSq - arm.orders * mean * mean) / (arm.orders - 1));
    return { mean, se2: variance / arm.orders };
  };

  const sa = stat(a);
  const sb = stat(b);
  const se = Math.sqrt(sa.se2 + sb.se2);
  if (!Number.isFinite(se) || se === 0) return null;

  const t = (sb.mean - sa.mean) / se;
  const zCrit = normalQuantile(1 - alpha / 2);
  const diff = sb.mean - sa.mean;
  const pValue = 2 * (1 - normalCdf(Math.abs(t)));

  return {
    key: "aov",
    ...metaFor("aov", lang),
    valueA: sa.mean,
    valueB: sb.mean,
    upliftRelative: sa.mean === 0 ? 0 : diff / sa.mean,
    ciLow: sa.mean === 0 ? 0 : (diff - zCrit * se) / sa.mean,
    ciHigh: sa.mean === 0 ? 0 : (diff + zCrit * se) / sa.mean,
    pValue,
    significant: pValue < alpha,
    probBBeatsA: normalCdf(t),
  };
}

/**
 * Keempat metric dalam satu bentuk yang sama supaya bisa ditampilkan berdampingan.
 *
 * Untuk uji rata-rata (RPV dan AOV) P(B>A) diambil dari Phi(t): dengan prior datar
 * pada selisih rata-rata, itu persis peluang posterior bahwa B di atas A. Uji
 * proporsi memakai posterior Beta yang sudah dihitung di stats.ts.
 */
export function buildMetricTests(results: ExperimentResults, lang: Lang = "id"): MetricTest[] {
  const out: MetricTest[] = [];

  if (results.cvr) {
    out.push({
      key: "cvr",
      ...metaFor("cvr", lang),
      valueA: results.cvr.rateA,
      valueB: results.cvr.rateB,
      upliftRelative: results.cvr.upliftRelative,
      ciLow: results.cvr.ciLow,
      ciHigh: results.cvr.ciHigh,
      pValue: results.cvr.pValue,
      significant: results.cvr.significant,
      probBBeatsA: results.cvr.probBBeatsA,
    });
  }

  if (results.atcRate) {
    out.push({
      key: "atc_rate",
      ...metaFor("atc_rate", lang),
      valueA: results.atcRate.rateA,
      valueB: results.atcRate.rateB,
      upliftRelative: results.atcRate.upliftRelative,
      ciLow: results.atcRate.ciLow,
      ciHigh: results.atcRate.ciHigh,
      pValue: results.atcRate.pValue,
      significant: results.atcRate.significant,
      probBBeatsA: results.atcRate.probBBeatsA,
    });
  }

  if (results.revenue) {
    out.push({
      key: "rpv",
      ...metaFor("rpv", lang),
      valueA: results.revenue.rpvA,
      valueB: results.revenue.rpvB,
      upliftRelative: results.revenue.upliftRelative,
      ciLow: results.revenue.ciLow,
      ciHigh: results.revenue.ciHigh,
      pValue: results.revenue.pValue,
      significant: results.revenue.significant,
      probBBeatsA: normalCdf(results.revenue.tScore),
    });
  }

  const aov = aovTest(results.A, results.B, lang);
  if (aov) out.push(aov);

  return out;
}

export type VerdictKind = "untrusted" | "no_data" | "b_wins" | "a_wins" | "inconclusive";

export interface Verdict {
  kind: VerdictKind;
  /** null selama belum ada pemenang, atau selama datanya belum boleh dipercaya */
  winner: "A" | "B" | null;
  /** uji pada metric utama; satu-satunya yang boleh menentukan keputusan */
  primary: MetricTest | null;
  metricLabel: string;
  headline: string;
  detail: string;
  /** true = boleh diumumkan; false = baru arah sementara */
  final: boolean;
  /** dipakai untuk mewarnai panel */
  tone: "a" | "b" | "neutral" | "critical";
}

export function buildVerdict(
  results: ExperimentResults,
  primaryMetric: string,
  metrics?: MetricTest[],
  lang: Lang = "id",
): Verdict {
  const t = tr(lang);
  const tests = metrics ?? buildMetricTests(results, lang);
  const primary = tests.find((m) => m.key === primaryMetric) ?? null;
  const meta = METRIC_META[primaryMetric as MetricKey];
  const metricLabel = meta ? pick(lang, meta.label) : primaryMetric;

  if (results.srm?.mismatch || results.bucketDrift > 0) {
    return {
      kind: "untrusted",
      winner: null,
      primary,
      metricLabel,
      headline: t("Hasil tidak bisa dipakai", "These results cannot be used"),
      detail: t(
        "Pembagian grup rusak, jadi angka di halaman ini tidak mengukur apa pun tentang desain B. Perbaiki penyebabnya, lalu mulai ulang eksperimen dari nol.",
        "The group split is broken, so the numbers on this page say nothing about design B. Fix the cause, then restart the experiment from scratch.",
      ),
      final: false,
      tone: "critical",
    };
  }

  if (!primary) {
    return {
      kind: "no_data",
      winner: null,
      primary,
      metricLabel,
      headline: t("Menunggu data", "Waiting for data"),
      detail: t(
        `Belum ada cukup pengunjung atau order untuk menguji ${metricLabel.toLowerCase()}.`,
        `Not enough visitors or orders yet to test ${metricLabel.toLowerCase()}.`,
      ),
      final: false,
      tone: "neutral",
    };
  }

  const leader: "A" | "B" = primary.upliftRelative >= 0 ? "B" : "A";
  const final = primary.significant && results.readyToConclude;
  const magnitude = `${Math.abs(primary.upliftRelative * 100).toFixed(1)}%`;

  if (!primary.significant) {
    return {
      kind: "inconclusive",
      winner: null,
      primary,
      metricLabel,
      headline: t("Belum ada pemenang", "No winner yet"),
      detail: `${t(
        "Interval kepercayaan 95% masih melewati nol, artinya selisih sebesar ini masih bisa muncul dari kebetulan saja.",
        "The 95% confidence interval still crosses zero, so a gap this size could still be pure chance.",
      )} ${
        results.readyToConclude
          ? t(
              "Sample dan durasi sudah cukup, jadi kemungkinan besar kedua desain memang setara — biarkan A dan pakai energinya untuk hipotesis lain.",
              "Sample and duration are sufficient, so the two designs are most likely equivalent — keep A and spend the effort on another hypothesis.",
            )
          : t("Biarkan test berjalan sampai target sample terpenuhi.", "Let the test run until the target sample is reached.")
      }`,
      final: false,
      tone: "neutral",
    };
  }

  return {
    kind: leader === "B" ? "b_wins" : "a_wins",
    winner: final ? leader : null,
    primary,
    metricLabel,
    headline: final
      ? leader === "B"
        ? t("Variant B menang", "Variant B wins")
        : t("Variant A menang", "Variant A wins")
      : leader === "B"
        ? t("Variant B memimpin", "Variant B is leading")
        : t("Variant A memimpin", "Variant A is leading"),
    detail: final
      ? leader === "B"
        ? t(
            `${metricLabel} B lebih tinggi ${magnitude} dari A, dan seluruh interval kepercayaan berada di atas nol. Terapkan desain B secara permanen, lalu tutup eksperimen ini.`,
            `B's ${metricLabel.toLowerCase()} is ${magnitude} higher than A's, and the whole confidence interval sits above zero. Roll out design B permanently, then close this experiment.`,
          )
        : t(
            `${metricLabel} B lebih rendah ${magnitude} dari A. Desain lama terbukti lebih baik — kembalikan seluruh trafik ke A.`,
            `B's ${metricLabel.toLowerCase()} is ${magnitude} lower than A's. The original design is proven better — send all traffic back to A.`,
          )
      : t(
          `Selisihnya sudah signifikan secara statistik, tapi ${
            results.blockers.length > 1 ? "beberapa syarat" : "satu syarat"
          } belum terpenuhi. Berhenti sekarang karena angkanya sedang bagus adalah cara paling umum menghasilkan kemenangan palsu.`,
          `The difference is already statistically significant, but ${
            results.blockers.length > 1 ? "some requirements haven't" : "one requirement hasn't"
          } been met yet. Stopping now because the numbers look good is the most common way to produce a false win.`,
        ),
    final,
    tone: leader === "B" ? "b" : "a",
  };
}
