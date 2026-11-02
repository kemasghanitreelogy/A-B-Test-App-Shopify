/**
 * Template yang pernah disimpan Shopify membawa header komentar /* ... *\/ di awal.
 * sectionTypesIn() dulu memanggil JSON.parse langsung, gagal diam-diam, dan
 * mengembalikan [] — tidak ada section yang diisolasi, sehingga template variant B
 * tetap menunjuk section milik variant A (2 Nov 2026, prepareVariant PDP kapsul).
 */
import { sectionTypesIn } from "../app/lib/template-json.ts";

let failed = 0;
function check(label, ok, detail = "") {
  console.log(`  ${ok ? "ok   " : "GAGAL"} ${label}${ok ? "" : `  ${detail}`}`);
  if (!ok) failed++;
}

const body = JSON.stringify({ sections: { main: { type: "main-product" }, story: { type: "pdp5-story" }, dup: { type: "main-product" } }, order: ["main", "story", "dup"] }, null, 2);
const header = "/*\n * ------------------------------------------------------------\n * IMPORTANT: The contents of this file are auto-generated.\n * ------------------------------------------------------------\n */\n";

check("template tanpa header: semua tipe section terbaca", JSON.stringify(sectionTypesIn(body)) === JSON.stringify(["main-product", "pdp5-story"]), JSON.stringify(sectionTypesIn(body)));
check("template ber-header komentar Shopify: tipe section tetap terbaca", JSON.stringify(sectionTypesIn(header + body)) === JSON.stringify(["main-product", "pdp5-story"]), JSON.stringify(sectionTypesIn(header + body)));
check("header + BOM tetap terbaca", sectionTypesIn("﻿" + header + body).length === 2, JSON.stringify(sectionTypesIn("﻿" + header + body)));
check("JSON rusak tetap [] (tidak melempar)", Array.isArray(sectionTypesIn("{ rusak")) && sectionTypesIn("{ rusak").length === 0);

console.log(failed ? `\n  ${failed} gagal\nADA YANG GAGAL` : "\nOK — tipe section terbaca dari template ber-header.");
process.exitCode = failed ? 1 : 0;
