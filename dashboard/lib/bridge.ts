import { createHmac } from "node:crypto";
import { getShopDomain } from "./shop";
import type { PostHogStatus } from "./posthog-results";
import type { HeatmapReplay, PostHogAnalytics, PostHogHeatmap } from "./posthog-analytics-types";
import type { HealthReport } from "./health-types";
import type { VariantPlan } from "./component-variant";

/**
 * Klien untuk endpoint internal di app Shopify (Fly.io).
 *
 * Access token Shopify sengaja hanya ada di satu tempat — app Fly.io. Dashboard
 * ini tidak memilikinya dan tidak boleh memilikinya, karena menyebar kredensial
 * ke dua platform berarti menggandakan permukaan yang harus dijaga dan dirotasi.
 */

export type BridgeAction =
  | "start"
  | "pause"
  | "complete"
  | "killswitch"
  | "republish"
  | "status"
  | "themes.list"
  | "theme.pages"
  | "theme.diff"
  | "theme.prepareVariant"
  | "theme.translationPlan"
  | "theme.cleanupTranslations"
  | "component.readiness"
  | "component.analyzeVariant"
  | "component.prepareVariant"
  | "posthog.status"
  | "posthog.sync"
  | "posthog.recalculate"
  | "posthog.analytics"
  | "posthog.heatmap"
  | "posthog.pages"
  | "posthog.heatmapReplays"
  | "health.run"
  | "health.latest"
  | "pixel.ensure";

export interface ThemeSummary {
  id: string;
  numericId: string;
  name: string;
  role: string;
  updatedAt: string | null;
}

export interface PageTypeInfo {
  type: string;
  suffix: string | null;
  filename: string;
  isJson: boolean;
}

export type ChangeClass = "safe" | "isolatable" | "blocking";

export interface ChangedFile {
  filename: string;
  status: "changed" | "added" | "removed";
  changeClass: ChangeClass;
  reason: string;
}

/** Satu string variant B yang tidak bisa diterjemahkan otomatis. */
export interface ManualTranslation {
  locale: string;
  path: string;
  /** teks variant B pada locale primary */
  sourceText: string;
  /** teks variant A pada locale primary */
  controlText: string | null;
  /** terjemahan yang dipakai variant A sekarang */
  controlTranslation: string | null;
}

export interface LocalePlan {
  locale: string;
  name: string;
  willCopy: number;
  needsManual: ManualTranslation[];
}

export interface TranslationPlan {
  locales: LocalePlan[];
  willCopy: number;
  needsManual: ManualTranslation[];
  error?: string;
}

export interface TranslationCopyResult {
  copied: number;
  skipped: number;
  needsManual: ManualTranslation[];
  locales: string[];
  warnings: string[];
}

/** Hasil preflight eksperimen komponen terhadap theme live (lib/components.ts). */
export interface ComponentReadiness {
  ok: boolean;
  problems: Array<{ file: string; reason: "missing_file" | "missing_switch" | "bypass" }>;
  theme: { id: string; name: string } | null;
}

/** Varian B komponen dari draft theme (app/lib/component-variant.server.ts). */
export interface ComponentVariantAnalysis {
  plan: VariantPlan;
  sourceThemeId: string;
  /** berkas yang berbeda, memengaruhi halaman, dan TIDAK ikut dibawa */
  notCarried: string[];
}

export interface ComponentVariantPrepared {
  plan: VariantPlan;
  written: string[];
  localesChanged: Record<string, number>;
  notCarried: string[];
}

export interface BridgeResult {
  ok?: boolean;
  error?: string;
  readiness?: ComponentReadiness;
  result?: {
    templateCreated: boolean;
    handleCount: number;
    themeEditorSuffix: string;
    translationsCopied: number;
    translationsNeedManual: number;
    warnings: string[];
  };
  theme?: { id: string; name: string };
  editorUrl?: string | null;
  templateDrift?: boolean;
  themes?: ThemeSummary[];
  pages?: PageTypeInfo[];
  diff?: { files: ChangedFile[]; counts: Record<ChangeClass, number> };
  prepare?: {
    templateFilename: string;
    isolatedFiles: Array<{ from: string; to: string }>;
    warnings: string[];
    translations: TranslationCopyResult | null;
  };
  blockingFiles?: ChangedFile[];
  analysis?: ComponentVariantAnalysis;
  variant?: ComponentVariantPrepared;
  blocking?: VariantPlan["blocking"];
  translationPlan?: TranslationPlan;
  cleanup?: { removed: number; locales: string[]; warnings: string[] };
  /** acuan PostHog: status cermin eksperimen + hasil terakhir */
  posthog?: PostHogStatus;
  /** jumlah event outbox yang berhasil dikirim pada aksi ini */
  sent?: number;
  /** analitik perilaku per variant dari PostHog */
  analytics?: PostHogAnalytics;
  heatmap?: PostHogHeatmap;
  replays?: HeatmapReplay[];
  /** halaman produk yang tercatat di PostHog, urut dari yang paling ramai */
  productPages?: Array<{ path: string; visitors: number }>;
  /** laporan kesehatan pipeline (invariant I1..I14 + coverage per sumber) */
  health?: HealthReport | null;
  /**
   * Status web pixel. Men-deploy extension saja tidak mengaktifkannya — tanpa
   * record yang dibuat lewat Admin API, pixel terdaftar tapi tidak pernah jalan.
   */
  webPixel?: { active: boolean; id: string | null; settingsOk: boolean };
  pixel?: { active: boolean; id: string | null; action: string; settings: string | null; error: string | null };
}

export interface BridgeOptions {
  experimentId?: string;
  actorEmail: string;
  sourceThemeId?: string;
  templateFilename?: string;
  suffix?: string;
  /** parameter tambahan aksi (heatmap: path, type, viewport) */
  params?: Record<string, string>;
}

export async function callBridge(
  action: BridgeAction,
  options: BridgeOptions,
): Promise<BridgeResult> {
  const baseUrl = process.env.SHOPIFY_APP_URL;
  const secret = process.env.INTERNAL_API_SECRET;

  if (!baseUrl || !secret) {
    return { error: "Bridge belum dikonfigurasi. Butuh SHOPIFY_APP_URL dan INTERNAL_API_SECRET." };
  }

  // Domain diambil dari Session OAuth, bukan env: harus sama persis dengan yang
  // menempel pada access token, kalau tidak Fly tidak akan menemukan sesinya.
  let shop: string;
  try {
    shop = await getShopDomain();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  const body = JSON.stringify({
    shop,
    action,
    experimentId: options.experimentId,
    actorEmail: options.actorEmail,
    sourceThemeId: options.sourceThemeId,
    templateFilename: options.templateFilename,
    suffix: options.suffix,
    params: options.params,
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/internal/action`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-TL-Timestamp": timestamp,
        "X-TL-Signature": signature,
      },
      body,
      // Membuat template theme dan menerbitkan metafield bisa memakan waktu.
      signal: AbortSignal.timeout(60_000),
    });

    const text = await response.text();
    try {
      return JSON.parse(text) as BridgeResult;
    } catch {
      return { error: `Respons bridge tidak bisa dibaca (HTTP ${response.status}): ${text.slice(0, 200)}` };
    }
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      return { error: "Bridge tidak merespons dalam 60 detik. Cek apakah app Fly.io hidup." };
    }
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
