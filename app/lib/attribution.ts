import { ATTR_COMPONENT_EXPERIMENTS } from "./components";

/** Nama cart attribute yang dipasang saat add-to-cart. Prefix "_" = hidden dari customer. */
export const ATTR_EXPERIMENTS = "_tl_ab";
export const ATTR_VISITOR = "_tl_vid";
/**
 * Keanggotaan eksperimen KOMPONEN, ditulis saat komponen benar-benar dilihat
 * (drawer dibuka). Formatnya sama dengan `_tl_ab`. Dipisah dari `_tl_ab`
 * supaya dua alur penulisan (template saat add-to-cart, komponen saat
 * exposure) tidak saling menimpa satu nilai yang sama.
 */
export { ATTR_COMPONENT_EXPERIMENTS };
const ASSIGNMENT_ATTRIBUTES = new Set([ATTR_EXPERIMENTS, ATTR_COMPONENT_EXPERIMENTS]);

export interface ParsedAttribution {
  visitorId: string | null;
  /** experimentId -> variant */
  assignments: Map<string, "A" | "B">;
}

/**
 * Parse note_attributes dari order.
 * Format `_tl_ab` dan `_tl_abx`: "expId:B" atau "exp1:B,exp2:A" untuk beberapa
 * eksperimen sekaligus. Keduanya digabung: satu order bisa ikut test template
 * dan test komponen bersamaan.
 */
export function parseAttribution(
  noteAttributes: Array<{ name?: string; value?: string }> | undefined | null,
): ParsedAttribution {
  const assignments = new Map<string, "A" | "B">();
  let visitorId: string | null = null;

  for (const attr of noteAttributes ?? []) {
    if (!attr?.name) continue;
    if (attr.name === ATTR_VISITOR) {
      visitorId = (attr.value ?? "").trim() || null;
      continue;
    }
    if (!ASSIGNMENT_ATTRIBUTES.has(attr.name)) continue;
    for (const pair of (attr.value ?? "").split(",")) {
      const [expId, variant] = pair.split(":").map((s) => s.trim());
      if (expId && (variant === "A" || variant === "B")) {
        assignments.set(expId, variant);
      }
    }
  }

  return { visitorId, assignments };
}

/* ------------------------------------------------------------------------- */

export type AttributionKind = "cart_attr" | "checkout_token" | "cart_token";

export interface SecondaryKeyMatch {
  visitorId: string;
  experimentId: string;
  variant: "A" | "B";
}

export interface AttributionChainInput {
  noteAttributes: Array<{ name?: string; value?: string }> | undefined | null;
  /** hasil pencarian AttributionKey(kind=checkout_token, value=order.checkout_token) */
  byCheckoutToken: SecondaryKeyMatch[];
  /** hasil pencarian AttributionKey(kind=cart_token, value=order.cart_token) */
  byCartToken: SecondaryKeyMatch[];
}

export interface ResolvedAttribution extends ParsedAttribution {
  kind: AttributionKind | null;
}

/**
 * Rantai atribusi berlapis. Dievaluasi berurutan, berhenti di kecocokan pertama:
 *
 *   1. cart attribute `_tl_ab` (+ `_tl_vid`)  — jalur utama, ditulis skrip storefront
 *   2. `order.checkout_token`                 — kunci dari pixel checkout_started
 *   3. `order.cart_token`                     — kunci dari /cart.js saat add-to-cart
 *
 * Kunci 2–3 hanya menyumbang PASANGAN order↔visitor; variant-nya berasal dari
 * Assignment yang dibuat jalur bertanda tangan, jadi kepercayaannya sama dengan
 * jalur 1. Murni, tanpa database — supaya bisa diuji tanpa Shopify.
 */
export function resolveAttributionChain(input: AttributionChainInput): ResolvedAttribution {
  const primary = parseAttribution(input.noteAttributes);
  if (primary.assignments.size > 0) return { ...primary, kind: "cart_attr" };

  for (const [kind, matches] of [
    ["checkout_token", input.byCheckoutToken],
    ["cart_token", input.byCartToken],
  ] as const) {
    if (matches.length === 0) continue;
    // Satu kunci bisa memuat beberapa eksperimen (visitor ikut dua test sekaligus),
    // tapi selalu satu visitor. Kalau visitornya berbeda-beda, kuncinya ambigu.
    const visitorIds = new Set(matches.map((m) => m.visitorId));
    if (visitorIds.size !== 1) continue;
    const assignments = new Map<string, "A" | "B">();
    for (const m of matches) assignments.set(m.experimentId, m.variant);
    return { visitorId: matches[0].visitorId, assignments, kind };
  }

  return { visitorId: primary.visitorId, assignments: new Map(), kind: null };
}

/** Kanal order yang tidak pernah lewat storefront — dikeluarkan dari coverage, bukan dihitung gagal. */
export const EXCLUDED_ORDER_SOURCES = new Set(["pos", "shopify_draft_order", "subscription_contract"]);
