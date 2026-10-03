# SPEC — Component experiments (A/B test cart drawer)

Status: implemented 30 Sep 2026. Scope: add a second experiment **kind** next to
the existing product-template kind, and ship the first component: the cart
drawer (`cart_drawer`).

## 1. Why the template mechanism cannot test the drawer

Template experiments redirect B visitors to `?view=ab-b` so Shopify renders
`templates/product.ab-b.json`. The cart drawer is not part of any page
template: it is rendered by `sections/Header.liquid` on **every** page type and
re-rendered through `cart?view=mini`. There is no template to swap, and
rewriting every URL with `?view=` would require an alternate template for every
page type.

## 2. The switch: a hidden cart attribute that Liquid reads

Liquid cannot read cookies, but it can read `cart.attributes`, and Shopify
renders every storefront page per cart (verified 30 Sep 2026:
`cf-cache-status: DYNAMIC`, `server-timing: edge_cart`, page HTML reflected an
item added one request earlier on `/`, `/pages/about`, `/collections/all`).

```
_tl_abc_cart_drawer = "B"      ← treatment switch (absent / "" = A)
```

The theme renders exactly ONE implementation, server-side. The condition lives
in a single snippet, `snippets/cart-drawer-arm.liquid`:

```liquid
{%- if cart.attributes['_tl_abc_cart_drawer'] == 'B' -%}
  shell → {% render 'CartDrawer' %}            content → {% render 'CartDrawerV3Content' %}
{%- else -%}
  shell → {% render 'MiniCart', … %}           content → {% render 'CartDrawerContent' %}
{%- endif -%}
```

and both render paths go through it — a one-line change each versus the live
theme:

| Render path | File | Renders |
|---|---|---|
| initial drawer, every page | `sections/Header.liquid` | `cart-drawer-arm, part: 'shell'` |
| every re-render (`cart?view=mini`, both drawers) | `templates/cart.mini.liquid` | `cart-drawer-arm, part: 'content'` |

Arm A is the live drawer byte-for-byte (`MiniCart` + `CartDrawerContent`
untouched). No DOM swapping, no two scripts competing for `#cart`. With no
test running the attribute is absent and the theme behaves exactly as before.

## 3. Storefront lifecycle (tl-ab-core, `<head>`)

```
every page
  ├─ guards: design mode · bot/headless · internal · consent denied
  │     → desired = "A" (internal: ?_tl_ab_force=cart_drawer:B overrides)
  ├─ running component experiment → desired = bucketOf(vid, expId, split)
  ├─ no running experiment (paused / completed / kill switch) → desired = "A"
  │
  ├─ rendered = CTX.abc._tl_abc_cart_drawer   (Liquid, same render as the theme)
  └─ rendered ≠ desired
        ├─ POST /cart/update.js { attributes: { _tl_abc_cart_drawer: desired|"" } }
        └─ desired = B and this page shows A → reload ONCE (session guard)
               so even the landing page shows the assigned drawer

drawer opens (.mini-cart gains .active — shared by BOTH implementations)
  ├─ rendered === variant ? exposure : render_mismatch  (never both)
  ├─ exposure (deduped per visitor/day on the server) → Assignment row
  ├─ broadcast tl_ab_experience_impression (GTM · pixel · PostHog · Contentsquare)
  └─ stamp _tl_abx = "expId:variant" on the cart  → order attribution

add to cart (any path: fetch · XHR · native form)
  └─ re-stamp _tl_abx + add_to_cart event for exposed component experiments
```

Exposure is **triggered at the point of treatment** (drawer opened), not at
page view. The trigger itself is identical in both arms (header icon or add to
cart, before any drawer content is seen), so it cannot be biased by the
variant — SRM stays valid. Visitors who never open the drawer are not in the
experiment and do not dilute it.

### Coverage matrix (every path a visitor can take)

| Path | Handled by |
|---|---|
| Landing page, new visitor, arm B | attribute write + one reload |
| Any later page, any page type | Liquid reads the attribute |
| Drawer re-render (`cart?view=mini`) | same switch in `cart.mini.liquid` |
| Add to cart: fetch / XHR / native form | existing interceptors + component stamping |
| New cart after checkout (attributes gone) | reconciled on the next page view |
| Experiment paused / completed / kill switch | desired = A → attribute cleared |
| Internal device (`?_tl_ab_off=1`) | forced A, never counted; `?_tl_ab_force=cart_drawer:B` to QA B |
| Bots, headless, Lighthouse | early return, never get the attribute → A |
| Consent denied | desired = A, no events |
| Attribute write failed / cache served wrong arm | `render_mismatch` event, not counted, health check |
| Theme missing the switch | start refused by the preflight (§5) |

## 4. Attribution

| Attribute | Written when | Meaning |
|---|---|---|
| `_tl_abc_<component>` | first page view | treatment switch read by Liquid |
| `_tl_abx` | drawer exposure / add to cart | analysis membership, `"exp1:B,exp2:A"` |
| `_tl_ab` | unchanged (template experiments) | |
| `_tl_vid` | unchanged | |

`parseAttribution` reads `_tl_ab` **and** `_tl_abx`; one conversion row per
`order#experiment` already supports concurrent experiments (a PDP test and a
drawer test can run together). The web pixel reads every pair from both
attributes, so `checkout_started` / `checkout_completed` reach every
experiment the order belongs to.

## 5. Server lifecycle

- `Experiment.kind` = `template` (default, existing rows) | `component`.
- `Experiment.component` = `cart_drawer` (registry in `app/lib/components.ts`).
- Start (component): **preflight** reads the MAIN theme and refuses to start
  unless the arm snippet reads the attribute, `Header.liquid` and
  `cart.mini.liquid` both render the arm snippet **and no longer render a
  drawer directly** (a bypass would show A to arm B), and every file either
  arm renders exists. The same preflight runs as health check I9 during the
  test, so a theme edit that breaks the switch is caught. No template is
  created, no product handles are resolved.
- One running experiment per component at a time (a second one would fight
  over the same attribute).
- Config sent to the storefront gains `t:"c"` and `c:"cart_drawer"`; template
  experiments are unchanged (`t` omitted).
- New event type `render_mismatch` (storefront only), excluded from results,
  surfaced by health check `I15` (mismatch rate > 1% = warn, > 5% = fail).

## 6. Dashboard

The wizard's first step asks **what** is tested: a page template (existing
5-step flow) or a site component. Component flow: pick component → theme
readiness check (the same preflight, via the bridge) → configuration (split,
primary metric, MDE). Detail and list pages show the component instead of a
template suffix.

## 7. Rolling out the winner

- **B wins:** change the theme condition to `!= 'A'` (B becomes default), mark
  the experiment completed; the storefront clears the attribute on the next
  page view and everyone sees v3.
- **A wins / abort:** complete or pause; attributes are cleared automatically.

## 8. Tests

`scripts/verify-components.mjs` runs the real `tl-ab-core.liquid` in the
harness: bucketing parity with the server, attribute write, one-time reload,
no reload for A, loop guard, exposure only on open, exposure vs mismatch,
`_tl_abx` stamping, kill switch clears, internal force, bots untouched,
coexistence with a running template experiment. `verify-attribution.mjs`
covers `_tl_abx` parsing and multi-experiment orders.

## 9. Deploy runbook (order matters)

1. **Theme first** (safe on its own: with no attribute every visitor gets A,
   byte-identical to today). Push to the live theme through Treelogy's
   `claudedocs/qa-lib/deploy.mjs`: `snippets/cart-drawer-arm.liquid`,
   `snippets/CartDrawer.liquid`, `snippets/CartDrawerV3Content.liquid`,
   `snippets/cart-v3-*.liquid`, `assets/cart-drawer-v3.{js,css}`,
   `assets/cart-v3-payments.svg`, locale keys `cart_v3.*`, then
   `templates/cart.mini.liquid` and `sections/Header.liquid` last.
   Verify: `cart?view=mini` without the attribute = legacy markup.
2. **Database**: `npx prisma migrate deploy` (adds `Experiment.kind`,
   `Experiment.component`; existing rows default to `template`).
3. **App server (Fly.io)**: deploy — new start branch, bridge action
   `component.readiness`, `render_mismatch` intake, health I9/I15, `_tl_abx`
   attribution.
4. **Extensions**: `shopify app deploy` — `tl-ab-core` (component switch,
   exposure, stamping) and the web pixel (multi-experiment checkout events).
5. **Dashboard (Vercel)**: deploy — type chooser + component wizard.
6. Register GTM trigger regex for `tl_ab_experience_impression` with
   `component` parameter if drawer impressions should reach GA4.
7. QA on a real browser: `?_tl_ab_off=1` then `?_tl_ab_force=cart_drawer:B`
   → v3 drawer everywhere; `?_tl_ab_force=` → back to A. Then create the
   experiment in the dashboard (preflight must be green) and start it.

## 10. Variant B from a draft theme (live 1 Oct 2026)

Same rules as the page-template flow: **A never changes by a byte**, and
**B in live is what the draft's preview shows**. Anything that can't satisfy
both blocks; nothing is silently dropped.

**Which drawer is "the draft's"?** The one the draft renders for a visitor
WITHOUT the attribute — i.e. its preview. Resolved from the draft's
`Header.liquid` / `templates/cart.mini.liquid`: through the arm snippet's
default branch (`== 'B'` → else-branch, `!= 'A'` → if-branch), or the
`MiniCart` / first render they call directly. A draft duplicated from live
still shows the legacy drawer → the analysis says **A/A**; make the new design
the draft's default drawer first.

**Two generated entry snippets** sit between the arm and B:
`snippets/tl-abx-cart_drawer-shell.liquid` / `-content.liquid`. The arm's B
branch renders only these. Each experiment stores its own targets
(`Experiment.variantBEntries`, null = `fallback` = CartDrawer /
CartDrawerV3Content); **start** rewrites the entries to point at them
(`activateComponentVariant`, read back). So several drafted experiments can
coexist; only the running one owns the entries. Health I9 fails if the live
entries stop pointing at the running experiment's B.

| Step | Writes to live | Visible to visitors |
|---|---|---|
| analyze (`component.analyzeVariant`) | nothing | — |
| create (`component.prepareVariant`) | isolated copies + additive locale keys | no — nothing renders them |
| start | the two entry snippets | yes, to arm B only |

**Planner** (`app/lib/component-variant.ts`, pure, synced to the dashboard;
`scripts/verify-component-variant.mjs`):
- tree = every snippet reachable from the entries (`render`/`include`, tag
  and `{% liquid %}` forms; `{% doc %}`/`{% comment %}` ignored), every
  `'x' | asset_url`, every quoted literal that resolves to a key in the draft's
  primary locale (literal-based because keys get `assign`ed first).
- file status by checksum. A file is **isolated** (`<name>-abx<token>`) if it
  changed, or anything it renders / loads / translates did; otherwise reused.
- changed text asset → `x-abx<token>.ext`; changed text → key
  `abx_<token>.<key with . → __>` (two levels); new key → added as is.
  Locale files are merged into the CURRENT live file (header comment kept) and
  read back semantically.
- **blocking**: missing snippet/asset, dynamic `render var`, changed binary
  asset, and a changed file with `{% stylesheet %}`/`{% javascript %}`
  (Shopify bundles those into every page → would restyle A).
- **untranslated** keys (missing in a non-primary draft locale) need an
  explicit acknowledgement in the wizard; the server re-checks.
- `notCarried` = layout/, settings_data, Header, and existing assets that
  differ but are outside the tree — shown, not copied.
- shell entries pass `up_selling` only when the target reads it (LiquidDoc
  rejects undeclared arguments).

Copies are never deleted automatically (a completed experiment may be
re-run); they're inert. Clean-up is manual: files `*-abx<token>*` and locale
namespace `abx_<token>`.
