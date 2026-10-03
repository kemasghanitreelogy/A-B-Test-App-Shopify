import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { ingestCollectPayload, parseCollectPayload } from "../lib/collect.server";

/**
 * Endpoint pengumpul event, dipanggil storefront lewat App Proxy:
 *   https://treelogy.com/apps/tl-ab/collect  ->  POST /proxy/collect
 *
 * Dipanggil pakai navigator.sendBeacon sehingga bersifat fire-and-forget:
 * kegagalan di sini tidak boleh pernah memblokir atau memperlambat render halaman.
 * Karena itu response-nya selalu 204, bahkan saat payload ditolak — client tidak
 * punya apa pun untuk dilakukan dengan pesan error.
 *
 * Web pixel TIDAK lewat sini: sandbox-nya menolak request ke origin toko, jadi
 * pixel memakai /pixel/collect langsung di domain Fly. Logika penerimaannya
 * sama, ada di lib/collect.server.ts.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const noContent = () => new Response(null, { status: 204, headers: CORS_HEADERS });

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Health check dari storefront: GET /apps/tl-ab/collect
  await authenticate.public.appProxy(request);
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") return noContent();

  // Memverifikasi HMAC dari Shopify; melempar kalau signature tidak sah.
  const { session } = await authenticate.public.appProxy(request);
  const shop = session?.shop;
  if (!shop) return noContent();

  const payload = parseCollectPayload(await request.text());
  if (!payload) return noContent();

  await ingestCollectPayload(shop, payload, { source: "storefront", requireKnownVisitor: false });
  return noContent();
};
