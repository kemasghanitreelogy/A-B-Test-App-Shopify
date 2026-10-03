# Spesifikasi: Auto-Translation untuk Variant B

Untuk custom app A/B test (`shopify://apps/a-b-test-treelogy`)
Toko: `treelogymoringa.myshopify.com` · Theme live: `156446064828`
Ditulis & diverifikasi: 4 September 2026
Status: **sudah diimplementasikan di app** — lihat §10.

---

## 1. Ringkasan eksekutif

App menyalin `templates/product.json` → `templates/product.ab-b.json` di theme live.
**Terjemahannya tidak ikut tersalin.**

Terjemahan Translate & Adapt untuk `templates/*.json` bukan disimpan di dalam file theme.
Ia hidup sebagai resource terpisah bertipe `ONLINE_STORE_THEME_JSON_TEMPLATE`, dan
resource itu **diidentifikasi oleh nama file template**. Begitu app membuat file baru
dengan nama baru, yang lahir adalah resource kosong.

Akibatnya Shopify jatuh ke nilai locale primary — **bahasa Inggris**.

### Dampak

Variant B tampil berbahasa Inggris untuk **79% pembeli** (order id-ID), sementara
variant A tampil berbahasa Indonesia. Yang terukur bukan lagi hipotesis test,
melainkan "Indonesia lawan Inggris". Variant B akan kalah telak di hampir semua test,
dan kesimpulannya akan selalu salah arah: *"desain barunya jelek"*.

Ini berlaku untuk **semua** test, bukan hanya test yang mengubah teks. Test yang cuma
menggeser padding pun terkena, karena seluruh teks di template ikut kehilangan
terjemahannya.

**Tidak ada error yang muncul.** Halaman tetap render, test tetap jalan, angka tetap keluar.
Ini persis kelas kegagalan senyap yang jadi alasan §2 panduan dibuat.

### Yang diminta

Tambahkan satu langkah di proses "Jalankan": setelah template disalin, salin juga
terjemahannya. Algoritmanya ada di §5, dan sudah terbukti jalan — implementasi
referensi: `claudedocs/ab-test/copy-template-translations.mjs`.

---

## 2. Bukti terukur

Diambil 4 Sep 2026 dari theme live, sebelum diperbaiki:

| Resource | Konten translatable | Terjemahan `id` |
|---|---|---|
| `templates/product.json` | 61 | **45** |
| `templates/product.ab-b.json` | 61 | **0** |

Isi kedua file **byte-identical** (md5 `a408bb3e1457e2a83a0c73b2f87ba880`). Konten
translatable-nya sama persis, 61 lawan 61. Yang hilang murni terjemahannya.

Contoh yang akan dilihat pengunjung `id` di variant B:

| Setting | Variant A (`id`) | Variant B (fallback) |
|---|---|---|
| `main.payment_title` | Kami menerima: | `We accept:` |
| `main.note` | atau 4 kali cicilan tanpa bunga sebesar Rp 135.000 | `or 4 interest-free installments of IDR 135.000 by` |
| `main.story_cta_text` | Tambahkan ke Keranjang | `Add to Cart` |
| `main.usp_slider.heading_1` | Pembayaran Aman | `Secure Checkout` |
| `main.usp_slider.text_1` | QRIS • E-wallet • Kartu Debit | `QRIS • E-wallet • Debit Card` |

Tombol *Add to Cart* dalam bahasa Inggris di PDP, untuk 79% pembeli. Itu saja sudah
cukup menjelaskan penurunan konversi apa pun.

> Kondisi live saat ini sudah ditambal manual — `product.ab-b` kini punya 45/45
> terjemahan. Tapi tambalan itu hanya berlaku untuk file yang ada **sekarang**.
> Setiap test baru akan mengulang masalah yang sama sampai app-nya diperbaiki.

---

## 3. Model data yang harus dipahami dulu

### 3.1 Resource

```
gid://shopify/OnlineStoreThemeJsonTemplate/<nama-template>?theme_id=<theme_id>
```

- `<nama-template>` = nama file tanpa `.json` — `product`, `product.ab-b`, `page.faq`
- **wajib URL-encoded**: `customers/login` → `customers%2Flogin`
- terikat ke `theme_id`, jadi tiap theme punya set resource-nya sendiri

### 3.2 Bentuk key

```
section.<nama-template>.json.<path-setting>:<hash-key>
```

Contoh, setting yang **sama persis** di dua template:

```
section.product.json.main.payment_title:exh9xdirkvfv
section.product.ab-b.json.main.payment_title:3tbvdgy6sc7s9
```

Dua bagian berubah: nama template, **dan** hash di belakang titik dua. Artinya key
tidak bisa dipakai langsung sebagai jodoh antar template.

Satu-satunya bagian yang stabil adalah `<path-setting>` — segmen di antara literal
`.json.` dan `:<hash-key>`:

```js
const pathOf = k => k.replace(/^section\..*?\.json\./, '').replace(/:[a-z0-9]+$/, '');
// -> "main.payment_title"
```

Terverifikasi: pemetaan lewat `pathOf` mencocokkan **61/61** setting.

### 3.3 `digest` adalah hash NILAI, bukan hash key

Ini yang membuat seluruh algoritma jadi sederhana dan aman.

Diuji atas tiga resource (`live/product`, `live/product.ab-b`, `draft/product`):
**61/61 digest identik** untuk setiap path. Nama template dan hash key berbeda,
digest tetap sama selama nilai sumbernya sama.

Dua konsekuensi yang dipakai algoritma:

- **digest sama** → teks sumbernya identik → terjemahan A boleh disalin apa adanya
- **digest beda** → teks sumbernya sengaja diubah → **inilah yang sedang di-A/B-kan**,
  terjemahan lama TIDAK boleh ditimpakan (nanti variant B menampilkan kalimat A)

Jadi perbandingan digest sekaligus berfungsi sebagai detektor otomatis "string mana
yang sedang diuji". App tidak perlu diberi tahu.

### 3.4 Duplikasi theme MEMBAWA terjemahan

Diuji: theme draft `158347690172` (duplikat live) punya 45/45 terjemahan `id` yang
sama untuk `templates/product.json`.

Ini penting — artinya merchant **bisa menerjemahkan teks variant B-nya di theme
preview** lewat Translate & Adapt seperti biasa, dan app tinggal memungutnya.
Sumber kebenaran yang benar adalah **theme preview**, bukan theme live (§5.1).

---

## 4. Enam jebakan yang wajib ditangani

### Jebakan 1 — `translations` bocor lintas template sepresiks

Ini yang paling berbahaya dan paling tidak terduga.

`translatableResource(resourceId: ".../page")` mengembalikan `translatableContent`
milik `page` saja (85 item, benar), tapi field `translations`-nya ikut membawa
terjemahan milik **semua** template yang namanya berawalan `page`:

```
resourceId meminta: page
  translatableContent : {"page": 85}                                   <- benar
  translations(id)    : {"page":65, "page.about":39, "page.benefit":13,
                         "page.faq":102, "page.farm":56,
                         "page.moringa-tree":73, "page.sub":1,
                         "page.links":20}                              <- BOCOR
```

Hal yang sama terjadi pada `product`: setelah `product.ab-b` diisi, query `product`
mengembalikan 90 baris — 45 miliknya, 45 milik `product.ab-b`.

Kalau tidak disaring, menyalin `page` → `page.ab-b` akan menyeret teks dari
halaman FAQ dan halaman farm ke dalam variant B. Implementasi referensi sempat kena
bug ini; uji regresi `page → page.about` sekarang membuang 304 baris asing.

**Wajib**: saring `translations` ke nama template yang persis.

```js
const tplOf = k => (k.match(/^section\.(.*?)\.json\./) || [, ''])[1];
const own = res.translations.filter(t => tplOf(t.key) === namaTemplate);
```

`translatableContent` tidak perlu disaring — ia sudah benar.

### Jebakan 2 — jangan salin string yang sedang diuji

Kalau merchant mengubah heading Inggris di variant B, digest-nya berubah. Menyalin
terjemahan A ke situ akan membuat pengunjung `id` tetap melihat kalimat **variant A**
— testnya jadi A/A tanpa ada yang sadar.

**Wajib**: lewati kalau `digest_sumber !== digest_tujuan`, dan **laporkan ke merchant**
(lihat §6).

### Jebakan 3 — locale mana saja

Jangan hardcode `id`. Ambil dari `shopLocales`, pakai yang `published` dan bukan
`primary`.

Kondisi toko sekarang: `en` (primary), `id` (published), `fr` (unpublished).
Jadi hari ini hanya `id` — tapi begitu `fr` dipublikasikan, hardcode akan diam-diam
melewatkannya.

### Jebakan 4 — translation bisa terikat market

`TranslationInput` punya `marketId`. Terjemahan yang market-scoped harus ditulis ulang
dengan `marketId` yang sama, kalau tidak cakupannya berubah diam-diam.

Kondisi sekarang: 45/45 terjemahan `product` tidak terikat market. Tetap tangani,
karena toko ini punya market internasional (US/AU/SG/EU) yang bisa berubah kapan saja.

### Jebakan 5 — urutan operasi

Resource terjemahan baru ada **setelah** file template-nya ada. `translationsRegister`
ke template yang belum dibuat akan gagal.

**Urutan wajib**: upsert `templates/<x>.ab-b.json` → tunggu sukses → baru salin terjemahan.

### Jebakan 6 — digest basi saat template ditulis ulang

Kalau app menulis ulang `product.ab-b.json` (test diedit / test baru), digest untuk
key yang isinya berubah ikut berubah, dan terjemahan lama jadi `outdated`.

**Wajib**: ambil ulang digest tujuan **sesudah** upsert, jangan pakai yang di-cache
dari sebelum upsert.

---

## 5. Algoritma yang harus diimplementasikan

### 5.1 Sumber kebenaran: theme preview, bukan theme live

```
SUMBER  = theme preview  · templates/product.json       (yang merchant edit & terjemahkan)
TUJUAN  = theme live     · templates/product.ab-b.json  (yang app buat)
```

Kenapa bukan dari `live/product`: kalau test mengubah teks, `live/product` tidak punya
terjemahan untuk teks baru itu — teks itu hanya ada di preview. Mengambil dari preview
membuat merchant punya satu tempat yang wajar untuk menerjemahkan variant B-nya:
Translate & Adapt pada theme preview, sebelum test dijalankan.

### 5.2 Pseudocode

```
untuk setiap locale L in shopLocales where published and not primary:

    src = translatableResource(preview_theme, template_sumber, locale = L)
    dst = translatableResource(live_theme,    template_tujuan, locale = L)   # SESUDAH upsert

    srcContent   = index(src.translatableContent, by = pathOf)               # tak perlu disaring
    dstContent   = index(dst.translatableContent, by = pathOf)               # tak perlu disaring
    srcTrans     = filter(src.translations, tplOf(key) == template_sumber)   # Jebakan 1
    dstTransPath = set(pathOf(k) for k in filter(dst.translations,
                                                 tplOf(key) == template_tujuan))

    inputs = []
    perluDiterjemahkanManual = []

    untuk setiap t in srcTrans:
        p      = pathOf(t.key)
        target = dstContent[p]

        jika target tidak ada:                       lewati   # setting dihapus di variant B
        jika target.digest != srcContent[p].digest:            # Jebakan 2
            perluDiterjemahkanManual.append(p);      lewati    # inilah yang sedang diuji
        jika p in dstTransPath:                      lewati    # idempotensi

        inputs.append({
            key:                      target.key,              # key TUJUAN, bukan key sumber
            locale:                   L,
            translatableContentDigest: target.digest,          # digest TUJUAN
            value:                    t.value,
            marketId:                 t.market?.id             # Jebakan 4
        })

    untuk setiap batch of 100 in inputs:
        translationsRegister(resourceId = dst.resourceId, translations = batch)
```

Tiga hal yang paling gampang salah, ditulis ulang biar tidak terlewat:

1. `key` dan `translatableContentDigest` **harus milik TUJUAN**. `value` saja yang dari sumber.
2. `srcTrans` **harus disaring** dengan `tplOf`.
3. `dst` **harus diambil sesudah** upsert template.

### 5.3 GraphQL

Sudah divalidasi lawan schema Admin API `2026-07` (`validate.mjs` exit 0).

Baca:

```graphql
query TemplateTranslations($id: ID!, $locale: String!) {
  translatableResource(resourceId: $id) {
    resourceId
    translatableContent { key value digest }
    translations(locale: $locale) { key value market { id } outdated }
  }
}
```

Tulis:

```graphql
mutation CopyTemplateTranslations($resourceId: ID!, $translations: [TranslationInput!]!) {
  translationsRegister(resourceId: $resourceId, translations: $translations) {
    translations { key locale }
    userErrors { field message }
  }
}
```

Locale:

```graphql
query { shopLocales { locale primary published } }
```

Batas: `translationsRegister` menerima banyak translation sekali panggil; implementasi
referensi memakai batch 100 dan sukses menulis 45 dalam satu panggilan.

### 5.4 Access scope

App perlu tambahan:

- `read_translations`
- `write_translations`
- `read_markets` — hanya kalau menyalin `market { id }` (disarankan, lihat Jebakan 4)

`read_themes` / `write_themes` sudah ada.

---

## 6. Perubahan di wizard (bagian yang menghadap merchant)

Auto-copy saja tidak cukup. Ada satu kasus yang **tidak bisa** diselesaikan otomatis:
string yang teksnya diubah — justru yang jadi inti test.

### 6.1 Panel baru di langkah "Periksa"

Sejajar dengan "Perbedaan theme", tambahkan:

```
Terjemahan
  45 akan disalin otomatis
   1 perlu diterjemahkan manual        <- angka ini harus nol sebelum "Jalankan"
```

Untuk yang manual, tampilkan konkret:

```
main.section_how_to.title
   Variant A  (en) "How to Use"     (id) "Cara Pakai"
   Variant B  (en) "How To Take It" (id) — belum ada —

   Pengunjung Indonesia akan melihat "How To Take It" dalam bahasa Inggris.
   Terjemahkan di theme preview: Translate & Adapt -> Theme -> Templates -> product
```

### 6.2 Jadikan blokir, bukan peringatan

Perlakukan sama seperti file kelas BLOKIR di §2 panduan: **tombol "Jalankan" mati**
selama masih ada string variant B yang belum diterjemahkan, dengan satu jalan keluar
eksplisit — checkbox *"Saya sengaja menguji teks Inggris untuk semua pengunjung"*.

Alasannya sama dengan alasan penolakan file BLOKIR: kalau dipaksa lanjut, testnya
tetap jalan, angkanya tetap keluar, dan tidak ada tanda apa pun bahwa yang terukur
sebenarnya bahasa, bukan desain.

### 6.3 Tampilkan di snapshot

Snapshot B saat ini diambil dari theme preview — dan di preview, terjemahannya **ada**.
Jadi snapshot terlihat benar sementara halaman live-nya nanti salah. Snapshot
berdampingan tidak akan pernah memperlihatkan bug ini.

Minimal: ambil snapshot B dalam locale `id` juga, atau beri catatan eksplisit bahwa
snapshot preview tidak mewakili keadaan terjemahan di live.

---

## 7. Saat test dihentikan

`templates/product.ab-b.json` boleh ditinggal (tidak ada yang menyajikannya). Tapi
terjemahannya sebaiknya dibersihkan supaya tidak jadi puing yang membingungkan di
Translate & Adapt:

```graphql
mutation { translationsRemove(resourceId: $id, locales: ["id"], translationKeys: [...]) }
```

`translationKeys` harus memakai key lengkap **berikut suffix `:<hash-key>`** — key
tanpa hash akan ditolak diam-diam. (Jebakan yang sama sudah pernah kena di toko ini
pada kasus metafield technical settings.)

Kalau app memilih menyimpannya untuk test berikutnya, itu wajar — tapi jangan
diasumsikan masih valid: begitu template ditulis ulang, digest-nya berubah dan
statusnya jadi `outdated` (Jebakan 6).

---

## 8. Cara memverifikasi implementasinya

1. **Unit** — `pathOf` dan `tplOf` atas key asli dari `product` dan `page.faq`.
2. **Regresi kebocoran presiks** — jalankan sumber `page`. Kalau hasilnya menyeret
   path milik `page.faq` / `page.farm`, Jebakan 1 belum tertangani. Nilai benar:
   304 baris asing dibuang.
3. **Idempotensi** — jalankan dua kali. Jalur kedua harus menyalin 0.
4. **Deteksi string yang diuji** — ubah satu teks di preview, jalankan. String itu
   harus masuk `perluDiterjemahkanManual`, bukan tersalin.
5. **End-to-end** — set `templateSuffix` sebuah produk uji ke `ab-b`, buka
   `/id/products/<handle>`, pastikan tidak ada teks Inggris yang bocor. Bandingkan
   dengan `/products/<handle>`.
6. **Jangan pakai headless browser.** `tl-ab-core` selalu mengembalikan variant A
   untuk `navigator.webdriver` dan UA yang mengandung `headlesschrome|lighthouse|bot`.
   Verifikasi split wajib di browser asli; `?_tl_ab_off=1` mematikan logika A/B.

---

## 9. Yang perlu ditambahkan ke `panduan-preview-theme-variant-b.md`

**Sudah dikerjakan** — daftar di bawah ini tinggal catatan apa yang berubah:

- **§2** — tambahkan kelas keempat, atau catatan pada kelas AMAN: `templates/*.json`
  aman untuk **struktur**, tapi terjemahannya adalah resource terpisah yang ikut
  berpindah hanya kalau app menyalinnya.
- **§4** — perjelas bahwa **mengubah teks lewat Translate & Adapt pada theme preview
  itu BOLEH dan justru diperlukan** untuk test teks. Yang berstatus BLOKIR adalah
  `locales/*.json` (string milik theme, `{{ 'x' | t }}`), bukan terjemahan template.
  Ini dua hal berbeda yang saat ini terbaca sebagai satu larangan.
- **§7** — tambahkan ke checklist: *"Teks variant B sudah diterjemahkan ke Indonesia"*.
- **§10** — perbarui jawaban *"Bagaimana kalau saya cuma mau menguji teks tombol?"*.
  Jawaban sekarang bilang hasilnya `1 aman, 0 isolasi, 0 blokir` dan itu ideal —
  padahal justru kasus itulah yang paling rawan kena bug ini.

---

## 10. Di mana ini diimplementasikan

| Bagian | File |
|---|---|
| Algoritma §5, keenam jebakan §4 | `app/lib/translations.server.ts` |
| Salin saat variant B dibangun dari theme preview | `app/lib/theme-analysis.server.ts` → `prepareVariantFromTheme` |
| Salin saat variant B dibuat sebagai template kosong | `app/lib/theme.server.ts` → `ensureVariantTemplate` |
| Endpoint `theme.translationPlan` dan `theme.cleanupTranslations` | `app/routes/internal.action.tsx` |
| Panel "Terjemahan" dan blokir tombol §6 | `dashboard/components/wizard/new-experiment-wizard.tsx` |
| Blokir yang sama diperiksa ulang di server | `dashboard/app/wizard-actions.ts` → `createFromWizard` |
| Uji 1–4 §8 | `scripts/verify-translations.mjs` (ikut `npm test`) |

Catatan implementasi yang tidak ada di spec ini:

- **Cadangan dari variant A.** Kalau theme preview belum punya terjemahan untuk
  sebuah setting tapi teks sumbernya identik dengan variant A (digest sama),
  terjemahan variant A dipakai. Aman menurut aturan §3.3, dan membuat theme preview
  lama tetap bisa dipakai tanpa menerjemahkan ulang dari nol.
- **Yang dilaporkan sebagai "perlu manual"** hanya setting yang variant A-nya sudah
  diterjemahkan tapi variant B-nya tidak — yaitu regresi yang benar-benar terlihat
  pengunjung. Setting yang di kedua variant sama-sama tidak diterjemahkan tidak
  dihitung, karena bukan perubahan.
- **`marketId` ikut ditulis** (Jebakan 4), dan diuji di `verify-translations.mjs`.
- **Pembersihan §7 tidak berjalan otomatis** saat test ditutup. Ia tersedia sebagai
  aksi `theme.cleanupTranslations` yang harus dipanggil dengan sengaja — menghapus
  terjemahan sebagai efek samping dari menutup test terlalu berisiko untuk sesuatu
  yang tidak bisa dibatalkan.
- **Gagal memeriksa tidak dianggap aman.** Kalau scope belum di-approve, wizard
  menampilkan errornya, bukan "0 perlu manual".

Scope yang ditambahkan ke `shopify.app.toml`: `read_translations`,
`write_translations`, `read_locales`, `read_markets`. App harus di-deploy ulang dan
izinnya disetujui lagi di admin sebelum fitur ini bisa jalan.
