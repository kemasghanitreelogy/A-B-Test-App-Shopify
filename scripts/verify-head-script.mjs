/**
 * Pengujian perilaku script <head> di DOM tiruan.
 * Menjalankan file .liquid yang sebenarnya dikirim ke browser.
 */
import { runScript, baseConfig, baseCtx } from "./harness.mjs";

let failed = 0;
const results = [];
function check(label, condition, detail = "") {
  results.push({ label, ok: Boolean(condition), detail });
  if (!condition) failed++;
}

// Cari visitor id yang menghasilkan bucket B, supaya pengujian deterministik.
function fnv1a32(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
const bucket = (vid, exp, split) => (split * 100 > fnv1a32(`${vid}:${exp}`) % 10000 ? "B" : "A");
let VID_B = "", VID_A = "";
for (let i = 0; !VID_B || !VID_A; i++) {
  const v = `vid-${i}`;
  if (bucket(v, "exp1", 50) === "B" && !VID_B) VID_B = v;
  if (bucket(v, "exp1", 50) === "A" && !VID_A) VID_A = v;
}

/* ---------- 0. Skrip harus tetap valid SETELAH dibungkus Shopify ----------

   Shopify menyisipkan komentar HTML "BEGIN/END app snippet" di dalam tag script,
   tepat sebelum dan sesudah isi file. Di JavaScript, tanda buka komentar HTML di
   awal baris dibaca sebagai komentar satu baris — kalau baris pertama file berisi
   kode (atau pembuka komentar blok), ia tertelan dan seluruh skrip gagal parse
   di browser tanpa satu pun error yang sampai ke dashboard. Pengujian ini meniru
   pembungkusan itu persis seperti yang terlihat di HTML treelogy.com.          */
{
  const { readFileSync } = await import("node:fs");
  const vm = await import("node:vm");
  const raw = readFileSync("extensions/tl-ab-embed/snippets/tl-ab-core.liquid", "utf8");
  const wrapped = `<!-- BEGIN app snippet: tl-ab-core -->${raw}<!-- END app snippet: tl-ab-core -->`;
  let parseError = "";
  try { new vm.Script(wrapped, { filename: "tl-ab-core.rendered.js" }); } catch (e) { parseError = e.message; }
  check("skrip tetap valid setelah dibungkus komentar app snippet Shopify", parseError === "", parseError);
  check("file dimulai dengan baris kosong (pelindung dari komentar HTML Shopify)", raw.startsWith("\n"));
}

/* ---------- 1. Bucket B harus diarahkan ke alternate template ---------- */
{
  const r = runScript({ config: baseConfig, ctx: baseCtx, cookies: `_tl_vid=${VID_B}` });
  check("bucket B diarahkan ke ?view=ab-b", r.log.replaced?.includes("view=ab-b"), r.log.replaced ?? "(tidak ada redirect)");
}

/* ---------- 2. Bucket A tidak boleh diarahkan ke mana pun ---------- */
{
  const r = runScript({ config: baseConfig, ctx: baseCtx, cookies: `_tl_vid=${VID_A}` });
  check("bucket A tidak diarahkan", r.log.replaced === null, r.log.replaced ?? "");
}

/* ---------- 3. Bucket A yang mendarat di ?view=ab-b dikembalikan ---------- */
{
  const r = runScript({
    config: baseConfig,
    ctx: { ...baseCtx, suffix: "ab-b" },
    url: "https://treelogy.com/products/kapsul?view=ab-b",
    cookies: `_tl_vid=${VID_A}`,
  });
  check("bucket A dikembalikan dari ?view=ab-b", r.log.replaced !== null && !r.log.replaced.includes("view="), r.log.replaced ?? "(tidak ada)");
}

/* ---------- 4. Bucket B yang sudah di template B tidak diarahkan lagi ---------- */
{
  const r = runScript({
    config: baseConfig,
    ctx: { ...baseCtx, suffix: "ab-b" },
    url: "https://treelogy.com/products/kapsul?view=ab-b",
    cookies: `_tl_vid=${VID_B}`,
  });
  check("bucket B sudah di tempat, tidak diarahkan", r.log.replaced === null, r.log.replaced ?? "");
}

/* ---------- 5. Guard: theme editor ---------- */
{
  const r = runScript({ config: baseConfig, ctx: { ...baseCtx, designMode: true }, cookies: `_tl_vid=${VID_B}` });
  check("theme editor tidak kena redirect", r.log.replaced === null && r.log.beacons.length === 0);
}

/* ---------- 6. Guard: crawler ---------- */
{
  const r = runScript({ config: baseConfig, ctx: baseCtx, cookies: `_tl_vid=${VID_B}`, userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1)" });
  check("Googlebot selalu variant A", r.log.replaced === null && r.log.beacons.length === 0);
}
{
  const r = runScript({ config: baseConfig, ctx: baseCtx, cookies: `_tl_vid=${VID_B}`, userAgent: "Mozilla/5.0 Chrome-Lighthouse" });
  check("Lighthouse selalu variant A", r.log.replaced === null);
}

/* ---------- 7. Guard: opt-out QA ---------- */
{
  const r = runScript({ config: baseConfig, ctx: baseCtx, url: "https://treelogy.com/products/kapsul?_tl_ab_off=1", cookies: `_tl_vid=${VID_B}` });
  check("?_tl_ab_off=1 mematikan semuanya", r.log.replaced === null && r.log.beacons.length === 0);
}

/* ---------- 8. Guard: consent ditolak ---------- */
{
  const r = runScript({
    config: baseConfig, ctx: baseCtx, cookies: `_tl_vid=${VID_B}`,
    customerPrivacy: { analyticsProcessingAllowed: () => false },
  });
  check("consent ditolak -> tidak ada cookie & tidak ada redirect", r.log.replaced === null && r.log.cookiesSet.length === 0);
}

/* ---------- 9. Halaman non-produk tidak disentuh ---------- */
{
  const r = runScript({ config: baseConfig, ctx: { ...baseCtx, pageType: "collection" }, cookies: `_tl_vid=${VID_B}` });
  check("halaman koleksi tidak diarahkan", r.log.replaced === null);
}

/* ---------- 10. Kill switch global ---------- */
{
  const r = runScript({ config: { ...baseConfig, on: false }, ctx: baseCtx, cookies: `_tl_vid=${VID_B}` });
  check("kill switch mematikan semuanya", r.log.replaced === null && r.log.cookiesSet.length === 0);
}

/* ---------- 10b. Kill switch TIDAK boleh ikut mematikan analitik ----------

   Kill switch ditekan justru saat ada yang tidak beres. Kalau posthog-js ikut
   mati, session replay dan heatmap — satu-satunya cara melihat apa yang dialami
   pengunjung saat itu — ikut hilang persis ketika paling dibutuhkan.            */
{
  const ph = { t: "phc_test", h: "https://us.i.posthog.com", r: 1, hm: 1 };
  const r = runScript({ config: { ...baseConfig, on: false, ph }, ctx: baseCtx, cookies: `_tl_vid=${VID_B}` });
  check("kill switch: tidak ada redirect", r.log.replaced === null, r.log.replaced ?? "");
  check("kill switch: tidak ada penandaan keranjang",
    !r.log.fetches.some((f) => f.url.includes("/cart/update.js")));
  check("kill switch: posthog-js tetap dimuat", typeof r.sandbox.posthog === "object" && r.sandbox.posthog !== null);
}

/* ---------- 11b. Tanpa eksperimen, PostHog tetap jalan ---------- */
{
  const ph = { t: "phc_test", h: "https://us.i.posthog.com", r: 1, hm: 1 };
  const r = runScript({ config: { ...baseConfig, ex: [], ph }, ctx: baseCtx });
  check("tanpa eksperimen: posthog-js tetap dimuat (analitik situs)",
    typeof r.sandbox.posthog === "object" && r.sandbox.posthog !== null);
  check("tanpa eksperimen: tidak ada event A/B yang dikirim", r.log.beacons.length === 0);
}

/* ---------- 11c. Penanda variant eksperimen lama harus dicabut ----------

   Properti $feature/ bertahan di browser sampai dihapus. Kalau tidak dicabut
   saat eksperimennya berakhir, kunjungan berbulan-bulan sesudahnya masih terhitung
   ke eksperimen itu — dan halaman audit sebuah test yang sudah ditutup akan
   berubah angkanya sendiri.                                                     */
{
  const ph = { t: "phc_test", h: "https://us.i.posthog.com", r: 1, hm: 1 };
  const r = runScript({
    config: { ...baseConfig, ph, ex: [{ ...baseConfig.ex[0], k: "tl-ab-baru" }] },
    ctx: baseCtx,
    cookies: `_tl_vid=${VID_A}`,
    localStorage: { _tl_ab_ph_keys: JSON.stringify(["tl-ab-lama", "tl-ab-baru"]) },
  });
  const calls = (r.sandbox.posthog || []).filter((c) => Array.isArray(c));
  const unregistered = calls.filter((c) => c[0] === "unregister").map((c) => c[1]);
  check("penanda eksperimen yang sudah berakhir dicabut", unregistered.includes("$feature/tl-ab-lama"),
    JSON.stringify(unregistered));
  check("penanda eksperimen yang masih jalan TIDAK dicabut", !unregistered.includes("$feature/tl-ab-baru"),
    JSON.stringify(unregistered));
  const stored = JSON.parse(r.sandbox.localStorage.getItem("_tl_ab_ph_keys") || "[]");
  check("daftar tersimpan hanya berisi yang masih jalan", stored.length === 1 && stored[0] === "tl-ab-baru",
    JSON.stringify(stored));
}

/* ---------- 11. Tanpa eksperimen berjalan ---------- */
{
  const r = runScript({ config: { ...baseConfig, ex: [] }, ctx: baseCtx });
  check("daftar eksperimen kosong -> berhenti seketika", r.log.replaced === null && r.log.cookiesSet.length === 0);
}

/* ---------- 12. Targeting handle ---------- */
{
  const cfg = { ...baseConfig, ex: [{ ...baseConfig.ex[0], h: ["produk-lain"] }] };
  const r = runScript({ config: cfg, ctx: baseCtx, cookies: `_tl_vid=${VID_B}` });
  check("produk di luar target tidak diarahkan", r.log.replaced === null);
}
{
  const cfg = { ...baseConfig, ex: [{ ...baseConfig.ex[0], h: ["kapsul"] }] };
  const r = runScript({ config: cfg, ctx: baseCtx, cookies: `_tl_vid=${VID_B}` });
  check("produk di dalam target diarahkan", r.log.replaced?.includes("view=ab-b"));
}
{
  const cfg = { ...baseConfig, ex: [{ ...baseConfig.ex[0], x: ["kapsul"] }] };
  const r = runScript({ config: cfg, ctx: baseCtx, cookies: `_tl_vid=${VID_B}` });
  check("produk yang dikecualikan tidak diarahkan", r.log.replaced === null);
}

/* ---------- 13. Produk dengan template khusus lain tidak diganggu ---------- */
{
  const r = runScript({ config: baseConfig, ctx: { ...baseCtx, suffix: "context.europe" }, cookies: `_tl_vid=${VID_B}` });
  check("template khusus lain (context.europe) tidak diganggu", r.log.replaced === null, r.log.replaced ?? "");
}

/* ---------- 14. Query param lain harus dipertahankan ---------- */
{
  const r = runScript({
    config: baseConfig, ctx: baseCtx, cookies: `_tl_vid=${VID_B}`,
    url: "https://treelogy.com/products/kapsul?utm_source=meta&variant=42",
  });
  check("utm & variant dipertahankan saat redirect",
    r.log.replaced?.includes("utm_source=meta") && r.log.replaced?.includes("variant=42"),
    r.log.replaced ?? "");
}

/* ---------- 15. Visitor baru: cookie dibuat ---------- */
{
  const r = runScript({ config: baseConfig, ctx: baseCtx, cookies: "" });
  check("visitor baru dapat cookie _tl_vid", r.log.cookiesSet.some((c) => c.startsWith("_tl_vid=")));
}

/* ---------- 16. BAHAYA: cookie ditolak browser (domain tidak cocok) ---------- */
{
  const r = runScript({ config: baseConfig, ctx: baseCtx, cookies: "", cookieDomainRejected: true });
  const written = r.cookieJar().includes("_tl_vid=");
  check("cookie tetap tertulis walau domain ditolak", written,
    written ? "" : "vid gagal disimpan -> tiap pageview jadi visitor baru");
}

/* ---------- 17. BAHAYA: loop redirect saat template B tidak ada ---------- */
{
  // Shopify mengabaikan ?view= kalau templatenya tidak ada, jadi suffix tetap "".
  const r = runScript({
    config: baseConfig, ctx: baseCtx,
    url: "https://treelogy.com/products/kapsul?view=ab-b",
    cookies: `_tl_vid=${VID_B}`,
    storageThrows: true,
  });
  check("template B tidak ada + storage diblokir -> TIDAK loop", r.log.replaced === null,
    r.log.replaced ? `mengarahkan lagi ke ${r.log.replaced} -> LOOP TAK BERUJUNG` : "");
}

/* ---------- 18. Event exposure terkirim ---------- */
{
  const r = runScript({ config: baseConfig, ctx: { ...baseCtx, suffix: "ab-b" }, url: "https://treelogy.com/products/kapsul?view=ab-b", cookies: `_tl_vid=${VID_B}` });
  const body = r.log.beacons[0]?.body ? JSON.parse(r.log.beacons[0].body) : null;
  check("exposure terkirim ke app proxy", r.log.beacons[0]?.endpoint === "/apps/tl-ab/collect");
  check("payload berisi vid dan variant B", body?.vid === VID_B && body?.ev?.some((e) => e.t === "exposure" && e.v === "B"),
    JSON.stringify(body)?.slice(0, 120) ?? "");
}

/* ---------- 19. Cookie jembatan untuk web pixel ---------- */
{
  const r = runScript({ config: baseConfig, ctx: { ...baseCtx, suffix: "ab-b" }, url: "https://treelogy.com/products/kapsul?view=ab-b", cookies: `_tl_vid=${VID_B}` });
  // Nilai cookie di-URL-encode, jadi "|" tersimpan sebagai %7C. Web pixel
  // membacanya dengan decodeURIComponent, jadi bentuk inilah yang benar.
  const last = r.log.cookiesSet.find((c) => c.startsWith("_tl_ab_last="));
  check("cookie _tl_ab_last dipasang untuk web pixel", Boolean(last), last ?? "(tidak ada)");
  check("_tl_ab_last bisa di-decode web pixel jadi exp1|B|vid", (() => {
    if (!last) return false;
    const raw = last.split(";")[0].slice("_tl_ab_last=".length);
    const [e, v, id] = decodeURIComponent(raw).split("|");
    return e === "exp1" && v === "B" && id === VID_B;
  })(), last ?? "");
}

/* ---------- 20. Link rewriting ---------- */
{
  const r = runScript({
    config: baseConfig,
    ctx: { ...baseCtx, suffix: "ab-b" },
    url: "https://treelogy.com/products/kapsul?view=ab-b",
    cookies: `_tl_vid=${VID_B}`,
    anchors: ["/products/produk-b", "/collections/all", "https://luar.com/products/x"],
  });
  const [prod, coll, luar] = r.anchors.map((a) => a._href);
  check("link produk internal ditulis ulang", prod.includes("view=ab-b"), prod);
  check("link koleksi tidak disentuh", !coll.includes("view="), coll);
  check("link domain luar tidak disentuh", !luar.includes("view="), luar);
}

/* ---------- 21. Atribusi cart lewat fetch (jalur AJAX) ---------- */
{
  const r = runScript({
    config: baseConfig, ctx: { ...baseCtx, suffix: "ab-b" },
    url: "https://treelogy.com/products/kapsul?view=ab-b", cookies: `_tl_vid=${VID_B}`,
  });
  // Theme memanggil /cart/add.js lewat fetch yang sudah dibungkus script kita.
  await r.sandbox.fetch("/cart/add.js", { method: "POST" });
  await new Promise((res) => setImmediate(res));
  const update = r.log.fetches.find((f) => f.url.includes("/cart/update.js"));
  check("add-to-cart via fetch memicu /cart/update.js", Boolean(update),
    r.log.fetches.map((f) => f.url).join(", "));
  if (update) {
    const attrs = JSON.parse(update.init.body).attributes;
    check("atribut _tl_ab benar", attrs._tl_ab === "exp1:B", JSON.stringify(attrs));
    check("atribut _tl_vid benar", attrs._tl_vid === VID_B, JSON.stringify(attrs));
    check("atribut memakai prefix _ (tersembunyi dari pembeli)",
      Object.keys(attrs).every((k) => k.startsWith("_")), Object.keys(attrs).join(","));
  }
}

/* ---------- 22. Atribusi cart lewat form submit native ---------- */
{
  const r = runScript({
    config: baseConfig, ctx: { ...baseCtx, suffix: "ab-b" },
    url: "https://treelogy.com/products/kapsul?view=ab-b", cookies: `_tl_vid=${VID_B}`,
  });
  const submitHandlers = r.log.listeners["submit"] ?? [];
  check("penangkap submit terpasang", submitHandlers.length > 0);
  if (submitHandlers.length) {
    submitHandlers[0]({ target: { getAttribute: (n) => (n === "action" ? "/cart/add" : null) } });
    const update = r.log.fetches.find((f) => f.url.includes("/cart/update.js"));
    check("form submit native memicu /cart/update.js", Boolean(update));
    check("request submit memakai keepalive", update?.init?.keepalive === true,
      JSON.stringify(update?.init ?? {}).slice(0, 80));
  }
}

/* ---------- 23. Form yang bukan add-to-cart diabaikan ---------- */
{
  const r = runScript({
    config: baseConfig, ctx: { ...baseCtx, suffix: "ab-b" },
    url: "https://treelogy.com/products/kapsul?view=ab-b", cookies: `_tl_vid=${VID_B}`,
  });
  (r.log.listeners["submit"] ?? [])[0]?.({
    target: { getAttribute: (n) => (n === "action" ? "/search" : null) },
  });
  check("form pencarian tidak memicu cart update",
    !r.log.fetches.some((f) => f.url.includes("/cart/update.js")));
}

/* ---------- 24. Dua eksperimen sekaligus, halaman cocok ke salah satu ---------- */
{
  const cfg = {
    ...baseConfig,
    ex: [
      { id: "expA", s: 50, a: "", b: "va", h: ["produk-lain"], x: [] },
      { id: "expB", s: 50, a: "", b: "vb", h: ["kapsul"], x: [] },
    ],
  };
  let vidB = "";
  for (let i = 0; !vidB; i++) { const v = `m-${i}`; if (bucket(v, "expB", 50) === "B") vidB = v; }
  const r = runScript({ config: cfg, ctx: baseCtx, cookies: `_tl_vid=${vidB}` });
  check("eksperimen yang cocok dengan halaman yang dipakai", r.log.replaced?.includes("view=vb"),
    r.log.replaced ?? "(tidak ada)");
}

/* ---------- 25. Split 0 dan 100 persen ---------- */
{
  const cfg100 = { ...baseConfig, ex: [{ ...baseConfig.ex[0], s: 100 }] };
  const r = runScript({ config: cfg100, ctx: baseCtx, cookies: `_tl_vid=${VID_A}` });
  check("split 100% -> bahkan bucket A sebelumnya ikut ke B", r.log.replaced?.includes("view=ab-b"),
    r.log.replaced ?? "");
  const cfg0 = { ...baseConfig, ex: [{ ...baseConfig.ex[0], s: 0 }] };
  const r0 = runScript({ config: cfg0, ctx: baseCtx, cookies: `_tl_vid=${VID_B}` });
  check("split 0% -> tidak ada yang ke B", r0.log.replaced === null, r0.log.replaced ?? "");
}

/* ---------- 26. Siaran variant ke alat analitik lain ----------

   Ini yang membuat GA4, GTM, dan Contentsquare tahu kunjungan ini variant apa.
   Tanpa siaran ini semua alat itu mencampur A dan B jadi satu angka yang tetap
   terlihat masuk akal — tidak ada error yang muncul.                          */
{
  // Pakai bucket A supaya halaman tidak diredirect, sehingga siaran benar-benar
  // sempat berjalan sampai selesai di halaman yang sama.
  const r = runScript({ config: baseConfig, ctx: baseCtx, cookies: `_tl_vid=${VID_A}` });

  const dl = r.sandbox.dataLayer || [];
  const impression = dl.find((e) => e.event === "tl_ab_experience_impression");
  check("dataLayer menerima impression variant", Boolean(impression),
    JSON.stringify(dl.map((e) => e.event)));
  check("nama event dataLayer diberi awalan tl_ab_ supaya tidak menyalakan trigger GTM yang sudah ada",
    dl.every((e) => String(e.event).startsWith("tl_ab_")), JSON.stringify(dl.map((e) => e.event)));
  check("exp_variant_string mengikuti format TOOL-EXPERIMENT-VARIANT",
    impression?.exp_variant_string === "TLAB-exp1-A", impression?.exp_variant_string ?? "(kosong)");
  check("variant dan experiment id ikut disiarkan",
    impression?.variant === "A" && impression?.experiment_id === "exp1");

  const published = r.log.published.map((x) => x.name);
  check("custom event diterbitkan untuk web pixel", published.includes("tl_ab:experience_impression"),
    JSON.stringify(published));
  check("nama custom event memakai awalan app diikuti titik dua, sesuai dokumentasi",
    r.log.published.every((x) => x.name.startsWith("tl_ab:")), JSON.stringify(published));

  const dvar = r.log.uxa.find((c) => c[0] === "trackDynamicVariable");
  check("Contentsquare menerima dynamic variable", Boolean(dvar), JSON.stringify(r.log.uxa.map((c) => c[0])));
  check("dynamic variable memakai key per-eksperimen dan value variant",
    dvar?.[1]?.key === "AB_TL_exp1" && dvar?.[1]?.value === "A", JSON.stringify(dvar?.[1] ?? {}));
  check("dynamic variable dikirim lewat afterPageView, bukan langsung",
    r.log.uxa.some((c) => c[0] === "afterPageView"));
}

/* ---------- 27. Penanda redirect untuk GTM ----------

   Skrip ini disuntikkan menjelang penutup head, jadi tag GA4 bisa saja sudah
   menembak page_view untuk URL sebelum redirect. Kalau itu terjadi, grup B
   mencatat dua page_view sementara grup A hanya satu — bias yang tidak simetris
   antar variant.                                                              */
{
  const r = runScript({ config: baseConfig, ctx: baseCtx, cookies: `_tl_vid=${VID_B}` });
  check("halaman yang akan ditinggalkan menandai dirinya",
    r.sandbox.__TL_AB_REDIRECTING__ === true);
  check("penanda juga masuk dataLayer supaya bisa dipakai exception trigger GTM",
    (r.sandbox.dataLayer || []).some((e) => e.event === "tl_ab_redirect_pending"));
  check("halaman yang akan ditinggalkan tidak menyiarkan impression",
    !(r.sandbox.dataLayer || []).some((e) => e.event === "tl_ab_experience_impression"));
}

/* ---------- 28. Identitas GA4 ikut ke server ----------

   Konversi terjadi di checkout, yang tidak boleh memuat gtag.js. client_id ini
   satu-satunya cara membelah revenue GA4 per variant.                         */
{
  const r = runScript({
    config: baseConfig,
    ctx: baseCtx,
    cookies: `_tl_vid=${VID_A}; _ga=GA1.1.1234567890.1700000000; _ga_ABC123=GS2.1.s1700000123$o5$g1$t1700000456`,
  });
  const body = JSON.parse(r.log.beacons[0]?.body ?? "{}");
  check("client_id GA4 dikirim ke server", body.ga?.c === "1234567890.1700000000",
    JSON.stringify(body.ga ?? null));
  check("session_id GA4 ikut kalau terbaca", body.ga?.s === "1700000123", JSON.stringify(body.ga ?? null));
}

/* ---------- 29. Tanpa GA4 terpasang, payload tetap bersih ---------- */
{
  const r = runScript({ config: baseConfig, ctx: baseCtx, cookies: `_tl_vid=${VID_A}` });
  const body = JSON.parse(r.log.beacons[0]?.body ?? "{}");
  check("tanpa cookie _ga, tidak ada field ga yang dikirim", body.ga === undefined,
    JSON.stringify(body.ga ?? null));
  check("event funnel tetap terkirim seperti biasa", Array.isArray(body.ev) && body.ev.length > 0);
}

/* ---------- laporan ---------- */
console.log();
for (const r of results) {
  console.log(`  ${r.ok ? "ok   " : "GAGAL"} ${r.label}${r.ok || !r.detail ? "" : `\n           ${r.detail}`}`);
}
console.log(`\n  ${results.length - failed}/${results.length} lolos`);
if (failed) { console.error("\nADA YANG GAGAL"); process.exit(1); }
console.log("OK");
