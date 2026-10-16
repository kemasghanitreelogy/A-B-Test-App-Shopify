# Deploy ke VPS

Seluruh produksi — app Shopify **dan** dashboard — berjalan di `vps-utama` (IDCloudHost,
203.145.35.26, alias SSH `treelogy-vps`), berdampingan dengan layanan Treelogy dan
combined-discount. Tidak ada yang berjalan di Vercel atau Fly.

| Komponen | URL | Slot | User / unit |
|---|---|---|---|
| `app` — app Shopify (react-router) | https://ab.treelogy-services.my.id | 127.0.0.1:3300 / 3301 | `treelogy-ab` / `treelogy-ab@<port>` |
| `dash` — dashboard (Next.js standalone) | https://dash.treelogy-services.my.id | 127.0.0.1:3310 / 3311 | `treelogy-ab-dash` / `treelogy-ab-dash@<port>` |

```
Shopify / storefront ──┐                   ┌─ ab.*   ─▶ :3300 | :3301  app (blue/green)
                       ├─HTTPS─▶ nginx ────┤                   ▲ /internal/action (HMAC)
Tim (browser) ─────────┘          :443     └─ dash.* ─▶ :3310 | :3311  dashboard (blue/green)
                                                           │
                         Supabase Postgres (schema treelogy_ab) ◀──TLS──┘
                         app → session pooler :5432 · dashboard → transaction pooler :6543
```

Dashboard sengaja user Linux terpisah: ia tidak bisa membaca `/etc/treelogy-ab/env`, jadi
access token Shopify tetap hanya di app, dan dashboard menyentuh Shopify hanya lewat bridge.

| Apa | Di mana (`<c>` = `treelogy-ab` atau `treelogy-ab-dash`) |
|---|---|
| Slot live | `/etc/nginx/conf.d/<c>-upstream.conf` (ditulis oleh perintah deploy) |
| Kode live | `/opt/<c>/current` → `releases/<utc>-<sha>`; tiap slot menjalankan `slots/<port>` |
| Rahasia | `/etc/<c>/env` (root:<c>, 640) — template: `deploy/env.example`, `deploy/dashboard.env.example` |
| Service | `/etc/systemd/system/<c>@.service` (template, instance = port) |
| Perintah deploy | `/usr/local/sbin/treelogy-ab-deploy` (salinan `deploy/bin/deploy.sh`) |
| Log | `journalctl -u 'treelogy-ab@*' -u 'treelogy-ab-dash@*' -f`, `/var/log/nginx/treelogy-ab*.log` |

## Deploy

Push ke GitHub, lalu:

```sh
npm run deploy:vps                          # app + dashboard dari origin/main (satu SHA)
npm run deploy:vps -- <sha|branch>          # idem, ref lain
npm run deploy:vps -- app|dash [ref]        # satu komponen saja
ssh treelogy-vps sudo treelogy-ab-deploy status
ssh treelogy-vps sudo treelogy-ab-deploy rollback app|dash   # rilis sebelumnya, tanpa build ulang
ssh treelogy-vps sudo treelogy-ab-deploy restart [app|dash]  # setelah mengubah env (default: keduanya)
```

Default-nya kedua komponen dibangun dari commit yang sama: `lib/stats.ts` dkk. disalin
dari app ke dashboard, dan satu SHA menjamin keduanya menghitung hasil dengan rumus yang
sama. Keduanya dibangun dulu (berurutan — dua build Next/Vite sekaligus bisa membuat
layanan lain di box ini kena OOM), baru migrasi, lalu app live, lalu dashboard live.
Build yang gagal tidak mengubah apa pun.

Dashboard membaca env file juga saat **build**: `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`
dan `NEXT_PUBLIC_*` tertanam di build, jadi setelah mengubahnya deploy ulang `dash`,
`restart` saja tidak cukup. Kunci Server Action yang tetap + `deploymentId` per SHA
membuat tab yang dibuka sebelum deploy melakukan reload penuh, bukan error
"Failed to find Server Action".

Deploy blue/green tanpa downtime: build di direktori rilis baru (tiap langkah dicek),
`prisma migrate deploy`, start di slot **idle**, `/healthz` (menyentuh DB) + smoke
`/` dan `/auth/login` di slot itu, baru nginx dipindah dengan reload graceful,
diverifikasi end-to-end lewat TLS (header `X-Upstream`, hanya untuk loopback), lalu
slot lama dihentikan setelah drain 10 detik. Rilis yang gagal sebelum switch tidak
pernah menerima traffic. Dua slot berbagi satu DB selama switch — aman: drainer
outbox PostHog memakai `FOR UPDATE SKIP LOCKED`.

Migrasi berjalan saat rilis lama masih melayani, jadi harus backward compatible.

Konfigurasi sisi Shopify (URL, app proxy, webhook) dan extension (web pixel, theme
embed) tidak ikut deploy ini — dirilis lewat `shopify app deploy`. Setelah
`SHOPIFY_APP_URL` berubah, endpoint web pixel harus diperbarui lewat aksi bridge
`pixel.ensure`.

## Database

Supabase project **treelogy-ab** (`yeiadvzyphcnwovdozlc`, ap-southeast-1, Pro), Postgres 17.
App dan dashboard login sebagai role `treelogy_ab`, pemilik schema `treelogy_ab` saja:
bukan superuser, tanpa bypass RLS, tanpa CREATE di database/`public`, tidak terekspos
lewat Data API. Search path default role = `treelogy_ab`, jadi raw SQL tanpa prefix
schema tetap jalan (juga lewat transaction pooler).

- App: session pooler `:5432`, `connection_limit=5` (dua slot bisa hidup bersamaan).
- Dashboard: transaction pooler `:6543` dengan `pgbouncer=true&connection_limit=5`, supaya
  tidak ikut memakan kuota koneksi session pooler milik app.

Pindah dari Neon + Fly pada 2026-10-05 tanpa event hilang: data disalin saat Fly masih
melayani, sequence Supabase dimulai 100 juta di atas Neon supaya kedua sisi bisa
menulis bersamaan tanpa bentrok id, traffic dipindah (`shopify app deploy`,
`pixel.ensure`, env Vercel), lalu baris yang masih masuk ke Neon digabung secara
idempoten (yang lebih baru menang). Token offline Shopify diserahkan sekali dari Neon
ke Supabase dan refresh token di Neon dikosongkan — Shopify merotasi refresh token,
jadi hanya satu sisi boleh memegangnya.

## Mengubah tooling deploy

Server menjalankan salinan terpasang. Setelah mengubah apa pun di `deploy/`:

```sh
rsync -a --delete deploy/ treelogy-vps:/tmp/ab-deploy/
ssh treelogy-vps sudo /tmp/ab-deploy/bin/bootstrap.sh host app    # atau: dash
ssh treelogy-vps sudo /tmp/ab-deploy/bin/bootstrap.sh tls  app    # atau: dash
```
