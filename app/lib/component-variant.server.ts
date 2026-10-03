import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { componentOf, type ComponentDefinition } from "./components";
import {
  defaultDrawer,
  entrySnippet,
  entryTarget,
  localeValue,
  mergeLocale,
  parseLocaleFile,
  planVariant,
  rewriteBody,
  serializeLocaleFile,
  snippetFile,
  snippetRefs,
  assetRefs,
  type FileMap,
  type VariantEntries,
  type VariantPlan,
} from "./component-variant";
import { fileChecksums, readFiles } from "./theme-analysis.server";

/**
 * Variant B of a component experiment from a draft theme — the I/O half.
 * Decisions live in component-variant.ts (pure, tested); this file only reads
 * and writes theme files. Spec: claudedocs/SPEC-component-experiments.md §10
 *
 * Three steps, each one safe on its own:
 *   analyze  — reads both themes, writes nothing
 *   prepare  — writes ONLY files nothing renders yet (copies under new names,
 *              additive translation keys), so creating an experiment never
 *              changes what any visitor sees
 *   activate — at start: points the generated entry snippets at this
 *              experiment's B. Only the running experiment owns them.
 */

const UPSERT = `#graphql
  mutation ThemeFilesUpsert($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
    themeFilesUpsert(themeId: $themeId, files: $files) {
      upsertedThemeFiles { filename }
      userErrors { filename message }
    }
  }
`;

const gid = (id: string) => (id.startsWith("gid://") ? id : `gid://shopify/OnlineStoreTheme/${id}`);

/** Files that change how the drawer looks but are not carried over — shown, never silently dropped. */
const GLOBAL_PREFIXES = ["layout/", "config/settings_data.json", "sections/Header.liquid"];

export interface VariantAnalysis {
  plan: VariantPlan;
  sourceThemeId: string;
  /** files that differ between the themes, influence the page, and are NOT carried over */
  notCarried: string[];
}

export class VariantBlockedError extends Error {
  readonly plan: VariantPlan;
  constructor(plan: VariantPlan) {
    super("Variant B dari theme ini tidak bisa dipindahkan ke live tanpa ikut mengubah variant A.");
    this.plan = plan;
  }
}

function drawerOf(componentKey: string): ComponentDefinition {
  const component = componentOf(componentKey);
  if (!component) throw new Error(`Komponen "${componentKey}" tidak dikenal.`);
  return component;
}

/** Read the whole snippet tree + its text assets from a theme, breadth-first. */
async function readTree(admin: AdminApiContext, themeId: string, entries: VariantEntries, sums: Map<string, string>) {
  const source: FileMap = new Map();
  let frontier = [snippetFile(entries.shell), snippetFile(entries.content)];
  for (let depth = 0; depth < 12 && frontier.length; depth++) {
    const toRead = [...new Set(frontier)].filter((f) => !source.has(f) && sums.has(f));
    if (!toRead.length) break;
    const bodies = await readFiles(admin, themeId, toRead);
    for (const [f, b] of bodies) source.set(f, b);
    frontier = [...bodies.values()].flatMap((b) => snippetRefs(b).map(snippetFile));
  }
  const assets = [...new Set([...source.values()].flatMap((b) => assetRefs(b).map((a) => `assets/${a}`)))].filter((a) =>
    sums.has(a),
  );
  for (const [f, b] of await readFiles(admin, themeId, assets)) source.set(f, b);
  return source;
}

async function readLocales(admin: AdminApiContext, themeId: string, sums: Map<string, string>) {
  const names = [...sums.keys()].filter((f) => /^locales\/[^/]+\.json$/.test(f) && !f.endsWith(".schema.json"));
  const raw = await readFiles(admin, themeId, names);
  const parsed: Record<string, { header: string; data: Record<string, unknown> }> = {};
  for (const [f, text] of raw) parsed[f.replace(/^locales\//, "").replace(/\.json$/, "")] = parseLocaleFile(text);
  return parsed;
}

export async function analyzeComponentVariant(
  admin: AdminApiContext,
  opts: { liveThemeId: string; sourceThemeId: string; component: string; token: string },
): Promise<VariantAnalysis> {
  const component = drawerOf(opts.component);
  const { arm, legacyShell } = component.variantB;
  const [liveSums, sourceSums] = await Promise.all([
    fileChecksums(admin, opts.liveThemeId),
    fileChecksums(admin, opts.sourceThemeId),
  ]);

  const head = await readFiles(admin, opts.sourceThemeId, [
    "sections/Header.liquid",
    "templates/cart.mini.liquid",
    snippetFile(arm),
  ]);
  const found = defaultDrawer(
    {
      header: head.get("sections/Header.liquid") ?? null,
      cartMini: head.get("templates/cart.mini.liquid") ?? null,
      arm: head.get(snippetFile(arm)) ?? null,
    },
    { arm, attribute: component.attribute, legacyShell },
  );
  if (!found.entries) {
    throw new Error(`Drawer di theme ini tidak ditemukan: ${found.problem}.`);
  }

  const [source, sourceLocales, liveLocales] = await Promise.all([
    readTree(admin, opts.sourceThemeId, found.entries, sourceSums),
    readLocales(admin, opts.sourceThemeId, sourceSums),
    readLocales(admin, opts.liveThemeId, liveSums),
  ]);
  const primaryLocale = Object.keys(liveLocales).find((l) => l.endsWith(".default")) ?? "en.default";

  const plan = planVariant({
    token: opts.token,
    entries: found.entries,
    source,
    sourceSums,
    liveSums,
    sourceLocales: Object.fromEntries(Object.entries(sourceLocales).map(([k, v]) => [k, v.data])),
    liveLocales: Object.fromEntries(Object.entries(liveLocales).map(([k, v]) => [k, v.data])),
    primaryLocale,
  });

  // generated names must not already exist in live (a token collision would overwrite)
  for (const f of [...plan.files, ...plan.assets]) {
    if (f.action === "isolate" && liveSums.has(f.target)) {
      plan.blocking.push({ file: f.target, reason: "a file with this generated name already exists in live" });
      plan.entries = null;
    }
  }

  const tree = new Set([...plan.files.map((f) => f.source), ...plan.assets.map((a) => a.source)]);
  const notCarried = [...sourceSums.keys()]
    .filter((f) => !tree.has(f) && liveSums.get(f) !== sourceSums.get(f))
    .filter((f) => GLOBAL_PREFIXES.some((p) => f.startsWith(p)) || (f.startsWith("assets/") && liveSums.has(f)))
    .sort();

  return { plan, sourceThemeId: opts.sourceThemeId, notCarried };
}

async function upsert(admin: AdminApiContext, themeId: string, files: Array<{ filename: string; value: string }>) {
  for (let i = 0; i < files.length; i += 50) {
    const res = await admin.graphql(UPSERT, {
      variables: {
        themeId: gid(themeId),
        files: files.slice(i, i + 50).map((f) => ({ filename: f.filename, body: { type: "TEXT", value: f.value } })),
      },
    });
    const json = await res.json();
    const errors: Array<{ filename?: string; message: string }> = json?.data?.themeFilesUpsert?.userErrors ?? [];
    if (errors.length) {
      throw new Error(`Gagal menulis ke theme live: ${errors.map((e) => `${e.filename ?? ""} ${e.message}`).join("; ")}`);
    }
  }
}

export interface PrepareVariantResult {
  plan: VariantPlan;
  written: string[];
  localesChanged: Record<string, number>;
  notCarried: string[];
}

/**
 * Copy B into live under new names. Writes nothing any visitor renders: the
 * copies are only reachable through the entry snippets, which `activate`
 * points at them when THIS experiment starts.
 */
export async function prepareComponentVariant(
  admin: AdminApiContext,
  opts: { liveThemeId: string; sourceThemeId: string; component: string; token: string },
): Promise<PrepareVariantResult> {
  const analysis = await analyzeComponentVariant(admin, opts);
  const { plan } = analysis;
  if (plan.blocking.length || !plan.entries) throw new VariantBlockedError(plan);

  const isolatedFiles = plan.files.filter((f) => f.action === "isolate");
  const isolatedAssets = plan.assets.filter((a) => a.action === "isolate");
  const bodies = await readFiles(admin, opts.sourceThemeId, [...isolatedFiles, ...isolatedAssets].map((f) => f.source));
  const writes: Array<{ filename: string; value: string }> = [];
  for (const f of isolatedFiles) writes.push({ filename: f.target, value: rewriteBody(bodies.get(f.source) ?? "", plan) });
  for (const a of isolatedAssets) writes.push({ filename: a.target, value: bodies.get(a.source) ?? "" });

  // translation keys: merged into the CURRENT live files, never replacing them
  const localesChanged: Record<string, number> = {};
  if (plan.localeKeys.length) {
    const liveSums = await fileChecksums(admin, opts.liveThemeId);
    const sourceSums = await fileChecksums(admin, opts.sourceThemeId);
    const [liveLocales, sourceLocales] = await Promise.all([
      readLocales(admin, opts.liveThemeId, liveSums),
      readLocales(admin, opts.sourceThemeId, sourceSums),
    ]);
    for (const [name, live] of Object.entries(liveLocales)) {
      const src = sourceLocales[name];
      if (!src) continue;
      const { merged, changed } = mergeLocale(live.data, src.data, plan);
      if (!changed) continue;
      localesChanged[name] = changed;
      writes.push({ filename: `locales/${name}.json`, value: serializeLocaleFile(live.header, merged) });
    }
  }

  // copies first, translations last: a key may only appear once its readers exist
  const locales = writes.filter((w) => w.filename.startsWith("locales/"));
  await upsert(admin, opts.liveThemeId, writes.filter((w) => !w.filename.startsWith("locales/")));
  await upsert(admin, opts.liveThemeId, locales);

  await verifyWritten(admin, opts.liveThemeId, writes, plan);
  return { plan, written: writes.map((w) => w.filename), localesChanged, notCarried: analysis.notCarried };
}

/**
 * Read back what was written. themeFilesUpsert can drop content without a
 * userError (e.g. locale keys Shopify does not accept), so success of the
 * mutation proves nothing.
 */
async function verifyWritten(
  admin: AdminApiContext,
  themeId: string,
  writes: Array<{ filename: string; value: string }>,
  plan: VariantPlan,
) {
  const back = await readFiles(admin, themeId, writes.map((w) => w.filename));
  const problems: string[] = [];
  for (const w of writes) {
    const got = back.get(w.filename);
    if (got == null) {
      problems.push(`${w.filename} tidak ada setelah ditulis`);
      continue;
    }
    if (!w.filename.startsWith("locales/")) continue;
    // Shopify reformats locale files, so compare the keys, not the bytes
    const data = parseLocaleFile(got).data;
    const wanted = parseLocaleFile(w.value).data;
    for (const k of plan.localeKeys) {
      if (JSON.stringify(localeValue(data, k.target)) !== JSON.stringify(localeValue(wanted, k.target))) {
        problems.push(`${w.filename}: kunci ${k.target} tidak tersimpan`);
      }
    }
  }
  if (problems.length) throw new Error(`Penulisan variant B tidak utuh: ${problems.join("; ")}.`);
}

/**
 * Point the generated entry snippets at an experiment's B. Called when a
 * component experiment starts; refuses when a copy it renders is missing,
 * because the arm would then render a Liquid error to group B.
 */
export async function activateComponentVariant(
  admin: AdminApiContext,
  opts: { liveThemeId: string; component: string; entries: VariantEntries | null; owner: string },
): Promise<{ entries: VariantEntries; changed: boolean }> {
  const component = drawerOf(opts.component);
  if (!opts.entries) {
    throw new Error("Eksperimen ini belum punya varian B. Buat ulang dengan memilih draft theme sebagai sumber varian B.");
  }
  const target = opts.entries;
  const gen = component.variantB.entries;

  const sums = await fileChecksums(admin, opts.liveThemeId);
  for (const name of [target.shell, target.content]) {
    if (!sums.has(snippetFile(name))) {
      throw new Error(`Variant B tidak lengkap di theme live: ${snippetFile(name)} tidak ada. Siapkan ulang dari draft theme.`);
    }
  }

  const current = await readFiles(admin, opts.liveThemeId, [
    snippetFile(gen.shell),
    snippetFile(gen.content),
    snippetFile(target.shell),
  ]);
  const writes: Array<{ filename: string; value: string }> = [];
  if (entryTarget(current.get(snippetFile(gen.shell)) ?? null) !== target.shell) {
    writes.push({
      filename: snippetFile(gen.shell),
      value: entrySnippet(target.shell, "shell", opts.owner, current.get(snippetFile(target.shell)) ?? ""),
    });
  }
  if (entryTarget(current.get(snippetFile(gen.content)) ?? null) !== target.content) {
    writes.push({ filename: snippetFile(gen.content), value: entrySnippet(target.content, "content", opts.owner) });
  }
  if (writes.length) {
    await upsert(admin, opts.liveThemeId, writes);
    const back = await readFiles(admin, opts.liveThemeId, writes.map((w) => w.filename));
    if (
      entryTarget(back.get(snippetFile(gen.shell)) ?? current.get(snippetFile(gen.shell)) ?? null) !== target.shell ||
      entryTarget(back.get(snippetFile(gen.content)) ?? current.get(snippetFile(gen.content)) ?? null) !== target.content
    ) {
      throw new Error("Entry variant B tidak tersimpan di theme live.");
    }
  }
  return { entries: target, changed: writes.length > 0 };
}

/** Which B the live entries render right now (health checks, detail page). */
export async function liveEntries(admin: AdminApiContext, themeId: string, componentKey: string) {
  const gen = drawerOf(componentKey).variantB.entries;
  const files = await readFiles(admin, themeId, [snippetFile(gen.shell), snippetFile(gen.content)]);
  return {
    shell: entryTarget(files.get(snippetFile(gen.shell)) ?? null),
    content: entryTarget(files.get(snippetFile(gen.content)) ?? null),
  };
}
