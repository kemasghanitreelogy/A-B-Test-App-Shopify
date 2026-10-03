"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/password";
import { createSession, destroySession, requireAdmin, requireUser } from "@/lib/session";
import { callBridge, type BridgeAction } from "@/lib/bridge";
import { sampleSizePerArm } from "@/lib/stats";
import { getShopDomain } from "@/lib/shop";
import { getPostHogClient } from "@/lib/posthog-server";
import { getLang } from "@/lib/i18n.server";
import { tr } from "@/lib/i18n";

export interface FormState {
  error?: string;
  ok?: string;
}

/** Jeda yang sama untuk sukses maupun gagal, supaya waktu respons tidak
 *  membocorkan apakah sebuah email terdaftar atau tidak. */
const MIN_LOGIN_MS = 400;

export async function loginAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const started = Date.now();
  const t = tr(await getLang());
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  const settle = async () => {
    const elapsed = Date.now() - started;
    if (elapsed < MIN_LOGIN_MS) {
      await new Promise((r) => setTimeout(r, MIN_LOGIN_MS - elapsed));
    }
  };

  if (!email || !password) {
    await settle();
    return { error: t("Email dan password wajib diisi.", "Email and password are required.") };
  }

  const user = await db.adminUser.findUnique({ where: { email } });
  // Pesan error sengaja sama untuk email tidak ada maupun password salah:
  // membedakannya memberi tahu penyerang email mana yang terdaftar.
  const valid = user ? await verifyPassword(password, user.passwordHash) : false;

  if (!user || !valid) {
    await settle();
    return { error: t("Email atau password salah.", "Incorrect email or password.") };
  }

  await db.adminUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await createSession({ id: user.id, email: user.email, name: user.name, role: user.role });

  const posthog = getPostHogClient();
  if (posthog) {
    posthog.identify({
      distinctId: user.id,
      properties: { email: user.email, name: user.name, role: user.role },
    });
    posthog.capture({
      distinctId: user.id,
      event: "user_logged_in",
      properties: { role: user.role },
    });
    await posthog.flush();
  }

  redirect("/");
}

export async function logoutAction(): Promise<void> {
  await destroySession();
  redirect("/login");
}

export async function createExperimentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireAdmin();
  const t = tr(await getLang());

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: t("Nama eksperimen wajib diisi.", "Experiment name is required.") };

  const suffix = String(formData.get("variantBSuffix") ?? "").trim() || "ab-b";
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(suffix)) {
    return {
      error: t(
        "Template suffix hanya boleh huruf kecil, angka, dan tanda hubung — nilainya dipakai sebagai nama file templates/product.<suffix>.json.",
        "Template suffix may only contain lowercase letters, numbers, and hyphens — it becomes the file name templates/product.<suffix>.json.",
      ),
    };
  }

  let shop: string;
  try {
    shop = await getShopDomain();
  } catch (error) {
    const posthog = getPostHogClient();
    if (posthog) {
      posthog.captureException(error, user.id, { action: "experiment_create" });
      await posthog.flush();
    }
    return { error: error instanceof Error ? error.message : String(error) };
  }

  const mde = Number(formData.get("mdeRelative") ?? 0.2);
  const baseline = Number(formData.get("baselineCvr") ?? 0.02);
  const targetType = String(formData.get("targetType") ?? "all_products");

  const experiment = await db.experiment.create({
    data: {
      shop,
      name,
      hypothesis: String(formData.get("hypothesis") ?? "").trim() || null,
      variantBSuffix: suffix,
      splitPctB: clamp(Number(formData.get("splitPctB") ?? 50), 5, 95),
      primaryMetric: String(formData.get("primaryMetric") ?? "cvr"),
      mdeRelative: mde,
      minSampleArm: sampleSizePerArm(baseline || 0.02, mde || 0.2),
      targetType,
      targetHandles: splitList(formData.get("targetHandles")),
      excludeHandles: splitList(formData.get("excludeHandles")),
    },
  });

  await db.auditLog.create({
    data: { actorEmail: user.email, action: "experiment.create", experimentId: experiment.id, detail: name },
  });

  const posthog = getPostHogClient();
  if (posthog) {
    posthog.capture({
      distinctId: user.id,
      event: "experiment_created",
      properties: {
        experiment_id: experiment.id,
        target_type: targetType,
        primary_metric: experiment.primaryMetric,
        split_pct_b: experiment.splitPctB,
        creation_flow: "form",
      },
    });
    await posthog.flush();
  }

  redirect(`/experiments/${experiment.id}`);
}

export async function updateExperimentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireAdmin();
  const t = tr(await getLang());
  const id = String(formData.get("id") ?? "");
  if (!id) return { error: t("Eksperimen tidak ditemukan.", "Experiment not found.") };

  const experiment = await db.experiment.findUnique({ where: { id } });
  if (!experiment) return { error: t("Eksperimen tidak ditemukan.", "Experiment not found.") };

  // Begitu test berjalan, parameter yang menentukan validitas statistik tidak
  // boleh berubah. Mengubahnya di tengah jalan membuat data sebelum dan sesudah
  // perubahan tidak bisa digabungkan, dan itu tidak akan terlihat sebagai error.
  const locked = experiment.status === "running";

  await db.experiment.update({
    where: { id },
    data: {
      name: String(formData.get("name") ?? experiment.name),
      hypothesis: String(formData.get("hypothesis") ?? "").trim() || null,
      targetHandles: splitList(formData.get("targetHandles")),
      excludeHandles: splitList(formData.get("excludeHandles")),
      ...(locked
        ? {}
        : {
            targetType: String(formData.get("targetType") ?? experiment.targetType),
            splitPctB: clamp(Number(formData.get("splitPctB") ?? experiment.splitPctB), 5, 95),
            primaryMetric: String(formData.get("primaryMetric") ?? experiment.primaryMetric),
            mdeRelative: Number(formData.get("mdeRelative") ?? experiment.mdeRelative),
          }),
    },
  });

  await db.auditLog.create({
    data: { actorEmail: user.email, action: "experiment.update", experimentId: id },
  });

  // Config di storefront harus ikut diperbarui, kalau tidak perubahan targeting
  // hanya tersimpan di database tapi tidak berlaku untuk pengunjung.
  if (locked) {
    const result = await callBridge("republish", { experimentId: id, actorEmail: user.email });
    if (result.error) return {
        error: t(
          `Tersimpan, tapi gagal menerbitkan ke storefront: ${result.error}`,
          `Saved, but publishing to the storefront failed: ${result.error}`,
        ),
      };
  }

  const posthog = getPostHogClient();
  if (posthog) {
    posthog.capture({
      distinctId: user.id,
      event: "experiment_updated",
      properties: { experiment_id: id, was_running: locked },
    });
    await posthog.flush();
  }

  revalidatePath(`/experiments/${id}`);
  return { ok: t("Tersimpan.", "Saved.") };
}

export async function controlExperimentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireAdmin();
  const id = String(formData.get("id") ?? "") || undefined;
  const action = String(formData.get("action") ?? "") as BridgeAction;
  const t = tr(await getLang());

  if (!["start", "pause", "complete", "killswitch", "republish", "posthog.sync", "posthog.recalculate", "pixel.ensure", "health.run"].includes(action)) {
    return { error: t("Aksi tidak dikenal.", "Unknown action.") };
  }

  const result = await callBridge(action, { experimentId: id, actorEmail: user.email });
  if (result.error) return { error: result.error };

  const posthog = getPostHogClient();
  if (posthog) {
    posthog.capture({
      distinctId: user.id,
      event: "experiment_controlled",
      properties: {
        experiment_id: id,
        control_action: action,
        affected_all_experiments: action === "killswitch" && !id,
      },
    });
    await posthog.flush();
  }

  revalidatePath("/");
  if (id) revalidatePath(`/experiments/${id}`);

  // Terjemahan template bukan bagian dari file theme, jadi hasil penyalinannya
  // harus dikatakan: kalau ada yang tertinggal, variant B tampil berbahasa
  // Inggris dan tidak ada error apa pun yang muncul.
  const translations = result.result
    ? result.result.translationsNeedManual > 0
      ? t(
          ` ${result.result.translationsCopied} terjemahan disalin, tapi ${result.result.translationsNeedManual} teks variant B belum diterjemahkan dan akan tampil dalam bahasa Inggris.`,
          ` ${result.result.translationsCopied} translations copied, but ${result.result.translationsNeedManual} variant B texts are untranslated and will show in English.`,
        )
      : result.result.translationsCopied > 0
        ? t(
            ` ${result.result.translationsCopied} terjemahan template ikut disalin.`,
            ` ${result.result.translationsCopied} template translations were copied too.`,
          )
        : ""
    : "";
  const startWarnings = (result.result?.warnings ?? []).join(" ");

  const messages: Record<string, string> = {
    start:
      (result.result?.templateCreated
        ? t(
            `Eksperimen jalan. templates/product.${result.result.themeEditorSuffix}.json baru dibuat sebagai salinan template produk saat ini — sekarang garap desain B di theme editor.`,
            `Experiment started. templates/product.${result.result.themeEditorSuffix}.json was created as a copy of the current product template — now build design B in the theme editor.`,
          )
        : t("Eksperimen jalan.", "Experiment started.")) +
      translations +
      (startWarnings ? ` ${startWarnings}` : ""),
    pause: t("Dijeda. Semua pengunjung kembali melihat variant A.", "Paused. All visitors see variant A again."),
    complete: t("Eksperimen ditutup.", "Experiment completed."),
    killswitch: t("Kill switch aktif. Semua pengunjung melihat variant A.", "Kill switch on. All visitors see variant A."),
    republish: t("Config storefront diterbitkan ulang.", "Storefront config republished."),
    "posthog.sync":
      t("PostHog tersinkron.", "PostHog synced.") +
      (result.sent
        ? t(` ${result.sent} event yang tertunda ikut terkirim.`, ` ${result.sent} pending events were sent too.`)
        : "") +
      (result.posthog?.url
        ? t(` Status di PostHog: ${result.posthog.status ?? "—"}.`, ` PostHog status: ${result.posthog.status ?? "—"}.`)
        : ""),
    "posthog.recalculate":
      t(
        "PostHog diminta menghitung ulang. Hasil biasanya muncul dalam beberapa menit dan halaman ini memuatnya sendiri.",
        "PostHog was asked to recalculate. Results usually appear within a few minutes and this page loads them automatically.",
      ) +
      (result.sent
        ? t(
            ` ${result.sent} event yang tertunda ikut terkirim lebih dulu.`,
            ` ${result.sent} pending events were sent first.`,
          )
        : ""),
    "health.run": (() => {
      const fails = result.health?.checks.filter((c) => c.status === "fail").length ?? 0;
      const warns = result.health?.checks.filter((c) => c.status === "warn").length ?? 0;
      return fails > 0
        ? t(
            `Pemeriksaan selesai: ${fails} invariant GAGAL — lihat panel kesehatan.`,
            `Check finished: ${fails} ${fails === 1 ? "invariant" : "invariants"} FAILED — see the health panel.`,
          )
        : warns > 0
          ? t(
              `Pemeriksaan selesai: ${warns} hal perlu dilihat, tidak ada yang gagal.`,
              `Check finished: ${warns} ${warns === 1 ? "item needs" : "items need"} a look, nothing failed.`,
            )
          : t("Pemeriksaan selesai: semua hijau.", "Check finished: all green.");
    })(),
    "pixel.ensure":
      result.pixel?.action === "created"
        ? t(
            "Web pixel diaktifkan. Langkah checkout di funnel mulai terisi dari kunjungan berikutnya.",
            "Web pixel activated. Checkout steps in the funnel start filling from the next visit.",
          )
        : result.pixel?.action === "updated"
          ? t("Pengaturan web pixel dibetulkan.", "Web pixel settings fixed.")
          : t("Web pixel sudah aktif — tidak ada yang perlu diubah.", "Web pixel is already active — nothing to change."),
  };
  return { ok: messages[action] };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function splitList(value: FormDataEntryValue | null): string[] {
  return String(value ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function currentUser() {
  return requireUser();
}
