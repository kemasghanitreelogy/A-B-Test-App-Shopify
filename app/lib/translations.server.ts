import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

/**
 * Menyalin terjemahan template dari theme preview ke alternate template variant B.
 *
 * Terjemahan Translate & Adapt untuk `templates/*.json` TIDAK tersimpan di dalam
 * file theme. Ia hidup sebagai resource terpisah yang diidentifikasi lewat **nama
 * file template**, jadi begitu app membuat `templates/product.ab-b.json`, resource
 * terjemahannya lahir kosong dan Shopify jatuh ke locale primary — bahasa Inggris.
 *
 * Tidak ada error yang muncul. Halaman tetap render, test tetap jalan, dan yang
 * terukur diam-diam berubah dari "desain A lawan desain B" menjadi "Indonesia
 * lawan Inggris". Karena itu penyalinan terjemahan adalah bagian dari proses
 * membuat variant B, bukan langkah opsional sesudahnya.
 *
 * Rinciannya ada di SPEC-auto-translation.md.
 */

const SHOP_LOCALES = `#graphql
  query ShopTranslationLocales {
    shopLocales {
      locale
      name
      primary
      published
    }
  }
`;

const TEMPLATE_TRANSLATIONS = `#graphql
  query TemplateTranslations($id: ID!, $locale: String!) {
    translatableResource(resourceId: $id) {
      resourceId
      translatableContent { key value digest }
      translations(locale: $locale) {
        key
        value
        outdated
        market { id }
      }
    }
  }
`;

const TRANSLATIONS_REGISTER = `#graphql
  mutation CopyTemplateTranslations($resourceId: ID!, $translations: [TranslationInput!]!) {
    translationsRegister(resourceId: $resourceId, translations: $translations) {
      translations { key locale }
      userErrors { field message }
    }
  }
`;

const TRANSLATIONS_REMOVE = `#graphql
  mutation RemoveTemplateTranslations($resourceId: ID!, $locales: [String!]!, $translationKeys: [String!]!) {
    translationsRemove(resourceId: $resourceId, locales: $locales, translationKeys: $translationKeys) {
      translations { key locale }
      userErrors { field message }
    }
  }
`;

/** Maksimal translation per panggilan `translationsRegister`. */
const BATCH = 100;

export interface TargetLocale {
  locale: string;
  name: string;
}

/** Satu string variant B yang tidak bisa diterjemahkan otomatis. */
export interface ManualTranslation {
  locale: string;
  /** mis. "main.section_how_to.title" */
  path: string;
  /** teks variant B pada locale primary */
  sourceText: string;
  /** teks variant A pada locale primary */
  controlText: string | null;
  /** terjemahan yang dipakai variant A sekarang */
  controlTranslation: string | null;
}

export interface LocalePlan {
  locale: string;
  name: string;
  willCopy: number;
  needsManual: ManualTranslation[];
}

export interface TranslationPlan {
  locales: LocalePlan[];
  willCopy: number;
  needsManual: ManualTranslation[];
  /** Diisi kalau pemeriksaannya sendiri yang gagal — mis. scope belum di-approve. */
  error?: string;
}

export interface TranslationCopyResult {
  copied: number;
  skipped: number;
  needsManual: ManualTranslation[];
  locales: string[];
  warnings: string[];
}

/* ------------------------------------------------------------------ *
 * Bentuk key
 *
 *   section.<nama-template>.json.<path-setting>:<hash-key>
 *
 * Nama template DAN hash-nya ikut berubah antar template, jadi key tidak bisa
 * dipakai langsung sebagai jodoh. Yang stabil hanya <path-setting>.
 * ------------------------------------------------------------------ */

export function pathOf(key: string): string {
  return key.replace(/^section\..*?\.json\./, "").replace(/:[a-z0-9]+$/i, "");
}

export function tplOf(key: string): string {
  return (key.match(/^section\.(.*?)\.json\./) ?? ["", ""])[1];
}

/** "templates/product.ab-b.json" -> "product.ab-b" */
export function templateNameOf(filename: string): string {
  return filename.replace(/^templates\//, "").replace(/\.(json|liquid)$/, "");
}

function numericThemeId(themeId: string): string {
  return themeId.split("/").pop() ?? themeId;
}

/**
 * Nama template harus URL-encoded — `customers/login` menjadi `customers%2Flogin`,
 * kalau tidak garis miringnya dibaca sebagai pemisah segmen gid.
 */
function templateResourceId(themeId: string, templateName: string): string {
  return `gid://shopify/OnlineStoreThemeJsonTemplate/${encodeURIComponent(templateName)}?theme_id=${numericThemeId(themeId)}`;
}

interface ContentRow {
  key: string;
  value: string;
  digest: string;
}

interface TranslationRow {
  key: string;
  value: string;
  outdated: boolean;
  marketId: string | null;
}

interface TemplateResource {
  resourceId: string;
  /** hanya baris milik template ini, diindeks lewat path setting */
  byPath: Map<string, ContentRow>;
  translations: TranslationRow[];
}

export async function listTargetLocales(admin: AdminApiContext): Promise<TargetLocale[]> {
  const res = await admin.graphql(SHOP_LOCALES);
  const json = await res.json();
  throwOnErrors(json, "membaca daftar bahasa toko");
  const rows: Array<{ locale: string; name: string; primary: boolean; published: boolean }> =
    json?.data?.shopLocales ?? [];
  // Locale primary tidak perlu diterjemahkan, locale yang belum published tidak
  // dilihat pengunjung. Sengaja tidak di-hardcode "id": begitu bahasa lain
  // dipublikasikan, ia harus ikut tersalin tanpa perlu ganti kode.
  return rows
    .filter((l) => l.published && !l.primary)
    .map((l) => ({ locale: l.locale, name: l.name }));
}

async function readTemplateResource(
  admin: AdminApiContext,
  themeId: string,
  templateName: string,
  locale: string,
): Promise<TemplateResource> {
  const res = await admin.graphql(TEMPLATE_TRANSLATIONS, {
    variables: { id: templateResourceId(themeId, templateName), locale },
  });
  const json = await res.json();
  throwOnErrors(json, `membaca terjemahan ${templateName}`);

  const node = json?.data?.translatableResource;
  if (!node) {
    throw new Error(
      `Resource terjemahan untuk ${templateName} tidak ditemukan di theme ${numericThemeId(themeId)}.`,
    );
  }

  // `translations` ikut membawa terjemahan milik SEMUA template yang namanya
  // berawalan sama: meminta `page` mengembalikan juga `page.faq`, `page.farm`,
  // dan seterusnya. Tanpa disaring, menyalin page -> page.ab-b akan menyeret teks
  // halaman lain ke dalam variant B.
  const byPath = new Map<string, ContentRow>();
  for (const row of (node.translatableContent ?? []) as ContentRow[]) {
    if (tplOf(row.key) !== templateName) continue;
    byPath.set(pathOf(row.key), row);
  }

  const translations: TranslationRow[] = [];
  for (const row of (node.translations ?? []) as Array<{
    key: string;
    value: string | null;
    outdated: boolean;
    market: { id: string } | null;
  }>) {
    if (tplOf(row.key) !== templateName) continue;
    if (row.value == null) continue;
    translations.push({
      key: row.key,
      value: row.value,
      outdated: Boolean(row.outdated),
      marketId: row.market?.id ?? null,
    });
  }

  return { resourceId: node.resourceId, byPath, translations };
}

interface DesiredValue {
  value: string;
  marketId: string | null;
}

/**
 * Tentukan terjemahan mana yang boleh dipindahkan ke variant B, dan mana yang
 * harus dikerjakan manusia.
 *
 * `digest` adalah hash NILAI, bukan hash key. Digest yang sama berarti teks
 * sumbernya identik — terjemahannya boleh dipakai apa adanya. Digest yang berbeda
 * berarti teksnya sengaja diubah, dan itulah yang sedang di-A/B-kan: menimpakan
 * terjemahan lama di situ membuat pengunjung Indonesia tetap membaca kalimat
 * variant A, jadi testnya diam-diam berubah menjadi A/A.
 */
function analyzeLocale(
  locale: string,
  source: TemplateResource,
  control: TemplateResource,
): { desired: Map<string, DesiredValue[]>; needsManual: ManualTranslation[] } {
  const desired = new Map<string, DesiredValue[]>();

  const push = (path: string, entry: DesiredValue) => {
    const list = desired.get(path);
    if (list) list.push(entry);
    else desired.set(path, [entry]);
  };

  // Sumber utama: terjemahan variant B di theme preview. Duplikasi theme ikut
  // membawa terjemahan, jadi merchant bisa menerjemahkan teks barunya di sana
  // lewat Translate & Adapt seperti biasa.
  for (const t of source.translations) {
    if (t.outdated) continue;
    const path = pathOf(t.key);
    if (!source.byPath.has(path)) continue;
    push(path, { value: t.value, marketId: t.marketId });
  }

  // Cadangan: theme preview yang sudah lama bisa belum punya terjemahan untuk
  // setting yang di variant A sudah diterjemahkan. Selama teks sumbernya identik
  // (digest sama), terjemahan variant A sah dipakai.
  for (const t of control.translations) {
    if (t.outdated) continue;
    const path = pathOf(t.key);
    if (desired.has(path)) continue;
    const src = source.byPath.get(path);
    const ctl = control.byPath.get(path);
    if (!src || !ctl) continue;
    if (src.digest !== ctl.digest) continue;
    push(path, { value: t.value, marketId: t.marketId });
  }

  // Sisanya: setting yang variant A-nya berbahasa Indonesia, tapi variant B
  // mengubah teksnya dan belum diterjemahkan. Inilah yang tidak bisa diselesaikan
  // otomatis — dan justru sering merupakan inti test-nya.
  const seen = new Set<string>();
  const needsManual: ManualTranslation[] = [];
  for (const t of control.translations) {
    const path = pathOf(t.key);
    if (desired.has(path) || seen.has(path)) continue;
    const src = source.byPath.get(path);
    if (!src) continue;
    seen.add(path);
    needsManual.push({
      locale,
      path,
      sourceText: src.value,
      controlText: control.byPath.get(path)?.value ?? null,
      controlTranslation: t.value,
    });
  }

  return { desired, needsManual };
}

/**
 * Periksa keadaan terjemahan SEBELUM variant B dibuat, untuk ditampilkan di wizard.
 *
 * Template tujuan belum ada saat ini dipanggil, jadi perbandingannya adalah
 * theme preview (calon variant B) lawan theme live (variant A).
 */
export async function planTemplateTranslations(
  admin: AdminApiContext,
  opts: { liveThemeId: string; sourceThemeId: string; templateFilename: string },
): Promise<TranslationPlan> {
  const templateName = templateNameOf(opts.templateFilename);

  try {
    const locales = await listTargetLocales(admin);
    const plans: LocalePlan[] = [];

    for (const { locale, name } of locales) {
      const [source, control] = await Promise.all([
        readTemplateResource(admin, opts.sourceThemeId, templateName, locale),
        readTemplateResource(admin, opts.liveThemeId, templateName, locale),
      ]);
      const { desired, needsManual } = analyzeLocale(locale, source, control);
      plans.push({ locale, name, willCopy: desired.size, needsManual });
    }

    return {
      locales: plans,
      willCopy: plans.reduce((n, p) => n + p.willCopy, 0),
      needsManual: plans.flatMap((p) => p.needsManual),
    };
  } catch (error) {
    // Gagal memeriksa bukan berarti aman. Dikembalikan sebagai error yang
    // ditampilkan, bukan sebagai plan kosong yang terbaca "tidak ada masalah".
    return {
      locales: [],
      willCopy: 0,
      needsManual: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Salin terjemahan ke alternate template variant B.
 *
 * WAJIB dipanggil SESUDAH file template-nya benar-benar ada di theme live:
 * resource terjemahan baru lahir setelah file-nya ada, dan digest tujuan baru
 * benar setelah isinya ditulis.
 */
export async function copyTemplateTranslations(
  admin: AdminApiContext,
  opts: {
    liveThemeId: string;
    sourceThemeId: string;
    /** template variant A, mis. "templates/product.json" */
    templateFilename: string;
    /** template variant B yang baru dibuat, mis. "templates/product.ab-b.json" */
    targetTemplateFilename: string;
  },
): Promise<TranslationCopyResult> {
  const sourceName = templateNameOf(opts.templateFilename);
  const targetName = templateNameOf(opts.targetTemplateFilename);

  const result: TranslationCopyResult = {
    copied: 0,
    skipped: 0,
    needsManual: [],
    locales: [],
    warnings: [],
  };

  const locales = await listTargetLocales(admin);
  if (locales.length === 0) return result;

  for (const { locale } of locales) {
    result.locales.push(locale);

    const [source, control, target] = await Promise.all([
      readTemplateResource(admin, opts.sourceThemeId, sourceName, locale),
      readTemplateResource(admin, opts.liveThemeId, sourceName, locale),
      readTemplateResource(admin, opts.liveThemeId, targetName, locale),
    ]);

    const { desired, needsManual } = analyzeLocale(locale, source, control);
    result.needsManual.push(...needsManual);

    // Terjemahan yang sudah ada di tujuan tidak ditulis ulang, supaya menjalankan
    // proses ini dua kali tidak menimpa suntingan manual merchant.
    const already = new Set(
      target.translations.map((t) => `${pathOf(t.key)}|${t.marketId ?? ""}`),
    );

    const inputs: Array<{
      key: string;
      locale: string;
      translatableContentDigest: string;
      value: string;
      marketId?: string;
    }> = [];

    for (const [path, values] of desired) {
      const dst = target.byPath.get(path);
      const src = source.byPath.get(path);
      if (!dst || !src) {
        // Setting-nya tidak ada di variant B — mis. section-nya dihapus.
        result.skipped += values.length;
        continue;
      }
      if (dst.digest !== src.digest) {
        // Isi template tujuan tidak sama dengan sumbernya. Menyalin ke sini
        // berarti menempelkan terjemahan pada teks yang berbeda.
        result.skipped += values.length;
        continue;
      }
      for (const v of values) {
        if (already.has(`${path}|${v.marketId ?? ""}`)) {
          result.skipped++;
          continue;
        }
        inputs.push({
          // key dan digest HARUS milik tujuan; hanya `value` yang dari sumber.
          key: dst.key,
          locale,
          translatableContentDigest: dst.digest,
          value: v.value,
          // Terjemahan yang terikat market harus ditulis ulang dengan market yang
          // sama, kalau tidak cakupannya berubah diam-diam.
          ...(v.marketId ? { marketId: v.marketId } : {}),
        });
      }
    }

    for (let i = 0; i < inputs.length; i += BATCH) {
      const batch = inputs.slice(i, i + BATCH);
      const res = await admin.graphql(TRANSLATIONS_REGISTER, {
        variables: { resourceId: target.resourceId, translations: batch },
      });
      const json = await res.json();
      throwOnErrors(json, `menulis terjemahan ${targetName}`);
      const userErrors: Array<{ field?: string[]; message: string }> =
        json?.data?.translationsRegister?.userErrors ?? [];
      if (userErrors.length > 0) {
        result.warnings.push(
          `Sebagian terjemahan ${locale} ditolak Shopify: ${userErrors
            .map((e) => e.message)
            .join("; ")}`,
        );
      }
      result.copied += json?.data?.translationsRegister?.translations?.length ?? 0;
    }
  }

  return result;
}

/**
 * Bersihkan terjemahan variant B setelah test selesai, supaya tidak jadi puing
 * yang membingungkan di Translate & Adapt.
 *
 * `translationKeys` harus memakai key lengkap berikut suffix `:<hash-key>` —
 * key tanpa hash ditolak diam-diam.
 */
export async function removeTemplateTranslations(
  admin: AdminApiContext,
  opts: { liveThemeId: string; targetTemplateFilename: string },
): Promise<{ removed: number; locales: string[]; warnings: string[] }> {
  const targetName = templateNameOf(opts.targetTemplateFilename);
  const out = { removed: 0, locales: [] as string[], warnings: [] as string[] };

  for (const { locale } of await listTargetLocales(admin)) {
    const target = await readTemplateResource(admin, opts.liveThemeId, targetName, locale);
    const keys = [...new Set(target.translations.map((t) => t.key))];
    if (keys.length === 0) continue;
    out.locales.push(locale);

    for (let i = 0; i < keys.length; i += BATCH) {
      const res = await admin.graphql(TRANSLATIONS_REMOVE, {
        variables: {
          resourceId: target.resourceId,
          locales: [locale],
          translationKeys: keys.slice(i, i + BATCH),
        },
      });
      const json = await res.json();
      throwOnErrors(json, `menghapus terjemahan ${targetName}`);
      const userErrors: Array<{ message: string }> =
        json?.data?.translationsRemove?.userErrors ?? [];
      if (userErrors.length > 0) {
        out.warnings.push(
          `Sebagian terjemahan ${locale} gagal dihapus: ${userErrors.map((e) => e.message).join("; ")}`,
        );
      }
      out.removed += json?.data?.translationsRemove?.translations?.length ?? 0;
    }
  }

  return out;
}

function throwOnErrors(json: unknown, what: string): void {
  const errors = (json as { errors?: Array<{ message: string }> })?.errors;
  if (errors && errors.length > 0) {
    throw new Error(`Gagal ${what}: ${errors.map((e) => e.message).join("; ")}`);
  }
}
