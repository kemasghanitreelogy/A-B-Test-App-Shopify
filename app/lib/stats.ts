/**
 * Uji statistik untuk hasil A/B test.
 *
 * Semua fungsi di sini murni (tanpa I/O) supaya gampang di-unit test dan
 * hasilnya bisa dicocokkan dengan kalkulator eksternal.
 */

/** CDF distribusi normal standar (Abramowitz & Stegun 26.2.17, error < 7.5e-8). */
export function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

/** Inverse CDF normal standar (Acklam). Dipakai untuk z-kritis pada sample size. */
export function normalQuantile(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pLow) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export interface Arm {
  /** jumlah visitor yang terpapar */
  n: number;
  /** jumlah yang konversi */
  x: number;
}

export interface ProportionResult {
  rateA: number;
  rateB: number;
  /** uplift relatif B terhadap A, mis. 0.18 = +18% */
  upliftRelative: number;
  /** batas bawah/atas CI 95% untuk uplift relatif */
  ciLow: number;
  ciHigh: number;
  zScore: number;
  /** p-value dua sisi */
  pValue: number;
  significant: boolean;
  /** P(B lebih baik dari A) secara Bayesian, lebih mudah dibaca non-statistikawan */
  probBBeatsA: number;
}

/**
 * Two-proportion z-test (pooled) + interval kepercayaan pada selisih,
 * dikonversi ke uplift relatif.
 */
export function twoProportionTest(a: Arm, b: Arm, alpha = 0.05): ProportionResult | null {
  if (a.n < 1 || b.n < 1) return null;
  const pA = a.x / a.n;
  const pB = b.x / b.n;
  const pPool = (a.x + b.x) / (a.n + b.n);
  const sePooled = Math.sqrt(pPool * (1 - pPool) * (1 / a.n + 1 / b.n));
  const z = sePooled === 0 ? 0 : (pB - pA) / sePooled;
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));

  // CI pakai SE tak-pooled (praktik standar untuk estimasi selisih)
  const seDiff = Math.sqrt((pA * (1 - pA)) / a.n + (pB * (1 - pB)) / b.n);
  const zCrit = normalQuantile(1 - alpha / 2);
  const diff = pB - pA;

  return {
    rateA: pA,
    rateB: pB,
    upliftRelative: pA === 0 ? 0 : diff / pA,
    ciLow: pA === 0 ? 0 : (diff - zCrit * seDiff) / pA,
    ciHigh: pA === 0 ? 0 : (diff + zCrit * seDiff) / pA,
    zScore: z,
    pValue,
    significant: pValue < alpha,
    probBBeatsA: bayesianProbBBeatsA(a, b),
  };
}

/**
 * P(rate_B > rate_A) dengan prior Beta(1,1) (uniform).
 *
 * Memakai pendekatan normal terhadap posterior Beta. Untuk n di atas beberapa
 * ratus -- selalu terpenuhi pada test yang layak disimpulkan -- galatnya di bawah
 * 0,001 dibanding integrasi eksak, dan hasilnya deterministik (tidak seperti
 * Monte Carlo yang berubah tiap dijalankan).
 */
export function bayesianProbBBeatsA(a: Arm, b: Arm): number {
  const post = (arm: Arm) => {
    const alpha = arm.x + 1;
    const beta = arm.n - arm.x + 1;
    const s = alpha + beta;
    return { mean: alpha / s, variance: (alpha * beta) / (s * s * (s + 1)) };
  };
  const pa = post(a);
  const pb = post(b);
  const sd = Math.sqrt(pa.variance + pb.variance);
  if (sd === 0) return 0.5;
  return normalCdf((pb.mean - pa.mean) / sd);
}

export interface RevenueArm {
  /** jumlah visitor terpapar (termasuk yang tidak beli) */
  n: number;
  /** jumlah order */
  orders: number;
  /** total revenue */
  sum: number;
  /** jumlah kuadrat nilai tiap order */
  sumSq: number;
}

export interface RevenueResult {
  rpvA: number;
  rpvB: number;
  aovA: number;
  aovB: number;
  upliftRelative: number;
  ciLow: number;
  ciHigh: number;
  tScore: number;
  pValue: number;
  significant: boolean;
}

/**
 * Welch t-test untuk Revenue per Visitor.
 *
 * Visitor yang tidak membeli dihitung sebagai revenue 0, jadi mean = sum/n dan
 * variance dihitung atas seluruh n. Distribusi revenue miring (skewed), tapi
 * dengan n ribuan Central Limit Theorem membuat uji pada MEAN tetap valid.
 */
export function revenuePerVisitorTest(a: RevenueArm, b: RevenueArm, alpha = 0.05): RevenueResult | null {
  if (a.n < 2 || b.n < 2) return null;
  const stat = (arm: RevenueArm) => {
    const mean = arm.sum / arm.n;
    // E[X^2] atas seluruh n (non-pembeli menyumbang 0 ke sumSq)
    const variance = Math.max(0, (arm.sumSq - arm.n * mean * mean) / (arm.n - 1));
    return { mean, variance, se2: variance / arm.n };
  };
  const sa = stat(a);
  const sb = stat(b);
  const se = Math.sqrt(sa.se2 + sb.se2);
  if (se === 0) return null;

  const t = (sb.mean - sa.mean) / se;
  // n besar -> distribusi t mendekati normal, jadi pakai normalCdf
  const pValue = 2 * (1 - normalCdf(Math.abs(t)));
  const zCrit = normalQuantile(1 - alpha / 2);
  const diff = sb.mean - sa.mean;

  return {
    rpvA: sa.mean,
    rpvB: sb.mean,
    aovA: a.orders ? a.sum / a.orders : 0,
    aovB: b.orders ? b.sum / b.orders : 0,
    upliftRelative: sa.mean === 0 ? 0 : diff / sa.mean,
    ciLow: sa.mean === 0 ? 0 : (diff - zCrit * se) / sa.mean,
    ciHigh: sa.mean === 0 ? 0 : (diff + zCrit * se) / sa.mean,
    tScore: t,
    pValue,
    significant: pValue < alpha,
  };
}

export interface SrmResult {
  observedPctB: number;
  expectedPctB: number;
  chiSquare: number;
  pValue: number;
  /** true = split menyimpang signifikan -> hasil test TIDAK boleh dipercaya */
  mismatch: boolean;
}

/**
 * Sample Ratio Mismatch check (chi-square, 1 derajat kebebasan).
 *
 * Ambang p < 0.001 (bukan 0.05) supaya tidak sering false alarm, sesuai praktik
 * industri. SRM hampir selalu berarti ada bug -- redirect gagal, bot masuk
 * bucket, atau cookie hilang di salah satu grup -- bukan sekadar kebetulan.
 */
export function srmCheck(nA: number, nB: number, expectedPctB: number): SrmResult | null {
  const total = nA + nB;
  if (total < 100) return null;
  const expB = (total * expectedPctB) / 100;
  const expA = total - expB;
  if (expA <= 0 || expB <= 0) return null;

  const chi = (nA - expA) ** 2 / expA + (nB - expB) ** 2 / expB;
  // 1 df: p = 2 * (1 - Phi(sqrt(chi2)))
  const pValue = 2 * (1 - normalCdf(Math.sqrt(chi)));
  return {
    observedPctB: (nB / total) * 100,
    expectedPctB,
    chiSquare: chi,
    pValue,
    mismatch: pValue < 0.001,
  };
}

/**
 * Sample size per arm untuk two-proportion test.
 * @param baseline conversion rate variant A (mis. 0.02)
 * @param mdeRelative lift relatif minimum yang mau dideteksi (mis. 0.2 = 20%)
 */
export function sampleSizePerArm(baseline: number, mdeRelative: number, alpha = 0.05, power = 0.8): number {
  const p1 = baseline;
  const p2 = baseline * (1 + mdeRelative);
  if (p2 >= 1 || p1 <= 0 || mdeRelative <= 0) return Number.POSITIVE_INFINITY;
  const zAlpha = normalQuantile(1 - alpha / 2);
  const zBeta = normalQuantile(power);
  const n = ((zAlpha + zBeta) ** 2 * (p1 * (1 - p1) + p2 * (1 - p2))) / (p2 - p1) ** 2;
  return Math.ceil(n);
}
