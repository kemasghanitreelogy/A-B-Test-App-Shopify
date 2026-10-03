/**
 * Mendeteksi tracking apa saja yang menyala di sebuah halaman storefront.
 *
 * Gunanya bukan sekadar membuat daftar, tapi menjawab satu pertanyaan yang sering
 * disalahpahami: **tracker mana yang tahu tentang variant A/B, dan mana yang tidak.**
 *
 * Tanpa penjelasan ini, orang mudah mengira GA4 atau Meta akan otomatis memisahkan
 * hasil A dan B — padahal tidak. Keduanya tetap mencatat semuanya jadi satu, dan
 * angka yang keluar dari sana tidak bisa dipakai menyimpulkan test.
 */

import { bi, type Bi } from "./i18n";

export type VariantAwareness = "source-of-truth" | "aware" | "unaware";

export interface TrackerSignature {
  id: string;
  name: string;
  vendor: string;
  pattern: RegExp;
  /** pola untuk menarik ID akun/pixel kalau ada */
  idPattern?: RegExp;
  awareness: VariantAwareness;
  note: Bi;
}

export const TRACKER_SIGNATURES: TrackerSignature[] = [
  {
    id: "ga4",
    name: "Google Analytics 4",
    vendor: "Google",
    pattern: /gtag\(|googletagmanager\.com\/gtag|\bG-[A-Z0-9]{8,}\b/,
    idPattern: /\bG-[A-Z0-9]{8,}\b/g,
    awareness: "unaware",
    note: bi("Mencatat semua pengunjung tanpa membedakan variant. Angkanya tidak bisa dipakai menyimpulkan test.", "Records every visitor without separating variants. Its numbers can't be used to conclude the test."),
  },
  {
    id: "gtm",
    name: "Google Tag Manager",
    vendor: "Google",
    pattern: /googletagmanager\.com\/gtm\.js|\bGTM-[A-Z0-9]+\b/,
    idPattern: /\bGTM-[A-Z0-9]+\b/g,
    awareness: "unaware",
    note: bi("Container yang memuat tag lain. Isinya perlu diperiksa terpisah.", "A container that loads other tags. Check its contents separately."),
  },
  {
    id: "google-ads",
    name: "Google Ads",
    vendor: "Google",
    pattern: /\bAW-[0-9]{9,}\b/,
    idPattern: /\bAW-[0-9]{9,}\b/g,
    awareness: "unaware",
    note: bi("Konversi iklan tetap tercatat utuh, tapi tidak terpisah per variant.", "Ad conversions are still recorded in full, but not split by variant."),
  },
  {
    id: "meta",
    name: "Meta Pixel",
    vendor: "Meta",
    pattern: /\bfbq\(|connect\.facebook\.net\/[^/]+\/fbevents/,
    idPattern: /fbq\(\s*['"]init['"]\s*,\s*['"](\d{15,16})['"]/g,
    awareness: "unaware",
    note: bi("Facebook dan Instagram Ads. Tidak membedakan variant.", "Facebook and Instagram Ads. Doesn't separate variants."),
  },
  {
    id: "tiktok",
    name: "TikTok Pixel",
    vendor: "TikTok",
    pattern: /\bttq\.|analytics\.tiktok\.com/,
    awareness: "unaware",
    note: bi("Tidak membedakan variant.", "Doesn't separate variants."),
  },
  {
    id: "pinterest",
    name: "Pinterest Tag",
    vendor: "Pinterest",
    pattern: /\bpintrk\(|s\.pinimg\.com\/ct/,
    awareness: "unaware",
    note: bi("Tidak membedakan variant.", "Doesn't separate variants."),
  },
  {
    id: "snap",
    name: "Snap Pixel",
    vendor: "Snap",
    pattern: /\bsnaptr\(|sc-static\.net\/scevent/,
    awareness: "unaware",
    note: bi("Tidak membedakan variant.", "Doesn't separate variants."),
  },
  {
    id: "klaviyo",
    name: "Klaviyo",
    vendor: "Klaviyo",
    pattern: /static\.klaviyo\.com|klaviyo\.com\/onsite|_learnq/,
    awareness: "unaware",
    note: bi("Email dan SMS. Profil pelanggan tidak ditandai variant.", "Email and SMS. Customer profiles aren't tagged with a variant."),
  },
  {
    id: "hotjar",
    name: "Hotjar",
    vendor: "Hotjar",
    pattern: /static\.hotjar\.com|hjSiteSettings/,
    awareness: "unaware",
    note: bi("Rekaman sesi dan heatmap. Rekamannya mencampur kedua variant.", "Session recordings and heatmaps. Recordings mix both variants."),
  },
  {
    id: "clarity",
    name: "Microsoft Clarity",
    vendor: "Microsoft",
    pattern: /clarity\.ms/,
    awareness: "unaware",
    note: bi("Rekaman sesi. Mencampur kedua variant.", "Session recordings. Mixes both variants."),
  },
  {
    id: "criteo",
    name: "Criteo",
    vendor: "Criteo",
    pattern: /static\.criteo\.net|criteo\.com\/js/,
    awareness: "unaware",
    note: bi("Retargeting. Tidak membedakan variant.", "Retargeting. Doesn't separate variants."),
  },
  {
    id: "bing",
    name: "Microsoft Ads (Bing)",
    vendor: "Microsoft",
    pattern: /bat\.bing\.com|\buetq\b/,
    awareness: "unaware",
    note: bi("Tidak membedakan variant.", "Doesn't separate variants."),
  },
  {
    id: "linkedin",
    name: "LinkedIn Insight",
    vendor: "LinkedIn",
    pattern: /snap\.licdn\.com|_linkedin_partner_id/,
    awareness: "unaware",
    note: bi("Tidak membedakan variant.", "Doesn't separate variants."),
  },
  {
    id: "twitter",
    name: "X (Twitter) Pixel",
    vendor: "X",
    pattern: /static\.ads-twitter\.com|\btwq\(/,
    awareness: "unaware",
    note: bi("Tidak membedakan variant.", "Doesn't separate variants."),
  },
  {
    id: "shopify-analytics",
    name: "Shopify Analytics",
    vendor: "Shopify",
    pattern: /trekkie|shopify\.com\/s\/trekkie/,
    awareness: "unaware",
    // Tetap "unaware": sessions & conversion rate tidak bisa dibelah per variant.
    note: bi("Laporan bawaan Shopify. Sales, jumlah order, dan AOV bisa dibelah per variant lewat metafield order tl_ab.variant — conversion rate tidak.", "Shopify's built-in reports. Sales, order count and AOV can be split by variant via the tl_ab.variant order metafield — conversion rate can't."),
  },
  {
    id: "shopify-web-pixels",
    name: "Shopify Web Pixels",
    vendor: "Shopify",
    pattern: /web-pixels-manager|webPixelsConfigList/,
    awareness: "aware",
    note: bi("Wadah tempat web pixel app ini berjalan. Pixel milik app ini membaca variant dari cookie.", "The container this app's web pixel runs in. The app's pixel reads the variant from a cookie."),
  },
  {
    id: "tl-ab",
    name: "A/B Test Treelogy",
    vendor: "Treelogy",
    pattern: /__TL_AB__|_tl_vid|\/apps\/tl-ab\//,
    awareness: "source-of-truth",
    note: bi("Menempelkan variant ke cart, lalu konversi dibaca dari webhook orders/paid — kebal ad-blocker.", "Attaches the variant to the cart, then reads conversions from the orders/paid webhook — immune to ad blockers."),
  },
];

export interface DetectedTracker {
  id: string;
  name: string;
  vendor: string;
  awareness: VariantAwareness;
  note: Bi;
  ids: string[];
}

export function detectTrackers(html: string): DetectedTracker[] {
  const found: DetectedTracker[] = [];

  for (const sig of TRACKER_SIGNATURES) {
    if (!sig.pattern.test(html)) continue;

    const ids: string[] = [];
    if (sig.idPattern) {
      // Regex global menyimpan lastIndex antar pemanggilan, jadi disalin dulu.
      const re = new RegExp(sig.idPattern.source, sig.idPattern.flags);
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null) {
        const value = m[1] ?? m[0];
        if (value && !ids.includes(value)) ids.push(value);
        if (ids.length >= 5) break;
      }
    }

    found.push({
      id: sig.id,
      name: sig.name,
      vendor: sig.vendor,
      awareness: sig.awareness,
      note: sig.note,
      ids,
    });
  }

  const rank: Record<VariantAwareness, number> = { "source-of-truth": 0, aware: 1, unaware: 2 };
  return found.sort((a, b) => rank[a.awareness] - rank[b.awareness] || a.name.localeCompare(b.name));
}

/** Web pixel yang terdaftar resmi di Shopify, dibaca dari konfigurasi yang disisipkan ke halaman. */
export function extractShopifyWebPixels(html: string): Array<{ name: string; type: string }> {
  const match = html.match(/"webPixelsConfigList":(\[[\s\S]*?\])\s*[,}]/);
  if (!match) return [];
  try {
    const list = JSON.parse(match[1]) as Array<{ name?: string; type?: string; id?: string }>;
    return list.map((p) => ({ name: p.name ?? p.type ?? "(tanpa nama)", type: p.type ?? "unknown" }));
  } catch {
    return [];
  }
}
