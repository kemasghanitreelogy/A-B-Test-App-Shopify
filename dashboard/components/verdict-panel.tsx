import { CalendarClock, Check, ChevronDown, Hourglass, Scale, ShieldAlert, TrendingDown, TrendingUp, Trophy, Users, X } from "lucide-react";
import type { ExperimentResults } from "@/lib/results";
import type { Verdict } from "@/lib/verdict";
import { fmtIdr, fmtInt, fmtPct, fmtSigned } from "@/lib/format";
import { CiPlot } from "@/components/ci-plot";
import { CountUp } from "@/components/count-up";
import { LiveIndicator } from "@/components/live-indicator";
import { cn } from "@/lib/utils";
import { intlLocale, tr, type Lang } from "@/lib/i18n";

type T = ReturnType<typeof tr>;

const TONE = {
  b: { accent: "var(--variant-b)" },
  a: { accent: "var(--variant-a)" },
  neutral: { accent: "var(--muted-foreground)" },
  critical: { accent: "var(--destructive)" },
} as const;

const ICON = {
  b_wins: Trophy,
  a_wins: Trophy,
  inconclusive: Scale,
  no_data: Hourglass,
  untrusted: ShieldAlert,
} as const;

const MIN_DAYS = 14;

/**
 * Panel keputusan untuk pembaca awam.
 *
 * Susunannya mengikuti tiga pertanyaan yang sebenarnya ditanyakan reviewer,
 * dalam urutan itu: (1) mana yang lebih baik, (2) seberapa yakin, (3) kapan boleh
 * disimpulkan. Angka mentah (pengunjung, pembelian) ditampilkan APA ADANYA di
 * kartu A dan B, karena "4 dari 339 orang membeli" jauh lebih mudah dipercaya
 * daripada "1,18%". Istilah statistik (interval kepercayaan, p-value) tetap ada,
 * tapi dilipat ke "Detail statistik" — dibutuhkan analis, tidak dibutuhkan
 * untuk membaca keputusan.
 */
export function VerdictPanel({
  verdict,
  results,
  requiredPerArm,
  renderedAt,
  startedAt,
  lang,
}: {
  verdict: Verdict;
  results: ExperimentResults;
  requiredPerArm: number;
  /** ISO string saat server merender; dipakai jam pada penanda Live */
  renderedAt: string;
  /** ISO string mulai eksperimen; dipakai memperkirakan sisa hari */
  startedAt?: string | null;
  lang: Lang;
}) {
  const t = tr(lang);
  const Icon = ICON[verdict.kind];
  const tone = TONE[verdict.tone];
  const primary = verdict.primary;

  const smallestArm = Math.min(results.A.visitors, results.B.visitors);
  const progress = requiredPerArm > 0 ? Math.min(100, (smallestArm / requiredPerArm) * 100) : 0;
  const sampleOk = requiredPerArm > 0 && smallestArm >= requiredPerArm;
  const daysOk = results.daysRunning >= MIN_DAYS;
  const dataOk = !results.srm?.mismatch && results.bucketDrift === 0 && verdict.kind !== "untrusted";

  // Perkiraan sisa hari dari laju pengunjung sejak mulai; di hari pertama laju
  // dihitung dari jam yang sudah berjalan supaya tidak membagi nol.
  const elapsedDays = startedAt ? Math.max(0.25, (Date.parse(renderedAt) - Date.parse(startedAt)) / 86_400_000) : Math.max(0.25, results.daysRunning);
  const totalVisitors = results.A.visitors + results.B.visitors;
  const perDay = totalVisitors / elapsedDays;
  const remainingVisitors = Math.max(0, requiredPerArm * 2 - totalVisitors);
  const daysForSample = perDay > 0 ? Math.ceil(remainingVisitors / perDay) : null;
  const daysForMinimum = Math.max(0, MIN_DAYS - Math.floor(elapsedDays));
  const daysLeft = daysForSample == null ? null : Math.max(daysForSample, daysForMinimum);
  const finishDate =
    daysLeft != null
      ? new Intl.DateTimeFormat(intlLocale(lang), { day: "numeric", month: "long", timeZone: "Asia/Jakarta" }).format(new Date(Date.parse(renderedAt) + daysLeft * 86_400_000))
      : null;

  const plain = plainLanguage(verdict, results, t);
  const counts = primary ? countsFor(primary.key, results, t) : null;

  return (
    <section
      className="surface reveal relative overflow-hidden rounded-3xl"
      style={{ borderColor: `color-mix(in oklab, ${tone.accent} 30%, var(--border))` }}
    >
      <div className="grid-backdrop pointer-events-none absolute inset-0" aria-hidden />
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden
        style={{
          background: `radial-gradient(ellipse 55% 70% at 100% 0%, color-mix(in oklab, ${tone.accent} 16%, transparent), transparent 70%)`,
        }}
      />
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-px"
        aria-hidden
        style={{ background: `linear-gradient(90deg, transparent, ${tone.accent}, transparent)`, opacity: 0.7 }}
      />

      <div className="relative space-y-7 p-5 sm:p-8">
        {/* ---- 1. Keputusan, dalam bahasa sehari-hari ---- */}
        <div className="flex flex-wrap items-start gap-4">
          <span
            className="flex size-12 shrink-0 items-center justify-center rounded-2xl"
            style={{
              background: `color-mix(in oklab, ${tone.accent} 14%, transparent)`,
              color: tone.accent,
              boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${tone.accent} 35%, transparent)`,
            }}
          >
            <Icon className="size-6" />
          </span>
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">{plain.headline}</h2>
              <StatusChip verdict={verdict} t={t} />
              <LiveIndicator renderedAt={renderedAt} className="ml-auto" />
            </div>
            <p className="max-w-3xl text-base leading-relaxed text-foreground/85">{plain.summary}</p>
          </div>
        </div>

        {/* ---- 2. Dua desain berdampingan, angka apa adanya ---- */}
        {primary && counts ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <ArmCard
              index={0}
              name="A"
              title={t("Desain lama", "Original design")}
              color="var(--variant-a)"
              value={primary.valueA}
              format={primary.format}
              metricLabel={verdict.metricLabel}
              counts={counts.a}
              winner={verdict.winner === "A"}
              leading={!verdict.winner && verdict.kind === "a_wins"}
              t={t}
            />
            <ArmCard
              index={1}
              name="B"
              title={t("Desain baru", "New design")}
              color="var(--variant-b)"
              value={primary.valueB}
              format={primary.format}
              metricLabel={verdict.metricLabel}
              counts={counts.b}
              winner={verdict.winner === "B"}
              leading={!verdict.winner && verdict.kind === "b_wins"}
              delta={primary.upliftRelative}
              deltaCertain={primary.significant}
              t={t}
            />
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            {t("Belum ada cukup pengunjung untuk membandingkan kedua desain.", "Not enough visitors yet to compare the two designs.")}
          </div>
        )}

        {/* ---- 3. Seberapa yakin & kapan boleh disimpulkan ---- */}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="reveal rounded-2xl border border-border/70 bg-background/40 p-5" style={{ "--i": 3 } as React.CSSProperties}>
            <h3 className="eyebrow">{t("Seberapa yakin B lebih baik?", "How sure are we that B is better?")}</h3>
            {primary ? (
              <>
                <div className="mt-2 flex items-baseline gap-2">
                  <CountUp
                    value={primary.probBBeatsA}
                    kind="prob"
                    className={cn(
                      "stat-figure text-4xl font-semibold",
                      primary.significant && primary.probBBeatsA >= 0.95
                        ? "text-glow-positive"
                        : primary.significant && primary.probBBeatsA <= 0.05
                          ? "text-glow-negative"
                          : primary.probBBeatsA > 0.5
                            ? "text-[var(--positive)]"
                            : primary.probBBeatsA < 0.5
                              ? "text-destructive"
                              : "text-foreground",
                    )}
                  />
                  <span className="text-sm text-muted-foreground">{t("peluang B benar-benar lebih baik", "chance B is truly better")}</span>
                </div>
                <ConfidenceMeter value={primary.probBBeatsA} t={t} />
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{confidenceSentence(primary.probBBeatsA, primary.significant, t)}</p>
              </>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">{t("Belum bisa dihitung.", "Can't be calculated yet.")}</p>
            )}
          </div>

          <div className="reveal rounded-2xl border border-border/70 bg-background/40 p-5" style={{ "--i": 4 } as React.CSSProperties}>
            <h3 className="eyebrow">{t("Kapan boleh disimpulkan?", "When can we conclude?")}</h3>
            <ul className="mt-3 space-y-2.5">
              <Requirement
                ok={sampleOk}
                icon={Users}
                label={t("Cukup pengunjung", "Enough visitors")}
                detail={t(
                  `${fmtInt(smallestArm)} dari ${fmtInt(requiredPerArm)} per desain`,
                  `${fmtInt(smallestArm)} of ${fmtInt(requiredPerArm)} per design`,
                )}
                t={t}
              >
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="bar-grow h-full rounded-full"
                    style={{
                      width: `${Math.max(progress, 0.5)}%`,
                      background: sampleOk ? "var(--positive)" : "linear-gradient(90deg, var(--primary), color-mix(in oklab, var(--primary) 60%, var(--positive)))",
                    }}
                  />
                </div>
              </Requirement>
              <Requirement
                ok={daysOk}
                icon={CalendarClock}
                label={t(`Sudah berjalan ${MIN_DAYS} hari`, `Ran for ${MIN_DAYS} days`)}
                detail={
                  daysOk
                    ? t(`hari ke-${results.daysRunning}`, `day ${results.daysRunning}`)
                    : t(
                        `hari ke-${results.daysRunning} · ${MIN_DAYS - results.daysRunning} hari lagi`,
                        `day ${results.daysRunning} · ${MIN_DAYS - results.daysRunning} days to go`,
                      )
                }
                t={t}
              />
              <Requirement
                ok={dataOk}
                icon={ShieldAlert}
                label={t("Data sehat", "Healthy data")}
                detail={dataOk ? t("pembagian grup normal", "group split is normal") : t("ada masalah pada pembagian grup", "group split has a problem")}
                t={t}
              />
            </ul>
            <p className="mt-4 border-t border-border/70 pt-3 text-sm text-muted-foreground">
              {sampleOk && daysOk ? (
                <>{t("Syarat terpenuhi — keputusan di atas sudah boleh dipakai.", "Requirements met — the decision above can be used.")}</>
              ) : daysLeft != null ? (
                <>
                  {t("Perkiraan bisa disimpulkan sekitar", "Expected to be conclusive around")}{" "}
                  <span className="font-medium text-foreground">{finishDate}</span>{" "}
                  <span className="font-mono text-xs">(±{daysLeft} {t("hari", "days")})</span>{" "}
                  {t("pada laju pengunjung saat ini.", "at the current visitor rate.")}
                </>
              ) : (
                <>{t("Perkiraan muncul setelah ada pengunjung.", "An estimate appears once there are visitors.")}</>
              )}
            </p>
          </div>
        </div>

        {/* ---- 4. Statistik, dilipat ---- */}
        {primary ? (
          <details className="group rounded-2xl border border-border/70 bg-background/30">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-muted-foreground transition-colors duration-200 hover:text-foreground [&::-webkit-details-marker]:hidden">
              <ChevronDown className="size-4 transition-transform duration-200 group-open:rotate-180" aria-hidden />
              {t("Detail statistik", "Statistical details")}
              <span className="ml-auto font-mono text-[11px] font-normal">
                uplift{" "}
                <span className={primary.upliftRelative > 0 ? "text-[var(--positive)]" : primary.upliftRelative < 0 ? "text-destructive" : undefined}>
                  {fmtSigned(primary.upliftRelative)}
                </span>{" "}
                · p {primary.pValue.toFixed(4)}
              </span>
            </summary>
            <div className="grid gap-5 border-t border-border/70 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_240px]">
              <div className="space-y-2">
                <div className="text-xs text-muted-foreground">
                  {t(
                    `Interval kepercayaan 95% untuk selisih ${verdict.metricLabel.toLowerCase()} (B dibanding A). Selama batangnya menyentuh garis nol, selisihnya masih bisa terjadi karena kebetulan.`,
                    `95% confidence interval for the difference in ${verdict.metricLabel.toLowerCase()} (B vs A). As long as the bar touches the zero line, the difference could still be chance.`,
                  )}
                </div>
                <CiPlot
                  low={primary.ciLow}
                  high={primary.ciHigh}
                  point={primary.upliftRelative}
                  domain={Math.max(0.1, Math.max(Math.abs(primary.ciLow), Math.abs(primary.ciHigh)) * 1.25)}
                  lang={lang}
                />
                <div className="flex justify-between font-mono text-[11px] text-muted-foreground">
                  <span>{fmtSigned(primary.ciLow)}</span>
                  <span>0</span>
                  <span>{fmtSigned(primary.ciHigh)}</span>
                </div>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-1">
                <Stat
                  label={t("Uplift relatif", "Relative uplift")}
                  value={fmtSigned(primary.upliftRelative)}
                  className={primary.upliftRelative > 0 ? "text-[var(--positive)]" : primary.upliftRelative < 0 ? "text-destructive" : undefined}
                />
                <Stat label="p-value" value={primary.pValue.toFixed(4)} hint={primary.significant ? t("signifikan (< 0,05)", "significant (< 0.05)") : t("belum signifikan", "not significant yet")} />
                <Stat label="P(B > A)" value={fmtPct(primary.probBBeatsA, 1)} />
                <Stat label={t("Pengunjung", "Visitors")} value={`${fmtInt(results.A.visitors)} · ${fmtInt(results.B.visitors)}`} hint="A · B" />
              </dl>
            </div>
          </details>
        ) : null}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------------- */

function plainLanguage(verdict: Verdict, results: ExperimentResults, t: T): { headline: string; summary: string } {
  const p = verdict.primary;
  const metric = verdict.metricLabel.toLowerCase();
  const magnitude = p ? `${Math.abs(p.upliftRelative * 100).toFixed(1)}%` : "";
  switch (verdict.kind) {
    case "untrusted":
      return { headline: verdict.headline, summary: verdict.detail };
    case "no_data":
      return {
        headline: t("Menunggu pengunjung", "Waiting for visitors"),
        summary: t(
          "Belum ada cukup orang yang melihat halaman ini untuk membandingkan desain lama dan desain baru.",
          "Not enough people have seen this page yet to compare the original and new designs.",
        ),
      };
    case "inconclusive":
      return {
        headline: t("Belum ada pemenang", "No winner yet"),
        summary: results.readyToConclude
          ? t(
              `Setelah sample dan waktu yang cukup, ${metric} desain baru dan desain lama praktis sama. Kedua desain setara — tidak ada alasan mengganti yang sekarang.`,
              `With enough sample and time, the new and original designs have practically the same ${metric}. They're equivalent — no reason to replace the current one.`,
            )
          : t(
              `Sejauh ini ${metric} desain baru dan desain lama hampir sama. Selisih sekecil ini masih bisa terjadi karena kebetulan, jadi belum boleh ditarik kesimpulan. Biarkan test terus berjalan.`,
              `So far the new and original designs have nearly the same ${metric}. A gap this small could still be chance, so no conclusion yet. Let the test keep running.`,
            ),
      };
    case "b_wins":
      return verdict.final
        ? {
            headline: t("Desain baru menang", "New design wins"),
            summary: t(
              `Desain baru menghasilkan ${metric} ${magnitude} lebih tinggi dari desain lama, dan selisih ini bukan kebetulan. Aman untuk dipakai ke semua pengunjung.`,
              `The new design delivers ${magnitude} higher ${metric} than the original, and the gap isn't chance. Safe to roll out to all visitors.`,
            ),
          }
        : {
            headline: t("Desain baru memimpin — belum pasti", "New design is leading — not certain yet"),
            summary: t(
              `Sementara ini desain baru unggul ${magnitude} pada ${metric}, tapi sample belum cukup untuk memastikan itu bukan kebetulan. Jangan diputuskan dulu.`,
              `For now the new design is ahead by ${magnitude} on ${metric}, but the sample isn't big enough to rule out chance. Don't decide yet.`,
            ),
          };
    case "a_wins":
      return verdict.final
        ? {
            headline: t("Desain lama menang", "Original design wins"),
            summary: t(
              `Desain baru menghasilkan ${metric} ${magnitude} lebih rendah dari desain lama, dan selisih ini bukan kebetulan. Pertahankan desain yang sekarang.`,
              `The new design delivers ${magnitude} lower ${metric} than the original, and the gap isn't chance. Keep the current design.`,
            ),
          }
        : {
            headline: t("Desain lama memimpin — belum pasti", "Original design is leading — not certain yet"),
            summary: t(
              `Sementara ini desain lama unggul ${magnitude} pada ${metric}, tapi sample belum cukup untuk memastikan itu bukan kebetulan. Jangan diputuskan dulu.`,
              `For now the original design is ahead by ${magnitude} on ${metric}, but the sample isn't big enough to rule out chance. Don't decide yet.`,
            ),
          };
  }
}

function confidenceSentence(prob: number, significant: boolean, t: T): string {
  if (significant && prob >= 0.95)
    return t(
      "Hampir pasti desain baru lebih baik. Kalau test dihentikan sekarang, keputusannya bisa dipercaya.",
      "The new design is almost certainly better. If the test stopped now, the decision would hold up.",
    );
  if (significant && prob <= 0.05)
    return t(
      "Hampir pasti desain baru lebih buruk. Kalau test dihentikan sekarang, keputusannya bisa dipercaya.",
      "The new design is almost certainly worse. If the test stopped now, the decision would hold up.",
    );
  if (prob >= 0.8)
    return t(
      "Desain baru terlihat lebih baik, tapi masih ada kemungkinan cukup besar itu hanya kebetulan. Tunggu sample bertambah.",
      "The new design looks better, but there's still a real chance it's just luck. Wait for more sample.",
    );
  if (prob <= 0.2)
    return t(
      "Desain baru terlihat lebih buruk, tapi masih ada kemungkinan cukup besar itu hanya kebetulan. Tunggu sample bertambah.",
      "The new design looks worse, but there's still a real chance it's just luck. Wait for more sample.",
    );
  return t(
    "Sama seperti lempar koin: belum bisa dibedakan mana yang lebih baik. Ini normal di awal test.",
    "It's a coin flip: can't tell which is better yet. That's normal early in a test.",
  );
}

function countsFor(key: string, results: ExperimentResults, t: T): { a: string; b: string } {
  const line = (arm: ExperimentResults["A"]) => {
    switch (key) {
      case "atc_rate":
        return t(
          `${fmtInt(arm.addToCarts)} dari ${fmtInt(arm.visitors)} pengunjung masuk keranjang`,
          `${fmtInt(arm.addToCarts)} of ${fmtInt(arm.visitors)} visitors added to cart`,
        );
      case "rpv":
        return t(
          `${fmtIdr(arm.revenue)} dari ${fmtInt(arm.visitors)} pengunjung`,
          `${fmtIdr(arm.revenue)} from ${fmtInt(arm.visitors)} visitors`,
        );
      case "aov":
        return t(`${fmtIdr(arm.revenue)} dari ${fmtInt(arm.orders)} order`, `${fmtIdr(arm.revenue)} from ${fmtInt(arm.orders)} orders`);
      default:
        return t(
          `${fmtInt(arm.orders)} dari ${fmtInt(arm.visitors)} pengunjung membeli`,
          `${fmtInt(arm.orders)} of ${fmtInt(arm.visitors)} visitors bought`,
        );
    }
  };
  return { a: line(results.A), b: line(results.B) };
}

function StatusChip({ verdict, t }: { verdict: Verdict; t: T }) {
  const label =
    verdict.kind === "untrusted"
      ? t("Data rusak", "Bad data")
      : verdict.kind === "no_data"
        ? t("Menunggu", "Waiting")
        : verdict.final
          ? t("Final", "Final")
          : t("Sementara", "Provisional");
  const styles =
    verdict.kind === "untrusted"
      ? "border-destructive/30 bg-destructive/10 text-destructive"
      : verdict.final
        ? "border-[var(--positive)]/30 bg-[var(--positive)]/10 text-[var(--positive)]"
        : "border-border bg-muted/70 text-muted-foreground";
  return (
    <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-[0.1em] ${styles}`}>{label}</span>
  );
}

/**
 * Kartu satu desain. Angka besar = metric utama; baris di bawahnya = angka
 * mentah yang membentuknya, supaya pembaca bisa memeriksa sendiri.
 */
function ArmCard({
  index,
  name,
  title,
  color,
  value,
  format,
  metricLabel,
  counts,
  winner,
  leading,
  delta,
  deltaCertain = false,
  t,
}: {
  index: number;
  name: "A" | "B";
  title: string;
  color: string;
  value: number;
  format: "pct" | "idr";
  metricLabel: string;
  counts: string;
  winner: boolean;
  leading: boolean;
  /** hanya untuk B: selisih relatif terhadap A */
  delta?: number;
  /** warna hanya diberikan kalau selisihnya signifikan — warna = kepastian */
  deltaCertain?: boolean;
  t: T;
}) {
  return (
    <div
      className={cn("reveal relative overflow-hidden rounded-2xl border p-5", winner ? "bg-background/60" : "bg-background/40")}
      style={{
        "--i": index + 1,
        borderColor: winner || leading ? `color-mix(in oklab, ${color} 55%, var(--border))` : "var(--border)",
        boxShadow: winner ? `0 0 0 1px color-mix(in oklab, ${color} 35%, transparent), 0 20px 48px -28px ${color}` : undefined,
      } as React.CSSProperties}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-1" style={{ background: color, opacity: 0.9 }} aria-hidden />
      <div className="flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-lg text-xs font-semibold text-white" style={{ background: color }}>
          {name}
        </span>
        <span className="text-sm font-medium">{title}</span>
        {winner ? (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ background: `color-mix(in oklab, ${color} 18%, transparent)`, color }}>
            <Trophy className="size-3" aria-hidden /> {t("pemenang", "winner")}
          </span>
        ) : leading ? (
          <span className="ml-auto rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">{t("memimpin", "leading")}</span>
        ) : null}
      </div>
      <div className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {format === "idr" ? (
          <CountUp value={value} kind="idr" className="stat-figure text-4xl font-semibold sm:text-5xl" />
        ) : (
          <CountUp value={value} kind="pct" digits={2} className="stat-figure text-4xl font-semibold sm:text-5xl" />
        )}
        {delta != null && delta !== 0 ? (
          <span
            className={cn(delta > 0 ? "pill-positive" : "pill-negative", deltaCertain && "is-certain")}
            title={deltaCertain ? t("selisih signifikan — bisa dipercaya", "significant difference — reliable") : t("selisih sementara — belum signifikan", "provisional difference — not significant yet")}
          >
            {delta > 0 ? <TrendingUp className="size-3.5" aria-hidden /> : <TrendingDown className="size-3.5" aria-hidden />}
            {fmtSigned(delta)} vs A
            {!deltaCertain ? <span className="ml-1 text-[10px] font-medium uppercase tracking-[0.1em] opacity-70">{t("sementara", "provisional")}</span> : null}
          </span>
        ) : null}
      </div>
      <div className="mt-1 text-xs uppercase tracking-[0.12em] text-muted-foreground">{metricLabel}</div>
      <div className="mt-3 border-t border-border/70 pt-3 text-sm text-foreground/85">{counts}</div>
    </div>
  );
}

/**
 * Meter keyakinan dengan tiga zona berlabel kata, bukan angka: pembaca hanya
 * perlu melihat jarum ada di zona mana.
 */
function ConfidenceMeter({ value, t }: { value: number; t: T }) {
  const pct = Math.min(100, Math.max(0, value * 100));
  // Semakin jauh dari 50%, semakin pekat warnanya — ke merah di kiri (desain
  // baru lebih buruk), ke hijau di kanan (desain baru lebih baik).
  const lean = Math.abs(value - 0.5) * 2;
  const needle = value > 0.5 ? "var(--positive)" : value < 0.5 ? "var(--destructive)" : "var(--foreground)";
  return (
    <div className="mt-4">
      <div className="relative h-3 overflow-hidden rounded-full bg-muted" role="img" aria-label={t(`Peluang B lebih baik: ${pct.toFixed(0)} persen`, `Chance B is better: ${pct.toFixed(0)} percent`)}>
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(90deg, color-mix(in oklab, var(--destructive) 70%, transparent) 0%, color-mix(in oklab, var(--destructive) 18%, transparent) 30%, transparent 50%, color-mix(in oklab, var(--positive) 18%, transparent) 70%, color-mix(in oklab, var(--positive) 70%, transparent) 100%)",
          }}
        />
        <div className="absolute inset-y-0 left-[5%] w-px bg-background/60" aria-hidden />
        <div className="absolute inset-y-0 right-[5%] w-px bg-background/60" aria-hidden />
        <div
          className="absolute top-1/2 h-5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card transition-[left,background-color] duration-700"
          style={{ left: `${pct}%`, background: needle, boxShadow: `0 0 ${6 + lean * 14}px ${needle}` }}
        />
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] font-medium uppercase tracking-[0.1em]">
        <span className={value < 0.5 ? "text-destructive" : "text-muted-foreground"}>{t("B lebih buruk", "B is worse")}</span>
        <span className="text-muted-foreground">{t("belum bisa dibedakan", "too close to call")}</span>
        <span className={value > 0.5 ? "text-[var(--positive)]" : "text-muted-foreground"}>{t("B lebih baik", "B is better")}</span>
      </div>
    </div>
  );
}

function Requirement({
  ok,
  icon: Icon,
  label,
  detail,
  t,
  children,
}: {
  ok: boolean;
  icon: typeof Users;
  label: string;
  detail: string;
  t: T;
  children?: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-3">
      <span
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full",
          ok ? "bg-[var(--positive)]/15 text-[var(--positive)]" : "bg-muted text-muted-foreground",
        )}
        aria-label={ok ? t("terpenuhi", "met") : t("belum", "not yet")}
      >
        {ok ? <Check className="size-3" /> : <X className="size-3" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm">
          <Icon className="size-3.5 text-muted-foreground" aria-hidden />
          <span className={cn("font-medium", !ok && "text-foreground/85")}>{label}</span>
          <span className="ml-auto font-mono text-[11px] text-muted-foreground">{detail}</span>
        </div>
        {children}
      </div>
    </li>
  );
}

function Stat({ label, value, hint, className }: { label: string; value: string; hint?: string; className?: string }) {
  return (
    <div>
      <dt className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{label}</dt>
      <dd className={cn("stat-figure mt-0.5 text-base font-semibold", className)}>{value}</dd>
      {hint ? <div className="font-mono text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}
