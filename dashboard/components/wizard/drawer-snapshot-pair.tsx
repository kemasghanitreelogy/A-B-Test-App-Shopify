"use client";

import { useEffect, useState } from "react";
import { ExternalLink, Loader2, Monitor, Smartphone } from "lucide-react";
import { loadDrawerSampleProducts } from "@/app/wizard-actions";
import type { SampleProduct } from "@/lib/drawer-snapshot";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useT } from "@/components/lang-provider";

/**
 * Cart drawer A (live) next to B (draft theme), open, with the same sample
 * cart — rendered by the real themes (/api/drawer-snapshot), scripts stripped.
 */

const DEFAULT_HANDLE = "organic-moringa-capsules";

export function DrawerSnapshotPair({ themeId, themeName }: { themeId: string; themeName: string }) {
  const t = useT();
  const [products, setProducts] = useState<SampleProduct[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [handle, setHandle] = useState("");
  const [variantId, setVariantId] = useState("");
  const [qty, setQty] = useState("1");
  const [locale, setLocale] = useState<"" | "id">("");
  const [device, setDevice] = useState<"mobile" | "desktop">("mobile");

  useEffect(() => {
    let alive = true;
    loadDrawerSampleProducts().then((res) => {
      if (!alive) return;
      if (res.error || !res.products?.length) {
        setError(res.error ?? "");
        return;
      }
      setProducts(res.products);
      const first = res.products.find((p) => p.handle === DEFAULT_HANDLE) ?? res.products[0];
      setHandle(first.handle);
      setVariantId(String(first.variants[0].id));
    });
    return () => {
      alive = false;
    };
  }, []);

  const product = products?.find((p) => p.handle === handle) ?? null;
  const numericTheme = themeId.split("/").pop() ?? themeId;
  const ready = !!variantId;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <h3 className="mr-auto text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("Preview drawer A vs B", "Drawer preview A vs B")}
        </h3>

        <Select
          value={handle}
          onValueChange={(h) => {
            setHandle(h);
            const p = products?.find((x) => x.handle === h);
            if (p) setVariantId(String(p.variants[0].id));
          }}
          disabled={!products}
        >
          <SelectTrigger className="h-8 w-56 text-xs" aria-label={t("Produk di keranjang contoh", "Product in the sample cart")}>
            <SelectValue placeholder={t("Memuat produk…", "Loading products…")} />
          </SelectTrigger>
          <SelectContent>
            {(products ?? []).map((p) => (
              <SelectItem key={p.handle} value={p.handle}>
                {p.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {product && product.variants.length > 1 && (
          <Select value={variantId} onValueChange={setVariantId}>
            <SelectTrigger className="h-8 w-40 text-xs" aria-label={t("Varian", "Variant")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {product.variants.map((v) => (
                <SelectItem key={v.id} value={String(v.id)}>
                  {v.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Select value={qty} onValueChange={setQty}>
          <SelectTrigger className="h-8 w-16 text-xs" aria-label={t("Jumlah", "Quantity")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {["1", "2", "3"].map((q) => (
              <SelectItem key={q} value={q}>
                ×{q}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex rounded-md border p-0.5 text-xs" role="group" aria-label={t("Bahasa", "Language")}>
          {(
            [
              ["", "EN"],
              ["id", "ID"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={label}
              type="button"
              aria-pressed={locale === value}
              onClick={() => setLocale(value)}
              className={cn(
                "cursor-pointer rounded px-2 py-1 transition-colors duration-200",
                locale === value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex rounded-md border p-0.5" role="group" aria-label={t("Perangkat", "Device")}>
          <button
            type="button"
            aria-label={t("Tampilan mobile", "Mobile view")}
            aria-pressed={device === "mobile"}
            onClick={() => setDevice("mobile")}
            className={cn(
              "cursor-pointer rounded p-1.5 transition-colors duration-200",
              device === "mobile" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Smartphone className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label={t("Tampilan desktop", "Desktop view")}
            aria-pressed={device === "desktop"}
            onClick={() => setDevice("desktop")}
            className={cn(
              "cursor-pointer rounded p-1.5 transition-colors duration-200",
              device === "desktop" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Monitor className="size-3.5" />
          </button>
        </div>
      </div>

      {error !== null && (
        <p className="text-sm text-destructive">
          {error || t("Produk contoh tidak bisa dimuat.", "Sample products could not be loaded.")}
        </p>
      )}

      {ready && (
        <div className={cn("grid gap-4", device === "mobile" ? "sm:grid-cols-2" : "grid-cols-1 xl:grid-cols-2")}>
          <DrawerFrame
            label={t("A · drawer sekarang (live)", "A · current drawer (live)")}
            tone="a"
            src={snapshotSrc(null, variantId, qty, locale)}
            openHref={null}
            device={device}
          />
          <DrawerFrame
            label={`B · ${themeName}`}
            tone="b"
            src={snapshotSrc(numericTheme, variantId, qty, locale)}
            openHref={`https://treelogy.com${locale ? `/${locale}` : ""}/?preview_theme_id=${numericTheme}`}
            device={device}
          />
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {t(
          "Dirender oleh theme aslinya dengan keranjang contoh (hadiah otomatis ikut ditambahkan), tanpa script — tombol tidak bisa diklik. Untuk mencoba interaksinya, buka preview B di tab baru.",
          "Rendered by the real themes with a sample cart (automatic gifts included), without scripts — buttons don't respond. To try the interactions, open B's preview in a new tab.",
        )}
      </p>
    </div>
  );
}

function snapshotSrc(theme: string | null, variant: string, qty: string, locale: string) {
  const q = new URLSearchParams({ variant, qty });
  if (theme) q.set("theme", theme);
  if (locale) q.set("locale", locale);
  return `/api/drawer-snapshot?${q}`;
}

function DrawerFrame({
  label,
  tone,
  src,
  openHref,
  device,
}: {
  label: string;
  tone: "a" | "b";
  src: string;
  openHref: string | null;
  device: "mobile" | "desktop";
}) {
  const t = useT();
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const key = `${src}-${device}`;
  const loading = loadedSrc !== key;

  return (
    <div className="flex min-w-0 flex-col surface rounded-2xl">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ background: tone === "a" ? "var(--variant-a)" : "var(--variant-b)" }}
        />
        <span className="truncate text-xs font-medium">{label}</span>
        {openHref && (
          <a
            href={openHref}
            target="_blank"
            rel="noreferrer"
            aria-label={t("Buka preview interaktif di tab baru", "Open the interactive preview in a new tab")}
            className="ml-auto rounded p-1 text-muted-foreground transition-colors duration-200 hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>
      <div
        className={cn(
          "relative mx-auto overflow-hidden rounded-b-xl bg-white",
          device === "mobile" ? "h-[548px] w-[254px]" : "h-[352px] w-full max-w-[563px]",
        )}
      >
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-card text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t("Mengisi keranjang contoh…", "Filling a sample cart…")}
          </div>
        )}
        <iframe
          key={key}
          src={src}
          title={label}
          onLoad={() => setLoadedSrc(key)}
          sandbox=""
          className={cn(
            "origin-top-left border-0 bg-white",
            device === "mobile" ? "h-[844px] w-[390px] scale-[0.65]" : "h-[800px] w-[1280px] scale-[0.44]",
          )}
        />
      </div>
    </div>
  );
}
