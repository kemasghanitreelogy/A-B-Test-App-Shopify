import type { Experiment } from "@prisma/client";
import {
  COLLECT_TYPE_TO_EVENT,
  EVENTS,
  PH,
  PROPS,
  VARIANT_KEY,
  eventUuid,
  featureProperty,
  flagKeyFor,
  type LocalVariant,
} from "./taxonomy";
import type { OutboundEvent } from "./client.server";

/**
 * Pembentuk event PostHog dari kejadian internal.
 *
 * Semua event membawa `$feature/<flag-key>` = variant. Untuk metric PostHog itu
 * tidak wajib (variant ditentukan dari exposure), tapi membuat breakdown per
 * variant di insight biasa dan session replay langsung bisa dipakai.
 */

function flagKeyOf(experiment: Pick<Experiment, "id" | "posthogFeatureFlagKey">): string {
  return experiment.posthogFeatureFlagKey ?? flagKeyFor(experiment.id);
}

function baseProps(experiment: Pick<Experiment, "id" | "name" | "shop" | "posthogFeatureFlagKey">, variant: LocalVariant, source: string) {
  return {
    [featureProperty(flagKeyOf(experiment))]: VARIANT_KEY[variant],
    [PROPS.EXPERIMENT_ID]: experiment.id,
    [PROPS.EXPERIMENT_NAME]: experiment.name,
    [PROPS.VARIANT]: variant,
    [PROPS.SOURCE]: source,
    [PROPS.SHOP]: experiment.shop,
  };
}

type ExperimentRef = Pick<Experiment, "id" | "name" | "shop" | "posthogFeatureFlagKey" | "posthogExposureEvent">;

/**
 * Event dari proxy.collect (storefront / web pixel).
 * @returns null untuk tipe yang tidak dipetakan
 */
export function collectEvent(input: {
  experiment: ExperimentRef;
  visitorId: string;
  variant: LocalVariant;
  type: string;
  productId: string | null;
  dedupeKey: string;
  source: "storefront" | "web_pixel";
  occurredAt: Date;
}): OutboundEvent | null {
  const { experiment, visitorId, variant, type, productId, dedupeKey, source, occurredAt } = input;
  const flagKey = flagKeyOf(experiment);

  if (type === "exposure") {
    // Nama event exposure mengikuti apa yang PostHog resolve untuk eksperimen ini.
    const event = experiment.posthogExposureEvent || EVENTS.EXPOSURE_DEFAULT;
    return {
      uuid: eventUuid(dedupeKey),
      distinctId: visitorId,
      event,
      occurredAt,
      properties: {
        ...baseProps(experiment, variant, source),
        [PH.FEATURE_FLAG]: flagKey,
        [PH.FEATURE_FLAG_RESPONSE]: VARIANT_KEY[variant],
        [PROPS.PRODUCT_ID]: productId ?? "",
      },
    };
  }

  const event = COLLECT_TYPE_TO_EVENT[type];
  if (!event) return null;
  return {
    uuid: eventUuid(dedupeKey),
    distinctId: visitorId,
    event,
    occurredAt,
    properties: { ...baseProps(experiment, variant, source), [PROPS.PRODUCT_ID]: productId ?? "" },
  };
}

export function bucketDriftEvent(input: {
  experiment: ExperimentRef;
  visitorId: string;
  clientVariant: LocalVariant;
  serverVariant: LocalVariant;
  dedupeKey: string;
  occurredAt: Date;
}): OutboundEvent {
  return {
    uuid: eventUuid(input.dedupeKey),
    distinctId: input.visitorId,
    event: EVENTS.BUCKET_DRIFT,
    occurredAt: input.occurredAt,
    properties: {
      ...baseProps(input.experiment, input.clientVariant, "storefront"),
      [PROPS.CLIENT_VARIANT]: input.clientVariant,
      [PROPS.SERVER_VARIANT]: input.serverVariant,
    },
  };
}

/** Konversi dari webhook orders/paid. Revenue kotor; refund dikirim sebagai event terpisah. */
export function orderPaidEvent(input: {
  experiment: ExperimentRef;
  visitorId: string;
  variant: LocalVariant;
  orderId: string;
  revenue: number;
  currency: string;
  financialStatus: string | null;
  occurredAt: Date;
}): OutboundEvent {
  return {
    uuid: eventUuid(`order_paid|${input.experiment.id}|${input.orderId}`),
    distinctId: input.visitorId,
    event: EVENTS.ORDER_PAID,
    occurredAt: input.occurredAt,
    properties: {
      ...baseProps(input.experiment, input.variant, "webhook"),
      [PROPS.ORDER_ID]: input.orderId,
      [PROPS.REVENUE]: input.revenue,
      [PROPS.CURRENCY]: input.currency,
      [PROPS.FINANCIAL_STATUS]: input.financialStatus ?? "",
    },
  };
}

export function orderCancelledEvent(input: {
  experiment: ExperimentRef;
  visitorId: string;
  variant: LocalVariant;
  orderId: string;
  occurredAt: Date;
}): OutboundEvent {
  return {
    uuid: eventUuid(`order_cancelled|${input.experiment.id}|${input.orderId}`),
    distinctId: input.visitorId,
    event: EVENTS.ORDER_CANCELLED,
    occurredAt: input.occurredAt,
    properties: { ...baseProps(input.experiment, input.variant, "webhook"), [PROPS.ORDER_ID]: input.orderId },
  };
}

export function orderRefundedEvent(input: {
  experiment: ExperimentRef;
  visitorId: string;
  variant: LocalVariant;
  orderId: string;
  refundId: string;
  amount: number;
  currency: string;
  occurredAt: Date;
}): OutboundEvent {
  return {
    uuid: eventUuid(`order_refunded|${input.experiment.id}|${input.orderId}|${input.refundId}`),
    distinctId: input.visitorId,
    event: EVENTS.ORDER_REFUNDED,
    occurredAt: input.occurredAt,
    properties: {
      ...baseProps(input.experiment, input.variant, "webhook"),
      [PROPS.ORDER_ID]: input.orderId,
      [PROPS.REFUND_AMOUNT]: input.amount,
      [PROPS.CURRENCY]: input.currency,
    },
  };
}
