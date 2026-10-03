import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { Experiment } from "@prisma/client";
import { flagKeyFor } from "./posthog/taxonomy";
import { componentOf } from "./components";

/**
 * Config yang di-inline ke <head> storefront lewat app-data metafield.
 *
 * Bentuknya sengaja dibuat sekecil mungkin: script di <head> bersifat
 * render-blocking, jadi tiap byte di sini menambah waktu render tiap halaman.
 */
export interface StorefrontConfig {
  v: number;
  /** kill switch global: false -> semua visitor lihat variant A */
  on: boolean;
  /** path App Proxy untuk kirim event */
  ep: string;
  /** nama cookie visitor id */
  ck: string;
  /** umur cookie visitor id dalam hari */
  ckd: number;
  /** domain cookie, mis. ".treelogy.com" */
  ckdom: string;
  /**
   * posthog-js di storefront (opsional, POSTHOG_STOREFRONT=1). Token project
   * bersifat publik (phc_…), sama seperti yang dipasang di snippet mana pun.
   *   t = token, h = api host, r = session replay, hm = heatmap
   */
  ph?: { t: string; h: string; r: 0 | 1; hm: 0 | 1 };
  ex: StorefrontExperiment[];
}

export interface StorefrontExperiment {
  id: string;
  /**
   * flag key PostHog ("tl-ab-<id>"). Dipakai skrip storefront untuk menandai
   * event posthog-js dengan `$feature/<key>` — hanya kalau toko memasang
   * posthog-js; pengiriman utama tetap dari server.
   */
  k: string;
  /** persentase traffic ke variant B */
  s: number;
  /** template suffix variant A; "" = templates/product.json (template default) */
  a: string;
  /** template suffix variant B, mis. "ab-b" */
  b: string;
  /** "*" = semua produk, atau daftar handle */
  h: "*" | string[];
  /** handle yang dikecualikan */
  x: string[];
  /**
   * Component experiments only (omitted for template experiments):
   *   t = "c", c = component key, at = cart attribute the theme reads.
   */
  t?: "c";
  c?: string;
  at?: string;
}

interface UserError {
  message: string;
}

export const AB_METAFIELD_NAMESPACE = "$app:ab";
export const AB_METAFIELD_KEY = "config";

export function buildStorefrontConfig(
  experiments: Experiment[],
  opts: {
    enabled: boolean;
    proxySubpath: string;
    cookieName: string;
    cookieDays: number;
    cookieDomain: string;
    posthog?: { token: string; host: string; replay: boolean; heatmaps: boolean } | null;
  },
): StorefrontConfig {
  return {
    v: 2,
    on: opts.enabled,
    ep: `/apps/${opts.proxySubpath}/collect`,
    ck: opts.cookieName,
    ckd: opts.cookieDays,
    ckdom: opts.cookieDomain,
    ...(opts.posthog
      ? { ph: { t: opts.posthog.token, h: opts.posthog.host, r: opts.posthog.replay ? (1 as const) : (0 as const), hm: opts.posthog.heatmaps ? (1 as const) : (0 as const) } }
      : {}),
    // hanya eksperimen yang benar-benar jalan yang dikirim ke storefront
    ex: experiments
      .filter((e) => e.status === "running")
      .map((e): StorefrontExperiment => {
        const base = {
          id: e.id,
          k: e.posthogFeatureFlagKey ?? flagKeyFor(e.id),
          s: e.splitPctB,
          a: e.variantASuffix ?? "",
          b: e.variantBSuffix,
          h: e.targetType === "all_products" ? ("*" as const) : e.targetHandles,
          x: e.excludeHandles,
        };
        const component = e.kind === "component" ? componentOf(e.component) : null;
        return component ? { ...base, h: [], t: "c", c: component.key, at: component.attribute } : base;
      })
      // A component experiment whose key is unknown must never reach the
      // storefront: the script would not know which attribute to switch.
      .filter((e) => e.t === "c" || e.b !== "" || e.a !== ""),
  };
}

const CURRENT_APP_INSTALLATION = `#graphql
  query CurrentAppInstallation {
    currentAppInstallation { id }
  }
`;

const METAFIELDS_SET = `#graphql
  mutation SetAbConfig($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key updatedAt }
      userErrors { field message code }
    }
  }
`;

/**
 * Tulis config ke app-data metafield (owner = instalasi app ini).
 *
 * Dipakai app-data metafield, bukan shop metafield, karena inilah jalur resmi
 * untuk konfigurasi milik app dan nilainya bisa dibaca theme app extension lewat
 * objek Liquid `app.metafields` tanpa perlu hardcode app id.
 */
export async function publishStorefrontConfig(
  admin: AdminApiContext,
  config: StorefrontConfig,
): Promise<void> {
  const installRes = await admin.graphql(CURRENT_APP_INSTALLATION);
  const installJson = await installRes.json();
  const ownerId = installJson?.data?.currentAppInstallation?.id;
  if (!ownerId) {
    throw new Error("Tidak bisa membaca currentAppInstallation.id — cek scope app.");
  }

  const res = await admin.graphql(METAFIELDS_SET, {
    variables: {
      metafields: [
        {
          ownerId,
          namespace: AB_METAFIELD_NAMESPACE,
          key: AB_METAFIELD_KEY,
          type: "json",
          value: JSON.stringify(config),
        },
      ],
    },
  });
  const json = await res.json();
  const errors: UserError[] = json?.data?.metafieldsSet?.userErrors ?? [];
  if (errors.length > 0) {
    throw new Error(`metafieldsSet gagal: ${errors.map((e) => e.message).join("; ")}`);
  }
}
