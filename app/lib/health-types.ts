/**
 * Kontrak panel kesehatan pipeline — dibagi ke dashboard lewat sync-dashboard.
 *
 * Bebas dependency dan efek samping. Definisi invariant ada di health.server.ts;
 * di sini hanya bentuk data yang dibaca dashboard.
 */

import type { Bi } from "./i18n";

export type HealthStatus = "ok" | "warn" | "fail" | "info";

export interface HealthCheckResult {
  /** I1 … I15 */
  id: string;
  /** judul pendek untuk baris panel */
  label: Bi;
  status: HealthStatus;
  /** angka utama (rasio, hitungan, detik) — null kalau tidak berlaku */
  value: number | null;
  /** teks siap tampil: angka + konteksnya */
  detail: Bi;
  /** true = kalau fail, hasil eksperimen otomatis "tidak bisa dipakai" */
  critical: boolean;
  checkedAt: string;
}

export interface SourceCoverage {
  /** storefront | pixel | webhook */
  source: string;
  label: Bi;
  lastSeenAt: string | null;
  /** angka 24 jam terakhir, label sudah termasuk satuannya */
  figure: Bi;
}

export interface HealthReport {
  experimentId: string;
  generatedAt: string;
  checks: HealthCheckResult[];
  coverage: SourceCoverage[];
  /** true kalau ada check kritis yang fail */
  untrusted: boolean;
  /** true kalau template A dan B identik (I9) */
  aaTest: boolean;
}

/** Check yang, kalau gagal, membuat hasil eksperimen tidak boleh dipercaya. */
export const CRITICAL_CHECKS = new Set(["I1", "I2", "I7", "I8", "I10", "I15"]);
