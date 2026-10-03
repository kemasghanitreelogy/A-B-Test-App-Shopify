import { cn } from "@/lib/utils";
import { pick, type Bi, type Lang } from "@/lib/i18n";

const STATUS: Record<string, { label: Bi; dot: string; text: string; ring: string }> = {
  running: { label: { id: "Berjalan", en: "Running" }, dot: "bg-emerald-500", text: "text-emerald-500", ring: "ring-emerald-500/25" },
  paused: { label: { id: "Dijeda", en: "Paused" }, dot: "bg-amber-500", text: "text-amber-500", ring: "ring-amber-500/25" },
  draft: { label: { id: "Draft", en: "Draft" }, dot: "bg-slate-400", text: "text-muted-foreground", ring: "ring-border" },
  completed: { label: { id: "Selesai", en: "Completed" }, dot: "bg-sky-500", text: "text-sky-500", ring: "ring-sky-500/25" },
  archived: { label: { id: "Diarsipkan", en: "Archived" }, dot: "bg-slate-500", text: "text-muted-foreground", ring: "ring-border" },
};

export function StatusBadge({
  status,
  className,
  lang = "id",
}: {
  status: string;
  className?: string;
  lang?: Lang;
}) {
  const s = STATUS[status] ?? STATUS.draft;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset",
        s.text,
        s.ring,
        className,
      )}
    >
      {/* Titik berdenyut hanya untuk status berjalan — dan status juga ditulis
          sebagai teks, jadi warna bukan satu-satunya pembeda. */}
      <span className={cn("size-1.5 rounded-full", s.dot, status === "running" && "animate-pulse")} />
      {pick(lang, s.label)}
    </span>
  );
}
