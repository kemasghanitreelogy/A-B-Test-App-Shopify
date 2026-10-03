/**
 * Menyalin kode yang harus identik antara app Shopify (Fly.io) dan dashboard (Vercel).
 *
 * Keduanya adalah aplikasi terpisah dengan node_modules sendiri, tapi berbicara ke
 * database yang sama dan harus menghitung statistik dengan cara yang sama persis.
 * Kalau schema atau rumus keduanya pernah berbeda, dashboard akan menampilkan angka
 * yang tidak sesuai kenyataan tanpa memunculkan error apa pun.
 *
 *   node scripts/sync-dashboard.mjs           menyalin
 *   node scripts/sync-dashboard.mjs --check    gagal kalau ada yang drift (dipakai npm test)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const HEADER = `// ============================================================================
// FILE INI DIHASILKAN OTOMATIS — JANGAN DIEDIT DI SINI.
// Sumber: %SRC%
// Untuk mengubahnya: edit file sumber, lalu jalankan dari root repo:
//     node scripts/sync-dashboard.mjs
// ============================================================================

`;

/** @type {Array<{src: string, dest: string, transform?: (s: string) => string, comment?: string}>} */
const FILES = [
  {
    src: "prisma/schema.prisma",
    dest: "dashboard/prisma/schema.prisma",
    // Dashboard hanya membaca/menulis data, tidak pernah menjalankan migrate.
    // directUrl dihapus supaya tidak ada godaan menjalankan migrate dari sana.
    transform: (s) => s.replace(/\n\s*directUrl = env\("DIRECT_URL"\)/, ""),
  },
  { src: "app/lib/stats.ts", dest: "dashboard/lib/stats.ts" },
  { src: "app/lib/bucketing.ts", dest: "dashboard/lib/bucketing.ts" },
  // Registry eksperimen komponen (cart drawer, …): wizard dashboard dan preflight
  // server harus sepakat pada kunci, atribut, dan berkas tema yang diperiksa.
  { src: "app/lib/components.ts", dest: "dashboard/lib/components.ts" },
  // Rencana variant B dari draft theme (pure): wizard menampilkan rencana yang sama persis
  // dengan yang dijalankan server.
  { src: "app/lib/component-variant.ts", dest: "dashboard/lib/component-variant.ts" },
  // Taksonomi event, definisi metric, dan pembaca hasil PostHog: dashboard harus
  // memasangkan hasil PostHog ke metric lokal dengan uuid dan nama yang sama persis.
  { src: "app/lib/posthog/taxonomy.ts", dest: "dashboard/lib/posthog-taxonomy.ts" },
  { src: "app/lib/posthog/analytics-types.ts", dest: "dashboard/lib/posthog-analytics-types.ts" },
  // Dua bahasa (ID/EN): helper bersama app Fly & dashboard.
  { src: "app/lib/i18n.ts", dest: "dashboard/lib/i18n.ts" },
  // Kontrak panel kesehatan pipeline (invariant I1..I14 + coverage per sumber).
  { src: "app/lib/health-types.ts", dest: "dashboard/lib/health-types.ts" },
  {
    src: "app/lib/posthog/metrics.ts",
    dest: "dashboard/lib/posthog-metrics.ts",
    transform: (s) => s.replace('from "./taxonomy"', 'from "./posthog-taxonomy"'),
  },
  {
    src: "app/lib/posthog/results.ts",
    dest: "dashboard/lib/posthog-results.ts",
    transform: (s) =>
      s
        .replace('from "./taxonomy"', 'from "./posthog-taxonomy"')
        .replace('from "./metrics"', 'from "./posthog-metrics"')
        .replace('from "../i18n"', 'from "./i18n"'),
  },
  {
    src: "app/lib/results.server.ts",
    dest: "dashboard/lib/results.ts",
    transform: (s) =>
      s
        .replace('import db from "../db.server";', 'import { db } from "./db";')
        .replace('from "./stats.server"', 'from "./stats"')
        .replace('from "./stats"', 'from "./stats"'),
  },
];

const check = process.argv.includes("--check");
let drift = 0;

for (const file of FILES) {
  const raw = readFileSync(file.src, "utf8");
  const body = file.transform ? file.transform(raw) : raw;
  const header = HEADER.replace("%SRC%", file.src);
  const output = header + body;

  if (check) {
    const current = existsSync(file.dest) ? readFileSync(file.dest, "utf8") : "";
    if (current !== output) {
      console.error(`  DRIFT  ${file.dest}  (sumber: ${file.src})`);
      drift++;
    } else {
      console.log(`  ok     ${file.dest}`);
    }
  } else {
    mkdirSync(dirname(file.dest), { recursive: true });
    writeFileSync(file.dest, output);
    console.log(`  tulis  ${file.dest}`);
  }
}

if (check && drift > 0) {
  console.error(`\n${drift} file tidak sinkron. Jalankan: node scripts/sync-dashboard.mjs`);
  process.exit(1);
}
console.log(check ? "\nOK — dashboard sinkron dengan sumbernya." : "\nSelesai.");
