import type { Prisma } from "@prisma/client";
import db from "../../db.server";
import { LIB_NAME, LIB_VERSION, PH } from "./taxonomy";

/**
 * Pengirim event ke PostHog lewat outbox.
 *
 * KENAPA OUTBOX, BUKAN SDK. posthog-node menyimpan antrean di memori: restart
 * mesin Fly, deploy, atau PostHog yang sedang tidak bisa dihubungi menghilangkan
 * event tanpa jejak — dan hilangnya belum tentu simetris antar variant. Di sini
 * event tersimpan di Postgres dalam transaksi yang sama dengan Event/Conversion,
 * lalu dikirim sesudahnya dengan retry. Tidak ada event yang "kira-kira terkirim".
 *
 * KENAPA /batch LANGSUNG. Endpoint publik PostHog menerima `uuid` dan `timestamp`
 * per event. uuid deterministik membuat kiriman ulang aman, timestamp membuat
 * order yang datang lewat webhook tercatat pada waktu kejadiannya.
 *
 * KENAPA PERSONLESS. Pengunjung toko anonim; profil person tidak diperlukan untuk
 * analisis eksperimen (exposure dan metric dipasangkan lewat distinct_id yang sama,
 * yaitu _tl_vid) dan event personless jauh lebih murah. Bisa diubah lewat
 * POSTHOG_PERSON_PROFILES=always kalau nanti butuh person properties.
 */

export interface OutboundEvent {
  /** kunci idempotensi; uuid event diturunkan dari sini */
  uuid: string;
  distinctId: string;
  event: string;
  properties: Record<string, unknown>;
  occurredAt: Date;
}

export function captureConfigured(): boolean {
  return Boolean(process.env.POSTHOG_PROJECT_TOKEN);
}

function captureHost(): string {
  return (process.env.POSTHOG_HOST || "https://us.i.posthog.com").replace(/\/$/, "");
}

function personProfiles(): boolean {
  return process.env.POSTHOG_PERSON_PROFILES === "always";
}

/** Properti yang menempel di semua event. */
export function commonProperties(): Record<string, unknown> {
  return {
    [PH.PROCESS_PERSON_PROFILE]: personProfiles(),
    [PH.LIB]: LIB_NAME,
    [PH.LIB_VERSION]: LIB_VERSION,
  };
}

/**
 * Baris outbox untuk dimasukkan ke db.$transaction bersama Event/Conversion.
 * Kalau PostHog belum dikonfigurasi, mengembalikan array kosong: tidak ada
 * yang perlu diantrekan.
 */
export function outboxRows(events: OutboundEvent[]): Prisma.PostHogOutboxCreateManyInput[] {
  if (!captureConfigured()) return [];
  return events.map((e) => ({
    uuid: e.uuid,
    distinctId: e.distinctId,
    event: e.event,
    properties: { ...commonProperties(), ...e.properties } as Prisma.InputJsonValue,
    occurredAt: e.occurredAt,
  }));
}

/** Antrekan lalu coba kirim segera. Tidak pernah melempar. */
export async function enqueue(events: OutboundEvent[]): Promise<void> {
  const rows = outboxRows(events);
  if (rows.length === 0) return;
  try {
    await db.postHogOutbox.createMany({ data: rows, skipDuplicates: true });
  } catch (error) {
    console.warn(`[posthog] gagal menulis outbox: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  kickDrain();
}

/** Picu pengiriman tanpa menunggu; aman dipanggil dari handler request. */
export function kickDrain(): void {
  void drainOutbox().catch((error) => {
    console.warn(`[posthog] drain gagal: ${error instanceof Error ? error.message : String(error)}`);
  });
}

const BATCH_SIZE = 200;
const MAX_ATTEMPTS_BEFORE_HOURLY = 8;
const RETENTION_DAYS = 7;

let draining = false;

/** Baris yang sudah di-klaim proses ini. BigInt id dari Postgres. */
interface ClaimedRow {
  id: bigint;
  uuid: string;
  distinctId: string;
  event: string;
  properties: unknown;
  occurredAt: Date;
  attempts: number;
}

/**
 * Ambil sebatch baris SECARA ATOMIK.
 *
 * App ini berjalan di DUA mesin Fly sekaligus. Tanpa klaim atomik, kedua mesin
 * bisa membaca baris yang sama dan mengirimnya dua kali — dan order yang
 * terhitung dua kali menggeser hasil eksperimen tanpa memunculkan error apa pun.
 * `FOR UPDATE SKIP LOCKED` membuat mesin kedua melewati baris yang sedang
 * dipegang mesin pertama, bukan menunggunya.
 *
 * Klaim juga memundurkan nextAttemptAt, sehingga baris yang prosesnya mati di
 * tengah jalan otomatis bisa diambil lagi setelah jeda itu — tidak ada yang
 * tersangkut selamanya.
 */
async function claimBatch(limit: number): Promise<ClaimedRow[]> {
  return db.$queryRaw<ClaimedRow[]>`
    UPDATE "PostHogOutbox"
    SET "nextAttemptAt" = now() + interval '2 minutes'
    WHERE id IN (
      SELECT id FROM "PostHogOutbox"
      WHERE "sentAt" IS NULL AND "nextAttemptAt" <= now()
      ORDER BY id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, uuid, "distinctId", event, properties, "occurredAt", attempts
  `;
}

/**
 * Kirim semua baris yang belum terkirim dan sudah waktunya dicoba.
 *
 * @returns jumlah event yang berhasil dikirim pada panggilan ini
 */
export async function drainOutbox(): Promise<number> {
  if (!captureConfigured() || draining) return 0;
  draining = true;
  let sent = 0;
  try {
    for (;;) {
      const rows = await claimBatch(BATCH_SIZE);
      if (rows.length === 0) break;

      const ids = rows.map((r) => r.id);
      const error = await postBatch(rows);
      if (!error) {
        await db.postHogOutbox.updateMany({
          where: { id: { in: ids } },
          data: { sentAt: new Date(), lastError: null },
        });
        sent += rows.length;
        if (rows.length < BATCH_SIZE) break;
        continue;
      }

      // Gagal = tunda seluruh batch dengan backoff eksponensial, maksimal satu jam.
      // Tidak ada batas percobaan: event lebih baik terlambat daripada hilang, dan
      // antrean yang menumpuk terlihat di dashboard.
      const attempts = Math.min(...rows.map((r) => r.attempts)) + 1;
      const delayMs = Math.min(60 * 60_000, 2 ** Math.min(attempts, MAX_ATTEMPTS_BEFORE_HOURLY) * 15_000);
      await db.postHogOutbox.updateMany({
        where: { id: { in: ids } },
        data: { attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + delayMs), lastError: error.slice(0, 500) },
      });
      console.warn(`[posthog] batch ${rows.length} event gagal (percobaan ${attempts}): ${error}`);
      break;
    }
  } finally {
    draining = false;
  }
  return sent;
}

/** Hapus baris yang sudah terkirim dan lebih tua dari retensi. */
export async function purgeSentOutbox(): Promise<number> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 864e5);
  const res = await db.postHogOutbox.deleteMany({ where: { sentAt: { not: null, lt: cutoff } } });
  return res.count;
}

export async function outboxBacklog(): Promise<{ pending: number; oldestPendingAt: Date | null; lastError: string | null }> {
  const [pending, oldest] = await Promise.all([
    db.postHogOutbox.count({ where: { sentAt: null } }),
    db.postHogOutbox.findFirst({ where: { sentAt: null }, orderBy: { id: "asc" }, select: { createdAt: true, lastError: true } }),
  ]);
  return { pending, oldestPendingAt: oldest?.createdAt ?? null, lastError: oldest?.lastError ?? null };
}

/** @returns pesan error, atau null kalau PostHog menerima batch-nya */
async function postBatch(rows: Array<Omit<ClaimedRow, "id" | "attempts">>): Promise<string | null> {
  const token = process.env.POSTHOG_PROJECT_TOKEN;
  if (!token) return "POSTHOG_PROJECT_TOKEN kosong";
  const body = JSON.stringify({
    api_key: token,
    batch: rows.map((r) => ({
      uuid: r.uuid,
      event: r.event,
      distinct_id: r.distinctId,
      timestamp: r.occurredAt.toISOString(),
      properties: { distinct_id: r.distinctId, ...(r.properties as Record<string, unknown>) },
    })),
  });
  try {
    const res = await fetch(`${captureHost()}/batch/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return null;
    const text = await res.text().catch(() => "");
    return `HTTP ${res.status} ${text.slice(0, 200)}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/* ---------------------------------------------------------------------------
   Drainer latar belakang.

   Dijalankan sekali per proses server. Pengiriman utama terjadi segera setelah
   enqueue; drainer ini hanya menangani sisa yang gagal dan pembersihan. unref()
   supaya tidak menahan proses saat shutdown.
   --------------------------------------------------------------------------- */
const DRAIN_INTERVAL_MS = 30_000;
const PURGE_INTERVAL_MS = 6 * 60 * 60_000;
let started = false;

export function startOutboxDrainer(): void {
  if (started || !captureConfigured()) return;
  started = true;
  setInterval(kickDrain, DRAIN_INTERVAL_MS).unref();
  setInterval(() => {
    purgeSentOutbox().catch(() => {});
  }, PURGE_INTERVAL_MS).unref();
  kickDrain();
}

/**
 * Perbaiki nama event exposure pada baris outbox yang belum terkirim.
 *
 * Nama event exposure yang benar ($feature_flag_called atau $experiment_exposure)
 * baru diketahui SETELAH eksperimen dicerminkan ke PostHog. Kalau sinkronisasi
 * pertama gagal (PostHog tidak bisa dihubungi) sementara pengunjung sudah mulai
 * terbagi, exposure sempat terantre dengan nama default. Nama yang salah tidak
 * ditolak PostHog — ia hanya tidak pernah dihitung sebagai exposure, sehingga
 * eksperimen terlihat kosong tanpa satu pun error.
 *
 * Karena baris yang belum terkirim masih ada di tabel, namanya bisa dibetulkan
 * sebelum sempat berangkat.
 *
 * @returns jumlah baris yang diperbaiki
 */
export async function repairPendingExposureNames(experimentId: string, correctEvent: string): Promise<number> {
  const wrong = ["$feature_flag_called", "$experiment_exposure"].filter((e) => e !== correctEvent);
  if (wrong.length === 0) return 0;
  const res = await db.postHogOutbox.updateMany({
    where: {
      sentAt: null,
      event: { in: wrong },
      properties: { path: ["experiment_id"], equals: experimentId },
    },
    data: { event: correctEvent },
  });
  return res.count;
}
