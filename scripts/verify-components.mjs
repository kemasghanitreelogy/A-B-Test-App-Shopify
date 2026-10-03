/**
 * Pengujian eksperimen KOMPONEN (claudedocs/SPEC-component-experiments.md).
 *
 * Menjalankan tl-ab-core.liquid yang sebenarnya di DOM tiruan, plus registry,
 * preflight tema, dan pembentuk config di server. Setiap baris matriks cakupan
 * di SPEC §3 punya minimal satu pengujian di sini.
 *
 *   node --import ./scripts/ts-resolve.mjs scripts/verify-components.mjs
 */
import { readFileSync } from "node:fs";
import { runScript, baseConfig } from "./harness.mjs";
import { COMPONENTS, evaluateComponentReadiness, ATTR_COMPONENT_EXPERIMENTS } from "../app/lib/components.ts";
import { buildStorefrontConfig } from "../app/lib/config.server.ts";
import { parseAttribution } from "../app/lib/attribution.ts";
import { bucketOf } from "../app/lib/bucketing.ts";

let failed = 0;
const results = [];
function check(label, condition, detail = "") {
  results.push({ label, ok: Boolean(condition), detail });
  if (!condition) failed++;
}
const tick = () => new Promise((r) => setImmediate(r));

const ATTR = "_tl_abc_cart_drawer";
const EXP = "cdexp";
const componentExp = { id: EXP, k: "tl-ab-cdexp", s: 50, a: "", b: "", h: [], x: [], t: "c", c: "cart_drawer", at: ATTR };
const cfg = (ex = [componentExp], extra = {}) => ({ ...baseConfig, ex, ...extra });
const ctx = (abc = {}, extra = {}) => ({
  pageType: "index",
  suffix: "",
  handle: "",
  productId: "",
  designMode: false,
  abc: { _: 0, ...abc },
  ...extra,
});

let VID_B = "";
let VID_A = "";
for (let i = 0; !VID_B || !VID_A; i++) {
  const v = `vid-${i}`;
  if (bucketOf(v, EXP, 50) === "B" && !VID_B) VID_B = v;
  if (bucketOf(v, EXP, 50) === "A" && !VID_A) VID_A = v;
}
const cookieFor = (vid) => `_tl_vid=${vid}`;

const updates = (log) =>
  log.fetches.filter((f) => f.url === "/cart/update.js").map((f) => JSON.parse(f.init.body).attributes);
const beaconEvents = (log) => log.beacons.flatMap((b) => JSON.parse(b.body).ev || []);

/* ---------- 1. Registry & kontrak ---------- */
{
  const liquid = readFileSync("extensions/tl-ab-embed/snippets/tl-ab-core.liquid", "utf8");
  const selectorBlock = liquid.match(/COMPONENT_OPEN_SELECTOR = \{([^}]*)\}/)?.[1] ?? "";
  for (const c of Object.values(COMPONENTS)) {
    check(`registry: atribut ${c.key} mengikuti konvensi _tl_abc_<key> yang dipakai skrip`, c.attribute === `_tl_abc_${c.key}`);
    check(`registry: skrip storefront tahu cara mendeteksi ${c.key} dibuka`, selectorBlock.includes(`${c.key}:`));
  }
  check("atribut keanggotaan = _tl_abx (dibaca webhook & pixel)", ATTR_COMPONENT_EXPERIMENTS === "_tl_abx");
  const pixel = readFileSync("extensions/tl-ab-pixel/src/index.js", "utf8");
  check("pixel membaca _tl_abx", pixel.includes('"_tl_abx"'));
  const block = readFileSync("extensions/tl-ab-embed/blocks/ab-test.liquid", "utf8");
  check("embed block mengirim atribut _tl_abc_* yang dirender ke skrip", block.includes("'_tl_abc_'") && block.includes("abc:"));
}

/* ---------- 2. Preflight tema ---------- */
{
  const c = COMPONENTS.cart_drawer;
  const good = {};
  for (const f of c.requiredFiles) good[f] = "ada";
  for (const k of c.checks) good[k.file] = `${good[k.file] ?? ""} … ${k.contains} …`; // one file can carry several checks
  check("preflight: tema lengkap → siap", evaluateComponentReadiness(c, good).ok);
  const r1 = evaluateComponentReadiness(c, { ...good, "templates/cart.mini.liquid": "{% render 'CartDrawerContent' %}" });
  check("preflight: cart.mini tanpa saklar → DITOLAK", !r1.ok && r1.problems[0].reason === "missing_switch");
  const r2 = evaluateComponentReadiness(c, { ...good, "snippets/tl-abx-cart_drawer-shell.liquid": null });
  check("preflight: entry varian B hilang → DITOLAK", !r2.ok && r2.problems[0].reason === "missing_file");
  const r3 = evaluateComponentReadiness(c, {
    ...good,
    "sections/Header.liquid": "{% render 'cart-drawer-arm', part: 'shell' %} {% render 'MiniCart' %}",
  });
  check("preflight: Header masih merender MiniCart langsung (jalur pintas) → DITOLAK", !r3.ok && r3.problems[0].reason === "bypass");
}

/* ---------- 3. Config server ---------- */
{
  const now = new Date();
  const base = {
    shop: "s", name: "n", hypothesis: null, status: "running", targetType: "all_products", targetIds: [], targetHandles: [],
    excludeHandles: [], variantASuffix: null, variantBSuffix: "", variantBChecksum: null, variantAChecksum: null, splitPctB: 50,
    primaryMetric: "cvr", mdeRelative: 0.2, minSampleArm: 1, startedAt: now, endedAt: null, posthogExperimentId: null,
    posthogFeatureFlagKey: null, posthogFeatureFlagId: null, posthogExposureEvent: null, posthogSyncedAt: null,
    posthogSyncError: null, createdAt: now, updatedAt: now,
  };
  const out = buildStorefrontConfig(
    [
      { ...base, id: "c1", kind: "component", component: "cart_drawer" },
      { ...base, id: "c2", kind: "component", component: "tidak_ada" },
      { ...base, id: "t1", kind: "template", component: null, variantBSuffix: "ab-b" },
    ],
    { enabled: true, proxySubpath: "tl-ab", cookieName: "_tl_vid", cookieDays: 180, cookieDomain: "" },
  );
  const c1 = out.ex.find((e) => e.id === "c1");
  check("config: eksperimen komponen dikirim dengan t/c/at", c1 && c1.t === "c" && c1.c === "cart_drawer" && c1.at === ATTR);
  check("config: komponen tidak dikenal TIDAK dikirim ke storefront", !out.ex.some((e) => e.id === "c2"));
  const t1 = out.ex.find((e) => e.id === "t1");
  check("config: eksperimen template tidak berubah (tanpa t)", t1 && t1.b === "ab-b" && !("t" in t1));
}

/* ---------- 4. Pendaratan pertama grup B: tulis atribut, muat ulang SEKALI ---------- */
{
  const { log } = runScript({ config: cfg(), ctx: ctx(), cookies: cookieFor(VID_B), drawer: true });
  await tick();
  const u = updates(log);
  check("B, belum ada atribut → /cart/update.js menulis _tl_abc_cart_drawer=B", u.some((a) => a[ATTR] === "B"), JSON.stringify(u));
  check("B, halaman merender A → dimuat ulang sekali", log.replaced !== null);
}
{
  const { log } = runScript({
    config: cfg(),
    ctx: ctx(),
    cookies: cookieFor(VID_B),
    drawer: true,
    sessionStorage: { _tl_abc_rl: JSON.stringify({ [ATTR]: "B" }) },
  });
  await tick();
  check("penjaga loop: sudah pernah reload untuk nilai ini → TIDAK reload lagi", log.replaced === null);
}

/* ---------- 5. Grup A & grup B yang sudah benar: tidak menyentuh apa pun ---------- */
{
  const { log } = runScript({ config: cfg(), ctx: ctx(), cookies: cookieFor(VID_A), drawer: true });
  await tick();
  check("A tanpa atribut → tidak menulis, tidak reload", updates(log).length === 0 && log.replaced === null);
}
{
  const { log } = runScript({ config: cfg(), ctx: ctx({ [ATTR]: "B" }), cookies: cookieFor(VID_B), drawer: true });
  await tick();
  check("B dengan atribut B → tidak menulis, tidak reload", updates(log).length === 0 && log.replaced === null);
}

/* ---------- 6. Exposure hanya saat drawer DIBUKA ---------- */
{
  const run = runScript({ config: cfg(), ctx: ctx({ [ATTR]: "B" }), cookies: cookieFor(VID_B), drawer: true });
  await tick();
  check("belum dibuka → belum ada exposure", !beaconEvents(run.log).some((e) => e.t === "exposure"));
  run.openDrawer();
  await tick();
  const ev = beaconEvents(run.log);
  check("drawer dibuka → exposure varian B", ev.some((e) => e.t === "exposure" && e.e === EXP && e.v === "B"), JSON.stringify(ev));
  check("exposure menandai keranjang: _tl_abx = exp:B", updates(run.log).some((a) => a._tl_abx === `${EXP}:B`));
  check(
    "exposure disiarkan ke GTM/pixel sebagai tl_ab:experience_impression",
    run.log.published.some((p) => p.name === "tl_ab:experience_impression" && p.data.experiment_id === EXP),
  );
  run.openDrawer();
  await tick();
  check("dibuka lagi di halaman yang sama → tidak ada exposure ganda", beaconEvents(run.log).filter((e) => e.t === "exposure").length === 1);
}
{
  const run = runScript({ config: cfg(), ctx: ctx(), cookies: cookieFor(VID_A), drawer: true });
  run.openDrawer();
  await tick();
  check("grup A juga terhitung saat membuka drawer (pemicu identik)", beaconEvents(run.log).some((e) => e.t === "exposure" && e.v === "A"));
}

/* ---------- 7. Varian yang terlihat ≠ penugasan → render_mismatch, BUKAN exposure ---------- */
{
  const run = runScript({
    config: cfg(),
    ctx: ctx(),
    cookies: cookieFor(VID_B),
    drawer: true,
    sessionStorage: { _tl_abc_rl: JSON.stringify({ [ATTR]: "B" }) },
  });
  run.openDrawer();
  await tick();
  const ev = beaconEvents(run.log);
  check("B tapi halaman merender A → render_mismatch", ev.some((e) => e.t === "render_mismatch" && e.v === "B"));
  check("… dan TIDAK dihitung sebagai exposure", !ev.some((e) => e.t === "exposure"));
}

/* ---------- 8. Kill switch, jeda, selesai: atribut dikembalikan ke A ---------- */
{
  const { log } = runScript({ config: cfg([componentExp], { on: false }), ctx: ctx({ [ATTR]: "B" }), cookies: cookieFor(VID_B), drawer: true });
  await tick();
  check("kill switch → atribut dikosongkan", updates(log).some((a) => a[ATTR] === ""));
  check("kill switch → halaman B dimuat ulang ke A", log.replaced !== null);
}
{
  const { log } = runScript({ config: cfg([]), ctx: ctx({ [ATTR]: "B" }), cookies: cookieFor(VID_B), drawer: true });
  await tick();
  check("eksperimen dijeda/selesai (tidak ada di config) → atribut dikosongkan", updates(log).some((a) => a[ATTR] === ""));
}

/* ---------- 9. Perangkat internal: A, atau varian yang dipaksa, tidak pernah dihitung ---------- */
{
  const { log } = runScript({ config: cfg(), ctx: ctx({ [ATTR]: "B" }), cookies: `${cookieFor(VID_B)}; _tl_ab_internal=1`, drawer: true });
  await tick();
  check("internal → dipaksa A (atribut B dikosongkan)", updates(log).some((a) => a[ATTR] === ""));
  check("internal → tidak ada event yang terkirim", log.beacons.length === 0);
}
{
  const { log } = runScript({
    config: cfg(),
    ctx: ctx(),
    url: "https://treelogy.com/?_tl_ab_force=cart_drawer:B",
    cookies: `${cookieFor(VID_A)}; _tl_ab_internal=1`,
    drawer: true,
  });
  await tick();
  check("internal + ?_tl_ab_force=cart_drawer:B → varian B untuk QA", updates(log).some((a) => a[ATTR] === "B"));
  check("… tetap tanpa event", log.beacons.length === 0);
}
{
  const { log } = runScript({ config: cfg(), ctx: ctx(), url: "https://treelogy.com/?_tl_ab_force=cart_drawer:B", cookies: cookieFor(VID_A), drawer: true });
  await tick();
  check("pengunjung biasa TIDAK bisa memaksa varian", !updates(log).some((a) => a[ATTR] === "B"));
}

/* ---------- 10. Bot & consent ---------- */
{
  const { log } = runScript({ config: cfg(), ctx: ctx(), cookies: cookieFor(VID_B), drawer: true, userAgent: "Googlebot/2.1" });
  await tick();
  check("bot → tidak menyentuh keranjang sama sekali", log.fetches.length === 0);
}
{
  const { log } = runScript({
    config: cfg(),
    ctx: ctx({ [ATTR]: "B" }),
    cookies: cookieFor(VID_B),
    drawer: true,
    customerPrivacy: { analyticsProcessingAllowed: () => false },
  });
  await tick();
  check("consent ditolak → kembali ke A, tanpa event", updates(log).some((a) => a[ATTR] === "") && log.beacons.length === 0);
}

/* ---------- 11. Add-to-cart membawa keanggotaan & event funnel ---------- */
{
  const run = runScript({ config: cfg(), ctx: ctx({ [ATTR]: "B", _tl_abx: `${EXP}:B` }), cookies: cookieFor(VID_B), drawer: true });
  await run.sandbox.fetch("/cart/add.js", { method: "POST" });
  await tick();
  check("add-to-cart menulis ulang _tl_abx", updates(run.log).some((a) => a._tl_abx === `${EXP}:B`));
  check("add-to-cart tercatat untuk eksperimen komponen", beaconEvents(run.log).some((e) => e.t === "add_to_cart" && e.e === EXP));
}

/* ---------- 12. Berdampingan dengan eksperimen template ---------- */
{
  const templateExp = { id: "exp1", k: "tl-ab-exp1", s: 50, a: "", b: "ab-b", h: "*", x: [] };
  const run = runScript({
    config: cfg([templateExp, componentExp]),
    ctx: ctx({ [ATTR]: "B", _tl_abx: `${EXP}:B` }, { pageType: "product", handle: "kapsul", productId: "1" }),
    url: "https://treelogy.com/products/kapsul?view=ab-b",
    cookies: cookieFor(VID_B),
    drawer: true,
  });
  await run.sandbox.fetch("/cart/add.js", { method: "POST" });
  await tick();
  const u = updates(run.log).find((a) => a._tl_ab);
  check("template + komponen: add-to-cart membawa _tl_ab DAN _tl_abx", u && u._tl_abx === `${EXP}:B`, JSON.stringify(updates(run.log)));
}

/* ---------- 13. Atribusi order ---------- */
{
  const parsed = parseAttribution([
    { name: "_tl_ab", value: "exp1:A" },
    { name: "_tl_abx", value: `${EXP}:B` },
    { name: "_tl_vid", value: "v1" },
  ]);
  check("webhook: order ikut dua eksperimen (template + komponen)", parsed.assignments.get("exp1") === "A" && parsed.assignments.get(EXP) === "B");
}

for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"}  ${r.label}${!r.ok && r.detail ? `  — ${r.detail}` : ""}`);
console.log(`\n  ${results.length - failed}/${results.length} lolos`);
if (failed) {
  console.log("GAGAL");
  process.exit(1);
}
console.log("OK — eksperimen komponen tercakup penuh.");
