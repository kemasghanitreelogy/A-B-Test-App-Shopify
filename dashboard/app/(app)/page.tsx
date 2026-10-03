import Link from "next/link";
import { ArrowUpRight, Plus, ShieldAlert } from "lucide-react";
import { requireUser } from "@/lib/session";
import { getShopDomain } from "@/lib/shop";
import { listExperimentSummaries, metricLabel } from "@/lib/summary";
import { getLang } from "@/lib/i18n.server";
import { tr, type Lang } from "@/lib/i18n";
import { StatusBadge } from "@/components/status-badge";
import { LiveIndicator } from "@/components/live-indicator";
import { ControlForm } from "@/components/control-form";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { fmtInt, fmtSigned } from "@/lib/format";
import { CiPlot, ciTone, type CiTone } from "@/components/ci-plot";

function statusLabel(tone: CiTone, lang: Lang): string {
  const t = tr(lang);
  if (tone === "positive") return t("B lebih baik", "B is better");
  if (tone === "negative") return t("A lebih baik", "A is better");
  return t("Belum pasti", "Not yet clear");
}

const STATUS_TEXT: Record<CiTone, string> = {
  positive: "text-[var(--positive)]",
  negative: "text-destructive",
  neutral: "text-muted-foreground",
};

export default async function ExperimentsPage() {
  const user = await requireUser();
  const shop = await getShopDomain();
  const experiments = await listExperimentSummaries(shop);
  const running = experiments.filter((e) => e.status === "running");
  const isAdmin = user.role === "admin";
  const lang = await getLang();
  const t = tr(lang);

  return (
    <div className="space-y-6">
      <div className="reveal flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{t("Eksperimen", "Experiments")}</h1>
            <LiveIndicator renderedAt={new Date().toISOString()} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {running.length > 0
              ? t(
                  `${running.length} eksperimen sedang berjalan di ${shop || "storefront"}.`,
                  `${running.length} ${running.length === 1 ? "experiment" : "experiments"} running on ${shop || "the storefront"}.`,
                )
              : t(
                  "Tidak ada eksperimen yang berjalan. Semua pengunjung melihat desain asli.",
                  "No experiments running. All visitors see the original design.",
                )}
          </p>
        </div>

        {isAdmin ? (
          <Button asChild>
            <Link href="/experiments/new">
              <Plus className="size-4" />
              {t("Eksperimen baru", "New experiment")}
            </Link>
          </Button>
        ) : null}
      </div>

      {running.length > 0 && isAdmin ? (
        <div className="surface reveal flex flex-wrap items-center gap-4 rounded-2xl border-destructive/25! bg-destructive/5 p-4" style={{ "--i": 1 } as React.CSSProperties}>
          <ShieldAlert className="size-5 shrink-0 text-destructive" />
          <div className="min-w-56 flex-1">
            <div className="text-sm font-medium">Kill switch</div>
            <p className="text-xs text-muted-foreground">
              {t(
                "Mengembalikan seluruh pengunjung ke desain asli seketika, tanpa menghapus data yang sudah terkumpul. Pakai ini kalau desain B ternyata rusak di perangkat tertentu.",
                "Instantly sends every visitor back to the original design without deleting collected data. Use it if design B turns out to be broken on some devices.",
              )}
            </p>
          </div>
          <ControlForm
            action="killswitch"
            label={t("Matikan semua", "Turn everything off")}
            confirmLabel={t("Yakin? Klik lagi", "Sure? Click again")}
            variant="outline"
            size="sm"
            className="shrink-0"
          />
        </div>
      ) : null}

      {experiments.length === 0 ? (
        <div className="reveal rounded-2xl border border-dashed p-12 text-center">
          <p className="text-sm text-muted-foreground">
            {t("Belum ada eksperimen.", "No experiments yet.")}{" "}
            {isAdmin ? (
              <Link href="/experiments/new" className="text-primary underline-offset-4 hover:underline">
                {t("Buat yang pertama", "Create the first one")}
              </Link>
            ) : null}
          </p>
        </div>
      ) : (
        <div className="grid gap-3">
          {experiments.map((e, i) => {
            const smallestArm = Math.min(e.visitorsA, e.visitorsB);
            const progress = e.minSampleArm > 0 ? Math.min(100, (smallestArm / e.minSampleArm) * 100) : 0;

            return (
              <Link
                key={e.id}
                href={`/experiments/${e.id}`}
                className="surface surface-hover reveal group grid gap-4 rounded-2xl p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-5"
                style={{ "--i": i } as React.CSSProperties}
              >
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <StatusBadge status={e.status} lang={lang} />
                    <span className="truncate text-sm font-medium">{e.name}</span>
                    <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
                  </div>

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>{metricLabel(e.primaryMetric, lang)}</span>
                    <span>Split {100 - e.splitPctB}/{e.splitPctB}</span>
                    <span className="font-mono">
                      A {fmtInt(e.visitorsA)} · B {fmtInt(e.visitorsB)}
                    </span>
                  </div>

                  <div className="flex items-center gap-3 pt-0.5">
                    <Progress value={progress} className="h-1 max-w-64" />
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                      {fmtInt(smallestArm)} / {fmtInt(e.minSampleArm)}
                    </span>
                  </div>
                </div>

                {/* Ringkasan hasil dibuat identik di setiap kartu — uplift, interval
                    kepercayaannya, dan peluang B menang — supaya daftar ini bisa
                    dipindai tanpa membuka satu per satu. Semuanya dihitung dari
                    conversion rate, dan itu dicantumkan supaya tidak tertukar dengan
                    metric utama eksperimen yang mungkin berbeda. */}
                <div className="sm:w-60 sm:justify-self-end">
                  <div className="flex items-baseline justify-between gap-4">
                    <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                      Conversion rate
                    </span>
                    <span
                      className={`stat-figure text-lg font-semibold ${
                        e.upliftRelative === null
                          ? "text-muted-foreground"
                          : e.upliftRelative >= 0
                            ? "text-[var(--positive)]"
                            : "text-destructive"
                      }`}
                    >
                      {e.upliftRelative === null ? "—" : fmtSigned(e.upliftRelative)}
                    </span>
                  </div>

                  {e.ciLow !== null && e.ciHigh !== null && e.upliftRelative !== null ? (
                    <>
                      <CiPlot
                        lang={lang}
                        low={e.ciLow}
                        high={e.ciHigh}
                        point={e.upliftRelative}
                        domain={Math.max(0.1, Math.max(Math.abs(e.ciLow), Math.abs(e.ciHigh)) * 1.15)}
                        label={t(
                          `${e.name}: interval kepercayaan 95% dari ${fmtSigned(e.ciLow)} sampai ${fmtSigned(e.ciHigh)}`,
                          `${e.name}: 95% confidence interval from ${fmtSigned(e.ciLow)} to ${fmtSigned(e.ciHigh)}`,
                        )}
                        className="h-5"
                      />
                      <div className="flex items-baseline justify-between gap-4 text-[11px] text-muted-foreground">
                        <span className={STATUS_TEXT[ciTone(e.ciLow, e.ciHigh)]}>
                          {statusLabel(ciTone(e.ciLow, e.ciHigh), lang)}
                        </span>
                        <span className="font-mono">
                          P(B&gt;A) {e.probBBeatsA === null ? "—" : `${(e.probBBeatsA * 100).toFixed(0)}%`}
                        </span>
                      </div>
                    </>
                  ) : (
                    <p className="mt-2 text-[11px] text-muted-foreground">{t("Belum ada cukup data.", "Not enough data yet.")}</p>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
