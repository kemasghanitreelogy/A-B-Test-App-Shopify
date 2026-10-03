/**
 * Definisi metric PostHog untuk satu eksperimen.
 *
 * Bentuk JSON mengikuti skema `ExperimentMetric` PostHog (kind, metric_type,
 * series/source/numerator/denominator sebagai EventsNode). Diverifikasi terhadap
 * skema live lewat MCP PostHog saat integrasi ini dibuat; kalau PostHog mengubah
 * skemanya, API akan menolak dengan pesan validasi yang jelas — dan kegagalan itu
 * tersimpan di Experiment.posthogSyncError, bukan didiamkan.
 *
 * Bebas dependency dan efek samping; ikut disalin ke dashboard.
 */
import {
  CORE_METRIC_KEYS,
  EVENTS,
  GUARDRAIL_METRIC_KEYS,
  METRICS,
  PROPS,
  metricUuid,
  type MetricKey,
} from "./taxonomy";

interface EventsNode {
  kind: "EventsNode";
  event: string;
  math?: "total" | "sum";
  math_property?: string;
}

export interface ExperimentMetricDefinition {
  kind: "ExperimentMetric";
  uuid: string;
  name: string;
  metric_type: "funnel" | "mean" | "ratio";
  goal: "increase" | "decrease";
  series?: EventsNode[];
  source?: EventsNode;
  numerator?: EventsNode;
  denominator?: EventsNode;
}

const orderPaid = (): EventsNode => ({ kind: "EventsNode", event: EVENTS.ORDER_PAID });

export function buildMetric(experimentId: string, key: MetricKey): ExperimentMetricDefinition {
  const meta = METRICS[key];
  const base = { kind: "ExperimentMetric" as const, uuid: metricUuid(experimentId, key), name: meta.name, goal: meta.goal };

  switch (key) {
    case "cvr":
      // Funnel: exposure (langkah 0, implisit) -> order paid
      return { ...base, metric_type: "funnel", series: [orderPaid()] };
    case "atc_rate":
      return { ...base, metric_type: "funnel", series: [{ kind: "EventsNode", event: EVENTS.PRODUCT_ADDED_TO_CART }] };
    case "checkout_rate":
      return { ...base, metric_type: "funnel", series: [{ kind: "EventsNode", event: EVENTS.CHECKOUT_STARTED }] };
    case "refund_rate":
      return { ...base, metric_type: "funnel", series: [{ kind: "EventsNode", event: EVENTS.ORDER_REFUNDED }] };
    case "rpv":
      // Mean per pengunjung terpapar: jumlah revenue / jumlah pengunjung.
      return { ...base, metric_type: "mean", source: { ...orderPaid(), math: "sum", math_property: PROPS.REVENUE } };
    case "aov":
      // Ratio: total revenue / jumlah order — denominatornya pembeli, bukan pengunjung.
      return {
        ...base,
        metric_type: "ratio",
        numerator: { ...orderPaid(), math: "sum", math_property: PROPS.REVENUE },
        denominator: { ...orderPaid(), math: "total" },
      };
  }
}

export interface MetricPlan {
  primary: ExperimentMetricDefinition[];
  secondary: ExperimentMetricDefinition[];
}

/**
 * Metric utama lokal jadi satu-satunya primary di PostHog — keputusan hanya boleh
 * bergantung pada satu metric yang ditetapkan sebelum test mulai. Metric lain dan
 * guardrail masuk secondary untuk diagnosis.
 */
export function buildMetricPlan(experimentId: string, primaryMetric: string): MetricPlan {
  const primaryKey = (CORE_METRIC_KEYS as string[]).includes(primaryMetric) ? (primaryMetric as MetricKey) : "cvr";
  const secondaryKeys = [...CORE_METRIC_KEYS.filter((k) => k !== primaryKey), ...GUARDRAIL_METRIC_KEYS];
  return {
    primary: [buildMetric(experimentId, primaryKey)],
    secondary: secondaryKeys.map((k) => buildMetric(experimentId, k)),
  };
}

/** uuid metric -> key lokal, untuk memasangkan hasil yang dibaca balik. */
export function metricKeyByUuid(experimentId: string): Map<string, MetricKey> {
  const map = new Map<string, MetricKey>();
  for (const key of [...CORE_METRIC_KEYS, ...GUARDRAIL_METRIC_KEYS]) map.set(metricUuid(experimentId, key), key);
  return map;
}
