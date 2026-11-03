import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Screenshot layar pertama PDP tiap variant, untuk kartu "Variants".
 *
 * Disimpan sebagai berkas statis di public/previews/<experimentId>-<a|b>.jpg
 * (ikut build ke build/client) — diambil dengan ?_tl_ab_off=1 supaya tidak
 * tercatat sebagai pengunjung. Tidak ada berkas = kartu tampil tanpa gambar.
 * `?v=` dari mtime membuat gambar baru langsung terlihat setelah deploy.
 */
export function previewImage(experimentId: string, arm: "a" | "b"): { url: string; capturedAt: string } | null {
  const name = `${experimentId}-${arm}.jpg`;
  const file = join(process.cwd(), "build", "client", "previews", name);
  if (!existsSync(file)) return null;
  const mtime = statSync(file).mtime;
  return { url: `/previews/${name}?v=${mtime.getTime()}`, capturedAt: mtime.toISOString() };
}
