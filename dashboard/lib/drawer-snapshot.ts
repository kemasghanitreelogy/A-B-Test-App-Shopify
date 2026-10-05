import { sanitizeForSnapshot, storeDomain } from "./storefront";

/**
 * Snapshot of the CART DRAWER, open, with a sample cart — for comparing the
 * live drawer (A) with a draft theme's drawer (B) in the wizard.
 *
 * A page snapshot is not enough: the drawer is closed and the cart empty. So
 * each snapshot gets its OWN fresh storefront cart (an isolated cookie jar —
 * never a shopper's), fills it, renders a page through the real theme (live or
 * `preview_theme_id`), strips every script like the page snapshot does, and
 * marks the drawer open (`.mini-cart.active`, the class both drawers use).
 *
 * Free gifts are added by a browser script on the real site; scripts don't run
 * here, so the same rule is applied server-side: the page's `[data-gift-map]`
 * ({trigger variant: [gift variants]}) × quantity, as `_Gifted` lines — what
 * assets/gift-auto-add.js would add.
 */

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

class Jar {
  private cookies = new Map<string, string>();
  take(res: Response) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const kv = c.split(";")[0];
      const i = kv.indexOf("=");
      if (i > 0) this.cookies.set(kv.slice(0, i), kv.slice(i + 1));
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

async function request(jar: Jar, url: string, init: RequestInit = {}): Promise<Response> {
  const base = `https://${storeDomain()}`;
  const send = (u: string, i: RequestInit) =>
    fetch(u, {
      ...i,
      redirect: "manual",
      cache: "no-store",
      headers: { "User-Agent": UA, Cookie: jar.header(), ...(i.headers as Record<string, string> | undefined) },
    });
  let res = await send(url, init);
  jar.take(res);
  // the first preview request answers 302 while setting the preview session cookie
  for (let hop = 0; hop < 3 && res.status >= 300 && res.status < 400; hop++) {
    const location = res.headers.get("location");
    if (!location) break;
    res = await send(new URL(location, base).toString(), { method: "GET" });
    jar.take(res);
  }
  return res;
}

export interface DrawerSnapshotInput {
  /** numeric theme id; null = live */
  themeId: string | null;
  variantId: number;
  quantity: number;
  /** storefront locale prefix, e.g. "id"; null = primary */
  locale: string | null;
}

export async function drawerSnapshot(input: DrawerSnapshotInput): Promise<string> {
  const base = `https://${storeDomain()}`;
  const jar = new Jar();
  const prefix = input.locale ? `/${input.locale}` : "";
  const query = new URLSearchParams({ _ab: "0", _fd: "0" });
  if (input.themeId) query.set("preview_theme_id", input.themeId);
  const pageUrl = () => `${base}${prefix}/pages/contact?${query}&_=${Date.now()}`;

  const add = async (items: Array<{ id: number; quantity: number; properties?: Record<string, string> }>) => {
    const res = await request(jar, `${base}/cart/add.js`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ items }),
    });
    // 429 comes back as HTML: never trust .json() blindly
    if (!res.ok) throw new Error(`Keranjang contoh gagal diisi (HTTP ${res.status}).`);
  };

  // 1. the preview session first (sets the theme for this jar), then the cart
  await request(jar, pageUrl());
  await add([{ id: input.variantId, quantity: input.quantity }]);

  // 2. gifts, by the store's own rule
  let html = await (await request(jar, pageUrl())).text();
  const mapJson = html.match(/<script[^>]*data-gift-map[^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if (mapJson) {
    try {
      const map = JSON.parse(mapJson) as Record<string, Array<string | number>>;
      const gifts = (map[String(input.variantId)] ?? []).map((g) => ({
        id: Number(g),
        quantity: input.quantity,
        properties: { _Gifted: "true" },
      }));
      if (gifts.length) {
        await add(gifts);
        html = await (await request(jar, pageUrl())).text();
      }
    } catch {
      // a broken map only means no gift rows in the snapshot
    }
  }

  if (input.themeId && !html.includes(`"id":${input.themeId}`)) {
    throw new Error("Preview draft theme tidak tersaji — theme mungkin sudah dihapus.");
  }

  // 3. strip scripts (no trackers fire from the dashboard), open the drawer
  let out = sanitizeForSnapshot(html);
  out = out.replace(/class="([^"]*\bmini-cart\b(?![-\w])[^"]*)"/, (_m, c: string) => `class="${c} active"`);
  // the page under a desktop side drawer stays dimmed, like on the site
  out = out.replace(
    /<\/head>/i,
    `<style>html,body{overflow:hidden!important}.mini-cart.active{visibility:visible!important;opacity:1!important}</style></head>`,
  );
  return out;
}

export interface SampleProduct {
  handle: string;
  title: string;
  variants: Array<{ id: number; title: string; price: number }>;
}

/** Vendors kept out of the catalog: LP-funnel listings, their gifts, and the legacy TEST name. */
const HIDDEN_VENDORS = new Set(["TEST", "Landing Page", "Gift"]);

/** Products a sample cart can hold: the real catalog rule (vendor ∉ HIDDEN_VENDORS, price > 0). */
export async function sampleProducts(): Promise<SampleProduct[]> {
  const res = await fetch(`https://${storeDomain()}/products.json?limit=250`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    next: { revalidate: 600 },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    products: Array<{
      handle: string;
      title: string;
      vendor: string;
      variants: Array<{ id: number; title: string; price: string; available: boolean }>;
    }>;
  };
  return data.products
    .filter((p) => !HIDDEN_VENDORS.has(p.vendor))
    .map((p) => ({
      handle: p.handle,
      title: p.title,
      variants: p.variants
        .filter((v) => Number(v.price) > 0 && v.available)
        .map((v) => ({ id: v.id, title: v.title, price: Number(v.price) })),
    }))
    .filter((p) => p.variants.length > 0);
}
