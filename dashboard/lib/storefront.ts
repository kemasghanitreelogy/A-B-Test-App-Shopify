/**
 * Mengambil halaman storefront sungguhan, dari theme live maupun theme preview.
 *
 * Tidak butuh token Admin: Shopify menandai theme unpublished sebagai
 * `previewable`, sehingga bisa diambil hanya dengan parameter `preview_theme_id`.
 * Karena itu seluruh snapshot dan audit tracking berjalan dari sini, tanpa
 * bolak-balik ke bridge.
 */

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

export interface FetchedPage {
  url: string;
  status: number;
  html: string;
  /** nama theme yang benar-benar merender halaman ini, dibaca dari Shopify.theme */
  themeName: string | null;
  themeId: string | null;
  themeRole: string | null;
}

/** Domain storefront publik; dipakai snapshot dan tautan bantuan di dashboard. */
export function storeDomain(): string {
  return process.env.STOREFRONT_DOMAIN || "treelogy.com";
}

/**
 * @param themeId kosongkan untuk theme live
 */
export async function fetchStorefrontPage(
  path: string,
  themeId?: string | null,
): Promise<FetchedPage> {
  const base = `https://${storeDomain()}`;
  const url = new URL(path.startsWith("/") ? path : `/${path}`, base);

  // _ab=0 dan _fd=0 mencegah Shopify mengalihkan ke domain lain atau ke
  // halaman "storefront password"; preview_theme_id memilih theme-nya.
  url.searchParams.set("_ab", "0");
  url.searchParams.set("_fd", "0");
  if (themeId) url.searchParams.set("preview_theme_id", themeId);

  // Permintaan pertama membalas 302 sambil memasang cookie sesi preview, jadi
  // redirect harus diikuti dan cookie-nya dibawa serta.
  const first = await fetch(url.toString(), {
    redirect: "manual",
    headers: { "User-Agent": BROWSER_UA, Accept: "text/html" },
    cache: "no-store",
  });

  let response = first;
  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get("location");
    const cookies = first.headers.getSetCookie?.() ?? [];
    const cookieHeader = cookies.map((c) => c.split(";")[0]).join("; ");
    if (location) {
      response = await fetch(new URL(location, base).toString(), {
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "text/html",
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
        cache: "no-store",
      });
    }
  }

  const html = response.ok ? await response.text() : "";
  const themeMatch = html.match(/Shopify\.theme\s*=\s*(\{[^}]*\})/);
  let themeName: string | null = null;
  let resolvedId: string | null = null;
  let themeRole: string | null = null;
  if (themeMatch) {
    try {
      const parsed = JSON.parse(themeMatch[1]) as { name?: string; id?: number; role?: string };
      themeName = parsed.name ?? null;
      resolvedId = parsed.id != null ? String(parsed.id) : null;
      themeRole = parsed.role ?? null;
    } catch {
      // Format Shopify.theme berubah suatu saat: bukan alasan menggagalkan snapshot.
    }
  }

  return { url: url.toString(), status: response.status, html, themeName, themeId: resolvedId, themeRole };
}

/**
 * Siapkan HTML untuk ditampilkan sebagai snapshot di dalam iframe.
 *
 * Seluruh <script> DIBUANG. Ini bukan sekadar kehati-hatian: halaman toko ini
 * memuat GA4, Google Tag Manager, Google Ads, Meta Pixel, dan Klaviyo. Kalau
 * dibiarkan hidup, setiap kali seseorang membuka preview di dashboard, semua
 * tracker itu ikut menyala dan tercatat sebagai kunjungan sungguhan — sepuluh kali
 * buka preview berarti sepuluh pageview palsu di analitik kamu.
 *
 * <base href> disisipkan supaya CSS, font, dan gambar tetap termuat dari CDN Shopify.
 */
export function sanitizeForSnapshot(html: string): string {
  const base = `https://${storeDomain()}/`;

  let out = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script\b[^>]*\/>/gi, "")
    // noscript sering berisi <img> pixel pelacak — ikut dibuang.
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, "")
    // Atribut event inline masih bisa menjalankan kode.
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "");

  const baseTag = `<base href="${base}">`;
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
  } else {
    out = baseTag + out;
  }

  return out;
}
