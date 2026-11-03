import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Grafik halaman hasil eksperimen.
 *
 * SVG tulisan tangan, tanpa library chart: admin memuat app ini di iframe dan
 * setiap kilobyte bundle terasa. Warna mengikuti Polaris (abu = kontrol, biru =
 * variant) supaya halaman tetap terasa bagian dari admin. Setiap grafik punya
 * tabel angka di bagian "Detail angka" sebagai alternatif aksesibel.
 */

export const AB_COLORS = {
  a: "#8a8a8a",
  b: "#005bd3",
  ok: "#29845a",
  bad: "#c70a24",
  warn: "#b28400",
  grid: "#ebebeb",
  axis: "#b5b5b5",
  text: "#303030",
  muted: "#616161",
};

const nf = (o?: Intl.NumberFormatOptions) => new Intl.NumberFormat("id-ID", o);
export const fmt = {
  int: (n: number) => nf({ maximumFractionDigits: 0 }).format(n),
  pct: (n: number, d = 2) => nf({ style: "percent", minimumFractionDigits: d, maximumFractionDigits: d }).format(n),
  signed: (n: number, d = 1) =>
    `${n > 0 ? "+" : n < 0 ? "−" : ""}${nf({ minimumFractionDigits: d, maximumFractionDigits: d }).format(Math.abs(n) * 100)}%`,
  idr: (n: number) => `Rp${nf({ maximumFractionDigits: 0 }).format(n)}`,
};

/** Lebar elemen yang mengikuti resize; nilai awal dipakai saat render server. */
function useWidth(initial = 640) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.floor(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

interface Tip {
  x: number;
  y: number;
  head: string;
  rows: Array<{ color?: string; text: string }>;
}

function Tooltip({ tip, width }: { tip: Tip | null; width: number }) {
  if (!tip) return null;
  const left = Math.max(0, Math.min(width - 220, tip.x + 12));
  return (
    <div className="ab-tip" style={{ left, top: Math.max(0, tip.y - 12), transform: "translateY(-100%)" }} role="status">
      <div className="ab-tip-head">{tip.head}</div>
      {tip.rows.map((r, i) => (
        <div className="ab-tip-row" key={i}>
          {r.color && <i className="ab-swatch" style={{ background: r.color }} />}
          {r.text}
        </div>
      ))}
    </div>
  );
}

function pointer(e: React.MouseEvent, box: HTMLElement | null) {
  const r = box?.getBoundingClientRect();
  return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
}

const niceTicks = (lo: number, hi: number, count: number) => {
  const span = hi - lo || 1;
  const raw = span / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const out: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) out.push(Math.round(v / step) * step);
  return out;
};

/* ------------------------------------------------------------------------- */

export interface ForestRow {
  key: string;
  label: string;
  primary: boolean;
  uplift: number;
  lo: number;
  hi: number;
  detail: string[];
}

/** Kenaikan B terhadap A per metrik, dengan rentang 95%, terhadap garis nol. */
export function ForestPlot({ rows }: { rows: ForestRow[] }) {
  const [ref, W] = useWidth();
  const [tip, setTip] = useState<Tip | null>(null);
  const rowH = 58;
  const top = 6;
  const H = top + rows.length * rowH + 24;
  const ticks = niceTicks(Math.min(0, ...rows.map((r) => r.lo)), Math.max(0, ...rows.map((r) => r.hi)), W < 480 ? 4 : 7);
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const x = (v: number) => 8 + ((v - lo) / (hi - lo || 1)) * (W - 16);
  const color = (r: ForestRow) =>
    r.lo > 0 ? AB_COLORS.ok : r.hi < 0 ? AB_COLORS.bad : r.primary ? AB_COLORS.b : AB_COLORS.a;

  return (
    <div className="ab-chart" ref={ref} onMouseLeave={() => setTip(null)}>
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Kenaikan B dibanding A per metrik dengan rentang 95%">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={top} y2={H - 22} stroke={AB_COLORS.grid} />
            <text x={x(t)} y={H - 6} textAnchor="middle" className="ab-tick">
              {fmt.signed(t, 0)}
            </text>
          </g>
        ))}
        <line x1={x(0)} x2={x(0)} y1={top} y2={H - 22} stroke={AB_COLORS.axis} strokeWidth={1.5} />
        {rows.map((r, i) => {
          const y = top + i * rowH;
          const c = color(r);
          return (
            <g
              key={r.key}
              className="ab-hover"
              onMouseMove={(e) => {
                const p = pointer(e, ref.current);
                setTip({ ...p, head: r.label, rows: r.detail.map((text) => ({ text })) });
              }}
            >
              <rect x={0} y={y} width={W} height={rowH} fill="transparent" />
              <text x={8} y={y + 17} className={r.primary ? "ab-label ab-strong" : "ab-label"}>
                {r.label}
                {r.primary ? " · metrik utama" : ""}
              </text>
              <text x={W - 8} y={y + 17} textAnchor="end" className="ab-tick">
                {fmt.signed(r.uplift)} ({fmt.signed(r.lo, 0)} s/d {fmt.signed(r.hi, 0)})
              </text>
              <line x1={x(r.lo)} x2={x(r.hi)} y1={y + 38} y2={y + 38} stroke={c} strokeOpacity={0.35} strokeWidth={r.primary ? 10 : 7} strokeLinecap="round" />
              <circle cx={x(r.uplift)} cy={y + 38} r={r.primary ? 7 : 5.5} fill={c} stroke="#fff" strokeWidth={2} />
            </g>
          );
        })}
      </svg>
      <Tooltip tip={tip} width={W} />
    </div>
  );
}

/* ------------------------------------------------------------------------- */

/** Satu batang: peluang A lebih baik di kiri, B di kanan. */
export function ProbabilityBar({ probB }: { probB: number }) {
  const a = 1 - probB;
  return (
    <div className="ab-prob" role="img" aria-label={`Peluang B lebih baik ${fmt.pct(probB, 0)}`}>
      <div className="ab-prob-bar">
        <span style={{ width: `${a * 100}%`, background: AB_COLORS.a }} />
        <span style={{ width: `${probB * 100}%`, background: AB_COLORS.b }} />
        <i className="ab-prob-mark" style={{ left: "95%" }} title="Ambang 95%" />
      </div>
      <div className="ab-prob-legend">
        <span>A lebih baik {fmt.pct(a, 0)}</span>
        <span>B lebih baik {fmt.pct(probB, 0)}</span>
      </div>
    </div>
  );
}

/** Kemajuan terhadap target, dengan penanda di 100%. */
export function ProgressRow({ label, value, target, color, suffix }: { label: string; value: number; target: number; color: string; suffix: ReactNode }) {
  const share = target > 0 ? Math.min(1, value / target) : 0;
  return (
    <div className="ab-progress">
      <div className="ab-progress-head">
        <span>{label}</span>
        <span className="ab-num">{suffix}</span>
      </div>
      <div className="ab-track" role="progressbar" aria-valuemin={0} aria-valuemax={target} aria-valuenow={value} aria-label={label}>
        <span style={{ width: `${share * 100}%`, background: color }} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- */

export interface FunnelStep {
  label: string;
  a: number;
  b: number;
}

/** Dua batang per langkah dari satu tepi kiri, persentase dari visitor. */
export function FunnelChart({ steps }: { steps: FunnelStep[] }) {
  const [ref, W] = useWidth();
  const [tip, setTip] = useState<Tip | null>(null);
  const baseA = steps[0]?.a || 1;
  const baseB = steps[0]?.b || 1;
  const max = Math.max(...steps.map((s) => Math.max(s.a, s.b)), 1);
  const labelW = W < 480 ? 0 : 150;
  const barW = W - labelW - 130;
  const rowH = W < 480 ? 66 : 50;
  const H = steps.length * rowH;
  const bar = (n: number) => Math.max(3, (n / max) * barW);

  return (
    <div className="ab-chart" ref={ref} onMouseLeave={() => setTip(null)}>
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Funnel visitor sampai order, A dibanding B">
        {steps.map((s, i) => {
          const y = i * rowH + (labelW ? 6 : 22);
          const prev = steps[i - 1];
          const stepA = prev && prev.a ? s.a / prev.a : null;
          const stepB = prev && prev.b ? s.b / prev.b : null;
          return (
            <g key={s.label}>
              <text x={0} y={labelW ? y + 16 : y - 6} className="ab-label">
                {s.label}
              </text>
              {(["a", "b"] as const).map((k, j) => {
                const n = s[k];
                const base = k === "a" ? baseA : baseB;
                const by = y + j * 18;
                const w = bar(n);
                const color = k === "a" ? AB_COLORS.a : AB_COLORS.b;
                const step = k === "a" ? stepA : stepB;
                return (
                  <g
                    key={k}
                    className="ab-hover"
                    onMouseMove={(e) => {
                      const p = pointer(e, ref.current);
                      setTip({
                        ...p,
                        head: `${s.label} · ${k.toUpperCase()}`,
                        rows: [
                          { color, text: `${fmt.int(n)} visitor` },
                          { text: `${fmt.pct(n / base)} dari semua visitor` },
                          ...(step !== null ? [{ text: `${fmt.pct(step, 1)} dari langkah sebelumnya` }] : []),
                        ],
                      });
                    }}
                  >
                    <rect x={labelW} y={by} width={w} height={14} rx={4} fill={color} />
                    <text x={labelW + w + 8} y={by + 11} className="ab-tick ab-num">
                      {k.toUpperCase()} {fmt.int(n)} · {i === 0 ? "100%" : fmt.pct(n / base, 1)}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
      <Tooltip tip={tip} width={W} />
    </div>
  );
}

/* ------------------------------------------------------------------------- */

export interface TrendPoint {
  t: string;
  variant: string;
  visitors: number;
  orders: number;
}

/**
 * Konversi kumulatif per periode (garis) di atas visitor baru per periode
 * (batang kecil). Kumulatif, bukan per periode: per jam isinya hampir selalu
 * 0 order, dan garis yang melompat 0%↔5% tidak menjelaskan apa-apa.
 */
export function TrendChart({ points, hourly }: { points: TrendPoint[]; hourly: boolean }) {
  const [ref, W] = useWidth();
  const [tip, setTip] = useState<Tip | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const times = [...new Set(points.map((p) => p.t))].sort();
  if (times.length < 2) {
    return <p className="ab-empty">Grafik muncul setelah data terkumpul di dua periode atau lebih.</p>;
  }
  const series = (["A", "B"] as const).map((v) => {
    let vis = 0;
    let ord = 0;
    return times.map((t) => {
      const p = points.find((q) => q.t === t && q.variant === v);
      const add = p?.visitors ?? 0;
      vis += add;
      ord += p?.orders ?? 0;
      return { t, v, add, vis, ord, cvr: vis ? ord / vis : 0 };
    });
  });

  const m = { l: 46, r: 70, t: 10 };
  const lineH = 170;
  const barTop = m.t + lineH + 26;
  const barH = 56;
  const H = barTop + barH + 22;
  const x = (i: number) => m.l + (i / (times.length - 1)) * (W - m.l - m.r);
  const yTicks = niceTicks(0, Math.max(...series.flat().map((s) => s.cvr), 0.001), 4);
  const yMax = yTicks[yTicks.length - 1];
  const y = (v: number) => m.t + lineH - (v / yMax) * lineH;
  const maxAdd = Math.max(...series.flat().map((s) => s.add), 1);
  const slot = (W - m.l - m.r) / times.length;
  const bw = Math.max(1, Math.min(10, slot / 2 - 1));
  const label = (t: string) =>
    new Intl.DateTimeFormat("id-ID", hourly
      ? { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit" }
      : { timeZone: "Asia/Jakarta", day: "numeric", month: "short" }).format(new Date(t));
  const every = Math.ceil(times.length / (W < 480 ? 4 : 8));
  const colors = [AB_COLORS.a, AB_COLORS.b];
  const ends = series
    .map((s, i) => ({ i, last: s[s.length - 1] }))
    .sort((p, q) => y(p.last.cvr) - y(q.last.cvr));
  // Label ujung garis didorong turun supaya tidak saling menimpa.
  const endY = ends.reduce<Array<(typeof ends)[number] & { yy: number }>>(
    (out, e) => [...out, { ...e, yy: Math.max(y(e.last.cvr) + 4, (out.at(-1)?.yy ?? -Infinity) + 15) }],
    [],
  );

  const onMove = (e: React.MouseEvent) => {
    const p = pointer(e, ref.current);
    const i = Math.max(0, Math.min(times.length - 1, Math.round(((p.x - m.l) / (W - m.l - m.r)) * (times.length - 1))));
    setTip({
      ...p,
      head: hourly ? `s/d ${label(new Date(new Date(times[i]).getTime() + 36e5).toISOString())} WIB` : label(times[i]),
      rows: series.map((s, k) => ({
        color: colors[k],
        text: `${k ? "B" : "A"}: ${fmt.pct(s[i].cvr)} · ${fmt.int(s[i].ord)} order / ${fmt.int(s[i].vis)} · +${fmt.int(s[i].add)} visitor`,
      })),
    });
    setHover(i);
  };

  return (
    <div className="ab-chart" ref={ref} onMouseLeave={() => { setTip(null); setHover(null); }}>
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Konversi kumulatif A dan B dari waktu ke waktu">
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={m.l} x2={W - m.r} y1={y(t)} y2={y(t)} stroke={AB_COLORS.grid} />
            <text x={m.l - 8} y={y(t) + 4} textAnchor="end" className="ab-tick">
              {fmt.pct(t, 1)}
            </text>
          </g>
        ))}
        {series.map((s, k) => (
          <path
            key={k}
            d={s.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.cvr)}`).join("")}
            fill="none"
            stroke={colors[k]}
            strokeWidth={k ? 2.5 : 2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {endY.map((e) => (
          <g key={e.i}>
            <circle cx={x(times.length - 1)} cy={y(e.last.cvr)} r={3.5} fill={colors[e.i]} />
            <text x={W - m.r + 8} y={e.yy} className="ab-label ab-num">
              {e.i ? "B" : "A"} {fmt.pct(e.last.cvr)}
            </text>
          </g>
        ))}
        <text x={m.l} y={barTop - 8} className="ab-tick">
          Visitor baru per {hourly ? "jam" : "hari"}
        </text>
        {series.map((s, k) =>
          s.map((p, i) => {
            const h = (p.add / maxAdd) * barH;
            return (
              <rect
                key={`${k}-${i}`}
                x={x(i) - bw + k * bw}
                y={barTop + barH - h}
                width={Math.max(1, bw - 0.5)}
                height={h}
                rx={1.5}
                fill={colors[k]}
                opacity={hover === null || hover === i ? 1 : 0.45}
              />
            );
          }),
        )}
        {times.map((t, i) =>
          i % every === 0 ? (
            <text key={t} x={x(i)} y={H - 4} textAnchor="middle" className="ab-tick">
              {label(t)}
            </text>
          ) : null,
        )}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={m.t} y2={barTop + barH} stroke={AB_COLORS.axis} />}
        <rect x={m.l - 6} y={m.t} width={W - m.l - m.r + 12} height={barTop + barH - m.t} fill="transparent" onMouseMove={onMove} />
      </svg>
      <Tooltip tip={tip} width={W} />
    </div>
  );
}

/* ------------------------------------------------------------------------- */

export const chartStyles = `
.ab-chart { position: relative; width: 100%; }
.ab-chart svg { display: block; overflow: visible; font-family: inherit; }
.ab-tick { font-size: 11px; fill: ${AB_COLORS.muted}; font-variant-numeric: tabular-nums; }
.ab-label { font-size: 13px; fill: ${AB_COLORS.text}; }
.ab-strong { font-weight: 650; }
.ab-num { font-variant-numeric: tabular-nums; }
/* Teks grafik tetap terbaca saat dilintasi garis grid atau garis nol. */
.ab-chart text { paint-order: stroke; stroke: #fff; stroke-width: 4px; stroke-linejoin: round; }
.ab-hover { cursor: default; }
.ab-tip { position: absolute; z-index: 20; pointer-events: none; background: #fff; border: 1px solid #e3e3e3; border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0,0,0,.12); padding: 8px 10px; font-size: 12px; display: grid; gap: 3px; min-width: 160px; max-width: 220px; color: ${AB_COLORS.text}; }
.ab-tip-head { color: ${AB_COLORS.muted}; }
.ab-tip-row { display: flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; }
.ab-swatch { width: 9px; height: 9px; border-radius: 2px; display: inline-block; flex: none; }
.ab-empty { color: ${AB_COLORS.muted}; font-size: 13px; margin: 8px 0; }
.ab-hero-value { font-size: 40px; line-height: 1.05; font-weight: 650; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.ab-kpi-value { font-size: 24px; line-height: 1.15; font-weight: 650; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
.ab-kpi-sub { font-size: 12px; color: ${AB_COLORS.muted}; font-variant-numeric: tabular-nums; }
.ab-legend { display: flex; flex-wrap: wrap; gap: 14px; font-size: 12px; color: ${AB_COLORS.muted}; }
.ab-legend span { display: inline-flex; align-items: center; gap: 6px; }
.ab-prob { display: grid; gap: 6px; }
.ab-prob-bar { position: relative; display: flex; height: 12px; border-radius: 999px; overflow: hidden; background: ${AB_COLORS.grid}; }
.ab-prob-bar > span { display: block; height: 100%; transition: width 400ms ease-out; }
.ab-prob-mark { position: absolute; top: -2px; bottom: -2px; width: 2px; background: ${AB_COLORS.text}; opacity: .55; }
.ab-prob-legend { display: flex; justify-content: space-between; font-size: 12px; color: ${AB_COLORS.muted}; font-variant-numeric: tabular-nums; }
.ab-progress { display: grid; gap: 6px; }
.ab-progress-head { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; color: ${AB_COLORS.muted}; }
.ab-track { height: 8px; border-radius: 999px; background: ${AB_COLORS.grid}; overflow: hidden; }
.ab-track > span { display: block; height: 100%; border-radius: 999px; transition: width 400ms ease-out; }
@media (prefers-reduced-motion: reduce) { .ab-prob-bar > span, .ab-track > span { transition: none; } }
`;
