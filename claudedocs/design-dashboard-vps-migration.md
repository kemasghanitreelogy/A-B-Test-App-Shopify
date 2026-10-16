# Desain: migrasi penuh dashboard dari Vercel ke VPS

Status: **draft, menunggu approval** · 2026-10-16

## 1. Tujuan dan batasan

| | |
|---|---|
| Tujuan | Dashboard Next.js (`dashboard/`) jalan di `treelogy-vps`, di samping app Shopify. **Tidak ada satu pun yang tersisa di Vercel** (deployment, env, project, git integration). |
| Wajib | Tanpa downtime saat deploy, ada rollback tanpa build ulang, rahasia yang pernah ada di Vercel dirotasi, tidak mengganggu layanan lain di box ini. |
| Batasan | VPS 4 vCPU / 3,8 GB RAM + 2 GB swap, dipakai bersama Treelogy API (:3000), combined-discount (:3100), layanan :3200, redis. Tidak ada IPv6. |
| Di luar scope | Mengubah skema DB, logika dashboard, atau pola bridge HMAC. |

Kondisi sekarang (dicek 2026-10-16): app live di slot :3301 (rilis `657ad67`), RAM tersedia ±3,0 GB.
Kode dashboard tidak memakai fitur khusus Vercel (tidak ada `vercel.json`, cron, edge runtime,
`@vercel/*`), jadi ini murni pindah hosting, bukan rewrite.

## 2. Arsitektur target

```
                         ┌───────────────────────── treelogy-vps ─────────────────────────┐
Shopify / storefront ─┐  │                                                                 │
                      ├──┼─▶ nginx :443 ─┬─ ab.treelogy-services.my.id ──▶ :3300 | :3301   │
Tim (browser) ────────┘  │   (TLS, HSTS, │      app Shopify (blue/green)    ▲              │
                         │   rate limit) │                                  │ /internal/   │
                         │               └─ dash.treelogy-services.my.id ─▶ :3310 | :3311  │
                         │                      dashboard Next.js (blue/green)              │
                         └──────────────────────────────┬──────────────────────────────────┘
                                                        │ TLS
                              Supabase Postgres (schema treelogy_ab, role treelogy_ab)
                              app → session pooler :5432 · dashboard → transaction pooler :6543
```

Keputusan utama:

| # | Keputusan | Alasan | Alternatif yang ditolak |
|---|---|---|---|
| D1 | Subdomain sendiri `dash.treelogy-services.my.id` | Cookie sesi, CSP, dan log terpisah dari app embedded; app memakai `/` sendiri | Path `/dashboard` di domain app: butuh `basePath`, bentrok dengan routing app dan header CSP `frame-ancestors` milik Shopify |
| D2 | Proses terpisah, user systemd terpisah (`treelogy-ab-dash`) | Dashboard tidak boleh bisa membaca access token Shopify (prinsip yang sudah ada di `lib/bridge.ts`) — isolasi sekarang dijaga OS, bukan lagi beda platform | Satu proses / satu user: kebocoran di dashboard = token Shopify ikut bocor |
| D3 | Blue/green yang sama dengan app (slot :3310/:3311) | Pola sudah teruji di box ini; zero-downtime, rollback instan | `pm2 reload`: tidak ada health gate sebelum traffic pindah |
| D4 | Satu perintah deploy untuk kedua komponen, **satu git SHA** | `lib/stats.ts` dkk. disalin dari root (`sync-dashboard.mjs`); deploy dari SHA yang sama menjamin rumus statistik app dan dashboard identik | Pipeline terpisah: bisa drift diam-diam |
| D5 | Next `output: "standalone"` | Rilis kecil (`node server.js`), tidak bawa `node_modules` dev | `next start` biasa: rilis ratusan MB per versi × 5 rilis disimpan |
| D6 | Bridge tetap lewat `https://ab.treelogy-services.my.id/internal/action`, **ditambah** nginx hanya mengizinkan `/internal/` dari IP box sendiri | Defense in depth: HMAC tetap, tapi endpoint tidak lagi bisa diserang dari internet | Panggil `127.0.0.1:330x` langsung: dashboard harus tahu slot mana yang live |

## 3. Komponen

### 3.1 Runtime (systemd `treelogy-ab-dash@.service`)

- Instance = port (3310/3311), `WorkingDirectory=/opt/treelogy-ab-dash/slots/%i`,
  `ExecStart=/usr/bin/node server.js`, `HOSTNAME=127.0.0.1`, `PORT=%i`.
- `EnvironmentFile=/etc/treelogy-ab-dash/env` (root:treelogy-ab-dash, 640).
- Hardening sama dengan unit app (`ProtectSystem=strict`, `NoNewPrivileges`, dst.), **plus**
  `ReadWritePaths=/opt/treelogy-ab-dash/releases` karena Next menulis data cache
  (`fetch(..., { next: { revalidate: 600 } })` di `lib/drawer-snapshot.ts`) ke `.next/cache`.
- `MemoryHigh=512M`, `MemoryMax=640M` → kalau bocor, yang mati dashboard, bukan layanan Treelogy.

### 3.2 Build dan deploy

`deploy.sh` diubah menjadi berbasis komponen, logika blue/green tidak diubah:

```
treelogy-ab-deploy [all|app|dash] [git-ref]   # default: all main
treelogy-ab-deploy rollback [app|dash]
treelogy-ab-deploy restart  [app|dash]
treelogy-ab-deploy status
```

Urutan `all`: fetch → archive SHA ke rilis → build app → build dashboard (**berurutan**, bukan
paralel: next build ±1–1,5 GB, dua build sekaligus bisa bikin layanan lain di-OOM kill) →
`prisma migrate deploy` (hanya dari app, seperti sekarang) → go-live app → go-live dashboard.
Kedua build selesai dulu sebelum apa pun live — build yang gagal tidak mengubah apa pun. Kalau
dashboard gagal saat go-live (health/smoke), app tetap di rilis baru (backward compatible) dan
dashboard tetap di rilis lama.

Health gate dashboard: route baru `GET /api/healthz` (menyentuh DB, diblokir dari publik di nginx
seperti `/healthz` app) + smoke `GET /login` = 200.

**Version skew saat switch** (masalah yang di Vercel ditangani otomatis oleh Skew Protection):
- `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` tetap di env → Server Action dari tab yang dibuka sebelum
  deploy tetap bisa didekripsi rilis baru.
- `deploymentId` di `next.config.ts` diisi dari SHA → klien lama melakukan hard reload, bukan
  error "Failed to find Server Action". *(Nama dan perilaku opsi ini dicek ke docs Next 16 saat implementasi.)*

### 3.3 Edge (nginx `dash.treelogy-services.my.id`)

- TLS Let's Encrypt lewat `bootstrap.sh tls` (sudah generik, tinggal diparametrisasi per domain).
- Header: HSTS, `nosniff`, `Referrer-Policy`, **`X-Frame-Options: DENY`** (dashboard tidak di-embed,
  beda dengan app).
- `limit_req` untuk `POST /login` (mis. 5/menit per IP, burst 5). Vercel dulu punya proteksi bawaan;
  sekarang tanggung jawab kita, dan scrypt di `lib/password.ts` sengaja mahal di CPU.
- `/_next/static/` di-cache `immutable`.
- Vhost app ditambah `location /internal/ { allow 127.0.0.1; allow 203.145.35.26; deny all; ... }`.

### 3.4 Konfigurasi dan rahasia

| Variable | Nilai di VPS | Catatan |
|---|---|---|
| `DATABASE_URL` | transaction pooler `:6543`, `pgbouncer=true&connection_limit=5` | `connection_limit=1` cocok untuk serverless; di proses long-running itu membuat semua query antre satu |
| `SESSION_SECRET` | **baru** | Domain berubah → semua orang login ulang juga, jadi rotasi gratis |
| `INTERNAL_API_SECRET` | **baru**, sama di env app dan env dashboard | Rotasi saat cutover (lihat §4) |
| `SHOPIFY_APP_URL` | `https://ab.treelogy-services.my.id` | Sekarang di `.env.local` masih Fly |
| `SHOPIFY_SHOP_DOMAIN`, `STOREFRONT_DOMAIN` | disalin dari Vercel | |
| `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | baru (32 byte base64) | Lihat §3.2 |
| `NEXT_PUBLIC_POSTHOG_*` | tidak di-set (sama dengan Vercel sekarang) | Ini dibaca saat **build**, bukan runtime — kalau nanti diaktifkan, harus tersedia ke `npm run build` |

Password role DB `treelogy_ab` juga pernah tersimpan di Vercel → dirotasi di akhir (§4 langkah 7),
mengubah env app dan dashboard sekaligus.

## 4. Rencana cutover

| # | Langkah | Rollback |
|---|---|---|
| 0 | **Kamu:** tambah A record `dash.treelogy-services.my.id → 203.145.35.26` | — |
| 1 | Kode: `standalone`, `/api/healthz`, `deploymentId`, deploy tooling berbasis komponen, unit + vhost dashboard, doc. Lulus `next build`, eslint, `npm test` lokal | revert commit |
| 2 | `bootstrap.sh host` + `tls` untuk dashboard; isi `/etc/treelogy-ab-dash/env` | hapus vhost |
| 3 | `treelogy-ab-deploy dash` → dashboard live di domain baru. Vercel **masih jalan** (paralel) | tetap pakai Vercel |
| 4 | Buat akun di DB yang sama (akun lama tetap berlaku — user ada di DB, bukan di Vercel); verifikasi login, daftar experiment, satu aksi bridge read-only (`status`) | tetap pakai Vercel |
| 5 | Rotasi `INTERNAL_API_SECRET`: tulis nilai baru ke kedua env → `restart dash` → `restart app`. Selama ±1 menit di antara keduanya aksi bridge 401 (baca data tidak terpengaruh) | tulis nilai lama |
| 6 | Pasang allowlist `/internal/` di nginx app; cek aksi bridge masih jalan dari dashboard dan `curl` dari luar dapat 403 | hapus blok `location` |
| 7 | Rotasi password role `treelogy_ab` di Supabase → update kedua env → `restart app` + `restart dash` | password lama masih ada di catatan rotasi sampai terverifikasi |
| 8 | **Decommission Vercel:** putuskan git integration, hapus env, `vercel project rm treelogy-ab-dashboard`, hapus `dashboard/.vercel/` | tidak bisa dibatalkan — dilakukan paling akhir, setelah konfirmasi kamu |

Langkah 8 dan 7 menyentuh hal yang tidak bisa diulang, jadi masing-masing minta konfirmasi dulu.

## 5. Risiko

| Risiko | Mitigasi |
|---|---|
| Build Next memakan RAM, mengganggu Treelogy API | build berurutan, `NODE_OPTIONS=--max-old-space-size=1536`, swap 2 GB sudah ada |
| Dashboard di-brute force | rate limit nginx + scrypt + login per-orang yang sudah ada |
| Satu box = satu titik gagal untuk app **dan** dashboard | sama seperti sekarang untuk app; dashboard tidak di jalur kritis storefront. Ditulis sebagai risiko yang diterima |
| Next data cache memenuhi disk | cache ikut rilis, rilis lama dipangkas (`KEEP_RELEASES=5`) |

## 6. Dokumen yang ikut diperbarui

`README.md`, `deploy/README.md`, `dashboard/README.md`, `dashboard/.env.example`, komentar yang masih
menyebut "Vercel"/"Fly.io" (`app/lib/internal-auth.server.ts`, `app/routes/internal.action.tsx`,
`dashboard/lib/bridge.ts`, `dashboard/lib/password.ts`, `scripts/sync-dashboard.mjs`,
`taxonomy.ts`, `dashboard/prisma/schema.prisma` lewat sumbernya di root).
