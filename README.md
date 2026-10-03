# Treelogy A/B Test — Custom Shopify App

Custom Shopify app untuk menjalankan A/B test dua desain PDP secara bersamaan di
`treelogy.com`. Visitor terbagi otomatis dan sticky, dan hasilnya diuji secara
statistik sebelum boleh disimpulkan.

Rencana lengkap, hasil riset, dan alasan di balik tiap keputusan arsitektur ada di
[`claudedocs/workflow_ab_test_pdp.md`](claudedocs/workflow_ab_test_pdp.md).

**Mau menyiapkan theme untuk variant B?** Baca
[`claudedocs/panduan-preview-theme-variant-b.md`](claudedocs/panduan-preview-theme-variant-b.md)
— aturan file apa yang boleh dan tidak boleh diubah, plus kondisi 8 theme preview
yang ada di toko sekarang.

Sistemnya terdiri dari dua aplikasi:

| | Di mana | Tugas |
|---|---|---|
| **App Shopify** (repo ini) | Fly.io `sin` | OAuth, webhook, app proxy, theme app extension, satu-satunya pemegang access token Shopify |
| **[Dashboard](dashboard/)** | Vercel | UI kontrol + analitik. Baca Neon langsung; aksi yang menyentuh Shopify di-relay lewat bridge HMAC |

---

## Cara kerjanya

Batasan yang membentuk seluruh desain: **Liquid dirender server-side dan tidak bisa
membaca cookie**, jadi keputusan "visitor ini A atau B" mustahil diambil di Liquid.

```
visitor buka /products/x
  └─ app embed block di <head> (theme app extension)
      ├─ config eksperimen sudah inline dari app-data metafield  → 0 network call
      ├─ ambil/buat cookie _tl_vid (180 hari)
      ├─ variant = fnv1a32(vid + ":" + expId) % 10000 < split*100 ? B : A
      └─ kalau B  → location.replace("/products/x?view=ab-b")
                    Shopify merender templates/product.ab-b.json (tetap di-cache CDN)

navigasi berikutnya
  └─ semua <a href="/products/*"> di-rewrite dengan ?view=ab-b  → tidak ada redirect lagi

add to cart
  └─ /cart/update.js  attributes: { _tl_ab: "expId:B", _tl_vid: "..." }
      └─ terbawa ke Order.note_attributes

order dibayar
  └─ webhook orders/paid  → SUMBER KEBENARAN konversi (kebal ad-blocker)
```

Bucketing tidak pernah memanggil server, jadi tidak ada flicker dan tidak ada
tambahan latency. Variant B dirender penuh oleh Shopify, bukan hasil manipulasi DOM.

---

## Struktur

```
app/                      APP SHOPIFY (Fly.io)
  lib/
    bucketing.ts          hash FNV-1a — HARUS identik dengan versi storefront
    stats.ts              z-test, Bayesian, Welch t-test, SRM, sample size
    results.server.ts     agregasi hasil + gate "boleh disimpulkan"
    config.server.ts      config storefront → app-data metafield ($app:ab/config)
    theme.server.ts       baca/buat templates/product.<suffix>.json
    experiment.server.ts  lifecycle: start / pause / kill switch / publish
    attribution.ts        parsing note_attributes order
    webhook.server.ts     idempotency webhook
    posthog/
      taxonomy.ts         nama event, properti, flag key, variant key, uuid v5 — satu sumber
      metrics.ts          definisi ExperimentMetric PostHog per metric lokal
      results.ts          pembaca hasil PostHog + verdict acuan
      client.server.ts    outbox → POST /batch (retry, idempotent)
      events.server.ts    pembentuk event dari kejadian internal
      experiments.server.ts  Experiments API: create/launch/pause/resume/end, hasil
  routes/
    app._index.tsx              daftar + buat eksperimen
    app.experiments.$id.tsx     pengaturan, aksi, dashboard hasil
    proxy.collect.tsx           App Proxy: penerima event dari storefront
    webhooks.orders.paid.tsx    konversi (sumber kebenaran)
    webhooks.orders.cancelled.tsx / webhooks.refunds.create.tsx
extensions/
  tl-ab-embed/            theme app extension (app embed block, target: head)
  tl-ab-pixel/            web pixel — metrik funnel sekunder saja
  routes/
    internal.action.tsx         bridge: satu-satunya pintu dashboard ke Shopify Admin API
scripts/
  verify-bucketing-parity.mjs   membuktikan hash storefront == hash server
  verify-stats.mjs              sanity check semua fungsi statistik
  verify-posthog.mjs            taksonomi, paritas literal storefront, bentuk metric, pembaca hasil
  sync-dashboard.mjs            menyalin schema + statistik ke dashboard, dan mengecek drift

dashboard/                DASHBOARD (Vercel) — lihat dashboard/README.md
  app/(app)/              daftar eksperimen, detail + grafik, audit log
  app/(app)/experiments/new  wizard 5 langkah: halaman -> variant B -> snapshot -> tracking -> konfigurasi
  app/api/snapshot/       proxy HTML storefront untuk iframe (script dibuang, wajib login)
  lib/storefront.ts       ambil halaman theme live & preview tanpa token Admin
  lib/trackers.ts         16 signature tracking + klasifikasi tahu/tidak tahu variant
  app/login/              email + password
  lib/                    db, sesi, hashing password, klien bridge
  lib/stats.ts            ← di-sync dari app/lib/stats.ts, jangan diedit di sini
```

---

## Setup

### 1. Isi env yang masih kosong

`.env` sudah berisi kredensial app. Yang masih perlu diisi:

```bash
DATABASE_URL="postgresql://...@...neon.tech/neondb?sslmode=require&channel_binding=require"
DIRECT_URL="postgresql://...@...neon.tech/neondb?sslmode=require"
```

`DATABASE_URL` memakai host `-pooler` (untuk runtime), `DIRECT_URL` memakai host tanpa
`-pooler` (untuk `prisma migrate`). Neon membedakan keduanya lewat hostname, jadi
parameter `pgbouncer=true` tidak diperlukan.

### 2. Approve scope di Shopify Admin

Buka **Admin → Settings → Apps and sales channels → Treelogy A/B Test → API access**
dan setujui akses data pelanggan. Tanpa ini `read_products` dan `read_orders` ditolak,
sehingga resource picker dan atribusi konversi tidak jalan.

### 3. Migrate & jalankan

```bash
npm install
npx prisma migrate dev --name init
npm run dev            # tunnel + install app ke toko
```

### 4. Aktifkan app embed di theme

Setelah app terpasang: **Online Store → Themes → Customize → App embeds →
"A/B Test PDP" → aktifkan**. App tidak bisa mengaktifkannya sendiri.

### 5. Deploy

```bash
fly launch --no-deploy      # sekali saja
fly secrets set DATABASE_URL=... DIRECT_URL=... SHOPIFY_API_SECRET=...
fly deploy
npm run deploy              # deploy extension + config app ke Shopify
```

---

## PostHog sebagai acuan analisis

Setiap eksperimen dicerminkan ke **PostHog Experiments**: exposure, funnel, dan
`order paid` dikirim dari server (kebal ad-blocker, idempotent lewat outbox), lalu
PostHog menghitung hasilnya dengan mesin Bayesian-nya sendiri. Dashboard
menampilkannya berdampingan dengan perhitungan lokal di panel **Acuan PostHog**.
Desain lengkapnya ada di
[`claudedocs/SPEC-posthog-integration.md`](claudedocs/SPEC-posthog-integration.md).

Env tambahan di Fly.io (dashboard tidak butuh apa pun):

```bash
POSTHOG_PROJECT_TOKEN="phc_..."          # capture event
POSTHOG_PERSONAL_API_KEY="phx_..."       # scope: experiment:read/write, feature_flag:read/write
POSTHOG_PROJECT_ID="613479"
# opsional: POSTHOG_HOST (default https://us.i.posthog.com), POSTHOG_API_HOST (default https://us.posthog.com)
```

Bucketing tetap di storefront — PostHog tidak pernah berada di jalur render.

App embed juga memuat **posthog-js** di storefront (identitas = `_tl_vid`, setiap
event membawa `$feature/<flag>` = variant) sehingga heatmap, session replay, scroll
depth, rage click, dan web vitals bisa dibaca **per variant** di halaman
**Audit lengkap** dashboard (`/experiments/<id>/audit`). Matikan dengan
`POSTHOG_STOREFRONT=0`; replay/heatmap terpisah lewat `POSTHOG_STOREFRONT_REPLAY=0`
dan `POSTHOG_STOREFRONT_HEATMAPS=0`.

## Verifikasi

```bash
npm test        # parity bucketing + sanity check statistik + cek drift dashboard
npm run build

cd dashboard && npx next build && npx eslint .
```

`sync-dashboard.mjs --check` gagal kalau schema atau rumus statistik di dashboard
sudah menyimpang dari sumbernya di sini.

`verify-bucketing-parity.mjs` mengekstrak fungsi hash langsung dari file Liquid dan
membandingkannya dengan implementasi TypeScript pada 20.000 visitor × 5 split.
Kalau keduanya pernah berbeda, variant yang dicatat database bukan variant yang
dilihat visitor — dan itu tidak akan memunculkan error apa pun. Jalankan setiap kali
salah satu implementasi disentuh.

---

## QA di storefront

| Kebutuhan | Cara |
|---|---|
| Lihat halaman tanpa kena bucketing | `?_tl_ab_off=1` |
| Paksa lihat variant B | `?view=ab-b` |
| Cek visitor id & variant | `document.cookie` → `_tl_vid`, `_tl_ab_last` |
| Semua visitor balik ke A seketika | tombol **Kill switch** di halaman eksperimen |

Crawler, Lighthouse, PageSpeed, dan theme editor selalu mendapat variant A —
supaya halaman yang diindeks tetap satu dan angka Core Web Vitals yang dipantau
selalu berasal dari halaman yang sama.

## Sebelum test asli: jalankan A/A test dulu

Buat satu eksperimen dengan `variantBSuffix` yang isinya salinan persis template A,
jalankan 3–5 hari. Kalau muncul SRM, bucket drift, atau selisih conversion rate yang
signifikan padahal kedua halaman identik, berarti ada bug di pipeline — dan itu jauh
lebih baik ketahuan sekarang daripada setelah mengambil keputusan desain.
