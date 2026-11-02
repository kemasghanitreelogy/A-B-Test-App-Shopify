/**
 * Membaca template JSON theme Shopify.
 *
 * Shopify menulis header komentar /* ... *\/ "auto-generated" di awal template yang
 * pernah disimpan lewat theme editor atau API. JSON.parse menolak header itu, jadi
 * setiap pembaca template harus mengupasnya dulu. Tanpa ini prepareVariant pernah
 * gagal diam-diam (2 Nov 2026): daftar section jatuh ke [], tidak ada yang
 * diisolasi, dan template B tetap menunjuk section milik variant A.
 */

const HEADER = /^﻿?\s*\/\*[\s\S]*?\*\/\s*/;

/** Isi template tanpa header komentar Shopify (dan BOM). */
export function stripTemplateHeader(templateJson: string): string {
  return templateJson.replace(HEADER, "");
}

/** Semua nama section yang dirujuk sebuah template JSON. JSON rusak -> []. */
export function sectionTypesIn(templateJson: string): string[] {
  try {
    const parsed = JSON.parse(stripTemplateHeader(templateJson)) as {
      sections?: Record<string, { type?: string }>;
    };
    return [
      ...new Set(
        Object.values(parsed.sections ?? {})
          .map((s) => s?.type)
          .filter((t): t is string => typeof t === "string"),
      ),
    ];
  } catch {
    return [];
  }
}
