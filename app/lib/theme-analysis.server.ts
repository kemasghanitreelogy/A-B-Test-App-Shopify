import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { copyTemplateTranslations, type TranslationCopyResult } from "./translations.server";

/**
 * Analisis theme untuk wizard pemilihan halaman.
 *
 * Semua fungsi di sini butuh token Admin, jadi hanya boleh dipanggil dari app ini
 * (Fly.io) — bukan dari dashboard. Token offline berumur satu jam dan di-refresh
 * oleh library di sini; dashboard tidak memegang token sama sekali.
 */

export interface ThemeSummary {
  id: string;
  numericId: string;
  name: string;
  role: string;
  updatedAt: string | null;
}

export interface PageTypeInfo {
  /** product, collection, index, page, blog, article, search, ... */
  type: string;
  /** null = template default; "context.europe" = alternate template */
  suffix: string | null;
  filename: string;
  /** true kalau JSON (Online Store 2.0) — hanya JSON yang mendukung alternate template */
  isJson: boolean;
}

/** File theme dikelompokkan menurut seberapa aman ia dipindahkan antar theme. */
export type ChangeClass = "safe" | "isolatable" | "blocking";

export interface ChangedFile {
  filename: string;
  status: "changed" | "added" | "removed";
  changeClass: ChangeClass;
  reason: string;
}

const THEMES_QUERY = `#graphql
  query Themes {
    themes(first: 50) {
      nodes { id name role updatedAt }
    }
  }
`;

const FILE_LIST_QUERY = `#graphql
  query ThemeFileList($id: ID!, $cursor: String) {
    theme(id: $id) {
      files(first: 250, after: $cursor) {
        nodes { filename checksumMd5 size }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const FILE_BODY_QUERY = `#graphql
  query ThemeFileBodies($id: ID!, $filenames: [String!]!) {
    theme(id: $id) {
      files(first: 50, filenames: $filenames) {
        nodes {
          filename
          body { ... on OnlineStoreThemeFileBodyText { content } }
        }
      }
    }
  }
`;

const FILES_UPSERT = `#graphql
  mutation ThemeFilesUpsert($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
    themeFilesUpsert(themeId: $themeId, files: $files) {
      upsertedThemeFiles { filename }
      userErrors { filename message }
    }
  }
`;

function gid(numericOrGid: string): string {
  return numericOrGid.startsWith("gid://")
    ? numericOrGid
    : `gid://shopify/OnlineStoreTheme/${numericOrGid}`;
}

export async function listThemes(admin: AdminApiContext): Promise<ThemeSummary[]> {
  const res = await admin.graphql(THEMES_QUERY);
  const json = await res.json();
  const nodes: Array<{ id: string; name: string; role: string; updatedAt: string | null }> =
    json?.data?.themes?.nodes ?? [];
  return nodes.map((t) => ({
    id: t.id,
    numericId: t.id.split("/").pop() ?? "",
    name: t.name,
    role: String(t.role).toLowerCase(),
    updatedAt: t.updatedAt,
  }));
}

/** Semua nama file dalam sebuah theme, beserta checksum-nya. */
export async function fileChecksums(
  admin: AdminApiContext,
  themeId: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let cursor: string | null = null;

  // Theme besar bisa punya ribuan file; 12 halaman x 250 sudah lebih dari cukup
  // dan mencegah loop tak berujung kalau pageInfo bermasalah.
  for (let page = 0; page < 12; page++) {
    const res = await admin.graphql(FILE_LIST_QUERY, {
      variables: { id: gid(themeId), cursor },
    });
    const json = (await res.json()) as {
      data?: {
        theme?: {
          files?: {
            nodes: Array<{ filename: string; checksumMd5: string }>;
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        };
      };
    };
    const conn = json?.data?.theme?.files;
    if (!conn) break;
    for (const n of conn.nodes) out.set(n.filename, n.checksumMd5);
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out;
}

export async function readFiles(
  admin: AdminApiContext,
  themeId: string,
  filenames: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  // Query menerima maksimal 50 file sekaligus.
  for (let i = 0; i < filenames.length; i += 50) {
    const res = await admin.graphql(FILE_BODY_QUERY, {
      variables: { id: gid(themeId), filenames: filenames.slice(i, i + 50) },
    });
    const json = await res.json();
    for (const n of json?.data?.theme?.files?.nodes ?? []) {
      if (n?.body?.content != null) out.set(n.filename, n.body.content);
    }
  }
  return out;
}

/** Halaman apa saja yang bisa di-A/B test pada sebuah theme. */
export async function listPageTypes(
  admin: AdminApiContext,
  themeId: string,
): Promise<PageTypeInfo[]> {
  const files = await fileChecksums(admin, themeId);
  const out: PageTypeInfo[] = [];

  for (const filename of files.keys()) {
    if (!filename.startsWith("templates/")) continue;
    if (filename.startsWith("templates/customers/")) continue;

    const base = filename.slice("templates/".length);
    const isJson = base.endsWith(".json");
    const isLiquid = base.endsWith(".liquid");
    if (!isJson && !isLiquid) continue;

    const stem = base.replace(/\.(json|liquid)$/, "");
    const [type, ...rest] = stem.split(".");
    out.push({
      type,
      suffix: rest.length > 0 ? rest.join(".") : null,
      filename,
      isJson,
    });
  }

  return out.sort((a, b) => a.type.localeCompare(b.type) || (a.suffix ?? "").localeCompare(b.suffix ?? ""));
}

/**
 * Kelaskan sebuah file menurut apakah ia bisa dipindahkan tanpa menyentuh variant A.
 *
 * Ini inti keamanan seluruh fitur. Menyalin file yang salah berarti mengubah
 * tampilan variant A juga — dan hasilnya bukan error, melainkan test yang
 * membandingkan dua hal yang sama tanpa ada yang menyadarinya.
 */
export function classifyFile(filename: string): { changeClass: ChangeClass; reason: string } {
  if (filename.startsWith("templates/")) {
    return {
      changeClass: "safe",
      reason: "Template berdiri sendiri — bisa disalin sebagai alternate template tanpa menyentuh variant A.",
    };
  }
  if (filename.startsWith("sections/") || filename.startsWith("snippets/")) {
    return {
      changeClass: "isolatable",
      reason: "Dipakai bersama variant A, tapi bisa disalin dengan nama baru lalu rujukannya ditulis ulang.",
    };
  }
  if (filename.startsWith("assets/")) {
    return {
      changeClass: "blocking",
      reason: "Aset dimuat global oleh layout, tidak bisa dibedakan per template.",
    };
  }
  if (filename.startsWith("layout/")) {
    return {
      changeClass: "blocking",
      reason: "Layout membungkus semua halaman, termasuk variant A.",
    };
  }
  if (filename.startsWith("config/")) {
    return {
      changeClass: "blocking",
      reason: "Setting theme berlaku untuk seluruh toko.",
    };
  }
  if (filename.startsWith("locales/")) {
    return {
      changeClass: "blocking",
      reason: "Terjemahan berlaku untuk seluruh toko.",
    };
  }
  return { changeClass: "blocking", reason: "Jenis file tidak dikenali; tidak diambil risiko." };
}

export interface ThemeDiff {
  files: ChangedFile[];
  counts: Record<ChangeClass, number>;
}

export async function diffThemes(
  admin: AdminApiContext,
  liveThemeId: string,
  otherThemeId: string,
): Promise<ThemeDiff> {
  const [live, other] = await Promise.all([
    fileChecksums(admin, liveThemeId),
    fileChecksums(admin, otherThemeId),
  ]);

  const files: ChangedFile[] = [];
  for (const [filename, checksum] of other) {
    if (!live.has(filename)) {
      files.push({ filename, status: "added", ...classifyFile(filename) });
    } else if (live.get(filename) !== checksum) {
      files.push({ filename, status: "changed", ...classifyFile(filename) });
    }
  }
  for (const filename of live.keys()) {
    if (!other.has(filename)) {
      files.push({ filename, status: "removed", ...classifyFile(filename) });
    }
  }

  const counts: Record<ChangeClass, number> = { safe: 0, isolatable: 0, blocking: 0 };
  for (const f of files) counts[f.changeClass]++;

  files.sort((a, b) => a.filename.localeCompare(b.filename));
  return { files, counts };
}

export interface PrepareResult {
  templateFilename: string;
  isolatedFiles: Array<{ from: string; to: string }>;
  warnings: string[];
  /** Hasil penyalinan terjemahan template; null kalau gagal dijalankan. */
  translations: TranslationCopyResult | null;
}

export class BlockingChangeError extends Error {
  constructor(public readonly files: ChangedFile[]) {
    super(
      "Perubahan pada theme preview ini tidak bisa dipindahkan tanpa ikut mengubah variant A.",
    );
  }
}

/** "ab-b" -> "abb". Nama section dipakai sebagai `type` di JSON, jadi harus polos. */
function sectionToken(suffix: string): string {
  return suffix.replace(/[^a-z0-9]/gi, "").toLowerCase() || "abb";
}

/** Semua nama section yang dirujuk sebuah template JSON. */
function sectionTypesIn(templateJson: string): string[] {
  try {
    const parsed = JSON.parse(templateJson) as { sections?: Record<string, { type?: string }> };
    return [
      ...new Set(
        Object.values(parsed.sections ?? {})
          .map((s) => s?.type)
          .filter((t): t is string => typeof t === "string"),
      ),
    ];
  } catch {
    return [];
  }
}

/** Snippet yang dirujuk sebuah file Liquid lewat render/include. */
function snippetRefsIn(liquid: string): string[] {
  const refs = new Set<string>();
  const re = /\{%-?\s*(?:render|include)\s+'([^']+)'|\{%-?\s*(?:render|include)\s+"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(liquid)) !== null) {
    const name = m[1] ?? m[2];
    if (name) refs.add(name);
  }
  return [...refs];
}

/**
 * Bangun variant B di theme live dari sebuah theme preview.
 *
 * Prinsip yang dipegang: **variant A tidak boleh berubah satu byte pun.** Karena
 * itu tidak ada satu file pun milik live yang ditimpa — semuanya disalin dengan
 * nama baru, dan rujukannya ditulis ulang di dalam salinan itu.
 *
 * Kalau ada perubahan yang tidak bisa diisolasi (aset, layout, setting), proses
 * dibatalkan. Melanjutkan berarti variant B di live tidak akan sama dengan yang
 * dilihat di preview, dan tidak akan ada yang menyadarinya sampai hasil test
 * terlanjur dipakai mengambil keputusan.
 */
export async function prepareVariantFromTheme(
  admin: AdminApiContext,
  opts: {
    liveThemeId: string;
    sourceThemeId: string;
    /** mis. "templates/product.json" */
    templateFilename: string;
    /** mis. "ab-b" */
    suffix: string;
  },
): Promise<PrepareResult> {
  const { liveThemeId, sourceThemeId, templateFilename, suffix } = opts;

  const diff = await diffThemes(admin, liveThemeId, sourceThemeId);
  const blocking = diff.files.filter((f) => f.changeClass === "blocking" && f.status !== "removed");
  if (blocking.length > 0) throw new BlockingChangeError(blocking);

  const changed = new Set(
    diff.files.filter((f) => f.status !== "removed").map((f) => f.filename),
  );

  const token = sectionToken(suffix);
  const isolatedFiles: PrepareResult["isolatedFiles"] = [];
  const warnings: string[] = [];

  // Template B selalu diambil dari theme sumber.
  const templates = await readFiles(admin, sourceThemeId, [templateFilename]);
  let templateBody = templates.get(templateFilename);
  if (!templateBody) {
    throw new Error(`${templateFilename} tidak ditemukan di theme sumber.`);
  }

  // --- Tahap 1: section yang dirujuk template dan memang berubah ---
  const sectionsToIsolate = sectionTypesIn(templateBody).filter((type) =>
    changed.has(`sections/${type}.liquid`),
  );

  const upserts: Array<{ filename: string; body: { type: "TEXT"; value: string } }> = [];
  const renameMap = new Map<string, string>();

  const sectionBodies = await readFiles(
    admin,
    sourceThemeId,
    sectionsToIsolate.map((t) => `sections/${t}.liquid`),
  );

  // --- Tahap 2: telusuri snippet yang dirujuk section terisolasi, maksimal 3 tingkat ---
  const snippetsToIsolate = new Set<string>();
  let frontier = [...sectionBodies.values()];
  for (let depth = 0; depth < 3 && frontier.length > 0; depth++) {
    const next: string[] = [];
    const discovered: string[] = [];
    for (const body of frontier) {
      for (const ref of snippetRefsIn(body)) {
        if (!changed.has(`snippets/${ref}.liquid`)) continue;
        if (snippetsToIsolate.has(ref)) continue;
        snippetsToIsolate.add(ref);
        discovered.push(ref);
      }
    }
    if (discovered.length === 0) break;
    const bodies = await readFiles(
      admin,
      sourceThemeId,
      discovered.map((r) => `snippets/${r}.liquid`),
    );
    for (const [name, body] of bodies) {
      next.push(body);
      sectionBodies.set(name, body);
    }
    frontier = next;
  }

  // --- Tahap 3: tulis salinan bernama baru, dengan rujukan internal ikut ditulis ulang ---
  for (const type of sectionsToIsolate) renameMap.set(`sections/${type}.liquid`, `sections/${type}-${token}.liquid`);
  for (const name of snippetsToIsolate) renameMap.set(`snippets/${name}.liquid`, `snippets/${name}-${token}.liquid`);

  for (const [original, target] of renameMap) {
    let body = sectionBodies.get(original);
    if (body == null) {
      warnings.push(`Isi ${original} tidak terbaca, dilewati.`);
      continue;
    }
    // Rujukan ke snippet yang ikut diisolasi harus menunjuk salinannya, bukan aslinya.
    for (const snippet of snippetsToIsolate) {
      body = body
        .replaceAll(`'${snippet}'`, `'${snippet}-${token}'`)
        .replaceAll(`"${snippet}"`, `"${snippet}-${token}"`);
    }
    upserts.push({ filename: target, body: { type: "TEXT", value: body } });
    isolatedFiles.push({ from: original, to: target });
  }

  // --- Tahap 4: tulis ulang `type` section di template B ---
  for (const type of sectionsToIsolate) {
    templateBody = templateBody
      .replaceAll(`"type": "${type}"`, `"type": "${type}-${token}"`)
      .replaceAll(`"type":"${type}"`, `"type":"${type}-${token}"`);
  }

  const targetTemplate = templateFilename.replace(/\.(json|liquid)$/, (ext) => `.${suffix}${ext}`);
  upserts.push({ filename: targetTemplate, body: { type: "TEXT", value: templateBody } });

  const res = await admin.graphql(FILES_UPSERT, {
    variables: { themeId: gid(liveThemeId), files: upserts },
  });
  const json = await res.json();
  const errors: Array<{ filename?: string; message: string }> =
    json?.data?.themeFilesUpsert?.userErrors ?? [];
  if (errors.length > 0) {
    throw new Error(
      `Gagal menulis ke theme live: ${errors.map((e) => `${e.filename ?? ""} ${e.message}`).join("; ")}`,
    );
  }

  if (isolatedFiles.length > 0) {
    warnings.push(
      `${isolatedFiles.length} file disalin dengan nama baru supaya variant A tidak ikut berubah. ` +
        `Kalau nanti kamu mengedit versi aslinya di theme editor, salinan ini TIDAK ikut berubah.`,
    );
  }

  // Terjemahan template BARU bisa disalin setelah file-nya benar-benar ada:
  // resource terjemahannya baru lahir sesudah itu, dan digest tujuan baru benar
  // sesudah isinya ditulis. Urutan ini tidak boleh dibalik.
  let translations: TranslationCopyResult | null = null;
  try {
    translations = await copyTemplateTranslations(admin, {
      liveThemeId,
      sourceThemeId,
      templateFilename,
      targetTemplateFilename: targetTemplate,
    });
    if (translations.needsManual.length > 0) {
      warnings.push(
        `${translations.needsManual.length} teks variant B belum punya terjemahan. ` +
          `Pengunjung berbahasa non-primary akan melihatnya dalam bahasa Inggris.`,
      );
    }
    warnings.push(...translations.warnings);
  } catch (error) {
    // Template-nya sudah terlanjur ada, jadi menggagalkan seluruh proses di sini
    // justru meninggalkan keadaan setengah jadi. Yang dilakukan: dikeraskan
    // menjadi peringatan yang tidak bisa diabaikan diam-diam.
    warnings.push(
      `TERJEMAHAN TIDAK TERSALIN: ${error instanceof Error ? error.message : String(error)}. ` +
        `Variant B akan tampil dalam bahasa Inggris untuk pengunjung non-primary. ` +
        `Jangan jalankan test sebelum ini beres.`,
    );
  }

  return { templateFilename: targetTemplate, isolatedFiles, warnings, translations };
}
