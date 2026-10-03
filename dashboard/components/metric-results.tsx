import { Info } from "lucide-react";
import type { MetricTest } from "@/lib/verdict";
import { fmtIdr, fmtPct, fmtProb, fmtSigned } from "@/lib/format";
import { CiPlot, ciTone } from "@/components/ci-plot";
import { pick, tr, type Lang } from "@/lib/i18n";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const fmtValue = (v: number, format: "pct" | "idr") => (format === "idr" ? fmtIdr(v) : fmtPct(v, 2));

const STATUS = {
  positive: { label: { id: "B lebih baik", en: "B is better" }, className: "border-[var(--positive)]/30 bg-[var(--positive)]/10 text-[var(--positive)]" },
  negative: { label: { id: "A lebih baik", en: "A is better" }, className: "border-destructive/30 bg-destructive/10 text-destructive" },
  neutral: { label: { id: "Belum pasti", en: "Not yet clear" }, className: "border-border bg-muted text-muted-foreground" },
} as const;

/**
 * Keempat metric dalam satu tabel, dengan interval kepercayaannya digambar
 * pada sumbu yang sama.
 *
 * Menampilkan semuanya berdampingan justru MENGURANGI risiko p-hacking, bukan
 * menambahnya: ketika metric sekunder disembunyikan, orang tetap mencarinya satu
 * per satu dan hanya mengingat yang menang. Di sini terlihat sekaligus bahwa
 * metric non-utama sering menunjuk arah yang berbeda-beda — dan barisnya diberi
 * tanda bahwa ia tidak boleh menentukan keputusan.
 *
 * Kolom terakhir adalah gambar yang sama untuk semua baris, jadi panjang batang
 * bisa dibandingkan antar metric secara langsung.
 */
export function MetricResults({
  metrics,
  primaryMetric,
  lang,
}: {
  metrics: MetricTest[];
  primaryMetric: string;
  lang: Lang;
}) {
  const t = tr(lang);
  if (metrics.length === 0) {
    return (
      <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
        {t("Belum ada pengunjung yang cukup untuk menguji satu metric pun.", "Not enough visitors yet to test any metric.")}
      </p>
    );
  }

  const domain = Math.max(
    0.1,
    ...metrics.map((m) => Math.max(Math.abs(m.ciLow), Math.abs(m.ciHigh)) * 1.15),
  );
  const caveats = metrics.filter((m) => m.caveat);

  return (
    <div className="space-y-4">
      {/* Tabel lebar tidak boleh memaksa seluruh halaman ikut menggulir mendatar. */}
      <div className="-mx-1 overflow-x-auto px-1">
        <Table className="min-w-[760px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[190px]">Metric</TableHead>
              <TableHead className="text-right">A</TableHead>
              <TableHead className="text-right">B</TableHead>
              <TableHead className="text-right">Uplift</TableHead>
              <TableHead className="w-[200px]">
                <span className="flex items-center justify-between">
                  <span>−{(domain * 100).toFixed(0)}%</span>
                  <span className="font-normal normal-case text-muted-foreground">95% CI</span>
                  <span>+{(domain * 100).toFixed(0)}%</span>
                </span>
              </TableHead>
              <TableHead className="text-right">P(B&gt;A)</TableHead>
              <TableHead className="text-right">p</TableHead>
              <TableHead className="text-right">{t("Status", "Status")}</TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            {metrics.map((m) => {
              const isPrimary = m.key === primaryMetric;
              const status = STATUS[ciTone(m.ciLow, m.ciHigh)];

              return (
                <TableRow
                  key={m.key}
                  className={isPrimary ? "bg-muted/40 hover:bg-muted/60" : undefined}
                >
                  <TableCell className="relative">
                    {/* Penanda metric utama: batang tipis di tepi kiri baris, tidak
                        mengandalkan warna latar yang bisa hilang di light mode. */}
                    {isPrimary ? (
                      <span
                        className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary"
                        aria-hidden
                      />
                    ) : null}
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className={isPrimary ? "font-medium" : undefined}>{m.label}</span>
                      {isPrimary ? (
                        <span className="rounded border border-primary/30 bg-primary/10 px-1.5 py-px text-[10px] font-medium uppercase tracking-[0.08em] text-primary">
                          {t("utama", "primary")}
                        </span>
                      ) : null}
                      {m.caveat ? (
                        <Info className="size-3 text-muted-foreground" aria-label={t("lihat catatan", "see note")} />
                      ) : null}
                    </span>
                  </TableCell>

                  <TableCell className="text-right font-mono tabular-nums text-[var(--variant-a)]">
                    {fmtValue(m.valueA, m.format)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums text-[var(--variant-b)]">
                    {fmtValue(m.valueB, m.format)}
                  </TableCell>
                  <TableCell
                    className={`text-right font-mono font-medium tabular-nums ${
                      m.upliftRelative >= 0 ? "text-[var(--positive)]" : "text-destructive"
                    }`}
                  >
                    {fmtSigned(m.upliftRelative)}
                  </TableCell>

                  <TableCell>
                    <CiPlot
                      low={m.ciLow}
                      high={m.ciHigh}
                      point={m.upliftRelative}
                      domain={domain}
                      label={t(
                        `${m.label}: interval kepercayaan 95% dari ${fmtSigned(m.ciLow)} sampai ${fmtSigned(m.ciHigh)}`,
                        `${m.label}: 95% confidence interval from ${fmtSigned(m.ciLow)} to ${fmtSigned(m.ciHigh)}`,
                      )}
                      lang={lang}
                    />
                  </TableCell>

                  <TableCell className="text-right font-mono tabular-nums">
                    {fmtProb(m.probBBeatsA)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
                    {m.pValue < 0.0001 ? "<0.0001" : m.pValue.toFixed(4)}
                  </TableCell>
                  <TableCell className="text-right">
                    <span
                      className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium ${status.className}`}
                    >
                      {pick(lang, status.label)}
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {caveats.length > 0 ? (
        <ul className="space-y-1.5 border-t pt-3 text-xs leading-relaxed text-muted-foreground">
          {caveats.map((m) => (
            <li key={m.key} className="flex gap-2">
              <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
              <span>
                <span className="text-foreground/80">{m.label}:</span> {m.caveat}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
