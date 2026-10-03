"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import posthog from "posthog-js";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CircleCheck,
  FileWarning,
  Languages,
  Layers,
  Loader2,
  Radar,
  ShieldCheck,
  ShieldOff,
} from "lucide-react";
import {
  analyzePage,
  createFromWizard,
  loadPages,
  loadThemes,
  type AnalysisResult,
} from "@/app/wizard-actions";
import type {
  ChangedFile,
  ManualTranslation,
  PageTypeInfo,
  ThemeSummary,
  TranslationPlan,
} from "@/lib/bridge";
import { sampleSizePerArm } from "@/lib/stats";
import { fmtInt } from "@/lib/format";
import { StepIndicator } from "./step-indicator";
import { SnapshotFrame } from "./snapshot-frame";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useLang, useT } from "@/components/lang-provider";
import { bi, pick, type Bi } from "@/lib/i18n";

/** nama langkah untuk analytics — sengaja tetap satu bahasa supaya event konsisten */
const STEPS = ["Halaman", "Variant B", "Snapshot", "Tracking", "Konfigurasi"];

const STEP_LABELS: Bi[] = [
  bi("Halaman", "Page"),
  bi("Variant B", "Variant B"),
  bi("Snapshot", "Snapshot"),
  bi("Tracking", "Tracking"),
  bi("Konfigurasi", "Configure"),
];

const PAGE_LABEL: Record<string, Bi> = {
  index: bi("Beranda", "Home page"),
  product: bi("Halaman produk", "Product page"),
  collection: bi("Halaman koleksi", "Collection page"),
  page: bi("Halaman statis", "Static page"),
  blog: bi("Daftar artikel", "Blog"),
  article: bi("Artikel", "Article"),
  search: bi("Hasil pencarian", "Search results"),
  cart: bi("Keranjang", "Cart"),
  "list-collections": bi("Daftar koleksi", "Collections list"),
  "404": bi("Halaman 404", "404 page"),
};

/** Tipe halaman yang tidak masuk akal untuk di-A/B test. */
const HIDDEN_TYPES = new Set(["404", "gift_card", "agents", "llms", "llms-full", "cart"]);

const SESSIONS_PER_DAY = 1820;

export function NewExperimentWizard() {
  const router = useRouter();
  const lang = useLang();
  const t = useT();
  const pageLabel = (type: string) => (PAGE_LABEL[type] ? pick(lang, PAGE_LABEL[type]) : type);
  const [step, setStep] = useState(0);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [themes, setThemes] = useState<ThemeSummary[]>([]);
  const [pages, setPages] = useState<PageTypeInfo[]>([]);
  const [examples, setExamples] = useState<Record<string, string>>({});

  const [pageType, setPageType] = useState("");
  const [templateFilename, setTemplateFilename] = useState("");
  const [examplePath, setExamplePath] = useState("/");

  const [variantSource, setVariantSource] = useState<"preview" | "blank">("preview");
  const [sourceThemeId, setSourceThemeId] = useState("");
  const [suffix, setSuffix] = useState("ab-b");

  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [blockingFiles, setBlockingFiles] = useState<ChangedFile[] | null>(null);
  const [manualTranslations, setManualTranslations] = useState<ManualTranslation[] | null>(null);
  /** merchant menyatakan sengaja menguji teks Inggris untuk semua pengunjung */
  const [acceptEnglish, setAcceptEnglish] = useState(false);
  const [snapshotLocale, setSnapshotLocale] = useState<string>("");

  const [cfg, setCfg] = useState({
    name: "",
    hypothesis: "",
    splitPctB: "50",
    primaryMetric: "cvr",
    mdeRelative: "0.2",
    baselineCvr: "0.02",
  });

  // Data theme dan template dimuat sekali di awal; keduanya lewat bridge, jadi
  // sebaiknya tidak diambil ulang setiap pindah langkah.
  useEffect(() => {
    startTransition(async () => {
      const [th, p] = await Promise.all([loadThemes(), loadPages()]);
      if (th.error) setError(th.error);
      else setThemes((th.themes ?? []).filter((x) => x.role !== "development"));
      if (p.error) setError(p.error);
      else {
        setPages(p.pages ?? []);
        setExamples(p.examples ?? {});
      }
    });
  }, []);

  const liveTheme = themes.find((th) => th.role === "main");
  const previewThemes = themes.filter((th) => th.role !== "main");

  const availableTypes = [
    ...new Set(pages.filter((p) => p.isJson && !p.suffix && !HIDDEN_TYPES.has(p.type)).map((p) => p.type)),
  ];

  const perArm = sampleSizePerArm(Number(cfg.baselineCvr) || 0.02, Number(cfg.mdeRelative) || 0.2);
  const days = Math.ceil((perArm * 2) / SESSIONS_PER_DAY);

  function choosePageType(type: string) {
    setPageType(type);
    const tpl = pages.find((p) => p.type === type && !p.suffix && p.isJson);
    setTemplateFilename(tpl?.filename ?? `templates/${type}.json`);
    setExamplePath(examples[type] ?? (type === "index" ? "/" : ""));
  }

  function completeStep(stepIndex: number) {
    posthog.capture("experiment_setup_step_completed", {
      step_index: stepIndex,
      step_name: STEPS[stepIndex],
      page_type: pageType || undefined,
      variant_source: stepIndex > 0 ? variantSource : undefined,
    });
  }

  function advance() {
    completeStep(step);
    setStep((s) => s + 1);
  }

  function runAnalysis() {
    setError(null);
    startTransition(async () => {
      const result = await analyzePage(
        examplePath,
        variantSource === "preview" ? sourceThemeId : undefined,
        templateFilename,
      );
      if (result.error) setError(result.error);
      setAnalysis(result);
      completeStep(1);
      setStep(2);
    });
  }

  function submit() {
    setError(null);
    setBlockingFiles(null);
    setManualTranslations(null);
    startTransition(async () => {
      const res = await createFromWizard({
        name: cfg.name,
        hypothesis: cfg.hypothesis,
        pageType,
        templateFilename,
        examplePath,
        sourceThemeId: variantSource === "preview" ? sourceThemeId : null,
        suffix,
        acceptEnglishFallback: acceptEnglish,
        splitPctB: Number(cfg.splitPctB),
        primaryMetric: cfg.primaryMetric,
        mdeRelative: Number(cfg.mdeRelative),
        baselineCvr: Number(cfg.baselineCvr),
        targetType: "all_products",
        targetHandles: "",
      });
      if (res.error) {
        setError(res.error);
        setBlockingFiles(res.blockingFiles ?? null);
        setManualTranslations(res.manualTranslations ?? null);
        return;
      }
      completeStep(4);
      router.push(`/experiments/${res.experimentId}`);
    });
  }

  const pendingTranslations = analysis?.translations?.needsManual ?? [];
  // Diperlakukan sama seperti file kelas BLOKIR: kalau dipaksa lanjut, testnya
  // tetap jalan dan angkanya tetap keluar, tanpa tanda apa pun bahwa yang terukur
  // sebenarnya bahasa, bukan desain.
  const translationsBlock = pendingTranslations.length > 0 && !acceptEnglish;

  // Sama persis dengan cek di server (createFromWizard) — dicek di sini supaya
  // salahnya ketahuan di langkah 2, bukan baru saat tombol terakhir ditekan.
  const suffixValid = /^[a-z0-9][a-z0-9-]{0,30}$/.test(suffix);

  const canNext =
    (step === 0 && Boolean(pageType) && Boolean(examplePath)) ||
    (step === 1 && suffixValid && (variantSource === "blank" || Boolean(sourceThemeId))) ||
    step === 2 ||
    step === 3;

  return (
    <div className="space-y-6">
      <StepIndicator
        steps={STEP_LABELS.map((l) => pick(lang, l))}
        current={step}
        ariaLabel={t("Langkah", "Steps")}
      />

      {error && (
        <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/8 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-destructive">
            <AlertTriangle className="size-4" />
            {t("Tidak bisa dilanjutkan", "Can't continue")}
          </div>
          <p className="mt-1.5 text-sm text-foreground/80">{error}</p>
          {manualTranslations && manualTranslations.length > 0 && (
            <ul className="mt-3 space-y-2 border-t border-destructive/20 pt-3">
              {manualTranslations.slice(0, 8).map((m) => (
                <li key={`${m.locale}-${m.path}`} className="text-xs">
                  <code className="font-mono text-destructive">{m.path}</code>
                  <span className="ml-2 text-muted-foreground">
                    {t(
                      `variant B "${m.sourceText}" belum punya terjemahan ${m.locale}`,
                      `variant B "${m.sourceText}" has no ${m.locale} translation`,
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {blockingFiles && blockingFiles.length > 0 && (
            <ul className="mt-3 space-y-1.5 border-t border-destructive/20 pt-3">
              {blockingFiles.map((f) => (
                <li key={f.filename} className="text-xs">
                  <code className="font-mono text-destructive">{f.filename}</code>
                  <span className="ml-2 text-muted-foreground">{f.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ---------- Langkah 1: pilih halaman ---------- */}
      {step === 0 && (
        <section className="space-y-5 surface rounded-2xl p-5">
          <div>
            <h2 className="text-sm font-semibold">{t("Halaman mana yang mau diuji?", "Which page do you want to test?")}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {t(
                `Diambil dari template yang benar-benar ada di theme live${liveTheme ? ` "${liveTheme.name}"` : ""}. Hanya template JSON yang muncul — template Liquid lama tidak mendukung alternate template.`,
                `Taken from templates that actually exist in the live theme${liveTheme ? ` "${liveTheme.name}"` : ""}. Only JSON templates are listed — legacy Liquid templates don't support alternate templates.`,
              )}
            </p>
          </div>

          {pending && pages.length === 0 ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("Membaca template dari theme live…", "Reading templates from the live theme…")}
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {availableTypes.map((type) => {
                const alternates = pages.filter((p) => p.type === type && p.suffix).length;
                return (
                  <button
                    key={type}
                    type="button"
                    onClick={() => choosePageType(type)}
                    className={cn(
                      "rounded-lg border p-3 text-left transition-colors duration-200 hover:border-primary/40 hover:bg-accent/40",
                      pageType === type && "border-primary bg-primary/8",
                    )}
                  >
                    <div className="text-sm font-medium">{pageLabel(type)}</div>
                    <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                      templates/{type}.json
                    </div>
                    {alternates > 0 && (
                      <div className="mt-1.5 text-[11px] text-muted-foreground">
                        {t(
                          `${alternates} alternate template sudah ada`,
                          `${alternates} alternate template${alternates === 1 ? "" : "s"} already exist${alternates === 1 ? "s" : ""}`,
                        )}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {pageType && (
            <div className="space-y-2 border-t pt-4">
              <Label htmlFor="examplePath">{t("Halaman contoh untuk dilihat", "Example page to preview")}</Label>
              <Input
                id="examplePath"
                value={examplePath}
                onChange={(e) => setExamplePath(e.target.value)}
                placeholder="/products/kapsul-moringa-60"
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                {t(
                  `Dipakai hanya untuk snapshot dan audit tracking. Test tetap berlaku untuk semua halaman bertipe ${pageLabel(pageType)}.`,
                  `Only used for the snapshot and tracking audit. The test still applies to every page of type ${pageLabel(pageType)}.`,
                )}
              </p>
            </div>
          )}
        </section>
      )}

      {/* ---------- Langkah 2: sumber variant B ---------- */}
      {step === 1 && (
        <section className="space-y-4 surface rounded-2xl p-5">
          <div>
            <h2 className="text-sm font-semibold">{t("Variant B diambil dari mana?", "Where does variant B come from?")}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {t(
                "Kedua variant harus hidup bersamaan di theme live, jadi isi theme preview akan disalin ke sana sebagai alternate template.",
                "Both variants must live side by side in the live theme, so the preview theme's content is copied there as an alternate template.",
              )}
            </p>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <button
              type="button"
              onClick={() => setVariantSource("preview")}
              className={cn(
                "rounded-lg border p-4 text-left transition-colors duration-200 hover:border-primary/40",
                variantSource === "preview" && "border-primary bg-primary/8",
              )}
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                <Layers className="size-4 text-primary" />
                {t("Dari theme preview", "From a preview theme")}
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                {t(
                  `Pakai theme yang sudah kamu garap. Ada ${previewThemes.length} theme di toko ini.`,
                  `Use a theme you've already worked on. This store has ${previewThemes.length} theme${previewThemes.length === 1 ? "" : "s"}.`,
                )}
              </p>
            </button>

            <button
              type="button"
              onClick={() => setVariantSource("blank")}
              className={cn(
                "rounded-lg border p-4 text-left transition-colors duration-200 hover:border-primary/40",
                variantSource === "blank" && "border-primary bg-primary/8",
              )}
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                <FileWarning className="size-4 text-muted-foreground" />
                {t("Template kosong baru", "New blank template")}
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                {t(
                  "Salinan persis template sekarang, digarap dari nol di theme editor.",
                  "An exact copy of the current template, built out from scratch in the theme editor.",
                )}
              </p>
            </button>
          </div>

          {variantSource === "preview" && (
            <div className="space-y-2">
              <Label htmlFor="sourceTheme">Theme preview</Label>
              <Select value={sourceThemeId} onValueChange={setSourceThemeId}>
                <SelectTrigger id="sourceTheme">
                  <SelectValue placeholder={t("Pilih theme…", "Choose a theme…")} />
                </SelectTrigger>
                <SelectContent>
                  {previewThemes.map((th) => (
                    <SelectItem key={th.numericId} value={th.numericId}>
                      {th.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="suffix">{t("Nama template variant B", "Variant B template name")}</Label>
            <Input
              id="suffix"
              value={suffix}
              onChange={(e) =>
                // spasi/underscore jadi tanda hubung, huruf besar jadi kecil
                setSuffix(e.target.value.toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, ""))
              }
              aria-invalid={!suffixValid}
              className="font-mono text-sm"
            />
            {!suffixValid && (
              <p className="text-xs text-destructive">
                {t(
                  "Harus diawali huruf/angka, maksimal 31 karakter, hanya huruf kecil, angka, dan tanda hubung.",
                  "Must start with a letter or number, max 31 characters, lowercase letters, numbers and hyphens only.",
                )}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {t("Akan dibuat sebagai", "Will be created as")}{" "}
              <code className="font-mono text-foreground">
                {templateFilename.replace(/\.json$/, `.${suffix}.json`)}
              </code>
            </p>
          </div>
        </section>
      )}

      {/* ---------- Langkah 3: snapshot ---------- */}
      {step === 2 && (
        <section className="space-y-4">
          {(analysis?.translations?.locales.length ?? 0) > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2 text-xs">
              <Languages className="size-3.5 text-muted-foreground" />
              <span className="text-muted-foreground">{t("Lihat dalam bahasa:", "View in language:")}</span>
              <LocaleChip
                label="Primary"
                active={snapshotLocale === ""}
                onClick={() => setSnapshotLocale("")}
              />
              {analysis?.translations?.locales.map((l) => (
                <LocaleChip
                  key={l.locale}
                  label={l.name}
                  active={snapshotLocale === l.locale}
                  onClick={() => setSnapshotLocale(l.locale)}
                />
              ))}
              <span className="w-full text-muted-foreground">
                {t(
                  "Snapshot B diambil dari theme preview — dan di preview terjemahannya memang ada. Yang menentukan adalah apakah terjemahan itu ikut pindah ke theme live; itu dilaporkan di panel Terjemahan di bawah, bukan oleh snapshot ini.",
                  "Snapshot B comes from the preview theme — and the preview does have the translations. What matters is whether they move to the live theme too; that's reported in the Translations panel below, not by this snapshot.",
                )}
              </span>
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <SnapshotFrame
              path={examplePath}
              label={t("A — theme live sekarang", "A — current live theme")}
              tone="a"
              locale={snapshotLocale || null}
            />
            {variantSource === "preview" && sourceThemeId ? (
              <SnapshotFrame
                path={examplePath}
                themeId={sourceThemeId}
                label={`B — ${previewThemes.find((th) => th.numericId === sourceThemeId)?.name ?? "preview"}`}
                tone="b"
                locale={snapshotLocale || null}
              />
            ) : (
              <div className="flex h-full min-h-[480px] items-center justify-center rounded-xl border border-dashed p-8 text-center">
                <p className="max-w-xs text-sm text-muted-foreground">
                  {t(
                    "Variant B belum punya tampilan — template-nya baru akan dibuat sebagai salinan persis variant A, lalu kamu garap di theme editor.",
                    "Variant B has no design yet — its template will be created as an exact copy of variant A, which you then edit in the theme editor.",
                  )}
                </p>
              </div>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            {t(
              "Snapshot dirender dari HTML sungguhan, tapi seluruh script dibuang. Kalau tidak, setiap kali preview dibuka, GA4, Meta Pixel, dan Klaviyo milik toko ikut menyala dan tercatat sebagai kunjungan sungguhan.",
              "Snapshots render the real HTML with every script stripped. Otherwise, each time a preview opened, the store's GA4, Meta Pixel and Klaviyo would fire and log it as a real visit.",
            )}
          </p>

          {analysis?.diff && <DiffPanel diff={analysis.diff} />}

          {analysis?.translations && (
            <TranslationPanel
              plan={analysis.translations}
              accepted={acceptEnglish}
              onAcceptChange={setAcceptEnglish}
            />
          )}
        </section>
      )}

      {/* ---------- Langkah 4: tracking ---------- */}
      {step === 3 && analysis?.a && <TrackingPanel analysis={analysis} />}

      {/* ---------- Langkah 5: konfigurasi ---------- */}
      {step === 4 && (
        <section className="space-y-4 surface rounded-2xl p-5">
          <h2 className="text-sm font-semibold">{t("Konfigurasi test", "Test configuration")}</h2>

          <div className="space-y-2">
            <Label htmlFor="name">{t("Nama eksperimen", "Experiment name")}</Label>
            <Input
              id="name"
              value={cfg.name}
              onChange={(e) => setCfg((c) => ({ ...c, name: e.target.value }))}
              placeholder={`${pageLabel(pageType)} redesign`}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="hypothesis">{t("Hipotesis", "Hypothesis")}</Label>
            <Textarea
              id="hypothesis"
              rows={3}
              value={cfg.hypothesis}
              onChange={(e) => setCfg((c) => ({ ...c, hypothesis: e.target.value }))}
              placeholder={t(
                "Ditulis sekarang, sebelum ada data. Hipotesis yang dikarang setelah melihat hasil selalu terdengar benar.",
                "Write it now, before there's any data. A hypothesis made up after seeing the results always sounds right.",
              )}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="splitPctB">{t("Traffic ke B (%)", "Traffic to B (%)")}</Label>
              <Input
                id="splitPctB"
                type="number"
                min={5}
                max={95}
                value={cfg.splitPctB}
                onChange={(e) => setCfg((c) => ({ ...c, splitPctB: e.target.value }))}
                className="font-mono"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="primaryMetric">Primary metric</Label>
              <Select
                value={cfg.primaryMetric}
                onValueChange={(v) => setCfg((c) => ({ ...c, primaryMetric: v }))}
              >
                <SelectTrigger id="primaryMetric">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cvr">Conversion rate</SelectItem>
                  <SelectItem value="atc_rate">Add-to-cart rate</SelectItem>
                  <SelectItem value="rpv">Revenue per visitor</SelectItem>
                  <SelectItem value="aov">Average order value</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="mde">Minimum effect</Label>
              <Select
                value={cfg.mdeRelative}
                onValueChange={(v) => setCfg((c) => ({ ...c, mdeRelative: v }))}
              >
                <SelectTrigger id="mde">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0.3">{t("30% relatif", "30% relative")}</SelectItem>
                  <SelectItem value="0.2">{t("20% relatif", "20% relative")}</SelectItem>
                  <SelectItem value="0.15">{t("15% relatif", "15% relative")}</SelectItem>
                  <SelectItem value="0.1">{t("10% relatif", "10% relative")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="rounded-lg bg-muted/60 p-4 text-sm">
            {lang === "en" ? (
              <>
                Needs <span className="stat-figure font-semibold">{fmtInt(perArm)}</span> visitors per
                group — about{" "}
                <span className="stat-figure font-semibold">
                  {days} day{days === 1 ? "" : "s"}
                </span>{" "}
                at current traffic.
              </>
            ) : (
              <>
                Butuh <span className="stat-figure font-semibold">{fmtInt(perArm)}</span> pengunjung per
                grup — sekitar <span className="stat-figure font-semibold">{days} hari</span> pada
                volume traffic saat ini.
              </>
            )}
          </div>
        </section>
      )}

      {/* ---------- navigasi ---------- */}
      <div className="flex items-center justify-between gap-3 border-t pt-4">
        <Button
          variant="ghost"
          onClick={() => setStep((s) => Math.max(0, s - 1))}
          disabled={step === 0 || pending}
        >
          <ArrowLeft className="size-4" />
          {t("Kembali", "Back")}
        </Button>

        {step < 4 ? (
          <Button
            onClick={() => (step === 1 ? runAnalysis() : advance())}
            disabled={!canNext || pending}
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {step === 1 ? t("Ambil snapshot", "Take snapshot") : t("Lanjut", "Next")}
            {!pending && <ArrowRight className="size-4" />}
          </Button>
        ) : (
          <div className="flex flex-col items-end gap-1.5">
            <Button
              onClick={submit}
              disabled={pending || !cfg.name.trim() || translationsBlock}
            >
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("Buat eksperimen", "Create experiment")}
            </Button>
            {translationsBlock && (
              <span className="text-xs text-destructive">
                {t(
                  `${pendingTranslations.length} teks variant B belum diterjemahkan — bereskan dulu di langkah Snapshot.`,
                  `${pendingTranslations.length} variant B text${pendingTranslations.length === 1 ? " is" : "s are"} untranslated — fix ${pendingTranslations.length === 1 ? "it" : "them"} in the Snapshot step first.`,
                )}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function LocaleChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full border px-2.5 py-0.5 transition-colors duration-200",
        active ? "border-primary bg-primary/10 text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

/**
 * Keadaan terjemahan variant B.
 *
 * Terjemahan template bukan file theme — ia resource terpisah yang diidentifikasi
 * lewat nama file template. Karena itu sebuah theme bisa lulus "0 blokir" di panel
 * Perbedaan theme dan tetap membuat variant B tampil berbahasa Inggris.
 */
function TranslationPanel({
  plan,
  accepted,
  onAcceptChange,
}: {
  plan: TranslationPlan;
  accepted: boolean;
  onAcceptChange: (v: boolean) => void;
}) {
  const t = useT();
  const manual = plan.needsManual;

  return (
    <section className="space-y-4 surface rounded-2xl p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Languages className="size-4 text-primary" />
          {t("Terjemahan", "Translations")}
        </h2>
        {!plan.error && (
          <div className="flex gap-4 text-xs">
            <Legend color="var(--positive)" label={t(`${plan.willCopy} akan disalin otomatis`, `${plan.willCopy} copied automatically`)} />
            <Legend
              color={manual.length > 0 ? "var(--destructive)" : "var(--positive)"}
              label={t(`${manual.length} perlu diterjemahkan manual`, `${manual.length} need manual translation`)}
            />
          </div>
        )}
      </div>

      {plan.error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/8 p-4 text-sm">
          <div className="flex items-center gap-2 font-medium text-destructive">
            <AlertTriangle className="size-4" />
            {t("Keadaan terjemahan tidak bisa diperiksa", "Couldn't check translation status")}
          </div>
          <p className="mt-1.5 text-foreground/80">{plan.error}</p>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {t(
              "Kalau ini soal access scope, app perlu di-deploy ulang dan izinnya disetujui lagi di admin. Sampai itu beres, terjemahan variant B tidak bisa dijamin.",
              "If this is an access scope issue, the app needs to be redeployed and its permissions re-approved in the admin. Until then, variant B translations can't be guaranteed.",
            )}
          </p>
        </div>
      ) : plan.locales.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t(
            "Toko ini hanya punya satu bahasa yang dipublikasikan, jadi tidak ada terjemahan yang perlu ikut dipindahkan.",
            "This store has only one published language, so there are no translations to move.",
          )}
        </p>
      ) : manual.length === 0 ? (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/8 p-4 text-sm">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-500" />
          <span>
            {t(
              "Semua teks variant B sudah punya terjemahan, dan akan ikut disalin ke theme live saat eksperimen dibuat.",
              "All variant B text is already translated and will be copied to the live theme when the experiment is created.",
            )}
          </span>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="rounded-lg border border-destructive/30 bg-destructive/8 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-destructive">
              <ShieldOff className="size-4" />
              {t(
                `${manual.length} teks variant B belum diterjemahkan`,
                `${manual.length} variant B text${manual.length === 1 ? " is" : "s are"} untranslated`,
              )}
            </div>
            <p className="mt-1.5 text-sm text-foreground/80">
              {t(
                "Variant A menampilkan teks ini dalam bahasa lokal, variant B tidak akan. Yang terukur bukan lagi hipotesis test, melainkan bahasa lawan bahasa — dan variant B akan kalah hampir pasti. Terjemahkan di theme preview lewat Translate & Adapt → Theme → Templates, lalu ambil snapshot ulang.",
                "Variant A shows this text in the local language; variant B won't. The test would no longer measure your hypothesis but language against language — and variant B would almost certainly lose. Translate it in the preview theme via Translate & Adapt → Theme → Templates, then take the snapshot again.",
              )}
            </p>
            <ul className="mt-3 space-y-3">
              {manual.slice(0, 10).map((m) => (
                <li key={`${m.locale}-${m.path}`} className="space-y-0.5 text-xs">
                  <code className="font-mono text-destructive">{m.path}</code>
                  <div className="text-muted-foreground">
                    Variant A &quot;{m.controlText}&quot; → &quot;{m.controlTranslation}&quot;
                  </div>
                  <div className="text-muted-foreground">
                    Variant B &quot;{m.sourceText}&quot; →{" "}
                    {t(`belum ada terjemahan ${m.locale}`, `no ${m.locale} translation yet`)}
                  </div>
                </li>
              ))}
              {manual.length > 10 && (
                <li className="text-xs text-muted-foreground">
                  {t(`…dan ${manual.length - 10} lagi.`, `…and ${manual.length - 10} more.`)}
                </li>
              )}
            </ul>
          </div>

          <label className="flex items-start gap-3 rounded-lg border p-3 text-sm">
            <Switch checked={accepted} onCheckedChange={onAcceptChange} className="mt-0.5" />
            <span>
              {t(
                "Saya sengaja menguji teks Inggris untuk semua pengunjung.",
                "I'm intentionally testing English text for all visitors.",
              )}
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {t(
                  "Hanya benar kalau bahasa memang bagian dari hipotesis. Selain itu, hasil test ini tidak akan bisa ditafsirkan.",
                  "Only valid if language is part of the hypothesis. Otherwise, the results of this test can't be interpreted.",
                )}
              </span>
            </span>
          </label>
        </div>
      )}
    </section>
  );
}

function DiffPanel({ diff }: { diff: NonNullable<AnalysisResult["diff"]> }) {
  const t = useT();
  const blocking = diff.files.filter((f) => f.changeClass === "blocking" && f.status !== "removed");

  return (
    <section className="space-y-4 surface rounded-2xl p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{t("Perbedaan theme", "Theme differences")}</h2>
        <div className="flex gap-4 text-xs">
          <Legend color="var(--positive)" label={t(`${diff.counts.safe ?? 0} aman`, `${diff.counts.safe ?? 0} safe`)} />
          <Legend color="var(--variant-b)" label={t(`${diff.counts.isolatable ?? 0} perlu isolasi`, `${diff.counts.isolatable ?? 0} need isolation`)} />
          <Legend color="var(--destructive)" label={t(`${diff.counts.blocking ?? 0} tidak bisa`, `${diff.counts.blocking ?? 0} blocking`)} />
        </div>
      </div>

      {blocking.length > 0 ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/8 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-destructive">
            <ShieldOff className="size-4" />
            {t("Theme ini tidak bisa dipakai sebagai variant B", "This theme can't be used as variant B")}
          </div>
          <p className="mt-1.5 text-sm text-foreground/80">
            {t(
              `${blocking.length} file yang berubah dipakai bersama oleh seluruh halaman, jadi tidak bisa dipisahkan per template. Kalau dipaksa, variant B di theme live tidak akan sama dengan yang kamu lihat di preview — dan tidak akan ada yang menyadarinya sampai hasil test terlanjur dipakai mengambil keputusan.`,
              `${blocking.length} changed file${blocking.length === 1 ? " is" : "s are"} shared by every page, so ${blocking.length === 1 ? "it" : "they"} can't be split per template. If forced, variant B on the live theme won't match what you see in the preview — and nobody will notice until the test results have already driven a decision.`,
            )}
          </p>
          <ul className="mt-3 space-y-1">
            {blocking.map((f) => (
              <li key={f.filename} className="text-xs">
                <code className="font-mono text-destructive">{f.filename}</code>
                <span className="ml-2 text-muted-foreground">{f.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/8 p-4 text-sm">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-500" />
          <span>
            {t(
              "Semua perubahan bisa dipindahkan tanpa menyentuh variant A. File yang dipakai bersama akan disalin dengan nama baru.",
              "Every change can be moved without touching variant A. Shared files will be copied under a new name.",
            )}
          </span>
        </div>
      )}

      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground transition-colors duration-200 hover:text-foreground">
          {t(
            `Lihat ${diff.files.length} file yang berbeda`,
            `View ${diff.files.length} changed file${diff.files.length === 1 ? "" : "s"}`,
          )}
        </summary>
        <ul className="mt-3 max-h-64 space-y-1 overflow-y-auto font-mono text-xs">
          {diff.files.map((f) => (
            <li key={f.filename} className="flex items-center gap-2">
              <span
                className="size-1.5 shrink-0 rounded-full"
                style={{
                  background:
                    f.changeClass === "safe"
                      ? "var(--positive)"
                      : f.changeClass === "isolatable"
                        ? "var(--variant-b)"
                        : "var(--destructive)",
                }}
              />
              <span className="w-16 shrink-0 text-muted-foreground">{f.status}</span>
              <span className="truncate">{f.filename}</span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-muted-foreground">
      <span className="size-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

function TrackingPanel({ analysis }: { analysis: AnalysisResult }) {
  const t = useT();
  const trackers = analysis.a?.trackers ?? [];
  const aware = trackers.filter((tr) => tr.awareness !== "unaware");
  const unaware = trackers.filter((tr) => tr.awareness === "unaware");

  return (
    <section className="space-y-5 surface rounded-2xl p-5">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Radar className="size-4 text-primary" />
          {t("Apa saja yang melacak halaman ini", "What's tracking this page")}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {t(
            `${trackers.length} tracker terdeteksi pada`,
            `${trackers.length} tracker${trackers.length === 1 ? "" : "s"} detected on`,
          )}{" "}
          <code className="font-mono">{analysis.a?.path}</code>.{" "}
          {t(
            "Yang penting bukan jumlahnya, tapi mana yang bisa memisahkan hasil A dan B.",
            "What matters isn't how many, but which ones can separate A and B results.",
          )}
        </p>
      </div>

      <div className="space-y-2">
        <h3 className="flex items-center gap-1.5 text-xs font-medium text-emerald-500">
          <CircleCheck className="size-3.5" />
          {t("Tahu variant — dipakai menyimpulkan test", "Variant-aware — used to conclude the test")}
        </h3>
        {aware.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t(
              "Belum ada. App ini baru akan terdeteksi setelah app embed diaktifkan di theme.",
              "None yet. This app is only detected once its app embed is enabled in the theme.",
            )}
          </p>
        ) : (
          aware.map((tr) => <TrackerRow key={tr.id} tracker={tr} tone="good" />)
        )}
      </div>

      <div className="space-y-2 border-t pt-4">
        <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <ShieldOff className="size-3.5" />
          {t(
            "Tidak tahu variant — tetap mencatat, tapi mencampur A dan B",
            "Not variant-aware — still records, but mixes A and B",
          )}
        </h3>
        {unaware.map((tr) => (
          <TrackerRow key={tr.id} tracker={tr} tone="muted" />
        ))}
      </div>

      <p className="rounded-lg bg-muted/60 p-3 text-xs leading-relaxed text-muted-foreground">
        {t(
          "Jangan memakai GA4, Meta, atau Klaviyo untuk menilai siapa yang menang. Semuanya mencatat kedua variant jadi satu angka. Kesimpulan test hanya boleh diambil dari dashboard ini, yang membaca konversi dari webhook order Shopify.",
          "Don't use GA4, Meta or Klaviyo to judge the winner. They all lump both variants into one number. Only draw conclusions from this dashboard, which reads conversions from Shopify order webhooks.",
        )}
      </p>
    </section>
  );
}

function TrackerRow({
  tracker,
  tone,
}: {
  tracker: { id: string; name: string; vendor: string; note: Bi | string; ids: string[] };
  tone: "good" | "muted";
}) {
  const lang = useLang();
  const t = useT();
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border p-3">
      <span className={cn("text-sm font-medium", tone === "good" && "text-emerald-500")}>
        {tracker.name}
        {tracker.id === "tl-ab" && ` ${t("(app ini)", "(this app)")}`}
      </span>
      {tracker.ids.map((id) => (
        <code key={id} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
          {id}
        </code>
      ))}
      <span className="w-full text-xs text-muted-foreground">{pick(lang, tracker.note)}</span>
    </div>
  );
}
