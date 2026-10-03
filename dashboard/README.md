# Dashboard Treelogy A/B

Dashboard kontrol dan analitik untuk A/B test halaman produk. Next.js 16 App Router,
deploy ke Vercel, membaca database Neon yang sama dengan app Shopify di Fly.io.

## Kenapa terpisah dari app Shopify

App Shopify di Fly.io memegang satu-satunya hal yang tidak boleh digandakan:
**access token Shopify**. Dashboard ini tidak punya dan tidak boleh punya token itu.

```
Vercel (dashboard ini)              Fly.io (app Shopify)
  │                                   │
  ├─ baca/tulis Neon langsung         ├─ OAuth + access token
  │    semua analitik & pengaturan    ├─ webhook orders/paid
  │                                   ├─ app proxy /apps/tl-ab/collect
  └─ POST /internal/action ─────────► └─ Shopify Admin API
       HMAC-SHA256 + timestamp             • buat templates/product.ab-b.json
       (tolak kalau > 5 menit)             • terbitkan metafield config
```

Aksi yang menyentuh Shopify — menjalankan, menjeda, kill switch, menerbitkan ulang
config — di-relay lewat bridge. Sisanya ditulis langsung ke Neon.

## Menjalankan lokal

```bash
cp .env.example .env.local     # lalu isi nilainya
npm install
npm run create-user -- --email kamu@treelogy.com --name "Nama"
npm run dev
```

### Membuat akun

`create-user` memilih cara membaca password sesuai kondisi:

| Kondisi | Perilaku |
|---|---|
| Terminal sungguhan | prompt tersembunyi + konfirmasi ulang |
| Ada pipe | membaca baris pertama dari stdin |
| `ADMIN_PASSWORD` di env | memakai nilainya (untuk CI) |

Password **tidak** boleh lewat argumen: argumen terlihat di `ps` milik user lain di
mesin yang sama dan tersimpan di riwayat shell. Karena itu jalankan di aplikasi
terminal kamu sendiri, bukan lewat asisten atau CI, supaya yang kamu ketik tidak
pernah tercatat di mana pun:

```bash
cd dashboard
npm run create-user -- --email kamu@treelogy.com --name "Nama"
# Password untuk kamu@treelogy.com: (tidak ditampilkan)
```

Script memuat `.env.local` lewat `--env-file-if-exists`. Untuk menulis ke database
produksi dari lokal, timpa saja variabelnya:

```bash
DATABASE_URL="postgresql://...neon.tech/..." npm run create-user -- \
  --email kamu@treelogy.com --name "Nama" --role admin
```

Migrasi database **tidak** dijalankan dari sini. Skema dimiliki repo root dan
di-migrate saat deploy Fly.io. Kalau keduanya boleh migrate, dua deploy yang
berjalan bersamaan bisa saling menimpa.

## Environment variable

| Variable | Keterangan |
|---|---|
| `DATABASE_URL` | Neon, connection string **pooled** |
| `SESSION_SECRET` | penandatangan cookie sesi, minimal 32 karakter (`openssl rand -base64 48`) |
| `SHOPIFY_APP_URL` | URL app Fly.io, mis. `https://treelogy-ab.fly.dev` |
| `INTERNAL_API_SECRET` | **harus persis sama** dengan nilai di Fly.io, kalau beda semua aksi ditolak 401 |
| `SHOPIFY_SHOP_DOMAIN` | `treelogymoringa.myshopify.com` |

## Deploy ke Vercel

Aplikasi ini ada di subdirektori repo, jadi linknya harus level repo:

```bash
npm i -g vercel
vercel login
vercel link --repo          # WAJIB --repo untuk project di subdirektori
```

Di dashboard Vercel, set **Root Directory** ke `dashboard`. Lalu:

```bash
vercel env add DATABASE_URL production
vercel env add SESSION_SECRET production
vercel env add SHOPIFY_APP_URL production
vercel env add INTERNAL_API_SECRET production
vercel env add SHOPIFY_SHOP_DOMAIN production

vercel --prod
```

Setelah itu buat akun pertama — lihat **Membuat akun** di atas.

## Peran

| Peran | Bisa |
|---|---|
| `admin` | melihat semua, membuat/mengubah, menjalankan, menjeda, kill switch |
| `viewer` | hanya melihat hasil |

Semua aksi yang mengubah storefront tercatat di halaman **Audit** beserta email
pelakunya — itulah alasan login memakai identitas per-orang, bukan passcode bersama.

## Kode yang di-sync, jangan diedit di sini

`lib/stats.ts`, `lib/bucketing.ts`, `lib/results.ts`, dan `prisma/schema.prisma`
dihasilkan dari repo root. Edit sumbernya, lalu dari root jalankan:

```bash
node scripts/sync-dashboard.mjs
```

`npm test` di root gagal kalau keduanya sempat berbeda. Ini bukan formalitas: kalau
rumus statistik di dashboard menyimpang dari yang di app Shopify, dashboard akan
menampilkan angka yang tidak sesuai kenyataan tanpa memunculkan error apa pun.

## Desain

Dark-first. Dua warna data dipakai konsisten dan tidak pernah untuk hal lain:

- **A (kontrol) — biru** `#3B82F6`, garis solid
- **B (variant) — amber** `#F59E0B`, garis putus-putus

Bentuk garis dibedakan supaya warna bukan satu-satunya pembeda. Angka memakai Fira
Code dengan `tabular-nums` agar digit sejajar vertikal dan mudah dibandingkan
antar baris.
