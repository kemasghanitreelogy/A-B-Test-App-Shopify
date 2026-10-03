# SPEC — PostHog sebagai acuan A/B test

Status: diimplementasikan (2026-09-17). Dokumen ini adalah keluaran `/sc:design`
dan sekaligus catatan keputusan untuk `/sc:implement`.

## 1. Tujuan

Menjadikan **PostHog Experiments** sebagai *acuan analisis* eksperimen PDP, tanpa
mengorbankan dua hal yang membentuk seluruh arsitektur app ini:

1. Keputusan A/B diambil di `<head>` storefront tanpa network call (nol flicker,
   nol latency tambahan).
2. Konversi berasal dari webhook `orders/paid`, bukan JavaScript (kebal ad-blocker).

Hasilnya: dua mesin statistik membaca **aliran event yang sama**. Perhitungan
lokal (z-test, posterior Beta, Welch) dan PostHog (Bayesian default) ditampilkan
berdampingan. Sepakat = keputusan lebih kuat; tidak sepakat = pipeline yang harus
diperiksa, bukan desain.

## 2. Keputusan arsitektur

| Keputusan | Pilihan | Alasan |
|---|---|---|
| Siapa yang membagi visitor | **Storefront (FNV-1a)**, bukan PostHog flags | Flag PostHog butuh `/decide` sebelum render → flicker. Pola resmi PostHog untuk ini: *running experiments without feature flags*. |
| Cara PostHog tahu variant | Exposure `$feature_flag_called` dengan `$feature_flag` + `$feature_flag_response`, dan properti `$feature/<flag-key>` di semua event | Persis yang dikirim SDK PostHog sendiri; tidak perlu custom exposure config. Nama event exposure dibaca dari `resolved_exposure_event` (bisa `$experiment_exposure` untuk eksperimen baru). |
| Dari mana event dikirim | **Server (Fly.io)** lewat tabel outbox → `POST /batch/` | Kebal ad-blocker, satu `distinct_id` (`_tl_vid`) untuk exposure dan konversi, `uuid` deterministik → idempotent, `timestamp` = waktu kejadian. |
| Identitas | `distinct_id = _tl_vid`, event **personless** (`$process_person_profile: false`) | Pengunjung anonim; profil person tidak dibutuhkan analisis eksperimen dan event personless jauh lebih murah. `POSTHOG_PERSON_PROFILES=always` untuk mengubah. |
| Siapa memegang kunci | Hanya app Fly.io (`POSTHOG_PERSONAL_API_KEY`) | Konsisten dengan prinsip bridge: dashboard tidak pernah memegang kredensial pihak ketiga. |
| Sumber kebenaran lifecycle | **Lokal**. PostHog dicerminkan setelahnya, kegagalan disimpan di `posthogSyncError` | Start/pause/complete mengubah apa yang dilihat pelanggan; tidak boleh gagal karena PostHog. |
| Mesin statistik PostHog | Default Bayesian (95% credible interval) | Tidak diubah; dashboard menampilkan `chance_to_win` + interval. |

## 3. Aliran data

```
visitor buka /products/x
  └─ head script: bucket lokal → redirect ?view=ab-b (tidak berubah)
      ├─ sendBeacon /apps/tl-ab/collect  {exposure, product_viewed, add_to_cart}
      └─ (opsional) posthog-js: register $feature/<key>; capture $feature_flag_called
           HANYA jika posthog.get_distinct_id() === _tl_vid

/proxy/collect  (Fly)
  └─ satu transaksi Postgres:
       Event + Assignment (seperti sebelumnya)
       + PostHogOutbox rows  (uuid = uuid5(dedupeKey))
  └─ kickDrain(): POST {POSTHOG_HOST}/batch/ → sentAt

webhook orders/paid → Conversion (sumber kebenaran) → outbox "order paid" {revenue}
webhook orders/cancelled → outbox "order cancelled"
webhook refunds/create   → outbox "order refunded" {refund_amount}

lifecycle lokal (start/pause/complete)
  └─ mirrorTransition(): Experiments API
       draft→launch | paused→resume | stopped→reset+launch | running→pause | →end

dashboard (Vercel) ── bridge HMAC ──▶ /internal/action posthog.status
  └─ GET experiments/:id/  +  GET experiments/:id/metrics_recalculation/latest/
  └─ parseRecalculation() → panel "Acuan PostHog"
```

## 4. Skema

### 4.1 Prisma (`prisma/schema.prisma`)

`Experiment` mendapat kolom tautan: `posthogExperimentId`, `posthogFeatureFlagKey`
(unique), `posthogFeatureFlagId`, `posthogExposureEvent`, `posthogSyncedAt`,
`posthogSyncError`.

`PostHogOutbox` baru: `uuid` (unique, deterministik), `distinctId`, `event`,
`properties` (jsonb), `occurredAt`, `attempts`, `nextAttemptAt`, `sentAt`,
`lastError`. Indeks `(sentAt, nextAttemptAt, id)` untuk drain.

Migrasi: `prisma/migrations/20260917090000_posthog_integration`.

### 4.2 Taksonomi event PostHog (`app/lib/posthog/taxonomy.ts`)

Flag key: `tl-ab-<experimentId>`. Variant key: `A → control`, `B → test`.

| Event PostHog | Sumber | Properti khusus | Dipakai metric |
|---|---|---|---|
| `$feature_flag_called` (atau `resolved_exposure_event`) | proxy.collect `exposure` | `$feature_flag`, `$feature_flag_response`, `product_id` | exposure (langkah 0 semua funnel) |
| `product viewed` | storefront | `product_id` | — |
| `product added to cart` | storefront | `product_id` | Add-to-cart rate |
| `checkout started` | web pixel | — | guardrail Checkout started rate |
| `checkout completed` | web pixel | — | — (diagnosis funnel) |
| `order paid` | webhook orders/paid | `order_id`, `revenue`, `currency`, `financial_status` | CVR, RPV, AOV |
| `order cancelled` | webhook | `order_id` | — |
| `order refunded` | webhook | `order_id`, `refund_amount`, `currency` | guardrail Refund rate |
| `bucket drift detected` | proxy.collect | `client_variant`, `server_variant` | guardrail pipeline |

Properti umum di semua event: `$feature/<flag-key>`, `experiment_id`,
`experiment_name`, `variant` (A/B), `source` (storefront | web_pixel | webhook),
`shop`, `$process_person_profile`, `$lib`, `$lib_version`.

### 4.3 Metric PostHog (`app/lib/posthog/metrics.ts`)

uuid metric deterministik: `uuid5("tl-ab:<experimentId>:metric:<key>")`, supaya
hasil bisa dipetakan balik ke key lokal tanpa mencocokkan nama.

| Key lokal | PostHog `metric_type` | Definisi |
|---|---|---|
| `cvr` | funnel | exposure → `order paid` |
| `atc_rate` | funnel | exposure → `product added to cart` |
| `rpv` | mean | `sum(order paid.revenue)` per pengunjung terpapar |
| `aov` | ratio | `sum(order paid.revenue)` / `count(order paid)` |
| `checkout_rate` | funnel (guardrail) | exposure → `checkout started` |
| `refund_rate` | funnel (guardrail, goal decrease) | exposure → `order refunded` |

`primaryMetric` lokal = satu-satunya **primary** di PostHog; sisanya secondary.
`allow_unknown_events: true` dipakai saat membuat eksperimen karena event baru
masuk setelah eksperimen pertama berjalan.

### 4.4 Perbedaan yang disengaja antara lokal dan PostHog

| Hal | Lokal | PostHog |
|---|---|---|
| Revenue | bersih (dikurangi refund, order batal dikeluarkan) | kotor (`order paid`); refund/batal jadi event guardrail |
| Denominator | semua Assignment | pengunjung dengan exposure event; yang terpapar dua variant **dikecualikan** |
| Uji | frequentist + P(B>A) posterior Beta | Bayesian, `chance_to_win`, credible interval relatif |
| Syarat simpul | ≥14 hari, sample size, tanpa SRM/drift | PostHog tidak menerapkan gate ini — gate lokal tetap berlaku |

Selisih pengunjung terpapar lokal vs PostHog ditampilkan di panel (rasio per
variant). Rasio yang jauh dari 100% = outbox tertinggal atau exclusion PostHog.

## 5. Kontrak API

### 5.1 Bridge (`/internal/action`, HMAC)

| action | input | output |
|---|---|---|
| `posthog.status` | `experimentId` | `{ ok, posthog: PostHogStatus }` |
| `posthog.sync` | `experimentId` | mencerminkan lifecycle sesuai status lokal + drain outbox; `{ ok, posthog, sent }` |
| `posthog.recalculate` | `experimentId` | drain outbox lalu `POST metrics_recalculation/`; `{ ok, sent }` |

`PostHogStatus` dan `PostHogResults` didefinisikan di `app/lib/posthog/results.ts`
(disalin ke `dashboard/lib/posthog-results.ts` oleh `sync-dashboard.mjs`).

### 5.2 PostHog Experiments API (dari Fly)

Base `POSTHOG_API_HOST` (default `https://us.posthog.com`), header
`Authorization: Bearer <personal api key>`.

- `POST /api/projects/:pid/experiments/` — buat draft + flag + metric
- `GET  /api/projects/:pid/experiments/:id/` — status, `resolved_exposure_event`
- `POST .../launch/ | pause/ | resume/ | end/ | reset/`
- `POST .../metrics_recalculation/` — minta hitung ulang (`{trigger:"manual"}`)
- `GET  .../metrics_recalculation/latest/` — hasil terakhir:
  `{ status, completed_at, query_to, results:[{ metric_uuid, status, error_message, result:{ baseline, variant_results[] } }] }`
  dengan `baseline/variant_results` berbentuk `ExperimentStatsBase` /
  `ExperimentVariantResult{Bayesian,Frequentist}` (posthog/schema.py).

### 5.3 PostHog capture (dari Fly)

`POST {POSTHOG_HOST}/batch/` body `{ api_key, batch:[{ uuid, event, distinct_id, timestamp, properties }] }`.

## 6. Environment (app Fly.io)

| Var | Wajib | Keterangan |
|---|---|---|
| `POSTHOG_PROJECT_TOKEN` | ya (capture) | token project `phc_…` |
| `POSTHOG_HOST` | tidak | default `https://us.i.posthog.com` |
| `POSTHOG_PERSONAL_API_KEY` | ya (cermin eksperimen) | scope: `experiment:read`, `experiment:write`, `feature_flag:read`, `feature_flag:write` |
| `POSTHOG_PROJECT_ID` | ya (cermin eksperimen) | `613479` untuk project "Default project" org Treelogy |
| `POSTHOG_API_HOST` | tidak | default `https://us.posthog.com` |
| `POSTHOG_PERSON_PROFILES` | tidak | `always` → event identified (lebih mahal) |
| `POSTHOG_STOREFRONT` | tidak | `0` mematikan posthog-js di storefront (default aktif bila token ada) |
| `POSTHOG_STOREFRONT_REPLAY` | tidak | `0` mematikan session replay |
| `POSTHOG_STOREFRONT_HEATMAPS` | tidak | `0` mematikan pengumpulan heatmap |

Tanpa `POSTHOG_PROJECT_TOKEN`: tidak ada baris outbox yang ditulis. Tanpa
personal key: event tetap terkirim, tapi eksperimen PostHog harus dibuat manual
dengan flag key `tl-ab-<id>` (panel dashboard menjelaskan ini).

Dashboard tidak butuh env baru.

## 7. Runbook

1. Buat personal API key di PostHog (Settings → Personal API keys) dengan scope di
   atas; `fly secrets set POSTHOG_PROJECT_TOKEN=… POSTHOG_PERSONAL_API_KEY=… POSTHOG_PROJECT_ID=613479`.
2. `fly deploy` (migrasi jalan lewat `release_command`). `npm run deploy` untuk
   extension (config storefront kini membawa `k` = flag key).
3. Jalankan eksperimen dari dashboard. Panel "Acuan PostHog" menampilkan status
   `running` dan tautan ke PostHog. Kalau ada `posthogSyncError`, perbaiki lalu
   **Sinkronkan**.
4. A/A test dulu (lihat README). Di PostHog, eksperimen A/A yang "signifikan"
   sama artinya dengan bug pipeline.
5. Hasil PostHog dihitung terjadwal; **Hitung ulang di PostHog** memaksa
   perhitungan setelah mengosongkan outbox.

## 8. Verifikasi

- `npm test` → `scripts/verify-posthog.mjs`: uuid v5 (dicocokkan dengan
  `uuid.uuid5` Python), paritas literal storefront (`control`/`test`, `$feature/`,
  `$feature_flag_called`, penjagaan identitas), bentuk metric, pembaca hasil
  terhadap payload berbentuk upstream, dan `sync-dashboard --check`.
- Setelah deploy: di PostHog, Data management → Events harus memunculkan
  `$feature_flag_called` dan `product viewed` dalam beberapa menit setelah
  pengunjung pertama; `order paid` setelah order pertama dibayar.

## 9. Analitik perilaku, heatmap, dan replay per variant (tahap 2)

Ditambahkan 2026-09-17 sore, setelah cermin eksperimen berjalan.

### 9.1 posthog-js di storefront

App embed memuat posthog-js sendiri (bukan snippet manual di theme), dari
`tl-ab-core.liquid`, hanya kalau config storefront membawa `ph` (env
`POSTHOG_STOREFRONT` tidak `0`). Aturan yang dipegang:

- Dimuat **setelah** keputusan redirect dan **setelah** guard bot/consent/theme
  editor — halaman yang akan ditinggalkan tidak memuat apa pun.
- `bootstrap.distinctID = _tl_vid` → event browser dan server jatuh ke person
  yang sama. `person_profiles: identified_only` → tetap personless.
- `capture_pageview: false`, lalu `register({ "$feature/<flag>": variant })`
  **sebelum** `capture("$pageview")` manual — pageview pertama pun sudah
  membawa variant, jadi heatmap/replay halaman pendaratan terpisah per variant.
- Autocapture, dead click, pageleave (scroll depth), web vitals, heatmap
  (`POSTHOG_STOREFRONT_HEATMAPS`), session replay dengan `maskAllInputs`
  (`POSTHOG_STOREFRONT_REPLAY`). Sampling replay diatur di project settings PostHog.

### 9.2 Bridge baru

| action | input | output |
|---|---|---|
| `posthog.analytics` | `experimentId` | `PostHogAnalytics`: engagement per variant (pageview, sesi, bounce, durasi, scroll, klik, rage/dead click, LCP/INP/CLS p75), breakdown device & negara, harian, 40 replay terparah, halaman produk teramai |
| `posthog.heatmap` | `experimentId`, `params: { path, type: click\|rageclick\|mousemove\|scrolldepth, viewport: mobile\|tablet\|desktop }` | `PostHogHeatmap`: titik `(relX, y, count)` atau bucket scroll per variant |

Semua lewat HogQL (`POST /api/projects/:pid/query/`) atas tabel `events`,
`heatmaps`, `raw_session_replay_events`, dan properti `session.*` — setiap
query diverifikasi live saat ditulis (`app/lib/posthog/analytics.server.ts`).
Variant ditentukan dari `$feature/<flag>` pada session, **bukan URL**, sehingga
heatmap variant B tetap benar walau `?view=` hilang.

### 9.3 Halaman audit dashboard

`/experiments/[id]/audit`: keputusan, tabel konversi per variant (server), tabel
perilaku per variant (browser), grafik harian, **heatmap A vs B** digambar
sendiri di atas snapshot halaman (`/api/snapshot`) dengan ramp biru→merah dan
mode scroll depth, breakdown device/negara, dan daftar replay per variant
(tautan ke pemutar PostHog). Sumber server dan browser sengaja dipisah secara
visual: yang pertama menentukan pemenang, yang kedua menjelaskan alasannya.

## 9.4 Bug yang ditemukan saat verifikasi live (2026-09-17)

Skrip `<head>` **tidak pernah berjalan di produksi** sebelum hari ini. Shopify
membungkus isi `{% render 'tl-ab-core' %}` dengan komentar HTML
`<!-- BEGIN app snippet: tl-ab-core -->` **di dalam** tag `<script>`. Di
JavaScript, `<!--` di awal baris adalah komentar satu baris (HTML-like comment),
sehingga pembuka `/*` di baris pertama file ikut tertelan dan seluruh skrip gagal
parse — tanpa error apa pun yang sampai ke dashboard. Perbaikan: file dimulai
dengan baris kosong dan `;`. `scripts/verify-head-script.mjs` kini mem-parse
skrip persis seperti yang dibungkus Shopify, jadi regresi ini tidak bisa lolos
lagi.

## 9.5 Audit pra-live 17 September 2026

Seluruh jalur diuji end-to-end dengan eksperimen uji sungguhan (dibuat lalu
dihapus): App Proxy ber-tanda-tangan Shopify, webhook `orders/paid`
ber-tanda-tangan, outbox, dan pembacaan balik. Hasil: event sampai di PostHog
dengan properti yang benar, kiriman ulang idempoten, dan `resolved_exposure_event`
untuk eksperimen baru ternyata **`$experiment_exposure`**, bukan
`$feature_flag_called`.

Tujuh cacat ditemukan dan diperbaiki:

| # | Cacat | Akibat kalau dibiarkan |
|---|---|---|
| 1 | Skrip `<head>` tertelan komentar app snippet Shopify | Seluruh A/B test tidak pernah berjalan (§9.4) |
| 2 | Browser mengirim exposure dengan nama `$feature_flag_called` hardcoded | Nama salah tidak ditolak PostHog, hanya tidak pernah dihitung. Exposure ganda/percuma. Kini exposure **hanya** dari server. |
| 3 | Sinkronisasi PostHog terjadi **setelah** config storefront terbit | Exposure pertama bisa terkirim sebelum nama event diketahui. Diurutkan ulang + `repairPendingExposureNames()` membetulkan baris outbox yang belum berangkat. |
| 4 | Dua mesin Fly bisa mengirim baris outbox yang sama | Order terhitung dua kali. Kini klaim atomik `FOR UPDATE SKIP LOCKED`. |
| 5 | `$prev_pageview_max_scroll_percentage` dibaca sebagai 0–100 | Kedalaman scroll selalu tampil 0%. Nilainya pecahan 0–1. |
| 6 | Heatmap scrolldepth menghitung per baris | PostHog menulis banyak baris per sesi (terverifikasi sampai 7). Satu sesi terhitung di banyak bucket. Kini `max(y)` per sesi dulu. |
| 7 | Heatmap mencocokkan URL dengan `LIKE`, `$dead_swipe` tidak dihitung | Halaman `/id/...` (±84% trafik) tercampur dengan versi Inggris walau tinggi halamannya berbeda; sinyal frustrasi utama di toko mobile hilang. Kini cocok per pathname persis + `$dead_swipe` ikut. |

Pemeriksaan ulang setelah perbaikan menemukan tiga lagi:

| # | Cacat | Akibat kalau dibiarkan |
|---|---|---|
| 8 | Query analitik & heatmap tidak punya batas AKHIR | Eksperimen yang sudah ditutup terus menyerap data baru tiap kali halaman audit dibuka. Angkanya berubah sendiri berhari-hari setelah keputusan diambil, dan dua orang yang membuka halaman yang sama di hari berbeda melihat hasil berbeda. Kini dibatasi `windowOf()` memakai `endedAt`. |
| 9 | Properti `$feature/` tertinggal di browser setelah eksperimen berakhir | posthog-js menyimpan properti terdaftar sampai dihapus. Tanpa pembersihan, setiap event pengunjung itu terus membawa penanda eksperimen mati — payload membengkak dan audit test lama ikut tercemar. Kini daftarnya dicatat di `localStorage` lalu dibandingkan dengan config yang berlaku; yang sudah tidak ada dicabut dengan `unregister()`. |
| 10 | Loader posthog-js menyisipkan `<script>` SEBELUM mendaftarkan antrean method | Kalau penyisipan gagal (CSP ketat, ekstensi pemblokir, DOM belum siap), antrean tidak pernah terbentuk dan pemanggilan berikutnya melempar error yang membatalkan sisa skrip A/B — termasuk penandaan keranjang. Urutannya dibalik, dan penyisipan dibungkus try/catch. |

Selain itu kill switch kini menghentikan pembagian variant **tanpa** mematikan
posthog-js — saat kill switch ditekan justru replay dan heatmap paling dibutuhkan.

Angka dasar toko yang mengubah keputusan desain: **100% trafik heatmap mobile**,
**±84% pageview berbahasa Indonesia** (`/id/...`), **kedalaman scroll rata-rata
±15%**. Ketiganya masuk ke `claudedocs/panduan-preview-theme-variant-b.md` §11.

## 9.6 Web pixel tidak pernah aktif (ditemukan 18 September 2026)

Di Shopify Admin → Settings → Customer events, pixel **A/B Test Treelogy**
tampil dengan titik kosong (abu-abu), bukan hijau seperti pixel lain.

Sebabnya: **men-deploy web pixel extension hanya membuatnya MUNCUL di daftar.**
Ia tidak berjalan sampai app membuat record-nya lewat mutasi `webPixelCreate`.
App ini tidak pernah memanggilnya — tidak ada satu baris pun yang menyebut
`webPixel` di seluruh kode.

Akibatnya `extensions/tl-ab-pixel/src/index.js` tidak pernah dieksekusi pada satu
pengunjung pun, sehingga `checkout started` dan `checkout completed` tidak pernah
terkirim. Gejalanya: baris **"Mulai checkout"** pada funnel selamanya nol, dan
metric guardrail *Checkout started rate* di PostHog selalu kosong — terlihat
persis seperti test yang memang belum ada yang checkout.

Konversi, revenue, dan exposure **tidak terpengaruh**: ketiganya datang dari
webhook `orders/paid` dan app embed di `<head>`, bukan dari pixel.

Perbaikan (`app/lib/pixel.server.ts`):

- `ensureWebPixel(admin)` — idempoten: membuat kalau belum ada, memperbarui kalau
  settings berubah, diam kalau sudah benar. `"sudah ada"` diperlakukan sebagai
  sukses, bukan kegagalan.
- Dipanggil otomatis saat eksperimen dijalankan, dan tersedia sebagai aksi bridge
  `pixel.ensure`.
- `readWebPixel(admin)` — hanya membaca, dipakai halaman eksperimen (yang dibuka
  berkali-kali) supaya tidak ada efek samping tiap render.
- Halaman eksperimen menampilkan peringatan beserta tombol **Aktifkan web pixel**
  kalau pixel mati atau settings-nya tidak cocok.

Terverifikasi di toko: pixel dibuat (`gid://shopify/WebPixel/2697527484`), dan
panggilan kedua mengembalikan `unchanged`. Scope `write_pixels` yang sudah ada
ternyata cukup — `read_pixels` tidak perlu ditambahkan.

## 10. Di luar cakupan (sengaja)

- Memutar session replay di dalam dashboard: pemutar PostHog butuh token berbagi
  per rekaman, jadi replay dibuka di PostHog.
- Ship variant / rollout lewat flag PostHog: variant B diterapkan permanen dengan
  mengganti template Shopify, bukan lewat flag.
