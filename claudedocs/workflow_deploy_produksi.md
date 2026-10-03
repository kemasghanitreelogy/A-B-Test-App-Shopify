# Workflow — Deploy Produksi 3 Platform

Tanggal: 2026-09-03 · Toko: `treelogymoringa.myshopify.com` (treelogy.com)

---

## 0. Status awal terverifikasi

| Platform | Status | Catatan |
|---|---|---|
| **Neon** | ✅ siap | project `twilight-mouse-38711040`, PG18, `aws-ap-southeast-1`, migrasi `init` sudah jalan |
| **Fly.io** | ✅ login `kemas@treelogy.com` | org personal "Kemas Treelogy"; belum ada app sama sekali |
| **Vercel** | ✅ login `kemasghanitreelogy` | 8 project lain sudah ada; belum ada untuk A/B test |
| **Shopify CLI** | ⚠ ter-logout | perlu login ulang saat deploy |
| Nama `treelogy-ab.fly.dev` | ✅ tersedia | DNS belum resolve |

---

## 1. Blocker yang harus dibereskan SEBELUM deploy pertama

Ketiganya ditemukan saat memeriksa artefak deploy, bukan setelah gagal di produksi.

### 1.1 Dockerfile template akan gagal build ⛔

```dockerfile
RUN npm ci --omit=dev     # vite TIDAK ikut terpasang
COPY . .
RUN npm run build         # react-router build BUTUH vite -> gagal
```

`vite` ada di `devDependencies`, dan `@react-router/dev` hanya menyebutnya sebagai
*peer* dependency — bukan dependency langsung. Jadi `--omit=dev` membuat build
kehilangan bundler-nya sendiri.

**Perbaikan:** multi-stage build — pasang semua dependency, build, baru `npm prune
--omit=dev`. Image akhir tetap ramping tanpa mengorbankan proses build.

### 1.2 `.env` ikut masuk ke dalam image ⛔ (kebocoran secret)

`.dockerignore` tidak menyebut `.env`, padahal Dockerfile melakukan `COPY . .`.
Artinya `ADMIN_API_KEY`, `SHOPIFY_API_SECRET`, `INTERNAL_API_SECRET`, dan seluruh
connection string Neon ikut terpanggang ke dalam layer image — dan layer tidak bisa
dihapus belakangan, siapa pun yang bisa menarik image itu bisa membacanya.

**Perbaikan:** tambahkan `.env` dan `.env.*` ke `.dockerignore`. Secret masuk lewat
`fly secrets`, yang disimpan terenkripsi dan diberikan sebagai env saat runtime.

### 1.3 Migrasi dijalankan dua kali

`fly.toml` sudah punya `release_command = "npx prisma migrate deploy"`, tapi
`docker-start` juga menjalankan `prisma migrate deploy` di tiap start container.
Saat rolling deploy dengan lebih dari satu mesin, dua proses migrasi bisa berjalan
bersamaan pada database yang sama.

**Perbaikan:** migrasi hanya di `release_command` — Fly menjalankannya sekali di
mesin sementara, dan **membatalkan deploy kalau gagal**, yang justru perilaku yang
diinginkan. Container start cukup `npm run start`.

---

## 2. Urutan deploy (dependensi searah, tidak boleh dibolak-balik)

```
Neon (selesai)
   │
   ▼
① Fly.io  ─── menghasilkan URL produksi ──┐
   │                                       │
   ▼                                       │
② Shopify Partners                         │
   application_url + redirect_urls         │
   menunjuk ke URL Fly                     │
   theme app extension + web pixel         │
                                           ▼
                            ③ Vercel (SHOPIFY_APP_URL = URL Fly)
                                           │
                                           ▼
                            ④ Verifikasi lintas platform
```

Alasan urutannya begini: Shopify butuh URL Fly untuk OAuth callback, dan Vercel butuh
URL Fly untuk bridge. Kalau Vercel dideploy duluan, ia akan menyimpan URL yang belum ada.

---

## 3. Peta secret

Satu nilai dipakai di dua tempat dan **harus identik**, kalau tidak semua tombol aksi
di dashboard ditolak 401:

```
INTERNAL_API_SECRET ──┬──► Fly    (memverifikasi signature yang masuk)
                      └──► Vercel (menandatangani request keluar)
```

| Secret | Fly | Vercel | Sumber |
|---|---|---|---|
| `DATABASE_URL` | ✓ pooled | ✓ pooled | Neon CLI |
| `DIRECT_URL` | ✓ direct | — | hanya untuk `prisma migrate` |
| `SHOPIFY_API_SECRET` | ✓ | — | Partners |
| `INTERNAL_API_SECRET` | ✓ | ✓ | **sama persis** |
| `SESSION_SECRET` | — | ✓ | khusus cookie dashboard |
| `SHOPIFY_APP_URL` | ✓ | ✓ | hasil langkah ① |

Tidak ada satu pun yang boleh masuk ke git atau ke layer image.

---

## 4. Titik rollback

| Kalau gagal di | Dampak ke pengunjung toko | Cara mundur |
|---|---|---|
| Fly build | nol — belum ada yang berubah di storefront | perbaiki, deploy ulang |
| Fly release (migrasi) | nol — Fly membatalkan deploy otomatis | migrasi tidak diterapkan sebagian |
| `shopify app deploy` | **nyata** — mengubah URL app yang sudah ada di Partners | `shopify app versions list` lalu release versi sebelumnya |
| App embed diaktifkan | **nyata** — script mulai jalan di storefront | matikan app embed di theme editor |
| Eksperimen dijalankan | **nyata** — pengunjung mulai melihat desain B | tombol Kill switch |
| Vercel | nol — hanya UI internal | `vercel rollback` |

Sampai app embed diaktifkan **dan** ada eksperimen berstatus `running`, tidak ada satu
pun pengunjung toko yang terpengaruh. Seluruh deploy di bawah ini berhenti sebelum titik itu.

⚠ `shopify app deploy` menimpa `application_url` app yang sudah ada (client_id
`f4afe79d…`). Konfigurasi lamanya harus dibaca dulu lewat `shopify app config link`
sebelum ditimpa — kalau app itu ternyata sedang dipakai untuk hal lain, deploy harus
dibatalkan dan dibuatkan app baru.

---

## 5. Langkah eksekusi

### ① Fly.io
1. Perbaiki `Dockerfile`, `.dockerignore`, dan script `docker-start`
2. `fly launch --no-deploy --name treelogy-ab --region sin --org personal`
3. `fly secrets set` untuk 5 variabel
4. `fly deploy` — release command menjalankan migrasi
5. **Checkpoint:** `curl https://treelogy-ab.fly.dev/` membalas, dan
   `/internal/action` tanpa signature membalas **401** (bukan 500 atau 200)

### ② Shopify
1. `shopify auth login`
2. `shopify app config link` — **baca dulu** konfigurasi app yang ada
3. Bandingkan `application_url` lama vs baru; hentikan kalau mencurigakan
4. `shopify app deploy` — config + theme app extension + web pixel
5. **Checkpoint:** extension muncul di Partners; app embed **belum** diaktifkan

### ③ Vercel
1. `vercel link --repo` (wajib `--repo` untuk project di subdirektori)
2. Set Root Directory = `dashboard`
3. `vercel env add` untuk 5 variabel di environment production
4. `vercel deploy --prod`
5. **Checkpoint:** `/login` HTTP 200, `/` mengembalikan 307 ke `/login`

### ④ Verifikasi lintas platform
1. Login dashboard produksi
2. Buat eksperimen **draft** (belum dijalankan)
3. Tekan "Terbitkan ulang config" → membuktikan rantai
   Vercel → HMAC → Fly → Shopify Admin API benar-benar tersambung
4. **Checkpoint:** muncul toast sukses, dan barisnya tercatat di halaman Audit

Setelah ini sistem siap, tapi belum menyentuh satu pun pengunjung. Mengaktifkan app
embed dan menjalankan A/A test adalah keputusan terpisah.


---

## 6. Hasil eksekusi — 2026-09-03

| Platform | Status | URL / referensi |
|---|---|---|
| Neon | ✅ | `twilight-mouse-38711040`, PG18, migrasi `init` |
| Fly.io | ✅ | https://treelogy-ab.fly.dev — region `sin`, image 128 MB |
| Shopify | ✅ | versi `treelogy-ab-test-4`, app "A/B Test Treelogy" |
| Vercel | ✅ | https://treelogy-ab-dashboard.vercel.app |

### Masalah yang ditemukan saat eksekusi

| # | Masalah | Perbaikan |
|---|---|---|
| 1 | Dockerfile template gagal build — `vite` hanya peer dependency | multi-stage: install lengkap, build, lalu `npm prune --omit=dev` |
| 2 | `.env` ikut ter-COPY ke layer image | tambahkan `.env` dan `.env.*` ke `.dockerignore` |
| 3 | Migrasi jalan dua kali (release_command + container start) | hanya di `release_command` |
| 4 | Fly gagal alokasi IP otomatis (bug flyctl v0.4.38 vs API) | `fly ips allocate-v4 --shared` dan `allocate-v6` manual |
| 5 | `@shopify/web-pixels-extension` belum ter-install | `npm install` di root (extension adalah npm workspace) |
| 6 | LiquidHTMLSyntaxError — theme check membaca `i < 16` sebagai tag HTML | semua perbandingan ditulis terbalik `b > a`; parity hash diverifikasi ulang tetap 0 mismatch |

### Scope Shopify dipersempit

Sebelum: 19 scope, termasuk `read_customers`, `read_customer_payment_methods`,
`write_metaobjects`, `read_analytics` — tidak satu pun dipakai kode ini.

Sesudah: 6 scope, masing-masing diverifikasi ke dokumentasi resmi.

| Scope | Untuk | Sumber |
|---|---|---|
| `read_themes`, `write_themes` | `themeFilesUpsert` membuat `product.ab-b.json` | doc mutation menyebut `write_themes` |
| `read_orders` | payload webhook `orders/paid` | — |
| `read_products` | resource picker produk/collection | — |
| `write_pixels`, `read_customer_events` | `webPixelCreate` | doc mutation menyebut keduanya |

`metafieldsSet` untuk app-data metafield tidak butuh scope tambahan — dokumentasinya
menyatakan syaratnya adalah "akses yang sama dengan memutasi resource pemiliknya",
dan pemiliknya adalah instalasi app itu sendiri.

### Belum dilakukan (perlu tindakan manusia)

1. **Install app ke toko** lewat OAuth — butuh persetujuan scope di browser.
   Tanpa ini `Session` kosong dan bridge belum punya access token.
2. Approve protected customer data di Admin → Settings → Apps → API access.
3. Aktifkan app embed di theme editor.
4. Jalankan A/A test.

Sampai langkah 3 dan 4 dilakukan, **tidak ada satu pun pengunjung toko yang terpengaruh**.
