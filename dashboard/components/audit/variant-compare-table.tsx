import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import { relDelta } from "./audit-format";

export interface CompareRow {
  label: string;
  hint?: string;
  a: number | null;
  b: number | null;
  format: (v: number | null) => string;
  /** arah yang diinginkan; "none" = netral (tidak diwarnai) */
  goal: "increase" | "decrease" | "none";
}

/**
 * Tabel A vs B dengan selisih relatif.
 *
 * Warna hanya dipakai kalau arah "lebih baik"-nya jelas (goal), dan selalu
 * disertai panah + angka supaya warna bukan satu-satunya pembeda.
 */
export function VariantCompareTable({ rows, caption }: { rows: CompareRow[]; caption?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead className="text-left text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
          <tr>
            <th scope="col" className="pb-2 font-medium">
              Metric
            </th>
            <th scope="col" className="pb-2 text-right font-medium text-[var(--variant-a)]">
              A
            </th>
            <th scope="col" className="pb-2 text-right font-medium text-[var(--variant-b)]">
              B
            </th>
            <th scope="col" className="pb-2 text-right font-medium">
              B vs A
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const delta = relDelta(row.a, row.b);
            const better =
              delta == null || row.goal === "none" || Math.abs(delta) < 0.005
                ? null
                : row.goal === "increase"
                  ? delta > 0
                  : delta < 0;
            const Icon = delta == null || Math.abs(delta) < 0.005 ? Minus : delta > 0 ? ArrowUpRight : ArrowDownRight;
            return (
              <tr key={row.label} className="border-t transition-colors duration-200 hover:bg-accent/40">
                <th scope="row" className="py-2 pr-3 text-left font-normal">
                  <div>{row.label}</div>
                  {row.hint ? <div className="text-xs text-muted-foreground">{row.hint}</div> : null}
                </th>
                <td className="py-2 text-right font-mono tabular-nums">{row.format(row.a)}</td>
                <td className="py-2 text-right font-mono tabular-nums">{row.format(row.b)}</td>
                <td
                  className={cn(
                    "py-2 text-right font-mono tabular-nums",
                    better === true && "text-[var(--positive)]",
                    better === false && "text-destructive",
                    better === null && "text-muted-foreground",
                  )}
                >
                  <span className="inline-flex items-center gap-1">
                    <Icon className="size-3.5" aria-hidden />
                    {delta == null ? "—" : `${delta > 0 ? "+" : ""}${(delta * 100).toFixed(1)}%`}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
