import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ChevronLeft, CircleCheck, ExternalLink, Flame, ScanSearch, TriangleAlert } from "lucide-react";
import { db } from "@/lib/db";
import { computeResults } from "@/lib/results";
import { buildMetricTests, buildVerdict } from "@/lib/verdict";
import { callBridge } from "@/lib/bridge";
import { requireUser } from "@/lib/session";
import { metricLabel, targetLabel } from "@/lib/summary";
import { fmtIdr, fmtInt } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";
import { ControlForm } from "@/components/control-form";
import { VerdictPanel } from "@/components/verdict-panel";
import { MetricResults } from "@/components/metric-results";
import { TimelineChart } from "@/components/timeline-chart";
import { Funnel } from "@/components/funnel";
import { ExperimentSettings } from "@/components/experiment-settings";
import { PostHogPanel } from "@/components/posthog-panel";
import { HeatmapCompare } from "@/components/audit/heatmap-compare";
import { HealthPanel } from "@/components/health-panel";
import { storeDomain } from "@/lib/storefront";
import type { Verdict } from "@/lib/verdict";
import { pick, tr } from "@/lib/i18n";
import { getLang } from "@/lib/i18n.server";
import { componentOf } from "@/lib/components";

export default async function ExperimentPage({ params }: PageProps<"/experiments/[id]">) {
  const { id } = await params;
  const user = await requireUser();
  const isAdmin = user.role === "admin";
  const lang = await getLang();
  const t = tr(lang);

  const experiment = await db.experiment.findUnique({ where: { id } });
  if (!experiment) notFound();
  const component = experiment.kind === "component" ? componentOf(experiment.component) : null;

  // Bridge dipanggil paralel dengan agregasi, dan kegagalannya tidak boleh
  // membuat halaman hasil ikut gagal — melihat data justru paling dibutuhkan
  // saat ada yang bermasalah dengan koneksi ke Shopify.
  const [results, bridge, posthogBridge, healthBridge] = await Promise.all([
    computeResults(id),
    callBridge("status", { experimentId: id, actorEmail: user.email }),
    // Acuan PostHog dibaca lewat bridge yang sama: kunci API PostHog hanya ada
    // di app Fly.io. Kegagalannya ditampilkan di panelnya sendiri, bukan
    // menggagalkan halaman.
    callBridge("posthog.status", { experimentId: id, actorEmail: user.email }),
    // Laporan kesehatan terakhir (dihitung terjadwal di Fly, hanya dibaca di sini).
    callBridge("health.latest", { experimentId: id, actorEmail: user.email }),
  ]);

  const running = experiment.status === "running";
  const primary = experiment.primaryMetric;
  const metrics = buildMetricTests(results, lang);
  const health = healthBridge.health ?? null;
  const failedCritical = health?.checks.filter((c) => c.critical && c.status === "fail") ?? [];
  const baseVerdict = buildVerdict(results, primary, metrics, lang);
  /* Invariant kritis yang gagal (skrip storefront mati, event dari sumber yang
   * salah, konversi tanpa penugasan, …) membuat angka di halaman ini tidak
   * mengukur desain B. Verdict-nya dipaksa "tidak bisa dipakai" dengan alasan
   * yang menunjuk ke check-nya — bukan dibiarkan terlihat seperti hasil sah. */
  const verdict: Verdict =
    baseVerdict.kind !== "untrusted" && failedCritical.length > 0
      ? {
          ...baseVerdict,
          kind: "untrusted",
          winner: null,
          final: false,
          tone: "critical",
          headline: t("Pipeline tidak sehat", "Pipeline unhealthy"),
          detail: (() => {
            const list = failedCritical.map((c) => `${c.id} ${pick(lang, c.label)} (${pick(lang, c.detail)})`).join("; ");
            return t(
              `Pemeriksaan kritis gagal: ${list}. Perbaiki dulu — angka di bawah tidak bisa dipakai menilai desain B.`,
              `Critical checks failed: ${list}. Fix these first — the numbers below can't be used to judge design B.`,
            );
          })(),
        }
      : baseVerdict;

  return (
    <div className="space-y-6">
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors duration-200 hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        {t("Eksperimen", "Experiments")}
      </Link>

      <div className="reveal flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge status={experiment.status} lang={lang} />
            <h1 className="text-2xl font-semibold tracking-tight">{experiment.name}</h1>
            {health?.aaTest ? (
              <span
                className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-[0.1em] text-amber-600 dark:text-amber-400"
                title={t(
                  "Template B identik dengan A. Sah untuk memvalidasi pipeline, tapi bukan test desain.",
                  "Template B is identical to A. Valid for validating the pipeline, but not a design test.",
                )}
              >
                A/A test
              </span>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            {metricLabel(primary, lang)} · {component ? pick(lang, component.label) : targetLabel(experiment.targetType, lang)} · split{" "}
            {100 - experiment.splitPctB}/{experiment.splitPctB}
            {experiment.startedAt ? t(` · hari ke-${results.daysRunning}`, ` · day ${results.daysRunning}`) : ""}
          </p>
          {experiment.hypothesis ? (
            <p className="max-w-2xl border-l-2 border-border pl-3 text-sm leading-relaxed text-muted-foreground">
              {experiment.hypothesis}
            </p>
          ) : null}
        </div>
        <Link
          href={`/experiments/${id}/audit`}
          className="surface surface-hover inline-flex h-10 items-center gap-2 rounded-xl px-3.5 text-sm font-medium"
        >
          <ScanSearch className="size-4" aria-hidden />
          {t("Audit lengkap", "Full audit")}
          <span className="hidden text-xs font-normal text-muted-foreground sm:inline">
            {t("heatmap · replay · perilaku", "heatmap · replay · behavior")}
          </span>
        </Link>
      </div>

      {results.srm?.mismatch ? (
        <Callout tone="critical" icon={<TriangleAlert className="size-4" />} title="Sample Ratio Mismatch">
          {t(
            `Split yang teramati ${results.srm.observedPctB.toFixed(1)}% padahal seharusnya ${results.srm.expectedPctB}% (p = ${results.srm.pValue.toExponential(2)}). Penyimpangan sebesar ini hampir tidak pernah terjadi karena kebetulan — biasanya redirect gagal pada sebagian pengunjung, atau bot ikut masuk bucket. Jangan mengambil kesimpulan apa pun dari eksperimen ini sampai penyebabnya ditemukan.`,
            `The observed split is ${results.srm.observedPctB.toFixed(1)}% but should be ${results.srm.expectedPctB}% (p = ${results.srm.pValue.toExponential(2)}). A deviation this large almost never happens by chance — usually the redirect fails for some visitors, or bots end up in a bucket. Don't draw any conclusion from this experiment until the cause is found.`,
          )}
        </Callout>
      ) : null}

      {results.bucketDrift > 0 ? (
        <Callout tone="critical" icon={<TriangleAlert className="size-4" />} title={t("Bucketing tidak sinkron", "Bucketing out of sync")}>
          {t(
            `${fmtInt(results.bucketDrift)} pengunjung mendapat variant yang berbeda antara hitungan browser dan hitungan server. Artinya rumus hash di storefront dan di server sudah tidak identik, dan variant yang tercatat bukan variant yang benar-benar dilihat orang.`,
            `${fmtInt(results.bucketDrift)} visitors got a different variant in the browser count than in the server count. The hash formula on the storefront and on the server no longer match, so the recorded variant isn't the one people actually saw.`,
          )}
        </Callout>
      ) : null}

      {bridge.templateDrift ? (
        <Callout tone="warning" icon={<AlertTriangle className="size-4" />} title={t("Template variant B berubah saat test berjalan", "Variant B template changed while the test was running")}>
          {t(
            `Isi templates/product.${experiment.variantBSuffix}.json berbeda dari saat eksperimen dimulai. Data sebelum dan sesudah perubahan tidak sebanding — pertimbangkan memulai ulang.`,
            `The contents of templates/product.${experiment.variantBSuffix}.json differ from when the experiment started. Data before and after the change aren't comparable — consider restarting.`,
          )}
        </Callout>
      ) : null}

      {bridge.webPixel && !bridge.webPixel.active ? (
        <Callout tone="warning" icon={<AlertTriangle className="size-4" />} title={t("Web pixel belum aktif", "Web pixel not active")}>
          {t(
            "Men-deploy extension saja tidak mengaktifkannya. Selama pixel belum aktif, langkah",
            "Deploying the extension alone doesn't activate it. Until the pixel is active, the",
          )}{" "}
          <span className="text-foreground">{t("Mulai checkout", "Started checkout")}</span>{" "}
          {t(
            "di funnel akan selalu nol — terlihat persis seperti test yang memang belum ada yang checkout. Konversi dan revenue tidak terpengaruh, keduanya berasal dari webhook order.",
            "step in the funnel will always be zero — exactly like a test where nobody has checked out yet. Conversions and revenue aren't affected; both come from the order webhook.",
          )}
          {isAdmin ? (
            <div className="mt-3 max-w-[220px]">
              <ControlForm experimentId={id} action="pixel.ensure" label={t("Aktifkan web pixel", "Activate web pixel")} variant="outline" size="sm" />
            </div>
          ) : null}
        </Callout>
      ) : null}

      {bridge.webPixel?.active && !bridge.webPixel.settingsOk ? (
        <Callout tone="warning" icon={<AlertTriangle className="size-4" />} title={t("Pengaturan web pixel tidak cocok", "Web pixel settings don't match")}>
          {t(
            "Pixel aktif, tapi alamat pengumpul event-nya berbeda dari yang dipakai app sekarang. Event funnel dari checkout kemungkinan besar tidak sampai.",
            "The pixel is active, but its event collector address differs from the one the app uses now. Checkout funnel events most likely aren't arriving.",
          )}
          {isAdmin ? (
            <div className="mt-3 max-w-[220px]">
              <ControlForm experimentId={id} action="pixel.ensure" label={t("Betulkan pengaturan", "Fix settings")} variant="outline" size="sm" />
            </div>
          ) : null}
        </Callout>
      ) : null}

      {bridge.error ? (
        <Callout tone="warning" icon={<AlertTriangle className="size-4" />} title={t("Tidak bisa menghubungi app Shopify", "Can't reach the Shopify app")}>
          {bridge.error}{" "}
          {t(
            "Angka di bawah tetap akurat karena dibaca langsung dari database, tapi tombol aksi kemungkinan besar akan gagal.",
            "The numbers below are still accurate because they're read straight from the database, but the action buttons will most likely fail.",
          )}
        </Callout>
      ) : null}

      <VerdictPanel
        verdict={verdict}
        results={results}
        requiredPerArm={results.requiredPerArm}
        renderedAt={new Date().toISOString()}
        startedAt={experiment.startedAt?.toISOString() ?? null}
        lang={lang}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="space-y-6">
          {results.readyToConclude ? (
            <Callout tone="success" icon={<CircleCheck className="size-4" />} title={t("Siap disimpulkan", "Ready to conclude")}>
              {t(
                "Sample size dan durasi minimum sudah terpenuhi, dan tidak ada tanda data rusak.",
                "Minimum sample size and duration are met, and there's no sign of bad data.",
              )}
            </Callout>
          ) : (
            <Callout tone="warning" icon={<AlertTriangle className="size-4" />} title={t("Belum boleh disimpulkan", "Not ready to conclude")}>
              <ul className="mt-1 space-y-1.5">
                {results.blockers.map((b, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-muted-foreground">·</span>
                    <span>{pick(lang, b)}</span>
                  </li>
                ))}
              </ul>
            </Callout>
          )}

          <section className="surface reveal rounded-2xl p-5 sm:p-6" style={{ "--i": 2 } as React.CSSProperties}>
            <div className="mb-4">
              <h2 className="text-sm font-semibold">{t("Conversion rate kumulatif", "Cumulative conversion rate")}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t(
                  "Garis putus-putus amber adalah variant B, dengan pita interval kepercayaan 95%. Selama pita itu masih menutupi garis A yang biru, selisihnya belum berarti apa-apa.",
                  "The dashed amber line is variant B, with its 95% confidence band. As long as that band still covers the blue A line, the gap means nothing yet.",
                )}
              </p>
            </div>
            <TimelineChart daily={results.daily} />
          </section>

          <HealthPanel experimentId={id} report={health} bridgeError={healthBridge.error ?? null} isAdmin={isAdmin} lang={lang} />

          <PostHogPanel
            experimentId={id}
            status={posthogBridge.posthog ?? null}
            bridgeError={posthogBridge.error ?? null}
            localVisitorsA={results.A.visitors}
            localVisitorsB={results.B.visitors}
            localOrdersA={results.A.orders}
            localOrdersB={results.B.orders}
            localPrimary={verdict.primary ? { valueA: verdict.primary.valueA, valueB: verdict.primary.valueB, upliftRelative: verdict.primary.upliftRelative, significant: verdict.primary.significant } : null}
            isAdmin={isAdmin}
            lang={lang}
          />

          <section className="surface reveal rounded-2xl p-5 sm:p-6" style={{ "--i": 4 } as React.CSSProperties}>
            <div className="mb-4">
              <h2 className="text-sm font-semibold">{t("Detail hasil uji", "Test result details")}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("Hanya baris bertanda", "Only the row marked")}{" "}
                <span className="text-foreground">{t("utama", "primary")}</span>{" "}
                {t(
                  "yang menentukan keputusan. Baris lain untuk diagnosis — memilih metric mana pun yang kebetulan menang adalah p-hacking.",
                  "decides the outcome. The other rows are for diagnosis — picking whichever metric happens to win is p-hacking.",
                )}
              </p>
            </div>
            <MetricResults metrics={metrics} primaryMetric={primary} lang={lang} />
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <section className="surface reveal rounded-2xl p-5 sm:p-6" style={{ "--i": 5 } as React.CSSProperties}>
              <h2 className="mb-4 text-sm font-semibold">Funnel</h2>
              <Funnel a={results.A} b={results.B} lang={lang} />
            </section>

            <section className="surface reveal rounded-2xl p-5 sm:p-6" style={{ "--i": 6 } as React.CSSProperties}>
              <h2 className="mb-4 text-sm font-semibold">{t("Angka mentah", "Raw numbers")}</h2>
              <dl className="space-y-3 text-sm">
                <Row label={t("Pengunjung", "Visitors")} a={fmtInt(results.A.visitors)} b={fmtInt(results.B.visitors)} />
                <Row label={t("Order", "Orders")} a={fmtInt(results.A.orders)} b={fmtInt(results.B.orders)} />
                <Row label="Total revenue" a={fmtIdr(results.A.revenue)} b={fmtIdr(results.B.revenue)} />
              </dl>
              <div className="mt-4 space-y-1.5 border-t pt-3 text-xs leading-relaxed text-muted-foreground">
                <p>
                  {t("Split teramati", "Observed split")}{" "}
                  <span className="font-mono text-foreground">
                    {results.srm
                      ? `${(100 - results.srm.observedPctB).toFixed(1)}/${results.srm.observedPctB.toFixed(1)}`
                      : "—"}
                  </span>{" "}
                  {t("dari target", "vs target")} {100 - experiment.splitPctB}/{experiment.splitPctB}.
                </p>
                <p>
                  {t(
                    "Order dihitung dari webhook Shopify, bukan dari JavaScript di halaman, jadi ad-blocker tidak mengurangi angkanya.",
                    "Orders are counted from Shopify webhooks, not page JavaScript, so ad-blockers don't reduce them.",
                  )}
                </p>
              </div>
            </section>
          </div>

          <section className="surface reveal rounded-2xl p-5 sm:p-6" style={{ "--i": 7 } as React.CSSProperties}>
            <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="flex items-center gap-2 text-sm font-semibold">
                  <Flame className="size-4 text-[var(--variant-b)]" aria-hidden />
                  Heatmap A vs B
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t(
                    "Klik, rage click, gerak kursor, dan kedalaman scroll dari PostHog di atas snapshot halaman yang sebenarnya. Diperbarui sendiri tiap menit.",
                    "Clicks, rage clicks, cursor movement, and scroll depth from PostHog over a snapshot of the real page. Refreshes itself every minute.",
                  )}
                </p>
              </div>
              <Link
                href={`/experiments/${id}/audit`}
                className="text-xs text-primary underline-offset-4 hover:underline"
              >
                {t("Perilaku, replay & perangkat →", "Behavior, replay & devices →")}
              </Link>
            </div>
            {component ? (
              <p className="text-xs text-muted-foreground">
                {t(
                  "Heatmap per URL tidak berlaku untuk eksperimen komponen: kedua varian tampil di alamat yang sama. Pisahkan varian di PostHog lewat properti $feature eksperimen ini (halaman Audit).",
                  "Per-URL heatmaps don't apply to component experiments: both arms render at the same address. Split the arms in PostHog through this experiment's $feature property (Audit page).",
                )}
              </p>
            ) : (
              <HeatmapCompare experimentId={id} variantBSuffix={experiment.variantBSuffix} live />
            )}
          </section>
        </div>

        <aside className="space-y-6">
          {isAdmin ? (
            <section className="surface reveal space-y-2 rounded-2xl p-4" style={{ "--i": 3 } as React.CSSProperties}>
              <h2 className="mb-3 text-sm font-semibold">{t("Aksi", "Actions")}</h2>
              {!running ? (
                <ControlForm
                  experimentId={id}
                  action="start"
                  label={experiment.startedAt ? t("Lanjutkan", "Resume") : t("Jalankan", "Start")}
                  variant="default"
                />
              ) : (
                <ControlForm experimentId={id} action="pause" label={t("Jeda", "Pause")} />
              )}
              <ControlForm
                experimentId={id}
                action="complete"
                label={t("Tutup eksperimen", "Close experiment")}
                confirmLabel={t("Yakin? Klik lagi", "Sure? Click again")}
                variant="outline"
              />
              <ControlForm experimentId={id} action="republish" label={t("Terbitkan ulang config", "Republish config")} variant="ghost" />
            </section>
          ) : null}

          <section className="surface reveal space-y-3 rounded-2xl p-4" style={{ "--i": 4 } as React.CSSProperties}>
            <h2 className="text-sm font-semibold">{t("Desain variant B", "Variant B design")}</h2>
            {component ? (
              <div className="space-y-2 text-xs text-muted-foreground">
                <p>
                  {t("Komponen", "Component")}: <span className="font-medium text-foreground">{pick(lang, component.label)}</span>
                </p>
                <p className="break-all font-mono">cart.attributes[&apos;{component.attribute}&apos;] == &apos;B&apos;</p>
                <p>
                  {t("Sumber B", "B source")}:{" "}
                  <span className="font-medium text-foreground">
                    {experiment.variantBSourceThemeName
                      ? t(`draft theme "${experiment.variantBSourceThemeName}"`, `draft theme "${experiment.variantBSourceThemeName}"`)
                      : t("belum ada — buat ulang dari draft theme", "none — recreate from a draft theme")}
                  </span>
                </p>
                {(() => {
                  const e = experiment.variantBEntries as { shell?: string; content?: string } | null;
                  return e?.shell ? (
                    <p className="break-all font-mono">
                      {e.shell} / {e.content}
                    </p>
                  ) : null;
                })()}
                <p>
                  {t("Lihat varian B tanpa ikut dihitung:", "View variant B without being counted:")}{" "}
                  <a
                    href={`https://${storeDomain()}/?_tl_ab_off=1&_tl_ab_force=${component.key}:B`}
                    target="_blank"
                    rel="noreferrer"
                    className="break-all font-mono text-primary underline-offset-4 hover:underline"
                  >
                    ?_tl_ab_off=1&amp;_tl_ab_force={component.key}:B
                  </a>
                </p>
              </div>
            ) : (
              <p className="break-all font-mono text-xs text-muted-foreground">
                templates/product.{experiment.variantBSuffix}.json
              </p>
            )}
            {!component && bridge.editorUrl ? (
              <a
                href={bridge.editorUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-primary underline-offset-4 hover:underline"
              >
                {t("Buka di theme editor", "Open in theme editor")}
                <ExternalLink className="size-3.5" />
              </a>
            ) : null}
            <div className="space-y-2 border-t pt-3 text-xs leading-relaxed text-muted-foreground">
              <p className="font-medium text-foreground">{t("Kunjungan tim jangan ikut dihitung", "Keep team visits out of the count")}</p>
              <p>
                {t("Buka", "Open")}{" "}
                <a href={`https://${storeDomain()}/?_tl_ab_off=1`} target="_blank" rel="noreferrer" className="font-mono text-primary underline-offset-4 hover:underline">
                  {storeDomain()}/?_tl_ab_off=1
                </a>{" "}
                {t(
                  "sekali di tiap browser/HP yang dipakai tim. Browser itu lalu diabaikan selama setahun: tidak dibucket, tidak dicatat, tidak masuk PostHog.",
                  "once in every browser/phone the team uses. That browser is then ignored for a year: not bucketed, not recorded, not sent to PostHog.",
                )}
              </p>
              <p>
                {t("Setelah dikecualikan, lihat variant B lewat", "Once excluded, view variant B via")}{" "}
                <code className="font-mono text-foreground">
                  {component ? `?_tl_ab_force=${component.key}:B` : `/products/…?view=${experiment.variantBSuffix}`}
                </code>
                . {t("Aktifkan lagi dengan", "Re-enable with")}{" "}
                <a href={`https://${storeDomain()}/?_tl_ab_on=1`} target="_blank" rel="noreferrer" className="font-mono text-primary underline-offset-4 hover:underline">
                  ?_tl_ab_on=1
                </a>
                .
              </p>
            </div>
          </section>
        </aside>
      </div>

      {isAdmin ? <ExperimentSettings experiment={serialize(experiment)} locked={running} /> : null}
    </div>
  );
}

function Row({ label, a, b }: { label: string; a: string; b: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-3">
      <dt className="truncate text-muted-foreground">{label}</dt>
      <dd className="w-24 text-right font-mono tabular-nums text-[var(--variant-a)]">{a}</dd>
      <dd className="w-24 text-right font-mono tabular-nums text-[var(--variant-b)]">{b}</dd>
    </div>
  );
}

function Callout({
  tone,
  icon,
  title,
  children,
}: {
  tone: "critical" | "warning" | "success";
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  const styles = {
    critical: "border-destructive/30 bg-destructive/8 text-destructive",
    warning: "border-amber-500/30 bg-amber-500/8 text-amber-600 dark:text-amber-400",
    success: "border-emerald-500/30 bg-emerald-500/8 text-emerald-600 dark:text-emerald-400",
  }[tone];

  return (
    <div className={`reveal rounded-2xl border p-4 backdrop-blur-sm ${styles}`} role={tone === "critical" ? "alert" : undefined}>
      <div className="flex items-center gap-2 text-sm font-medium">
        {icon}
        {title}
      </div>
      <div className="mt-1.5 text-sm leading-relaxed text-foreground/80">{children}</div>
    </div>
  );
}

function serialize(e: {
  id: string;
  name: string;
  hypothesis: string | null;
  targetType: string;
  targetHandles: string[];
  excludeHandles: string[];
  splitPctB: number;
  primaryMetric: string;
  mdeRelative: number;
}) {
  return {
    id: e.id,
    name: e.name,
    hypothesis: e.hypothesis ?? "",
    targetType: e.targetType,
    targetHandles: e.targetHandles.join("\n"),
    excludeHandles: e.excludeHandles.join("\n"),
    splitPctB: String(e.splitPctB),
    primaryMetric: e.primaryMetric,
    mdeRelative: String(e.mdeRelative),
  };
}
