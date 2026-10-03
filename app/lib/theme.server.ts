import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { evaluateComponentReadiness, readinessFiles, type ComponentDefinition } from "./components";
import { createHash } from "node:crypto";
import { copyTemplateTranslations, type TranslationCopyResult } from "./translations.server";

/**
 * Helper theme: baca template produk yang aktif, bikin alternate template untuk
 * variant B, dan hitung checksum supaya perubahan diam-diam lewat theme editor
 * bisa terdeteksi saat eksperimen sedang jalan.
 */

const MAIN_THEME = `#graphql
  query MainTheme {
    themes(first: 1, roles: [MAIN]) {
      nodes { id name role }
    }
  }
`;

const THEME_FILES = `#graphql
  query ThemeFiles($themeId: ID!, $filenames: [String!]!) {
    theme(id: $themeId) {
      files(filenames: $filenames, first: 5) {
        nodes {
          filename
          body { ... on OnlineStoreThemeFileBodyText { content } }
        }
      }
    }
  }
`;

const THEME_FILES_UPSERT = `#graphql
  mutation ThemeFilesUpsert($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
    themeFilesUpsert(themeId: $themeId, files: $files) {
      upsertedThemeFiles { filename }
      userErrors { field message }
    }
  }
`;

export async function getMainTheme(admin: AdminApiContext) {
  const res = await admin.graphql(MAIN_THEME);
  const json = await res.json();
  const theme = json?.data?.themes?.nodes?.[0];
  if (!theme) throw new Error("Live theme tidak ditemukan.");
  return theme as { id: string; name: string; role: string };
}

/**
 * Preflight eksperimen komponen, dijalankan terhadap theme LIVE: setiap berkas
 * yang merender komponen harus membaca atribut saklarnya, dan setiap berkas
 * yang dirender varian B harus ada. Tanpa ini, satu jalur render yang lupa
 * diberi saklar diam-diam menampilkan varian A kepada grup B.
 */
export async function checkComponentReadiness(
  admin: AdminApiContext,
  themeId: string,
  component: ComponentDefinition,
) {
  const files: Record<string, string | null> = {};
  for (const name of readinessFiles(component)) files[name] = await readThemeFile(admin, themeId, name);
  return evaluateComponentReadiness(component, files);
}

export function productTemplateFilename(suffix: string | null): string {
  return suffix ? `templates/product.${suffix}.json` : "templates/product.json";
}

export async function readThemeFile(
  admin: AdminApiContext,
  themeId: string,
  filename: string,
): Promise<string | null> {
  const res = await admin.graphql(THEME_FILES, {
    variables: { themeId, filenames: [filename] },
  });
  const json = await res.json();
  const node = json?.data?.theme?.files?.nodes?.[0];
  return node?.body?.content ?? null;
}

export interface EnsureVariantResult {
  created: boolean;
  checksum: string;
  translations: TranslationCopyResult | null;
  warnings: string[];
}

/**
 * Bikin templates/product.<suffix>.json dengan menyalin template produk default.
 * Kalau file-nya sudah ada, tidak ditimpa — supaya desain B yang sudah dikerjakan
 * di theme editor tidak hilang.
 *
 * Terjemahan selalu diperiksa ulang, juga saat file-nya sudah ada: penyalinannya
 * idempoten, dan template yang dibuat sebelum fitur ini ada masih kosong
 * terjemahannya tanpa memberi tanda apa pun.
 */
export async function ensureVariantTemplate(
  admin: AdminApiContext,
  themeId: string,
  suffix: string,
): Promise<EnsureVariantResult> {
  const target = productTemplateFilename(suffix);
  const existing = await readThemeFile(admin, themeId, target);
  let created = false;
  let checksum: string;

  if (existing) {
    checksum = checksumOf(existing);
  } else {
    const base = await readThemeFile(admin, themeId, "templates/product.json");
    if (!base) {
      throw new Error(
        "templates/product.json tidak ditemukan. Theme ini mungkin bukan Online Store 2.0 dan tidak mendukung alternate template JSON.",
      );
    }

    const res = await admin.graphql(THEME_FILES_UPSERT, {
      variables: {
        themeId,
        files: [{ filename: target, body: { type: "TEXT", value: base } }],
      },
    });
    const json = await res.json();
    const errors: Array<{ message: string }> = json?.data?.themeFilesUpsert?.userErrors ?? [];
    if (errors.length > 0) {
      throw new Error(`Gagal membuat ${target}: ${errors.map((e) => e.message).join("; ")}`);
    }
    created = true;
    checksum = checksumOf(base);
  }

  // Isi template-nya tersalin, terjemahannya tidak — resource terjemahan
  // diidentifikasi lewat nama file, jadi template baru selalu lahir kosong dan
  // jatuh ke bahasa Inggris tanpa satu pun error muncul.
  const warnings: string[] = [];
  let translations: TranslationCopyResult | null = null;
  try {
    translations = await copyTemplateTranslations(admin, {
      liveThemeId: themeId,
      sourceThemeId: themeId,
      templateFilename: "templates/product.json",
      targetTemplateFilename: target,
    });
    if (translations.needsManual.length > 0) {
      warnings.push(
        `${translations.needsManual.length} teks variant B belum punya terjemahan dan akan tampil dalam bahasa Inggris.`,
      );
    }
    warnings.push(...translations.warnings);
  } catch (error) {
    warnings.push(
      `TERJEMAHAN TIDAK TERSALIN: ${error instanceof Error ? error.message : String(error)}. ` +
        `Variant B akan tampil dalam bahasa Inggris untuk pengunjung non-primary.`,
    );
  }

  return { created, checksum, translations, warnings };
}

export function checksumOf(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 32);
}

/** Deep link ke theme editor untuk menggarap desain variant B. */
export function themeEditorUrl(shop: string, themeId: string, suffix: string): string {
  const numericId = themeId.split("/").pop();
  return `https://${shop}/admin/themes/${numericId}/editor?template=product&view=${encodeURIComponent(suffix)}`;
}
