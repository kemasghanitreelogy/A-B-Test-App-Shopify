import { Prisma } from "@prisma/client";
import db from "../db.server";

/**
 * Shopify menjamin at-least-once delivery, artinya webhook yang sama BISA datang
 * lebih dari sekali. Tanpa penjagaan ini satu order bisa terhitung dua kali dan
 * menggeser hasil eksperimen.
 *
 * @returns true kalau webhook ini sudah pernah diproses (harus di-skip)
 */
export async function alreadyProcessed(
  request: Request,
  topic: string,
  shop: string,
): Promise<boolean> {
  const webhookId = request.headers.get("X-Shopify-Webhook-Id");
  if (!webhookId) return false;
  try {
    await db.webhookLog.create({ data: { webhookId, topic, shop } });
    return false;
  } catch (error) {
    // Hanya primary key bentrok yang berarti "sudah pernah diproses". Error lain
    // (DB tak terjangkau, pool habis) dilempar: handler membalas 500 dan Shopify
    // mengirim ulang. Dulu semua error dianggap duplikat → dibalas 200 → order
    // hilang tanpa jejak.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return true;
    }
    throw error;
  }
}
