import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

/**
 * Order hanya dihitung untuk eksperimen produk kalau isinya memuat produk
 * yang dites.
 *
 * Penugasan variant menempel di keranjang begitu pengunjung membuka PDP yang
 * dites, jadi tanpa saringan ini order yang HANYA berisi produk lain (buka PDP
 * kapsul, lalu pindah dan beli powder) ikut terhitung sebagai konversi kapsul,
 * lengkap dengan revenue-nya. Itu mengukur "orang yang pernah melihat desain
 * ini", bukan "orang yang membeli produk ini".
 *
 * Eksperimen all_products dan eksperimen komponen tidak disaring: keduanya
 * memang mengukur seluruh toko. Eksperimen produk juga bisa memilih
 * conversionScope = all_products kalau memang ingin mengukur seluruh belanja
 * pengunjung yang terpapar.
 */

interface TargetSpec {
  kind: string;
  targetType: string;
  targetHandles: string[];
  conversionScope?: string | null;
}

export interface OrderLineItem {
  product_id?: number | string | null;
  properties?: Array<{ name?: string; value?: unknown }> | null;
}

/** true kalau eksperimen ini hanya menghitung order yang memuat produk target. */
export function isProductScoped(e: TargetSpec): boolean {
  return (
    e.kind === "template" &&
    e.targetType !== "all_products" &&
    e.targetHandles.length > 0 &&
    e.conversionScope !== "all_products"
  );
}

const TARGET_PRODUCTS = `#graphql
  query TargetProducts($q: String!) {
    products(first: 250, query: $q) { nodes { id handle } }
  }
`;

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { ids: Set<string>; at: number }>();

/**
 * Handle → id produk numerik (format yang dipakai line_items di payload order).
 *
 * Melempar error kalau API gagal atau satu pun handle tidak ketemu: lebih baik
 * webhook dibalas 500 dan dikirim ulang Shopify daripada order dihitung dengan
 * saringan yang salah.
 */
export async function targetProductIds(admin: AdminApiContext, handles: string[]): Promise<Set<string>> {
  const key = [...handles].sort().join(",");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.ids;

  const q = handles.map((h) => `handle:'${h.replace(/'/g, "")}'`).join(" OR ");
  const res = await admin.graphql(TARGET_PRODUCTS, { variables: { q } });
  const json = (await res.json()) as { data?: { products?: { nodes?: Array<{ id: string; handle: string }> } } };
  const nodes = (json?.data?.products?.nodes ?? []).filter((n) => handles.includes(n.handle));
  if (nodes.length === 0) throw new Error(`produk target tidak ditemukan untuk handle: ${key}`);

  const ids = new Set(nodes.map((n) => n.id.split("/").pop()!));
  cache.set(key, { ids, at: Date.now() });
  return ids;
}

/** Baris hadiah otomatis (`_Gifted`) bukan pembelian, jadi tidak dihitung. */
function isGiftLine(li: OrderLineItem): boolean {
  return (li.properties ?? []).some((p) => p?.name === "_Gifted");
}

export function orderHasTargetProduct(lineItems: OrderLineItem[] | undefined, ids: Set<string>): boolean {
  return (lineItems ?? []).some((li) => li.product_id != null && ids.has(String(li.product_id)) && !isGiftLine(li));
}
