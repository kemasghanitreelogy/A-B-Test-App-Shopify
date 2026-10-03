const idr = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});
const int = new Intl.NumberFormat("id-ID");

export const fmtInt = (n: number) => int.format(Math.round(n));
export const fmtIdr = (n: number) => idr.format(n);
export const fmtPct = (n: number, digits = 2) => `${(n * 100).toFixed(digits)}%`;

/** Peluang yang sudah membulat ke 100% atau 0% menyiratkan kepastian yang tidak
 *  pernah dihasilkan uji statistik, jadi kedua ujungnya ditulis sebagai batas. */
export function fmtProb(p: number): string {
  if (p >= 0.9995) return ">99.9%";
  if (p <= 0.0005) return "<0.1%";
  return `${(p * 100).toFixed(1)}%`;
}

export function fmtSigned(n: number, digits = 1): string {
  const value = (n * 100).toFixed(digits);
  return `${n >= 0 ? "+" : ""}${value}%`;
}

/** Angka besar yang perlu terbaca sekilas: 55.240 -> 55,2rb */
export function fmtCompact(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(".", ",")}jt`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1).replace(".", ",")}rb`;
  return int.format(n);
}

export function fmtDate(value: string | Date, lang: "id" | "en" = "id"): string {
  return new Intl.DateTimeFormat(lang === "en" ? "en-GB" : "id-ID", { dateStyle: "medium", timeZone: "Asia/Jakarta" }).format(new Date(value));
}
