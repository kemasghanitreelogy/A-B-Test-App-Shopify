import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { alreadyProcessed } from "../lib/webhook.server";

/**
 * Sengaja tidak menulis konversi apa pun.
 *
 * Konversi dicatat di orders/paid supaya order yang belum dibayar tidak dihitung.
 * Topik ini tetap di-subscribe hanya sebagai kanal cadangan kalau nanti perlu
 * mendeteksi order yang tidak pernah sampai berstatus paid.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  await alreadyProcessed(request, topic, shop);
  return new Response();
};
