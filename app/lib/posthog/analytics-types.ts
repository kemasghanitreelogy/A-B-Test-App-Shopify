/**
 * Bentuk data analitik per variant yang dibaca dashboard dari PostHog.
 * Bebas dependency; disalin ke dashboard oleh scripts/sync-dashboard.mjs.
 *
 * Semua angka di sini berasal dari posthog-js di browser (pageview, autocapture,
 * heatmap, replay, web vitals), jadi ikut terpotong ad-blocker di KEDUA variant.
 * Dipakai untuk memahami PERILAKU per variant, bukan untuk menentukan pemenang —
 * pemenang tetap dari order webhook.
 */
export type VariantKey = "A" | "B";

export interface VariantEngagement {
  variant: VariantKey;
  pageviews: number;
  visitors: number;
  sessions: number;
  /** detik */
  avgSessionDuration: number | null;
  /** 0..1 */
  bounceRate: number | null;
  clicks: number;
  rageclicks: number;
  deadclicks: number;
  /** 0..100, rata-rata kedalaman scroll maksimum per pageview */
  avgScrollDepth: number | null;
  /** ms */
  lcpP75: number | null;
  /** ms */
  inpP75: number | null;
  clsP75: number | null;
}

export interface BreakdownRow {
  variant: VariantKey;
  value: string;
  visitors: number;
}

export interface DailyEngagementRow {
  date: string;
  variant: VariantKey;
  pageviews: number;
  visitors: number;
}

export interface ReplayRow {
  sessionId: string;
  variant: VariantKey;
  startedAt: string;
  /** detik */
  duration: number;
  clicks: number;
  rageclicks: number;
  errors: number;
  firstUrl: string | null;
  url: string;
}

export interface ProductPageRow {
  path: string;
  visitors: number;
}

export interface PostHogAnalytics {
  /** ISO, batas bawah data (start eksperimen) */
  since: string;
  flagKey: string;
  engagement: VariantEngagement[];
  devices: BreakdownRow[];
  countries: BreakdownRow[];
  daily: DailyEngagementRow[];
  replays: ReplayRow[];
  pages: ProductPageRow[];
  /** true kalau storefront belum mengirim event browser sama sekali */
  empty: boolean;
  /** error per bagian; bagian lain tetap terisi */
  errors: string[];
}

/** attention = lama rata-rata tiap area layar terlihat (diturunkan dari baris scrolldepth yang bertanda waktu) */
export type HeatmapType = "click" | "rageclick" | "mousemove" | "scrolldepth" | "attention";
export const HEATMAP_TYPES: readonly HeatmapType[] = ["click", "rageclick", "mousemove", "scrolldepth", "attention"];
export type HeatmapViewport = "mobile" | "tablet" | "desktop";

export interface HeatmapPoint {
  /** 0..1 dari lebar viewport */
  relX: number;
  /** piksel dari atas dokumen (atau dari atas viewport kalau fixed) */
  y: number;
  fixed: boolean;
  count: number;
}

export interface ScrollBucket {
  /** batas bawah bucket, piksel dari atas dokumen */
  y: number;
  /** jumlah pageview yang mencapai kedalaman ini atau lebih */
  reached: number;
}

/** Elemen yang paling banyak diklik — "click list" ala Hotjar. */
export interface HeatmapElement {
  /** teks tombol/tautan, aria-label, alt gambar, atau href — yang pertama ada */
  label: string;
  tag: string;
  count: number;
  /** pangsa dari semua klik di halaman ini untuk variant ini, 0..1 */
  share: number;
}

export interface VariantHeatmap {
  variant: VariantKey;
  /** URL snapshot yang dipakai overlay (path relatif storefront) */
  path: string;
  points: HeatmapPoint[];
  scroll: ScrollBucket[];
  totalSessions: number;
  maxCount: number;
  /** tinggi viewport rata-rata pengunjung (px dokumen) = garis "lipatan"; null kalau belum ada data */
  foldY: number | null;
  elements: HeatmapElement[];
  /** peta perhatian: detik rata-rata tiap pita 100px terlihat di layar */
  attention: AttentionBucket[];
}

export interface AttentionBucket {
  /** batas atas pita, piksel dari atas dokumen */
  y: number;
  /** perkiraan detik per pengunjung area ini berada di layar (dari durasi & kedalaman scroll $pageleave) */
  seconds: number;
  sessions: number;
}

/** Rekaman sesi yang berinteraksi di sekitar satu titik heatmap. */
export interface HeatmapReplay {
  sessionId: string;
  /** tautan pemutar replay PostHog */
  url: string;
  /** jumlah interaksi sesi ini di sekitar titik */
  count: number;
  occurredAt: string;
}

export interface HeatmapReplayParams {
  path: string;
  type: HeatmapType;
  viewport: HeatmapViewport;
  variant: VariantKey;
  /** 0..1 dari lebar viewport */
  relX: number;
  /** piksel dokumen */
  y: number;
}

/** Satu kelompok lebar layar (16px, satuan tabel heatmaps ÷ scale_factor). */
export interface WidthBucket {
  /** viewport_width mentah di tabel heatmaps (px ÷ 16, dibulatkan ke atas) */
  bucket: number;
  minPx: number;
  maxPx: number;
  sessions: number;
  /** pangsa dari semua sesi di rentang perangkat ini, 0..1 */
  share: number;
}

/** "auto" = lebar paling umum, "all" = seluruh rentang perangkat, angka = bucket tertentu */
export type HeatmapWidth = "auto" | "all" | number;

export interface PostHogHeatmap {
  type: HeatmapType;
  viewport: HeatmapViewport;
  path: string;
  a: VariantHeatmap;
  b: VariantHeatmap;
  errors: string[];
  /** distribusi lebar layar pengunjung di rentang perangkat ini, urut dari yang paling umum */
  widths: WidthBucket[];
  /** bucket yang dipakai untuk menyaring titik; null = seluruh rentang */
  widthBucket: number | null;
  /** lebar (px) yang harus dipakai merender snapshot supaya posisi titik cocok */
  renderWidth: number;
}

/** Lebar render untuk satu bucket: titik tengah rentangnya. */
export function widthBucketPx(bucket: number): number {
  return bucket * 16 - 8;
}

export const VIEWPORT_RANGE: Record<HeatmapViewport, { min: number; max: number; width: number }> = {
  mobile: { min: 320, max: 767, width: 390 },
  tablet: { min: 768, max: 1023, width: 820 },
  desktop: { min: 1024, max: 4096, width: 1280 },
};

/**
 * Jendela waktu data sebuah eksperimen, sebagai potongan klausa HogQL.
 *
 * Batas ATAS wajib ada begitu eksperimen ditutup. Tanpa itu, eksperimen yang
 * sudah selesai terus menyerap data baru setiap kali halaman audit dibuka:
 * angkanya berubah sendiri berhari-hari setelah keputusan diambil, dan dua orang
 * yang membuka halaman yang sama pada hari berbeda melihat hasil yang berbeda —
 * tanpa satu pun tanda bahwa itu tidak wajar.
 *
 * Fungsi murni, tanpa dependensi, supaya bisa diuji langsung.
 */
export function windowClause(from: Date, to: Date | null, column = "timestamp"): string {
  const fmt = (d: Date) => `toDateTime('${d.toISOString().slice(0, 19).replace("T", " ")}')`;
  const lower = `${column} >= ${fmt(from)}`;
  return to ? `${lower} AND ${column} <= ${fmt(to)}` : lower;
}
