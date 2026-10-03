// ============================================================================
// FILE INI DIHASILKAN OTOMATIS — JANGAN DIEDIT DI SINI.
// Sumber: app/lib/bucketing.ts
// Untuk mengubahnya: edit file sumber, lalu jalankan dari root repo:
//     node scripts/sync-dashboard.mjs
// ============================================================================

/**
 * Bucketing deterministik untuk A/B test.
 *
 * PENTING: logika di file ini HARUS identik byte-per-byte dengan versi JavaScript
 * di extensions/tl-ab-embed/snippets/tl-ab-core.liquid. Kalau keduanya berbeda,
 * variant yang dicatat server tidak akan cocok dengan yang dilihat visitor dan
 * seluruh hasil eksperimen jadi tidak valid.
 *
 * Kenapa hash, bukan Math.random():
 *   - visitor yang sama selalu dapat variant yang sama tanpa perlu simpan state
 *   - tidak butuh round-trip ke server -> nol flicker, nol tambahan latency
 *   - distribusi merata, dan bisa diverifikasi ulang di server saat audit SRM
 */

/** FNV-1a 32-bit. Dipilih karena implementasinya pendek (muat inline di <head>) dan cepat. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export type Variant = "A" | "B";

/**
 * @param splitPctB persentase traffic ke variant B (0-100)
 */
export function bucketOf(
  visitorId: string,
  experimentId: string,
  splitPctB: number,
): Variant {
  const bucket = fnv1a32(`${visitorId}:${experimentId}`) % 10000;
  return bucket < splitPctB * 100 ? "B" : "A";
}
