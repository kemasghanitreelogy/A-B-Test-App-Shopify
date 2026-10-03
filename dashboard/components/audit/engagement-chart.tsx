"use client";

import { useMemo } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import type { DailyEngagementRow } from "@/lib/posthog-analytics-types";
import { useT } from "@/components/lang-provider";

/** Pengunjung unik per hari per variant, dari pageview posthog-js. */
export function EngagementChart({ daily }: { daily: DailyEngagementRow[] }) {
  const t = useT();
  const config = {
    a: { label: t("A (kontrol)", "A (control)"), color: "var(--variant-a)" },
    b: { label: "B (variant)", color: "var(--variant-b)" },
  } satisfies ChartConfig;
  const data = useMemo(() => {
    const byDate = new Map<string, { date: string; a: number; b: number }>();
    for (const row of daily) {
      const entry = byDate.get(row.date) ?? { date: row.date, a: 0, b: 0 };
      if (row.variant === "A") entry.a += row.visitors;
      else entry.b += row.visitors;
      byDate.set(row.date, entry);
    }
    return [...byDate.values()].sort((x, y) => x.date.localeCompare(y.date));
  }, [daily]);

  if (data.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("Belum ada pageview dari storefront.", "No pageviews from the storefront yet.")}</p>;
  }

  return (
    <ChartContainer config={config} className="h-56 w-full">
      <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={(v: string) => v.slice(5)}
        />
        <YAxis tickLine={false} axisLine={false} width={36} allowDecimals={false} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Line type="monotone" dataKey="a" stroke="var(--color-a)" strokeWidth={2} dot={false} isAnimationActive={false} />
        <Line type="monotone" dataKey="b" stroke="var(--color-b)" strokeWidth={2} dot={false} strokeDasharray="5 4" isAnimationActive={false} />
      </LineChart>
    </ChartContainer>
  );
}
