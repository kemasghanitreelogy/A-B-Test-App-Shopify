import type { Lang } from "@/lib/i18n";

/** Pembantu format khusus halaman audit. */
export function fmtDuration(seconds: number | null, lang: Lang = "id"): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const s = Math.round(seconds);
  const sec = lang === "en" ? "s" : "d";
  const hr = lang === "en" ? "h" : "j";
  if (s < 60) return `${s}${sec}`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return `${m}m ${rest.toString().padStart(2, "0")}${sec}`;
  return `${Math.floor(m / 60)}${hr} ${(m % 60).toString().padStart(2, "0")}m`;
}

export function fmtMs(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

export function fmtRatio(v: number | null, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}

/** Selisih relatif B terhadap A; null kalau A nol atau salah satu kosong. */
export function relDelta(a: number | null, b: number | null): number | null {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null;
  return (b - a) / a;
}
