import { ExternalLink, MousePointerClick, Play, TriangleAlert } from "lucide-react";
import type { ReplayRow } from "@/lib/posthog-analytics-types";
import { fmtDuration } from "./audit-format";
import { intlLocale, tr, type Lang } from "@/lib/i18n";

/**
 * Daftar rekaman sesi per variant, diurutkan dari yang paling banyak rage click.
 *
 * Rekaman tidak bisa diputar di luar PostHog (pemutarnya butuh token berbagi per
 * rekaman), jadi setiap baris membuka pemutar PostHog di tab baru.
 */
export function ReplayList({
  rows,
  variant,
  lang = "id",
}: {
  rows: ReplayRow[];
  variant: "A" | "B";
  lang?: Lang;
}) {
  const t = tr(lang);
  const accent = variant === "A" ? "var(--variant-a)" : "var(--variant-b)";
  const mine = rows.filter((r) => r.variant === variant).slice(0, 12);

  return (
    <div className="surface rounded-2xl">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <span className="size-2 rounded-full" style={{ background: accent }} aria-hidden />
        <h3 className="text-sm font-medium">{t(`Replay variant ${variant}`, `Variant ${variant} replays`)}</h3>
        <span className="ml-auto text-xs text-muted-foreground">{t(`${mine.length} rekaman`, `${mine.length} recordings`)}</span>
      </div>
      {mine.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">{t("Belum ada rekaman untuk variant ini.", "No recordings for this variant yet.")}</p>
      ) : (
        <ul className="divide-y">
          {mine.map((r) => (
            <li key={r.sessionId}>
              <a
                href={r.url}
                target="_blank"
                rel="noreferrer"
                className="flex cursor-pointer items-center gap-3 px-4 py-2.5 text-sm transition-colors duration-200 hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none"
              >
                <Play className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="truncate">
                    {new Date(r.startedAt).toLocaleString(intlLocale(lang), { dateStyle: "medium", timeStyle: "short" })}
                    <span className="ml-2 text-muted-foreground">{fmtDuration(r.duration, lang)}</span>
                  </div>
                  <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <MousePointerClick className="size-3" aria-hidden />
                      {t(`${r.clicks} klik`, `${r.clicks} ${r.clicks === 1 ? "click" : "clicks"}`)}
                    </span>
                    {r.rageclicks > 0 ? (
                      <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                        <TriangleAlert className="size-3" aria-hidden />
                        {r.rageclicks} {t("rage click", r.rageclicks === 1 ? "rage click" : "rage clicks")}
                      </span>
                    ) : null}
                    {r.errors > 0 ? <span className="text-destructive">{t(`${r.errors} error console`, `${r.errors} console ${r.errors === 1 ? "error" : "errors"}`)}</span> : null}
                  </div>
                </div>
                <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
