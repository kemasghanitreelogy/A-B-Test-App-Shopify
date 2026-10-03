import db from "../db.server";

/**
 * Bukti hidup per sumber event.
 *
 * Ditulis paling sering sekali per 30 detik per proses: yang dibutuhkan hanya
 * "kapan terakhir sumber ini terdengar", bukan hitungan — hitungan diambil dari
 * tabel Event oleh pemeriksaan kesehatan. Kegagalan menulis tidak boleh pernah
 * mengganggu penerimaan event itu sendiri.
 */
const THROTTLE_MS = 30_000;
const lastWrite = new Map<string, number>();

export function touchHeartbeat(source: "storefront" | "pixel" | "webhook" | "track"): void {
  const now = Date.now();
  if (now - (lastWrite.get(source) ?? 0) < THROTTLE_MS) return;
  lastWrite.set(source, now);
  db.sourceHeartbeat
    .upsert({
      where: { source },
      create: { source, lastSeenAt: new Date(now) },
      update: { lastSeenAt: new Date(now) },
    })
    .catch((error) => console.warn(`[heartbeat] ${source}: ${error instanceof Error ? error.message : String(error)}`));
}
