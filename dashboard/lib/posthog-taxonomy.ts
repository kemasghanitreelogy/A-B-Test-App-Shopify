// ============================================================================
// FILE INI DIHASILKAN OTOMATIS — JANGAN DIEDIT DI SINI.
// Sumber: app/lib/posthog/taxonomy.ts
// Untuk mengubahnya: edit file sumber, lalu jalankan dari root repo:
//     node scripts/sync-dashboard.mjs
// ============================================================================

/**
 * Taksonomi event PostHog untuk eksperimen A/B.
 *
 * SATU-SATUNYA tempat nama event, nama properti, flag key, dan pemetaan variant
 * didefinisikan. Dipakai app Fly.io (pengirim), dashboard Vercel (pembaca hasil),
 * dan diverifikasi lawan skrip storefront oleh scripts/verify-posthog.mjs.
 *
 * File ini sengaja bebas dependency dan bebas efek samping supaya bisa disalin
 * apa adanya ke dashboard oleh scripts/sync-dashboard.mjs.
 *
 * KENAPA POSTHOG TIDAK MELAKUKAN BUCKETING. Keputusan A/B diambil di <head>
 * storefront tanpa satu pun network call, supaya tidak ada flicker dan tidak ada
 * latency. PostHog tidak bisa berada di jalur itu. Karena itu integrasinya mengikuti
 * pola resmi "running experiments without feature flags": bucketing milik kita,
 * PostHog menerima event yang sudah membawa variant, lalu menghitung hasilnya
 * dengan mesin statistiknya sendiri. Dua mesin statistik (lokal dan PostHog)
 * membaca data yang sama — kalau keduanya sepakat, kesimpulan jauh lebih kuat.
 */

/** Variant internal ("A"/"B") -> variant key di PostHog. `control` adalah baseline tetap. */
export const VARIANT_KEY = { A: "control", B: "test" } as const;
export type LocalVariant = keyof typeof VARIANT_KEY;
export type PostHogVariantKey = (typeof VARIANT_KEY)[LocalVariant];

export const VARIANT_NAME: Record<LocalVariant, string> = {
  A: "A — desain saat ini (control)",
  B: "B — desain baru",
};

/** Awalan flag key. Hanya huruf, angka, tanda hubung, garis bawah yang diterima PostHog. */
export const FLAG_KEY_PREFIX = "tl-ab-";

export function flagKeyFor(experimentId: string): string {
  const safe = experimentId.replace(/[^A-Za-z0-9_-]/g, "");
  return `${FLAG_KEY_PREFIX}${safe}`;
}

export const FLAG_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Properti standar yang membuat PostHog mengenali exposure eksperimen. */
export const PH = {
  FEATURE_FLAG: "$feature_flag",
  FEATURE_FLAG_RESPONSE: "$feature_flag_response",
  PROCESS_PERSON_PROFILE: "$process_person_profile",
  LIB: "$lib",
  LIB_VERSION: "$lib_version",
} as const;

/** Properti `$feature/<flag-key>` yang membawa variant pada SEMUA event eksperimen. */
export function featureProperty(flagKey: string): string {
  return `$feature/${flagKey}`;
}

/**
 * Nama event, mengikuti anjuran PostHog "[object] [verb]".
 *
 * Dibedakan dari nama tipe event internal (exposure, add_to_cart, ...) dengan
 * sengaja: nama di sini adalah kontrak publik yang muncul di UI PostHog dan dipakai
 * definisi metric, sedangkan nama internal bebas berubah.
 */
export const EVENTS = {
  /** exposure default PostHog; bisa diganti `$experiment_exposure` sesuai `resolved_exposure_event` */
  EXPOSURE_DEFAULT: "$feature_flag_called",
  PRODUCT_VIEWED: "product viewed",
  PRODUCT_ADDED_TO_CART: "product added to cart",
  CHECKOUT_STARTED: "checkout started",
  CHECKOUT_COMPLETED: "checkout completed",
  /** SUMBER KEBENARAN konversi, dari webhook orders/paid */
  ORDER_PAID: "order paid",
  ORDER_CANCELLED: "order cancelled",
  ORDER_REFUNDED: "order refunded",
  /** guardrail pipeline: hash browser != hash server */
  BUCKET_DRIFT: "bucket drift detected",
} as const;

export type ExperimentEventName = (typeof EVENTS)[keyof typeof EVENTS];

/** Tipe event internal (proxy.collect) -> nama event PostHog. */
export const COLLECT_TYPE_TO_EVENT: Record<string, ExperimentEventName | null> = {
  exposure: null, // dipetakan ke event exposure yang di-resolve per eksperimen
  product_viewed: EVENTS.PRODUCT_VIEWED,
  add_to_cart: EVENTS.PRODUCT_ADDED_TO_CART,
  checkout_started: EVENTS.CHECKOUT_STARTED,
  checkout_completed: EVENTS.CHECKOUT_COMPLETED,
  bucket_drift: EVENTS.BUCKET_DRIFT,
};

/** Nama properti kustom. snake_case, konsisten dengan event dashboard yang sudah ada. */
export const PROPS = {
  EXPERIMENT_ID: "experiment_id",
  EXPERIMENT_NAME: "experiment_name",
  VARIANT: "variant",
  PRODUCT_ID: "product_id",
  PAGE_TYPE: "page_type",
  TEMPLATE_SUFFIX: "template_suffix",
  ORDER_ID: "order_id",
  /** revenue kotor order saat dibayar, dalam mata uang toko */
  REVENUE: "revenue",
  CURRENCY: "currency",
  FINANCIAL_STATUS: "financial_status",
  REFUND_AMOUNT: "refund_amount",
  CLIENT_VARIANT: "client_variant",
  SERVER_VARIANT: "server_variant",
  /** storefront | web_pixel | webhook */
  SOURCE: "source",
  SHOP: "shop",
} as const;

export const LIB_NAME = "treelogy-ab";
export const LIB_VERSION = "1.0.0";

/**
 * Metric eksperimen. Key lokal (cvr, atc_rate, rpv, aov) dipetakan satu-satu ke
 * definisi ExperimentMetric PostHog. uuid-nya deterministik per eksperimen supaya
 * hasil yang dibaca balik bisa dipasangkan lagi ke key lokal tanpa menebak nama.
 */
export type MetricKey = "cvr" | "atc_rate" | "rpv" | "aov" | "checkout_rate" | "refund_rate";

export interface MetricMeta {
  key: MetricKey;
  name: string;
  /** funnel = proporsi pengunjung; mean = rata-rata per pengunjung; ratio = per order */
  metricType: "funnel" | "mean" | "ratio";
  goal: "increase" | "decrease";
  format: "pct" | "money";
  /** metric lokal yang setara, kalau ada */
  localKey?: "cvr" | "atc_rate" | "rpv" | "aov";
}

export const METRICS: Record<MetricKey, MetricMeta> = {
  cvr: { key: "cvr", name: "Conversion rate (order paid)", metricType: "funnel", goal: "increase", format: "pct", localKey: "cvr" },
  atc_rate: { key: "atc_rate", name: "Add-to-cart rate", metricType: "funnel", goal: "increase", format: "pct", localKey: "atc_rate" },
  rpv: { key: "rpv", name: "Revenue per visitor", metricType: "mean", goal: "increase", format: "money", localKey: "rpv" },
  aov: { key: "aov", name: "Average order value", metricType: "ratio", goal: "increase", format: "money", localKey: "aov" },
  checkout_rate: { key: "checkout_rate", name: "Checkout started rate (guardrail)", metricType: "funnel", goal: "increase", format: "pct" },
  refund_rate: { key: "refund_rate", name: "Refund rate (guardrail)", metricType: "funnel", goal: "decrease", format: "pct" },
};

/** Urutan tampil: metric utama lokal selalu jadi primary di PostHog, sisanya secondary. */
export const CORE_METRIC_KEYS: MetricKey[] = ["cvr", "atc_rate", "rpv", "aov"];
export const GUARDRAIL_METRIC_KEYS: MetricKey[] = ["checkout_rate", "refund_rate"];

/**
 * UUID v5 (RFC 4122) tanpa dependency. Dipakai untuk:
 *   - uuid event outbox (dari dedupeKey)  -> kiriman ulang tidak dobel
 *   - uuid metric PostHog (dari experimentId + key) -> hasil bisa dipetakan balik
 *
 * Implementasi SHA-1 murni supaya file ini tetap bisa dijalankan di browser
 * maupun Node tanpa import; hash-nya pendek dan hanya dipanggil per event.
 */
export const TL_AB_NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

export function uuidV5(name: string, namespace: string = TL_AB_NAMESPACE): string {
  const ns = hexToBytes(namespace.replace(/-/g, ""));
  const nameBytes = utf8(name);
  const input = new Uint8Array(ns.length + nameBytes.length);
  input.set(ns, 0);
  input.set(nameBytes, ns.length);
  const hash = sha1(input);
  hash[6] = (hash[6] & 0x0f) | 0x50; // versi 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // varian RFC 4122
  const hex = Array.from(hash.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function metricUuid(experimentId: string, key: MetricKey): string {
  return uuidV5(`tl-ab:${experimentId}:metric:${key}`);
}

export function eventUuid(dedupeKey: string): string {
  return uuidV5(`tl-ab:event:${dedupeKey}`);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function utf8(str: string): Uint8Array {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c >= 0xd800 && c < 0xdc00) {
      const next = str.charCodeAt(++i);
      c = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return new Uint8Array(out);
}

function sha1(message: Uint8Array): Uint8Array {
  const ml = message.length * 8;
  const withOne = new Uint8Array(((message.length + 9 + 63) >> 6) << 6);
  withOne.set(message);
  withOne[message.length] = 0x80;
  const view = new DataView(withOne.buffer);
  view.setUint32(withOne.length - 4, ml >>> 0, false);
  view.setUint32(withOne.length - 8, Math.floor(ml / 0x100000000), false);

  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let off = 0; off < withOne.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, h0, false); ov.setUint32(4, h1, false); ov.setUint32(8, h2, false);
  ov.setUint32(12, h3, false); ov.setUint32(16, h4, false);
  return out;
}
