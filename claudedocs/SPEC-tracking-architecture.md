# SPEC — Arsitektur tracking full-coverage & konsisten

Status: **fase 1–4 diimplementasikan & live** (2026-09-23, app version
treelogy-ab-test-22, migrasi `20260923120000_tracking_v2`). Fase 5 (canary
terjadwal) dan 6 (webhook `checkouts/*`, scope `read_checkouts`) belum.
Keluaran `/sc:design`, disusun setelah audit pipeline hari ini. Tanda ✅/➕ di
bawah menggambarkan keadaan SEBELUM implementasi; kode acuan: `app/lib/collect.server.ts`,
`app/lib/health.server.ts`, `app/routes/webhooks.orders.paid.tsx`, `app/lib/attribution.ts`,
`dashboard/components/health-panel.tsx`. I13–I14 belum dieksekusi (masih lewat panel PostHog).

Dokumen ini melengkapi `SPEC-posthog-integration.md` (PostHog sebagai acuan) —
bukan menggantikannya.

---

## 0. Kenapa dokumen ini ada

Hari ini tiga cacat ditemukan, dan **ketiganya tidak menghasilkan satu pun error**:

| Cacat | Gejala | Akar |
|---|---|---|
| Web pixel tidak pernah mengirim apa pun | "Mulai checkout" = 0 padahal "Membeli" = 1 | Sandbox pixel menolak request ke origin toko; error ditelan `try/catch` |
| `productId` selalu `null` | Breakdown per produk kosong | Theme mengirim angka, server hanya menerima string |
| Eksperimen berjalan sebagai A/A tanpa disadari | "Belum ada pemenang" selamanya | Template B identik dengan A; tidak ada pemeriksaan |

Pola yang sama di ketiganya: **pipeline gagal diam-diam, dan hasilnya terlihat
seperti data yang sah** ("belum ada yang checkout", "produk tidak dicatat", "test
masih berjalan"). Sistem yang matang bukan sistem yang tidak pernah gagal —
melainkan sistem yang **tidak bisa gagal tanpa ketahuan**. Itulah tujuan desain ini.

---

## 1. Prinsip (tidak bisa dinegosiasikan)

1. **Satu ledger, banyak turunan.** Semua angka di dashboard, PostHog, GA4, dan
   Shopify Analytics diturunkan dari ledger lokal (Neon). Tidak ada sumber yang
   dihitung terpisah. Kalau dua tampilan berbeda, yang diperbaiki pipelinenya,
   bukan angkanya.
2. **Pemenang hanya dari jalur kebal ad-blocker.** Denominator = `Assignment`
   (exposure lewat App Proxy bertanda tangan); numerator konversi = webhook
   `orders/paid`. Jalur browser lain (pixel, PostHog JS, GA4) adalah *diagnostik*.
3. **Setiap jalur punya bukti hidup.** Sumber yang bisa mati diam-diam wajib
   punya *heartbeat* dan *coverage ratio* yang diawasi. Nol event ≠ nol kejadian.
4. **Idempoten di setiap batas.** Retry, at-least-once webhook, dan replay tidak
   boleh mengubah angka. Kunci idempotensi ditentukan **sebelum** data disimpan.
5. **Atribusi berlapis, bukan satu kunci.** Order dicocokkan ke visitor lewat
   beberapa kunci independen; hilangnya satu kunci tidak menghilangkan order.
6. **Order tanpa atribusi tetap dicatat.** "Tidak tahu variant-nya" adalah
   informasi (coverage), bukan alasan membuang baris.
7. **Invariant dieksekusi, bukan didokumentasikan.** Setiap aturan konsistensi di
   §7 adalah query terjadwal yang menghasilkan status hijau/kuning/merah di
   dashboard — bukan kalimat di README.

---

## 2. Peta sumber data (state saat ini + target)

```
                 ┌──────────────────────────────────────────────────────────────┐
                 │                        BROWSER PENGUNJUNG                     │
                 │                                                              │
                 │  <head> tl-ab-core.liquid ──► bucket FNV-1a ──► ?view=suffix  │
                 │        │ sendBeacon (signed App Proxy)                        │
                 │        │ exposure · product_viewed · add_to_cart · ga ids      │
                 │        │ cart attrs _tl_ab/_tl_vid ➕ cart_token ➕ session   │
                 │        ▼                                                      │
                 │  web pixel (sandbox Shopify) ──► fetch Fly langsung (CORS)     │
                 │        checkout_started · checkout_completed ➕ checkout_token │
                 │  posthog-js (opsional, diagnostik) ──► PostHog langsung         │
                 └───────────────┬──────────────────────────┬───────────────────┘
                                 │                          │
                 ┌───────────────▼──────────┐   ┌───────────▼─────────────────┐
                 │ Fly: /proxy/collect      │   │ Fly: /pixel/collect          │
                 │ HMAC Shopify ✅          │   │ tanpa HMAC, requireKnown ✅  │
                 └───────────────┬──────────┘   └───────────┬─────────────────┘
                                 └──────────┬───────────────┘
                                            ▼
                              ┌─────────────────────────────┐
   Shopify webhooks ─────────►│  INGEST  lib/collect.server │◄── ➕ canary / replay
   orders/create ✅ (kosong)   │  validasi · policy · dedupe │
   orders/paid ✅              └─────────────┬───────────────┘
   orders/cancelled ✅                       ▼
   refunds/create ✅          ┌─────────────────────────────┐
   ➕ checkouts/create        │  LEDGER (Neon)              │
   ➕ checkouts/update        │  Assignment · Event         │
                              │  Conversion · ➕ OrderIntake│
                              │  ➕ AttributionKey          │
                              │  ➕ HealthSample            │
                              └─────────────┬───────────────┘
                                            ▼
                    ┌───────────────────────┼────────────────────────┐
                    ▼                       ▼                        ▼
            DERIVASI (results)      FAN-OUT (outbox)          REKONSILIASI ➕
            z-test · Beta · Welch   PostHog · GA4 ·           invariant I1–I14
            SRM · drift · verdict   metafield order           health panel
```

Legenda: ✅ ada · ➕ baru.

---

## 3. Model identitas & kunci atribusi

Satu pengunjung punya **beberapa kunci** yang muncul di tempat berbeda. Ledger
menyimpan semuanya di satu tabel supaya order bisa dicocokkan lewat kunci mana
pun yang selamat sampai webhook.

| Kunci | Dibuat di | Terlihat di | Ketahanan |
|---|---|---|---|
| `visitorId` (`_tl_vid`) | head script, cookie 180 hari | semua event storefront, cart attr `_tl_vid` | hilang kalau cookie dihapus / consent ditolak |
| `_tl_ab` (exp:variant) | head script → `/cart/update.js` | `order.note_attributes` | **hilang** kalau app lain menimpa attributes, cart di-merge, atau checkout dari link (buy-now, draft order, Shop app) |
| ➕ `cart_token` | `/cart.js` saat add-to-cart | `order.cart_token`, `checkouts/*` webhook | tahan terhadap penimpaan attributes; berubah kalau cart dikosongkan |
| ➕ `checkout_token` | pixel `checkout_started` (`event.data.checkout.token`) | `order.checkout_token`, `checkouts/*` webhook | tahan; hanya ada kalau pixel hidup |
| ➕ `sessionId` | head script (`sessionStorage`, 30 menit idle) | event storefront & pixel | untuk metrik per sesi dan dedupe |
| `ga4ClientId` | cookie `_ga` | `VisitorAnalytics` ✅ | hanya untuk GA4 |

**Rantai atribusi order** (dievaluasi berurutan, berhenti di kecocokan pertama,
alasan disimpan):

```
1. note_attributes._tl_ab + _tl_vid           → "cart_attr"      (✅ sekarang satu-satunya)
2. order.checkout_token  → AttributionKey       → "checkout_token" ➕
3. order.cart_token      → AttributionKey       → "cart_token"     ➕
4. tidak ada                                    → OrderIntake.status = "unattributed" ➕
```

Semua kunci ➕ disimpan di tabel `AttributionKey (kind, value, visitorId,
experimentId, variant, seenAt)` dengan unique `(kind, value)`. Ditulis oleh
ingest saat event membawanya (add_to_cart membawa `cart_token`; checkout_started
membawa `checkout_token`).

**Konsekuensi penting:** jalur 2–3 memakai `Assignment` yang sudah ada (dibuat
oleh exposure bertanda tangan), jadi variant-nya tetap dari sumber tepercaya —
pixel hanya menyumbang *kuncinya*, bukan variant-nya.

---

## 4. Envelope event v2 (kontrak tunggal)

Satu bentuk untuk semua sumber. Yang lama (`{e,v,t,p,n}`) tetap diterima selama
masa transisi (`v` absen = v1).

```jsonc
{
  "v": 2,
  "vid": "uuid",                 // visitorId
  "sid": "uuid",                 // ➕ sessionId
  "src": "storefront|pixel",     // ditentukan ULANG oleh server dari route, bukan dipercaya dari client
  "sent_at": 1790150000000,      // ms; server menyimpan juga received_at
  "keys": {                      // ➕ kunci atribusi yang terlihat client saat itu
    "cart_token": "…",
    "checkout_token": "…"
  },
  "ga": { "c": "…", "s": "…" },  // ✅ hanya storefront
  "ev": [
    {
      "e": "experimentId",
      "v": "A|B",
      "t": "exposure|product_viewed|add_to_cart|checkout_started|checkout_completed",
      "p": "productId",          // string; angka dari theme dinormalkan ✅
      "seq": 3,                  // ➕ nomor urut per sesi (deteksi event hilang)
      "n": "nonce"               // "" untuk event unik-per-hari
    }
  ]
}
```

**Kunci idempotensi** (`dedupeKey`, ✅ sudah ada, dipertahankan):
`experimentId|visitorId|type|productId|dayKey|nonce`. Untuk `checkout_*`
➕ nonce = `checkout_token` — satu checkout hanya sekali, walau pixel memicu ulang.

**Kebijakan per pintu** (server, bukan client):

| Pintu | Auth | Tipe diterima | Boleh membuat Assignment | Visitor harus dikenal |
|---|---|---|---|---|
| `/proxy/collect` | HMAC App Proxy ✅ | semua kecuali `checkout_*` ➕ | ya | tidak |
| `/pixel/collect` | tidak ada; CORS `*` ✅ | hanya `checkout_*` ✅ | tidak ✅ | ya ✅ |
| webhook | HMAC Shopify ✅ | order lifecycle | tidak | tidak (lihat §5) |

➕ `/proxy/collect` **menolak** `checkout_*`: satu tipe = satu sumber, supaya
coverage per sumber bisa diukur (§8).

---

## 5. Ledger: skema target

Model yang sudah ada dipertahankan; yang baru ditambahkan tanpa migrasi destruktif.

```prisma
/// ➕ SEMUA order yang masuk webhook, punya atribusi atau tidak.
model OrderIntake {
  orderId          String   @id            // gid
  shop             String
  checkoutToken    String?
  cartToken        String?
  totalPrice       Decimal  @db.Decimal(14, 2)
  currency         String
  financialStatus  String?
  sourceName       String?                 // web | shop_app | pos | draft_order …
  createdAt        DateTime
  paidAt           DateTime?
  /// attributed | unattributed | excluded (pos, draft, test)
  status           String
  /// cart_attr | checkout_token | cart_token | none
  attributionKind  String?
  receivedAt       DateTime @default(now())
  @@index([shop, status, createdAt])
}

/// ➕ Kunci sekunder untuk atribusi berlapis (§3).
model AttributionKey {
  kind         String   // cart_token | checkout_token
  value        String
  visitorId    String
  experimentId String
  variant      String
  seenAt       DateTime @default(now())
  @@id([kind, value])
  @@index([visitorId])
}

/// ➕ Hasil pemeriksaan invariant, satu baris per pemeriksaan (§7).
model HealthSample {
  id           BigInt   @id @default(autoincrement())
  experimentId String?
  check        String   // I1..I14
  status       String   // ok | warn | fail
  value        Float?
  detail       String?
  checkedAt    DateTime @default(now())
  @@index([check, checkedAt])
}

/// ➕ Bukti hidup per sumber, dipakai I2/I3.
model SourceHeartbeat {
  source     String   @id  // storefront | pixel | webhook | posthog_outbox
  lastSeenAt DateTime
  count24h   Int
}
```

Perubahan pada model lama:
- `Event` ➕ `sessionId String?`, `source String` (storefront|pixel|canary),
  `receivedAt`. `productId` sudah string ✅.
- `Conversion` ➕ `attributionKind String`, relasi ke `OrderIntake`.
- `Experiment` ➕ `variantAChecksum` — untuk **I9 (A/A tak disengaja)**.

---

## 6. Alur utama & titik gagal

### 6.1 Kunjungan → order (jalur bahagia)

```
head script   /proxy/collect   ingest        ledger              webhook           ingest
    │ exposure+view ─►│ HMAC ok ──►│ Assignment(vid,exp,B)      │                   │
    │ add_to_cart ───►│           │ Event · AttributionKey(cart_token) ◄─ /cart.js   │
pixel checkout_started ─► /pixel/collect ─► Event · AttributionKey(checkout_token)   │
                                                                orders/paid ──────►│ rantai §3
                                                                                   │ Conversion(attr=cart_attr)
                                                                                   │ OrderIntake(attributed)
                                                                                   │ outbox: PostHog · GA4 · metafield
```

### 6.2 Mode gagal yang WAJIB tertangani (dan bagaimana)

| # | Kegagalan | Sekarang | Target |
|---|---|---|---|
| F1 | Cart attributes ditimpa app lain | order hilang dari hasil, tanpa jejak | fallback `checkout_token` → `cart_token`; kalau tetap gagal → `OrderIntake.unattributed` + I5 |
| F2 | Pixel diblokir / mati | funnel checkout = 0, terlihat sah | `SourceHeartbeat.pixel` + I3 (rasio `checkout_started` / `orders` per hari) |
| F3 | Endpoint pixel salah (kasus hari ini) | diam | pixel **bertanda tangan ringan**: `settings.collectEndpoint` divalidasi saat `ensureWebPixel` dengan HEAD ke URL-nya; I3 menangkap sisanya |
| F4 | Storefront JS mati (theme diedit, snippet rusak) | exposure = 0 tapi order tetap masuk | I2: order tanpa exposure dalam 7 hari terakhir → **merah** |
| F5 | Webhook tertunda / gagal | konversi terlambat | `WebhookLog` ✅ + I4 (lag `paidAt → receivedAt` p95) + ➕ backfill harian via Admin API `orders(query: "financial_status:paid updated_at:>…")` |
| F6 | Cookie hilang di tengah (consent, private mode) | visitor baru → dua exposure | I6 (rasio exposure : session) + `sid` untuk dedupe per sesi |
| F7 | Hash browser ≠ server | ✅ `bucket_drift` | tetap; I7 = 0 toleransi |
| F8 | Split tidak 50/50 | ✅ SRM | tetap; I8 |
| F9 | Variant B identik dengan A | tidak terdeteksi | ➕ I9: checksum A vs B saat start & tiap jam; kalau sama → badge "A/A" di dashboard (bukan error — A/A sah, tapi harus disadari) |
| F10 | Event ganda dari dua sumber | tadi terjadi | satu tipe = satu sumber (§4) + I10 (duplikat `visitorId,type,productId,dayKey` lintas sumber = 0) |
| F11 | Outbox PostHog macet | ✅ `outboxPending` | I11 ambang: pending > 500 atau tertua > 15 menit → kuning |
| F12 | Order dari kanal non-storefront (POS, draft, Shop app checkout tanpa cart) | dihitung sebagai unattributed | `OrderIntake.status = excluded` berdasarkan `source_name`; **tidak** masuk coverage |
| F13 | Bot lolos guard UA | pengunjung palsu | ➕ `sid` tanpa `product_viewed` kedua dalam 2 detik + tanpa scroll → tanda `bot_suspect` (diagnostik, bukan filter) |
| F14 | Zona waktu `dayKey` UTC vs laporan WIB | hari bergeser 7 jam | dedupe tetap UTC (stabil); **laporan** dan timeline memakai `Asia/Jakarta` secara eksplisit |

---

## 7. Invariants (dieksekusi terjadwal)

Semua dievaluasi oleh satu job `reconcile` (Fly, tiap 10 menit; ringan) dan
ditulis ke `HealthSample`. Ambang default; bisa diubah per eksperimen.

| ID | Invariant | Query inti | ok / warn / fail |
|---|---|---|---|
| I1 | `Conversion.visitorId` selalu punya `Assignment` dengan variant yang sama | anti-join | fail jika > 0 |
| I2 | Storefront hidup: ada `exposure` dalam 60 menit terakhir saat toko ramai (≥ 1 order/jam) | heartbeat | fail |
| I3 | Pixel hidup: `checkout_started` unik ÷ `orders` (24 jam) ≥ 0,6 | rasio | warn < 0,6 · fail = 0 saat orders ≥ 5 |
| I4 | Lag webhook p95 (`paidAt → receivedAt`) < 5 menit | percentile | warn > 5m · fail > 30m |
| I5 | Coverage atribusi: `attributed ÷ (attributed+unattributed)` ≥ 0,9 (order web) | rasio | warn < 0,9 · fail < 0,7 |
| I6 | Exposure per sesi ≤ 1,05 | rasio | warn |
| I7 | `bucket_drift` = 0 | count | fail |
| I8 | SRM p ≥ 0,001 | ✅ | fail |
| I9 | checksum(template A) ≠ checksum(template B) | bridge `status` | **info** "A/A" jika sama |
| I10 | Tidak ada tipe event yang datang dari dua sumber | group by source,type | fail |
| I11 | Outbox PostHog: pending < 500 dan tertua < 15 menit | ✅ backlog | warn |
| I12 | Order metafield `tl_ab.variant` ada untuk setiap `Conversion` (24 jam) | anti-join via Admin API | warn |
| I13 | Selisih `Conversion.count` vs PostHog `order paid` (24 jam) ≤ 2 % | HogQL | warn |
| I14 | Selisih `Assignment.count` vs PostHog exposure unik ≤ 20 % (ad-blocker wajar) | ✅ exposure gap | info |

Dashboard: panel **Kesehatan pipeline** di halaman hasil, satu baris per
invariant, warna + nilai + kapan diperiksa. `fail` pada I1/I2/I7/I8/I10 →
`verdict.kind = "untrusted"` otomatis (mesin verdict sudah punya jalur ini ✅).

---

## 8. Coverage per sumber (angka yang harus selalu terlihat)

Ditampilkan di panel kesehatan, dihitung 24 jam terakhir:

```
storefront  : exposure unik  ████████████████████ 1.240   (heartbeat 14:52)
pixel       : checkout_started 312 ÷ orders 41 → 7,6×      (heartbeat 14:51)
webhook     : orders 41 · lag p95 38 dtk                    (heartbeat 14:50)
atribusi    : 39 / 41 order web = 95 %  · 2 unattributed · 3 excluded (POS)
posthog     : outbox 0 pending · order paid 41 = lokal 41
metafield   : 41 / 41 order bertanda
```

Angka-angka ini menjawab "apakah nol itu nol" — pertanyaan yang hari ini
butuh dua jam debugging untuk dijawab.

---

## 9. Antarmuka

### 9.1 HTTP (Fly)

| Route | Method | Auth | Fungsi |
|---|---|---|---|
| `/proxy/collect` ✅ | POST | HMAC App Proxy | event storefront (v1+v2) |
| `/pixel/collect` ✅ | POST/OPTIONS | CORS, requireKnown | event checkout dari pixel |
| ➕ `/internal/action` `health.run` | POST | internal token ✅ | jalankan reconcile sekarang, kembalikan `HealthSample[]` |
| ➕ `/internal/action` `orders.backfill` | POST | internal token | tarik order paid 48 jam terakhir via Admin API, jalankan rantai atribusi untuk yang belum ada |
| ➕ `/internal/action` `canary.run` | POST | internal token | jalankan visitor sintetis (§10) |

### 9.2 Webhook tambahan ➕

`checkouts/create` dan `checkouts/update` — membawa `token`, `cart_token`,
`note_attributes` lebih awal dari order; dipakai untuk mengisi `AttributionKey`
tanpa bergantung pada pixel. (Scope `read_checkouts`; perlu approval merchant
seperti `write_orders` tadi.)

### 9.3 Fan-out (semua idempoten, dari ledger)

| Tujuan | Kunci idempotensi | Sumber baris |
|---|---|---|
| PostHog `/batch` ✅ | uuid dari `dedupeKey` | `PostHogOutbox` |
| GA4 Measurement Protocol ✅ | `transaction_id = orderId` | `Conversion` |
| Metafield `tl_ab.variant` ✅ | `metafieldsSet` (upsert alami) | `Conversion` |
| ➕ Backfill metafield | sama | job harian untuk order yang gagal ditandai (I12) |

---

## 10. Pengujian & verifikasi berkelanjutan

1. **Canary visitor terjadwal** (tiap 30 menit): headless Chromium dari Fly
   (atau GitHub Actions) menjalankan PDP → add-to-cart → `/checkout`, dengan
   `vid` berprefiks `canary-` dan `navigator.webdriver` disamarkan. Lalu
   menegaskan di ledger: `exposure`, `add_to_cart`, `checkout_started`, dan
   `AttributionKey(checkout_token)` ada dalam ≤ 60 detik. Baris canary
   **dikecualikan** dari hasil (`source = canary`), tidak dihapus. Inilah tes
   yang hari ini dilakukan manual — dan yang akan menangkap F2/F3/F4 dalam 30
   menit, bukan setelah 1 order aneh.
2. **Kontrak skema**: `scripts/verify-attribution.mjs` ✅ ditambah kasus v2,
   `cart_token`, `checkout_token`, order tanpa attributes, dan urutan rantai.
3. **Replay**: fixture payload webhook (paid → cancelled → refund, dan retry
   ganda) dijalankan ke ingest dalam transaksi yang di-rollback; angka akhir
   harus identik dengan sekali jalan.
4. **Property test bucketing** ✅ (`verify-bucketing-parity`) dipertahankan.
5. **Uji sandbox pixel**: skrip CDP mentah (lihat memori) menjadi
   `scripts/verify-pixel-sandbox.mjs` — dijalankan manual setelah tiap deploy
   pixel, karena Playwright biasa tidak bisa melihat ke dalam sandbox.

---

## 11. Fase implementasi (urut berdasarkan risiko yang dihilangkan)

| Fase | Isi | Menghilangkan | Perkiraan |
|---|---|---|---|
| **1** | `OrderIntake` untuk semua order + status; panel coverage atribusi (I5) & heartbeat (I2, I3) | F1 terlihat, F2/F4 terdeteksi | 1 hari |
| **2** | `AttributionKey` + `cart_token` dari `/cart.js` + `checkout_token` dari pixel; rantai §3; backfill harian | F1 diperbaiki, bukan cuma terlihat | 1–2 hari |
| **3** | Job `reconcile` + `HealthSample` + panel kesehatan lengkap (I1–I14); `untrusted` otomatis | semua kegagalan diam-diam | 1–2 hari |
| **4** | Envelope v2 (`sid`, `seq`, `keys`), satu tipe = satu sumber di server, I9 checksum A/A | F6, F10, F9 | 1 hari |
| **5** | Canary terjadwal + skrip verifikasi sandbox | regresi masa depan | ½ hari |
| **6** | `checkouts/*` webhook (scope baru) + `orders.backfill` | F5, ketergantungan pada pixel untuk kunci | ½ hari + approval |

Fase 1–3 sudah cukup untuk menyebut sistem ini "tidak bisa gagal tanpa ketahuan".
Fase 4–6 membuatnya juga **sembuh sendiri** untuk kasus yang paling sering.

---

## 12. Yang sengaja TIDAK dilakukan

- **Tidak** memindahkan bucketing ke server/edge: flicker nol tetap prinsip
  utama (lihat SPEC PostHog §2).
- **Tidak** memakai pixel sebagai numerator konversi, walau `checkout_completed`
  ada: bias ad-blocker antar variant tidak bisa diukur, jadi tidak boleh masuk
  keputusan.
- **Tidak** menyimpan data pribadi pembeli (nama, email) di ledger: atribusi
  cukup lewat token & visitor id anonim.
- **Tidak** menghapus baris apa pun secara otomatis; canary dan bot ditandai,
  bukan dibuang — supaya audit selalu bisa merekonstruksi angka.


---

## 13. Heatmap kelas Hotjar (ditambahkan 2026-09-24)

Lapisan heatmap di `dashboard/components/audit/heatmap-frame.tsx` + query di
`app/lib/posthog/analytics.server.ts` (`heatmapFor`, `heatmapReplaysFor`).

| Mode | Sumber PostHog | Derivasi | Interaksi |
|---|---|---|---|
| Klik / Gerak / Rage | `heatmaps` (x, y, viewport ÷16) | peta panas Gaussian, dinormalkan ke piksel terpanas | hover: N tap · % dari semua tap; klik: kartu sematan + **Lihat replay** (sesi dalam radius ±6% lebar / ±60px → tautan replay PostHog) |
| Scroll | `heatmaps` scrolldepth (max per sesi) | % sesi yang mencapai tiap pita 100px, warna kontinu | garis mengikuti kursor "x% menggulir sampai sini", rel legenda kiri, garis lipatan (rata-rata `viewport_height`) |
| Perhatian | `events` `$pageleave` (`$prev_pageview_duration`, `$prev_pageview_max_scroll`, `$viewport_height`) | durasi halaman dibagi rata ke area yang sempat terlihat (0..max_scroll+vh), area tak digulir = 0; dibagi SEMUA pengunjung; warna relatif min..max halaman. (Baris scrolldepth terlalu jarang untuk waktu per posisi.) | garis mengikuti kursor "≈ x dtk per pengunjung · perhatian tinggi/sedang/rendah" |
| Click list | `events` `$autocapture` klik, `elements_chain` via regex | 8 elemen teratas + pangsa | — |

Aturan yang dipelajari dengan mahal: `viewport_width`, `x`, `y` di tabel
`heatmaps` sudah dibagi `scale_factor` (16); kolom array `elements_chain_*`
gagal di-GROUP BY pada project ini → pakai regex atas `elements_chain`; iframe
snapshot harus `pointer-events: none` + `scrolling="no"` supaya lapisan panas
tidak melenceng.
