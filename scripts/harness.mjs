/**
 * Menjalankan script <head> A/B test di lingkungan DOM tiruan.
 *
 * Yang diuji adalah file .liquid yang sebenarnya dikirim ke browser — dibaca apa
 * adanya, bukan salinan. Kalau logikanya diubah tanpa mengubah pengujian ini,
 * pengujiannya yang akan gagal.
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SNIPPET = "extensions/tl-ab-embed/snippets/tl-ab-core.liquid";

export function runScript({
  config,
  ctx,
  url = "https://treelogy.com/products/kapsul",
  cookies = "",
  userAgent = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/131.0 Safari/537.36",
  storageThrows = false,
  cookieDomainRejected = false,
  anchors = [],
  readyState = "complete",
  customerPrivacy = null,
  /** isi awal localStorage, untuk menguji sisa keadaan dari kunjungan sebelumnya */
  localStorage: localStorageSeed = null,
  /** isi awal sessionStorage (penjaga reload komponen) */
  sessionStorage: sessionStorageSeed = null,
  /** true = halaman punya elemen .mini-cart (eksperimen komponen cart drawer) */
  drawer = false,
} = {}) {
  const log = {
    beacons: [],
    fetches: [],
    replaced: null,
    cookiesSet: [],
    listeners: {},
    /** panggilan Shopify.analytics.publish */
    published: [],
    /** perintah yang didorong ke antrian tag Contentsquare */
    uxa: [],
  };

  const loc = new URL(url);
  const location = {
    get href() { return loc.href; },
    get search() { return loc.search; },
    get pathname() { return loc.pathname; },
    get host() { return loc.host; },
    get protocol() { return loc.protocol; },
    get origin() { return loc.origin; },
    replace(next) { log.replaced = next; },
  };

  let cookieJar = cookies;
  const storage = (seed) => {
    const map = new Map(Object.entries(seed ?? {}));
    return {
      getItem: (k) => { if (storageThrows) throw new Error("blocked"); return map.has(k) ? map.get(k) : null; },
      setItem: (k, v) => { if (storageThrows) throw new Error("blocked"); map.set(k, String(v)); },
      removeItem: (k) => { if (storageThrows) throw new Error("blocked"); map.delete(k); },
    };
  };

  const makeEl = (href) => ({
    _href: href,
    getAttribute(n) { return n === "href" ? this._href : null; },
    setAttribute(n, v) { if (n === "href") this._href = v; },
    closest() { return this; },
  });
  const anchorEls = anchors.map(makeEl);

  /* Elemen .mini-cart secukupnya: classList + MutationObserver tiruan, supaya
     exposure "saat drawer dibuka" bisa diuji. openDrawer() meniru tema yang
     menambahkan kelas active. */
  const observers = [];
  const drawerEl = drawer
    ? {
        _classes: new Set(),
        classList: {
          contains: (c) => drawerEl._classes.has(c),
          add: (c) => { drawerEl._classes.add(c); observers.forEach((o) => o.el === drawerEl && o.fn([])); },
          remove: (c) => { drawerEl._classes.delete(c); observers.forEach((o) => o.el === drawerEl && o.fn([])); },
        },
      }
    : null;

  const document = {
    readyState,
    get cookie() { return cookieJar; },
    set cookie(v) {
      log.cookiesSet.push(v);
      // Browser menolak cookie yang domain-nya tidak cocok dengan host saat ini.
      if (cookieDomainRejected && /;\s*domain=/i.test(v)) return;
      cookieJar = cookieJar ? `${cookieJar}; ${v.split(";")[0]}` : v.split(";")[0];
    },
    querySelectorAll: () => anchorEls,
    querySelector: (sel) => (sel === ".mini-cart" ? drawerEl : null),
    // DOM secukupnya untuk penyisipan script posthog-js
    createElement: () => ({}),
    getElementsByTagName: () => [{ parentNode: { insertBefore: () => {} } }],
    addEventListener: (type, fn) => { (log.listeners[type] ??= []).push(fn); },
  };

  const sandbox = {
    console,
    Date, Math, JSON, URL, Error, RegExp, String, Number, Boolean, Array, Object,
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout: () => {},
    Blob: class { constructor(parts) { this.parts = parts; } },
    XMLHttpRequest: function () {},
    document,
    navigator: {
      userAgent,
      webdriver: false,
      sendBeacon: (endpoint, blob) => { log.beacons.push({ endpoint, body: blob.parts[0] }); return true; },
    },
    fetch: (input, init) => { log.fetches.push({ url: String(input), init }); return Promise.resolve({ ok: true }); },
    crypto: { randomUUID: () => "uuid-tetap-untuk-pengujian" },
    MutationObserver: class {
      constructor(fn) { this.fn = fn; }
      observe(el) { observers.push({ el, fn: this.fn }); }
      disconnect() {}
    },
  };
  sandbox.XMLHttpRequest.prototype = { open() {}, addEventListener() {} };
  sandbox.addEventListener = (type, fn) => { (log.listeners[`window:${type}`] ??= []).push(fn); };
  sandbox.removeEventListener = () => {};
  sandbox.window = sandbox;
  sandbox.location = location;
  sandbox.window.location = location;
  sandbox.localStorage = storage(localStorageSeed);
  sandbox.sessionStorage = storage(sessionStorageSeed);
  sandbox.__TL_AB__ = config;
  sandbox.__TL_AB_CTX__ = ctx;
  /* Shopify.analytics.publish adalah satu-satunya jembatan resmi ke web pixel,
     jadi panggilannya direkam supaya bisa diperiksa. Selalu disediakan, bukan
     hanya saat consent API dipasang. */
  sandbox.Shopify = { analytics: { publish: (name, data) => { log.published.push({ name, data }); } } };
  if (customerPrivacy) sandbox.Shopify.customerPrivacy = customerPrivacy;

  // Contentsquare: antrian perintah tag-nya. afterPageView dijalankan langsung
  // supaya callback-nya ikut teruji.
  sandbox._uxa = {
    push(cmd) {
      log.uxa.push(cmd);
      if (Array.isArray(cmd) && cmd[0] === "afterPageView" && typeof cmd[1] === "function") cmd[1]();
    },
  };
  sandbox.window._uxa = sandbox._uxa;

  const code = readFileSync(SNIPPET, "utf8");
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: SNIPPET });

  return {
    log,
    sandbox,
    cookieJar: () => cookieJar,
    anchors: anchorEls,
    openDrawer: () => drawerEl && drawerEl.classList.add("active"),
  };
}

export const baseConfig = {
  v: 1,
  on: true,
  ep: "/apps/tl-ab/collect",
  ck: "_tl_vid",
  ckd: 180,
  ckdom: ".treelogy.com",
  ex: [{ id: "exp1", s: 50, a: "", b: "ab-b", h: "*", x: [] }],
};

export const baseCtx = {
  pageType: "product",
  suffix: "",
  handle: "kapsul",
  productId: "123",
  designMode: false,
};
