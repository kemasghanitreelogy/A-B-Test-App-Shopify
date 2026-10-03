/**
 * Jalur event perilaku first-party (cart drawer). Fungsi murni saja — tanpa DB.
 *   node --import ./scripts/ts-resolve.mjs scripts/verify-track.mjs
 */
import { parseTrackEvent, featureProps, TRACK_EVENTS } from "../app/lib/track.ts";
import { flagKeyFor } from "../app/lib/posthog/taxonomy.ts";

let failed = 0;
const results = [];
const check = (label, ok, detail = "") => { results.push({ label, ok: !!ok, detail }); if (!ok) failed++; };
const now = new Date("2026-10-01T03:00:00Z");
const base = { id: "a1b2c3d4-0000-4000-8000-000000000001", n: "cart_open", s: "cart_drawer", ui: "v3", a: "header", t: now.getTime() - 1000 };

const row = parseTrackEvent(base, now);
check("event sah diterima", row && row.name === "cart_open" && row.ui === "v3" && row.action === "header");
check("nama event di luar kontrak ditolak", parseTrackEvent({ ...base, n: "purchase" }, now) === null);
check("uuid wajib & berbentuk wajar", parseTrackEvent({ ...base, id: "x" }, now) === null && parseTrackEvent({ ...base, id: "<script>" }, now) === null);
check("surface di luar kontrak ditolak", parseTrackEvent({ ...base, s: "checkout" }, now) === null);
check("jam klien di masa depan → waktu terima", parseTrackEvent({ ...base, t: now.getTime() + 3600_000 }, now).occurredAt.getTime() === now.getTime());
check("event > 8 hari ditolak (antrean klien membuangnya di 7 hari)", parseTrackEvent({ ...base, t: now.getTime() - 9 * 86400_000 }, now) === null);
check("event 6 hari dari antrean offline tetap diterima", parseTrackEvent({ ...base, t: now.getTime() - 6 * 86400_000 }, now) !== null);
check("detail dipotong 200, angka divalidasi", (() => { const r = parseTrackEvent({ ...base, d: "x".repeat(500), val: 795000, ms: 12.7 }, now); return r.detail.length === 200 && r.value === 795000 && r.ms === 13; })());
check("nilai bukan angka → null", parseTrackEvent({ ...base, val: "795000", ms: "x" }, now).value === null);
check("variant_id angka diterima sebagai teks", parseTrackEvent({ ...base, v: 44527085650108 }, now).variantId === "44527085650108");
check("semua 11 nama kontrak terdaftar", TRACK_EVENTS.size === 11);
const fp = featureProps("cdexp:B,exp1:A,rusak");
check("keanggotaan A/B → properti $feature PostHog", fp[`$feature/${flagKeyFor("cdexp")}`] === "test" && fp[`$feature/${flagKeyFor("exp1")}`] === "control" && Object.keys(fp).length === 2);

for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"}  ${r.label}${!r.ok && r.detail ? `  — ${r.detail}` : ""}`);
console.log(`\n  ${results.length - failed}/${results.length} lolos`);
if (failed) { console.log("GAGAL"); process.exit(1); }
console.log("OK — jalur track first-party konsisten.");
