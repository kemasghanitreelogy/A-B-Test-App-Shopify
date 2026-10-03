/**
 * Variant B of a COMPONENT experiment, built from a draft theme — pure core
 * (no I/O, shared by the server, the dashboard and the tests).
 *
 * Same rules as the page-template flow (theme-analysis.server.ts):
 *   1. Variant A must not change by a single byte. Nothing the live theme
 *      already renders is overwritten; whatever differs is copied under a new
 *      name and the references inside the copies are rewritten.
 *   2. Variant B in live must be what the draft's preview shows. Anything that
 *      cannot be carried over faithfully blocks, it is never silently dropped.
 *
 * "The drawer of the draft" = what the draft renders for a visitor WITHOUT the
 * test attribute, i.e. exactly what its theme preview shows.
 *
 * Because a component's render tree can be traced exactly, two things the
 * template flow has to block are isolatable here:
 *   - assets the component loads (`'x.js' | asset_url`) → `x-<token>.js`
 *   - translation keys whose text differs → `abx_<token>.<key>`
 * New translation keys are additive (A never reads them).
 *
 * Spec: claudedocs/SPEC-component-experiments.md §10
 */

export type FileMap = Map<string, string>; // filename → content (absent = not read / not text)
export type SumMap = Map<string, string>; // filename → checksum (absent = file does not exist)

export interface VariantPlanFile {
  /** file in the draft theme */
  source: string;
  /** file in the live theme (same as source when reused) */
  target: string;
  /** reuse = live already has it byte-identical and nothing below it changed */
  action: "reuse" | "isolate";
  status: "identical" | "changed" | "added" | "depends_on_changed";
}

export interface LocaleKeyPlan {
  key: string;
  /** add = missing in live · isolate = text differs from live → abx_<token>.<flat key> */
  action: "add" | "isolate";
  target: string;
}

export interface VariantEntries {
  /** snippet names (no folder, no extension) the arm renders for B */
  shell: string;
  content: string;
}

export interface VariantPlan {
  token: string;
  /** the draft's own drawer snippets (before isolation) */
  sourceEntries: VariantEntries | null;
  /** what the generated live entry snippets must render (after isolation) */
  entries: VariantEntries | null;
  files: VariantPlanFile[];
  assets: VariantPlanFile[];
  localeKeys: LocaleKeyPlan[];
  /** keys B uses that have no translation in a non-primary locale of the draft */
  untranslated: Array<{ key: string; locale: string }>;
  blocking: Array<{ file: string; reason: string }>;
  warnings: string[];
  /** true when B renders exactly what A renders (A/A test) */
  identicalToLive: boolean;
}

const PLURAL_KEYS = new Set(["zero", "one", "two", "few", "many", "other"]);

/** Liquid without {% doc %} / {% comment %} blocks — prose there is not code. */
export function codeOf(liquid: string): string {
  return liquid
    .replace(/\{%-?\s*doc\s*-?%\}[\s\S]*?\{%-?\s*enddoc\s*-?%\}/g, "")
    .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, "");
}

/** Statement lines inside {% liquid %} blocks. */
function liquidBlockLines(code: string): string[] {
  const out: string[] = [];
  const re = /\{%-?\s*liquid\b([\s\S]*?)-?%\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) out.push(...m[1].split("\n"));
  return out;
}

/** Snippets a Liquid file renders (render/include, tag or {% liquid %} form). */
export function snippetRefs(liquid: string): string[] {
  const code = codeOf(liquid);
  const out = new Set<string>();
  const tag = /\{%-?\s*(?:render|include)\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(code)) !== null) out.add(m[1]);
  for (const line of liquidBlockLines(code)) {
    const l = /^\s*(?:render|include)\s+['"]([^'"]+)['"]/.exec(line);
    if (l) out.add(l[1]);
  }
  return [...out];
}

/** render/include of a variable — the snippet name is only known at render time. */
export function hasDynamicRender(liquid: string): boolean {
  const code = codeOf(liquid);
  if (/\{%-?\s*(?:render|include)\s+[A-Za-z_]/.test(code)) return true;
  return liquidBlockLines(code).some((l) => /^\s*(?:render|include)\s+[A-Za-z_]/.test(l));
}

/** {% stylesheet %} / {% javascript %}: Shopify bundles these into EVERY page. */
export function hasBundledAssetTag(liquid: string): boolean {
  return /\{%-?\s*(?:stylesheet|javascript)\s*-?%\}/.test(codeOf(liquid));
}

export function assetRefs(liquid: string): string[] {
  const out = new Set<string>();
  const re = /['"]([A-Za-z0-9_.-]+\.[A-Za-z0-9]+)['"]\s*\|\s*asset_url/g;
  let m: RegExpExecArray | null;
  const code = codeOf(liquid);
  while ((m = re.exec(code)) !== null) out.add(m[1]);
  return [...out];
}

/** A translation leaf: a string, or a pluralization object ({one, other, …}). */
function isLeaf(v: unknown): boolean {
  if (typeof v === "string") return true;
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.length > 0 && keys.every((k) => PLURAL_KEYS.has(k));
}

/**
 * Translation keys a file uses: every quoted dotted literal that resolves to a
 * leaf in the locale. Literal-based on purpose — themes assign keys to a
 * variable first (`assign k = 'cart_v3.change_pack'` … `{{ k | t }}`), which a
 * `'key' | t` pattern would miss.
 */
export function translationRefs(liquid: string, locale: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const re = /['"]([a-z0-9_]+(?:\.[a-z0-9_]+)+)['"]/gi;
  let m: RegExpExecArray | null;
  const code = codeOf(liquid);
  while ((m = re.exec(code)) !== null) if (isLeaf(localeValue(locale, m[1]))) out.add(m[1]);
  return [...out];
}

/** `'prefix.' | append: x | t` — a key built at render time cannot be traced. */
export function hasDynamicTranslationKey(liquid: string): boolean {
  return /['"][a-z0-9_.]*\.['"]\s*\|\s*append\b/i.test(codeOf(liquid));
}

export function localeValue(locale: unknown, key: string): unknown {
  let node = locale as Record<string, unknown> | undefined;
  for (const part of key.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = node[part] as Record<string, unknown> | undefined;
  }
  return node;
}

export function setLocaleValue(locale: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".");
  let node = locale;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!node[parts[i]] || typeof node[parts[i]] !== "object") node[parts[i]] = {};
    node = node[parts[i]] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]] = value;
}

/** Shopify locale files start with a block comment, which JSON.parse rejects. */
export function parseLocaleFile(text: string): { header: string; data: Record<string, unknown> } {
  const m = /^\s*\/\*[\s\S]*?\*\/\s*/.exec(text);
  const header = m ? m[0] : "";
  return { header, data: JSON.parse(text.slice(header.length)) as Record<string, unknown> };
}

export function serializeLocaleFile(header: string, data: Record<string, unknown>): string {
  return `${header}${JSON.stringify(data, null, 2)}\n`;
}

/* ---------------- which drawer does a theme render by default? ---------------- */

interface Tag {
  start: number;
  end: number;
  body: string;
}

function tagsOf(code: string): Tag[] {
  const out: Tag[] = [];
  const re = /\{%-?([\s\S]*?)-?%\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) out.push({ start: m.index, end: m.index + m[0].length, body: m[1].trim() });
  return out;
}

const OPENERS = /^(if|unless|case|for|tablerow|capture|form|paginate)\b/;
const CLOSERS = /^end(if|unless|case|for|tablerow|capture|form|paginate)\b/;

/** Branches of the first {% if %} whose condition matches. null = not found. */
export function ifBranches(code: string, condition: RegExp): { then: string; else: string; condition: string } | null {
  const tags = tagsOf(code);
  const i = tags.findIndex((t) => /^if\b/.test(t.body) && condition.test(t.body));
  if (i < 0) return null;
  let depth = 0;
  let elseAt: Tag | null = null;
  for (let j = i + 1; j < tags.length; j++) {
    const b = tags[j].body;
    if (OPENERS.test(b)) depth++;
    else if (CLOSERS.test(b)) {
      if (depth === 0) {
        const thenEnd = elseAt ? elseAt.start : tags[j].start;
        return {
          condition: tags[i].body,
          then: code.slice(tags[i].end, thenEnd),
          else: elseAt ? code.slice(elseAt.end, tags[j].start) : "",
        };
      }
      depth--;
    } else if (depth === 0 && /^(else|elsif)\b/.test(b) && !elseAt) elseAt = tags[j];
  }
  return null;
}

/**
 * The drawer the arm snippet renders for a visitor without the attribute:
 * `== 'B'` → the else-branch, `!= 'A'` (B shipped permanently) → the if-branch.
 */
export function armDefault(arm: string, attribute: string): VariantEntries | null {
  const code = codeOf(arm);
  const sw = ifBranches(code, new RegExp(escapeRe(attribute)));
  if (!sw) return null;
  const branch = /!=\s*['"]A['"]/.test(sw.condition) ? sw.then : sw.else;
  const part = ifBranches(branch, /\bpart\s*(?:==|!=)\s*['"]content['"]/);
  if (!part) return null;
  const contentFirst = /==/.test(part.condition);
  const contentRefs = snippetRefs(contentFirst ? part.then : part.else);
  const shellRefs = snippetRefs(contentFirst ? part.else : part.then);
  return contentRefs[0] && shellRefs[0] ? { shell: shellRefs[0], content: contentRefs[0] } : null;
}

/**
 * Entry snippets of the drawer a theme shows by default. Header renders either
 * the arm snippet or the drawer shell directly; cart?view=mini renders either
 * the arm or the drawer content directly.
 */
export function defaultDrawer(
  files: { header: string | null; cartMini: string | null; arm: string | null },
  opts: { arm: string; attribute: string; legacyShell: string },
): { entries: VariantEntries | null; problem: string | null } {
  if (!files.header) return { entries: null, problem: "sections/Header.liquid missing in the draft theme" };
  if (!files.cartMini) return { entries: null, problem: "templates/cart.mini.liquid missing in the draft theme" };
  const viaArm = (body: string) => snippetRefs(body).includes(opts.arm);
  const fromArm = files.arm ? armDefault(files.arm, opts.attribute) : null;

  let shell: string | null = null;
  if (viaArm(files.header)) shell = fromArm?.shell ?? null;
  else if (snippetRefs(files.header).includes(opts.legacyShell)) shell = opts.legacyShell;
  let content: string | null = null;
  if (viaArm(files.cartMini)) content = fromArm?.content ?? null;
  else content = snippetRefs(files.cartMini)[0] ?? null;

  if (!shell) return { entries: null, problem: "could not find which drawer the draft's Header renders" };
  if (!content) return { entries: null, problem: "could not find which drawer content the draft's cart.mini renders" };
  return { entries: { shell, content }, problem: null };
}

/* ---------------- the plan ---------------- */

export interface PlanInput {
  token: string;
  entries: VariantEntries;
  /** text contents of the draft's files in the tree (snippets + text assets) */
  source: FileMap;
  /** checksums of every file in the draft / live theme */
  sourceSums: SumMap;
  liveSums: SumMap;
  /** parsed locale files keyed by name without extension ("en.default", "id") */
  sourceLocales: Record<string, Record<string, unknown>>;
  liveLocales: Record<string, Record<string, unknown>>;
  /** primary locale name, e.g. "en.default" */
  primaryLocale: string;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const snippetFile = (name: string) => `snippets/${name}.liquid`;
const snippetName = (file: string) => file.replace(/^snippets\//, "").replace(/\.liquid$/, "");
const tokenSafe = (token: string) => token.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Name of a translation key B owns, flattened to two levels. */
export function isolatedKey(token: string, key: string): string {
  return `abx_${tokenSafe(token)}.${key.replace(/\./g, "__")}`;
}

/** Snippet tree reachable from the entries, with each file's direct children. */
export function renderTree(entries: string[], source: FileMap): { files: string[]; children: Map<string, string[]> } {
  const children = new Map<string, string[]>();
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const body = source.get(file);
    if (body == null) continue;
    const kids = snippetRefs(body).map(snippetFile);
    children.set(file, kids);
    for (const k of kids) if (!seen.has(k)) queue.push(k);
  }
  return { files: [...seen], children };
}

/** Build the isolation plan. Pure: the server reads the files, this decides. */
export function planVariant(input: PlanInput): VariantPlan {
  const { token, source, sourceSums, liveSums } = input;
  const tok = tokenSafe(token);
  const blocking: VariantPlan["blocking"] = [];
  const warnings: string[] = [];
  const statusOf = (f: string): VariantPlanFile["status"] =>
    !liveSums.has(f) ? "added" : liveSums.get(f) === sourceSums.get(f) ? "identical" : "changed";

  const entryFiles = [snippetFile(input.entries.shell), snippetFile(input.entries.content)];
  const tree = renderTree(entryFiles, source);
  for (const f of tree.files) {
    if (!sourceSums.has(f)) blocking.push({ file: f, reason: "rendered by the drawer but missing in the draft theme" });
    else if (!source.has(f)) blocking.push({ file: f, reason: "could not be read from the draft theme" });
  }
  const present = tree.files.filter((f) => source.has(f));
  for (const f of present) {
    if (hasDynamicRender(source.get(f)!)) {
      blocking.push({ file: f, reason: "renders a snippet whose name is a variable — the tree cannot be traced" });
    }
    if (hasDynamicTranslationKey(source.get(f)!)) {
      warnings.push(`${f} builds a translation key at render time; that key is not carried over if it is new or changed.`);
    }
  }

  // assets the tree loads
  const assetNames = new Set<string>();
  for (const f of present) for (const a of assetRefs(source.get(f)!)) assetNames.add(`assets/${a}`);
  const assets: VariantPlanFile[] = [];
  const changedAssets = new Set<string>();
  for (const a of [...assetNames].sort()) {
    if (!sourceSums.has(a)) {
      blocking.push({ file: a, reason: "loaded by the drawer but missing in the draft theme" });
      continue;
    }
    const st = statusOf(a);
    if (st !== "identical") {
      changedAssets.add(a);
      if (!source.has(a)) blocking.push({ file: a, reason: "binary asset differs from live — upload it under a new name in the draft" });
    }
    assets.push({
      source: a,
      target: st === "identical" ? a : a.replace(/(\.[A-Za-z0-9]+)$/, `-abx${tok}$1`),
      action: st === "identical" ? "reuse" : "isolate",
      status: st,
    });
  }

  // translation keys
  const primarySrc = input.sourceLocales[input.primaryLocale] ?? {};
  const primaryLive = input.liveLocales[input.primaryLocale] ?? {};
  const keys = new Set<string>();
  for (const f of present) for (const k of translationRefs(source.get(f)!, primarySrc)) keys.add(k);
  const localeKeys: LocaleKeyPlan[] = [];
  const untranslated: VariantPlan["untranslated"] = [];
  const isolatedKeys = new Set<string>();
  for (const key of [...keys].sort()) {
    const liveVal = localeValue(primaryLive, key);
    if (liveVal === undefined) localeKeys.push({ key, action: "add", target: key });
    else {
      const differs = Object.keys(input.sourceLocales).some((loc) => {
        const s = localeValue(input.sourceLocales[loc], key);
        return s !== undefined && !same(s, localeValue(input.liveLocales[loc] ?? {}, key));
      });
      if (differs) {
        localeKeys.push({ key, action: "isolate", target: isolatedKey(tok, key) });
        isolatedKeys.add(key);
      }
    }
    for (const loc of Object.keys(input.sourceLocales)) {
      if (loc === input.primaryLocale) continue;
      if (localeValue(input.sourceLocales[loc], key) === undefined) untranslated.push({ key, locale: loc });
    }
  }

  // a file is isolated when it changed, or anything it renders / loads / translates did
  const needs = new Map<string, boolean>();
  const visit = (f: string, stack: Set<string>): boolean => {
    if (needs.has(f)) return needs.get(f)!;
    if (stack.has(f) || !source.has(f)) return false;
    stack.add(f);
    const body = source.get(f)!;
    let n = statusOf(f) !== "identical";
    for (const k of tree.children.get(f) ?? []) if (visit(k, stack)) n = true;
    if (assetRefs(body).some((a) => changedAssets.has(`assets/${a}`))) n = true;
    if (translationRefs(body, primarySrc).some((k) => isolatedKeys.has(k))) n = true;
    stack.delete(f);
    needs.set(f, n);
    return n;
  };
  const files: VariantPlanFile[] = [];
  for (const f of [...present].sort()) {
    const isolate = visit(f, new Set());
    const status = statusOf(f);
    files.push({
      source: f,
      target: isolate ? f.replace(/\.liquid$/, `-abx${tok}.liquid`) : f,
      action: isolate ? "isolate" : "reuse",
      status: isolate && status === "identical" ? "depends_on_changed" : status,
    });
    // a copy's {% stylesheet %} is bundled into every page → would restyle A too
    if (isolate && status !== "identical" && hasBundledAssetTag(source.get(f)!)) {
      blocking.push({
        file: f,
        reason: "uses {% stylesheet %}/{% javascript %}, which Shopify loads on every page — it would change variant A too. Move it to an asset (asset_url).",
      });
    }
  }

  const targetOf = (name: string) => snippetName(files.find((x) => x.source === snippetFile(name))?.target ?? snippetFile(name));
  const ready = blocking.length === 0;
  return {
    token: tok,
    sourceEntries: input.entries,
    entries: ready ? { shell: targetOf(input.entries.shell), content: targetOf(input.entries.content) } : null,
    files,
    assets,
    localeKeys,
    untranslated,
    blocking,
    warnings,
    identicalToLive: files.every((f) => f.action === "reuse") && assets.every((a) => a.action === "reuse") && localeKeys.length === 0,
  };
}

/** Rewrite the references inside one isolated file according to the plan. */
export function rewriteBody(body: string, plan: VariantPlan): string {
  let out = body;
  for (const f of plan.files) {
    if (f.action !== "isolate") continue;
    const from = snippetName(f.source);
    const to = snippetName(f.target);
    out = out.replace(new RegExp(`((?:render|include)\\s+)(['"])${escapeRe(from)}\\2`, "g"), `$1$2${to}$2`);
  }
  for (const a of plan.assets) {
    if (a.action !== "isolate") continue;
    const from = a.source.replace(/^assets\//, "");
    const to = a.target.replace(/^assets\//, "");
    out = out.replace(new RegExp(`(['"])${escapeRe(from)}\\1(\\s*\\|\\s*asset_url)`, "g"), `$1${to}$1$2`);
  }
  for (const k of plan.localeKeys) {
    if (k.action !== "isolate") continue;
    out = out.replace(new RegExp(`(['"])${escapeRe(k.key)}\\1`, "g"), `$1${k.target}$1`);
  }
  return out;
}

/** Merge B's keys into one live locale file — additive, isolated keys under their new name. */
export function mergeLocale(
  liveLocale: Record<string, unknown>,
  sourceLocale: Record<string, unknown>,
  plan: VariantPlan,
): { merged: Record<string, unknown>; changed: number } {
  const merged = JSON.parse(JSON.stringify(liveLocale)) as Record<string, unknown>;
  let changed = 0;
  for (const k of plan.localeKeys) {
    const value = localeValue(sourceLocale, k.key);
    if (value === undefined) continue;
    if (same(localeValue(merged, k.target), value)) continue;
    setLocaleValue(merged, k.target, value);
    changed++;
  }
  return { merged, changed };
}

/** Generated live entry snippet: what the arm renders for B. */
export function entrySnippet(render: string, kind: "shell" | "content", owner: string, targetBody = ""): string {
  // only a shell that reads up_selling gets it — LiquidDoc rejects undeclared arguments
  const params = kind === "shell" && /\bup_selling\b/.test(codeOf(targetBody)) ? ", up_selling: up_selling" : "";
  const label = owner.replace(/[{}%\n]/g, " ").slice(0, 120);
  return `{% comment %}
  GENERATED by the A/B app — variant B of the cart drawer (${label}).
  Do not edit: starting a cart-drawer experiment rewrites this file.
{% endcomment %}
{%- render '${render}'${params} -%}
`;
}

/** The snippet a generated entry renders (null = not a generated entry). */
export function entryTarget(body: string | null): string | null {
  if (!body) return null;
  return snippetRefs(body)[0] ?? null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
