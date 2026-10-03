import type { Experiment } from "@prisma/client";
import db from "../../db.server";
import { buildMetricPlan } from "./metrics";
import { parseRecalculation, type PostHogResults, type PostHogStatus } from "./results";
import { EVENTS, FLAG_KEY_PATTERN, VARIANT_KEY, VARIANT_NAME, flagKeyFor, metricUuid, type MetricKey } from "./taxonomy";
import { captureConfigured, outboxBacklog, repairPendingExposureNames } from "./client.server";

/**
 * Cermin eksperimen di PostHog lewat Experiments API (personal API key).
 *
 * Aturan yang dipegang di seluruh file ini:
 *   1. Lifecycle lokal adalah sumber kebenaran. Sinkronisasi ke PostHog tidak
 *      pernah membatalkan start/pause/complete lokal; kegagalannya disimpan di
 *      Experiment.posthogSyncError dan ditampilkan di dashboard.
 *   2. Tidak ada tebakan bentuk API. Endpoint dan body mengikuti Experiments API
 *      dan skema tool MCP PostHog yang diverifikasi saat integrasi ini ditulis.
 *   3. Kunci hanya ada di app Fly.io. Dashboard membaca hasil lewat bridge.
 *
 * Endpoint yang dipakai (base: POSTHOG_API_HOST, default https://us.posthog.com):
 *   POST /api/projects/:pid/experiments/                       buat draft (+ flag)
 *   GET  /api/projects/:pid/experiments/:id/                   status, metrics, resolved_exposure_event
 *   POST /api/projects/:pid/experiments/:id/launch|pause|resume|end|reset/
 *   POST /api/projects/:pid/experiments/:id/metrics_recalculation/          minta hitung ulang
 *   GET  /api/projects/:pid/experiments/:id/metrics_recalculation/latest/   hasil terakhir
 *
 * Scope personal API key yang dibutuhkan: experiment:read, experiment:write,
 * feature_flag:read, feature_flag:write (flag dibuat otomatis saat create).
 */

export function experimentsApiConfigured(): boolean {
  return Boolean(process.env.POSTHOG_PERSONAL_API_KEY && process.env.POSTHOG_PROJECT_ID);
}

function apiHost(): string {
  return (process.env.POSTHOG_API_HOST || "https://us.posthog.com").replace(/\/$/, "");
}

function projectId(): string {
  return process.env.POSTHOG_PROJECT_ID ?? "";
}

export function projectUrl(): string {
  return `${apiHost()}/project/${projectId()}`;
}

export function experimentUrl(posthogExperimentId: number): string {
  return `${projectUrl()}/experiments/${posthogExperimentId}`;
}

export class PostHogApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = "PostHogApiError";
  }
}

export async function api<T = unknown>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
  const key = process.env.POSTHOG_PERSONAL_API_KEY;
  if (!key || !projectId()) throw new PostHogApiError("PostHog Experiments API belum dikonfigurasi", 0, "");
  const res = await fetch(`${apiHost()}/api/projects/${projectId()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 400);
    try {
      const parsed = JSON.parse(text) as { detail?: string; error?: string };
      detail = parsed.detail ?? parsed.error ?? detail;
    } catch {
      /* body bukan JSON */
    }
    throw new PostHogApiError(`PostHog ${method} ${path} -> HTTP ${res.status}: ${detail}`, res.status, text);
  }
  return (text ? JSON.parse(text) : null) as T;
}

/* --------------------------------------------------------------------------- */

export interface RemoteExperiment {
  id: number;
  name?: string;
  start_date?: string | null;
  end_date?: string | null;
  conclusion?: string | null;
  /** draft | running | paused | exposure_frozen | stopped */
  status?: string;
  resolved_exposure_event?: string;
  feature_flag?: { id?: number; key?: string; active?: boolean } | null;
  feature_flag_key?: string;
  metrics?: Array<{ uuid?: string; name?: string }>;
  metrics_secondary?: Array<{ uuid?: string; name?: string }>;
  [key: string]: unknown;
}

export async function fetchRemote(posthogExperimentId: number): Promise<RemoteExperiment> {
  return api<RemoteExperiment>("GET", `/experiments/${posthogExperimentId}/`);
}

/**
 * Buat draft eksperimen di PostHog beserta metric-nya.
 *
 * `allow_unknown_events: true` disengaja: metric merujuk event yang baru akan
 * masuk ketika eksperimen pertama berjalan, dan PostHog menolak metric untuk
 * event yang belum pernah diterima. Nama event berasal dari taxonomy.ts yang sama
 * dengan pengirimnya, jadi tidak ada risiko salah ketik yang biasanya dijaga
 * validasi itu.
 */
async function createRemote(experiment: Experiment): Promise<RemoteExperiment> {
  const flagKey = flagKeyFor(experiment.id);
  if (!FLAG_KEY_PATTERN.test(flagKey)) throw new Error(`flag key tidak sah: ${flagKey}`);
  const plan = buildMetricPlan(experiment.id, experiment.primaryMetric);

  const body: Record<string, unknown> = {
    name: experiment.name,
    description: [
      experiment.hypothesis ? `Hipotesis: ${experiment.hypothesis}` : null,
      `Eksperimen PDP Shopify (templates/product.${experiment.variantBSuffix}.json).`,
      "Bucketing dilakukan di storefront (FNV-1a); PostHog menerima event yang sudah membawa variant.",
      `Sumber: Treelogy A/B ${experiment.id}`,
    ]
      .filter(Boolean)
      .join("\n"),
    feature_flag_key: flagKey,
    type: "product",
    feature_flag: {
      filters: {
        multivariate: {
          variants: [
            { key: VARIANT_KEY.A, name: VARIANT_NAME.A, rollout_percentage: 100 - experiment.splitPctB },
            { key: VARIANT_KEY.B, name: VARIANT_NAME.B, rollout_percentage: experiment.splitPctB },
          ],
        },
        groups: [{ properties: [], rollout_percentage: 100 }],
      },
      ensure_experience_continuity: false,
    },
    exposure_criteria: {
      // Event storefront bersifat personless dan tidak punya properti person untuk
      // disaring; filter test account bisa membuang semuanya tanpa peringatan.
      filterTestAccounts: false,
      multiple_variant_handling: "exclude",
    },
    metrics: plan.primary,
    metrics_secondary: plan.secondary,
    running_time_calculation: {
      minimum_detectable_effect: Math.round(experiment.mdeRelative * 100),
      recommended_sample_size: experiment.minSampleArm * 2,
    },
    allow_unknown_events: true,
    tags: ["treelogy-ab", "shopify-pdp"],
  };

  try {
    return await api<RemoteExperiment>("POST", "/experiments/", body);
  } catch (error) {
    /* Flag dengan key ini sudah ada — mis. eksperimen PostHog-nya dihapus tapi
     * flag-nya tidak, atau sinkronisasi sebelumnya gagal di tengah jalan. API
     * menolak konfigurasi flag untuk flag yang sudah ada, jadi coba lagi dengan
     * menautkan flag itu apa adanya. */
    const looksLikeExistingFlag =
      error instanceof PostHogApiError && error.status === 400 && /flag/i.test(error.body) && /exist/i.test(error.body);
    if (!looksLikeExistingFlag) throw error;
    const { feature_flag: _omit, ...withoutFlagConfig } = body;
    void _omit;
    return api<RemoteExperiment>("POST", "/experiments/", withoutFlagConfig);
  }
}

async function saveLink(experimentId: string, remote: RemoteExperiment): Promise<void> {
  await db.experiment.update({
    where: { id: experimentId },
    data: {
      posthogExperimentId: remote.id,
      posthogFeatureFlagKey: remote.feature_flag?.key ?? remote.feature_flag_key ?? flagKeyFor(experimentId),
      posthogFeatureFlagId: remote.feature_flag?.id ?? null,
      posthogExposureEvent: remote.resolved_exposure_event || EVENTS.EXPOSURE_DEFAULT,
      posthogSyncedAt: new Date(),
      posthogSyncError: null,
    },
  });
}

async function saveError(experimentId: string, error: unknown): Promise<string> {
  const message = error instanceof Error ? error.message : String(error);
  await db.experiment.update({ where: { id: experimentId }, data: { posthogSyncError: message.slice(0, 1000) } });
  console.warn(`[posthog] sync eksperimen ${experimentId} gagal: ${message}`);
  return message;
}

/** Pastikan ada cermin di PostHog; buat kalau belum. */
export async function ensureRemote(experiment: Experiment): Promise<RemoteExperiment> {
  if (experiment.posthogExperimentId) {
    try {
      return await fetchRemote(experiment.posthogExperimentId);
    } catch (error) {
      // 404 = dihapus di PostHog. Buat ulang; selain itu, lempar apa adanya.
      if (!(error instanceof PostHogApiError && error.status === 404)) throw error;
    }
  }
  const created = await createRemote(experiment);
  await saveLink(experiment.id, created);
  return created;
}

type LocalTransition = "start" | "pause" | "complete";

/**
 * Cerminkan transisi lifecycle lokal ke PostHog. Tidak pernah melempar.
 *
 *   start    : draft -> launch; paused -> resume; stopped -> reset lalu launch
 *   pause    : running -> pause
 *   complete : running/paused -> end
 *
 * @returns pesan error kalau gagal, null kalau berhasil atau PostHog tidak dikonfigurasi
 */
export async function mirrorTransition(experimentId: string, transition: LocalTransition): Promise<string | null> {
  if (!experimentsApiConfigured()) return null;
  const experiment = await db.experiment.findUnique({ where: { id: experimentId } });
  if (!experiment) return "eksperimen tidak ditemukan";

  try {
    const remote = await ensureRemote(experiment);
    const id = remote.id;
    const status = remote.status ?? (remote.end_date ? "stopped" : remote.start_date ? "running" : "draft");

    if (transition === "start") {
      if (status === "draft") await api("POST", `/experiments/${id}/launch/`, {});
      else if (status === "paused") await api("POST", `/experiments/${id}/resume/`, {});
      else if (status === "stopped") {
        await api("POST", `/experiments/${id}/reset/`, {});
        await api("POST", `/experiments/${id}/launch/`, {});
      }
      // running / exposure_frozen: sudah sesuai
    } else if (transition === "pause") {
      if (status === "running") await api("POST", `/experiments/${id}/pause/`, {});
    } else if (transition === "complete") {
      if (status === "running" || status === "paused" || status === "exposure_frozen") {
        await api("POST", `/experiments/${id}/end/`, {
          conclusion_comment: "Ditutup dari dashboard Treelogy A/B. Kesimpulan diisi manusia setelah membaca kedua mesin statistik.",
        });
      }
    }

    // Baca ulang supaya exposure event dan flag id yang tersimpan selalu yang terbaru.
    const fresh = await fetchRemote(id);
    await saveLink(experiment.id, fresh);

    // Betulkan exposure yang sempat terantre dengan nama default sebelum PostHog
    // memberi tahu nama sebenarnya.
    const repaired = await repairPendingExposureNames(
      experiment.id,
      fresh.resolved_exposure_event || EVENTS.EXPOSURE_DEFAULT,
    );
    if (repaired > 0) console.warn(`[posthog] ${repaired} exposure tertunda dibetulkan namanya`);
    return null;
  } catch (error) {
    return saveError(experimentId, error);
  }
}

/** Minta PostHog menghitung ulang semua metric. Idempoten kalau sudah ada yang berjalan. */
export async function requestRecalculation(experiment: Experiment): Promise<string | null> {
  if (!experiment.posthogExperimentId) return "eksperimen belum tersambung ke PostHog";
  try {
    await api("POST", `/experiments/${experiment.posthogExperimentId}/metrics_recalculation/`, { trigger: "manual" });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function fetchLatestResults(experiment: Experiment): Promise<PostHogResults | null> {
  if (!experiment.posthogExperimentId) return null;
  try {
    const payload = await api<unknown>("GET", `/experiments/${experiment.posthogExperimentId}/metrics_recalculation/latest/`);
    const primaryKey = (["cvr", "atc_rate", "rpv", "aov"] as MetricKey[]).includes(experiment.primaryMetric as MetricKey)
      ? (experiment.primaryMetric as MetricKey)
      : "cvr";
    return parseRecalculation(payload, experiment.id, metricUuid(experiment.id, primaryKey));
  } catch (error) {
    // 404 = belum pernah dihitung. Bukan kegagalan.
    if (error instanceof PostHogApiError && error.status === 404) return null;
    throw error;
  }
}

/* Hasil PostHog tidak dihitung live — `metrics_recalculation/latest` hanya
 * mengembalikan perhitungan terakhir yang selesai. Tanpa pemicu otomatis, panel
 * PostHog membeku sampai ada admin yang ingat menekan "Hitung ulang", sementara
 * angka lokal di atasnya terus bergerak. Batas 10 menit menjaga biaya query di
 * PostHog: dashboard yang terbuka memuat ulang tiap 30 detik, tapi PostHog
 * paling sering diminta menghitung sekali per 10 menit per eksperimen. */
const AUTO_RECALC_AFTER_MS = 10 * 60_000;
const lastAutoRecalc = new Map<string, number>();

function shouldAutoRecalculate(experiment: Experiment, results: PostHogResults | null): boolean {
  if (experiment.status !== "running") return false;
  // Masih ada yang berjalan — meminta lagi hanya menumpuk antrean.
  if (results && (results.status === "pending" || results.status === "running")) return false;
  const now = Date.now();
  if (now - (lastAutoRecalc.get(experiment.id) ?? 0) < AUTO_RECALC_AFTER_MS) return false;
  const computedAt = results?.computedAt ? Date.parse(results.computedAt) : 0;
  return now - computedAt >= AUTO_RECALC_AFTER_MS;
}

/** Gambaran lengkap untuk dashboard. Tidak pernah melempar. */
export async function statusFor(experiment: Experiment): Promise<PostHogStatus> {
  const base: PostHogStatus = {
    configured: experimentsApiConfigured(),
    captureConfigured: captureConfigured(),
    linked: Boolean(experiment.posthogExperimentId),
    experimentId: experiment.posthogExperimentId ?? null,
    flagKey: experiment.posthogFeatureFlagKey ?? null,
    url: experiment.posthogExperimentId ? experimentUrl(experiment.posthogExperimentId) : null,
    status: null,
    startDate: null,
    endDate: null,
    conclusion: null,
    exposureEvent: experiment.posthogExposureEvent ?? null,
    syncedAt: experiment.posthogSyncedAt?.toISOString() ?? null,
    syncError: experiment.posthogSyncError ?? null,
    results: null,
    outboxPending: 0,
    outboxOldestPendingAt: null,
  };

  try {
    const backlog = await outboxBacklog();
    base.outboxPending = backlog.pending;
    base.outboxOldestPendingAt = backlog.oldestPendingAt?.toISOString() ?? null;
  } catch {
    /* tabel outbox tidak bisa dibaca; angka 0 lebih jujur daripada halaman gagal */
  }

  if (!base.configured || !experiment.posthogExperimentId) return base;

  try {
    const [remote, results] = await Promise.all([fetchRemote(experiment.posthogExperimentId), fetchLatestResults(experiment)]);
    base.status = remote.status ?? null;
    base.startDate = remote.start_date ?? null;
    base.endDate = remote.end_date ?? null;
    base.conclusion = remote.conclusion ?? null;
    base.exposureEvent = remote.resolved_exposure_event ?? base.exposureEvent;
    base.results = results;

    if (shouldAutoRecalculate(experiment, results)) {
      lastAutoRecalc.set(experiment.id, Date.now());
      const reason = await requestRecalculation(experiment);
      if (reason) console.warn(`[posthog] hitung ulang otomatis gagal untuk ${experiment.id}: ${reason}`);
    }
  } catch (error) {
    base.syncError = error instanceof Error ? error.message : String(error);
  }
  return base;
}
