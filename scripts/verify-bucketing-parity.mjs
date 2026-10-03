/**
 * Membuktikan bahwa bucketing di storefront (tl-ab-core.liquid) dan di server
 * (app/lib/bucketing.ts) menghasilkan variant yang sama persis.
 *
 * Kalau keduanya pernah berbeda, variant yang dicatat database bukan variant yang
 * dilihat visitor, dan seluruh hasil eksperimen jadi sampah tanpa ada error yang
 * kelihatan. Karena itu pengecekan ini dijalankan sebagai bagian dari `npm test`.
 */
import { readFileSync } from "node:fs";

// --- implementasi server (disalin dari app/lib/bucketing.ts) ---
function serverFnv1a32(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
function serverBucket(vid, expId, splitPctB) {
  return serverFnv1a32(`${vid}:${expId}`) % 10000 < splitPctB * 100 ? "B" : "A";
}

// --- implementasi storefront: diekstrak langsung dari file liquid ---
const liquid = readFileSync("extensions/tl-ab-embed/snippets/tl-ab-core.liquid", "utf8");
const fnMatch = liquid.match(/function fnv1a32\(str\)\s*\{[\s\S]*?\n  \}/);
const bucketMatch = liquid.match(/function bucketOf\(vid, expId, splitPctB\)\s*\{[\s\S]*?\n  \}/);
if (!fnMatch || !bucketMatch) {
  console.error("GAGAL: fnv1a32/bucketOf tidak ditemukan di tl-ab-core.liquid");
  process.exit(1);
}
const clientBucket = new Function(`${fnMatch[0]}\n${bucketMatch[0]}\nreturn bucketOf;`)();

// --- perbandingan ---
const splits = [10, 25, 50, 75, 90];
const N = 20000;
let mismatches = 0;
const tally = Object.fromEntries(splits.map((s) => [s, { A: 0, B: 0 }]));

for (let i = 0; i < N; i++) {
  const vid = `${i}-${Math.random().toString(36).slice(2)}`;
  for (const s of splits) {
    const a = serverBucket(vid, "exp_test_1", s);
    const b = clientBucket(vid, "exp_test_1", s);
    if (a !== b) mismatches++;
    tally[s][a]++;
  }
}

// Verifikasi juga bahwa distribusinya benar-benar sesuai split yang diminta.
let skewed = false;
for (const s of splits) {
  const pct = (tally[s].B / N) * 100;
  const off = Math.abs(pct - s);
  if (off > 1.5) skewed = true;
  console.log(`  split ${String(s).padStart(2)}% -> B teramati ${pct.toFixed(2)}% (selisih ${off.toFixed(2)} pp)`);
}

// Sticky: visitor yang sama harus selalu dapat variant yang sama.
const vid = "sticky-check";
const first = serverBucket(vid, "exp_test_1", 50);
const sticky = Array.from({ length: 1000 }, () => serverBucket(vid, "exp_test_1", 50)).every((v) => v === first);

console.log(`\n  parity mismatch : ${mismatches}`);
console.log(`  distribusi      : ${skewed ? "MENYIMPANG" : "ok"}`);
console.log(`  sticky          : ${sticky ? "ok" : "GAGAL"}`);

if (mismatches > 0 || skewed || !sticky) {
  console.error("\nGAGAL");
  process.exit(1);
}
console.log("\nOK — storefront dan server sepakat pada semua kasus.");
