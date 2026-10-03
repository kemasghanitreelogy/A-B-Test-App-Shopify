// ============================================================================
// FILE INI DIHASILKAN OTOMATIS — JANGAN DIEDIT DI SINI.
// Sumber: app/lib/i18n.ts
// Untuk mengubahnya: edit file sumber, lalu jalankan dari root repo:
//     node scripts/sync-dashboard.mjs
// ============================================================================

/**
 * Dua bahasa untuk dashboard: Indonesia (default) dan Inggris.
 *
 * Sengaja tanpa kamus berkunci. Aplikasi internal dengan dua bahasa lebih mudah
 * dirawat kalau kedua teks ditulis berdampingan di tempat ia dipakai:
 *
 *   const t = tr(lang);
 *   t("Belum ada pemenang", "No winner yet")
 *
 * Teks yang dibuat di server (app Fly) lalu dikirim ke dashboard memakai `Bi`
 * — pasangan {id, en} — supaya dashboard tinggal memilih sesuai bahasa pembaca.
 *
 * File ini bebas dependency dan disalin ke dashboard oleh sync-dashboard.
 */

export type Lang = "id" | "en";

export const LANGS: readonly Lang[] = ["id", "en"];
export const DEFAULT_LANG: Lang = "id";
/** cookie tempat pilihan bahasa disimpan, dibaca server supaya render pertama sudah benar */
export const LANG_COOKIE = "tl_lang";

export function parseLang(value: unknown): Lang {
  return value === "en" ? "en" : DEFAULT_LANG;
}

/** Pasangan teks dua bahasa. */
export interface Bi {
  id: string;
  en: string;
}

export const bi = (id: string, en: string): Bi => ({ id, en });

/** Pilih satu teks dari pasangan; menerima string biasa untuk data lama. */
export function pick(lang: Lang, value: Bi | string | null | undefined): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return lang === "en" ? value.en : value.id;
}

/** Pembuat fungsi penerjemah: `t(indonesia, english)`. */
export function tr(lang: Lang) {
  return (id: string, en: string): string => (lang === "en" ? en : id);
}

/** Locale Intl untuk tanggal & teks. Angka uang tetap format Indonesia (IDR). */
export function intlLocale(lang: Lang): string {
  return lang === "en" ? "en-GB" : "id-ID";
}
