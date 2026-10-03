import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Autentikasi untuk endpoint internal yang dipanggil dashboard Vercel.
 *
 * Dashboard tidak memegang access token Shopify — hanya app ini yang memegangnya.
 * Jadi aksi apa pun yang menyentuh Shopify (membuat template, menerbitkan
 * metafield) di-relay ke sini. Endpoint ini terbuka ke internet, sehingga
 * signature-nya harus benar-benar diverifikasi, bukan sekadar dicocokkan string.
 */

/** Request yang lebih tua dari ini ditolak, supaya request lama tidak bisa diputar ulang. */
const MAX_SKEW_SECONDS = 300;

export class InternalAuthError extends Error {}

export function verifyInternalRequest(request: Request, rawBody: string): void {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    throw new InternalAuthError("INTERNAL_API_SECRET belum diset di server ini.");
  }

  const timestamp = request.headers.get("X-TL-Timestamp");
  const signature = request.headers.get("X-TL-Signature");
  if (!timestamp || !signature) {
    throw new InternalAuthError("Header signature tidak lengkap.");
  }

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > MAX_SKEW_SECONDS) {
    throw new InternalAuthError("Timestamp di luar toleransi.");
  }

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, "hex");
  } catch {
    throw new InternalAuthError("Signature bukan hex yang sah.");
  }

  // Panjang harus dicek dulu: timingSafeEqual melempar kalau panjangnya beda,
  // dan itu sendiri sudah membocorkan informasi.
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new InternalAuthError("Signature tidak cocok.");
  }
}
