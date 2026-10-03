import { ExternalLink, RefreshCw, Sparkles, TriangleAlert } from "lucide-react";
import { ControlForm } from "@/components/control-form";
import { fmtIdr, fmtInt, fmtPct, fmtProb, fmtSigned } from "@/lib/format";
import { buildPostHogVerdict, exposureGap, type PostHogMetricResult, type PostHogStatus } from "@/lib/posthog-results";
import { cn } from "@/lib/utils";
import { intlLocale, pick, tr, type Lang } from "@/lib/i18n";

/**
 * Acuan PostHog, berdampingan dengan hasil lokal.
 *
 * Dua mesin statistik membaca aliran event yang sama: lokal (z-test + posterior
 * Beta, revenue Welch) dan PostHog (Bayesian default). Panel ini tidak memilih
 * salah satu; ia menampilkan keduanya supaya ketidaksepakatan terlihat — dan
 * ketidaksepakatan hampir selalu berarti pipeline, bukan desain, yang bermasalah.
 */
export function PostHogPanel({
  experimentId,
  status,
  bridgeError,
  localVisitorsA,
  localVisitorsB,
  localPrimary,
  localOrdersA = 0,
  localOrdersB = 0,
  isAdmin,
  lang,
}: {
  experimentId: string;
  status: PostHogStatus | null;
  bridgeError: string | null;
  localVisitorsA: number;
  localVisitorsB: number;
  localPrimary: { valueA: number; valueB: number; upliftRelative: number; significant: boolean } | null;
  /** order dibayar per variant (lokal) — dibandingkan dengan ambang 5 milik PostHog */
  localOrdersA?: number;
  localOrdersB?: number;
  isAdmin: boolean;
  lang: Lang;
}) {
  const t = tr(lang);
  const locale = intlLocale(lang);
  if (!status) {
    return (
      <Section title={t("Acuan PostHog", "PostHog reference")} lang={lang}>
        <Note tone="warning">
          {t("Tidak bisa membaca status PostHog dari app Shopify.", "Couldn't read the PostHog status from the Shopify app.")}
          {bridgeError ? ` ${bridgeError}` : ""}{" "}
          {t("Angka lokal di halaman ini tidak terpengaruh.", "The local numbers on this page are unaffected.")}
        </Note>
      </Section>
    );
  }

  if (!status.configured) {
    return (
      <Section title={t("Acuan PostHog", "PostHog reference")} lang={lang}>
        <Note tone="neutral">
          {t("Experiments API PostHog belum dikonfigurasi di app Fly.io. Isi", "The PostHog Experiments API isn't configured in the Fly.io app yet. Set")}{" "}
          <code className="font-mono text-foreground">POSTHOG_PERSONAL_API_KEY</code>,{" "}
          <code className="font-mono text-foreground">POSTHOG_PROJECT_ID</code>, {t("dan", "and")}{" "}
          <code className="font-mono text-foreground">POSTHOG_PROJECT_TOKEN</code>{" "}
          {t("lalu jalankan ulang eksperimen.", "then restart the experiment.")}
          {status.captureConfigured
            ? t(
                " Event sudah dikirim ke PostHog, hanya cermin eksperimennya yang belum dibuat.",
                " Events are already being sent to PostHog; only the mirrored experiment hasn't been created.",
              )
            : t(" Saat ini tidak ada event yang dikirim ke PostHog.", " No events are being sent to PostHog right now.")}
        </Note>
      </Section>
    );
  }

  const verdict = buildPostHogVerdict(status.results, status);
  const gap = exposureGap(localVisitorsA, localVisitorsB, status.results);
  const primary = verdict.primary;

  const disagree =
    primary && localPrimary && primary.significant != null
      ? primary.significant !== localPrimary.significant ||
        (primary.upliftRelative != null && Math.sign(primary.upliftRelative) !== Math.sign(localPrimary.upliftRelative) && primary.significant)
      : false;

  return (
    <Section
      title={t("Acuan PostHog", "PostHog reference")}
      lang={lang}
      aside={
        <div className="flex flex-wrap items-center gap-2">
          {status.status ? <RemoteStatus status={status.status} lang={lang} /> : null}
          {status.url ? (
            <a
              href={status.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
            >
              {t("Buka di PostHog", "Open in PostHog")}
              <ExternalLink className="size-3" />
            </a>
          ) : null}
        </div>
      }
    >
      {status.syncError ? (
        <Note tone="warning">
          {t("Sinkronisasi terakhir gagal:", "Last sync failed:")} {status.syncError}{" "}
          {t("Eksperimen lokal tetap berjalan normal; tekan", "The local experiment keeps running normally; press")}{" "}
          <span className="text-foreground">{t("Sinkronkan", "Sync")}</span>{" "}
          {t("setelah penyebabnya diperbaiki.", "once the cause is fixed.")}
        </Note>
      ) : null}

      {status.outboxPending > 0 ? (
        <Note tone="warning">
          {t(
            `${fmtInt(status.outboxPending)} event belum sampai ke PostHog`,
            `${fmtInt(status.outboxPending)} events haven't reached PostHog yet`,
          )}
          {status.outboxOldestPendingAt
            ? t(
                ` (tertua sejak ${new Date(status.outboxOldestPendingAt).toLocaleString(locale)})`,
                ` (oldest since ${new Date(status.outboxOldestPendingAt).toLocaleString(locale)})`,
              )
            : ""}
          .{" "}
          {t(
            "Angka PostHog akan tertinggal dari angka lokal sampai antrean ini kosong.",
            "PostHog's numbers will lag the local ones until this queue is empty.",
          )}
        </Note>
      ) : null}

      <div
        className={cn(
          "rounded-lg border p-4",
          verdict.kind === "b_wins" && "border-[var(--variant-b)]/40",
          verdict.kind === "a_wins" && "border-[var(--variant-a)]/40",
          verdict.kind === "invalid" && "border-destructive/40",
        )}
      >
        <div className="flex items-center gap-2 text-sm font-medium">
          <Sparkles className="size-4 text-muted-foreground" />
          {pick(lang, verdict.headline)}
        </div>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{pick(lang, verdict.detail)}</p>
        {verdict.kind === "invalid" ? (
          <p className="mt-2 font-mono text-xs text-muted-foreground">
            {t(
              `Order per variant saat ini: A ${fmtInt(localOrdersA)} · B ${fmtInt(localOrdersB)} — PostHog mulai menghitung begitu keduanya ≥ 5.`,
              `Orders per variant so far: A ${fmtInt(localOrdersA)} · B ${fmtInt(localOrdersB)} — PostHog starts calculating once both are ≥ 5.`,
            )}
          </p>
        ) : null}
        {disagree ? (
          <p className="mt-2 flex gap-2 text-sm text-amber-600 dark:text-amber-400">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>
              {t(
                "PostHog dan perhitungan lokal tidak sepakat soal metric utama. Jangan ambil keputusan sebelum tahu kenapa: cek antrean event, selisih pengunjung terpapar di bawah, dan apakah PostHog mengecualikan pengunjung yang terpapar dua variant.",
                "PostHog and the local calculation disagree on the primary metric. Don't decide anything until you know why: check the event queue, the exposed-visitor gap below, and whether PostHog excludes visitors exposed to both variants.",
              )}
            </span>
          </p>
        ) : null}
      </div>

      {status.results && status.results.metrics.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="pb-2 font-medium">Metric</th>
                <th className="pb-2 text-right font-medium text-[var(--variant-a)]">A</th>
                <th className="pb-2 text-right font-medium text-[var(--variant-b)]">B</th>
                <th className="pb-2 text-right font-medium">{t("Selisih (interval 95%)", "Difference (95% interval)")}</th>
                <th className="pb-2 text-right font-medium">{t("P(B lebih baik)", "P(B is better)")}</th>
              </tr>
            </thead>
            <tbody>
              {status.results.metrics.map((m) => (
                <MetricRow key={m.uuid} m={m} lang={lang} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <dl className="grid gap-2 border-t pt-3 text-xs text-muted-foreground sm:grid-cols-2">
        <div>
          <dt className="font-medium text-foreground">{t("Pengunjung terpapar: lokal vs PostHog", "Exposed visitors: local vs PostHog")}</dt>
          <dd className="mt-0.5 font-mono tabular-nums">
            A {fmtInt(localVisitorsA)} / {gap.a != null ? fmtInt(gap.a) : "—"}
            {gap.ratioA != null ? ` (${(gap.ratioA * 100).toFixed(0)}%)` : ""}
            {" · "}B {fmtInt(localVisitorsB)} / {gap.b != null ? fmtInt(gap.b) : "—"}
            {gap.ratioB != null ? ` (${(gap.ratioB * 100).toFixed(0)}%)` : ""}
          </dd>
        </div>
        <div>
          <dt className="font-medium text-foreground">{t("Perhitungan PostHog", "PostHog calculation")}</dt>
          <dd className="mt-0.5">
            {status.results?.computedAt
              ? `${status.results.status} · ${new Date(status.results.computedAt).toLocaleString(locale)}`
              : t("belum pernah dihitung", "never calculated")}
            {status.exposureEvent ? ` · exposure: ${status.exposureEvent}` : ""}
            {status.flagKey ? ` · flag: ${status.flagKey}` : ""}
            {status.status === "running"
              ? t(" · dihitung ulang otomatis tiap ±10 menit", " · recalculated automatically every ~10 minutes")
              : ""}
          </dd>
        </div>
      </dl>

      {isAdmin ? (
        <div className="flex flex-wrap gap-2 border-t pt-3">
          <ControlForm experimentId={experimentId} action="posthog.sync" label={t("Sinkronkan", "Sync")} variant="outline" size="sm" className="w-auto" />
          <ControlForm
            experimentId={experimentId}
            action="posthog.recalculate"
            label={t("Hitung ulang di PostHog", "Recalculate in PostHog")}
            variant="ghost"
            size="sm"
            disabled={!status.linked}
            className="w-auto"
          />
        </div>
      ) : null}
    </Section>
  );
}

function MetricRow({ m, lang }: { m: PostHogMetricResult; lang: Lang }) {
  const t = tr(lang);
  const format = m.meta?.format ?? "pct";
  const show = (v: number | null) => (v == null ? "—" : format === "money" ? fmtIdr(v) : fmtPct(v));
  const failures = [...(m.baseline?.validationFailures ?? []), ...(m.test?.validationFailures ?? [])];
  return (
    <tr className="border-t">
      <td className="py-2 pr-2">
        <div className="flex items-center gap-2">
          <span>{m.name}</span>
          {m.primary ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {t("utama", "primary")}
            </span>
          ) : null}
        </div>
        {m.error ? <div className="text-xs text-destructive">{m.error}</div> : null}
        {failures.length > 0 ? <div className="text-xs text-muted-foreground">{failures.join(", ")}</div> : null}
      </td>
      <td className="py-2 text-right font-mono tabular-nums">{show(m.baseline?.value ?? null)}</td>
      <td className="py-2 text-right font-mono tabular-nums">{show(m.test?.value ?? null)}</td>
      <td
        className={cn(
          "py-2 text-right font-mono tabular-nums",
          m.significant === true && (m.upliftRelative ?? 0) > 0 && "text-[var(--positive)]",
          m.significant === true && (m.upliftRelative ?? 0) < 0 && "text-destructive",
        )}
      >
        {m.upliftRelative != null ? fmtSigned(m.upliftRelative) : "—"}
        {m.intervalLow != null && m.intervalHigh != null ? (
          <span className="ml-1 text-xs text-muted-foreground">
            [{fmtSigned(m.intervalLow)}, {fmtSigned(m.intervalHigh)}]
          </span>
        ) : null}
      </td>
      <td className="py-2 text-right font-mono tabular-nums">
        {m.chanceToWin != null ? fmtProb(m.chanceToWin) : m.pValue != null ? `p=${m.pValue.toFixed(3)}` : "—"}
      </td>
    </tr>
  );
}

function RemoteStatus({ status, lang }: { status: string; lang: Lang }) {
  const t = tr(lang);
  const label: Record<string, string> = {
    draft: t("draft di PostHog", "draft in PostHog"),
    running: t("berjalan di PostHog", "running in PostHog"),
    paused: t("dijeda di PostHog", "paused in PostHog"),
    exposure_frozen: t("exposure dibekukan", "exposure frozen"),
    stopped: t("selesai di PostHog", "stopped in PostHog"),
  };
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
      <RefreshCw className="size-3" />
      {label[status] ?? status}
    </span>
  );
}

function Section({
  title,
  aside,
  lang,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  lang: Lang;
  children: React.ReactNode;
}) {
  const t = tr(lang);
  return (
    <section className="space-y-4 surface rounded-2xl p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t(
              "Mesin statistik kedua atas aliran event yang sama. Sepakat = keputusan lebih kuat; tidak sepakat = periksa pipeline sebelum menyimpulkan apa pun.",
              "A second stats engine over the same event stream. Agreement = a stronger decision; disagreement = check the pipeline before concluding anything.",
            )}
          </p>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Note({ tone, children }: { tone: "warning" | "neutral"; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "rounded-lg border p-3 text-sm leading-relaxed",
        tone === "warning" ? "border-amber-500/30 bg-amber-500/8 text-foreground/80" : "border-border text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}
