import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { alreadyProcessed } from "../lib/webhook.server";
import { enqueue } from "../lib/posthog/client.server";
import { orderCancelledEvent } from "../lib/posthog/events.server";

/** Order batal harus dikeluarkan dari hasil, kalau tidak variant bisa terlihat menang palsu. */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  if (await alreadyProcessed(request, topic, shop)) return new Response();

  const order = payload as { id: number | string; cancelled_at?: string };
  const orderGid = `gid://shopify/Order/${order.id}`;
  const cancelledAt = order?.cancelled_at ? new Date(order.cancelled_at) : new Date();
  await db.conversion.updateMany({
    where: { orderId: { startsWith: `${orderGid}#` } },
    data: { cancelledAt },
  });

  /* PostHog tidak bisa "membatalkan" event order paid yang sudah masuk; yang bisa
   * dilakukan adalah mengirim event pembatalan supaya bisa dipakai sebagai
   * guardrail dan dibandingkan dengan angka lokal (yang mengeluarkan order batal). */
  const rows = await db.conversion.findMany({
    where: { orderId: { startsWith: `${orderGid}#` }, visitorId: { not: null } },
    include: { experiment: true },
  });
  await enqueue(
    rows
      .filter((r) => r.variant === "A" || r.variant === "B")
      .map((r) =>
        orderCancelledEvent({
          experiment: r.experiment,
          visitorId: r.visitorId as string,
          variant: r.variant as "A" | "B",
          orderId: String(order.id),
          occurredAt: cancelledAt,
        }),
      ),
  );
  return new Response();
};
