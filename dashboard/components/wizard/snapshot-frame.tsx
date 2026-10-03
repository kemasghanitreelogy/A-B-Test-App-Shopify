"use client";

import { useState } from "react";
import { ExternalLink, Loader2, Monitor, Smartphone } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/components/lang-provider";

/**
 * Menampilkan halaman storefront sungguhan di dalam iframe ber-sandbox.
 *
 * Yang dimuat adalah HTML asli yang sudah dibuang seluruh script-nya oleh route
 * /api/snapshot — jadi tata letak, font, dan gambar tetap seperti aslinya, tapi
 * tidak ada tracker toko yang ikut menyala saat preview dibuka.
 */
export function SnapshotFrame({
  path,
  themeId,
  label,
  tone,
  locale,
}: {
  path: string;
  themeId?: string | null;
  label: string;
  tone: "a" | "b";
  /** locale storefront, mis. "id". Kosongkan untuk locale primary. */
  locale?: string | null;
}) {
  const t = useT();
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [loading, setLoading] = useState(true);

  // Shopify menyajikan bahasa lain lewat awalan path (/id/products/...). Tanpa
  // ini snapshot selalu berbahasa primary, sehingga bug terjemahan variant B
  // tidak akan pernah terlihat di sini.
  const localizedPath = locale ? `/${locale}${path === "/" ? "" : path}` : path;
  const src = `/api/snapshot?path=${encodeURIComponent(localizedPath)}${themeId ? `&theme=${themeId}` : ""}`;
  const accent = tone === "a" ? "var(--variant-a)" : "var(--variant-b)";

  return (
    <div className="flex min-w-0 flex-col surface rounded-2xl">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="size-2 shrink-0 rounded-full" style={{ background: accent }} />
        <span className="truncate text-xs font-medium">{label}</span>

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setDevice("desktop")}
            aria-label={t("Tampilan desktop", "Desktop view")}
            aria-pressed={device === "desktop"}
            className={cn(
              "rounded p-1 transition-colors duration-200",
              device === "desktop" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Monitor className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setDevice("mobile")}
            aria-label={t("Tampilan mobile", "Mobile view")}
            aria-pressed={device === "mobile"}
            className={cn(
              "rounded p-1 transition-colors duration-200",
              device === "mobile" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Smartphone className="size-3.5" />
          </button>
          <a
            href={`https://treelogy.com${localizedPath}${themeId ? `?preview_theme_id=${themeId}` : ""}`}
            target="_blank"
            rel="noreferrer"
            aria-label={t("Buka halaman aslinya di tab baru", "Open the live page in a new tab")}
            className="rounded p-1 text-muted-foreground transition-colors duration-200 hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
          </a>
        </div>
      </div>

      <div className="relative h-[440px] overflow-hidden rounded-b-xl bg-white">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-card text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t("Memuat halaman…", "Loading page…")}
          </div>
        )}
        <iframe
          key={`${src}-${device}`}
          src={src}
          title={label}
          onLoad={() => setLoading(false)}
          // allow-same-origin sengaja TIDAK diberikan: halaman ini berasal dari
          // toko, bukan dari kita, dan tidak boleh menyentuh apa pun milik dashboard.
          sandbox=""
          className={cn(
            "origin-top-left border-0 bg-white",
            device === "desktop" ? "h-[1100px] w-[1280px] scale-[0.4]" : "h-[1100px] w-[390px] scale-[0.4]",
          )}
        />
      </div>
    </div>
  );
}
