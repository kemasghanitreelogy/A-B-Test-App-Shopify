import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { buildStorefrontConfig, publishStorefrontConfig } from "./config.server";
import {
  checkComponentReadiness,
  ensureVariantTemplate,
  getMainTheme,
  productTemplateFilename,
  readThemeFile,
  checksumOf,
} from "./theme.server";
import { componentOf } from "./components";
import { activateComponentVariant } from "./component-variant.server";
import type { VariantEntries } from "./component-variant";
import { mirrorTransition } from "./posthog/experiments.server";
import { ensureWebPixel } from "./pixel.server";
import { ensureVariantMetafieldDefinition } from "./order-variant.server";

export const COOKIE_NAME = "_tl_vid";
export const COOKIE_DAYS = 180;

function env(name: string, fallback: string) {
  return process.env[name] || fallback;
}

/**
 * posthog-js di storefront: heatmap, session replay, web analytics per variant.
 * Dimatikan dengan POSTHOG_STOREFRONT=0. Replay dan heatmap masing-masing bisa
 * dimatikan terpisah (POSTHOG_STOREFRONT_REPLAY / POSTHOG_STOREFRONT_HEATMAPS).
 */
function storefrontPostHog() {
  const token = process.env.POSTHOG_PROJECT_TOKEN;
  if (!token || process.env.POSTHOG_STOREFRONT === "0") return null;
  return {
    token,
    host: env("POSTHOG_HOST", "https://us.i.posthog.com"),
    replay: process.env.POSTHOG_STOREFRONT_REPLAY !== "0",
    heatmaps: process.env.POSTHOG_STOREFRONT_HEATMAPS !== "0",
  };
}

/** Field yang tidak boleh diubah lagi setelah eksperimen mulai berjalan. */
export const LOCKED_WHEN_RUNNING = ["primaryMetric", "mdeRelative", "splitPctB", "variantBSuffix", "targetType"] as const;

interface CollectionProductsPage {
  nodes: Array<{ handle?: string }>;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

const PRODUCT_HANDLES = `#graphql
  query ProductHandles($ids: [ID!]!) {
    nodes(ids: $ids) { ... on Product { handle } }
  }
`;

const COLLECTION_PRODUCTS = `#graphql
  query CollectionProducts($id: ID!, $cursor: String) {
    collection(id: $id) {
      products(first: 250, after: $cursor) {
        nodes { handle }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

/**
 * Ubah pilihan resource picker menjadi daftar handle produk.
 *
 * Sengaja di-resolve saat publish, bukan saat runtime: script di <head> hanya
 * boleh melakukan pencocokan string, tidak boleh memanggil API apa pun.
 */
export async function resolveTargetHandles(
  admin: AdminApiContext,
  targetType: string,
  targetIds: string[],
): Promise<string[]> {
  if (targetType === "all_products" || targetIds.length === 0) return [];

  if (targetType === "products") {
    const res = await admin.graphql(PRODUCT_HANDLES, { variables: { ids: targetIds } });
    const json = await res.json();
    const nodes: Array<{ handle?: string } | null> = json?.data?.nodes ?? [];
    return nodes
      .map((n) => n?.handle)
      .filter((h): h is string => typeof h === "string");
  }

  if (targetType === "collections") {
    const handles = new Set<string>();
    for (const id of targetIds) {
      let cursor: string | null = null;
      // Batas 4 halaman (1000 produk) supaya publish tidak menggantung pada
      // collection raksasa. Kalau kena batas ini, pakai targeting produk.
      for (let page = 0; page < 4; page++) {
        const res = await admin.graphql(COLLECTION_PRODUCTS, { variables: { id, cursor } });
        const json = (await res.json()) as {
          data?: { collection?: { products?: CollectionProductsPage } };
        };
        const conn = json?.data?.collection?.products;
        for (const n of conn?.nodes ?? []) if (n?.handle) handles.add(n.handle);
        if (!conn?.pageInfo?.hasNextPage) break;
        cursor = conn.pageInfo.endCursor ?? null;
      }
    }
    return [...handles];
  }

  return [];
}

/**
 * Tulis ulang config storefront dari seluruh eksperimen milik shop ini.
 *
 * Selalu dipanggil dengan gambaran lengkap (bukan menambal satu eksperimen)
 * supaya metafield tidak pernah menyimpan eksperimen yang sebenarnya sudah
 * dihentikan.
 */
export async function republishConfig(admin: AdminApiContext, shop: string, enabled = true) {
  const experiments = await db.experiment.findMany({ where: { shop } });
  const config = buildStorefrontConfig(experiments, {
    enabled,
    proxySubpath: env("AB_PROXY_SUBPATH", "tl-ab"),
    cookieName: COOKIE_NAME,
    cookieDays: COOKIE_DAYS,
    cookieDomain: env("AB_COOKIE_DOMAIN", ""),
    posthog: storefrontPostHog(),
  });
  await publishStorefrontConfig(admin, config);
  return config;
}

export interface StartResult {
  templateCreated: boolean;
  handleCount: number;
  themeEditorSuffix: string;
  /** berapa terjemahan template ikut disalin ke variant B */
  translationsCopied: number;
  /** teks variant B yang masih harus diterjemahkan manusia */
  translationsNeedManual: number;
  warnings: string[];
}

/** Jalankan eksperimen: siapkan template B, resolve target, kunci metric, publish config. */
export async function startExperiment(
  admin: AdminApiContext,
  shop: string,
  experimentId: string,
): Promise<StartResult> {
  const experiment = await db.experiment.findUniqueOrThrow({ where: { id: experimentId } });
  const theme = await getMainTheme(admin);

  if (experiment.kind === "component") return startComponentExperiment(admin, shop, experiment, theme.id);

  const { created, checksum, translations, warnings } = await ensureVariantTemplate(
    admin,
    theme.id,
    experiment.variantBSuffix,
  );
  const handles = await resolveTargetHandles(admin, experiment.targetType, experiment.targetIds);

  if (experiment.targetType !== "all_products" && handles.length === 0 && experiment.targetHandles.length === 0) {
    throw new Error(
      "Tidak ada produk yang cocok dengan targeting ini. Pilih produk/collection lewat picker, atau isi handle produk secara manual.",
    );
  }

  // Checksum A disimpan bersama B: kalau keduanya sama, test ini A/A —
  // sah untuk memvalidasi pipeline, tapi harus terlihat, bukan disangka test desain.
  const templateA = await readThemeFile(admin, theme.id, productTemplateFilename(null));
  const checksumA = templateA ? checksumOf(templateA) : null;
  if (checksumA && checksumA === checksum) {
    warnings.push("Template B IDENTIK dengan A — ini A/A test. Pengunjung B melihat halaman yang sama persis.");
  }

  await db.experiment.update({
    where: { id: experimentId },
    data: {
      status: "running",
      startedAt: experiment.startedAt ?? new Date(),
      endedAt: null,
      targetHandles: handles.length > 0 ? handles : experiment.targetHandles,
      variantBChecksum: checksum,
      variantAChecksum: checksumA,
    },
  });

  /* Cerminkan ke PostHog SEBELUM config storefront terbit.
   *
   * Urutannya penting. Nama event exposure yang benar ($feature_flag_called atau
   * $experiment_exposure) baru diketahui dari jawaban PostHog. Kalau storefront
   * dinyalakan lebih dulu, exposure pertama bisa terkirim dengan nama yang salah —
   * dan nama yang salah tidak ditolak PostHog, ia hanya tidak pernah terhitung.
   * Eksperimen akan terlihat kosong tanpa satu pun error.
   *
   * PostHog tetap bukan sumber kebenaran lifecycle: kalau sinkronisasinya gagal,
   * eksperimen tetap dijalankan dan alasannya tersimpan di posthogSyncError,
   * ditampilkan dashboard beserta tombol sinkron ulang. */
  const posthogError = await mirrorTransition(experimentId, "start");
  if (posthogError) warnings.push(`PostHog tidak tersinkron: ${posthogError}`);

  /* Aktifkan web pixel kalau belum. Men-deploy extension saja tidak cukup —
   * tanpa record yang dibuat lewat webPixelCreate, pixel terdaftar tapi tidak
   * pernah berjalan, dan langkah "Mulai checkout" di funnel selamanya nol tanpa
   * satu pun tanda bahwa itu bukan angka sebenarnya. */
  const pixel = await ensureWebPixel(admin);
  if (pixel.error) warnings.push(`Web pixel tidak aktif: ${pixel.error} Funnel "Mulai checkout" akan kosong.`);

  /* Definisi metafield variant di order, supaya Shopify Analytics bisa membelah
   * order per variant. Dibuat di sini juga (bukan hanya saat order pertama masuk)
   * supaya kegagalannya — mis. scope write_orders belum disetujui — langsung
   * terlihat sebagai peringatan saat start, bukan diam-diam di log webhook. */
  const metafieldError = await ensureVariantMetafieldDefinition(admin);
  if (metafieldError) {
    warnings.push(`Shopify Analytics tidak bisa membedakan variant: ${metafieldError}`);
  }

  await republishConfig(admin, shop);

  return {
    templateCreated: created,
    handleCount: handles.length || experiment.targetHandles.length,
    themeEditorSuffix: experiment.variantBSuffix,
    translationsCopied: translations?.copied ?? 0,
    translationsNeedManual: translations?.needsManual.length ?? 0,
    warnings,
  };
}

/**
 * Jalankan eksperimen KOMPONEN (claudedocs/SPEC-component-experiments.md).
 *
 * Tidak ada template yang dibuat dan tidak ada handle produk yang di-resolve:
 * saklarnya atribut keranjang yang dibaca tema. Sebagai gantinya, theme live
 * WAJIB lolos preflight — setiap berkas yang merender komponen membaca
 * atributnya — dan hanya boleh ada satu eksperimen berjalan per komponen,
 * karena dua eksperimen akan berebut atribut yang sama.
 */
async function startComponentExperiment(
  admin: AdminApiContext,
  shop: string,
  experiment: {
    id: string;
    name: string;
    component: string | null;
    startedAt: Date | null;
    variantBEntries: unknown;
    variantBSourceThemeName: string | null;
  },
  themeId: string,
): Promise<StartResult> {
  const component = componentOf(experiment.component);
  if (!component) throw new Error(`Komponen "${experiment.component ?? ""}" tidak dikenal.`);

  const clash = await db.experiment.findFirst({
    where: { shop, status: "running", kind: "component", component: component.key, id: { not: experiment.id } },
    select: { name: true },
  });
  if (clash) {
    throw new Error(
      `Eksperimen "${clash.name}" sudah menguji ${component.label.id}. Hentikan dulu — dua eksperimen tidak bisa memakai saklar yang sama.`,
    );
  }

  /* Arahkan entry varian B ke B milik eksperimen INI (salinan dari draft
     theme, atau B bawaan komponen). Sebelum preflight: preflight memeriksa
     entry itu juga. Yang ditulis hanya dua snippet entry — salinan B sudah
     ada sejak eksperimen dibuat, dan tanpa atribut tidak ada yang merendernya. */
  const activation = await activateComponentVariant(admin, {
    liveThemeId: themeId,
    component: component.key,
    entries: parseEntries(experiment.variantBEntries),
    owner: experiment.name,
  });

  const readiness = await checkComponentReadiness(admin, themeId, component);
  if (!readiness.ok) {
    const detail = readiness.problems
      .map((p) =>
        p.reason === "missing_file"
          ? `${p.file} tidak ada`
          : p.reason === "bypass"
            ? `${p.file} masih merender drawer tanpa saklar`
            : `${p.file} belum memakai saklar`,
      )
      .join("; ");
    throw new Error(`Theme live belum siap untuk test ${component.label.id}: ${detail}.`);
  }

  await db.experiment.update({
    where: { id: experiment.id },
    data: { status: "running", startedAt: experiment.startedAt ?? new Date(), endedAt: null },
  });

  const warnings: string[] = [];
  warnings.push(`Varian B: ${activation.entries.shell} / ${activation.entries.content} (dari ${experiment.variantBSourceThemeName ?? "draft theme"}).`);
  const posthogError = await mirrorTransition(experiment.id, "start");
  if (posthogError) warnings.push(`PostHog tidak tersinkron: ${posthogError}`);
  const pixel = await ensureWebPixel(admin);
  if (pixel.error) warnings.push(`Web pixel tidak aktif: ${pixel.error} Funnel "Mulai checkout" akan kosong.`);
  const metafieldError = await ensureVariantMetafieldDefinition(admin);
  if (metafieldError) warnings.push(`Shopify Analytics tidak bisa membedakan variant: ${metafieldError}`);

  await republishConfig(admin, shop);

  return {
    templateCreated: false,
    handleCount: 0,
    themeEditorSuffix: "",
    translationsCopied: 0,
    translationsNeedManual: 0,
    warnings,
  };
}

function parseEntries(value: unknown): VariantEntries | null {
  const v = value as Partial<VariantEntries> | null;
  return v && typeof v.shell === "string" && typeof v.content === "string" ? { shell: v.shell, content: v.content } : null;
}

/** Preflight tanpa menjalankan apa pun — dipakai wizard dashboard lewat bridge. */
export async function componentReadiness(admin: AdminApiContext, componentKey: string) {
  const component = componentOf(componentKey);
  if (!component) return { ok: false, problems: [{ file: "", reason: "missing_file" as const }], theme: null };
  const theme = await getMainTheme(admin);
  const result = await checkComponentReadiness(admin, theme.id, component);
  return { ...result, theme: { id: theme.id, name: theme.name } };
}

export async function setStatus(
  admin: AdminApiContext,
  shop: string,
  experimentId: string,
  status: "paused" | "completed" | "draft",
) {
  await db.experiment.update({
    where: { id: experimentId },
    data: { status, endedAt: status === "completed" ? new Date() : null },
  });
  await republishConfig(admin, shop);

  // Status draft (reset) tidak punya padanan di PostHog; start berikutnya yang
  // akan me-reset dan me-launch ulang di sana.
  if (status === "paused") await mirrorTransition(experimentId, "pause");
  if (status === "completed") await mirrorTransition(experimentId, "complete");
}

/**
 * Deteksi kalau template variant B diubah lewat theme editor saat test berjalan.
 * Perubahan di tengah jalan membuat data sebelum dan sesudahnya tidak sebanding.
 */
export async function detectTemplateDrift(
  admin: AdminApiContext,
  experimentId: string,
): Promise<boolean> {
  const experiment = await db.experiment.findUniqueOrThrow({ where: { id: experimentId } });
  if (!experiment.variantBChecksum || experiment.status !== "running") return false;
  const theme = await getMainTheme(admin);
  const content = await readThemeFile(
    admin,
    theme.id,
    productTemplateFilename(experiment.variantBSuffix),
  );
  if (!content) return false;
  return checksumOf(content) !== experiment.variantBChecksum;
}
