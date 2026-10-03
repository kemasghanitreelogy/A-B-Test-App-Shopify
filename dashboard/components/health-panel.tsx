import { Activity, CircleCheck, CircleHelp, Info, OctagonAlert, TriangleAlert } from "lucide-react";
import type { HealthReport, HealthStatus } from "@/lib/health-types";
import { ControlForm } from "@/components/control-form";
import { cn } from "@/lib/utils";
import { intlLocale, pick, tr, type Bi, type Lang } from "@/lib/i18n";

const STATUS: Record<HealthStatus, { label: Bi; icon: typeof CircleCheck; className: string; dot: string }> = {
  ok: { label: { id: "OK", en: "OK" }, icon: CircleCheck, className: "text-[var(--positive)]", dot: "bg-[var(--positive)]" },
  warn: { label: { id: "Perlu dilihat", en: "Needs a look" }, icon: TriangleAlert, className: "text-amber-600 dark:text-amber-400", dot: "bg-amber-500" },
  fail: { label: { id: "Gagal", en: "Failed" }, icon: OctagonAlert, className: "text-destructive", dot: "bg-destructive" },
  info: { label: { id: "Info", en: "Info" }, icon: Info, className: "text-muted-foreground", dot: "bg-muted-foreground" },
};

const clockFor = (lang: Lang) =>
  new Intl.DateTimeFormat(intlLocale(lang), { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" });

/**
 * Panel kesehatan pipeline.
 *
 * Menjawab "apakah nol itu benar-benar nol": tiap sumber punya bukti hidup dan
 * coverage, dan tiap invariant punya status yang dieksekusi terjadwal — bukan
 * kalimat di dokumentasi. Check kritis yang gagal membuat verdict di atas
 * otomatis "tidak bisa dipakai"; di sini ditampilkan alasannya.
 */
export function HealthPanel({
  experimentId,
  report,
  bridgeError,
  isAdmin,
  lang,
}: {
  experimentId: string;
  report: HealthReport | null;
  bridgeError: string | null;
  isAdmin: boolean;
  lang: Lang;
}) {
  const t = tr(lang);
  const clock = clockFor(lang);
  const fails = report?.checks.filter((c) => c.status === "fail").length ?? 0;
  const warns = report?.checks.filter((c) => c.status === "warn").length ?? 0;
  const tone = !report ? "neutral" : fails > 0 ? "critical" : warns > 0 ? "warn" : "ok";

  return (
    <section
      className="surface reveal rounded-2xl p-5 sm:p-6"
      style={{
        "--i": 3,
        borderColor:
          tone === "critical"
            ? "color-mix(in oklab, var(--destructive) 40%, var(--border))"
            : tone === "warn"
              ? "color-mix(in oklab, #f59e0b 35%, var(--border))"
              : undefined,
      } as React.CSSProperties}
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Activity className="size-4 text-primary" aria-hidden />
            {t("Kesehatan pipeline", "Pipeline health")}
            {report ? (
              <span
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.1em]",
                  tone === "critical"
                    ? "border-destructive/30 bg-destructive/10 text-destructive"
                    : tone === "warn"
                      ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                      : "border-[var(--positive)]/30 bg-[var(--positive)]/10 text-[var(--positive)]",
                )}
              >
                {tone === "critical"
                  ? t(`${fails} gagal`, `${fails} failed`)
                  : tone === "warn"
                    ? t(`${warns} perlu dilihat`, `${warns} need a look`)
                    : t("semua hijau", "all green")}
              </span>
            ) : null}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("Apakah nol itu benar-benar nol. Diperiksa otomatis tiap 10 menit", "Is a zero really a zero? Checked automatically every 10 minutes")}
            {report ? ` · ${t("terakhir", "last")} ${clock.format(new Date(report.generatedAt))}` : ""}.
          </p>
        </div>
        {isAdmin ? (
          <ControlForm experimentId={experimentId} action="health.run" label={t("Periksa sekarang", "Check now")} variant="outline" size="sm" className="w-auto" />
        ) : null}
      </div>

      {bridgeError ? (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/8 p-3 text-sm">{bridgeError}</p>
      ) : !report ? (
        <p className="flex items-center gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          <CircleHelp className="size-4" aria-hidden />
          {t(
            "Belum pernah diperiksa. Pemeriksaan pertama berjalan 20 detik setelah app Fly menyala, lalu tiap 10 menit.",
            "Not checked yet. The first check runs 20 seconds after the Fly app starts, then every 10 minutes.",
          )}
        </p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
          <ul className="divide-y divide-border/70">
            {report.checks.map((c) => {
              const s = STATUS[c.status];
              return (
                <li key={c.id} className="flex items-start gap-3 py-2.5">
                  <s.icon className={cn("mt-0.5 size-4 shrink-0", s.className)} aria-label={pick(lang, s.label)} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-mono text-[10px] text-muted-foreground">{c.id}</span>
                      <span className="text-sm font-medium">{pick(lang, c.label)}</span>
                      {c.critical ? (
                        <span className="rounded border border-border px-1 py-px text-[9px] uppercase tracking-[0.1em] text-muted-foreground">{t("kritis", "critical")}</span>
                      ) : null}
                    </div>
                    <div className={cn("text-xs", c.status === "fail" ? "text-destructive" : "text-muted-foreground")}>{pick(lang, c.detail)}</div>
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="space-y-3 lg:border-l lg:border-border/70 lg:pl-6">
            <h3 className="eyebrow">{t("Coverage per sumber", "Coverage by source")}</h3>
            <ul className="space-y-3">
              {report.coverage.map((src) => {
                // Relatif terhadap waktu laporan dibuat, bukan Date.now(): render harus murni.
                const age = src.lastSeenAt ? (new Date(report.generatedAt).getTime() - new Date(src.lastSeenAt).getTime()) / 60000 : null;
                const alive = age == null ? null : age <= 60;
                return (
                  <li key={src.source} className="text-xs">
                    <div className="flex items-center gap-2">
                      {alive == null ? null : (
                        <span className={cn("size-1.5 rounded-full", alive ? "bg-[var(--positive)]" : "bg-destructive")} aria-hidden />
                      )}
                      <span className="font-medium text-foreground">{pick(lang, src.label)}</span>
                      {src.lastSeenAt ? (
                        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                          {age != null && age < 1
                            ? t("baru saja", "just now")
                            : t(`${Math.round(age ?? 0)} mnt lalu`, `${Math.round(age ?? 0)} min ago`)}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{pick(lang, src.figure)}</div>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
