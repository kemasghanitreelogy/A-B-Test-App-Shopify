import db from "../db.server";

/**
 * Probe liveness + readiness untuk skrip deploy. Sengaja menyentuh database:
 * app yang tidak bisa menjangkau Postgres tidak bisa menyimpan satu event pun,
 * jadi "proses hidup" saja akan meloloskan rilis yang rusak. nginx menolak path
 * ini dari luar; skrip deploy memanggilnya langsung di 127.0.0.1.
 */
export const loader = async () => {
  try {
    await db.$queryRaw`SELECT 1`;
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("healthz: database tak terjangkau", error);
    return Response.json(
      { ok: false },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
};
