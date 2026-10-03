import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

/**
 * Menandai order dengan variant-nya supaya bisa dibelah di Shopify Analytics.
 *
 * KENAPA BUKAN CART ATTRIBUTE. Variant sudah menempel di order sebagai note
 * attribute `_tl_ab`, tapi Shopify Analytics tidak membaca note attribute sama
 * sekali — laporannya selalu mencampur A dan B. Yang bisa di-GROUP BY di
 * ShopifyQL hanya metafield order yang definisinya punya capability
 * `analyticsQueryable`:
 *
 *   FROM sales SHOW total_sales, orders
 *   GROUP BY order.metafields.tl_ab.variant DURING last_30_days
 *
 * Batasnya: hanya angka berbasis order (sales, orders, AOV). Schema sessions tidak
 * punya dimensi metafield order, jadi conversion rate per variant tetap dari
 * dashboard ini / PostHog.
 *
 * Semua fungsi di sini tidak pernah melempar: Shopify Analytics adalah pelaporan
 * sekunder, dan kegagalannya tidak boleh membatalkan webhook atau start eksperimen.
 */

export const VARIANT_METAFIELD_NAMESPACE = "tl_ab";
export const VARIANT_METAFIELD_KEY = "variant";

const FIND_DEFINITION = `#graphql
  query VariantMetafieldDefinition($namespace: String!, $key: String!) {
    metafieldDefinitions(first: 1, ownerType: ORDER, namespace: $namespace, key: $key) {
      nodes {
        id
        capabilities { analyticsQueryable { enabled eligible } }
      }
    }
  }
`;

const CREATE_DEFINITION = `#graphql
  mutation CreateVariantMetafieldDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id capabilities { analyticsQueryable { enabled } } }
      userErrors { field message code }
    }
  }
`;

const ENABLE_ANALYTICS = `#graphql
  mutation EnableVariantMetafieldAnalytics($definition: MetafieldDefinitionUpdateInput!) {
    metafieldDefinitionUpdate(definition: $definition) {
      updatedDefinition { id capabilities { analyticsQueryable { enabled } } }
      userErrors { field message code }
    }
  }
`;

const SET_ORDER_VARIANT = `#graphql
  mutation SetOrderVariant($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id value }
      userErrors { field message code }
    }
  }
`;

interface UserError {
  field?: string[] | null;
  message: string;
  code?: string | null;
}

const errorText = (errors: UserError[]) => errors.map((e) => e.message).join("; ");
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Pastikan definisi metafield ada dan bisa di-query di Analytics. Idempoten.
 *
 * @returns null kalau beres, atau alasan kegagalannya
 */
export async function ensureVariantMetafieldDefinition(admin: AdminApiContext): Promise<string | null> {
  try {
    const res = await admin.graphql(FIND_DEFINITION, {
      variables: { namespace: VARIANT_METAFIELD_NAMESPACE, key: VARIANT_METAFIELD_KEY },
    });
    const json = await res.json();
    const existing = json?.data?.metafieldDefinitions?.nodes?.[0];

    if (existing) {
      const cap = existing.capabilities?.analyticsQueryable;
      if (cap?.enabled) return null;
      if (cap && cap.eligible === false) return "definisi metafield tidak eligible untuk analyticsQueryable";

      const upd = await admin.graphql(ENABLE_ANALYTICS, {
        variables: {
          definition: {
            ownerType: "ORDER",
            namespace: VARIANT_METAFIELD_NAMESPACE,
            key: VARIANT_METAFIELD_KEY,
            capabilities: { analyticsQueryable: { enabled: true } },
          },
        },
      });
      const updJson = await upd.json();
      const errors: UserError[] = updJson?.data?.metafieldDefinitionUpdate?.userErrors ?? [];
      return errors.length > 0 ? `metafieldDefinitionUpdate: ${errorText(errors)}` : null;
    }

    const created = await admin.graphql(CREATE_DEFINITION, {
      variables: {
        definition: {
          name: "A/B test variant",
          description: "Variant A/B test yang dilihat pembeli sebelum checkout. Diisi app A/B Test Treelogy.",
          ownerType: "ORDER",
          namespace: VARIANT_METAFIELD_NAMESPACE,
          key: VARIANT_METAFIELD_KEY,
          type: "single_line_text_field",
          capabilities: { analyticsQueryable: { enabled: true } },
        },
      },
    });
    const createdJson = await created.json();
    const errors: UserError[] = createdJson?.data?.metafieldDefinitionCreate?.userErrors ?? [];
    // "Sudah ada" = balapan dengan webhook lain yang baru saja membuatnya.
    if (errors.some((e) => e.code === "TAKEN")) return null;
    return errors.length > 0 ? `metafieldDefinitionCreate: ${errorText(errors)}` : null;
  } catch (error) {
    return messageOf(error);
  }
}

/* Cukup sekali per proses. Tanpa ini tiap order yang dibayar ikut memanggil
 * query definisi, padahal definisinya hampir selalu sudah ada. */
let definitionReady = false;

/**
 * Nilai yang tampil sebagai baris di laporan Shopify Analytics.
 *
 * Satu eksperimen (kasus normal): "Nama eksperimen: B". Kalau pembeli ikut
 * beberapa eksperimen sekaligus, digabung dengan urutan tetap supaya kombinasi
 * yang sama selalu jatuh ke baris yang sama.
 */
export function variantLabel(entries: Array<{ experimentId: string; name: string; variant: "A" | "B" }>): string {
  return [...entries]
    .sort((a, b) => a.experimentId.localeCompare(b.experimentId))
    .map((e) => `${e.name.trim()}: ${e.variant}`)
    .join(" | ")
    .slice(0, 255);
}

/**
 * Tulis variant ke metafield order.
 *
 * @returns null kalau beres, atau alasan kegagalannya
 */
export async function tagOrderVariant(
  admin: AdminApiContext,
  orderGid: string,
  label: string,
): Promise<string | null> {
  if (!definitionReady) {
    const reason = await ensureVariantMetafieldDefinition(admin);
    // Tetap lanjut menulis nilainya: kalau definisi menyusul dibuat, order ini
    // ikut terbaca. Yang hilang hanya kalau nilainya tidak pernah ditulis.
    if (reason) console.warn(`[order-variant] definisi metafield: ${reason}`);
    else definitionReady = true;
  }

  try {
    const res = await admin.graphql(SET_ORDER_VARIANT, {
      variables: {
        metafields: [
          {
            ownerId: orderGid,
            namespace: VARIANT_METAFIELD_NAMESPACE,
            key: VARIANT_METAFIELD_KEY,
            type: "single_line_text_field",
            value: label,
          },
        ],
      },
    });
    const json = await res.json();
    const errors: UserError[] = json?.data?.metafieldsSet?.userErrors ?? [];
    return errors.length > 0 ? `metafieldsSet: ${errorText(errors)}` : null;
  } catch (error) {
    return messageOf(error);
  }
}
