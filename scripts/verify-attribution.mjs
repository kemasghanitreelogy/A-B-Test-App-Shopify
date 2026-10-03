/**
 * Menguji pembacaan atribusi dari payload webhook order.
 *
 * Ini jalur yang menentukan angka konversi. Kalau salah membaca, seluruh hasil
 * test salah — dan tidak ada error yang muncul, hanya angka yang keliru.
 */
import { parseAttribution, resolveAttributionChain } from "../app/lib/attribution.ts";

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "ok   " : "GAGAL"} ${label}${ok || !detail ? "" : `\n           ${detail}`}`);
  if (!ok) failed++;
};

/* Bentuk note_attributes persis seperti yang dikirim Shopify. */
const order = (attrs) => attrs.map(([name, value]) => ({ name, value }));

/* 1. Kasus normal */
{
  const r = parseAttribution(order([["_tl_ab", "exp1:B"], ["_tl_vid", "v-123"]]));
  check("satu eksperimen terbaca", r.assignments.get("exp1") === "B");
  check("visitor id terbaca", r.visitorId === "v-123");
}

/* 2. Berdampingan dengan atribut milik theme (WhatsApp, GA) */
{
  const r = parseAttribution(order([
    ["wa_click_at", "2026-09-04T00:00:00Z"],
    ["ga_client_id", "GA1.1.123"],
    ["_tl_ab", "exp1:A"],
    ["_tl_vid", "v-9"],
    ["guide_cta_page", "/panduan"],
  ]));
  check("atribut theme tidak mengganggu", r.assignments.get("exp1") === "A" && r.visitorId === "v-9");
}

/* 3. Beberapa eksperimen sekaligus */
{
  const r = parseAttribution(order([["_tl_ab", "expA:B,expB:A,expC:B"], ["_tl_vid", "v-1"]]));
  check("tiga eksperimen terbaca", r.assignments.size === 3
    && r.assignments.get("expA") === "B" && r.assignments.get("expB") === "A" && r.assignments.get("expC") === "B",
    JSON.stringify([...r.assignments]));
}

/* 4. Spasi di sekitar pemisah */
{
  const r = parseAttribution(order([["_tl_ab", " expA : B , expB : A "]]));
  check("spasi berlebih tetap terbaca", r.assignments.get("expA") === "B" && r.assignments.get("expB") === "A",
    JSON.stringify([...r.assignments]));
}

/* 5. Order tanpa atribusi sama sekali */
{
  const r = parseAttribution(order([["wa_click_at", "x"]]));
  check("order tanpa atribusi -> kosong, tidak error", r.assignments.size === 0 && r.visitorId === null);
}

/* 6. Masukan rusak tidak boleh melempar error atau menghasilkan variant palsu */
for (const bad of [null, undefined, [], order([["_tl_ab", ""]]), order([["_tl_ab", "rusak"]]),
                   order([["_tl_ab", "exp:C"]]), order([["_tl_ab", ":::"]]), order([["_tl_ab", "exp1:b"]])]) {
  let threw = false, size = -1;
  try { size = parseAttribution(bad).assignments.size; } catch { threw = true; }
  check(`masukan rusak ditangani: ${JSON.stringify(bad)?.slice(0, 40)}`, !threw && size === 0,
    threw ? "MELEMPAR ERROR" : `menghasilkan ${size} assignment`);
}

/* 7. Huruf kecil "b" TIDAK boleh diterima sebagai variant B */
{
  const r = parseAttribution(order([["_tl_ab", "exp1:b"]]));
  check("variant huruf kecil ditolak (bukan diam-diam jadi B)", r.assignments.size === 0);
}

/* 8. Nama atribut mirip tapi bukan milik kita */
{
  const r = parseAttribution(order([["tl_ab", "exp1:B"], ["__tl_ab", "exp2:B"]]));
  check("nama atribut mirip diabaikan", r.assignments.size === 0, JSON.stringify([...r.assignments]));
}

console.log(failed ? "\nADA YANG GAGAL" : "\nOK");

/* ---- Rantai atribusi berlapis (cart attr → checkout_token → cart_token) ---- */

{
  const r = resolveAttributionChain({
    noteAttributes: order([["_tl_ab", "exp1:B"], ["_tl_vid", "v-1"]]),
    byCheckoutToken: [{ visitorId: "v-9", experimentId: "exp1", variant: "A" }],
    byCartToken: [],
  });
  check("cart attribute menang atas kunci sekunder", r.kind === "cart_attr" && r.assignments.get("exp1") === "B" && r.visitorId === "v-1");
}
{
  const r = resolveAttributionChain({
    noteAttributes: order([["wa_click_at", "x"]]),
    byCheckoutToken: [{ visitorId: "v-2", experimentId: "exp1", variant: "A" }],
    byCartToken: [{ visitorId: "v-3", experimentId: "exp1", variant: "B" }],
  });
  check("tanpa attribute → checkout_token dipakai sebelum cart_token", r.kind === "checkout_token" && r.visitorId === "v-2" && r.assignments.get("exp1") === "A");
}
{
  const r = resolveAttributionChain({
    noteAttributes: null,
    byCheckoutToken: [],
    byCartToken: [{ visitorId: "v-3", experimentId: "exp1", variant: "B" }, { visitorId: "v-3", experimentId: "exp2", variant: "A" }],
  });
  check("cart_token memuat dua eksperimen dari satu visitor", r.kind === "cart_token" && r.assignments.size === 2 && r.visitorId === "v-3");
}
{
  const r = resolveAttributionChain({
    noteAttributes: null,
    byCheckoutToken: [{ visitorId: "v-4", experimentId: "exp1", variant: "A" }, { visitorId: "v-5", experimentId: "exp1", variant: "B" }],
    byCartToken: [],
  });
  check("kunci ambigu (dua visitor) dilewati, bukan ditebak", r.kind === null && r.assignments.size === 0);
}
{
  const r = resolveAttributionChain({ noteAttributes: [], byCheckoutToken: [], byCartToken: [] });
  check("tanpa kunci apa pun → unattributed", r.kind === null && r.assignments.size === 0);
}

process.exit(failed ? 1 : 0);
