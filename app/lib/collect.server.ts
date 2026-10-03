import db from "../db.server";
import { bucketOf } from "./bucketing";
import { touchHeartbeat } from "./heartbeat.server";
import { kickDrain, outboxRows, type OutboundEvent } from "./posthog/client.server";
import { bucketDriftEvent, collectEvent } from "./posthog/events.server";

/**
 * Penerimaan event funnel — dipakai dua pintu masuk yang berbeda:
 *
 *   1. /proxy/collect  (App Proxy, HMAC Shopify)  ← skrip storefront
 *   2. /pixel/collect  (langsung ke Fly, CORS)     ← web pixel
 *
 * Kenapa dua pintu. Sandbox web pixel milik Shopify MELARANG request ke origin
 * toko sendiri (fetch melempar `RestrictedUrlError: Requests are not allowed to
 * the same origin`), padahal App Proxy hanya ada di origin itu. Jadi pixel harus
 * bicara langsung ke Fly — dan pintu itu tidak punya HMAC, sehingga dijaga
 * dengan cara lain: hanya visitor yang SUDAH dibucket lewat pintu bertanda
 * tangan yang eventnya diterima (`requireKnownVisitor`).
 *
 * SATU TIPE = SATU SUMBER. Storefront mencatat exposure/view/add-to-cart, pixel
 * mencatat checkout_*. Server yang menegakkannya, bukan client: kalau dua sumber
 * boleh mengirim tipe yang sama, coverage per sumber tidak bisa diukur — dan
 * duplikat hanya muncul pada pengunjung yang pixel-nya tidak diblokir, jadi
 * biasnya tidak merata antar variant.
 */

export const MAX_EVENTS_PER_REQUEST = 20;

const STOREFRONT_TYPES = new Set(["exposure", "product_viewed", "add_to_cart", "render_mismatch"]);

/**
 * render_mismatch: komponen dibuka, tapi varian yang dirender halaman berbeda
 * dari penugasan (atribut keranjang belum tertulis). Dicatat untuk health
 * check, TIDAK pernah membuat Assignment — pengunjung itu tidak melihat
 * perlakuannya, jadi memasukkannya ke penyebut membiaskan hasil.
 */
const NON_ASSIGNING_TYPES = new Set(["render_mismatch"]);
const PIXEL_TYPES = new Set(["checkout_started", "checkout_completed"]);
const ALLOWED_BY_SOURCE: Record<IngestOptions["source"], Set<string>> = {
  storefront: STOREFRONT_TYPES,
  web_pixel: PIXEL_TYPES,
};

export interface IncomingEvent {
  e?: string; // experimentId
  v?: string; // variant
  t?: string; // type
  p?: string | number; // productId (theme mengirim angka)
  n?: string; // nonce
}

/** Envelope v1 (`{vid, ev}`) dan v2 (`+ v, sid, keys`) diterima keduanya. */
export interface CollectPayload {
  v?: number;
  vid?: string;
  /** sesi browser (v2) */
  sid?: string;
  ev?: IncomingEvent[];
  /** kunci atribusi sekunder yang terlihat client saat itu (v2) */
  keys?: { cart_token?: string; checkout_token?: string };
  /** identitas GA4 milik pengunjung: c = client_id, s = session_id */
  ga?: { c?: string; s?: string };
}

export interface IngestOptions {
  source: "storefront" | "web_pixel";
  /** true = tolak visitor yang belum punya Assignment (pintu tanpa HMAC) */
  requireKnownVisitor: boolean;
}

export function parseCollectPayload(text: string): CollectPayload | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as CollectPayload) : null;
  } catch {
    return null;
  }
}

const token = (v: unknown, max = 64): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/* /cart.js mengembalikan token berbentuk "hWNH…?key=…", sedangkan
 * order.cart_token di webhook hanya bagian sebelum "?". Tanpa normalisasi ini
 * kunci cart_token tidak pernah cocok — dan tidak ada error yang memberi tahu. */
const bareToken = (v: string | null): string | null => (v ? v.split("?")[0] || null : null);

/** Simpan event yang sah; diam-diam mengabaikan yang tidak. Tidak pernah melempar karena payload. */
export async function ingestCollectPayload(shop: string, payload: CollectPayload, opts: IngestOptions): Promise<void> {
  const visitorId = token(payload.vid);
  if (!visitorId) return;
  const sessionId = token(payload.sid);
  const events = Array.isArray(payload.ev) ? payload.ev.slice(0, MAX_EVENTS_PER_REQUEST) : [];
  const keys = {
    cart_token: bareToken(token(payload.keys?.cart_token, 128)),
    checkout_token: bareToken(token(payload.keys?.checkout_token, 128)),
  };
  const hasKeys = Boolean(keys.cart_token || keys.checkout_token);
  // v2 boleh mengirim envelope TANPA event, hanya untuk menyetorkan kunci
  // (cart_token baru diketahui setelah /cart/update.js membalas).
  if (events.length === 0 && !hasKeys) return;

  touchHeartbeat(opts.source === "web_pixel" ? "pixel" : "storefront");

  /* Identitas GA4 disimpan terpisah dari event.
   *
   * Ini satu-satunya cara membelah revenue GA4 per variant: konversi terjadi di
   * checkout, yang tidak bisa memuat gtag.js, jadi event-nya harus dikirim dari
   * server — dan itu butuh client_id yang hanya terbaca di storefront.
   *
   * Sengaja tidak dititipkan sebagai cart attribute tambahan, karena cart
   * attribute tanpa awalan dua garis bawah terlihat pelanggan di checkout. */
  const gaClientId = opts.source === "storefront" && typeof payload.ga?.c === "string" ? payload.ga.c.slice(0, 64) : "";
  if (gaClientId) {
    const gaSessionId = typeof payload.ga?.s === "string" ? payload.ga.s.slice(0, 32) : null;
    await db.visitorAnalytics.upsert({
      where: { visitorId },
      create: { visitorId, ga4ClientId: gaClientId, ga4SessionId: gaSessionId },
      update: { ga4ClientId: gaClientId, ga4SessionId: gaSessionId },
    });
  }

  const experimentIds = new Set(events.map((e) => e.e).filter((x): x is string => !!x));

  // Penugasan yang sudah ada untuk visitor ini: dipakai sebagai penjaga pintu
  // pixel DAN sebagai sumber variant untuk AttributionKey.
  const existing = await db.assignment.findMany({
    where: { visitorId, experiment: { shop, status: "running" } },
    select: { experimentId: true, variant: true },
  });
  const known = new Map(existing.map((a) => [a.experimentId, a.variant]));
  for (const id of known.keys()) experimentIds.add(id);

  if (opts.requireKnownVisitor && known.size === 0) return;
  if (experimentIds.size === 0) return;

  const experiments = await db.experiment.findMany({
    where: { id: { in: [...experimentIds] }, shop, status: "running" },
  });
  const byId = new Map(experiments.map((e) => [e.id, e]));
  if (byId.size === 0) return;

  const allowed = ALLOWED_BY_SOURCE[opts.source];
  const eventSource = opts.source === "web_pixel" ? "pixel" : "storefront";
  const dayKey = new Date().toISOString().slice(0, 10);
  const eventRows: Array<{
    experimentId: string;
    visitorId: string;
    variant: string;
    type: string;
    productId: string | null;
    source: string;
    sessionId: string | null;
    dedupeKey: string;
  }> = [];
  const assignments = new Map<string, { experimentId: string; variant: string }>();
  const outbound: OutboundEvent[] = [];
  const now = new Date();

  for (const ev of events) {
    const experiment = ev.e ? byId.get(ev.e) : undefined;
    if (!experiment) continue;
    if (opts.requireKnownVisitor && !known.has(experiment.id)) continue;
    if (ev.v !== "A" && ev.v !== "B") continue;
    if (!ev.t || !allowed.has(ev.t)) continue;

    // `product.id | json` di theme menghasilkan ANGKA, bukan string. Kalau hanya
    // string yang diterima, productId selamanya null tanpa satu pun error.
    const productId =
      typeof ev.p === "string" ? ev.p.slice(0, 32) || null : typeof ev.p === "number" ? String(ev.p) : null;
    // Event checkout di-dedupe per checkout, bukan per nonce: pixel bisa memicu
    // ulang saat halaman checkout dimuat kembali, dan itu checkout yang sama.
    const nonce =
      ev.t.startsWith("checkout_") && keys.checkout_token
        ? keys.checkout_token
        : typeof ev.n === "string"
          ? ev.n.slice(0, 32)
          : "";
    const dedupeKey = `${experiment.id}|${visitorId}|${ev.t}|${productId ?? ""}|${dayKey}|${nonce}`;

    eventRows.push({
      experimentId: experiment.id,
      visitorId,
      variant: ev.v,
      type: ev.t,
      productId,
      source: eventSource,
      sessionId,
      dedupeKey,
    });

    // Cermin ke PostHog, dengan uuid yang diturunkan dari dedupeKey yang sama:
    // apa pun yang di-dedupe di sini juga ter-dedupe di sana.
    const mirrored = collectEvent({
      experiment,
      visitorId,
      variant: ev.v,
      type: ev.t,
      productId,
      dedupeKey,
      source: opts.source,
      occurredAt: now,
    });
    if (mirrored) outbound.push(mirrored);

    // Hitung ulang bucket di server. Kalau berbeda dengan yang dilihat visitor,
    // berarti implementasi hash di storefront dan di server sudah tidak sinkron —
    // itu bug serius yang membatalkan hasil test, jadi dicatat eksplisit.
    const serverVariant = bucketOf(visitorId, experiment.id, experiment.splitPctB);
    if (serverVariant !== ev.v) {
      const driftKey = `${experiment.id}|${visitorId}|bucket_drift|${dayKey}`;
      eventRows.push({
        experimentId: experiment.id,
        visitorId,
        variant: ev.v,
        type: "bucket_drift",
        productId: null,
        source: eventSource,
        sessionId,
        dedupeKey: driftKey,
      });
      outbound.push(
        bucketDriftEvent({ experiment, visitorId, clientVariant: ev.v, serverVariant, dedupeKey: driftKey, occurredAt: now }),
      );
    }

    // Hanya pintu bertanda tangan yang boleh membuat penugasan baru.
    if (opts.source === "storefront" && !NON_ASSIGNING_TYPES.has(ev.t)) {
      assignments.set(`${visitorId}:${experiment.id}`, { experimentId: experiment.id, variant: ev.v });
    }
  }

  /* Kunci atribusi sekunder: satu baris per (kunci, eksperimen yang visitor ini ikuti).
   *
   * Variant diambil dari Assignment yang sudah ada — atau dari event exposure di
   * batch yang sama untuk kunjungan pertama — bukan dari kunci itu sendiri. */
  const keyRows: Array<{ kind: string; value: string; visitorId: string; experimentId: string; variant: string }> = [];
  if (hasKeys) {
    const variantByExperiment = new Map(known);
    for (const a of assignments.values()) variantByExperiment.set(a.experimentId, a.variant);
    for (const [experimentId, variant] of variantByExperiment) {
      if (!byId.has(experimentId)) continue;
      if (keys.cart_token) keyRows.push({ kind: "cart_token", value: keys.cart_token, visitorId, experimentId, variant });
      if (keys.checkout_token) keyRows.push({ kind: "checkout_token", value: keys.checkout_token, visitorId, experimentId, variant });
    }
  }

  if (eventRows.length === 0 && keyRows.length === 0) return;

  // Outbox PostHog masuk transaksi yang sama: event yang tercatat lokal pasti
  // ikut terkirim (cepat atau lambat), dan yang ditolak lokal tidak pernah bocor.
  const posthogRows = outboxRows(outbound);

  await db.$transaction([
    // skipDuplicates memakai unique constraint dedupeKey: retry sendBeacon aman
    ...(eventRows.length > 0 ? [db.event.createMany({ data: eventRows, skipDuplicates: true })] : []),
    ...[...assignments.values()].map((a) =>
      db.assignment.upsert({
        where: { visitorId_experimentId: { visitorId, experimentId: a.experimentId } },
        create: { visitorId, experimentId: a.experimentId, variant: a.variant },
        update: { lastSeenAt: new Date() },
      }),
    ),
    // Kunci yang sama dari visitor yang sama boleh datang berkali-kali; kunci
    // yang sudah dimiliki visitor LAIN tidak ditimpa (kunci pertama menang).
    ...(keyRows.length > 0 ? [db.attributionKey.createMany({ data: keyRows, skipDuplicates: true })] : []),
    ...(posthogRows.length > 0 ? [db.postHogOutbox.createMany({ data: posthogRows, skipDuplicates: true })] : []),
  ]);

  if (posthogRows.length > 0) kickDrain();
}
