import { db } from "./db";

/**
 * Domain toko diambil dari Session hasil OAuth, bukan dari environment variable.
 *
 * Shopify menormalkan domain saat OAuth: toko ini bisa dipanggil
 * `treelogymoringa.myshopify.com`, tapi domain kanonik yang menempel pada access
 * token adalah `prkdg7-jt.myshopify.com`. Kalau nilai yang ditulis manusia di env
 * berbeda dari itu, eksperimen akan tersimpan dengan `shop` yang salah dan tidak
 * pernah muncul di daftar — gagal tanpa satu pun pesan error.
 *
 * Session hasil OAuth adalah satu-satunya sumber yang pasti benar, karena di situlah
 * token-nya berada.
 */
export async function getShopDomain(): Promise<string> {
  const session = await db.session.findFirst({
    where: { isOnline: false },
    select: { shop: true },
  });
  if (session) return session.shop;

  const fallback = process.env.SHOPIFY_SHOP_DOMAIN;
  if (fallback) return fallback;

  throw new Error(
    "Belum ada toko yang terhubung. Install dulu app-nya lewat " +
      "/auth/login?shop=<toko>.myshopify.com di app Shopify.",
  );
}
