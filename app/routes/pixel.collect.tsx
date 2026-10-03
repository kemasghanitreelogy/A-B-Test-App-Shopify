import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { ingestCollectPayload, parseCollectPayload } from "../lib/collect.server";

/**
 * Endpoint pengumpul event KHUSUS web pixel:
 *   https://treelogy-ab.fly.dev/pixel/collect
 *
 * Kenapa tidak lewat App Proxy seperti skrip storefront. Sandbox web pixel milik
 * Shopify menolak fetch ke origin toko sendiri (`RestrictedUrlError: Requests
 * are not allowed to the same origin`) — dan App Proxy memang hanya hidup di
 * origin toko. Sebelum endpoint ini ada, tidak satu pun event checkout pernah
 * sampai, tanpa error apa pun di sisi kita.
 *
 * Tanpa HMAC, pintu ini dijaga dengan aturan di collect.server.ts: hanya
 * visitor yang sudah dibucket lewat pintu bertanda tangan yang diterima, dan
 * pintu ini tidak pernah membuat penugasan baru. Responsnya selalu 204.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const noContent = () => new Response(null, { status: 204, headers: CORS_HEADERS });

/* App ini single-merchant: toko yang berhak adalah toko pemilik sesi offline.
 * Di-cache per proses supaya tiap event tidak membaca tabel sesi. */
let cachedShop: string | null = null;
async function shopDomain(): Promise<string | null> {
  if (cachedShop) return cachedShop;
  const session = await db.session.findFirst({ where: { isOnline: false }, select: { shop: true } });
  cachedShop = session?.shop ?? null;
  return cachedShop;
}

export const loader = async (_: LoaderFunctionArgs) =>
  new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json", ...CORS_HEADERS } });

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") return noContent();
  if (request.method !== "POST") return new Response(null, { status: 405, headers: CORS_HEADERS });

  const shop = await shopDomain();
  if (!shop) return noContent();

  const payload = parseCollectPayload(await request.text());
  if (!payload) return noContent();

  try {
    await ingestCollectPayload(shop, payload, { source: "web_pixel", requireKnownVisitor: true });
  } catch (error) {
    // Pixel tidak bisa berbuat apa-apa dengan error; yang penting tercatat di log.
    console.error(`[pixel.collect] ${error instanceof Error ? error.message : String(error)}`);
  }
  return noContent();
};
