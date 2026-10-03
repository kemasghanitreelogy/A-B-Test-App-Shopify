import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { ingestTrack, type TrackEnvelope } from "../lib/track.server";

/**
 * Penerima event perilaku first-party lewat App Proxy:
 *   https://treelogy.com/apps/tl-ab/track  ->  POST /proxy/track
 *
 * Berbeda dengan /proxy/collect (selalu 204, fire-and-forget), di sini status
 * jawaban ADALAH kontraknya: klien menghapus event dari antreannya hanya
 * setelah 2xx. Jadi 200 hanya setelah tersimpan; kegagalan database = 503
 * dan event tetap di antrean klien untuk dikirim ulang.
 */

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  const shop = session?.shop;
  // Tanpa sesi toko, mengirim ulang tidak akan pernah berhasil — jawab 200
  // supaya klien tidak berputar selamanya, tapi tandai di jawaban.
  if (!shop) return json({ ok: false, reason: "no_session" });

  let envelope: TrackEnvelope;
  try {
    envelope = JSON.parse(await request.text());
  } catch {
    return json({ ok: false, reason: "bad_json" });
  }

  try {
    const result = await ingestTrack(shop, envelope);
    return json({ ok: true, ...result });
  } catch (error) {
    console.error(`[track] gagal menyimpan: ${error instanceof Error ? error.message : String(error)}`);
    return json({ ok: false, reason: "store_failed" }, 503);
  }
};
