import db from "../db.server";
import type { Bi } from "./i18n";
import {
  twoProportionTest,
  revenuePerVisitorTest,
  srmCheck,
  sampleSizePerArm,
  type ProportionResult,
  type RevenueResult,
  type SrmResult,
} from "./stats";

export interface ArmTotals {
  visitors: number;
  addToCarts: number;
  /** dari web pixel, dibaca lewat checkout.attributes — langkah funnel, bukan konversi */
  checkoutStarts: number;
  orders: number;
  revenue: number;
  revenueSq: number;
}

export interface ExperimentResults {
  A: ArmTotals;
  B: ArmTotals;
  cvr: ProportionResult | null;
  atcRate: ProportionResult | null;
  revenue: RevenueResult | null;
  srm: SrmResult | null;
  /** jumlah visitor yang variant-nya berbeda antara hitungan client dan server */
  bucketDrift: number;
  requiredPerArm: number;
  daysRunning: number;
  /** true kalau sample size DAN durasi minimum sudah terpenuhi */
  readyToConclude: boolean;
  /** alasan belum boleh disimpulkan, dua bahasa */
  blockers: Bi[];
  daily: Array<{ date: string; variant: string; visitors: number; orders: number; revenue: number }>;
}

const MIN_RUNTIME_DAYS = 14;

export async function computeResults(experimentId: string): Promise<ExperimentResults> {
  const experiment = await db.experiment.findUniqueOrThrow({ where: { id: experimentId } });

  // Denominator = visitor unik yang benar-benar terpapar, bukan jumlah pageview.
  const assignments = await db.assignment.groupBy({
    by: ["variant"],
    where: { experimentId },
    _count: { _all: true },
  });

  const atc = await db.$queryRaw<Array<{ variant: string; visitors: bigint }>>`
    SELECT variant, COUNT(DISTINCT "visitorId") AS visitors
    FROM "Event"
    WHERE "experimentId" = ${experimentId} AND type = 'add_to_cart'
    GROUP BY variant
  `;

  /* Langkah antara keranjang dan pembelian.
   *
   * Datang dari web pixel, jadi ia ikut terpotong ad-blocker — karena itu tidak
   * pernah dipakai menghitung siapa yang menang. Gunanya hanya menunjukkan DI MANA
   * funnel bocor: kalau B unggul di add-to-cart tapi tertinggal di sini, yang
   * bermasalah bukan halaman produknya melainkan jalan menuju checkout. */
  const checkoutStarts = await db.$queryRaw<Array<{ variant: string; visitors: bigint }>>`
    SELECT variant, COUNT(DISTINCT "visitorId") AS visitors
    FROM "Event"
    WHERE "experimentId" = ${experimentId} AND type = 'checkout_started'
    GROUP BY variant
  `;

  // Revenue bersih = total order dikurangi refund. Order yang dibatalkan
  // dikeluarkan seluruhnya, bukan sekadar di-nol-kan revenue-nya.
  const conv = await db.$queryRaw<
    Array<{ variant: string; orders: bigint; revenue: number; revenue_sq: number }>
  >`
    SELECT variant,
           COUNT(*)                                                      AS orders,
           COALESCE(SUM(("totalPrice" - "refundedAmount")::float8), 0)    AS revenue,
           COALESCE(SUM((("totalPrice" - "refundedAmount")::float8) ^ 2), 0) AS revenue_sq
    FROM "Conversion"
    WHERE "experimentId" = ${experimentId} AND "cancelledAt" IS NULL
    GROUP BY variant
  `;

  const driftRows = await db.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(DISTINCT "visitorId") AS n
    FROM "Event"
    WHERE "experimentId" = ${experimentId} AND type = 'bucket_drift'
  `;

  const daily = await db.$queryRaw<
    Array<{ date: Date; variant: string; visitors: bigint; orders: bigint; revenue: number }>
  >`
    SELECT d.date, d.variant,
           COALESCE(a.visitors, 0) AS visitors,
           COALESCE(c.orders, 0)   AS orders,
           COALESCE(c.revenue, 0)  AS revenue
    FROM (
      SELECT DATE("firstSeenAt") AS date, variant FROM "Assignment" WHERE "experimentId" = ${experimentId}
      UNION
      SELECT DATE("createdAt") AS date, variant FROM "Conversion" WHERE "experimentId" = ${experimentId}
    ) d
    LEFT JOIN (
      SELECT DATE("firstSeenAt") AS date, variant, COUNT(*) AS visitors
      FROM "Assignment" WHERE "experimentId" = ${experimentId} GROUP BY 1, 2
    ) a ON a.date = d.date AND a.variant = d.variant
    LEFT JOIN (
      SELECT DATE("createdAt") AS date, variant, COUNT(*) AS orders,
             SUM(("totalPrice" - "refundedAmount")::float8) AS revenue
      FROM "Conversion" WHERE "experimentId" = ${experimentId} AND "cancelledAt" IS NULL
      GROUP BY 1, 2
    ) c ON c.date = d.date AND c.variant = d.variant
    ORDER BY d.date ASC, d.variant ASC
  `;

  const arm = (variant: "A" | "B"): ArmTotals => ({
    visitors: assignments.find((a) => a.variant === variant)?._count._all ?? 0,
    addToCarts: Number(atc.find((a) => a.variant === variant)?.visitors ?? 0),
    checkoutStarts: Number(checkoutStarts.find((a) => a.variant === variant)?.visitors ?? 0),
    orders: Number(conv.find((c) => c.variant === variant)?.orders ?? 0),
    revenue: Number(conv.find((c) => c.variant === variant)?.revenue ?? 0),
    revenueSq: Number(conv.find((c) => c.variant === variant)?.revenue_sq ?? 0),
  });

  const A = arm("A");
  const B = arm("B");

  // Sample size dihitung dari baseline yang teramati, bukan dari tebakan awal.
  const observedBaseline = A.visitors > 0 ? A.orders / A.visitors : 0;
  const requiredPerArm =
    observedBaseline > 0
      ? sampleSizePerArm(observedBaseline, experiment.mdeRelative)
      : experiment.minSampleArm;

  const daysRunning = experiment.startedAt
    ? Math.floor((Date.now() - experiment.startedAt.getTime()) / 864e5)
    : 0;

  const srm = srmCheck(A.visitors, B.visitors, experiment.splitPctB);
  const bucketDrift = Number(driftRows[0]?.n ?? 0);

  const blockers: Bi[] = [];
  const fmt = (n: number, locale: string) => n.toLocaleString(locale);
  if (daysRunning < MIN_RUNTIME_DAYS) {
    blockers.push({
      id: `Baru berjalan ${daysRunning} hari. Minimum ${MIN_RUNTIME_DAYS} hari supaya mencakup dua siklus mingguan penuh — perilaku belanja hari kerja dan akhir pekan berbeda.`,
      en: `Running for only ${daysRunning} day${daysRunning === 1 ? "" : "s"}. The minimum is ${MIN_RUNTIME_DAYS} days so the test covers two full weekly cycles — weekday and weekend shopping behaviour differ.`,
    });
  }
  if (Math.min(A.visitors, B.visitors) < requiredPerArm) {
    const have = Math.min(A.visitors, B.visitors);
    blockers.push({
      id: `Sample belum cukup: ${fmt(have, "id-ID")} dari ${fmt(requiredPerArm, "id-ID")} visitor per grup.`,
      en: `Not enough sample yet: ${fmt(have, "en-GB")} of ${fmt(requiredPerArm, "en-GB")} visitors per group.`,
    });
  }
  if (srm?.mismatch) {
    blockers.push({
      id: `Sample Ratio Mismatch (p=${srm.pValue.toExponential(2)}). Split menyimpang dari ${experiment.splitPctB}% — hampir selalu berarti ada bug, bukan kebetulan. Hasil test TIDAK boleh dipakai sampai ini beres.`,
      en: `Sample Ratio Mismatch (p=${srm.pValue.toExponential(2)}). The split deviates from ${experiment.splitPctB}% — this almost always means a bug, not chance. Do NOT use these results until it is fixed.`,
    });
  }
  if (bucketDrift > 0) {
    blockers.push({
      id: `${bucketDrift} visitor mendapat variant berbeda antara hitungan browser dan server. Logika hash di tl-ab-core.liquid dan app/lib/bucketing.ts sudah tidak sinkron.`,
      en: `${bucketDrift} visitor${bucketDrift === 1 ? "" : "s"} got a different variant in the browser than on the server. The hash logic in tl-ab-core.liquid and app/lib/bucketing.ts is out of sync.`,
    });
  }

  return {
    A,
    B,
    cvr: twoProportionTest({ n: A.visitors, x: A.orders }, { n: B.visitors, x: B.orders }),
    atcRate: twoProportionTest(
      { n: A.visitors, x: A.addToCarts },
      { n: B.visitors, x: B.addToCarts },
    ),
    revenue: revenuePerVisitorTest(
      { n: A.visitors, orders: A.orders, sum: A.revenue, sumSq: A.revenueSq },
      { n: B.visitors, orders: B.orders, sum: B.revenue, sumSq: B.revenueSq },
    ),
    srm,
    bucketDrift,
    requiredPerArm,
    daysRunning,
    readyToConclude: blockers.length === 0,
    blockers,
    daily: daily.map((d) => ({
      date: new Date(d.date).toISOString().slice(0, 10),
      variant: d.variant,
      visitors: Number(d.visitors),
      orders: Number(d.orders),
      revenue: Number(d.revenue),
    })),
  };
}
