"use server";

import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import {
  callBridge,
  type ChangedFile,
  type ComponentReadiness,
  type ComponentVariantAnalysis,
  type ManualTranslation,
  type PageTypeInfo,
  type ThemeSummary,
  type TranslationCopyResult,
  type TranslationPlan,
} from "@/lib/bridge";
import { fetchStorefrontPage } from "@/lib/storefront";
import { sampleProducts, type SampleProduct } from "@/lib/drawer-snapshot";
import { detectTrackers, extractShopifyWebPixels, type DetectedTracker } from "@/lib/trackers";
import { sampleSizePerArm } from "@/lib/stats";
import { getShopDomain } from "@/lib/shop";
import { getPostHogClient } from "@/lib/posthog-server";
import { tr } from "@/lib/i18n";
import { getLang } from "@/lib/i18n.server";
import { componentOf } from "@/lib/components";

export interface ThemesResult {
  error?: string;
  themes?: ThemeSummary[];
}

export async function loadThemes(): Promise<ThemesResult> {
  const user = await requireAdmin();
  const res = await callBridge("themes.list", { actorEmail: user.email });
  return res.error ? { error: res.error } : { themes: res.themes };
}

export interface PagesResult {
  error?: string;
  pages?: PageTypeInfo[];
  /** contoh URL nyata untuk tiap tipe halaman, supaya snapshot punya sesuatu untuk dirender */
  examples?: Record<string, string>;
}

export async function loadPages(themeId?: string): Promise<PagesResult> {
  const user = await requireAdmin();
  const res = await callBridge("theme.pages", {
    actorEmail: user.email,
    sourceThemeId: themeId,
  });
  if (res.error) return { error: res.error };
  return { pages: res.pages, examples: await exampleUrls() };
}

/**
 * URL contoh per tipe halaman.
 *
 * Diambil dari sitemap publik, bukan Admin API — supaya tidak menambah
 * ketergantungan pada scope `read_products` yang mungkin belum di-approve, dan
 * supaya yang tampil memang halaman yang benar-benar bisa diakses pengunjung.
 */
async function exampleUrls(): Promise<Record<string, string>> {
  const examples: Record<string, string> = { index: "/" };

  // Isi <loc> adalah XML, jadi "&" ditulis sebagai "&amp;". Tanpa di-decode,
  // query string sitemap Shopify (?from=...&to=...) jadi rusak dan sub-sitemap
  // membalas kosong.
  const locsIn = (xml: string): string[] =>
    [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) =>
      m[1].replaceAll("&amp;", "&").replaceAll("&#38;", "&"),
    );

  // Query string-nya bermakna — sitemap produk Shopify memakai ?from=&to= untuk
  // memilih rentang, jadi pathname saja tidak cukup.
  const relative = (absolute: string): string => {
    const u = new URL(absolute);
    return u.pathname + u.search;
  };

  try {
    const root = await fetchStorefrontPage("/sitemap.xml");
    // Sitemap berbahasa lain (/id/...) memuat produk yang sama; cukup yang utama.
    const subs = locsIn(root.html).filter((l) => !new URL(l).pathname.startsWith("/id/"));

    for (const sub of subs) {
      const path = relative(sub);
      if (!/sitemap_(products|pages|collections|blogs)/.test(path)) continue;

      const page = await fetchStorefrontPage(path);
      for (const entry of locsIn(page.html)) {
        const p = new URL(entry).pathname;
        if (p.startsWith("/products/") && !examples.product) examples.product = p;
        else if (p.startsWith("/collections/") && !examples.collection) examples.collection = p;
        else if (p.startsWith("/pages/") && !examples.page) examples.page = p;
        else if (p.startsWith("/blogs/")) {
          const depth = p.split("/").filter(Boolean).length;
          if (depth > 2 && !examples.article) examples.article = p;
          else if (depth === 2 && !examples.blog) examples.blog = p;
        }
      }
    }
  } catch {
    // Sitemap tidak wajib ada. Kalau gagal, user tetap bisa mengetik path manual.
  }

  return examples;
}

export interface AnalysisResult {
  error?: string;
  a?: PageAnalysis;
  b?: PageAnalysis;
  diff?: { files: ChangedFile[]; counts: Record<string, number> };
  /** keadaan terjemahan variant B — file theme-nya aman, terjemahannya belum tentu */
  translations?: TranslationPlan;
}

export interface PageAnalysis {
  path: string;
  status: number;
  themeName: string | null;
  themeRole: string | null;
  trackers: DetectedTracker[];
  shopifyPixels: Array<{ name: string; type: string }>;
  sizeKb: number;
}

/** Ambil dan analisis kedua sisi sekaligus: halaman live (A) dan halaman preview (B). */
export async function analyzePage(
  path: string,
  previewThemeId?: string,
  templateFilename?: string,
): Promise<AnalysisResult> {
  const user = await requireAdmin();

  const [live, preview] = await Promise.all([
    fetchStorefrontPage(path),
    previewThemeId ? fetchStorefrontPage(path, previewThemeId) : Promise.resolve(null),
  ]);

  const analyze = (p: NonNullable<typeof live>): PageAnalysis => ({
    path,
    status: p.status,
    themeName: p.themeName,
    themeRole: p.themeRole,
    trackers: detectTrackers(p.html),
    shopifyPixels: extractShopifyWebPixels(p.html),
    sizeKb: Math.round(p.html.length / 1024),
  });

  const result: AnalysisResult = { a: analyze(live) };
  if (preview) result.b = analyze(preview);

  if (previewThemeId) {
    const [diff, translations] = await Promise.all([
      callBridge("theme.diff", {
        actorEmail: user.email,
        sourceThemeId: previewThemeId,
      }),
      // Perbedaan file dan perbedaan terjemahan adalah dua pemeriksaan berbeda.
      // Sebuah theme bisa lulus "0 blokir" dan tetap membuat variant B tampil
      // berbahasa Inggris, karena terjemahan template bukan file theme.
      callBridge("theme.translationPlan", {
        actorEmail: user.email,
        sourceThemeId: previewThemeId,
        templateFilename,
      }),
    ]);
    if (diff.diff) result.diff = diff.diff;
    else if (diff.error) result.error = diff.error;

    if (translations.translationPlan) result.translations = translations.translationPlan;
    else if (translations.error) {
      result.translations = {
        locales: [],
        willCopy: 0,
        needsManual: [],
        error: translations.error,
      };
    }
  }

  const posthog = getPostHogClient();
  if (posthog) {
    posthog.capture({
      distinctId: user.id,
      event: "theme_analysis_completed",
      properties: {
        has_preview_theme: Boolean(previewThemeId),
        live_status: result.a?.status,
        preview_status: result.b?.status,
        blocking_file_count: result.diff?.counts.blocking ?? 0,
        manual_translation_count: result.translations?.needsManual.length ?? 0,
        has_error: Boolean(result.error),
      },
    });
    await posthog.flush();
  }

  return result;
}

export interface CreateFromWizardInput {
  name: string;
  hypothesis: string;
  pageType: string;
  templateFilename: string;
  examplePath: string;
  sourceThemeId: string | null;
  suffix: string;
  /** merchant sadar variant B akan tampil berbahasa Inggris dan tetap mau lanjut */
  acceptEnglishFallback: boolean;
  splitPctB: number;
  primaryMetric: string;
  mdeRelative: number;
  baselineCvr: number;
  targetType: string;
  targetHandles: string;
}

export interface CreateResult {
  error?: string;
  blockingFiles?: ChangedFile[];
  /** teks variant B yang belum diterjemahkan — pembuatan ditolak selama ini terisi */
  manualTranslations?: ManualTranslation[];
  experimentId?: string;
  isolatedFiles?: Array<{ from: string; to: string }>;
  warnings?: string[];
  translations?: TranslationCopyResult | null;
}

export async function createFromWizard(input: CreateFromWizardInput): Promise<CreateResult> {
  const user = await requireAdmin();
  const t = tr(await getLang());

  if (!input.name.trim()) return { error: t("Nama eksperimen wajib diisi.", "Experiment name is required.") };
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(input.suffix)) {
    return {
      error: t(
        "Template suffix hanya boleh huruf kecil, angka, dan tanda hubung.",
        "Template suffix may only contain lowercase letters, numbers and hyphens.",
      ),
    };
  }

  // Kalau variant B bersumber dari theme preview, isinya dipindahkan lebih dulu.
  let isolatedFiles: CreateResult["isolatedFiles"];
  let warnings: string[] | undefined;
  let translations: TranslationCopyResult | null = null;

  if (input.sourceThemeId) {
    // Diperiksa ulang di server, bukan hanya di tombol: teks variant B yang belum
    // diterjemahkan membuat test mengukur "Indonesia lawan Inggris", bukan
    // hipotesisnya — dan tidak ada satu pun error yang akan memberi tahu.
    if (!input.acceptEnglishFallback) {
      const plan = await callBridge("theme.translationPlan", {
        actorEmail: user.email,
        sourceThemeId: input.sourceThemeId,
        templateFilename: input.templateFilename,
      });
      const manual = plan.translationPlan?.needsManual ?? [];
      if (manual.length > 0) {
        return {
          error: t(
            `${manual.length} teks variant B belum punya terjemahan. Pengunjung berbahasa lain ` +
              `akan melihatnya dalam bahasa Inggris, sementara variant A tetap diterjemahkan — ` +
              `yang terukur jadi bahasanya, bukan desainnya.`,
            `${manual.length} variant B text${manual.length === 1 ? " has" : "s have"} no translation. Visitors in other ` +
              `languages will see ${manual.length === 1 ? "it" : "them"} in English while variant A stays translated — ` +
              `the test would measure language, not design.`,
          ),
          manualTranslations: manual,
        };
      }
    }

    const prepared = await callBridge("theme.prepareVariant", {
      actorEmail: user.email,
      sourceThemeId: input.sourceThemeId,
      templateFilename: input.templateFilename,
      suffix: input.suffix,
    });
    if (prepared.error) {
      return { error: prepared.error, blockingFiles: prepared.blockingFiles };
    }
    isolatedFiles = prepared.prepare?.isolatedFiles;
    warnings = prepared.prepare?.warnings;
    translations = prepared.prepare?.translations ?? null;
  }

  const shop = await getShopDomain();
  const experiment = await db.experiment.create({
    data: {
      shop,
      name: input.name.trim(),
      hypothesis: input.hypothesis.trim() || null,
      variantBSuffix: input.suffix,
      splitPctB: Math.min(95, Math.max(5, input.splitPctB)),
      primaryMetric: input.primaryMetric,
      mdeRelative: input.mdeRelative,
      minSampleArm: sampleSizePerArm(input.baselineCvr || 0.02, input.mdeRelative),
      targetType: input.targetType,
      targetHandles: input.targetHandles
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    },
  });

  await db.auditLog.create({
    data: {
      actorEmail: user.email,
      action: "experiment.create",
      experimentId: experiment.id,
      detail: `${input.pageType} · ${input.sourceThemeId ? "dari theme preview" : "template baru"}`,
    },
  });

  const posthog = getPostHogClient();
  if (posthog) {
    posthog.capture({
      distinctId: user.id,
      event: "experiment_created",
      properties: {
        experiment_id: experiment.id,
        page_type: input.pageType,
        target_type: input.targetType,
        primary_metric: input.primaryMetric,
        split_pct_b: experiment.splitPctB,
        creation_flow: "wizard",
        used_preview_theme: Boolean(input.sourceThemeId),
        warning_count: warnings?.length ?? 0,
      },
    });
    await posthog.flush();
  }

  return { experimentId: experiment.id, isolatedFiles, warnings, translations };
}

/* ------------------------------------------------------------------------
   Eksperimen KOMPONEN (claudedocs/SPEC-component-experiments.md)
   ------------------------------------------------------------------------ */

export interface ReadinessResult {
  error?: string;
  readiness?: ComponentReadiness;
}

/** Preflight theme live — sama persis dengan yang dijalankan server saat start. */
export async function checkComponentReadiness(component: string): Promise<ReadinessResult> {
  const user = await requireAdmin();
  const res = await callBridge("component.readiness", { actorEmail: user.email, params: { component } });
  return res.error ? { error: res.error } : { readiness: res.readiness };
}

export interface ComponentVariantResult {
  error?: string;
  analysis?: ComponentVariantAnalysis;
  /** dipakai lagi saat membuat eksperimen: nama salinan harus sama dengan yang dianalisis */
  token?: string;
}

/**
 * Analisis varian B dari draft theme — hanya membaca (SPEC-component-experiments §10).
 * Token dibuat di sini dan dibawa wizard sampai eksperimen dibuat.
 */
export async function analyzeComponentVariant(component: string, sourceThemeId: string, token?: string): Promise<ComponentVariantResult> {
  const user = await requireAdmin();
  const tok = token && /^[a-z0-9]{4,12}$/.test(token) ? token : randomBytes(3).toString("hex");
  const res = await callBridge("component.analyzeVariant", {
    actorEmail: user.email,
    sourceThemeId,
    params: { component, token: tok },
  });
  return res.error ? { error: res.error } : { analysis: res.analysis, token: tok };
}

export interface CreateComponentInput {
  name: string;
  hypothesis: string;
  component: string;
  splitPctB: number;
  primaryMetric: string;
  mdeRelative: number;
  baselineCvr: number;
  /** varian B dari draft theme — wajib; tidak ada B bawaan */
  source?: { themeId: string; themeName: string; token: string; acceptEnglishFallback: boolean };
}

export async function createComponentExperiment(input: CreateComponentInput): Promise<CreateResult> {
  const user = await requireAdmin();
  const t = tr(await getLang());

  if (!input.name.trim()) return { error: t("Nama eksperimen wajib diisi.", "Experiment name is required.") };
  const component = componentOf(input.component);
  if (!component) return { error: t("Komponen tidak dikenal.", "Unknown component.") };

  // Diperiksa ulang di server, bukan hanya di tombol: eksperimen yang dibuat di
  // atas tema tanpa saklar menampilkan varian A kepada grup B tanpa error apa pun.
  const check = await callBridge("component.readiness", { actorEmail: user.email, params: { component: component.key } });
  if (check.error) return { error: check.error };
  if (!check.readiness?.ok) {
    return {
      error: t(
        `Theme live belum siap untuk test ${component.label.id}: ${check.readiness?.problems.map((p) => p.file).join(", ")}.`,
        `The live theme is not ready for a ${component.label.en} test: ${check.readiness?.problems.map((p) => p.file).join(", ")}.`,
      ),
    };
  }

  /* Varian B dari draft theme: analisis ulang di server (bukan hanya di
     tombol), lalu salin ke live dengan nama baru. Salinan itu belum dirender
     siapa pun sampai eksperimen ini DIJALANKAN. */
  let entries: { shell: string; content: string } | null = null;
  let warnings: string[] | undefined;
  if (!input.source) {
    return { error: t("Pilih draft theme sebagai sumber varian B.", "Choose a draft theme as the source of variant B.") };
  }
  {
    const { themeId, token } = input.source;
    const check = await callBridge("component.analyzeVariant", {
      actorEmail: user.email,
      sourceThemeId: themeId,
      params: { component: component.key, token },
    });
    if (check.error || !check.analysis) return { error: check.error ?? t("Analisis gagal.", "Analysis failed.") };
    const plan = check.analysis.plan;
    if (plan.blocking.length) {
      return {
        error: t(
          `Varian B dari theme ini tidak bisa dipindahkan tanpa ikut mengubah varian A: ${plan.blocking.map((b) => b.file).join(", ")}.`,
          `Variant B from this theme cannot be carried over without changing variant A too: ${plan.blocking.map((b) => b.file).join(", ")}.`,
        ),
      };
    }
    if (plan.untranslated.length && !input.source.acceptEnglishFallback) {
      return {
        error: t(
          `${plan.untranslated.length} teks varian B belum diterjemahkan di draft theme — pengunjung bahasa lain akan melihatnya dalam bahasa utama, sementara A tetap diterjemahkan.`,
          `${plan.untranslated.length} variant B text${plan.untranslated.length === 1 ? " is" : "s are"} not translated in the draft theme — visitors in other languages would see the primary language while A stays translated.`,
        ),
      };
    }
    const prepared = await callBridge("component.prepareVariant", {
      actorEmail: user.email,
      sourceThemeId: themeId,
      params: { component: component.key, token },
    });
    if (prepared.error || !prepared.variant?.plan.entries) {
      return { error: prepared.error ?? t("Varian B gagal disiapkan.", "Variant B could not be prepared.") };
    }
    entries = prepared.variant.plan.entries;
    warnings = prepared.variant.plan.warnings;
  }

  const shop = await getShopDomain();
  const experiment = await db.experiment.create({
    data: {
      shop,
      name: input.name.trim(),
      hypothesis: input.hypothesis.trim() || null,
      variantBSourceThemeId: input.source?.themeId ?? null,
      variantBSourceThemeName: input.source?.themeName ?? null,
      ...(entries ? { variantBEntries: entries } : {}),
      kind: "component",
      component: component.key,
      variantBSuffix: "",
      splitPctB: Math.min(95, Math.max(5, input.splitPctB)),
      primaryMetric: input.primaryMetric,
      mdeRelative: input.mdeRelative,
      minSampleArm: sampleSizePerArm(input.baselineCvr || 0.02, input.mdeRelative),
      targetType: "all_products",
    },
  });

  await db.auditLog.create({
    data: {
      actorEmail: user.email,
      action: "experiment.create",
      experimentId: experiment.id,
      detail: `komponen · ${component.key}${input.source ? ` · B dari theme ${input.source.themeName} → ${entries?.shell} / ${entries?.content}` : " · B bawaan"}`,
    },
  });

  const posthog = getPostHogClient();
  if (posthog) {
    posthog.capture({
      distinctId: user.id,
      event: "experiment_created",
      properties: {
        experiment_id: experiment.id,
        page_type: "component",
        component: component.key,
        target_type: "component",
        primary_metric: input.primaryMetric,
        split_pct_b: experiment.splitPctB,
        creation_flow: "component_wizard",
        used_preview_theme: Boolean(input.source),
        warning_count: warnings?.length ?? 0,
      },
    });
    await posthog.flush();
  }

  return { experimentId: experiment.id, warnings };
}

/** Produk untuk keranjang contoh di preview drawer (aturan katalog: vendor ≠ TEST, harga > 0). */
export async function loadDrawerSampleProducts(): Promise<{ error?: string; products?: SampleProduct[] }> {
  await requireAdmin();
  try {
    return { products: await sampleProducts() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
