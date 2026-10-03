import db from "../db.server";
import { touchHeartbeat } from "./heartbeat.server";
import { kickDrain, outboxRows, type OutboundEvent } from "./posthog/client.server";
import { eventUuid } from "./posthog/taxonomy";
import { featureProps, MAX_TRACK_EVENTS, parseTrackEvent, str, type TrackEnvelope, type TrackRow } from "./track";

export type { TrackEnvelope } from "./track";

/**
 * Jalur event perilaku first-party (cart drawer, …).
 *
 * Kontrak klien (Treelogy assets/cart-analytics.js): event disimpan di antrean
 * localStorage lebih dulu, lalu dikirim ke /apps/tl-ab/track. Antrean baru
 * dihapus setelah server menjawab 2xx — jadi server WAJIB menjawab 2xx hanya
 * kalau barisnya benar-benar tersimpan, dan 5xx kalau tidak, supaya klien
 * mengirim ulang. `uuid` buatan klien membuat kiriman ulang aman (unique).
 *
 * Kontrak event: Treelogy claudedocs/gtm/CART-DRAWER-TRACKING.md
 */

/**
 * Simpan satu kiriman. Melempar kalau database gagal — route menjawab 5xx dan
 * klien mengirim ulang. Event yang tidak sah dibuang diam-diam (mengirim ulang
 * tidak akan membuatnya sah).
 */
export async function ingestTrack(shop: string, envelope: TrackEnvelope): Promise<{ accepted: number; rejected: number }> {
  const now = new Date();
  const raw = Array.isArray(envelope.ev) ? envelope.ev.slice(0, MAX_TRACK_EVENTS) : [];
  const rows = raw.map((r) => (r && typeof r === "object" ? parseTrackEvent(r, now) : null)).filter((r): r is TrackRow => !!r);
  if (rows.length === 0) return { accepted: 0, rejected: raw.length };

  touchHeartbeat("track");
  const visitorId = str(envelope.vid, 64);
  const sessionId = str(envelope.sid, 64);
  const gaClientId = str(envelope.ga, 64);
  const ab = str(envelope.ab, 300);
  const internal = envelope.internal === true;

  const outbound: OutboundEvent[] = internal
    ? []
    : rows.map((r) => ({
        uuid: eventUuid(`track|${r.uuid}`),
        distinctId: visitorId ?? `anon-${r.uuid}`,
        event: r.name,
        occurredAt: r.occurredAt,
        properties: {
          surface: r.surface,
          cart_ui: r.ui,
          cart_action: r.action,
          cart_detail: r.detail,
          variant_id: r.variantId,
          cart_value: r.value,
          cart_ms: r.ms,
          $current_url: r.pagePath,
          locale: r.locale,
          source: "first_party",
          ...featureProps(ab),
        },
      }));
  const posthogRows = outboxRows(outbound);

  await db.$transaction([
    db.interactionEvent.createMany({
      data: rows.map((r) => ({ ...r, shop, visitorId, sessionId, gaClientId, ab, internal })),
      skipDuplicates: true,
    }),
    ...(posthogRows.length > 0 ? [db.postHogOutbox.createMany({ data: posthogRows, skipDuplicates: true })] : []),
  ]);
  if (posthogRows.length > 0) kickDrain();
  return { accepted: rows.length, rejected: raw.length - rows.length };
}
