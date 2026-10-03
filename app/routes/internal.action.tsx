import type { ActionFunctionArgs } from "react-router";
import { unauthenticated } from "../shopify.server";
import db from "../db.server";
import { InternalAuthError, verifyInternalRequest } from "../lib/internal-auth.server";
import {
  componentReadiness,
  detectTemplateDrift,
  republishConfig,
  setStatus,
  startExperiment,
} from "../lib/experiment.server";
import { getMainTheme, themeEditorUrl } from "../lib/theme.server";
import {
  analyzeComponentVariant,
  prepareComponentVariant,
  VariantBlockedError,
} from "../lib/component-variant.server";
import {
  BlockingChangeError,
  diffThemes,
  listPageTypes,
  listThemes,
  prepareVariantFromTheme,
} from "../lib/theme-analysis.server";
import {
  planTemplateTranslations,
  removeTemplateTranslations,
} from "../lib/translations.server";
import { mirrorTransition, requestRecalculation, statusFor } from "../lib/posthog/experiments.server";
import { analyticsFor, heatmapFor, heatmapReplaysFor, pagesFor } from "../lib/posthog/analytics.server";
import { HEATMAP_TYPES, type HeatmapType, type HeatmapViewport } from "../lib/posthog/analytics-types";
import { drainOutbox } from "../lib/posthog/client.server";
import { ensureWebPixel, readWebPixel } from "../lib/pixel.server";
import { latestHealth, runHealthChecks } from "../lib/health.server";

/**
 * Jembatan dari dashboard Vercel ke Shopify Admin API.
 *
 * Dashboard membaca dan menulis Neon secara langsung untuk semua hal yang tidak
 * menyentuh Shopify. Yang lewat sini hanya aksi yang butuh access token Shopify,
 * yang sengaja disimpan di satu tempat saja: aplikasi ini.
 */

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

interface Payload {
  shop: string;
  action:
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
    | "pixel.ensure"
    | "health.run"
    | "health.latest";
  experimentId?: string;
  /** parameter tambahan aksi, mis. heatmap: { path, type, viewport } */
  params?: Record<string, string>;
  actorEmail?: string;
  /** theme yang jadi sumber variant B */
  sourceThemeId?: string;
  /** mis. "templates/product.json" */
  templateFilename?: string;
  /** mis. "ab-b" */
  suffix?: string;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return json({ error: "Method tidak diizinkan." }, 405);

  const rawBody = await request.text();
  try {
    verifyInternalRequest(request, rawBody);
  } catch (error) {
    if (error instanceof InternalAuthError) return json({ error: error.message }, 401);
    throw error;
  }

  let payload: Payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "Body bukan JSON yang sah." }, 400);
  }

  const { shop, action: name, experimentId, actorEmail, sourceThemeId, templateFilename, suffix, params } =
    payload;
  if (!shop) return json({ error: "shop wajib diisi." }, 400);

  try {
    const { admin } = await unauthenticated.admin(shop);

    switch (name) {
      case "start": {
        if (!experimentId) return json({ error: "experimentId wajib diisi." }, 400);
        const result = await startExperiment(admin, shop, experimentId);
        await log(actorEmail, "experiment.start", experimentId, JSON.stringify(result));
        return json({ ok: true, result });
      }

      case "pause":
      case "complete": {
        if (!experimentId) return json({ error: "experimentId wajib diisi." }, 400);
        await setStatus(admin, shop, experimentId, name === "pause" ? "paused" : "completed");
        await log(actorEmail, `experiment.${name}`, experimentId);
        return json({ ok: true });
      }

      case "killswitch": {
        await republishConfig(admin, shop, false);
        await log(actorEmail, "killswitch", experimentId, "semua visitor dikembalikan ke variant A");
        return json({ ok: true });
      }

      case "republish": {
        await republishConfig(admin, shop, true);
        await log(actorEmail, "republish", experimentId);
        return json({ ok: true });
      }

      case "status": {
        const theme = await getMainTheme(admin);
        return json({
          ok: true,
          theme: { id: theme.id, name: theme.name },
          editorUrl: experimentId
            ? themeEditorUrl(
                shop,
                theme.id,
                (await db.experiment.findUniqueOrThrow({ where: { id: experimentId } })).variantBSuffix,
              )
            : null,
          templateDrift: experimentId ? await detectTemplateDrift(admin, experimentId) : false,
          // Hanya dibaca, tidak diubah: halaman ini dibuka berkali-kali.
          webPixel: await readWebPixel(admin),
        });
      }

      /* Preflight eksperimen komponen terhadap theme LIVE, tanpa menjalankan
         apa pun — wizard menampilkannya sebelum eksperimen boleh dibuat. */
      case "component.readiness": {
        const key = params?.component ?? "";
        return json({ ok: true, readiness: await componentReadiness(admin, key) });
      }

      /* Varian B komponen dari draft theme (SPEC-component-experiments §10).
         analyze = baca saja; prepare = tulis salinan yang belum dirender siapa pun. */
      case "component.analyzeVariant":
      case "component.prepareVariant": {
        const component = params?.component ?? "";
        const token = params?.token ?? "";
        if (!sourceThemeId || !component || !/^[a-z0-9]{4,12}$/.test(token)) {
          return json({ error: "sourceThemeId, component, dan token (4–12 huruf/angka kecil) wajib diisi." }, 400);
        }
        const live = await getMainTheme(admin);
        if (live.id === sourceThemeId || live.id.endsWith(`/${sourceThemeId}`)) {
          return json({ error: "Pilih draft theme, bukan theme live." }, 400);
        }
        const opts = { liveThemeId: live.id, sourceThemeId, component, token };
        if (name === "component.analyzeVariant") {
          return json({ ok: true, analysis: await analyzeComponentVariant(admin, opts) });
        }
        try {
          const prepared = await prepareComponentVariant(admin, opts);
          await log(actorEmail, "component.prepareVariant", experimentId, JSON.stringify({
            sourceThemeId,
            token,
            entries: prepared.plan.entries,
            written: prepared.written,
            localesChanged: prepared.localesChanged,
          }));
          return json({ ok: true, variant: prepared });
        } catch (error) {
          if (error instanceof VariantBlockedError) {
            return json({ error: error.message, blocking: error.plan.blocking }, 409);
          }
          throw error;
        }
      }

      case "themes.list": {
        return json({ ok: true, themes: await listThemes(admin) });
      }

      case "theme.pages": {
        const theme = sourceThemeId ?? (await getMainTheme(admin)).id;
        return json({ ok: true, pages: await listPageTypes(admin, theme) });
      }

      case "theme.diff": {
        if (!sourceThemeId) return json({ error: "sourceThemeId wajib diisi." }, 400);
        const live = await getMainTheme(admin);
        return json({ ok: true, diff: await diffThemes(admin, live.id, sourceThemeId) });
      }

      case "theme.translationPlan": {
        if (!sourceThemeId || !templateFilename) {
          return json({ error: "sourceThemeId dan templateFilename wajib diisi." }, 400);
        }
        const live = await getMainTheme(admin);
        return json({
          ok: true,
          translationPlan: await planTemplateTranslations(admin, {
            liveThemeId: live.id,
            sourceThemeId,
            templateFilename,
          }),
        });
      }

      case "theme.cleanupTranslations": {
        if (!templateFilename || !suffix) {
          return json({ error: "templateFilename dan suffix wajib diisi." }, 400);
        }
        const live = await getMainTheme(admin);
        const target = templateFilename.replace(/\.(json|liquid)$/, (ext) => `.${suffix}${ext}`);
        const removed = await removeTemplateTranslations(admin, {
          liveThemeId: live.id,
          targetTemplateFilename: target,
        });
        await log(actorEmail, "theme.cleanupTranslations", experimentId, JSON.stringify(removed));
        return json({ ok: true, cleanup: removed });
      }

      /* ---------------- PostHog (acuan analisis) ---------------- */

      case "posthog.status": {
        if (!experimentId) return json({ error: "experimentId wajib diisi." }, 400);
        const experiment = await db.experiment.findUniqueOrThrow({ where: { id: experimentId } });
        return json({ ok: true, posthog: await statusFor(experiment) });
      }

      case "posthog.sync": {
        // Buat/tautkan ulang cermin PostHog dan sesuaikan lifecycle-nya dengan
        // status lokal saat ini, lalu kirim sisa outbox.
        if (!experimentId) return json({ error: "experimentId wajib diisi." }, 400);
        const experiment = await db.experiment.findUniqueOrThrow({ where: { id: experimentId } });
        const transition =
          experiment.status === "running" ? "start" : experiment.status === "paused" ? "pause" : experiment.status === "completed" ? "complete" : "start";
        const syncError = await mirrorTransition(experimentId, transition);
        const sent = await drainOutbox();
        await log(actorEmail, "posthog.sync", experimentId, JSON.stringify({ transition, syncError, sent }));
        if (syncError) return json({ error: `Sinkronisasi PostHog gagal: ${syncError}` }, 502);
        const fresh = await db.experiment.findUniqueOrThrow({ where: { id: experimentId } });
        return json({ ok: true, posthog: await statusFor(fresh), sent });
      }

      case "posthog.analytics": {
        if (!experimentId) return json({ error: "experimentId wajib diisi." }, 400);
        const experiment = await db.experiment.findUniqueOrThrow({ where: { id: experimentId } });
        return json({ ok: true, analytics: await analyticsFor(experiment) });
      }

      case "health.run":
      case "health.latest": {
        if (!experimentId) return json({ error: "experimentId wajib diisi." }, 400);
        const experiment = await db.experiment.findUniqueOrThrow({ where: { id: experimentId } });
        const health = name === "health.run" ? await runHealthChecks(experiment, admin) : await latestHealth(experiment);
        return json({ ok: true, health });
      }

      case "posthog.pages": {
        if (!experimentId) return json({ error: "experimentId wajib diisi." }, 400);
        const experiment = await db.experiment.findUniqueOrThrow({ where: { id: experimentId } });
        return json({ ok: true, productPages: await pagesFor(experiment) });
      }

      case "posthog.heatmap": {
        if (!experimentId) return json({ error: "experimentId wajib diisi." }, 400);
        const path = params?.path ?? "";
        if (!/^\/[A-Za-z0-9/_\-.%]*$/.test(path)) return json({ error: "path heatmap tidak valid." }, 400);
        const type = (HEATMAP_TYPES as readonly string[]).includes(params?.type ?? "") ? (params!.type as HeatmapType) : "click";
        const viewport = ["mobile", "tablet", "desktop"].includes(params?.viewport ?? "") ? (params!.viewport as "mobile") : "mobile";
        const experiment = await db.experiment.findUniqueOrThrow({ where: { id: experimentId } });
        const rawWidth = params?.width ?? "auto";
        const width = rawWidth === "all" ? "all" : /^\d+$/.test(rawWidth) ? Number(rawWidth) : "auto";
        return json({ ok: true, heatmap: await heatmapFor(experiment, { path, type, viewport, width }) });
      }

      case "posthog.heatmapReplays": {
        if (!experimentId) return json({ error: "experimentId wajib diisi." }, 400);
        const path = params?.path ?? "";
        if (!/^\/[A-Za-z0-9/_\-.%]*$/.test(path)) return json({ error: "path heatmap tidak valid." }, 400);
        const type = (HEATMAP_TYPES as readonly string[]).includes(params?.type ?? "") ? (params!.type as HeatmapType) : "click";
        const viewport = ["mobile", "tablet", "desktop"].includes(params?.viewport ?? "") ? (params!.viewport as HeatmapViewport) : "mobile";
        const variant = params?.variant === "B" ? "B" : "A";
        const experiment = await db.experiment.findUniqueOrThrow({ where: { id: experimentId } });
        return json({
          ok: true,
          replays: await heatmapReplaysFor(experiment, { path, type, viewport, variant, relX: Number(params?.relX ?? 0), y: Number(params?.y ?? 0) }),
        });
      }

      case "posthog.recalculate": {
        if (!experimentId) return json({ error: "experimentId wajib diisi." }, 400);
        const experiment = await db.experiment.findUniqueOrThrow({ where: { id: experimentId } });
        const sent = await drainOutbox();
        const recalcError = await requestRecalculation(experiment);
        await log(actorEmail, "posthog.recalculate", experimentId, JSON.stringify({ recalcError, sent }));
        if (recalcError) return json({ error: `PostHog menolak hitung ulang: ${recalcError}` }, 502);
        return json({ ok: true, sent });
      }

      case "pixel.ensure": {
        // Idempoten: membuat pixel kalau belum ada, membetulkan settings kalau
        // berubah, dan tidak melakukan apa-apa kalau sudah benar.
        const pixel = await ensureWebPixel(admin);
        await log(actorEmail, "pixel.ensure", experimentId, JSON.stringify(pixel));
        return json({ ok: true, pixel });
      }

      case "theme.prepareVariant": {
        if (!sourceThemeId || !templateFilename || !suffix) {
          return json({ error: "sourceThemeId, templateFilename, dan suffix wajib diisi." }, 400);
        }
        const live = await getMainTheme(admin);
        try {
          const result = await prepareVariantFromTheme(admin, {
            liveThemeId: live.id,
            sourceThemeId,
            templateFilename,
            suffix,
          });
          await log(actorEmail, "theme.prepareVariant", experimentId, JSON.stringify(result));
          return json({ ok: true, prepare: result });
        } catch (error) {
          // Perubahan yang tidak bisa diisolasi bukan kegagalan sistem, melainkan
          // jawaban yang perlu ditampilkan lengkap ke user agar bisa diperbaiki.
          if (error instanceof BlockingChangeError) {
            return json({ error: error.message, blockingFiles: error.files }, 409);
          }
          throw error;
        }
      }

      default:
        return json({ error: `Aksi tidak dikenal: ${name}` }, 400);
    }
  } catch (error) {
    // Pesan error diteruskan apa adanya supaya dashboard bisa menampilkan
    // penyebab sebenarnya (mis. scope belum di-approve), bukan "terjadi kesalahan".
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
};

async function log(actorEmail: string | undefined, action: string, experimentId?: string, detail?: string) {
  await db.auditLog.create({
    data: {
      actorEmail: actorEmail || "unknown",
      action,
      experimentId: experimentId ?? null,
      detail: detail ?? null,
    },
  });
}
