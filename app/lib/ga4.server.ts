import db from "../db.server";

/**
 * Mengirim konversi ke GA4 dari server lewat Measurement Protocol.
 *
 * KENAPA DARI SERVER. Konversi terjadi di checkout Shopify, yang berjalan di
 * dalam sandbox pixel. App pixel wajib memakai runtime_context "strict" dan di
 * sana tidak ada `document`, jadi gtag.js tidak bisa dimuat sama sekali.
 * Sementara integrasi GA4 resmi Shopify (channel Google & YouTube) memakai daftar
 * parameter tertutup yang tidak punya titik sisip untuk parameter buatan sendiri.
 * Jadi tidak ada satu pun jalur client-side yang bisa membawa variant sampai ke
 * event purchase tanpa keluar dari yang didukung Google.
 *
 * KENAPA NAMA EVENTNYA BUKAN "purchase". Kalau dikirim sebagai `purchase`, ia akan
 * berdampingan dengan purchase yang sudah dikirim integrasi GA4 Shopify, dan
 * revenue terhitung DUA KALI tanpa peringatan apa pun. Event ini sengaja diberi
 * nama sendiri supaya berdiri di samping angka resmi, bukan menimpanya, dan
 * di-join lewat transaction_id.
 *
 * Batas dari Google yang relevan:
 *   - backdating maksimal 72 jam
 *   - "only partial reporting may be available" — ini pelengkap, bukan pengganti
 *   - api_secret tidak boleh pernah ada di kode client
 */

const ENDPOINT = "https://www.google-analytics.com/mp/collect";

/** Nama event dibuat bisa diubah supaya tidak pernah tak sengaja jadi "purchase". */
const EVENT_NAME = process.env.GA4_EVENT_NAME || "tl_ab_purchase";

/** Batas backdating Measurement Protocol. */
const MAX_BACKDATE_MS = 72 * 60 * 60 * 1000;

export interface Ga4ConversionInput {
  visitorId: string | null;
  experimentId: string;
  variant: string;
  orderId: string;
  value: number;
  currency: string;
  occurredAt: Date;
}

export function ga4Configured(): boolean {
  return Boolean(process.env.GA4_MEASUREMENT_ID && process.env.GA4_API_SECRET);
}

/**
 * @returns alasan kalau tidak terkirim, atau null kalau berhasil. Tidak pernah
 *          melempar: webhook konversi tidak boleh gagal gara-gara analitik.
 */
export async function sendConversionToGa4(
  input: Ga4ConversionInput,
): Promise<string | null> {
  const measurementId = process.env.GA4_MEASUREMENT_ID;
  const apiSecret = process.env.GA4_API_SECRET;
  if (!measurementId || !apiSecret) return "GA4 belum dikonfigurasi";
  if (!input.visitorId) return "order tidak membawa visitor id";

  // client_id GA4 harus sama dengan yang dipakai tag di storefront, kalau tidak
  // event ini akan dianggap milik pengguna lain dan tidak bisa digabungkan.
  const analytics = await db.visitorAnalytics.findUnique({
    where: { visitorId: input.visitorId },
  });
  if (!analytics?.ga4ClientId) return "client_id GA4 tidak diketahui untuk visitor ini";

  const ageMs = Date.now() - input.occurredAt.getTime();
  if (ageMs > MAX_BACKDATE_MS) return "order lebih tua dari batas 72 jam Measurement Protocol";

  const params: Record<string, string | number> = {
    // Konvensi resmi integrasi eksperimen GA4: TOOL-EXPERIMENT-VARIANT.
    exp_variant_string: `TLAB-${input.experimentId}-${input.variant}`,
    experiment_id: input.experimentId,
    variant_id: input.variant,
    transaction_id: input.orderId,
    value: input.value,
    currency: input.currency,
    // Tanpa ini GA4 memperlakukan event sebagai tidak ter-engage dan bisa
    // membuangnya dari beberapa laporan.
    engagement_time_msec: 1,
  };
  if (analytics.ga4SessionId) params.session_id = analytics.ga4SessionId;

  const body = JSON.stringify({
    client_id: analytics.ga4ClientId,
    timestamp_micros: input.occurredAt.getTime() * 1000,
    non_personalized_ads: true,
    events: [{ name: EVENT_NAME, params }],
  });

  try {
    const res = await fetch(
      `${ENDPOINT}?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(5000),
      },
    );
    // Measurement Protocol membalas 204 tanpa isi, bahkan untuk payload yang
    // salah. Jadi status 2xx TIDAK berarti event diterima dengan benar —
    // verifikasinya harus lewat endpoint debug atau laporan realtime GA4.
    if (!res.ok) return `Measurement Protocol membalas HTTP ${res.status}`;
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
