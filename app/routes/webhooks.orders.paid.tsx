import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { EXCLUDED_ORDER_SOURCES, resolveAttributionChain, type SecondaryKeyMatch } from "../lib/attribution";
import { alreadyProcessed } from "../lib/webhook.server";
import { ga4Configured, sendConversionToGa4 } from "../lib/ga4.server";
import { touchHeartbeat } from "../lib/heartbeat.server";
import { enqueue } from "../lib/posthog/client.server";
import { orderPaidEvent } from "../lib/posthog/events.server";
import { tagOrderVariant, variantLabel } from "../lib/order-variant.server";

/**
 * SUMBER KEBENARAN konversi.
 *
 * Sengaja tidak mengandalkan event JavaScript: ad-blocker dan ITP memblokir
 * 10–30% event browser, dan bias itu belum tentu sama besar di variant A dan B —
 * yang justru merusak hasil test. Webhook dikirim server-to-server oleh Shopify
 * sehingga tertangkap 100%.
 *
 * Dipakai orders/paid (bukan orders/create) supaya order COD yang belum dibayar
 * tidak dihitung sebagai konversi.
 *
 * SEMUA order dicatat ke OrderIntake — punya atribusi atau tidak. Order yang
 * kehilangan cart attribute dicoba dipasangkan lewat checkout_token lalu
 * cart_token (lihat lib/attribution.ts); yang tetap gagal disimpan sebagai
 * `unattributed` supaya coverage atribusi bisa diukur, bukan lenyap diam-diam.
 */

interface OrderPayload {
  id: number | string;
  total_price?: string;
  currency?: string;
  financial_status?: string;
  created_at?: string;
  source_name?: string;
  checkout_token?: string | null;
  cart_token?: string | null;
  note_attributes?: Array<{ name?: string; value?: string }>;
}

async function keyMatches(kind: "checkout_token" | "cart_token", value: string | null | undefined): Promise<SecondaryKeyMatch[]> {
  if (!value) return [];
  const rows = await db.attributionKey.findMany({ where: { kind, value } });
  return rows
    .filter((r) => r.variant === "A" || r.variant === "B")
    .map((r) => ({ visitorId: r.visitorId, experimentId: r.experimentId, variant: r.variant as "A" | "B" }));
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);
  if (await alreadyProcessed(request, topic, shop)) return new Response();
  touchHeartbeat("webhook");

  const order = payload as OrderPayload;
  const orderGid = `gid://shopify/Order/${order.id}`;
  const total = Number(order?.total_price ?? 0);
  const currency = order?.currency ?? "IDR";
  const paidAt = order?.created_at ? new Date(order.created_at) : new Date();
  const sourceName = order?.source_name ?? null;
  const excluded = sourceName ? EXCLUDED_ORDER_SOURCES.has(sourceName) : false;

  const resolved = excluded
    ? { visitorId: null, assignments: new Map<string, "A" | "B">(), kind: null }
    : resolveAttributionChain({
        noteAttributes: order?.note_attributes,
        byCheckoutToken: await keyMatches("checkout_token", order?.checkout_token),
        byCartToken: await keyMatches("cart_token", order?.cart_token),
      });

  // Hanya eksperimen milik toko ini yang dihitung; id asing di attribute diabaikan.
  const experiments = await db.experiment.findMany({
    where: { id: { in: [...resolved.assignments.keys()] }, shop },
  });
  const known = new Map(experiments.map((e) => [e.id, e]));
  const attributed = [...resolved.assignments].filter(([id]) => known.has(id));

  /* Skrip storefront menempelkan `_tl_vid` pada SETIAP add-to-cart, terpapar
   * atau tidak. Jadi order yang membawa visitor id tanpa penugasan berasal dari
   * pengunjung yang memang tidak pernah membuka halaman produk selama test
   * (mis. beli dari collection lewat link email) — bukan atribusi yang hilang.
   * Hanya order tanpa jejak sama sekali yang dihitung sebagai "unattributed". */
  const status = excluded
    ? "excluded"
    : attributed.length > 0
      ? "attributed"
      : resolved.visitorId
        ? "not_exposed"
        : "unattributed";

  await db.orderIntake.upsert({
    where: { orderId: orderGid },
    create: {
      orderId: orderGid,
      shop,
      checkoutToken: order?.checkout_token ?? null,
      cartToken: order?.cart_token ?? null,
      totalPrice: total,
      currency,
      financialStatus: order?.financial_status ?? null,
      sourceName,
      createdAt: paidAt,
      status,
      attributionKind: attributed.length > 0 ? resolved.kind : null,
    },
    update: {
      financialStatus: order?.financial_status ?? null,
      status,
      attributionKind: attributed.length > 0 ? resolved.kind : null,
    },
  });

  if (attributed.length === 0) return new Response();

  const { visitorId } = resolved;
  const tagged: Array<{ experimentId: string; name: string; variant: "A" | "B" }> = [];

  for (const [experimentId, variant] of attributed) {
    const experiment = known.get(experimentId)!;
    tagged.push({ experimentId, name: experiment.name, variant });
    await db.conversion.upsert({
      where: { orderId: `${orderGid}#${experimentId}` },
      create: {
        orderId: `${orderGid}#${experimentId}`,
        experimentId,
        variant,
        visitorId,
        totalPrice: total,
        currency,
        financialStatus: order?.financial_status ?? null,
        createdAt: paidAt,
        source: "webhook",
        attributionKind: resolved.kind ?? "cart_attr",
      },
      update: {
        totalPrice: total,
        financialStatus: order?.financial_status ?? null,
      },
    });

    /* Cermin ke PostHog: metric "order paid" untuk conversion rate, RPV, dan AOV.
     *
     * Tanpa visitor id, PostHog tidak bisa memasangkan order ini dengan exposure
     * pengunjungnya, jadi dilewati dan dicatat — bukan dikirim dengan distinct_id
     * palsu yang akan tampil sebagai konversi tanpa exposure. */
    if (visitorId) {
      await enqueue([
        orderPaidEvent({
          experiment,
          visitorId,
          variant,
          orderId: String(order.id),
          revenue: total,
          currency,
          financialStatus: order?.financial_status ?? null,
          occurredAt: paidAt,
        }),
      ]);
    } else {
      console.warn(`[posthog] order ${order.id} tanpa _tl_vid — tidak dikirim ke PostHog`);
    }

    /* Kirim juga ke GA4, supaya order bisa dibelah per variant di sana.
     *
     * Sengaja SESUDAH baris konversi tersimpan, dan kegagalannya tidak pernah
     * membatalkan webhook: GA4 adalah pelaporan sekunder, sedangkan tabel
     * Conversion adalah sumber kebenaran. Kalau urutannya dibalik, gangguan di
     * Google bisa membuat konversi hilang dari hasil test. */
    if (ga4Configured()) {
      const reason = await sendConversionToGa4({
        visitorId,
        experimentId,
        variant,
        orderId: String(order.id),
        value: total,
        currency,
        occurredAt: paidAt,
      });
      if (reason) {
        // Dicatat, bukan didiamkan: GA4 yang diam-diam kehilangan sebagian order
        // menghasilkan laporan yang terlihat lengkap padahal tidak.
        console.warn(`[ga4] order ${order.id} tidak terkirim: ${reason}`);
      }
    }
  }

  /* Tandai order dengan variant-nya supaya Shopify Analytics bisa membelah
   * sales/orders/AOV per variant (lihat lib/order-variant.server.ts).
   *
   * Paling akhir dan tidak pernah membatalkan webhook, sama seperti GA4: tabel
   * Conversion di atas sudah tersimpan dan itulah sumber kebenarannya. */
  if (admin) {
    const reason = await tagOrderVariant(admin, orderGid, variantLabel(tagged));
    if (reason) console.warn(`[order-variant] order ${order.id} tidak ditandai: ${reason}`);
  } else {
    console.warn(`[order-variant] order ${order.id} tidak ditandai: tidak ada sesi admin untuk ${shop}`);
  }

  return new Response();
};
