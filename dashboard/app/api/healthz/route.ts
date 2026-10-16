import { db } from "@/lib/db";

/**
 * Probe liveness + readiness untuk skrip deploy, padanan /healthz di app.
 * Sengaja menyentuh database: dashboard yang tidak bisa menjangkau Postgres
 * tidak bisa menampilkan apa pun, jadi "proses hidup" saja akan meloloskan rilis
 * yang rusak. nginx menolak path ini dari luar; skrip deploy memanggilnya
 * langsung di 127.0.0.1.
 */
export const dynamic = "force-dynamic";

export async function GET() {
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
}
