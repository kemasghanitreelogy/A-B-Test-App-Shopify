import Link from "next/link";
import { notFound } from "next/navigation";
import { Activity, ChevronLeft, ExternalLink, Flame, ShoppingCart, TriangleAlert, Video } from "lucide-react";
import { db } from "@/lib/db";
import { computeResults } from "@/lib/results";
import { buildMetricTests, buildVerdict } from "@/lib/verdict";
import { callBridge } from "@/lib/bridge";
import { requireUser } from "@/lib/session";
import { fmtDate, fmtIdr, fmtInt, fmtPct } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";
import { LiveIndicator } from "@/components/live-indicator";
import { VariantCompareTable, type CompareRow } from "@/components/audit/variant-compare-table";
import { BreakdownTable } from "@/components/audit/breakdown-table";
import { ReplayList } from "@/components/audit/replay-list";
import { EngagementChart } from "@/components/audit/engagement-chart";
import { HeatmapCompare } from "@/components/audit/heatmap-compare";
import { fmtDuration, fmtMs, fmtRatio } from "@/components/audit/audit-format";
import type { PostHogAnalytics } from "@/lib/posthog-analytics-types";
import { getLang } from "@/lib/i18n.server";
import { tr } from "@/lib/i18n";

/**
 * Audit lengkap satu eksperimen: semua data per variant di satu halaman.
 *
 * Dua sumber dengan peran berbeda, sengaja ditampilkan terpisah:
 *   1. Neon (lokal) — pengunjung terpapar, add-to-cart, order, revenue. Order
 *      berasal dari webhook, kebal ad-blocker. INI yang menentukan pemenang.
 *   2. PostHog (posthog-js di storefront) — pageview, sesi, scroll, rage click,
 *      web vitals, heatmap, replay. Menjelaskan KENAPA sebuah variant menang atau
 *      kalah, tapi ikut terpotong ad-blocker di kedua variant.
 */
export default async function AuditPage({ params }: PageProps<"/experiments/[id]/audit">) {
  const { id } = await params;
  const user = await requireUser();
  const lang = await getLang();
  const t = tr(lang);

  const experiment = await db.experiment.findUnique({ where: { id } });
  if (!experiment) notFound();

  const [results, analyticsBridge] = await Promise.all([
    computeResults(id),
    callBridge("posthog.analytics", { experimentId: id, actorEmail: user.email }),
  ]);
  const metrics = buildMetricTests(results, lang);
  const verdict = buildVerdict(results, experiment.primaryMetric, metrics, lang);
  const analytics: PostHogAnalytics | null = analyticsBridge.analytics ?? null;
  const engA = analytics?.engagement.find((e) => e.variant === "A") ?? null;
  const engB = analytics?.engagement.find((e) => e.variant === "B") ?? null;

  const conversionRows: CompareRow[] = [
    { label: t("Pengunjung terpapar", "Exposed visitors"), hint: t("unik, dari server", "unique, from server"), a: results.A.visitors, b: results.B.visitors, format: (v) => fmtInt(v ?? 0), goal: "none" },
    { label: "Add-to-cart rate", a: rate(results.A.addToCarts, results.A.visitors), b: rate(results.B.addToCarts, results.B.visitors), format: (v) => (v == null ? "—" : fmtPct(v, 2)), goal: "increase" },
    { label: t("Mulai checkout", "Checkout started"), hint: "web pixel", a: rate(results.A.checkoutStarts, results.A.visitors), b: rate(results.B.checkoutStarts, results.B.visitors), format: (v) => (v == null ? "—" : fmtPct(v, 2)), goal: "increase" },
    { label: "Conversion rate", hint: t("order dibayar / pengunjung", "paid orders / visitors"), a: rate(results.A.orders, results.A.visitors), b: rate(results.B.orders, results.B.visitors), format: (v) => (v == null ? "—" : fmtPct(v, 2)), goal: "increase" },
    { label: t("Order", "Orders"), a: results.A.orders, b: results.B.orders, format: (v) => fmtInt(v ?? 0), goal: "none" },
    { label: t("Revenue bersih", "Net revenue"), hint: t("dikurangi refund, tanpa order batal", "minus refunds, excluding cancelled orders"), a: results.A.revenue, b: results.B.revenue, format: (v) => fmtIdr(v ?? 0), goal: "none" },
    { label: t("Revenue per pengunjung", "Revenue per visitor"), a: rate(results.A.revenue, results.A.visitors), b: rate(results.B.revenue, results.B.visitors), format: (v) => (v == null ? "—" : fmtIdr(v)), goal: "increase" },
    { label: t("Nilai order rata-rata", "Average order value"), a: rate(results.A.revenue, results.A.orders), b: rate(results.B.revenue, results.B.orders), format: (v) => (v == null ? "—" : fmtIdr(v)), goal: "increase" },
  ];

  const behaviorRows: CompareRow[] = [
    { label: "Pageview", a: engA?.pageviews ?? null, b: engB?.pageviews ?? null, format: (v) => (v == null ? "—" : fmtInt(v)), goal: "none" },
    { label: t("Pengunjung (browser)", "Visitors (browser)"), hint: t("ikut terpotong ad-blocker", "reduced by ad-blockers"), a: engA?.visitors ?? null, b: engB?.visitors ?? null, format: (v) => (v == null ? "—" : fmtInt(v)), goal: "none" },
    { label: t("Sesi", "Sessions"), a: engA?.sessions ?? null, b: engB?.sessions ?? null, format: (v) => (v == null ? "—" : fmtInt(v)), goal: "none" },
    { label: t("Durasi sesi rata-rata", "Average session duration"), a: engA?.avgSessionDuration ?? null, b: engB?.avgSessionDuration ?? null, format: (v) => fmtDuration(v, lang), goal: "increase" },
    { label: "Bounce rate", a: engA?.bounceRate ?? null, b: engB?.bounceRate ?? null, format: (v) => fmtRatio(v), goal: "decrease" },
    { label: t("Kedalaman scroll rata-rata", "Average scroll depth"), hint: t("% tinggi halaman", "% of page height"), a: engA?.avgScrollDepth ?? null, b: engB?.avgScrollDepth ?? null, format: (v) => (v == null ? "—" : `${v.toFixed(0)}%`), goal: "increase" },
    { label: t("Klik per sesi", "Clicks per session"), a: perSession(engA?.clicks, engA?.sessions), b: perSession(engB?.clicks, engB?.sessions), format: (v) => (v == null ? "—" : v.toFixed(2)), goal: "none" },
    { label: t("Rage click per 100 sesi", "Rage clicks per 100 sessions"), hint: t("frustrasi", "frustration"), a: per100(engA?.rageclicks, engA?.sessions), b: per100(engB?.rageclicks, engB?.sessions), format: (v) => (v == null ? "—" : v.toFixed(2)), goal: "decrease" },
    { label: t("Dead click per 100 sesi", "Dead clicks per 100 sessions"), hint: t("klik yang tidak menghasilkan apa-apa", "clicks that do nothing"), a: per100(engA?.deadclicks, engA?.sessions), b: per100(engB?.deadclicks, engB?.sessions), format: (v) => (v == null ? "—" : v.toFixed(2)), goal: "decrease" },
    { label: "LCP p75", hint: t("kecepatan tampil konten utama", "main content load speed"), a: engA?.lcpP75 ?? null, b: engB?.lcpP75 ?? null, format: fmtMs, goal: "decrease" },
    { label: "INP p75", hint: t("responsivitas interaksi", "interaction responsiveness"), a: engA?.inpP75 ?? null, b: engB?.inpP75 ?? null, format: fmtMs, goal: "decrease" },
    { label: "CLS p75", hint: t("pergeseran tata letak", "layout shift"), a: engA?.clsP75 ?? null, b: engB?.clsP75 ?? null, format: (v) => (v == null ? "—" : v.toFixed(3)), goal: "decrease" },
  ];

  const pageCandidates = dedupePages([
    ...(analytics?.pages ?? []),
    ...experiment.targetHandles.map((h) => ({ path: `/products/${h}`, visitors: 0 })),
  ]);

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <Link
          href={`/experiments/${id}`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors duration-200 hover:text-foreground"
        >
          <ChevronLeft className="size-4" aria-hidden />
          {t("Kembali ke hasil", "Back to results")}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge status={experiment.status} lang={lang} />
          <h1 className="text-xl font-semibold tracking-tight">{t("Audit lengkap", "Full audit")} · {experiment.name}</h1>
          {/* 60 detik, bukan 30: tiap muat ulang ikut menjalankan query HogQL di PostHog. */}
          <LiveIndicator renderedAt={new Date().toISOString()} intervalMs={60_000} className="ml-auto" />
        </div>
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
          {lang === "en" ? (
            <>
              All per-variant data in one place. <span className="text-foreground">Conversion</span> figures from the
              server (order webhooks) decide the winner; <span className="text-foreground">behavior</span> figures,
              heatmaps, and replays from posthog-js explain why.
            </>
          ) : (
            <>
              Semua data per variant di satu tempat. Angka <span className="text-foreground">konversi</span> dari server
              (webhook order) menentukan pemenang; angka <span className="text-foreground">perilaku</span>, heatmap, dan
              replay dari posthog-js menjelaskan alasannya.
            </>
          )}
          {experiment.startedAt
            ? t(` Data sejak ${fmtDate(experiment.startedAt, lang)}.`, ` Data since ${fmtDate(experiment.startedAt, lang)}.`)
            : ""}
        </p>
      </div>

      <section
        className="surface rounded-2xl p-5"
        style={{ borderColor: `color-mix(in oklab, ${verdict.tone === "b" ? "var(--variant-b)" : verdict.tone === "a" ? "var(--variant-a)" : verdict.tone === "critical" ? "var(--destructive)" : "var(--border)"} 35%, var(--border))` }}
      >
        <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{t("Keputusan", "Decision")}</div>
        <h2 className="mt-1 text-lg font-semibold">{verdict.headline}</h2>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">{verdict.detail}</p>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <Card icon={<ShoppingCart className="size-4" aria-hidden />} title={t("Konversi per variant", "Conversion by variant")} subtitle={t("Sumber: server & webhook Shopify. Kebal ad-blocker.", "Source: server & Shopify webhooks. Immune to ad-blockers.")}>
          <VariantCompareTable rows={conversionRows} caption={t("Konversi per variant", "Conversion by variant")} />
        </Card>
        <Card
          icon={<Activity className="size-4" aria-hidden />}
          title={t("Perilaku di halaman", "On-page behavior")}
          subtitle={t(
            "Sumber: posthog-js di storefront. Terpotong ad-blocker di kedua variant.",
            "Source: posthog-js on the storefront. Reduced by ad-blockers in both variants.",
          )}
          aside={analytics?.empty ? <EmptyBadge label={t("belum ada event browser", "no browser events yet")} /> : null}
        >
          {analytics ? (
            <VariantCompareTable rows={behaviorRows} caption={t("Perilaku per variant", "Behavior by variant")} />
          ) : (
            <BridgeError
              intro={t(
                "Tidak bisa membaca analitik PostHog dari app Shopify.",
                "Couldn't read PostHog analytics from the Shopify app.",
              )}
              message={analyticsBridge.error}
            />
          )}
          {analytics?.errors.length ? (
            <p className="mt-3 flex gap-2 text-xs text-muted-foreground">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>{analytics.errors.join(" · ")}</span>
            </p>
          ) : null}
        </Card>
      </section>

      <Card icon={<Activity className="size-4" aria-hidden />} title={t("Pengunjung per hari (browser)", "Visitors per day (browser)")}
        subtitle={t("Garis putus-putus amber = variant B.", "Dashed amber line = variant B.")}
      >
        <EngagementChart daily={analytics?.daily ?? []} />
      </Card>

      <Card
        icon={<Flame className="size-4" aria-hidden />}
        title="Heatmap A vs B"
        subtitle={t(
          "Klik, rage click, gerak kursor, dan kedalaman scroll di atas snapshot halaman yang sebenarnya. Kedua sisi memakai halaman, tanggal, dan viewport yang sama. Halaman berbahasa berbeda (/id/…) punya heatmap sendiri — pilih yang trafiknya paling besar.",
          "Clicks, rage clicks, cursor movement, and scroll depth over a snapshot of the real page. Both sides use the same page, dates, and viewport. Pages in another language (/id/…) have their own heatmap — pick the one with the most traffic.",
        )}
      >
        {experiment.kind === "component" ? (
          <p className="text-sm text-muted-foreground">
            {t(
              "Eksperimen komponen: kedua varian tampil di URL yang sama, jadi heatmap per URL tidak bisa memisahkannya. Buka heatmap di PostHog dengan filter properti $feature eksperimen ini.",
              "Component experiment: both arms render at the same URL, so per-URL heatmaps can't separate them. Open the heatmap in PostHog filtered by this experiment's $feature property.",
            )}
          </p>
        ) : (
          <HeatmapCompare experimentId={id} pages={pageCandidates} variantBSuffix={experiment.variantBSuffix} />
        )}
      </Card>

      <section className="grid gap-6 lg:grid-cols-2">
        <Card
          title={t("Perangkat", "Devices")}
          subtitle={t(
            "Pangsa di dalam masing-masing variant. Pangsa yang berbeda jauh = bucketing tidak acak.",
            "Share within each variant. Very different shares = bucketing isn't random.",
          )}
        >
          <BreakdownTable rows={analytics?.devices ?? []} label={t("Perangkat", "Device")} lang={lang} />
        </Card>
        <Card title={t("Negara", "Countries")} subtitle={t("Dari GeoIP PostHog.", "From PostHog GeoIP.")}>
          <BreakdownTable rows={analytics?.countries ?? []} label={t("Negara", "Country")} limit={10} lang={lang} />
        </Card>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <Video className="size-4" aria-hidden />
              Session replay
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t(
                "Diurutkan dari yang paling banyak rage click — sesi paling bermasalah di atas. Dibuka di pemutar PostHog.",
                "Sorted by most rage clicks — the most troubled sessions first. Opens in the PostHog player.",
              )}
            </p>
          </div>
          {analytics?.replays.length ? (
            <span className="text-xs text-muted-foreground">{t(`${analytics.replays.length} rekaman terbaru`, `${analytics.replays.length} latest recordings`)}</span>
          ) : null}
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <ReplayList rows={analytics?.replays ?? []} variant="A" lang={lang} />
          <ReplayList rows={analytics?.replays ?? []} variant="B" lang={lang} />
        </div>
      </section>

      <p className="text-xs leading-relaxed text-muted-foreground">
        {t("Semua data browser dipasangkan ke variant lewat properti", "All browser data is matched to a variant via the")}{" "}
        <code className="font-mono text-foreground">$feature/{analytics?.flagKey ?? "tl-ab-…"}</code>
        {t(", bukan lewat URL, jadi variant B tetap terbaca walau ", " property, not the URL, so variant B is still recognized even when ")}
        <code className="font-mono">?view=</code>
        {t(" hilang dari alamat.", " is missing from the address.")}
        {" "}
        <a
          href="https://us.posthog.com"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
        >
          {t("Buka PostHog", "Open PostHog")}
          <ExternalLink className="size-3" aria-hidden />
        </a>
      </p>
    </div>
  );
}

function rate(num: number, den: number): number | null {
  return den > 0 ? num / den : null;
}
function perSession(count: number | undefined, sessions: number | undefined): number | null {
  return count != null && sessions ? count / sessions : null;
}
function per100(count: number | undefined, sessions: number | undefined): number | null {
  return count != null && sessions ? (count / sessions) * 100 : null;
}
/**
 * Kandidat halaman untuk heatmap.
 *
 * Memakai `includes`, bukan `startsWith`: Shopify menyajikan halaman yang sama
 * pada pathname berbeda per bahasa (`/id/products/x/`), dan di toko ini justru
 * versi Indonesia yang paling ramai. Kalau disaring dengan `startsWith("/products/")`,
 * halaman dengan trafik terbesar justru tidak pernah muncul di daftar.
 */
function dedupePages(rows: Array<{ path: string; visitors: number }>) {
  const seen = new Map<string, number>();
  for (const r of rows) if (r.path.includes("/products/") && !seen.has(r.path)) seen.set(r.path, r.visitors);
  return [...seen.entries()]
    .map(([path, visitors]) => ({ path, visitors }))
    .sort((a, b) => b.visitors - a.visitors);
}

function Card({
  icon,
  title,
  subtitle,
  aside,
  children,
}: {
  icon?: React.ReactNode;
  title: string;
  subtitle?: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="surface rounded-2xl p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            {icon}
            {title}
          </h2>
          {subtitle ? <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{subtitle}</p> : null}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

function EmptyBadge({ label }: { label: string }) {
  return <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">{label}</span>;
}

function BridgeError({ intro, message }: { intro: string; message?: string }) {
  return (
    <p className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/8 p-3 text-sm" role="alert">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
      <span>
        {intro} {message ?? ""}
      </span>
    </p>
  );
}
