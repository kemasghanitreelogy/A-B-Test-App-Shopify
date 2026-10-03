"use server";

import { requireUser } from "@/lib/session";
import { callBridge } from "@/lib/bridge";
import { getLang } from "@/lib/i18n.server";
import { tr } from "@/lib/i18n";
import type { HeatmapReplay, HeatmapReplayParams, HeatmapType, HeatmapViewport, HeatmapWidth, PostHogHeatmap } from "@/lib/posthog-analytics-types";

export interface HeatmapResult {
  error?: string;
  heatmap?: PostHogHeatmap;
}

/**
 * Heatmap per variant untuk satu halaman produk. Dibaca lewat bridge karena
 * kunci PostHog hanya ada di app Fly.io.
 */
export async function loadHeatmap(
  experimentId: string,
  params: { path: string; type: HeatmapType; viewport: HeatmapViewport; width?: HeatmapWidth },
): Promise<HeatmapResult> {
  const user = await requireUser();
  if (!/^\/[A-Za-z0-9/_\-.%]*$/.test(params.path)) return { error: tr(await getLang())("Path halaman tidak valid.", "Invalid page path.") };
  const res = await callBridge("posthog.heatmap", {
    experimentId,
    actorEmail: user.email,
    params: { path: params.path, type: params.type, viewport: params.viewport, width: String(params.width ?? "auto") },
  });
  if (res.error) return { error: res.error };
  return { heatmap: res.heatmap };
}

/**
 * Halaman produk yang bisa dipilih untuk heatmap. Dipanggil dari panel heatmap
 * di halaman hasil, yang tidak memuat analitik perilaku lengkap.
 */
export async function loadHeatmapPages(experimentId: string): Promise<{ error?: string; pages: Array<{ path: string; visitors: number }> }> {
  const user = await requireUser();
  const res = await callBridge("posthog.pages", { experimentId, actorEmail: user.email });
  if (res.error) return { error: res.error, pages: [] };
  const seen = new Map<string, number>();
  for (const r of res.productPages ?? []) if (r.path.includes("/products/") && !seen.has(r.path)) seen.set(r.path, r.visitors);
  return { pages: [...seen.entries()].map(([path, visitors]) => ({ path, visitors })).sort((a, b) => b.visitors - a.visitors) };
}

/** Rekaman sesi di sekitar satu titik heatmap ("Lihat replay"). */
export async function loadHeatmapReplays(experimentId: string, params: HeatmapReplayParams): Promise<{ error?: string; replays: HeatmapReplay[] }> {
  const user = await requireUser();
  if (!/^\/[A-Za-z0-9/_\-.%]*$/.test(params.path)) return { error: tr(await getLang())("Path halaman tidak valid.", "Invalid page path."), replays: [] };
  const res = await callBridge("posthog.heatmapReplays", {
    experimentId,
    actorEmail: user.email,
    params: { path: params.path, type: params.type, viewport: params.viewport, variant: params.variant, relX: String(params.relX), y: String(params.y) },
  });
  if (res.error) return { error: res.error, replays: [] };
  return { replays: res.replays ?? [] };
}
