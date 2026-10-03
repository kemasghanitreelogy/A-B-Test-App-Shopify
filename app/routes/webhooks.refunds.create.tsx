import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { alreadyProcessed } from "../lib/webhook.server";
import { enqueue } from "../lib/posthog/client.server";
import { orderRefundedEvent } from "../lib/posthog/events.server";

/**
 * Refund mengurangi revenue yang benar-benar diterima. Tanpa ini, variant yang
 * mendorong pembelian impulsif bisa terlihat menang di RPV padahal refund-nya tinggi.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  if (await alreadyProcessed(request, topic, shop)) return new Response();

  const refund = payload as {
    id?: number | string;
    order_id: number | string;
    created_at?: string;
    transactions?: Array<{ amount?: string; currency?: string }>;
  };
  const orderGid = `gid://shopify/Order/${refund.order_id}`;
  const amount = (refund?.transactions ?? []).reduce(
    (sum, t) => sum + Number(t?.amount ?? 0),
    0,
  );
  if (amount <= 0) return new Response();

  const rows = await db.conversion.findMany({
    where: { orderId: { startsWith: `${orderGid}#` } },
    include: { experiment: true },
  });
  for (const row of rows) {
    await db.conversion.update({
      where: { orderId: row.orderId },
      data: { refundedAmount: { increment: amount } },
    });
  }

  // Guardrail "refund rate" di PostHog. Revenue di PostHog tetap kotor; angka
  // bersih (dikurangi refund) hanya ada di hasil lokal — lihat SPEC.
  const refundedAt = refund?.created_at ? new Date(refund.created_at) : new Date();
  await enqueue(
    rows
      .filter((r) => r.visitorId && (r.variant === "A" || r.variant === "B"))
      .map((r) =>
        orderRefundedEvent({
          experiment: r.experiment,
          visitorId: r.visitorId as string,
          variant: r.variant as "A" | "B",
          orderId: String(refund.order_id),
          refundId: String(refund?.id ?? refundedAt.getTime()),
          amount,
          currency: refund?.transactions?.[0]?.currency ?? r.currency,
          occurredAt: refundedAt,
        }),
      ),
  );
  return new Response();
};
