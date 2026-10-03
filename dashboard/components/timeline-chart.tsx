"use client";

import { useMemo } from "react";
import { Area, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { normalQuantile } from "@/lib/stats";
import { intlLocale } from "@/lib/i18n";
import { useLang, useT } from "@/components/lang-provider";

export interface DailyRow {
  date: string;
  variant: string;
  visitors: number;
  orders: number;
}

const configFor = (t: (id: string, en: string) => string) =>
  ({
    cvrA: { label: t("A (kontrol)", "A (control)"), color: "var(--variant-a)" },
    cvrB: { label: t("B (variant)", "B (variant)"), color: "var(--variant-b)" },
  }) satisfies ChartConfig;

/**
 * Conversion rate kumulatif per hari, bukan per hari terpisah.
 *
 * Angka harian terlalu berisik untuk dibaca — pada 1.800 sesi/hari, satu order
 * lebih atau kurang menggeser garisnya secara mencolok. Kurva kumulatif
 * menunjukkan hal yang sebenarnya ingin dilihat: apakah selisih antar variant
 * stabil dan menyempit, atau masih berayun tak menentu.
 *
 * Pita di sekeliling garis B adalah interval kepercayaan 95% untuk B, yang
 * menyempit seiring bertambahnya sample. Selama pita itu masih memuat garis A,
 * belum ada yang bisa disimpulkan.
 */
export function TimelineChart({ daily }: { daily: DailyRow[] }) {
  const lang = useLang();
  const t = useT();
  const config = useMemo(() => configFor(t), [t]);
  const locale = intlLocale(lang);
  const data = useMemo(() => {
    // Dikelompokkan dulu per tanggal; memfilter ulang di dalam loop membuatnya
    // kuadratik, dan test yang berjalan dua bulan menghasilkan ratusan baris.
    const byDate = new Map<string, { nA: number; xA: number; nB: number; xB: number }>();
    for (const row of daily) {
      const entry = byDate.get(row.date) ?? { nA: 0, xA: 0, nB: 0, xB: 0 };
      if (row.variant === "A") {
        entry.nA += row.visitors;
        entry.xA += row.orders;
      } else if (row.variant === "B") {
        entry.nB += row.visitors;
        entry.xB += row.orders;
      }
      byDate.set(row.date, entry);
    }

    const zCrit = normalQuantile(0.975);
    const rows: Array<{
      date: string;
      cvrA: number | null;
      cvrB: number | null;
      bandB: [number, number] | null;
    }> = [];

    let nA = 0;
    let xA = 0;
    let nB = 0;
    let xB = 0;

    for (const date of [...byDate.keys()].sort()) {
      const entry = byDate.get(date)!;
      nA += entry.nA;
      xA += entry.xA;
      nB += entry.nB;
      xB += entry.xB;

      const cvrA = nA > 0 ? xA / nA : null;
      const cvrB = nB > 0 ? xB / nB : null;
      const seB = nB > 0 && cvrB !== null ? Math.sqrt((cvrB * (1 - cvrB)) / nB) : 0;

      rows.push({
        date,
        cvrA,
        cvrB,
        bandB: cvrB !== null ? [Math.max(0, cvrB - zCrit * seB), cvrB + zCrit * seB] : null,
      });
    }

    return rows;
  }, [daily]);

  if (data.length < 2) {
    return (
      <div className="flex h-[280px] items-center justify-center rounded-xl border border-dashed text-sm text-muted-foreground">
        {t("Grafik muncul setelah ada data minimal dua hari.", "The chart appears once there are at least two days of data.")}
      </div>
    );
  }

  return (
    <ChartContainer config={config} className="h-[280px] w-full">
      <ComposedChart data={data} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={28}
          tickFormatter={(v: string) =>
            new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(new Date(v))
          }
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          width={48}
          tickFormatter={(v: number) => `${(v * 100).toFixed(1)}%`}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(v) =>
                new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(String(v)))
              }
              formatter={(value, name) => {
                if (name === "bandB" || typeof value !== "number") return null;
                return (
                  <span className="font-mono tabular-nums">
                    {config[name as keyof typeof config]?.label}: {(value * 100).toFixed(2)}%
                  </span>
                );
              }}
            />
          }
        />
        <Area
          dataKey="bandB"
          stroke="none"
          fill="var(--variant-b)"
          fillOpacity={0.14}
          isAnimationActive={false}
          connectNulls
        />
        <Line
          dataKey="cvrA"
          stroke="var(--variant-a)"
          strokeWidth={2}
          dot={false}
          connectNulls
          isAnimationActive={false}
        />
        {/* Garis putus-putus: variant B tetap bisa dibedakan tanpa mengandalkan warna. */}
        <Line
          dataKey="cvrB"
          stroke="var(--variant-b)"
          strokeWidth={2}
          strokeDasharray="5 4"
          dot={false}
          connectNulls
          isAnimationActive={false}
        />
      </ComposedChart>
    </ChartContainer>
  );
}
