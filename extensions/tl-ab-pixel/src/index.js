import { register } from "@shopify/web-pixels-extension";

/**
 * Web pixel funnel — metrik SEKUNDER saja.
 *
 * Angka konversi dan revenue TIDAK diambil dari sini. Pixel berjalan di sandbox
 * browser sehingga tetap bisa diblokir ad-blocker, dan tingkat pemblokirannya
 * belum tentu sama antara variant A dan B — bias itu justru bisa membalik
 * kesimpulan test. Sumber kebenaran tetap webhook orders/paid.
 *
 * Gunanya di sini: melihat DI MANA funnel bocor (view -> add to cart ->
 * checkout started -> completed), bukan menentukan variant mana yang menang.
 *
 * Cara pixel ini tahu variant, dari yang paling bisa diandalkan:
 *
 *   1. checkout.attributes  — cart attribute yang ikut sepanjang checkout.
 *      Terdokumentasi ada di checkout_started maupun checkout_completed, dan
 *      tidak bergantung pada cookie mana pun.
 *   2. custom event tl_ab:*  — disiarkan skrip head lewat Shopify.analytics.publish.
 *      Ini satu-satunya cara mengetahui variant pada langkah add-to-cart, karena
 *      standard event product_added_to_cart TIDAK membawa cart attribute sama
 *      sekali (payload-nya hanya cartLine).
 *   3. cookie _tl_ab_last  — cadangan terakhir untuk halaman storefront.
 */
register(({ analytics, browser, settings, init }) => {
  const configured = settings?.collectEndpoint || "/apps/tl-ab/collect";

  /**
   * Alamat absolut endpoint pengumpul.
   *
   * HARUS di domain app (Fly), bukan App Proxy di domain toko: sandbox pixel
   * menolak request ke origin toko sendiri — fetch melempar
   * `RestrictedUrlError: Requests are not allowed to the same origin` — dan
   * catch di bawah menelannya. Sebelum ini dibetulkan, tidak satu pun event
   * checkout pernah sampai. Settings `collectEndpoint` diisi app lewat
   * webPixelCreate/Update; cabang relatif di bawah hanya cadangan.
   */
  function endpointFor(event) {
    if (/^https?:\/\//i.test(configured)) return configured;
    const win = (event && event.context && event.context.window) || (init && init.context && init.context.window) || null;
    const origin = (win && (win.origin || (win.location && win.location.origin))) || "";
    return origin ? origin + configured : configured;
  }

  /** Baca penugasan dari cookie. Cadangan; cookie bisa hilang antar surface. */
  async function assignmentFromCookie() {
    try {
      // Sandbox pixel tidak bisa membaca DOM, tapi browser.cookie tersedia dan
      // di-proxy ke document.cookie frame utama.
      const raw = await browser.cookie.get("_tl_ab_last");
      if (!raw) return null;
      const [experimentId, variant, visitorId] = decodeURIComponent(raw).split("|");
      if (!experimentId || (variant !== "A" && variant !== "B") || !visitorId) return null;
      return { experimentId, variant, visitorId };
    } catch (e) {
      return null;
    }
  }

  /**
   * Baca SEMUA penugasan dari cart attribute yang ikut ke checkout.
   *
   * `_tl_ab` (eksperimen template, di-stamp saat add-to-cart) dan `_tl_abx`
   * (eksperimen komponen, di-stamp saat komponen dilihat) sama-sama berbentuk
   * "exp1:B,exp2:A"; `_tl_vid` berisi visitor id. Satu checkout bisa ikut
   * beberapa eksperimen sekaligus, dan setiap eksperimen butuh langkah
   * checkout-nya sendiri — membaca satu pasangan saja membuat funnel
   * eksperimen lain berhenti di add-to-cart tanpa satu pun error.
   */
  function assignmentsFromCheckout(event) {
    const attributes = event?.data?.checkout?.attributes;
    if (!Array.isArray(attributes)) return [];

    const raw = [];
    let visitorId = "";
    for (const a of attributes) {
      if (a?.key === "_tl_ab" || a?.key === "_tl_abx") raw.push(String(a.value ?? ""));
      else if (a?.key === "_tl_vid") visitorId = String(a.value ?? "");
    }
    if (!visitorId) return [];

    const seen = new Set();
    const out = [];
    for (const pair of raw.join(",").split(",")) {
      const sep = pair.lastIndexOf(":");
      if (sep === -1) continue;
      const experimentId = pair.slice(0, sep).trim();
      const variant = pair.slice(sep + 1).trim();
      if (!experimentId || (variant !== "A" && variant !== "B") || seen.has(experimentId)) continue;
      seen.add(experimentId);
      out.push({ experimentId, variant, visitorId });
    }
    return out;
  }

  /**
   * Baca penugasan dari custom event yang disiarkan skrip head.
   *
   * PERINGATAN dokumentasi Shopify: custom event bisa diterbitkan siapa pun,
   * termasuk pengunjung lewat console browser. Karena itu bentuknya divalidasi
   * ketat di sini, dan angka yang menentukan pemenang tetap tidak pernah
   * bersumber dari jalur ini.
   */
  function assignmentFromCustomData(event) {
    const d = event?.customData;
    if (!d) return null;
    const experimentId = typeof d.experiment_id === "string" ? d.experiment_id : "";
    const variant = d.variant;
    const visitorId = typeof d.visitor_id === "string" ? d.visitor_id : "";
    if (!experimentId || (variant !== "A" && variant !== "B") || !visitorId) return null;
    return { experimentId, variant, visitorId };
  }

  async function send(assignments, type, productId, event) {
    const list = (Array.isArray(assignments) ? assignments : [assignments]).filter(Boolean);
    if (list.length === 0) return;
    const assignment = list[0];
    /* checkout_token ikut dikirim sebagai kunci atribusi sekunder: kalau cart
     * attribute hilang sebelum order, webhook masih bisa memasangkan order ini
     * ke visitor lewat order.checkout_token. Server juga memakainya untuk
     * men-dedupe event checkout per checkout, bukan per pemuatan halaman. */
    const checkoutToken = event && event.data && event.data.checkout && event.data.checkout.token;
    const body = JSON.stringify({
      v: 2,
      vid: assignment.visitorId,
      keys: checkoutToken ? { checkout_token: String(checkoutToken).slice(0, 128) } : {},
      // Satu visitor, satu checkout — satu event per eksperimen yang diikuti.
      ev: list.map((x) => ({
        e: x.experimentId,
        v: x.variant,
        t: type,
        p: productId || "",
        n: Math.random().toString(36).slice(2, 10),
      })),
    });
    // `?src=pixel` hanya penanda di log server, supaya request pixel bisa
    // dibedakan dari request skrip storefront yang menuju endpoint yang sama.
    const url = endpointFor(event) + "?src=pixel";
    try {
      /* Tanpa `keepalive`. Di dalam web worker sebagian browser menolak opsi itu
       * dan fetch() langsung melempar — request tidak pernah dikirim, dan
       * catch di bawah menelannya tanpa jejak. Sandbox pixel tetap hidup cukup
       * lama untuk menyelesaikan request biasa. */
      await fetch(url, { method: "POST", mode: "cors", body });
    } catch (e) {
      /* Pixel tidak boleh pernah melempar error ke storefront. Kegagalannya
       * dilaporkan lewat query string supaya terbaca di log server — tanpa ini,
       * "pixel tidak mengirim apa-apa" tidak bisa dibedakan dari "tidak ada
       * yang checkout". */
      try {
        await fetch(url + "&diag=" + encodeURIComponent(String(e && e.message ? e.message : e).slice(0, 120)), {
          method: "POST",
          mode: "no-cors",
          body,
        });
      } catch (e2) {
        /* sudah tidak ada lagi yang bisa dilakukan */
      }
    }
  }

  /* ---------------- storefront ----------------
   *
   * product_viewed dan add_to_cart SENGAJA tidak dikirim dari sini. Keduanya
   * sudah dicatat skrip storefront (tl-ab-core.liquid) lewat App Proxy; kalau
   * pixel ikut mengirim, tiap kunjungan terhitung dua kali — dan hanya pada
   * pengunjung yang pixel-nya tidak diblokir, jadi biasnya tidak merata antar
   * variant. Pixel hanya untuk langkah checkout, yang tidak bisa dilihat
   * skrip storefront. */

  /* ---------------- checkout ---------------- */

  analytics.subscribe("checkout_started", async (event) => {
    const fromCheckout = assignmentsFromCheckout(event);
    send(fromCheckout.length ? fromCheckout : await assignmentFromCookie(), "checkout_started", "", event);
  });

  /**
   * Dicatat sebagai langkah FUNNEL, bukan sebagai konversi.
   *
   * Revenue tetap datang dari webhook orders/paid. Kalau angka di sini dipakai
   * menghitung konversi, hasilnya akan bias sebesar selisih pemblokiran
   * ad-blocker antara variant A dan B.
   */
  analytics.subscribe("checkout_completed", async (event) => {
    const fromCheckout = assignmentsFromCheckout(event);
    send(fromCheckout.length ? fromCheckout : await assignmentFromCookie(), "checkout_completed", "", event);
  });
});
