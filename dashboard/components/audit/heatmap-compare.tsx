"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Eye, Flame, Loader2, Monitor, MousePointer2, Pointer, ScrollText, Smartphone, Tablet, TriangleAlert } from "lucide-react";
import { loadHeatmap, loadHeatmapPages } from "@/app/audit-actions";
import { VIEWPORT_RANGE, type HeatmapType, type HeatmapViewport, type HeatmapWidth, type PostHogHeatmap } from "@/lib/posthog-analytics-types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { HeatmapFrame } from "./heatmap-frame";
import { useLang } from "@/components/lang-provider";
import { intlLocale, pick, tr, type Bi } from "@/lib/i18n";

const TYPES: Array<{ key: HeatmapType; label: Bi; icon: typeof Flame; hint: Bi }> = [
  {
    key: "click",
    label: { id: "Klik", en: "Clicks" },
    icon: Pointer,
    hint: {
      id: "Di mana orang mengetuk — klik satu titik untuk melihat rekaman",
      en: "Where people tap — click a spot to see recordings",
    },
  },
  {
    key: "mousemove",
    label: { id: "Gerak", en: "Movement" },
    icon: MousePointer2,
    hint: { id: "Gerakan kursor (desktop)", en: "Cursor movement (desktop)" },
  },
  {
    key: "scrolldepth",
    label: { id: "Scroll", en: "Scroll" },
    icon: ScrollText,
    hint: {
      id: "Berapa persen pengunjung sampai ke tiap kedalaman",
      en: "What share of visitors reach each depth",
    },
  },
  {
    key: "attention",
    label: { id: "Perhatian", en: "Attention" },
    icon: Eye,
    hint: {
      id: "Berapa lama tiap area halaman terlihat di layar",
      en: "How long each area of the page stays on screen",
    },
  },
  {
    key: "rageclick",
    label: { id: "Rage click", en: "Rage clicks" },
    icon: Flame,
    hint: { id: "Klik berulang cepat — tanda frustrasi", en: "Rapid repeated clicks — a sign of frustration" },
  },
];

const VIEWPORTS: Array<{ key: HeatmapViewport; label: string; icon: typeof Monitor }> = [
  { key: "mobile", label: "Mobile", icon: Smartphone },
  { key: "tablet", label: "Tablet", icon: Tablet },
  { key: "desktop", label: "Desktop", icon: Monitor },
];

/* Tiap muat ulang menjalankan tiga query HogQL per variant di PostHog; 60 detik
 * adalah batas antara "terasa live" dan menghamburkan kuota query. */
const LIVE_INTERVAL_MS = 60_000;


/**
 * Perbandingan heatmap A vs B untuk satu halaman produk.
 *
 * Halaman, jenis, dan viewport dipilih di sini; datanya diambil lewat server
 * action ke bridge. Kedua variant selalu dimuat bersama supaya perbandingannya
 * apple-to-apple: tanggal, halaman, dan viewport yang sama.
 *
 * Mode `live`: data ditarik ulang dari PostHog tiap menit selama tab terlihat.
 * Titik lama tetap ditampilkan sampai yang baru tiba — layar tidak pernah
 * berkedip kosong — dan begitu tab kembali terlihat, langsung dimuat ulang.
 */
export function HeatmapCompare({
  experimentId,
  pages: initialPages,
  variantBSuffix,
  live = false,
}: {
  experimentId: string;
  /** kandidat halaman produk, urut dari yang paling ramai; kalau kosong, diambil sendiri dari PostHog */
  pages?: Array<{ path: string; visitors: number }>;
  variantBSuffix: string;
  live?: boolean;
}) {
  const lang = useLang();
  const t = tr(lang);
  const clock = new Intl.DateTimeFormat(intlLocale(lang), {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Asia/Jakarta",
  });
  const [pages, setPages] = useState(initialPages ?? []);
  const [path, setPath] = useState(initialPages?.[0]?.path ?? "");
  const [type, setType] = useState<HeatmapType>("click");
  const [viewport, setViewport] = useState<HeatmapViewport>("mobile");
  // Lebar layar: "auto" = kelompok paling umum (dipilih server), "all" = semua, angka = bucket.
  const [widthChoice, setWidthChoice] = useState<HeatmapWidth>("auto");
  const [data, setData] = useState<PostHogHeatmap | null>(null);
  // Parameter yang menghasilkan `data`. Kalau berbeda dari parameter sekarang,
  // data itu milik jenis/viewport lain dan tidak boleh ditampilkan — overlay
  // klik di atas tampilan "Scroll" terlihat persis seperti "tidak ada data".
  // Muat ulang live (parameter sama) tetap menampilkan titik lama sampai yang
  // baru tiba.
  const [dataKey, setDataKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [opacity, setOpacity] = useState(0.85);
  const [pending, startTransition] = useTransition();
  // Menghindari balapan: hasil dari permintaan lama tidak boleh menimpa yang baru.
  const requestSeq = useRef(0);

  // Daftar halaman diambil sendiri kalau induk tidak memberikannya (halaman hasil).
  useEffect(() => {
    if (initialPages) return;
    let cancelled = false;
    loadHeatmapPages(experimentId).then((res) => {
      if (cancelled) return;
      setPages(res.pages);
      setPath((current) => current || res.pages[0]?.path || "");
      if (res.error) setError(res.error);
    });
    return () => {
      cancelled = true;
    };
  }, [experimentId, initialPages]);

  const refresh = useCallback(() => {
    if (!path) return;
    const seq = ++requestSeq.current;
    startTransition(async () => {
      const res = await loadHeatmap(experimentId, { path, type, viewport, width: widthChoice });
      if (seq !== requestSeq.current) return;
      if (res.error) {
        setError(res.error);
        setData(null);
      } else {
        setError(null);
        setData(res.heatmap ?? null);
        setDataKey(`${path}|${type}|${viewport}|${widthChoice}`);
        setUpdatedAt(new Date());
      }
    });
  }, [experimentId, path, type, viewport, widthChoice]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!live || !path) return;
    let id: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      clearInterval(id);
      id = setInterval(refresh, LIVE_INTERVAL_MS);
    };
    const onVisibility = () => {
      if (document.hidden) clearInterval(id);
      else {
        refresh();
        start();
      }
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [live, path, refresh]);

  const current = data && dataKey === `${path}|${type}|${viewport}|${widthChoice}` ? data : null;
  // Snapshot dirender di lebar yang sama dengan titik-titiknya; kalau belum ada data, lebar default perangkat.
  const width = current?.renderWidth ?? VIEWPORT_RANGE[viewport].width;
  // Daftar lebar dipertahankan dari respons terakhir supaya dropdown tidak kosong saat memuat.
  const widths = current?.widths ?? data?.widths ?? [];
  const chosenBucket = current?.widthBucket ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[240px] flex-1">
          <label htmlFor="heatmap-page" className="mb-1 block text-xs font-medium text-muted-foreground">
            {t("Halaman produk", "Product page")}
          </label>
          {pages.length > 0 ? (
            <Select value={path} onValueChange={setPath}>
              <SelectTrigger id="heatmap-page" className="w-full">
                <SelectValue placeholder={t("Pilih halaman", "Choose a page")} />
              </SelectTrigger>
              <SelectContent>
                {pages.map((p) => (
                  <SelectItem key={p.path} value={p.path}>
                    <span className="font-mono text-xs">{p.path}</span>
                    {p.visitors > 0 ? <span className="ml-2 text-xs text-muted-foreground">{t(`${p.visitors} pengunjung`, `${p.visitors} visitors`)}</span> : null}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <input
              id="heatmap-page"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={t("/products/nama-produk", "/products/product-name")}
              className="h-9 w-full rounded-md border bg-background px-3 font-mono text-sm"
            />
          )}
        </div>

        <fieldset className="flex rounded-lg border bg-muted/40 p-0.5" aria-label={t("Jenis heatmap", "Heatmap type")}>
          {TYPES.map((m) => (
            <button
              key={m.key}
              type="button"
              title={pick(lang, m.hint)}
              aria-pressed={type === m.key}
              onClick={() => setType(m.key)}
              className={cn(
                "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                type === m.key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <m.icon className="size-3.5" aria-hidden />
              {pick(lang, m.label)}
            </button>
          ))}
        </fieldset>

        <fieldset className="flex rounded-lg border bg-muted/40 p-0.5" aria-label="Viewport">
          {VIEWPORTS.map((v) => (
            <button
              key={v.key}
              type="button"
              aria-pressed={viewport === v.key}
              aria-label={v.label}
              onClick={() => setViewport(v.key)}
              className={cn(
                "inline-flex size-8 cursor-pointer items-center justify-center rounded-md transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                viewport === v.key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <v.icon className="size-4" aria-hidden />
            </button>
          ))}
        </fieldset>

        <div className="min-w-[200px]">
          <label htmlFor="heatmap-width" className="mb-1 block text-xs font-medium text-muted-foreground">
            {t("Lebar layar", "Screen width")}
          </label>
          <Select value={String(widthChoice)} onValueChange={(v) => setWidthChoice(v === "auto" || v === "all" ? v : Number(v))}>
            <SelectTrigger id="heatmap-width" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">
                {t("Paling umum", "Most common")}
                {chosenBucket && widthChoice === "auto" ? (
                  <span className="ml-2 font-mono text-xs text-muted-foreground">
                    {(chosenBucket - 1) * 16 + 1}–{chosenBucket * 16}px
                  </span>
                ) : null}
              </SelectItem>
              <SelectItem value="all">
                {t("Semua lebar", "All widths")}
                <span className="ml-2 font-mono text-xs text-muted-foreground">{t("kurang akurat", "less accurate")}</span>
              </SelectItem>
              {widths.map((w) => (
                <SelectItem key={w.bucket} value={String(w.bucket)}>
                  <span className="font-mono text-xs">
                    {w.minPx}–{w.maxPx}px
                  </span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {Math.round(w.share * 100)}% · {w.sessions} {t("sesi", w.sessions === 1 ? "session" : "sessions")}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {live ? (
          <span
            className="inline-flex h-8 items-center gap-2 rounded-full border border-[var(--positive)]/25 bg-[var(--positive)]/8 px-2.5 text-[11px] font-medium text-[var(--positive)]"
            title={t(
              `Ditarik ulang dari PostHog tiap ${LIVE_INTERVAL_MS / 1000} detik`,
              `Refetched from PostHog every ${LIVE_INTERVAL_MS / 1000} seconds`,
            )}
            role="status"
          >
            <span className="relative flex size-1.5" aria-hidden>
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-[var(--positive)] opacity-60" />
              <span className="relative inline-flex size-1.5 rounded-full bg-[var(--positive)]" />
            </span>
            Live
            <span className="font-mono text-muted-foreground">{updatedAt ? clock.format(updatedAt) : "—"}</span>
            {pending ? <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-label={t("memuat", "loading")} /> : null}
          </span>
        ) : pending ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
            <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
            {t("Mengambil data…", "Fetching data…")}
          </span>
        ) : null}
      </div>

      {error ? (
        <p className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/8 p-3 text-sm" role="alert">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
          <span>{error}</span>
        </p>
      ) : null}
      {current?.errors.length ? <p className="text-xs text-muted-foreground">{current.errors.join(" · ")}</p> : null}

      {!path ? (
        <p className="text-sm text-muted-foreground">
          {pending || (!initialPages && pages.length === 0 && !error)
            ? t("Mencari halaman produk yang tercatat…", "Looking for recorded product pages…")
            : t(
                "Belum ada halaman produk yang tercatat. Ketik path-nya di atas.",
                "No product pages recorded yet. Type the path above.",
              )}
        </p>
      ) : !current && pending ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-[560px] w-full rounded-xl" />
          <Skeleton className="h-[560px] w-full rounded-xl" />
        </div>
      ) : (
        <div className={cn("grid gap-4 transition-opacity duration-300 lg:grid-cols-2", pending && "opacity-80")}>
          <HeatmapFrame
            data={current?.a ?? null}
            type={type}
            viewport={viewport}
            viewportWidth={width}
            label={`A · ${path}`}
            tone="a"
            opacity={opacity}
            experimentId={experimentId}
            path={path}
          />
          <HeatmapFrame
            data={current?.b ?? null}
            type={type}
            viewport={viewport}
            viewportWidth={width}
            label={`B · ${path}?view=${variantBSuffix}`}
            tone="b"
            opacity={opacity}
            experimentId={experimentId}
            path={path}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <span className="h-2 w-24 rounded-full" style={{ background: "linear-gradient(90deg,#2563eb,#10b981,#facc15,#dc2626)" }} aria-hidden />
          {type === "scrolldepth"
            ? t("sedikit yang sampai → semua sampai", "few reach it → everyone reaches it")
            : type === "attention"
              ? t("sebentar → lama dilihat", "brief → long viewing")
              : t("jarang → paling sering", "rare → most frequent")}
        </span>
        <label className="inline-flex items-center gap-2">
          <span>{t("Intensitas", "Intensity")}</span>
          <input
            type="range"
            min={0.3}
            max={1}
            step={0.05}
            value={opacity}
            onChange={(e) => setOpacity(Number(e.target.value))}
            className="h-1 w-24 cursor-pointer accent-[var(--primary)]"
            aria-label={t("Intensitas lapisan heatmap", "Heatmap layer intensity")}
          />
        </label>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0 w-5 border-t-2 border-dashed border-fuchsia-500" aria-hidden />
          {t("lipatan = tinggi layar rata-rata pengunjung", "fold = average visitor screen height")}
        </span>
        <span>
          {type === "click" || type === "rageclick" || type === "mousemove"
            ? t(
                "Arahkan kursor untuk angka; klik titik panas untuk melihat rekaman sesinya.",
                "Hover for numbers; click a hot spot to see its session recordings.",
              )
            : t("Arahkan kursor ke peta untuk melihat angkanya.", "Hover over the map to see the numbers.")}
        </span>
        <span>
          {t(
            chosenBucket
              ? `Hanya sesi dengan lebar layar ${(chosenBucket - 1) * 16 + 1}–${chosenBucket * 16}px, digambar di snapshot selebar itu — posisi titik cocok dengan elemennya. Sesi yang sempat melihat kedua variant dikeluarkan.`
              : `Semua lebar ${VIEWPORT_RANGE[viewport].min}–${VIEWPORT_RANGE[viewport].max}px digabung: posisi vertikal bisa meleset karena tata letak tiap lebar berbeda. Sesi yang sempat melihat kedua variant dikeluarkan.`,
            chosenBucket
              ? `Only sessions with a ${(chosenBucket - 1) * 16 + 1}–${chosenBucket * 16}px screen, drawn on a snapshot of that width — points line up with their elements. Sessions that saw both variants are excluded.`
              : `All widths ${VIEWPORT_RANGE[viewport].min}–${VIEWPORT_RANGE[viewport].max}px combined: vertical positions can drift because each width lays out differently. Sessions that saw both variants are excluded.`,
          )}
        </span>
      </div>
    </div>
  );
}
