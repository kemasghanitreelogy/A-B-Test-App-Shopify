"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { ExternalLink, Loader2, MousePointerClick, Play, X } from "lucide-react";
import { loadHeatmapReplays } from "@/app/audit-actions";
import type { HeatmapReplay, HeatmapType, HeatmapViewport, VariantHeatmap } from "@/lib/posthog-analytics-types";
import { fmtInt } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useLang } from "@/components/lang-provider";
import { intlLocale, tr } from "@/lib/i18n";

/**
 * Snapshot halaman + lapisan heatmap yang digambar sendiri, setara Hotjar:
 *
 *   klik / gerak / rage  → peta panas Gaussian; klik satu titik memunculkan kartu
 *                          "N tap · x% dari semua tap · Lihat replay"
 *   scroll               → seluruh halaman diwarnai menurut % pengunjung yang
 *                          sampai; garis mengikuti kursor: "x% menggulir sampai sini"
 *   perhatian            → seluruh halaman diwarnai menurut detik rata-rata area
 *                          itu terlihat; garis mengikuti kursor: "x dtk rata-rata"
 *   rel kiri             → legenda vertikal dengan penanda posisi kursor
 *   garis lipatan        → tinggi layar rata-rata pengunjung
 *
 * Titik-titik datang dari tabel `heatmaps` PostHog sebagai (x relatif, y piksel
 * dokumen), ditaruh di atas iframe snapshot ber-sandbox. Iframe tidak bisa
 * dibaca dari sini (tanpa allow-same-origin, disengaja) dan tidak menerima
 * pointer — roda mouse menggulir HALAMAN, bukan iframe, supaya lapisan panas
 * tidak pernah melenceng dari elemen di bawahnya.
 */
export function HeatmapFrame({
  data,
  type,
  viewport,
  viewportWidth,
  label,
  tone,
  opacity = 0.85,
  experimentId,
  path,
}: {
  data: VariantHeatmap | null;
  type: HeatmapType;
  viewport: HeatmapViewport;
  viewportWidth: number;
  label: string;
  tone: "a" | "b";
  /** 0..1, dari slider "intensitas" di panel */
  opacity?: number;
  experimentId: string;
  path: string;
}) {
  const lang = useLang();
  const t = tr(lang);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [scale, setScale] = useState(0.5);
  const [wrapWidth, setWrapWidth] = useState(300);
  const [loading, setLoading] = useState(true);
  const [hover, setHover] = useState<{ x: number; y: number; docY: number; text: string; t: number } | null>(null);
  const [pinnedState, setPinned] = useState<{ x: number; y: number; relX: number; docY: number; count: number; share: number; forData: VariantHeatmap; forType: HeatmapType } | null>(null);
  // Kartu sematan hanya sah untuk data & jenis yang melahirkannya; begitu salah
  // satunya berganti, ia dianggap tidak ada — tanpa effect, tanpa render ganda.
  const pinned = pinnedState && pinnedState.forData === data && pinnedState.forType === type ? pinnedState : null;
  const [replays, setReplays] = useState<HeatmapReplay[] | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [replaysPending, startReplays] = useTransition();
  const accent = tone === "a" ? "var(--variant-a)" : "var(--variant-b)";
  const isBand = type === "scrolldepth" || type === "attention";

  const deepest = data
    ? Math.max(
        ...data.points.filter((p) => !p.fixed).map((p) => p.y),
        ...data.scroll.map((b) => b.y + 100),
        ...data.attention.map((b) => b.y + 100),
        0,
      )
    : 0;
  // Batas atas longgar: halaman produk yang panjang tidak boleh terpotong,
  // karena iframe tidak bisa digulir sendiri.
  const docHeight = Math.min(14000, Math.max(1400, deepest + 600));
  const totalPoints = useMemo(() => (data ? data.points.reduce((s, p) => s + p.count, 0) : 0), [data]);
  const unit =
    type === "mousemove"
      ? t("gerakan", "movements")
      : type === "rageclick"
        ? t("rage click", "rage clicks")
        : t("tap", "taps");
  // Satuan untuk satu angka: bahasa Inggris membedakan tunggal/jamak.
  const unitFor = (n: number) =>
    lang === "en" && n === 1
      ? type === "mousemove"
        ? "movement"
        : type === "rageclick"
          ? "rage click"
          : "tap"
      : unit;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      setScale(Math.min(0.75, el.clientWidth / viewportWidth));
      setWrapWidth(el.clientWidth);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [viewportWidth]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = viewportWidth;
    canvas.height = docHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!data) return;
    if (type === "scrolldepth") drawBands(ctx, data.scroll.map((b) => ({ y: b.y, t: b.reached / Math.max(1, data.scroll[0]?.reached ?? 1) })), viewportWidth);
    else if (type === "attention") drawBands(ctx, data.attention.map((b) => ({ y: b.y, t: attentionT(data, b.seconds) })), viewportWidth);
    else drawPoints(ctx, data, viewportWidth, docHeight, type);
  }, [data, type, viewportWidth, docHeight]);

  const src = `/api/snapshot?path=${encodeURIComponent(data?.path ?? "/")}`;

  function bandAt(docY: number): { text: string; t: number } | null {
    if (!data) return null;
    if (type === "scrolldepth") {
      const bucket = [...data.scroll].reverse().find((b) => docY >= b.y);
      const top = data.scroll[0]?.reached ?? 0;
      if (!bucket || top === 0) return null;
      const frac = bucket.reached / top;
      return {
        text: t(
          `${(frac * 100).toFixed(1)}% pengunjung menggulir sampai sini`,
          `${(frac * 100).toFixed(1)}% of visitors scrolled this far`,
        ),
        t: frac,
      };
    }
    const bucket = [...data.attention].reverse().find((b) => docY >= b.y);
    if (!bucket || data.maxCount <= 0) return null;
    const frac = attentionT(data, bucket.seconds);
    const level =
      frac >= 0.66
        ? t("perhatian tinggi", "high attention")
        : frac >= 0.33
          ? t("perhatian sedang", "medium attention")
          : t("perhatian rendah", "low attention");
    return {
      text: t(
        `≈ ${bucket.seconds.toFixed(1)} dtk per pengunjung area ini terlihat · ${level}`,
        `≈ ${bucket.seconds.toFixed(1)} s per visitor this area was visible · ${level}`,
      ),
      t: frac,
    };
  }

  function nearby(relX: number, docY: number): number {
    if (!data) return 0;
    const radius = Math.max(24, viewportWidth * 0.06);
    let count = 0;
    for (const p of data.points) {
      const dx = p.relX * viewportWidth - relX * viewportWidth;
      const dy = p.y - docY;
      if (dx * dx + dy * dy <= radius * radius) count += p.count;
    }
    return count;
  }

  function onMove(e: React.MouseEvent<HTMLDivElement>) {
    if (!data) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const docY = y / scale;
    if (isBand) {
      const band = bandAt(docY);
      return setHover(band ? { x, y, docY, text: band.text, t: band.t } : null);
    }
    const count = nearby(x / scale / viewportWidth, docY);
    if (count === 0) return setHover(null);
    const share = totalPoints > 0 ? (count / totalPoints) * 100 : 0;
    setHover({ x, y, docY, text: t(
        `${fmtInt(count)} ${unit} · ${share.toFixed(1)}% dari semua ${unit}`,
        `${fmtInt(count)} ${unitFor(count)} · ${share.toFixed(1)}% of all ${unit}`,
      ), t: Math.min(1, count / Math.max(1, data.maxCount)) });
  }

  function onClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!data || isBand) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const relX = x / scale / viewportWidth;
    const docY = y / scale;
    const count = nearby(relX, docY);
    if (count === 0) {
      setPinned(null);
      setReplays(null);
      return;
    }
    setPinned({ x, y, relX, docY, count, share: totalPoints > 0 ? (count / totalPoints) * 100 : 0, forData: data, forType: type });
    setReplays(null);
    setReplayError(null);
  }

  function fetchReplays() {
    if (!pinned || !data) return;
    startReplays(async () => {
      const res = await loadHeatmapReplays(experimentId, { path, type, viewport, variant: data.variant, relX: pinned.relX, y: Math.round(pinned.docY) });
      setReplayError(res.error ?? null);
      setReplays(res.replays);
    });
  }

  return (
    <div className="flex min-w-0 flex-col surface rounded-2xl">
      <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2">
        <span className="size-2 shrink-0 rounded-full" style={{ background: accent, boxShadow: `0 0 8px ${accent}` }} aria-hidden />
        <span className="truncate text-xs font-medium">{label}</span>
        <span className="ml-auto whitespace-nowrap font-mono text-[11px] text-muted-foreground">
          {data ? t(`${fmtInt(data.totalSessions)} sesi`, `${fmtInt(data.totalSessions)} sessions`) : "—"}
          {data && !isBand ? ` · ${fmtInt(totalPoints)} ${unit}` : ""}
        </span>
      </div>

      <div className="flex">
        {/* Rel legenda vertikal: gradien penuh, penanda mengikuti kursor. */}
        {isBand ? (
          <div className="relative w-6 shrink-0 border-r border-border/70 bg-card" aria-hidden>
            <div
              className="absolute inset-y-3 left-1/2 w-2.5 -translate-x-1/2 rounded-full"
              style={{
                background:
                  type === "scrolldepth"
                    ? "linear-gradient(180deg,#dc2626 0%,#facc15 20%,#10b981 45%,#2563eb 75%,rgba(37,99,235,0.15) 100%)"
                    : "linear-gradient(180deg,#2563eb,#10b981,#facc15,#dc2626)",
              }}
            />
            {hover ? (
              <div
                className="absolute left-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
                style={{ top: `calc(0.75rem + ${(type === "scrolldepth" ? 1 - hover.t : hover.t) * 100}% * (1 - 1.5rem / 100%))`, background: rampCss(hover.t) }}
              />
            ) : null}
          </div>
        ) : null}

        <div
          ref={wrapRef}
          className={cn("relative min-w-0 flex-1 overflow-hidden bg-white", isBand ? "cursor-row-resize" : "cursor-crosshair")}
          style={{ height: docHeight * scale }}
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
          onClick={onClick}
        >
          {loading ? (
            <div className="absolute inset-0 z-20 flex items-center justify-center gap-2 bg-card text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
              {t("Memuat halaman…", "Loading page…")}
            </div>
          ) : null}
          <div className="origin-top-left" style={{ width: viewportWidth, height: docHeight, transform: `scale(${scale})` }}>
            <iframe
              key={src}
              src={src}
              title={`Snapshot ${label}`}
              onLoad={() => setLoading(false)}
              sandbox=""
              scrolling="no"
              tabIndex={-1}
              className="pointer-events-none border-0 bg-white"
              style={{ width: viewportWidth, height: docHeight, overflow: "hidden" }}
            />
            <canvas
              ref={canvasRef}
              aria-hidden
              className="pointer-events-none absolute left-0 top-0 transition-opacity duration-300"
              style={{ width: viewportWidth, height: docHeight, opacity, mixBlendMode: isBand ? "multiply" : "normal" }}
            />
            {/* Garis lipatan: tinggi layar rata-rata pengunjung. Yang di bawah garis
                ini hanya terlihat setelah menggulir. */}
            {data?.foldY ? (
              <div className="pointer-events-none absolute inset-x-0" style={{ top: data.foldY }} aria-hidden>
                <div className="border-t-2 border-dashed border-fuchsia-500/80" />
                <span
                  className="absolute right-0 -top-7 rounded-md bg-fuchsia-600 px-2 py-1 font-sans font-semibold text-white"
                  style={{ fontSize: Math.round(12 / scale), lineHeight: 1.2 }}
                >
                  {t("Lipatan rata-rata", "Average fold")} · {fmtInt(data.foldY)}px
                </span>
              </div>
            ) : null}
          </div>

          {/* Garis pengikut kursor untuk peta scroll/perhatian, ala Hotjar. */}
          {isBand && hover ? (
            <div className="pointer-events-none absolute inset-x-0 z-30" style={{ top: hover.y }}>
              <div className="border-t border-slate-900/70" />
              <span className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-md bg-slate-900/90 px-2.5 py-1 text-[11px] font-medium text-white shadow-lg">
                {hover.text}
              </span>
            </div>
          ) : null}

          {!isBand && hover && !pinned ? (
            <div
              className="pointer-events-none absolute z-30 max-w-[240px] rounded-lg border border-border bg-popover/95 px-2.5 py-1.5 text-[11px] leading-snug text-popover-foreground shadow-xl backdrop-blur"
              style={{ left: Math.min(hover.x + 12, wrapWidth - 250), top: hover.y + 12 }}
            >
              {hover.text}
              <div className="mt-0.5 text-[10px] text-muted-foreground">{t("klik untuk melihat rekaman", "click to see recordings")}</div>
            </div>
          ) : null}

          {/* Kartu yang disematkan: N tap · x% · Lihat replay. */}
          {pinned ? (
            <div
              className="absolute z-40 w-[260px] rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl"
              style={{ left: Math.min(pinned.x + 14, wrapWidth - 270), top: Math.max(8, pinned.y - 20) }}
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-label={t("Detail titik heatmap", "Heatmap spot details")}
            >
              <div className="relative border-l-4 p-3" style={{ borderColor: accent }}>
                <button
                  type="button"
                  className="absolute right-2 top-2 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  onClick={() => setPinned(null)}
                  aria-label={t("Tutup", "Close")}
                >
                  <X className="size-3.5" />
                </button>
                <div className="stat-figure text-xl font-semibold">
                  {fmtInt(pinned.count)} {unitFor(pinned.count)}
                </div>
                <div className="text-xs text-muted-foreground">
                  {t(
                    `${pinned.share.toFixed(2)}% dari semua ${unit} di halaman ini`,
                    `${pinned.share.toFixed(2)}% of all ${unit} on this page`,
                  )}
                </div>
              </div>
              <div className="border-t border-border/70 p-2">
                {replays == null ? (
                  <button
                    type="button"
                    onClick={fetchReplays}
                    disabled={replaysPending}
                    className="inline-flex h-8 w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-primary/40 bg-primary/10 text-xs font-medium text-primary transition-colors hover:bg-primary/15 disabled:opacity-60"
                  >
                    {replaysPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
                    {t("Lihat replay", "View replays")}
                  </button>
                ) : replayError ? (
                  <p className="px-1 text-xs text-destructive">{replayError}</p>
                ) : replays.length === 0 ? (
                  <p className="px-1 text-xs text-muted-foreground">
                    {t(
                      "Tidak ada rekaman sesi untuk titik ini (replay PostHog memakai sampling).",
                      "No session recordings for this spot (PostHog replays are sampled).",
                    )}
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {replays.map((r) => (
                      <li key={r.sessionId}>
                        <a
                          href={r.url}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-accent"
                        >
                          <Play className="size-3 text-primary" aria-hidden />
                          <span className="font-mono text-[11px]">{r.sessionId.slice(0, 8)}…</span>
                          <span className="text-muted-foreground">{t(`${fmtInt(r.count)}× di sini`, `${fmtInt(r.count)}× here`)}</span>
                          <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                            {new Intl.DateTimeFormat(intlLocale(lang), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" }).format(new Date(r.occurredAt))}
                          </span>
                          <ExternalLink className="size-3 text-muted-foreground" aria-hidden />
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : null}

          {data && data.points.length === 0 && data.scroll.length === 0 && data.attention.length === 0 ? (
            <div className="absolute inset-x-0 bottom-0 z-10 bg-card/90 px-3 py-2 text-center text-xs text-muted-foreground backdrop-blur">
              {t(
                "Belum ada data heatmap untuk variant ini pada halaman dan viewport terpilih.",
                "No heatmap data for this variant on the selected page and viewport yet.",
              )}
            </div>
          ) : null}
        </div>
      </div>

      {/* Click list ala Hotjar: elemen yang paling diklik, dengan pangsa. */}
      {data && data.elements.length > 0 && !isBand ? (
        <div className="border-t border-border/70 px-3 py-3">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            <MousePointerClick className="size-3.5" aria-hidden />
            {t("Paling banyak diklik", "Most clicked")}
          </div>
          <ol className="space-y-1.5">
            {data.elements.map((el, i) => (
              <li key={`${el.tag}-${el.label}-${i}`} className="text-xs">
                <div className="flex items-baseline gap-2">
                  <span className="w-4 shrink-0 font-mono text-[10px] text-muted-foreground">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate" title={el.label}>
                    <span className="mr-1.5 rounded border border-border px-1 font-mono text-[9px] uppercase text-muted-foreground">{el.tag}</span>
                    {el.label}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] tabular-nums">
                    {fmtInt(el.count)} <span className="text-muted-foreground">· {Math.round(el.share * 100)}%</span>
                  </span>
                </div>
                <div className="ml-6 mt-1 h-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="bar-grow h-full rounded-full"
                    style={{ "--i": i, width: `${Math.max(2, el.share * 100)}%`, background: `linear-gradient(90deg, color-mix(in oklab, ${accent} 60%, transparent), ${accent})` } as React.CSSProperties}
                  />
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Rendering.

   Ramp warna mengikuti konvensi Hotjar: biru (jarang) → hijau → kuning → merah
   (paling sering). Intensitas ditumpuk per titik dengan gradien radial (jatuh
   Gaussian), lalu dinormalkan terhadap piksel terpanas supaya halaman dengan
   sedikit klik tetap terbaca.
   --------------------------------------------------------------------------- */
const RAMP: Array<[number, [number, number, number]]> = [
  [0, [37, 99, 235]],
  [0.3, [16, 185, 129]],
  [0.6, [250, 204, 21]],
  [1, [220, 38, 38]],
];

function rampColor(t: number): [number, number, number] {
  for (let i = 1; i < RAMP.length; i++) {
    if (t <= RAMP[i][0]) {
      const [t0, c0] = RAMP[i - 1];
      const [t1, c1] = RAMP[i];
      const k = (t - t0) / (t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k];
    }
  }
  return RAMP[RAMP.length - 1][1];
}

/* Perhatian dinormalkan terhadap rentang halaman itu sendiri (min..max), bukan
 * 0..max: yang menarik adalah area mana yang dilihat LEBIH LAMA dari area lain
 * di halaman yang sama. Dengan 0..max, halaman yang semua areanya dilihat
 * 8–10 detik tampil merah merata dan tidak mengatakan apa-apa. */
function attentionT(data: VariantHeatmap, seconds: number): number {
  const values = data.attention.map((b) => b.seconds);
  if (values.length === 0) return 0;
  const min = Math.min(...values);
  const max = Math.max(...values);
  return max - min < 0.05 ? 0.5 : (seconds - min) / (max - min);
}

function rampCss(t: number): string {
  const [r, g, b] = rampColor(Math.min(1, Math.max(0, t)));
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}

function drawPoints(ctx: CanvasRenderingContext2D, data: VariantHeatmap, width: number, height: number, type: HeatmapType) {
  if (data.points.length === 0) return;
  // Radius mengikuti lebar layar: ~6% lebar untuk klik, lebih lebar untuk gerak kursor.
  const radius = Math.max(18, width * (type === "mousemove" ? 0.09 : 0.06));
  const off = document.createElement("canvas");
  off.width = width;
  off.height = height;
  const octx = off.getContext("2d");
  if (!octx) return;
  const max = Math.max(1, data.maxCount);

  for (const p of data.points) {
    const x = p.relX * width;
    const y = p.y;
    if (y > height) continue;
    // Titik tunggal pun harus terlihat (alpha dasar), titik terpanas menumpuk sampai 1.
    const alpha = 0.22 + 0.78 * Math.min(1, p.count / max);
    const g = octx.createRadialGradient(x, y, 0, x, y, radius);
    g.addColorStop(0, `rgba(0,0,0,${alpha})`);
    g.addColorStop(0.5, `rgba(0,0,0,${alpha * 0.35})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    octx.fillStyle = g;
    octx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }

  // Normalisasi terhadap piksel terpanas: kalau tidak, halaman sepi hanya biru muda.
  const img = octx.getImageData(0, 0, width, height);
  const px = img.data;
  let peak = 1;
  for (let i = 3; i < px.length; i += 4) if (px[i] > peak) peak = px[i];
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (a === 0) continue;
    const t = Math.min(1, a / peak);
    const [r, g, b] = rampColor(t);
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = Math.min(255, 60 + t * 195);
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Pita berwarna selebar halaman (scroll & perhatian). Warna antar pita
 * diinterpolasi supaya tidak bergaris; t = 1 merah, t = 0 biru.
 */
function drawBands(ctx: CanvasRenderingContext2D, bands: Array<{ y: number; t: number }>, width: number) {
  if (bands.length === 0) return;
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    const next = bands[i + 1];
    const h = next ? Math.max(1, next.y - b.y) : 100;
    const g = ctx.createLinearGradient(0, b.y, 0, b.y + h);
    const [r0, g0, b0] = rampColor(b.t);
    const [r1, g1, b1] = rampColor(next ? next.t : b.t);
    g.addColorStop(0, `rgba(${r0},${g0},${b0},${0.2 + 0.5 * b.t})`);
    g.addColorStop(1, `rgba(${r1},${g1},${b1},${0.2 + 0.5 * (next ? next.t : b.t)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, b.y, width, h);
  }
}
