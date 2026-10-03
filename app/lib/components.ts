/**
 * Site components that can be A/B tested without a page template.
 *
 * A component experiment switches its treatment through a hidden cart
 * attribute that the theme reads in Liquid (see
 * claudedocs/SPEC-component-experiments.md). This registry is the single
 * source of truth for that contract: the storefront script, the start
 * preflight, the dashboard and the tests all read it from here.
 */

/** A theme file that must (and optionally must not) contain a string. */
export interface ThemeCheck {
  file: string;
  contains: string;
  /** a string whose presence means a render path bypasses the switch */
  absent?: string;
}

export interface ComponentDefinition {
  /** stable key, stored in Experiment.component and sent to the storefront */
  key: string;
  label: { id: string; en: string };
  /** hidden cart attribute the theme reads to pick the arm */
  attribute: string;
  /**
   * The wiring every render of the component must go through: the one
   * snippet that reads the attribute, and every entry point rendering it.
   */
  checks: ThemeCheck[];
  /** theme files both arms render; all must exist */
  requiredFiles: string[];
  /**
   * Variant B is rendered through two GENERATED entry snippets (one per render
   * path), which the A/B app points at the running experiment's B when it
   * starts — so several experiments can each carry their own B (e.g. built
   * from different draft themes) without touching variant A. §10 of the spec.
   */
  variantB: {
    /** generated snippet names the arm renders for B */
    entries: { shell: string; content: string };
    /**
     * What the entries render while no experiment owns them: the same drawer
     * as A, so a stray B visitor (QA force) never hits a missing snippet.
     * There is no built-in B — every B comes from a draft theme.
     */
    idle: { shell: string; content: string };
    /** where the arm lives and what renders the shell without it (for reading drafts) */
    arm: string;
    legacyShell: string;
  };
}

export const COMPONENTS: Record<string, ComponentDefinition> = {
  cart_drawer: {
    key: "cart_drawer",
    label: { id: "Cart drawer", en: "Cart drawer" },
    attribute: "_tl_abc_cart_drawer",
    checks: [
      // the single place the condition lives
      { file: "snippets/cart-drawer-arm.liquid", contains: "_tl_abc_cart_drawer" },
      // B goes through the generated entries, never a hard-coded drawer
      { file: "snippets/cart-drawer-arm.liquid", contains: "'tl-abx-cart_drawer-shell'" },
      { file: "snippets/cart-drawer-arm.liquid", contains: "'tl-abx-cart_drawer-content'" },
      // initial drawer on every page — must not render the old drawer directly
      { file: "sections/Header.liquid", contains: "'cart-drawer-arm'", absent: "render 'MiniCart'" },
      // every drawer re-render (both drawers fetch cart?view=mini)
      { file: "templates/cart.mini.liquid", contains: "'cart-drawer-arm'", absent: "render 'CartDrawerContent'" },
    ],
    requiredFiles: [
      "snippets/MiniCart.liquid",
      "snippets/CartDrawerContent.liquid",
      "snippets/tl-abx-cart_drawer-shell.liquid",
      "snippets/tl-abx-cart_drawer-content.liquid",
    ],
    variantB: {
      entries: { shell: "tl-abx-cart_drawer-shell", content: "tl-abx-cart_drawer-content" },
      idle: { shell: "MiniCart", content: "CartDrawerContent" },
      arm: "cart-drawer-arm",
      legacyShell: "MiniCart",
    },
  },
};

export function componentOf(key: string | null | undefined): ComponentDefinition | null {
  return key ? (COMPONENTS[key] ?? null) : null;
}

/** Cart attribute carrying analysis membership for component experiments: "exp1:B,exp2:A". */
export const ATTR_COMPONENT_EXPERIMENTS = "_tl_abx";

export interface ReadinessProblem {
  file: string;
  reason: "missing_file" | "missing_switch" | "bypass";
}

/** Every file the preflight reads, in display order. */
export function readinessFiles(component: ComponentDefinition): string[] {
  return [...new Set([...component.checks.map((c) => c.file), ...component.requiredFiles])];
}

/** The same theme file can carry several checks; report it once. */
function pushOnce(problems: ReadinessProblem[], problem: ReadinessProblem) {
  if (!problems.some((p) => p.file === problem.file)) problems.push(problem);
}

/**
 * Pure preflight: is the theme wired so EVERY render of the component obeys
 * the attribute? `files` maps filename → content (null = file absent).
 * Kept free of I/O so the server, the dashboard and the tests share it.
 */
export function evaluateComponentReadiness(
  component: ComponentDefinition,
  files: Record<string, string | null>,
): { ok: boolean; problems: ReadinessProblem[] } {
  const problems: ReadinessProblem[] = [];
  for (const check of component.checks) {
    const content = files[check.file];
    if (content == null) pushOnce(problems, { file: check.file, reason: "missing_file" });
    else if (!content.includes(check.contains)) pushOnce(problems, { file: check.file, reason: "missing_switch" });
    else if (check.absent && content.includes(check.absent)) pushOnce(problems, { file: check.file, reason: "bypass" });
  }
  for (const file of component.requiredFiles) {
    if (files[file] == null) pushOnce(problems, { file, reason: "missing_file" });
  }
  return { ok: problems.length === 0, problems };
}
