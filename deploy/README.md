# Deploy ke VPS

Produksi berjalan di `vps-utama` (IDCloudHost, 203.145.35.26, alias SSH `treelogy-vps`),
berdampingan dengan layanan Treelogy dan combined-discount, di
**https://ab.treelogy-services.my.id**.

```
                                  ┌─▶ 127.0.0.1:3300  treelogy-ab@3300  (blue)
Shopify / storefront ──HTTPS──▶ nginx :443 ──┤        satu slot live, satu idle
                                  └─▶ 127.0.0.1:3301  treelogy-ab@3301  (green)
                                              │
Dashboard (Vercel) ─────────────────────────┐ └──TLS──▶ Supabase Postgres (schema treelogy_ab)
                                            └──TLS──▶ (pooler transaction mode, pgbouncer=true)
```

| Apa | Di mana |
|---|---|
| Slot live | `/etc/nginx/conf.d/treelogy-ab-upstream.conf` (ditulis oleh perintah deploy) |
| Kode live | `/opt/treelogy-ab/current` → `releases/<utc>-<sha>`; tiap slot menjalankan `slots/<port>` |
| Rahasia | `/etc/treelogy-ab/env` (root:treelogy-ab, 640) — template: `deploy/env.example` |
| Service | `/etc/systemd/system/treelogy-ab@.service` (template, instance = port) |
| Perintah deploy | `/usr/local/sbin/treelogy-ab-deploy` (salinan `deploy/bin/deploy.sh`) |
| Log | `journalctl -u 'treelogy-ab@*' -f`, `/var/log/nginx/treelogy-ab.*.log` |

## Deploy

Push ke GitHub, lalu:

```sh
npm run deploy:vps                  # deploy origin/main
npm run deploy:vps -- <sha|branch>
ssh treelogy-vps sudo treelogy-ab-deploy status
ssh treelogy-vps sudo treelogy-ab-deploy rollback   # rilis sebelumnya, tanpa build ulang
ssh treelogy-vps sudo treelogy-ab-deploy restart    # setelah mengubah /etc/treelogy-ab/env
```

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

- App (VPS): session pooler `:5432`, `connection_limit=5` (dua slot bisa hidup bersamaan).
- Dashboard (Vercel, serverless): transaction pooler `:6543` dengan `pgbouncer=true&connection_limit=1`.

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
ssh treelogy-vps sudo /tmp/ab-deploy/bin/bootstrap.sh host
ssh treelogy-vps sudo /tmp/ab-deploy/bin/bootstrap.sh tls
```
