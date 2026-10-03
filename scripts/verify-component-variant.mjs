/**
 * Variant B of a component experiment from a draft theme — the pure planner
 * (app/lib/component-variant.ts, SPEC-component-experiments §10).
 *
 *   node --import ./scripts/ts-resolve.mjs scripts/verify-component-variant.mjs
 */
import {
  armDefault,
  defaultDrawer,
  entrySnippet,
  entryTarget,
  mergeLocale,
  parseLocaleFile,
  planVariant,
  rewriteBody,
  serializeLocaleFile,
  snippetRefs,
  translationRefs,
} from "../app/lib/component-variant.ts";
import { COMPONENTS, evaluateComponentReadiness } from "../app/lib/components.ts";

let failed = 0;
const results = [];
function check(label, condition, detail = "") {
  results.push({ label, ok: Boolean(condition), detail });
  if (!condition) failed++;
}

const ATTR = "_tl_abc_cart_drawer";
const ARM = `{% doc %}
  @example
  {% render 'cart-drawer-arm', part: 'shell' %}
{% enddoc -%}
{%- if part != 'content' -%}<script src="{{ 'cart-analytics.js' | asset_url }}" defer></script>{%- endif -%}
{%- if cart.attributes['${ATTR}'] == 'B' -%}
  {%- if part == 'content' -%}
    {%- render 'tl-abx-cart_drawer-content' -%}
  {%- else -%}
    {%- render 'tl-abx-cart_drawer-shell', up_selling: up_selling -%}
  {%- endif -%}
{%- else -%}
  {%- if part == 'content' -%}
    {%- render 'CartDrawerContent' -%}
  {%- else -%}
    {%- render 'MiniCart', up_selling: up_selling -%}
  {%- endif -%}
{%- endif -%}
`;
const OPTS = { arm: "cart-drawer-arm", attribute: ATTR, legacyShell: "MiniCart" };
const HEADER_ARM = `<header>{% render 'cart-drawer-arm', part: 'shell', up_selling: x %}</header>`;
const MINI_ARM = `{% layout none %}<div id="mini-cart-content">{% render 'cart-drawer-arm', part: 'content' %}</div>`;

/* ---------- which drawer a draft shows by default ---------- */
{
  const d = armDefault(ARM, ATTR);
  check("arm == 'B' → default is the else-branch (legacy)", d?.shell === "MiniCart" && d?.content === "CartDrawerContent", JSON.stringify(d));
  const shipped = ARM.replace("== 'B'", "!= 'A'");
  const s = armDefault(shipped, ATTR);
  check("arm != 'A' (B shipped) → default is the if-branch", s?.shell === "tl-abx-cart_drawer-shell" && s?.content === "tl-abx-cart_drawer-content", JSON.stringify(s));
  const viaArm = defaultDrawer({ header: HEADER_ARM, cartMini: MINI_ARM, arm: ARM }, OPTS);
  check("draft with the arm → legacy drawer entries", viaArm.entries?.shell === "MiniCart" && viaArm.entries?.content === "CartDrawerContent");
  const direct = defaultDrawer(
    { header: `{% render 'MiniCart', up_selling: x %}`, cartMini: `{% layout none %}{% render 'MyDrawerContent' %}`, arm: null },
    OPTS,
  );
  check("draft without the arm → Header's MiniCart + cart.mini's first render", direct.entries?.shell === "MiniCart" && direct.entries?.content === "MyDrawerContent");
  const none = defaultDrawer({ header: `<header></header>`, cartMini: MINI_ARM, arm: ARM }, OPTS);
  check("Header without any drawer → problem, no entries", !none.entries && /Header/.test(none.problem ?? ""));
  check("render inside {% doc %} is not a reference", !snippetRefs(ARM).includes("cart-drawer-arm"));
  check(
    "render in a {% liquid %} block is a reference",
    snippetRefs(`{%- liquid\n  assign a = 1\n  render 'cart-v3-rate', v: a\n-%}`).includes("cart-v3-rate"),
  );
}

/* ---------- the plan ---------- */
const EN = { cart_v3: { change_pack: "Change pack", new_key: "New", plural: { one: "1 item", other: "{{ count }} items" } }, cart: { title: "Cart" } };
const ID = { cart_v3: { change_pack: "Ganti paket", plural: { one: "1 barang", other: "{{ count }} barang" } }, cart: { title: "Keranjang" } };

function themes(overrides = {}) {
  const live = new Map(
    Object.entries({
      "snippets/MiniCart.liquid": `<div>{% render 'CartDrawerContent' %}</div><script src="{{ 'drawer.js' | asset_url }}"></script>`,
      "snippets/CartDrawerContent.liquid": `{% for item in cart.items %}{% render 'line', item: item %}{% endfor %}{{ 'cart.title' | t }}`,
      "snippets/line.liquid": `{%- liquid\n  assign k = 'cart_v3.change_pack'\n-%}<button>{{ k | t }}</button>`,
      "assets/drawer.js": "console.log('a')",
      "assets/logo.png": "",
    }),
  );
  const source = new Map(live);
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) source.delete(k);
    else source.set(k, v);
  }
  const sum = (m) => new Map([...m].map(([k, v]) => [k, `md5:${v}`]));
  return { live, source, liveSums: sum(live), sourceSums: sum(source) };
}
const plan = (t, extra = {}) =>
  planVariant({
    token: "f00d",
    entries: { shell: "MiniCart", content: "CartDrawerContent" },
    source: t.source,
    sourceSums: t.sourceSums,
    liveSums: t.liveSums,
    sourceLocales: { "en.default": EN, id: ID },
    liveLocales: { "en.default": EN, id: ID },
    primaryLocale: "en.default",
    ...extra,
  });

{
  const p = plan(themes());
  check("unchanged draft → A/A, everything reused", p.identicalToLive && p.files.every((f) => f.action === "reuse") && !p.blocking.length);
  check("unchanged draft → entries are the draft's own snippets", p.entries?.shell === "MiniCart" && p.entries?.content === "CartDrawerContent");
  check("tree traced through {% liquid %} and for-loops", p.files.map((f) => f.source).includes("snippets/line.liquid"));
}
{
  const t = themes({ "snippets/line.liquid": `<b>{{ 'cart_v3.change_pack' | t }}</b>` });
  const p = plan(t);
  const byName = Object.fromEntries(p.files.map((f) => [f.source, f]));
  check("changed leaf → isolated", byName["snippets/line.liquid"].action === "isolate" && byName["snippets/line.liquid"].status === "changed");
  check(
    "its parents → isolated as depends_on_changed (A keeps the originals)",
    byName["snippets/CartDrawerContent.liquid"].status === "depends_on_changed" && byName["snippets/MiniCart.liquid"].action === "isolate",
  );
  check("entries point at the copies", p.entries?.shell === "MiniCart-abxf00d" && p.entries?.content === "CartDrawerContent-abxf00d");
  const rewritten = rewriteBody(t.source.get("snippets/CartDrawerContent.liquid"), p);
  check("copy renders the copied child", rewritten.includes("render 'line-abxf00d'") && !rewritten.includes("render 'line',"));
  check("reused asset untouched", p.assets.every((a) => a.action === "reuse"));
}
{
  const t = themes({ "assets/drawer.js": "console.log('b')" });
  const p = plan(t);
  const asset = p.assets.find((a) => a.source === "assets/drawer.js");
  check("changed asset → isolated under a new name", asset?.action === "isolate" && asset.target === "assets/drawer-abxf00d.js");
  check("file loading it → isolated", p.files.find((f) => f.source === "snippets/MiniCart.liquid")?.action === "isolate");
  check(
    "copy loads the copied asset",
    rewriteBody(t.source.get("snippets/MiniCart.liquid"), p).includes("'drawer-abxf00d.js' | asset_url"),
  );
}
{
  const EN2 = structuredClone(EN);
  EN2.cart_v3.change_pack = "Swap pack";
  const p = plan(themes(), { sourceLocales: { "en.default": EN2, id: ID } });
  const k = p.localeKeys.find((x) => x.key === "cart_v3.change_pack");
  check("changed text (key assigned to a variable) → isolated key", k?.action === "isolate" && k.target === "abx_f00d.cart_v3__change_pack");
  const line = p.files.find((f) => f.source === "snippets/line.liquid");
  check("file using that key → isolated", line?.action === "isolate" && line.status === "depends_on_changed");
  const body = rewriteBody(themes().source.get("snippets/line.liquid"), p);
  check("literal rewritten to the isolated key", body.includes("'abx_f00d.cart_v3__change_pack'"));
  const { merged, changed } = mergeLocale(EN, EN2, p);
  check(
    "locale merge is additive: live text kept, B text under the new key",
    changed === 1 && merged.cart_v3.change_pack === "Change pack" && merged.abx_f00d.cart_v3__change_pack === "Swap pack" && merged.cart.title === "Cart",
  );
}
{
  const t = themes({ "snippets/line.liquid": `{{ 'cart_v3.new_key' | t }} {{ 'cart_v3.plural' | t: count: 2 }}` });
  const liveEN = structuredClone(EN);
  delete liveEN.cart_v3.new_key;
  const p = plan(t, { liveLocales: { "en.default": liveEN, id: ID } });
  check("new key → add (A never reads it)", p.localeKeys.some((k) => k.key === "cart_v3.new_key" && k.action === "add" && k.target === "cart_v3.new_key"));
  check("plural object counts as a translation leaf", translationRefs(`{{ 'cart_v3.plural' | t }}`, EN).includes("cart_v3.plural"));
  check("namespace literal is not a key", translationRefs(`{% assign x = 'cart_v3' %}{{ 'cart.missing' }}`, EN).length === 0);
  check("missing id translation reported", p.untranslated.some((u) => u.key === "cart_v3.new_key" && u.locale === "id"));
}
{
  const t = themes({ "snippets/line.liquid": `<b>x</b>{% stylesheet %}.line{color:red}{% endstylesheet %}` });
  check("changed file with {% stylesheet %} → blocking (bundled into every page)", plan(t).blocking.some((b) => b.file === "snippets/line.liquid"));
  const same = themes();
  same.source.set("snippets/line.liquid", same.live.get("snippets/line.liquid"));
  check("unchanged file is never blocked", !plan(same).blocking.length);
}
{
  const p = plan(themes({ "snippets/CartDrawerContent.liquid": `{% render block_name %}` }));
  check("dynamic render → blocking", p.blocking.some((b) => /variable/.test(b.reason)) && p.entries === null);
  const m = plan(themes({ "snippets/CartDrawerContent.liquid": `{% render 'gone' %}` }));
  check("snippet missing in draft → blocking", m.blocking.some((b) => b.file === "snippets/gone.liquid"));
  const t = themes({ "snippets/MiniCart.liquid": `{{ 'logo.png' | asset_url }}` });
  t.sourceSums.set("assets/logo.png", "md5:other");
  t.source.delete("assets/logo.png"); // binary: no text body
  check("changed binary asset → blocking", plan(t).blocking.some((b) => b.file === "assets/logo.png"));
}

/* ---------- locale files, entries, readiness ---------- */
{
  const text = `/*\n * auto-generated\n */\n{\n  "a": { "b": "c" }\n}\n`;
  const { header, data } = parseLocaleFile(text);
  check("locale header comment survives a round trip", serializeLocaleFile(header, data).startsWith("/*\n * auto-generated\n */") && data.a.b === "c");
  const e = entrySnippet("MiniCart-abxf00d", "shell", "Test {% raw %} 1", "{% for p in up_selling %}{% endfor %}");
  check("entry passes up_selling to a shell that reads it", e.includes("render 'MiniCart-abxf00d', up_selling: up_selling"));
  check(
    "entry does not pass up_selling to a shell that does not (LiquidDoc)",
    entrySnippet("CartDrawer", "shell", "x", "{% doc %}up_selling{% enddoc %}<div></div>").includes("render 'CartDrawer' -%}"),
  );
  check("entry target read back (comment ignored)", entryTarget(e) === "MiniCart-abxf00d");
  check("owner label cannot break out of the comment", !/\{%\s*raw/.test(e));
}
{
  const def = COMPONENTS.cart_drawer;
  const files = {
    "snippets/cart-drawer-arm.liquid": ARM,
    "sections/Header.liquid": HEADER_ARM.replace("x %}", "section.settings.up_selling_products %}"),
    "templates/cart.mini.liquid": MINI_ARM,
    "snippets/MiniCart.liquid": "a",
    "snippets/CartDrawerContent.liquid": "a",
    "snippets/tl-abx-cart_drawer-shell.liquid": "a",
    "snippets/tl-abx-cart_drawer-content.liquid": "a",
  };
  check("readiness: arm routed through the generated entries → ok", evaluateComponentReadiness(def, files).ok);
  const old = { ...files, "snippets/cart-drawer-arm.liquid": ARM.replace(/tl-abx-cart_drawer-(shell|content)/g, (_, p) => (p === "shell" ? "CartDrawer" : "CartDrawerV3Content")) };
  const r = evaluateComponentReadiness(def, old);
  check("readiness: hard-coded B → not ready, arm reported once", !r.ok && r.problems.filter((p) => p.file === "snippets/cart-drawer-arm.liquid").length === 1);
}

for (const r of results) console.log(`${r.ok ? "  ok " : "FAIL "} ${r.label}${r.ok || !r.detail ? "" : `  — ${r.detail}`}`);
console.log(`\n${results.length - failed}/${results.length} lulus`);
process.exit(failed ? 1 : 0);
