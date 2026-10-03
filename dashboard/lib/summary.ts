import { db } from "./db";
import { twoProportionTest } from "./stats";
import type { Lang } from "./i18n";

export interface ExperimentSummary {
  id: string;
  name: string;
  status: string;
  primaryMetric: string;
  splitPctB: number;
  targetType: string;
  variantBSuffix: string;
  startedAt: Date | null;
  visitorsA: number;
  visitorsB: number;
  ordersA: number;
  ordersB: number;
  minSampleArm: number;
  upliftRelative: number | null;
  probBBeatsA: number | null;
  ciLow: number | null;
  ciHigh: number | null;
}

/**
 * Ringkasan untuk halaman daftar.
 *
 * Sengaja tidak memanggil computeResults() per eksperimen: itu menjalankan lima
 * query berat untuk tiap baris. Di sini cukup dua query agregat untuk seluruh
 * daftar, dan angka detail dihitung saat eksperimen dibuka.
 */
export async function listExperimentSummaries(shop: string): Promise<ExperimentSummary[]> {
  const experiments = await db.experiment.findMany({
    where: { shop },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });
  if (experiments.length === 0) return [];

  const ids = experiments.map((e) => e.id);

  const [assignments, conversions] = await Promise.all([
    db.assignment.groupBy({
      by: ["experimentId", "variant"],
      where: { experimentId: { in: ids } },
      _count: { _all: true },
    }),
    db.conversion.groupBy({
      by: ["experimentId", "variant"],
      where: { experimentId: { in: ids }, cancelledAt: null },
      _count: { _all: true },
    }),
  ]);

  const pick = (
    rows: Array<{ experimentId: string; variant: string; _count: { _all: number } }>,
    id: string,
    variant: string,
  ) => rows.find((r) => r.experimentId === id && r.variant === variant)?._count._all ?? 0;

  return experiments.map((e) => {
    const visitorsA = pick(assignments, e.id, "A");
    const visitorsB = pick(assignments, e.id, "B");
    const ordersA = pick(conversions, e.id, "A");
    const ordersB = pick(conversions, e.id, "B");
    const test = twoProportionTest({ n: visitorsA, x: ordersA }, { n: visitorsB, x: ordersB });

    return {
      id: e.id,
      name: e.name,
      status: e.status,
      primaryMetric: e.primaryMetric,
      splitPctB: e.splitPctB,
      targetType: e.targetType,
      variantBSuffix: e.variantBSuffix,
      startedAt: e.startedAt,
      visitorsA,
      visitorsB,
      ordersA,
      ordersB,
      minSampleArm: e.minSampleArm,
      upliftRelative: test?.upliftRelative ?? null,
      probBBeatsA: test?.probBBeatsA ?? null,
      ciLow: test?.ciLow ?? null,
      ciHigh: test?.ciHigh ?? null,
    };
  });
}

export const METRIC_LABEL: Record<string, string> = {
  cvr: "Conversion rate",
  atc_rate: "Add-to-cart rate",
  rpv: "Revenue per visitor",
  aov: "Average order value",
};

export const TARGET_LABEL: Record<string, string> = {
  all_products: "Semua produk",
  products: "Produk tertentu",
  collections: "Collection tertentu",
};

const TARGET_LABEL_EN: Record<string, string> = {
  all_products: "All products",
  products: "Specific products",
  collections: "Specific collections",
};

/** Label metrik sesuai bahasa pembaca (nama metrik sama di kedua bahasa). */
export function metricLabel(key: string, lang: Lang): string {
  void lang;
  return METRIC_LABEL[key] ?? key;
}

/** Label target sesuai bahasa pembaca. */
export function targetLabel(key: string, lang: Lang): string {
  return (lang === "en" ? TARGET_LABEL_EN[key] : TARGET_LABEL[key]) ?? key;
}
