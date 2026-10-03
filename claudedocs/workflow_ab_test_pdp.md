# Workflow — Custom Shopify App: A/B Test 2 Desain PDP (Treelogy)

Tanggal: 2026-09-03 · Toko: `prkdg7-jt.myshopify.com` (treelogy.com) · Plan: Professional
Stack target: Shopify App (React Router template) + Neon Postgres + Fly.io

---

## 0. Fakta yang sudah diverifikasi (bukan asumsi)

Dicek langsung lewat Admin API `2026-07` pakai token di `.env`:

| Item | Nilai | Implikasi |
|---|---|---|
| Live theme | `156446064828` — "Treelogy/staging" | custom theme, bukan Dawn |
| Template produk | `templates/product.json` (**OS 2.0 / JSON**) | ✅ alternate template didukung |
| Section utama PDP | `main` → type `MainProductDetail` | 1 section = hampir seluruh PDP → gampang di-swap |
| Alternate template existing | `product.context.europe.json` | pola `product.<suffix>.json` sudah dipakai di toko ini |
| Order 30 hari terakhir | **1.094** (~36/hari) | volume cukup untuk A/B test |
| Scope `read_products` | ❌ belum di-approve merchant | perlu di-approve di Admin > Apps > API access |
| Theme non-published | 18 theme backup/preview | perlu housekeeping, tapi tidak memblokir |

---

## 1. Hasil riset: gimana app A/B test lain melakukannya

Batasan fundamental Shopify yang membentuk semua arsitektur:

> **Liquid dirender server-side dan TIDAK bisa membaca cookie atau query param secara arbitrer.**
> Jadi keputusan "user ini masuk A atau B" tidak bisa diambil di Liquid.

Konsekuensinya cuma ada 4 pola yang dipakai app-app komersial:

### Pola 1 — Theme swap via `preview_theme_id` (Theme Scientist, sebagian Shoplift theme test)
Duplikat theme jadi Theme B, lalu app melempar sebagian visitor ke `?preview_theme_id=<B>` yang men-set cookie preview.
- ✅ Bisa test perubahan global (header, nav, semua halaman)
- ❌ Theme preview **tidak di-cache CDN** → PDP jadi lambat, Core Web Vitals jatuh
- ❌ Rapuh (Shopify bisa ubah perilaku cookie preview kapan saja), risiko SEO
- **Verdict: jangan dipakai.**

### Pola 2 — Alternate template + `?view=` (Shoplift/Intelligems template test) ⭐
Bikin `templates/product.ab-b.json` di theme yang sama. URL `/products/x?view=ab-b` merender template B, **fully server-rendered dan tetap di-cache Shopify**.
- ✅ Zero flicker, performa sama dengan halaman normal
- ✅ Aman: template A sama sekali tidak disentuh
- ⚠️ Perlu strategi supaya URL tidak "kotor" dan crawler tidak kena test
- **Verdict: ini fondasi yang kita pakai.**

### Pola 3 — Section Rendering API swap
Fetch `/products/x?view=ab-b&sections=main` (mengembalikan JSON berisi HTML section), lalu replace DOM.
- ✅ Tanpa navigasi tambahan, URL tetap bersih
- ⚠️ Butuh anti-flicker CSS (sembunyikan section sampai HTML B datang) → ada skeleton ~100–250ms untuk grup B saja
- ⚠️ Maks 5 section per request; JS section B harus di-re-init manual setelah swap
- **Verdict: alternatif/fallback yang bagus.**

### Pola 4 — Client-side DOM mutation (gaya Google Optimize / VWO / Convert)
JS mengubah teks/warna/urutan elemen setelah halaman load.
- ✅ Cepat dibuat untuk test kecil (copy headline, warna tombol)
- ❌ Flicker jelas, dan tidak sanggup untuk "2 desain PDP berbeda"
- **Verdict: tidak cocok untuk kasus ini.**

### Yang sama di semua app
- Bucketing **deterministik & client-side**: `hash(visitorId + experimentId) % 100`. Tidak pernah panggil server untuk memutuskan variant — itu sumber flicker & latency.
- Cookie visitor first-party, umur 30–180 hari, sticky lintas device tidak dijamin.
- Konversi **tidak** diandalkan dari JS. Diambil dari **cart attributes → webhook order** (server-side, kebal ad-blocker).
- Web Pixel dipakai untuk funnel intermediate (view → ATC → checkout), bukan sumber kebenaran revenue.

---

## 2. Arsitektur yang direkomendasikan

```
                   ┌──────────────── Shopify Storefront (treelogy.com) ────────────────┐
                   │                                                                    │
  visitor ────────►│  theme.liquid <head>                                               │
                   │   └─ App Embed Block (theme app extension, target: head)           │
                   │       • baca shop.metafields.treelogy_ab.config  (Liquid, 0 ms)    │
                   │       • script SINKRON:                                            │
                   │           1. ambil/buat cookie _tl_vid (visitor id, 180 hari)      │
                   │           2. variant = fnv1a(vid+expId) % 100 < 50 ? 'B' : 'A'     │
                   │           3. kalau B & belum di template B → aktifkan variant B     │
                   │           4. rewrite semua link /products/* supaya sticky           │
                   │       • sendBeacon exposure  ─────────────────────────┐             │
                   │                                                       │             │
                   │  templates/product.json      (VARIANT A - desain lama)│             │
                   │  templates/product.ab-b.json (VARIANT B - desain baru)│             │
                   │                                                       │             │
                   │  Add to cart → /cart/update.js                        │             │
                   │    attributes: { _tl_ab: "exp1:B", _tl_vid: "..." }   │             │
                   │                                                       │             │
                   │  Web Pixel Extension (sandbox)                        │             │
                   │    product_viewed / checkout_started / completed  ────┤             │
                   └───────────────────────────────────────────────────────┼─────────────┘
                                                                           │
                        App Proxy  /apps/tl-ab/*  (signed, HMAC-verified)  │
                                                                           ▼
                   ┌──────────────────────── Fly.io (region: sin) ───────────────────────┐
                   │  Shopify App — React Router v7 + @shopify/shopify-app-react-router  │
                   │                                                                      │
                   │  /apps/tl-ab/collect   ← exposure + funnel events (batched)          │
                   │  /webhooks/orders/paid ← SUMBER KEBENARAN konversi                   │
                   │  /webhooks/orders/create, /app/uninstalled, GDPR x3                  │
                   │  /app/*                ← Admin UI (Polaris + App Bridge)             │
                   │      • bikin/edit eksperimen, split %, target produk                 │
                   │      • dashboard: sessions, CVR, RPV, uplift, p-value, SRM check     │
                   │      • tombol "Publish config" → tulis shop metafield + theme asset   │
                   └──────────────────────────────┬───────────────────────────────────────┘
                                                  │
                                     ┌────────────▼────────────┐
                                     │  Neon Postgres (ap-se1) │
                                     │  Prisma + pooled conn   │
                                     └────────────▲────────────┘
                                                  │ baca/tulis langsung
                   ┌──────────────────────────────┴───────────────────────────────┐
                   │  DASHBOARD — Next.js 16 di Vercel                            │
                   │    • login email+password (scrypt), peran admin/viewer        │
                   │    • daftar + detail eksperimen, grafik, audit log            │
                   │    • aksi Shopify di-relay ke Fly.io /internal/action         │
                   │      lewat HMAC-SHA256 + timestamp (tolak kalau > 5 menit)    │
                   └──────────────────────────────────────────────────────────────┘
```

### Kenapa bucketing di client, bukan di server
Kalau variant ditentukan lewat fetch ke Fly.io, setiap PDP nunggu round-trip Jakarta→Singapore (~40–120 ms) sebelum bisa render → flicker + LCP naik. Dengan hash deterministik + cookie, keputusan diambil **0 ms**, dan Fly.io cuma menerima log (fire-and-forget `sendBeacon`).

### Sticky assignment
`_tl_vid` = UUID di cookie first-party, 180 hari, domain `.treelogy.com`. Hash-nya deterministik, jadi visitor yang sama selalu dapat variant yang sama walau cookie experiment-nya hilang — selama `_tl_vid` bertahan. Kalau `_tl_vid` juga hilang → dihitung visitor baru (ini normal & sama di semua tool).

---

## 3. Keputusan yang perlu dikunci (fork arsitektur)

### 3A. Cara mengaktifkan Variant B — **DIPUTUSKAN: Redirect `?view=` + link rewriting**

```
Landing di /products/x  →  script <head> deteksi bucket B
                        →  location.replace('/products/x?view=ab-b')
                        →  Shopify render template B (cached, zero flicker)
Setelah itu semua <a href="/products/..."> di-rewrite jadi ?view=ab-b
                        → tidak ada redirect lagi di navigasi berikutnya
```
- ✅ 100% server-rendered, performa & CWV identik dengan halaman normal
- ✅ Paling sederhana & paling tahan banting
- ❌ 1 navigasi ekstra pada landing pertama grup B (~200–400 ms sekali saja)
- ❌ Query param `?view=ab-b` terlihat di URL

Opsi yang ditolak: Section Rendering API swap (URL bersih tapi ada skeleton 100–250 ms dan
JS section B harus di-init ulang manual → rawan bug untuk redesign PDP penuh).

### 3B. Cakupan test — **DIPUTUSKAN: user-selectable di admin UI**

Admin UI menyediakan **targeting selector** per eksperimen, bukan hardcoded:

| `targetType` | UI | Perilaku script |
|---|---|---|
| `all_products` | radio "Semua produk" | semua PDP masuk test |
| `product_ids` | resource picker multi-select produk | hanya handle produk terpilih |
| `collection_ids` | resource picker multi-select collection | produk dalam collection terpilih |
| `exclude_ids` | field opsional | blacklist, dievaluasi terakhir |

Implementasi: daftar **handle** produk yang masuk test di-resolve saat "Publish config"
(bukan saat runtime) dan disimpan ke `shop.metafields.treelogy_ab.config`. Script di
`<head>` cuma perlu cek `config.handles.includes(currentHandle)` — O(1) lewat Set, tanpa
network call. Kalau `targetType = all_products`, field `handles` dikosongkan dan script
cukup cek `template === 'product'`.

> ⚠️ Resource picker produk & collection butuh scope `read_products` yang **saat ini
> ditolak** — lihat Fase 0.2.

### 3C. Primary metric — **DIPUTUSKAN: user-selectable, dikunci saat test start**

Dropdown di form eksperimen:

| `primaryMetric` | Uji statistik | Catatan sample size |
|---|---|---|
| `cvr` (PDP view → purchase) | two-proportion z-test + Bayesian Beta-Binomial | baseline, ~19.600/arm untuk MDE 20% |
| `atc_rate` (view → add to cart) | two-proportion z-test | tercepat, tapi menang ATC ≠ menang revenue |
| `rpv` (revenue per visitor) | bootstrap CI (revenue tidak normal, jangan z-test) | butuh sample ~2–3× lebih banyak |
| `aov` (average order value) | Welch t-test pada order saja | denominator = order, bukan visitor |

**Guardrail anti p-hacking:** field `primaryMetric` + `mdeRelative` + `minSampleArm`
menjadi **read-only di level aplikasi begitu `status` berubah ke `running`**. Metric lain
tetap ditampilkan di dashboard tapi diberi label "secondary — jangan dipakai untuk
mengambil keputusan". Kalau user benar-benar mau ganti metric, satu-satunya jalan adalah
menghentikan eksperimen dan membuat eksperimen baru (sample direset).

## 4. Perkiraan durasi test (statistical power)

Basis: 1.094 order / 30 hari. Angka di bawah dihitung dengan formula two-proportion
eksak (α = 0,05, power = 80%) lewat `npm test`, bukan rule-of-thumb.

| Asumsi CVR | Sessions/hari (turunan) | MDE relatif | Sample/grup | Durasi |
|---|---|---|---|---|
| 2,0% | ~1.820 | 30% | 9.795 | **~11 hari** |
| 2,0% | ~1.820 | 20% | 21.106 | **~24 hari** |
| 2,0% | ~1.820 | 15% | 36.691 | ~41 hari |
| 2,0% | ~1.820 | 10% | 80.679 | ~89 hari ❌ |

> ⚠️ Kolom sessions/hari adalah **turunan dari asumsi CVR 2%**, bukan data.
> Langkah pertama Fase 0: ambil sessions & CVR asli dari Shopify Analytics.
> Aplikasi tidak memakai angka asumsi ini saat test berjalan — sample size
> dihitung ulang otomatis dari baseline yang benar-benar teramati di variant A.

**Aturan main yang di-enforce aplikasi:**
- Minimum runtime **14 hari** (2 siklus mingguan penuh) walau sudah "signifikan"
- Target MDE realistis: **≥20% relative lift** — desain B harus perubahan besar
- No peeking: dashboard menandai "Belum boleh disimpulkan" beserta alasannya
  sampai sample size dan durasi minimum terpenuhi
- SRM check chi-square (ambang p < 0,001) — banner merah kalau split menyimpang
- Bucket-drift check: kalau hash storefront dan server tidak sepakat, hasil ditandai rusak

## 5. Skema database (Neon Postgres / Prisma)

```prisma
model Session { ... }              // dari @shopify/shopify-app-session-storage-prisma

model Experiment {
  id            String   @id @default(cuid())
  shop          String
  name          String
  hypothesis    String?
  status        String   // draft | running | paused | completed | archived
  targetType    String   // all_products | product_ids | collection_id
  targetIds     String[] @default([])
  variantASuffix String? // null = templates/product.json (default)
  variantBSuffix String  // "ab-b" → templates/product.ab-b.json
  splitPctB     Int      @default(50)
  primaryMetric String   // cvr | rpv | aov
  mdeRelative   Float    @default(0.20)
  minSampleArm  Int
  startedAt     DateTime?
  endedAt       DateTime?
  @@index([shop, status])
}

model Assignment {                          // 1 baris per visitor per eksperimen
  visitorId    String
  experimentId String
  variant      String   // A | B
  firstSeenAt  DateTime @default(now())
  lastSeenAt   DateTime @updatedAt
  @@id([visitorId, experimentId])
  @@index([experimentId, variant])
}

model Event {
  id           BigInt   @id @default(autoincrement())
  experimentId String
  visitorId    String
  variant      String
  type         String   // exposure | product_viewed | add_to_cart | checkout_started
  productId    String?
  occurredAt   DateTime
  dedupeKey    String   @unique          // cegah double-count dari retry sendBeacon
  @@index([experimentId, variant, occurredAt])
}

model Conversion {                          // SUMBER KEBENARAN — dari webhook, bukan JS
  orderId      String   @id                 // gid Shopify
  experimentId String
  variant      String
  visitorId    String?
  totalPrice   Decimal
  currency     String
  financialStatus String
  createdAt    DateTime
  cancelledAt  DateTime?                    // untuk exclude order batal/refund
  source       String   // webhook | pixel
  @@index([experimentId, variant, createdAt])
}

model WebhookLog { webhookId String @id; topic String; receivedAt DateTime @default(now()) }
```

> Tidak ada tabel agregat harian. Semua angka dashboard dihitung langsung dari
> `Assignment` + `Event` + `Conversion` lewat SQL agregasi. Pada volume toko ini
> (~55rb visitor/bulan) Postgres menanganinya tanpa masalah, dan hasilnya selalu
> akurat tanpa risiko rollup basi. Tabel rollup baru perlu ditambahkan kalau
> nanti query dashboard mulai lambat.

---

## 6. Alur data & atribusi konversi

```
1. EXPOSURE
   PDP render → sendBeacon POST /apps/tl-ab/collect
   { vid, expId, variant, type:"exposure", productId, ts, nonce }
   Server: upsert Assignment + insert Event (dedupeKey = vid|expId|type|date)

2. ADD TO CART  ← titik atribusi paling penting
   Intercept fetch/XHR ke /cart/add.js (atau hook tombol ATC)
   → POST /cart/update.js
     { attributes: { "_tl_ab": "exp1:B", "_tl_vid": "<uuid>" } }
   Prefix "_" = hidden attribute, tidak muncul di halaman cart/checkout customer.

3. CHECKOUT
   Cart attributes otomatis ikut jadi Order.note_attributes.

4. PURCHASE (sumber kebenaran)
   Webhook orders/paid → baca note_attributes["_tl_ab"] dan ["_tl_vid"]
   → insert Conversion (dedupe by X-Shopify-Webhook-Id di WebhookLog)
   Webhook orders/cancelled + refunds/create → set cancelledAt, exclude dari hasil.

5. FUNNEL SEKUNDER (opsional, bukan sumber kebenaran)
   Web Pixel Extension → product_viewed, checkout_started, checkout_completed
   Variant dibaca via browser.cookie API di sandbox pixel.
```

**Kenapa cart attributes, bukan cuma pixel:** ad-blocker & ITP memblokir 10–30% event JS. Webhook order dikirim server-to-server dari Shopify → 100% tertangkap.

---

## 7. Fase implementasi

### Fase 0 — Prasyarat
| # | Task | Catatan |
|---|---|---|
| 0.1 | ~~Tambah `DATABASE_URL` Neon ke `.env`~~ | ✅ project `treelogy-ab-test` (`twilight-mouse-38711040`), PG18, `aws-ap-southeast-1`, migrasi `init` sudah jalan |
| 0.2 | Approve protected customer data + scope `read_products`, `read_orders` di Admin > Apps > API access | saat ini `read_products` ditolak |
| 0.3 | Ambil angka sessions & CVR asli dari Shopify Analytics | untuk kunci sample size di §4 |
| 0.4 | Kunci keputusan §3A / §3B / §3C | menentukan sisa pekerjaan |
| 0.5 | Housekeeping 18 theme unpublished | kurangi risiko salah edit theme |

### Fase 1 — Fondasi app ✅ SELESAI
1. `shopify app init` → template **React Router**
2. Ganti session storage SQLite → Prisma + **Neon** (pooled connection string, `?sslmode=require`)
3. `shopify.app.toml`: scopes `read_themes, write_themes, read_orders, write_pixels, read_customer_events, read_products`
4. Konfigurasi **App Proxy**: subpath `apps/tl-ab` → `https://<fly-app>.fly.dev/proxy`
5. Deploy Fly.io region `sin`, `min_machines_running = 1` (hindari cold start di endpoint proxy)
6. **Checkpoint**: app terinstall, OAuth jalan, `/apps/tl-ab/health` balikan 200 dari storefront

### Fase 2 — Schema & webhook ✅ SELESAI (belum di-migrate, butuh DATABASE_URL)
1. Prisma schema §5 + `prisma migrate deploy`
2. Webhook `orders/paid`, `orders/create`, `orders/cancelled`, `refunds/create`, `app/uninstalled`, GDPR ×3
3. HMAC verification + idempotency via `WebhookLog`
4. **Checkpoint**: order test manual → baris `Conversion` masuk Neon

### Fase 3 — Theme app extension ✅ SELESAI (belum di-deploy)
1. Extension `theme-app-extension` dengan app embed block `target: head`
2. Liquid inline config dari `shop.metafields.treelogy_ab.config` (type `json`)
3. Script sinkron ±2 KB, no dependency:
   - cookie `_tl_vid`
   - FNV-1a hash → bucket
   - guard: skip kalau `Shopify.designMode`, bot UA, `navigator.webdriver`, atau param `?_tl_ab_off=1`
   - guard: hormati Customer Privacy API consent kalau consent banner aktif
   - aktifkan variant sesuai keputusan §3A
   - link rewriting untuk sticky navigation
   - `sendBeacon` exposure
4. Hook add-to-cart → `/cart/update.js` set attributes
5. **Checkpoint**: buka PDP di 2 browser profile berbeda → dapat desain berbeda, refresh 10× → tetap sticky, Lighthouse LCP tidak turun >5%

### Fase 4 — Variant B di theme (paralel dengan Fase 3, tergantung desain)
1. Duplikat `templates/product.json` → `templates/product.ab-b.json` (via Admin API Asset atau Shopify CLI)
2. Susun desain B pakai theme editor: `/admin/themes/156446064828/editor?template=product&view=ab-b`
3. **Checkpoint**: `/products/<handle>?view=ab-b` render desain B dengan benar di mobile + desktop

### Fase 5 — Web Pixel + funnel ✅ SELESAI (belum di-register)
1. Web pixel extension, register via `webPixelCreate` mutation
2. Subscribe `product_viewed`, `search_submitted`, `checkout_started`, `checkout_completed`
3. Baca variant lewat `browser.cookie` API dalam sandbox
4. **Checkpoint**: Shopify Pixel Helper menunjukkan event terkirim dengan field `variant`

### Fase 6 — Admin UI + statistik ✅ SELESAI
1. Halaman list/create/edit eksperimen (Polaris)
2. Tombol "Publish" → tulis shop metafield config + (opsional) bikin alternate template otomatis
3. Cron rollup harian → `DailyRollup`
4. Dashboard:
   - Sessions, ATC rate, CVR, AOV, RPV per variant
   - Uplift relatif + confidence interval
   - **Two-proportion z-test** (p-value) untuk CVR
   - **Bayesian Beta-Binomial**: "probability B > A" (lebih gampang dibaca non-teknis)
   - RPV pakai bootstrap CI (revenue tidak normal)
   - **SRM check** chi-square, banner merah kalau p < 0.001
   - Progress bar sample size + "belum boleh disimpulkan" gate
5. **Checkpoint**: data dummy → semua angka statistik cocok dengan kalkulator eksternal

### Fase 8 — Dashboard Next.js di Vercel ✅ SELESAI

Alasan ada dua UI: admin Polaris di dalam Shopify Admin dibatasi komponen Polaris dan
hanya bisa dibuka lewat Shopify. Dashboard terpisah memberi keleluasaan desain penuh
dan bisa dibuka siapa saja yang diberi akun, tanpa perlu akses staff Shopify.

1. Next.js 16 App Router + Tailwind 4 + shadcn/ui (base radix), dark-first
2. Auth email + password: scrypt bawaan Node (tanpa modul native), sesi JWT di cookie
   httpOnly. Peran `admin` / `viewer`
3. Audit log — setiap aksi yang mengubah storefront tercatat beserta pelakunya
4. Bridge HMAC-SHA256 + timestamp ke `/internal/action` di Fly.io; request lebih tua
   dari 5 menit ditolak supaya tidak bisa diputar ulang
5. Grafik conversion rate kumulatif dengan pita interval kepercayaan 95%
6. `scripts/sync-dashboard.mjs` menjaga schema dan rumus statistik tetap identik
   antara kedua aplikasi, dengan mode `--check` di `npm test`

**Checkpoint**: `npx next build` dan `npx eslint .` bersih; login berhasil; tombol
Jalankan di Vercel benar-benar membuat template B di theme Shopify.

### Fase 7 — QA & rilis (1–2 hari)
1. A/A test 3–5 hari dulu (kedua variant pakai template sama) → validasi tidak ada bias sistematis & SRM bersih
2. Cek: cache CDN, Core Web Vitals, mobile, halaman non-PDP tidak terpengaruh
3. Cek SEO: `?view=` tidak diindeks (canonical bersih, crawler selalu dapat A)
4. Kill switch: satu toggle di admin → semua visitor balik ke A instan
5. Baru start test asli

---

## 8. Risiko & mitigasi

| Risiko | Dampak | Mitigasi |
|---|---|---|
| SRM (split tidak 50/50) | hasil test tidak valid | chi-square harian + alert; hash deterministik bukan `Math.random()` |
| Crawler kena bucket B | duplicate content / SEO | UA guard + canonical bersih + `?view=` tidak pernah di sitemap |
| Cold start Fly.io | exposure event hilang | `min_machines_running=1`; `sendBeacon` fire-and-forget jadi tidak blocking render |
| Ad-blocker blok `/apps/tl-ab` | exposure undercount | konversi tetap akurat via webhook; exposure via App Proxy (first-party domain) jarang diblok |
| Desain B punya bug di mobile | rugi revenue nyata | kill switch + monitoring CVR harian; auto-pause kalau B turun >20% setelah n minimum |
| Order tanpa `_tl_ab` attribute | konversi tidak ter-atribusi | fallback join via `_tl_vid` ke tabel Assignment |
| Theme editor overwrite template B | test rusak diam-diam | checksum template B, alert kalau berubah saat test running |
| Ganti primary metric di tengah | p-hacking | metric dikunci di DB saat status → `running`, read-only |

---

## 9. Env yang dibutuhkan

```bash
# Sudah ada di .env
ADMIN_API_KEY=...          # → rename ke SHOPIFY_ADMIN_API_TOKEN biar jelas
CLIENT_ID_APP=...          # → SHOPIFY_API_KEY
CLIENT_SECRET_APP=...      # → SHOPIFY_API_SECRET
STORE_NAME=treelogymoringa

# MASIH KURANG
DATABASE_URL=postgresql://...neon.tech/...?sslmode=require&channel_binding=require
DIRECT_URL=postgresql://...neon.tech/...?sslmode=require   # untuk prisma migrate
SHOPIFY_APP_URL=https://<fly-app>.fly.dev
SCOPES=read_themes,write_themes,read_orders,write_pixels,read_customer_events,read_products
SHOPIFY_APP_PROXY_SUBPATH=tl-ab
AB_COOKIE_DOMAIN=.treelogy.com
```

---

## 10. Estimasi

| Fase | Durasi |
|---|---|
| 0 — Prasyarat | 0,5 hari (+ waktu approval merchant) |
| 1 — Fondasi app | 1–2 hari |
| 2 — Schema & webhook | 1 hari |
| 3 — Theme app extension | 2–3 hari |
| 4 — Desain variant B | tergantung desainer |
| 5 — Web pixel | 1 hari |
| 6 — Admin UI + statistik | 2–3 hari |
| 7 — QA + A/A test | 1–2 hari + 3–5 hari runtime |
| **Total engineering** | **~9–13 hari kerja** |
| **Sampai hasil test valid** | **+3–4 minggu runtime** |

---

## Audit menyeluruh — 2026-09-04

Script `<head>` sebelumnya hanya diverifikasi fungsi hash-nya, tidak pernah
benar-benar **dijalankan**. Dibuatkan harness (`scripts/harness.mjs`) yang
mengeksekusi file `.liquid` yang sesungguhnya dikirim ke browser, di dalam DOM
tiruan. Harness membaca file itu langsung, jadi logika tidak bisa diubah tanpa
pengujiannya ikut gagal.

### Dua bug nyata yang ditemukan dan diperbaiki

**1. Cookie ditolak diam-diam → setiap pageview jadi pengunjung baru**

Browser menolak cookie yang `domain`-nya tidak cocok dengan host saat ini, **tanpa
melempar error**. Kalau `AB_COOKIE_DOMAIN` tidak cocok (misalnya saat diakses lewat
domain `.myshopify.com`), visitor id tidak pernah tersimpan: tiap halaman dibuka ia
dianggap pengunjung baru, bucket-nya diacak ulang, sticky assignment hilang total.

Yang membuatnya berbahaya: angka test tetap keluar dan tetap terlihat masuk akal.
Split tetap sekitar 50/50, jadi pemeriksaan SRM pun tidak menangkapnya.

Perbaikan: hasil penulisan cookie dibaca ulang; kalau gagal, ditulis ulang tanpa
atribut `domain`.

**2. Loop redirect tak berujung saat template variant B tidak ada**

Kalau `templates/product.ab-b.json` tidak ada, Shopify mengabaikan `?view=ab-b` dan
diam-diam merender template default. Script melihat suffix belum sesuai, lalu
mengarahkan lagi — selamanya. Pengaman `sessionStorage` yang ada membatasi di 3 kali,
tapi di mode privat `sessionStorage` melempar error sehingga penghitungnya tidak
pernah naik dan loop berjalan tanpa batas.

Perbaikan: sebelum mengarahkan, dicek apakah URL **sudah** meminta view tersebut.
Kalau sudah tapi Shopify tetap merender template lain, berarti templatenya tidak ada
— berhenti. Pemeriksaan ini tidak bergantung pada penyimpanan apa pun.

### Cakupan pengujian sekarang

| Berkas | Isi | Jumlah |
|---|---|---|
| `verify-bucketing-parity.mjs` | hash storefront vs server, 20.000 visitor x 5 split | 100.000 perbandingan |
| `verify-stats.mjs` | z-test, Bayesian, Welch, SRM, sample size | 14 asersi |
| `verify-head-script.mjs` | perilaku script di DOM tiruan | 38 asersi |
| `verify-attribution.mjs` | pembacaan atribusi dari payload order | 16 asersi |
| `sync-dashboard.mjs --check` | schema & statistik dashboard tidak drift | 4 berkas |

### Verifikasi ujung-ke-ujung di toko sungguhan

| Yang diuji | Hasil |
|---|---|
| `templates/product.ab-b.json` dibuat lewat bridge | `templateCreated: true` |
| Shopify merender alternate template | `page_template: "product.ab-b"` |
| Struktur halaman A vs B | 7 section, urutan identik |
| App block di A vs B | 4 app, sama persis |
| App embed hidup di storefront | `window.__TL_AB__` hadir di halaman produk |
| Config terbaca Liquid dari app-data metafield | terbukti — asumsi terakhir yang tersisa |
| Konteks halaman | `pageType: "product"`, handle & productId benar |
| Dampak ke pengunjung selama pengujian | 0 assignment, 0 event, 0 conversion |
