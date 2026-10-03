import { flagKeyFor } from "./posthog/taxonomy";

/**
 * Kontrak event perilaku first-party (cart drawer, …) — bagian MURNI, tanpa
 * database, supaya bisa diuji langsung (scripts/verify-track.mjs).
 * Kontrak event: Treelogy claudedocs/gtm/CART-DRAWER-TRACKING.md
 */

export const TRACK_EVENTS = new Set([
  "cart_open",
  "cart_close",
  "cart_line_change",
  "cart_pack_open",
  "cart_pack_select",
  "cart_offer_view",
  "cart_offer_accept",
  "cart_checkout_click",
  "cart_empty_cta",
  "cart_error",
  "cart_loading_timeout",
]);
export const TRACK_SURFACES = new Set(["cart_drawer"]);
export const MAX_TRACK_EVENTS = 50;
/** event yang lebih tua dari ini ditolak: antrean klien memang membuangnya di umur 7 hari */
const MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;

export interface TrackEnvelope {
  vid?: string;
  sid?: string;
  ga?: string;
  ab?: string;
  internal?: boolean;
  ev?: Array<Record<string, unknown>>;
}

export interface TrackRow {
  uuid: string;
  name: string;
  surface: string;
  ui: string | null;
  action: string | null;
  detail: string | null;
  variantId: string | null;
  value: number | null;
  ms: number | null;
  pagePath: string | null;
  locale: string | null;
  occurredAt: Date;
}

export const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : typeof v === "number" ? String(v).slice(0, max) : null;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Murni: ubah satu event mentah jadi baris, atau null kalau tidak sah. */
export function parseTrackEvent(raw: Record<string, unknown>, now: Date): TrackRow | null {
  const uuid = str(raw.id, 64);
  const name = str(raw.n, 40);
  const surface = str(raw.s, 24) ?? "cart_drawer";
  if (!uuid || !/^[A-Za-z0-9-]{8,64}$/.test(uuid)) return null;
  if (!name || !TRACK_EVENTS.has(name) || !TRACK_SURFACES.has(surface)) return null;
  const t = num(raw.t);
  // jam klien bisa meleset; event tanpa waktu sah memakai waktu terima
  let occurredAt = t ? new Date(t) : now;
  if (Number.isNaN(occurredAt.getTime()) || occurredAt.getTime() > now.getTime() + 5 * 60_000) occurredAt = now;
  if (now.getTime() - occurredAt.getTime() > MAX_AGE_MS) return null;
  const ms = num(raw.ms);
  return {
    uuid,
    name,
    surface,
    ui: str(raw.ui, 16),
    action: str(raw.a, 48),
    detail: str(raw.d, 200),
    variantId: str(raw.v, 32),
    value: num(raw.val),
    ms: ms === null ? null : Math.max(0, Math.min(2_147_000_000, Math.round(ms))),
    pagePath: str(raw.p, 200),
    locale: str(raw.l, 16),
    occurredAt,
  };
}

/** "exp1:B,exp2:A" → { "$feature/tl-ab-exp1": "test", … } supaya PostHog bisa memecah per varian */
export function featureProps(ab: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (ab ?? "").split(",")) {
    const [id, v] = pair.split(":");
    if (id && (v === "A" || v === "B")) out[`$feature/${flagKeyFor(id)}`] = v === "B" ? "test" : "control";
  }
  return out;
}
