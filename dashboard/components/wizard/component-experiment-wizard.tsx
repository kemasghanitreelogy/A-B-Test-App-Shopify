"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeft, ArrowRight, CircleCheck, Copy, Loader2, ShieldCheck, ShoppingBag } from "lucide-react";
import {
  analyzeComponentVariant,
  checkComponentReadiness,
  createComponentExperiment,
  loadThemes,
} from "@/app/wizard-actions";
import type { ComponentReadiness, ComponentVariantAnalysis, ThemeSummary } from "@/lib/bridge";
import { COMPONENTS, readinessFiles } from "@/lib/components";
import { sampleSizePerArm } from "@/lib/stats";
import { fmtInt } from "@/lib/format";
import { StepIndicator } from "./step-indicator";
import { DrawerSnapshotPair } from "./drawer-snapshot-pair";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useLang, useT } from "@/components/lang-provider";
import { bi, pick } from "@/lib/i18n";

/**
 * Wizard eksperimen KOMPONEN (claudedocs/SPEC-component-experiments.md).
 *
 * Empat langkah: pilih komponen → varian B (dari draft theme, seperti test
 * halaman) → periksa kesiapan theme live → konfigurasi.
 * Varian dipilih lewat atribut keranjang yang dibaca tema, jadi yang harus
 * dibuktikan sebelum test boleh dibuat adalah bahwa SETIAP jalur render
 * komponen membaca atribut itu — dan, kalau B dari draft theme, bahwa B bisa
 * dipindahkan ke live tanpa mengubah A satu byte pun (SPEC §10).
 */

const STEP_LABELS = [
  bi("Komponen", "Component"),
  bi("Varian B", "Variant B"),
  bi("Kesiapan tema", "Theme readiness"),
  bi("Konfigurasi", "Configure"),
];

const COMPONENT_COPY: Record<string, { desc: ReturnType<typeof bi>; exposure: ReturnType<typeof bi> }> = {
  cart_drawer: {
    desc: bi(
      "Drawer keranjang sekarang (A) lawan desain baru dari draft theme (B), di semua halaman.",
      "Current cart drawer (A) versus a new design from a draft theme (B), on every page.",
    ),
    exposure: bi(
      "Pengunjung masuk test saat pertama kali membuka keranjang — pemicunya sama di kedua varian.",
      "Visitors enter the test the first time they open the cart — the trigger is identical in both arms.",
    ),
  },
};

export function ComponentExperimentWizard() {
  const router = useRouter();
  const lang = useLang();
  const t = useT();
  const [step, setStep] = useState(0);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [component, setComponent] = useState("");
  const [readiness, setReadiness] = useState<ComponentReadiness | null>(null);
  const [themes, setThemes] = useState<ThemeSummary[] | null>(null);
  const [themeId, setThemeId] = useState("");
  const [analysis, setAnalysis] = useState<ComponentVariantAnalysis | null>(null);
  const [token, setToken] = useState<string | undefined>(undefined);
  const [acceptEnglish, setAcceptEnglish] = useState(false);
  const [cfg, setCfg] = useState({
    name: "",
    hypothesis: "",
    splitPctB: "50",
    primaryMetric: "rpv",
    mdeRelative: "0.1",
    baselineCvr: "0.3",
  });

  const perArm = sampleSizePerArm(Number(cfg.baselineCvr) || 0.3, Number(cfg.mdeRelative) || 0.1);
  const def = component ? COMPONENTS[component] : null;

  const theme = themes?.find((x) => x.id === themeId) ?? null;
  const plan = analysis?.plan ?? null;
  const variantOk =
    (!!plan && plan.blocking.length === 0 && !!plan.entries && (plan.untranslated.length === 0 || acceptEnglish));

  function toVariantStep() {
    setError(null);
    setStep(1);
    if (themes) return;
    startTransition(async () => {
      const res = await loadThemes();
      if (res.error) {
        setError(res.error);
        return;
      }
      setThemes((res.themes ?? []).filter((x) => x.role !== "main"));
    });
  }

  function runAnalysis(id: string) {
    setThemeId(id);
    setAnalysis(null);
    setAcceptEnglish(false);
    setError(null);
    startTransition(async () => {
      const res = await analyzeComponentVariant(component, id, token);
      if (res.error) {
        setError(res.error);
        return;
      }
      setAnalysis(res.analysis ?? null);
      setToken(res.token);
    });
  }

  function runReadiness() {
    setError(null);
    setReadiness(null);
    startTransition(async () => {
      const res = await checkComponentReadiness(component);
      if (res.error) {
        setError(res.error);
        return;
      }
      setReadiness(res.readiness ?? null);
      setStep(2);
    });
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await createComponentExperiment({
        name: cfg.name,
        hypothesis: cfg.hypothesis,
        component,
        splitPctB: Number(cfg.splitPctB),
        primaryMetric: cfg.primaryMetric,
        mdeRelative: Number(cfg.mdeRelative),
        baselineCvr: Number(cfg.baselineCvr),
        source:
          theme && token
            ? { themeId: theme.id, themeName: theme.name, token, acceptEnglishFallback: acceptEnglish }
            : undefined,
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      router.push(`/experiments/${res.experimentId}`);
    });
  }

  return (
    <div className="space-y-6">
      <StepIndicator steps={STEP_LABELS.map((l) => pick(lang, l))} current={step} ariaLabel={t("Langkah", "Steps")} />

      {error && (
        <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/8 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-destructive">
            <AlertTriangle className="size-4" />
            {t("Tidak bisa dilanjutkan", "Can't continue")}
          </div>
          <p className="mt-1.5 text-sm text-foreground/80">{error}</p>
        </div>
      )}

      {step === 0 && (
        <section className="space-y-3 surface rounded-2xl p-5">
          <h2 className="text-sm font-semibold">{t("Komponen yang dites", "Component to test")}</h2>
          <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label={t("Komponen", "Component")}>
            {Object.values(COMPONENTS).map((c) => {
              const active = component === c.key;
              return (
                <button
                  key={c.key}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setComponent(c.key)}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-xl border p-4 text-left transition-colors duration-200",
                    active ? "border-primary bg-primary/5" : "hover:bg-muted/60",
                  )}
                >
                  <ShoppingBag className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="space-y-1">
                    <span className="block text-sm font-medium">{pick(lang, c.label)}</span>
                    {COMPONENT_COPY[c.key] && (
                      <span className="block text-xs text-muted-foreground">{pick(lang, COMPONENT_COPY[c.key].desc)}</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {step === 1 && def && (
        <section className="space-y-4 surface rounded-2xl p-5">
          <h2 className="text-sm font-semibold">{t("Varian B dari draft theme", "Variant B from a draft theme")}</h2>
          <p className="text-xs text-muted-foreground">
            {t(
              "Desain drawer di draft theme, persis seperti yang tampil di preview-nya. Disalin ke live dengan nama baru saat eksperimen dibuat — varian A tidak berubah.",
              "The drawer designed in a draft theme, exactly as its preview shows it. Copied to live under new names when the experiment is created — variant A does not change.",
            )}
          </p>

          {(
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="c-theme">{t("Draft theme", "Draft theme")}</Label>
                <Select value={themeId} onValueChange={runAnalysis} disabled={!themes || pending}>
                  <SelectTrigger id="c-theme" className="sm:max-w-md">
                    <SelectValue placeholder={themes ? t("Pilih theme…", "Choose a theme…") : t("Memuat theme…", "Loading themes…")} />
                  </SelectTrigger>
                  <SelectContent>
                    {(themes ?? []).map((x) => (
                      <SelectItem key={x.id} value={x.id}>
                        {x.name}
                        <span className="ml-2 font-mono text-xs text-muted-foreground">{x.numericId}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {t(
                    "Varian B = drawer yang dirender draft ini untuk pengunjung biasa (yang terlihat di preview-nya tanpa parameter apa pun).",
                    "Variant B = the drawer this draft renders for a regular visitor (what its preview shows without any parameter).",
                  )}
                </p>
              </div>

              {pending && themeId && !plan && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  {t("Menelusuri drawer di draft theme…", "Tracing the drawer in the draft theme…")}
                </p>
              )}

              {plan && theme && !plan.blocking.length && <DrawerSnapshotPair themeId={theme.id} themeName={theme.name} />}

              {plan && <VariantPlanView analysis={analysis!} acceptEnglish={acceptEnglish} onAcceptEnglish={setAcceptEnglish} />}
            </div>
          )}
        </section>
      )}

      {step === 2 && def && readiness && (
        <section className="space-y-4 surface rounded-2xl p-5">
          <div className="flex items-center gap-2">
            {readiness.ok ? (
              <ShieldCheck className="size-4 text-emerald-600" />
            ) : (
              <AlertTriangle className="size-4 text-destructive" />
            )}
            <h2 className="text-sm font-semibold">
              {readiness.ok
                ? t("Theme live siap", "Live theme is ready")
                : t("Theme live belum siap", "Live theme is not ready")}
              {readiness.theme && <span className="ml-2 font-normal text-muted-foreground">· {readiness.theme.name}</span>}
            </h2>
          </div>

          <ul className="space-y-1.5 text-sm">
            {readinessFiles(def).map((file) => {
              const problem = readiness.problems.find((p) => p.file === file);
              const wired = def.checks.some((c) => c.file === file);
              return (
                <li key={file} className="flex items-start gap-2">
                  {problem ? (
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                  ) : (
                    <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
                  )}
                  <span>
                    <code className="font-mono text-xs">{file}</code>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {problem?.reason === "missing_file"
                        ? t("tidak ada", "missing")
                        : problem?.reason === "missing_switch"
                          ? t("belum memakai saklar", "not wired to the switch")
                          : problem?.reason === "bypass"
                            ? t("masih merender drawer tanpa saklar", "still renders a drawer around the switch")
                            : wired
                              ? t("lewat saklar", "goes through the switch")
                              : t("ada", "present")}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>

          <p className="rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground">
            {pick(lang, COMPONENT_COPY[def.key]?.exposure ?? bi("", ""))}{" "}
            {t(
              "QA varian B tanpa ikut terhitung: buka situs dengan ?_tl_ab_off=1 lalu ?_tl_ab_force=cart_drawer:B.",
              "QA variant B without being counted: open the site with ?_tl_ab_off=1, then ?_tl_ab_force=cart_drawer:B.",
            )}
          </p>
        </section>
      )}

      {step === 3 && def && (
        <section className="space-y-4 surface rounded-2xl p-5">
          <h2 className="text-sm font-semibold">{t("Konfigurasi test", "Test configuration")}</h2>

          <div className="space-y-2">
            <Label htmlFor="c-name">{t("Nama eksperimen", "Experiment name")}</Label>
            <Input
              id="c-name"
              value={cfg.name}
              onChange={(e) => setCfg((c) => ({ ...c, name: e.target.value }))}
              placeholder={`${pick(lang, def.label)} v3`}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="c-hypothesis">{t("Hipotesis", "Hypothesis")}</Label>
            <Textarea
              id="c-hypothesis"
              rows={3}
              value={cfg.hypothesis}
              onChange={(e) => setCfg((c) => ({ ...c, hypothesis: e.target.value }))}
              placeholder={t(
                "Ditulis sekarang, sebelum ada data. Hipotesis yang dikarang setelah melihat hasil selalu terdengar benar.",
                "Write it now, before there's any data. A hypothesis made up after seeing the results always sounds right.",
              )}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-4">
            <div className="space-y-2">
              <Label htmlFor="c-split">{t("Traffic ke B (%)", "Traffic to B (%)")}</Label>
              <Input
                id="c-split"
                type="number"
                min={5}
                max={95}
                value={cfg.splitPctB}
                onChange={(e) => setCfg((c) => ({ ...c, splitPctB: e.target.value }))}
                className="font-mono"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="c-metric">Primary metric</Label>
              <Select value={cfg.primaryMetric} onValueChange={(v) => setCfg((c) => ({ ...c, primaryMetric: v }))}>
                <SelectTrigger id="c-metric">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="rpv">Revenue per visitor</SelectItem>
                  <SelectItem value="cvr">Conversion rate</SelectItem>
                  <SelectItem value="aov">Average order value</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="c-mde">Minimum effect</Label>
              <Select value={cfg.mdeRelative} onValueChange={(v) => setCfg((c) => ({ ...c, mdeRelative: v }))}>
                <SelectTrigger id="c-mde">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0.2">{t("20% relatif", "20% relative")}</SelectItem>
                  <SelectItem value="0.15">{t("15% relatif", "15% relative")}</SelectItem>
                  <SelectItem value="0.1">{t("10% relatif", "10% relative")}</SelectItem>
                  <SelectItem value="0.05">{t("5% relatif", "5% relative")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="c-baseline">{t("Konversi saat ini", "Current conversion")}</Label>
              <Input
                id="c-baseline"
                type="number"
                min={0.01}
                max={0.95}
                step={0.01}
                value={cfg.baselineCvr}
                onChange={(e) => setCfg((c) => ({ ...c, baselineCvr: e.target.value }))}
                className="font-mono"
              />
            </div>
          </div>

          <div className="rounded-lg bg-muted/60 p-4 text-sm">
            {t(
              `Butuh ${fmtInt(perArm)} pengunjung PEMBUKA KERANJANG per grup. "Konversi saat ini" adalah porsi pembuka keranjang yang akhirnya membeli (bukan konversi seluruh situs) — isi dari data GA4 view_cart → purchase supaya perkiraan ini akurat.`,
              `Needs ${fmtInt(perArm)} CART-OPENING visitors per group. "Current conversion" is the share of cart openers who end up buying (not site-wide conversion) — fill it in from GA4 view_cart → purchase so this estimate is accurate.`,
            )}
          </div>
        </section>
      )}

      <div className="flex items-center justify-between gap-3 border-t pt-4">
        <Button variant="ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0 || pending}>
          <ArrowLeft className="size-4" />
          {t("Kembali", "Back")}
        </Button>

        {step === 0 && (
          <Button onClick={toVariantStep} disabled={!component || pending}>
            {t("Lanjut", "Next")}
            <ArrowRight className="size-4" />
          </Button>
        )}
        {step === 1 && (
          <Button onClick={runReadiness} disabled={!variantOk || pending}>
            {pending && plan ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("Periksa tema", "Check theme")}
            {!pending && <ArrowRight className="size-4" />}
          </Button>
        )}
        {step === 2 && (
          <Button onClick={() => setStep(3)} disabled={!readiness?.ok || pending}>
            {t("Lanjut", "Next")}
            <ArrowRight className="size-4" />
          </Button>
        )}
        {step === 3 && (
          <Button onClick={submit} disabled={pending || !cfg.name.trim()}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("Buat eksperimen", "Create experiment")}
          </Button>
        )}
      </div>
    </div>
  );
}

const STATUS_COPY: Record<string, ReturnType<typeof bi>> = {
  identical: bi("sama dengan live", "same as live"),
  changed: bi("diubah di draft", "changed in the draft"),
  added: bi("baru di draft", "new in the draft"),
  depends_on_changed: bi("merender berkas yang berubah", "renders a changed file"),
};

/** Rencana pemindahan varian B — sama persis dengan yang akan dijalankan server. */
function VariantPlanView({
  analysis,
  acceptEnglish,
  onAcceptEnglish,
}: {
  analysis: ComponentVariantAnalysis;
  acceptEnglish: boolean;
  onAcceptEnglish: (v: boolean) => void;
}) {
  const lang = useLang();
  const t = useT();
  const { plan, notCarried } = analysis;
  const blocked = plan.blocking.length > 0;
  const copies = [...plan.files, ...plan.assets].filter((f) => f.action === "isolate");
  const added = plan.localeKeys.filter((k) => k.action === "add").length;
  const isolated = plan.localeKeys.length - added;

  return (
    <div className="space-y-4">
      <div
        role="status"
        className={cn(
          "rounded-xl border p-4 text-sm",
          blocked
            ? "border-destructive/30 bg-destructive/8"
            : plan.identicalToLive
              ? "border-amber-500/30 bg-amber-500/8"
              : "border-emerald-600/30 bg-emerald-600/8",
        )}
      >
        <div className="flex items-center gap-2 font-medium">
          {blocked ? (
            <AlertTriangle className="size-4 text-destructive" />
          ) : plan.identicalToLive ? (
            <AlertTriangle className="size-4 text-amber-600" />
          ) : (
            <ShieldCheck className="size-4 text-emerald-600" />
          )}
          {blocked
            ? t("Tidak bisa dipindahkan tanpa mengubah varian A", "Cannot be carried over without changing variant A")
            : plan.identicalToLive
              ? t("Drawer di draft ini SAMA dengan drawer live — ini A/A test", "This draft's drawer is the SAME as live — this is an A/A test")
              : t("Bisa dipindahkan — varian A tidak berubah", "Can be carried over — variant A does not change")}
        </div>
        {plan.identicalToLive && !blocked && (
          <p className="mt-1.5 text-xs text-foreground/80">
            {t(
              "Draft ini masih merender drawer yang sama dengan live untuk pengunjung biasa. Jadikan desain barumu drawer bawaan di draft (yang tampil di preview), lalu analisis ulang.",
              "This draft still renders the live drawer for a regular visitor. Make your new design the draft's default drawer (the one its preview shows), then analyze again.",
            )}
          </p>
        )}
        {plan.sourceEntries && (
          <p className="mt-2 font-mono text-xs text-muted-foreground">
            {plan.sourceEntries.shell} / {plan.sourceEntries.content}
            {plan.entries && !plan.identicalToLive && (
              <>
                {" → "}
                {plan.entries.shell} / {plan.entries.content}
              </>
            )}
          </p>
        )}
      </div>

      {blocked && (
        <ul className="space-y-1.5 text-sm">
          {plan.blocking.map((b) => (
            <li key={b.file + b.reason} className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
              <span>
                <code className="font-mono text-xs">{b.file}</code>
                <span className="ml-2 text-xs text-muted-foreground">{b.reason}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t(`Berkas drawer (${plan.files.length + plan.assets.length})`, `Drawer files (${plan.files.length + plan.assets.length})`)}
          </h3>
          <ul className="space-y-1 text-sm">
            {[...plan.files, ...plan.assets].map((f) => (
              <li key={f.source} className="flex items-start gap-2">
                {f.action === "isolate" ? (
                  <Copy className="mt-0.5 size-3.5 shrink-0 text-primary" aria-label={t("disalin", "copied")} />
                ) : (
                  <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-label={t("dipakai ulang", "reused")} />
                )}
                <span className="min-w-0">
                  <code className="break-all font-mono text-xs">{f.source.replace(/^(snippets|assets)\//, "")}</code>
                  <span className="ml-2 text-xs text-muted-foreground">{pick(lang, STATUS_COPY[f.status])}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            {t(
              `${copies.length} disalin dengan nama baru, ${plan.files.length + plan.assets.length - copies.length} dipakai ulang apa adanya.`,
              `${copies.length} copied under new names, ${plan.files.length + plan.assets.length - copies.length} reused as they are.`,
            )}
          </p>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("Terjemahan", "Translations")}</h3>
            <p className="text-sm">
              {plan.localeKeys.length === 0
                ? t("Tidak ada teks yang berubah.", "No text changed.")
                : t(
                    `${added} kunci baru ditambahkan, ${isolated} teks yang berubah disimpan dengan nama baru (teks A tetap).`,
                    `${added} new key${added === 1 ? "" : "s"} added, ${isolated} changed text${isolated === 1 ? "" : "s"} stored under a new name (A's text stays).`,
                  )}
            </p>
            {plan.untranslated.length > 0 && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/8 p-3 text-sm">
                <p className="font-medium">
                  {t(
                    `${plan.untranslated.length} teks belum diterjemahkan di draft`,
                    `${plan.untranslated.length} text${plan.untranslated.length === 1 ? "" : "s"} not translated in the draft`,
                  )}
                </p>
                <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto font-mono text-xs text-muted-foreground">
                  {plan.untranslated.map((u) => (
                    <li key={u.key + u.locale}>
                      {u.locale} · {u.key}
                    </li>
                  ))}
                </ul>
                <label className="mt-2 flex cursor-pointer items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={acceptEnglish}
                    onChange={(e) => onAcceptEnglish(e.target.checked)}
                  />
                  {t(
                    "Saya paham: pengunjung bahasa itu melihat teks ini dalam bahasa utama, sementara A tetap diterjemahkan — yang terukur sebagian adalah bahasanya.",
                    "I understand: visitors in that language see this text in the primary language while A stays translated — part of what is measured is language.",
                  )}
                </label>
              </div>
            )}
          </div>

          {notCarried.length > 0 && (
            <div className="space-y-1.5">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t(`Tidak ikut dibawa (${notCarried.length})`, `Not carried over (${notCarried.length})`)}
              </h3>
              <p className="text-xs text-muted-foreground">
                {t(
                  "Berbeda di draft tapi berlaku untuk seluruh situs, jadi tidak dipindahkan. Kalau drawer barumu bergantung pada salah satunya, B di live tidak akan sama dengan preview.",
                  "Different in the draft but site-wide, so not carried over. If your new drawer depends on one of these, B in live will not match the preview.",
                )}
              </p>
              <ul className="max-h-32 space-y-0.5 overflow-y-auto font-mono text-xs text-muted-foreground">
                {notCarried.map((f) => (
                  <li key={f} className="break-all">
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {plan.warnings.length > 0 && (
            <ul className="space-y-1 text-xs text-amber-700 dark:text-amber-400">
              {plan.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
