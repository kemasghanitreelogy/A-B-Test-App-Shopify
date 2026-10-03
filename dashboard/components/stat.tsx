import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Stat({
  label,
  value,
  hint,
  tone = "default",
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "default" | "positive" | "negative" | "muted";
  className?: string;
}) {
  return (
    <div className={cn("surface rounded-2xl p-4 sm:p-5", className)}>
      <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "stat-figure mt-2 text-3xl font-semibold sm:text-4xl",
          tone === "positive" && "text-[var(--positive)]",
          tone === "negative" && "text-destructive",
          tone === "muted" && "text-muted-foreground",
        )}
      >
        {value}
      </div>
      {hint ? <div className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{hint}</div> : null}
    </div>
  );
}
