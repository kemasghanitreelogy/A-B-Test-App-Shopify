import type { BreakdownRow } from "@/lib/posthog-analytics-types";
import { fmtInt } from "@/lib/format";
import { tr, type Lang } from "@/lib/i18n";

/**
 * Breakdown (device / negara) sebagai pangsa per variant.
 *
 * Yang dibandingkan adalah PANGSA di dalam masing-masing variant, bukan angka
 * absolut: split 50/50 pun tidak pernah persis, dan pangsa yang berbeda jauh
 * (mis. B lebih banyak mobile) adalah tanda bucketing tidak acak.
 */
export function BreakdownTable({
  rows,
  label,
  limit = 8,
  lang = "id",
}: {
  rows: BreakdownRow[];
  label: string;
  limit?: number;
  lang?: Lang;
}) {
  const t = tr(lang);
  const totalA = rows.filter((r) => r.variant === "A").reduce((s, r) => s + r.visitors, 0);
  const totalB = rows.filter((r) => r.variant === "B").reduce((s, r) => s + r.visitors, 0);
  const values = [...new Set(rows.map((r) => r.value))]
    .map((value) => {
      const a = rows.find((r) => r.variant === "A" && r.value === value)?.visitors ?? 0;
      const b = rows.find((r) => r.variant === "B" && r.value === value)?.visitors ?? 0;
      return { value, a, b, total: a + b };
    })
    .sort((x, y) => y.total - x.total)
    .slice(0, limit);

  if (values.length === 0) {
    return <p className="text-sm text-muted-foreground">
        {t(`Belum ada data ${label.toLowerCase()}.`, `No ${label.toLowerCase()} data yet.`)}
      </p>;
  }

  return (
    <table className="w-full text-sm">
      <thead className="text-left text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
        <tr>
          <th scope="col" className="pb-2 font-medium">
            {label}
          </th>
          <th scope="col" className="pb-2 text-right font-medium text-[var(--variant-a)]">
            A
          </th>
          <th scope="col" className="pb-2 text-right font-medium text-[var(--variant-b)]">
            B
          </th>
        </tr>
      </thead>
      <tbody>
        {values.map((row) => {
          const shareA = totalA > 0 ? row.a / totalA : 0;
          const shareB = totalB > 0 ? row.b / totalB : 0;
          return (
            <tr key={row.value} className="border-t">
              <th scope="row" className="py-1.5 pr-2 text-left font-normal">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 truncate">{row.value}</span>
                  <span className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
                    <span className="h-full bg-[var(--variant-a)]" style={{ width: `${shareA * 50}%` }} />
                    <span className="h-full bg-[var(--variant-b)]" style={{ width: `${shareB * 50}%` }} />
                  </span>
                </div>
              </th>
              <td className="py-1.5 text-right font-mono tabular-nums">
                {fmtInt(row.a)}
                <span className="ml-1 text-xs text-muted-foreground">{(shareA * 100).toFixed(0)}%</span>
              </td>
              <td className="py-1.5 text-right font-mono tabular-nums">
                {fmtInt(row.b)}
                <span className="ml-1 text-xs text-muted-foreground">{(shareB * 100).toFixed(0)}%</span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
