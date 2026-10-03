/**
 * Pengujian penyalinan terjemahan template ke variant B.
 *
 * Dijalankan langsung terhadap sumber TypeScript-nya lewat type stripping Node,
 * dengan Admin API tiruan — supaya yang diuji benar-benar kode yang dipakai
 * aplikasi, termasuk penyaringan key dan pemilihan digest.
 *
 * Yang dijaga di sini adalah kelas kegagalan yang tidak memunculkan error apa pun:
 * variant B kehilangan terjemahannya, atau justru mewarisi kalimat variant A pada
 * teks yang sedang diuji.
 */
import {
  pathOf,
  tplOf,
  templateNameOf,
  copyTemplateTranslations,
  planTemplateTranslations,
} from "../app/lib/translations.server.ts";

const LIVE = "156446064828";
const PREVIEW = "158347690172";

/** Key asli berbentuk section.<template>.json.<path>:<hash>; hash-nya beda tiap template. */
const keyFor = (tpl, path) => `section.${tpl}.json.${path}:${hashFor(tpl)}`;
const hashFor = (tpl) => "h" + [...tpl].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 99991, 7).toString(36);

/**
 * Admin API tiruan.
 *
 * `translations` sengaja dibuat bocor lintas template sepresiks, persis seperti
 * Shopify: meminta `page` ikut mengembalikan milik `page.faq` dan `page.farm`.
 */
function fakeAdmin({ locales, resources }) {
  const registered = [];
  const removed = [];

  const admin = {
    async graphql(query, opts) {
      const variables = opts?.variables ?? {};

      if (query.includes("shopLocales")) {
        return { json: async () => ({ data: { shopLocales: locales } }) };
      }

      if (query.includes("translationsRegister")) {
        registered.push({ resourceId: variables.resourceId, translations: variables.translations });
        return {
          json: async () => ({
            data: {
              translationsRegister: {
                translations: variables.translations.map((t) => ({ key: t.key, locale: t.locale })),
                userErrors: [],
              },
            },
          }),
        };
      }

      if (query.includes("translationsRemove")) {
        removed.push({ resourceId: variables.resourceId, keys: variables.translationKeys });
        return {
          json: async () => ({
            data: {
              translationsRemove: {
                translations: variables.translationKeys.map((k) => ({ key: k, locale: variables.locales[0] })),
                userErrors: [],
              },
            },
          }),
        };
      }

      // translatableResource
      const [, name, themeId] = variables.id.match(
        /OnlineStoreThemeJsonTemplate\/([^?]+)\?theme_id=(.+)$/,
      );
      const templateName = decodeURIComponent(name);
      const locale = variables.locale;

      const translatableContent = [];
      const translations = [];
      for (const [id, tplName, res] of resources) {
        if (id !== themeId) continue;
        // Yang diminta hanya template ini — tapi Shopify mengembalikan juga
        // milik template lain yang namanya berawalan sama.
        if (tplName !== templateName && !tplName.startsWith(`${templateName}.`)) continue;
        if (tplName === templateName) {
          for (const c of res.content ?? []) {
            translatableContent.push({
              key: keyFor(tplName, c.path),
              value: c.value,
              digest: c.digest,
            });
          }
        }
        for (const t of res.translations?.[locale] ?? []) {
          translations.push({
            key: keyFor(tplName, t.path),
            value: t.value,
            outdated: Boolean(t.outdated),
            market: t.marketId ? { id: t.marketId } : null,
          });
        }
      }

      return {
        json: async () => ({
          data: {
            translatableResource: {
              resourceId: variables.id,
              translatableContent,
              translations,
            },
          },
        }),
      };
    },
  };

  return { admin, registered, removed };
}

const ID_ONLY = [
  { locale: "en", name: "English", primary: true, published: true },
  { locale: "id", name: "Indonesia", primary: false, published: true },
  { locale: "fr", name: "Prancis", primary: false, published: false },
];

/** product.json dengan 5 setting translatable, 3 di antaranya sudah diterjemahkan. */
const PRODUCT_CONTENT = [
  { path: "main.payment_title", value: "We accept:", digest: "d1" },
  { path: "main.story_cta_text", value: "Add to Cart", digest: "d2" },
  { path: "main.usp_slider.heading_1", value: "Secure Checkout", digest: "d3" },
  { path: "main.section_how_to.title", value: "How to Use", digest: "d4" },
  { path: "main.image_alt", value: "", digest: "d5" },
];

const PRODUCT_ID_TRANSLATIONS = [
  { path: "main.payment_title", value: "Kami menerima:" },
  { path: "main.story_cta_text", value: "Tambahkan ke Keranjang" },
  { path: "main.section_how_to.title", value: "Cara Pakai" },
];

const checks = [];
const check = (label, ok) => checks.push([label, ok]);

/* ---------------- 1. bentuk key ---------------- */

check(
  "pathOf membuang nama template dan hash",
  pathOf("section.product.json.main.payment_title:exh9xdirkvfv") === "main.payment_title" &&
    pathOf("section.product.ab-b.json.main.payment_title:3tbvdgy6sc7s9") === "main.payment_title",
);
check(
  "pathOf mencocokkan key template berbeda ke path yang sama",
  pathOf("section.page.faq.json.main.blocks.x.title:abc1") === "main.blocks.x.title",
);
check(
  "tplOf mengembalikan nama template lengkap",
  tplOf("section.product.ab-b.json.main.payment_title:3tb") === "product.ab-b" &&
    tplOf("section.page.faq.json.main.title:abc") === "page.faq",
);
check(
  "templateNameOf membuang folder dan ekstensi",
  templateNameOf("templates/product.ab-b.json") === "product.ab-b" &&
    templateNameOf("templates/product.json") === "product",
);

/* ---------------- 2. penyalinan dasar ---------------- */

const basic = fakeAdmin({
  locales: ID_ONLY,
  resources: [
    [LIVE, "product", { content: PRODUCT_CONTENT, translations: { id: PRODUCT_ID_TRANSLATIONS } }],
    [PREVIEW, "product", { content: PRODUCT_CONTENT, translations: { id: PRODUCT_ID_TRANSLATIONS } }],
    [LIVE, "product.ab-b", { content: PRODUCT_CONTENT, translations: { id: [] } }],
  ],
});

const basicResult = await copyTemplateTranslations(basic.admin, {
  liveThemeId: LIVE,
  sourceThemeId: PREVIEW,
  templateFilename: "templates/product.json",
  targetTemplateFilename: "templates/product.ab-b.json",
});

check("3 terjemahan tersalin", basicResult.copied === 3);
check("tidak ada yang perlu manual", basicResult.needsManual.length === 0);
check("hanya locale published non-primary yang diproses", basicResult.locales.join() === "id");

const written = basic.registered.flatMap((r) => r.translations);
check(
  "key yang ditulis milik TEMPLATE TUJUAN, bukan sumber",
  written.every((t) => tplOf(t.key) === "product.ab-b"),
);
check(
  "digest yang ditulis milik tujuan",
  written.every((t) => ["d1", "d2", "d4"].includes(t.translatableContentDigest)),
);
check(
  "nilainya diambil dari sumber",
  written.find((t) => pathOf(t.key) === "main.story_cta_text")?.value === "Tambahkan ke Keranjang",
);
check(
  "resourceId yang dipakai adalah resource tujuan",
  basic.registered.every((r) => r.resourceId.includes("product.ab-b")),
);

/* ---------------- 3. regresi kebocoran sepresiks ---------------- */

const leaky = fakeAdmin({
  locales: ID_ONLY,
  resources: [
    [LIVE, "page", {
      content: [{ path: "main.title", value: "About", digest: "p1" }],
      translations: { id: [{ path: "main.title", value: "Tentang" }] },
    }],
    [PREVIEW, "page", {
      content: [{ path: "main.title", value: "About", digest: "p1" }],
      translations: { id: [{ path: "main.title", value: "Tentang" }] },
    }],
    // Template lain yang namanya berawalan "page" — TIDAK boleh ikut tersalin.
    [PREVIEW, "page.faq", {
      content: [{ path: "main.title", value: "FAQ", digest: "q1" }],
      translations: { id: [{ path: "main.title", value: "Pertanyaan Umum" }] },
    }],
    [PREVIEW, "page.farm", {
      content: [{ path: "main.heading", value: "Farm", digest: "r1" }],
      translations: { id: [{ path: "main.heading", value: "Kebun" }] },
    }],
    [LIVE, "page.ab-b", {
      content: [{ path: "main.title", value: "About", digest: "p1" }],
      translations: { id: [] },
    }],
  ],
});

const leakResult = await copyTemplateTranslations(leaky.admin, {
  liveThemeId: LIVE,
  sourceThemeId: PREVIEW,
  templateFilename: "templates/page.json",
  targetTemplateFilename: "templates/page.ab-b.json",
});

const leakWritten = leaky.registered.flatMap((r) => r.translations);
check("page -> page.ab-b hanya menyalin miliknya sendiri", leakResult.copied === 1);
check(
  "teks page.faq / page.farm tidak ikut terseret",
  !leakWritten.some((t) => ["Pertanyaan Umum", "Kebun"].includes(t.value)),
);

/* ---------------- 4. idempotensi ---------------- */

const twice = fakeAdmin({
  locales: ID_ONLY,
  resources: [
    [LIVE, "product", { content: PRODUCT_CONTENT, translations: { id: PRODUCT_ID_TRANSLATIONS } }],
    [PREVIEW, "product", { content: PRODUCT_CONTENT, translations: { id: PRODUCT_ID_TRANSLATIONS } }],
    // Tujuan sudah terisi — mewakili jalur kedua.
    [LIVE, "product.ab-b", { content: PRODUCT_CONTENT, translations: { id: PRODUCT_ID_TRANSLATIONS } }],
  ],
});

const secondPass = await copyTemplateTranslations(twice.admin, {
  liveThemeId: LIVE,
  sourceThemeId: PREVIEW,
  templateFilename: "templates/product.json",
  targetTemplateFilename: "templates/product.ab-b.json",
});

check("jalur kedua menyalin 0", secondPass.copied === 0 && twice.registered.length === 0);
check("jalur kedua menghitungnya sebagai dilewati", secondPass.skipped === 3);

/* ---------------- 5. deteksi string yang sedang diuji ---------------- */

// Variant B mengubah teks Inggris satu heading dan belum menerjemahkannya.
const CHANGED_CONTENT = PRODUCT_CONTENT.map((c) =>
  c.path === "main.section_how_to.title"
    ? { ...c, value: "How To Take It", digest: "d4-baru" }
    : c,
);
const CHANGED_TRANSLATIONS = PRODUCT_ID_TRANSLATIONS.filter(
  (t) => t.path !== "main.section_how_to.title",
);

const tested = fakeAdmin({
  locales: ID_ONLY,
  resources: [
    [LIVE, "product", { content: PRODUCT_CONTENT, translations: { id: PRODUCT_ID_TRANSLATIONS } }],
    [PREVIEW, "product", { content: CHANGED_CONTENT, translations: { id: CHANGED_TRANSLATIONS } }],
    [LIVE, "product.ab-b", { content: CHANGED_CONTENT, translations: { id: [] } }],
  ],
});

const testedResult = await copyTemplateTranslations(tested.admin, {
  liveThemeId: LIVE,
  sourceThemeId: PREVIEW,
  templateFilename: "templates/product.json",
  targetTemplateFilename: "templates/product.ab-b.json",
});

const testedWritten = tested.registered.flatMap((r) => r.translations);
check("string yang diubah masuk daftar manual", testedResult.needsManual.length === 1);
check(
  "daftar manual menyebut path dan kedua teksnya",
  testedResult.needsManual[0]?.path === "main.section_how_to.title" &&
    testedResult.needsManual[0]?.sourceText === "How To Take It" &&
    testedResult.needsManual[0]?.controlTranslation === "Cara Pakai",
);
check(
  "terjemahan variant A TIDAK ditimpakan ke teks yang sedang diuji",
  !testedWritten.some((t) => t.value === "Cara Pakai"),
);
check("sisanya tetap tersalin", testedResult.copied === 2);

/* ---------------- 6. cadangan dari variant A saat preview basi ---------------- */

// Theme preview belum punya terjemahan sama sekali, tapi teksnya identik dengan
// variant A. Terjemahan A sah dipakai — digest-nya sama.
const stale = fakeAdmin({
  locales: ID_ONLY,
  resources: [
    [LIVE, "product", { content: PRODUCT_CONTENT, translations: { id: PRODUCT_ID_TRANSLATIONS } }],
    [PREVIEW, "product", { content: PRODUCT_CONTENT, translations: { id: [] } }],
    [LIVE, "product.ab-b", { content: PRODUCT_CONTENT, translations: { id: [] } }],
  ],
});

const staleResult = await copyTemplateTranslations(stale.admin, {
  liveThemeId: LIVE,
  sourceThemeId: PREVIEW,
  templateFilename: "templates/product.json",
  targetTemplateFilename: "templates/product.ab-b.json",
});
check("teks identik: terjemahan variant A dipakai sebagai cadangan", staleResult.copied === 3);
check("cadangan tidak memunculkan daftar manual", staleResult.needsManual.length === 0);

/* ---------------- 7. terjemahan yang terikat market ---------------- */

const market = fakeAdmin({
  locales: ID_ONLY,
  resources: [
    [LIVE, "product", { content: PRODUCT_CONTENT, translations: { id: [] } }],
    [PREVIEW, "product", {
      content: PRODUCT_CONTENT,
      translations: {
        id: [
          { path: "main.payment_title", value: "Kami menerima:" },
          { path: "main.payment_title", value: "Kami terima:", marketId: "gid://shopify/Market/1" },
        ],
      },
    }],
    [LIVE, "product.ab-b", { content: PRODUCT_CONTENT, translations: { id: [] } }],
  ],
});

const marketResult = await copyTemplateTranslations(market.admin, {
  liveThemeId: LIVE,
  sourceThemeId: PREVIEW,
  templateFilename: "templates/product.json",
  targetTemplateFilename: "templates/product.ab-b.json",
});
const marketWritten = market.registered.flatMap((r) => r.translations);
check("terjemahan global dan per-market keduanya tersalin", marketResult.copied === 2);
check(
  "marketId ikut ditulis ulang apa adanya",
  marketWritten.filter((t) => t.marketId === "gid://shopify/Market/1").length === 1 &&
    marketWritten.filter((t) => t.marketId === undefined).length === 1,
);

/* ---------------- 8. terjemahan outdated tidak dipakai ---------------- */

const outdated = fakeAdmin({
  locales: ID_ONLY,
  resources: [
    [LIVE, "product", { content: PRODUCT_CONTENT, translations: { id: [] } }],
    [PREVIEW, "product", {
      content: PRODUCT_CONTENT,
      translations: { id: [{ path: "main.payment_title", value: "Kalimat lama", outdated: true }] },
    }],
    [LIVE, "product.ab-b", { content: PRODUCT_CONTENT, translations: { id: [] } }],
  ],
});

const outdatedResult = await copyTemplateTranslations(outdated.admin, {
  liveThemeId: LIVE,
  sourceThemeId: PREVIEW,
  templateFilename: "templates/product.json",
  targetTemplateFilename: "templates/product.ab-b.json",
});
check("terjemahan outdated tidak ikut disalin", outdatedResult.copied === 0);

/* ---------------- 9. plan yang dipakai wizard ---------------- */

const planned = fakeAdmin({
  locales: ID_ONLY,
  resources: [
    [LIVE, "product", { content: PRODUCT_CONTENT, translations: { id: PRODUCT_ID_TRANSLATIONS } }],
    [PREVIEW, "product", { content: CHANGED_CONTENT, translations: { id: CHANGED_TRANSLATIONS } }],
  ],
});

const plan = await planTemplateTranslations(planned.admin, {
  liveThemeId: LIVE,
  sourceThemeId: PREVIEW,
  templateFilename: "templates/product.json",
});

check("plan menghitung yang akan disalin otomatis", plan.willCopy === 2);
check("plan menghitung yang perlu manual", plan.needsManual.length === 1);
check("plan tidak menulis apa pun", planned.registered.length === 0);
check("plan melaporkan per locale", plan.locales.length === 1 && plan.locales[0].locale === "id");

/* ---------------- 10. gagal memeriksa != aman ---------------- */

const broken = {
  admin: {
    async graphql() {
      return { json: async () => ({ errors: [{ message: "Access denied for shopLocales field." }] }) };
    },
  },
};
const brokenPlan = await planTemplateTranslations(broken.admin, {
  liveThemeId: LIVE,
  sourceThemeId: PREVIEW,
  templateFilename: "templates/product.json",
});
check("scope kurang dilaporkan sebagai error, bukan plan kosong", Boolean(brokenPlan.error));

/* ---------------- hasil ---------------- */

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? "ok   " : "GAGAL"} ${label}`);
  if (!ok) failed++;
}
console.log(
  `\n  ${checks.length - failed}/${checks.length} pemeriksaan lolos` +
    (failed ? ` — ${failed} GAGAL` : ""),
);
if (failed) process.exit(1);
