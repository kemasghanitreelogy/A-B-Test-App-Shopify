# Panduan: Membuat Preview Theme yang Bisa Dipakai sebagai Variant B

Toko: `treelogy.com` · Theme live: **Treelogy/staging** (`156446064828`)
Diperiksa ulang: **17 September 2026** (§6 dan §11 berisi angka hasil pengukuran hari itu)

---

## Ringkasan untuk yang buru-buru

1. **Duplikat theme live tepat sebelum mulai** — jangan pakai theme preview lama.
2. Ubah **hanya** yang berkaitan dengan hipotesis test.
3. Jangan sentuh: theme settings, `layout/theme.liquid`, `assets/*.css`, `assets/*.js`, locale.
4. Kalau kamu mengubah teks, **terjemahkan teks barunya** di theme preview sebelum jalan.
5. Selesai dalam hitungan hari, bukan minggu — makin lama makin besar kemungkinan basi.
6. **Pakai suffix template yang baru untuk tiap test** (§5a). Suffix lama berisi desain lama, dan aplikasi memakainya apa adanya tanpa bertanya.
7. **Kerjakan mobile lebih dulu.** 100% trafik yang terekam di toko ini mobile (§11).
8. Cek di wizard sebelum menjalankan. Kalau ada satu saja file "blokir" — atau satu teks yang belum diterjemahkan — theme itu belum bisa dipakai.
9. Setelah jalan, **pastikan datanya benar-benar masuk** dalam 10 menit pertama (§12). Test yang tidak terlacak hanya terlihat seperti test yang sepi.

Saat ini **15 dari 15** theme preview di toko ini tidak bisa dipakai. Penyebab utamanya satu dan sama, dan itu bukan pelanggaran aturan melainkan **cara kerja yang dipakai tim selama ini** — lihat §6.

---

## 1. Kenapa ada aturannya sama sekali

A/B test membandingkan dua halaman yang **hanya berbeda pada satu hal yang sedang diuji**. Kalau ada yang lain ikut berbeda, hasilnya tidak bisa ditafsirkan: kamu tidak tahu kenaikan konversi itu datang dari desain barunya, atau dari perubahan lain yang kebetulan ikut terbawa.

Masalahnya, Shopify hanya bisa menayangkan **satu theme** sekaligus. Jadi variant A dan B harus hidup berdampingan **di theme live yang sama**, dalam bentuk alternate template. Isi theme preview harus dipindahkan ke sana.

Di sinilah letak bahayanya. Sebagian file theme berdiri sendiri, sebagian lagi dipakai bersama oleh **semua** halaman. Menyalin file yang dipakai bersama berarti mengubah variant A juga — dan itu tidak memunculkan error apa pun. Test akan tetap jalan, angka tetap keluar, dan tidak ada yang tahu bahwa yang dibandingkan sebenarnya bukan A lawan B, melainkan A-yang-sudah-berubah lawan B.

> **Prinsip yang dipegang aplikasi ini: variant A tidak boleh berubah satu byte pun.**

---

## 2. Tiga kelas file

Setiap file yang berbeda antara theme live dan theme preview dimasukkan ke salah satu dari tiga kelas.

### AMAN — bisa langsung dipindahkan

| Pola | Contoh |
|---|---|
| `templates/*.json` | `templates/product.json`, `templates/index.json` |

Template adalah satu-satunya jenis file yang bisa punya versi alternatif. `templates/product.json` dan `templates/product.ab-b.json` hidup berdampingan tanpa saling mengganggu. Inilah fondasi seluruh mekanisme.

Isinya: section apa saja yang tampil, urutannya, dan **setting tiap section** (teks, gambar, warna per-section, jumlah kolom, dan seterusnya).

**Sebagian besar test yang bagus cukup mengubah file ini saja.**

> **Satu hal yang tidak ada di dalam file itu: terjemahannya.**
>
> Teks Indonesia untuk `templates/product.json` tidak tersimpan di dalam file template. Ia resource terpisah yang diidentifikasi lewat **nama file template**, jadi `templates/product.ab-b.json` lahir tanpa terjemahan sama sekali — dan Shopify jatuh ke bahasa primary, yaitu Inggris. Tidak ada error yang muncul; halaman tetap render dan test tetap jalan.
>
> Aplikasi menyalinnya untukmu saat variant B dibuat, dan wizard melaporkan berapa yang tersalin. Yang tidak bisa disalin otomatis hanya satu hal: **teks yang kamu ubah sendiri di variant B**, karena terjemahan lama tidak berlaku lagi untuk kalimat baru. Itu harus kamu terjemahkan — caranya di §4. Rincian teknisnya di `SPEC-auto-translation.md`.

---

### PERLU ISOLASI — dipindahkan dengan nama baru

| Pola | Contoh |
|---|---|
| `sections/*.liquid` | `sections/MainProductDetail.liquid` |
| `snippets/*.liquid` | `snippets/CartDrawerContent.liquid` |

File-file ini dipakai bersama: `sections/MainProductDetail.liquid` yang sama dirender oleh variant A maupun B. Menimpanya berarti mengubah keduanya.

Aplikasi menanganinya dengan **menyalin, bukan menimpa**:

```
Sebelum
  sections/MainProductDetail.liquid     dipakai variant A
  templates/product.json                variant A

Sesudah
  sections/MainProductDetail.liquid     TIDAK DISENTUH — tetap milik variant A
  sections/MainProductDetail-abb.liquid salinan dari theme preview
  templates/product.json                TIDAK DISENTUH
  templates/product.ab-b.json           type-nya menunjuk ke -abb
```

Rujukan `{% render %}` di dalam file yang disalin ikut ditelusuri sampai **3 tingkat**. Kalau section yang disalin merujuk snippet yang juga berubah, snippet itu ikut disalin dan rujukannya ditulis ulang.

> **Konsekuensi yang harus kamu ingat:** salinan itu terputus dari aslinya. Kalau setelah test jalan kamu mengedit `sections/MainProductDetail.liquid` di theme editor, **variant B tidak ikut berubah**. Itu memang disengaja — kalau ikut berubah, data sebelum dan sesudah edit jadi tidak sebanding. Tapi artinya perbaikan darurat harus diterapkan dua kali.

---

### BLOKIR — tidak bisa dipindahkan sama sekali

| Pola | Kenapa |
|---|---|
| `layout/theme.liquid` | Membungkus **semua** halaman. Tidak ada mekanisme layout alternatif per-template. |
| `assets/*.css` | Dimuat sekali oleh layout untuk seluruh situs. Tidak bisa dibedakan per template. |
| `assets/*.js` | Sama — satu berkas untuk semua halaman. |
| `config/settings_data.json` | Nilai `settings.*` berlaku ke seluruh toko. |
| `config/settings_schema.json` | Mendefinisikan setting theme itu sendiri. |
| `locales/*.json` | Terjemahan berlaku ke seluruh toko. |

Kalau salah satu dari ini berubah, aplikasi **menolak** dan menyebutkan file mana.

Penolakan itu bukan kerewelan. Kalau dipaksa lanjut, template-nya tersalin tapi perubahan CSS/layout/setting-nya tidak ikut — sehingga **variant B di theme live tampil berbeda dari yang kamu lihat di preview**. Kamu akan menguji sesuatu yang tidak pernah kamu setujui, dan tidak akan ada tanda apa pun.

---

## 3. Apa yang boleh kamu ubah dengan bebas

Semua ini hanya menyentuh `templates/*.json` (kelas AMAN):

- Menambah, menghapus, menyembunyikan section
- Mengubah **urutan** section
- Mengubah teks, heading, tombol, label
- Mengganti gambar dan video
- Mengubah setting yang disediakan section: jumlah kolom, warna per-section, padding, ukuran, mode tampilan
- Menambah / menghapus / menyusun ulang **block** di dalam section

Praktisnya: **apa pun yang bisa kamu lakukan lewat panel kanan theme editor saat sedang membuka sebuah halaman.**

Kelas PERLU ISOLASI, masih boleh tapi ada konsekuensinya:

- Mengedit kode `sections/*.liquid`
- Mengedit kode `snippets/*.liquid`
- Menambah section atau snippet baru

---

## 4. Apa yang membuat theme jadi tidak terpakai

Hafalkan yang ini — semuanya gampang terjadi tanpa sadar:

| Yang kamu lakukan | File yang berubah | Akibat |
|---|---|---|
| Theme editor → **Theme settings** (warna, tipografi, favicon, sosial media) | `config/settings_data.json` | ⛔ tidak bisa dipakai |
| Edit `layout/theme.liquid` | `layout/theme.liquid` | ⛔ tidak bisa dipakai |
| Edit `assets/theme.css` atau CSS mana pun | `assets/*.css` | ⛔ tidak bisa dipakai |
| Edit / menambah file JS di `assets/` | `assets/*.js` | ⛔ tidak bisa dipakai |
| Menerjemahkan **string milik theme** (Translate & Adapt → Theme → **Default theme content**) | `locales/*.json` | ⛔ tidak bisa dipakai |
| Menginstall app yang menyuntik kode ke theme | bermacam-macam | ⛔ biasanya tidak bisa dipakai |

**Kalau butuh CSS khusus untuk variant B**, jangan menulis ke `assets/theme.css`. Taruh di dalam file section-nya:

```liquid
{% stylesheet %}
  .produk-hero-baru { display: grid; gap: 1.5rem; }
{% endstylesheet %}
```

CSS di dalam `{% stylesheet %}` ikut file section itu, jadi ia ikut terisolasi bersama section-nya dan tidak menyentuh variant A. Ini cara yang benar.

Hal yang sama berlaku untuk JavaScript — pakai `{% javascript %}` di dalam section, bukan file terpisah di `assets/`.

### Menerjemahkan variant B: boleh, malah perlu

Baris terakhir tabel di atas sering terbaca sebagai "jangan sentuh Translate & Adapt sama sekali". Bukan itu maksudnya. Ada **dua hal berbeda** di balik menu yang sama:

| Yang kamu terjemahkan | Di Translate & Adapt | Tersimpan di | Untuk variant B |
|---|---|---|---|
| **String milik theme** — yang di kode ditulis `{{ 'products.add_to_cart' \| t }}` | Theme → **Default theme content** | `locales/*.json` | ⛔ berlaku ke seluruh toko, tidak bisa dibedakan per template |
| **Teks yang kamu isi sendiri di theme editor** — heading, tombol, label section | Theme → **Templates** → `product` | resource terpisah per nama template | ✅ boleh, dan memang harus |

Kalau test-mu mengubah teks — dan banyak test yang bagus memang begitu — **terjemahkan teks barunya di theme preview** lewat Translate & Adapt → Theme → Templates, sebelum test dijalankan. Aplikasi akan memungutnya dari situ.

Kalau tidak diterjemahkan, yang terjadi bukan error melainkan ini: pengunjung Indonesia melihat variant A dalam bahasa Indonesia dan variant B dalam bahasa Inggris. Yang terukur jadi bahasanya, bukan desainnya — dan variant B akan kalah di hampir semua test, dengan kesimpulan yang selalu salah arah: *"desain barunya jelek"*.

Karena itu wizard **memblokir** test yang masih punya teks variant B tanpa terjemahan, sama seperti ia memblokir file kelas BLOKIR. Ada satu jalan keluar eksplisit — saklar *"Saya sengaja menguji teks Inggris untuk semua pengunjung"* — yang hanya benar kalau bahasa memang bagian dari hipotesismu.

---

## 5. Alur kerja yang benar

### Langkah 1 — Duplikat theme live, hari itu juga

`Online Store → Themes → Treelogy/staging → ⋯ → Duplicate`

Beri nama yang menjelaskan **hipotesisnya**, bukan sekadar nomor versi:

```
AB — PDP trust badge di atas fold — 4 Sep
```

Duplikasi harus dilakukan **saat itu juga, sebelum mulai mengedit**. Theme yang diduplikat minggu lalu sudah ketinggalan dari live.

### Langkah 2 — Ubah hanya satu hal

Satu test menjawab satu pertanyaan. Kalau kamu mengubah hero, harga, dan urutan section sekaligus lalu konversi naik 15%, kamu tidak tahu mana yang menyebabkannya — dan tidak bisa menerapkan hanya bagian yang berhasil.

### Langkah 3 — Kerjakan lewat theme editor, bukan code editor

Panel kanan theme editor hanya menulis ke `templates/*.json`. Code editor bisa menyentuh apa saja. Kalau bisa dikerjakan lewat panel, kerjakan di sana.

### Langkah 4 — Periksa sebelum mulai

Buka wizard di dashboard → pilih halaman → pilih theme preview ini → **Ambil snapshot**.

Bagian "Perbedaan theme" akan menampilkan:

```
6 aman · 22 perlu isolasi · 0 tidak bisa
```

Angka terakhir **harus nol**. Kalau tidak nol, dashboard menyebutkan file mana dan kenapa.

Tepat di bawahnya ada panel "Terjemahan":

```
45 akan disalin otomatis
 1 perlu diterjemahkan manual
```

Angka kedua **juga harus nol**. Ini pemeriksaan yang terpisah: sebuah theme bisa lulus "0 tidak bisa" dan tetap membuat variant B tampil berbahasa Inggris, karena terjemahan template bukan file theme. Untuk yang perlu manual, dashboard menyebutkan setting mana, teks A-nya, teks B-nya, dan ke mana harus pergi memperbaikinya.

### Langkah 5 — Bandingkan snapshot A dan B

Snapshot berdampingan menampilkan halaman sungguhan. Pastikan yang berbeda memang hanya yang kamu maksudkan.

Ada saklar bahasa di atas kedua snapshot. Pakai untuk melihat halaman dalam bahasa Indonesia — tapi ingat: snapshot B diambil dari **theme preview**, dan di preview terjemahannya memang ada. Yang menentukan adalah apakah terjemahan itu ikut pindah ke theme live, dan itu dilaporkan panel "Terjemahan", bukan oleh snapshot.

### Langkah 6 — Jalankan

Aplikasi menyalin template + section terisolasi + terjemahannya ke theme live, lalu test mulai.

---

## 5a. Suffix template: satu test, satu suffix

Saat test dijalankan, aplikasi membuat `templates/product.<suffix>.json` di theme live. **Kalau file dengan nama itu sudah ada, aplikasi memakainya apa adanya** — ia tidak menimpanya, dan tidak bertanya.

Itu keputusan yang disengaja (menimpa berarti menghapus pekerjaan orang tanpa diminta), tapi konsekuensinya harus kamu tahu:

> Kalau kamu memakai ulang suffix dari test sebelumnya, **variant B-mu adalah desain test yang lama**, bukan desain yang barusan kamu siapkan. Halaman tetap render, angka tetap keluar, dan tidak ada peringatan apa pun.

Theme live saat ini **sudah punya `templates/product.ab-b.json`** — sisa percobaan lama. Jadi `ab-b` adalah suffix yang justru paling berbahaya untuk dipakai.

**Aturannya:** beri suffix yang menjelaskan hipotesis dan tanggalnya, sekali pakai.

```
ab-trustbadge-17sep
ab-hargacoret-24sep
```

Kalau kamu memang ingin memakai ulang sebuah suffix, hapus dulu file templatenya lewat `Online Store → Themes → ⋯ → Edit code` sebelum menjalankan test.

---

## 6. Kondisi theme preview kamu sekarang

Diukur ulang **17 September 2026** terhadap theme live, lewat bridge aplikasi (bukan perkiraan):

| Theme preview | Aman | Perlu isolasi | Blokir | Bisa dipakai? |
|---|---|---|---|---|
| PDP v4 — Perf (10 Sep) | 2 | 18 | **5** | ❌ |
| PDP v4 Capsules — UI Kit (9 Sep) | 2 | 21 | **6** | ❌ |
| PDP v3 — pre-push QA (8 Sep) | 2 | 34 | **6** | ❌ |
| PDP v3 Capsules — 1:1 (7 Sep) | 3 | 42 | **9** | ❌ |
| AB — A/A judul accordion + terjemahan (4 Sep) | 3 | 70 | **9** | ❌ |
| PDP v3 — Desktop/Tablet Revamp (4 Sep) | 3 | 68 | **9** | ❌ |
| Klaviyo testing review | 3 | 71 | **10** | ❌ |
| Preview — Kotak Ringkasan 3 Baris (27 Agu) | 9 | 90 | **10** | ❌ |
| Preview — Fix Hapus Cart Drawer (20 Agu) | 12 | 109 | **28** | ❌ |
| Preview — Fix Scroll Keranjang (18 Agu) | 12 | 109 | **28** | ❌ |
| LP Menopause — urutan v2 (15 Agu) | 12 | 109 | **28** | ❌ |
| Gift Rail Preview (14 Agu) | 12 | 119 | **29** | ❌ |
| backup 10 jun | 43 | 214 | **57** | ❌ |
| Treelogy - Update 24 Mar 2025 | 45 | 214 | **58** | ❌ |
| Development (lokal) | 8 | 0 | **4** | ❌ |

File yang memblokir, diurutkan dari yang paling sering muncul:

| File | Terkena |
|---|---|
| `layout/theme.liquid` | 14 dari 15 |
| `assets/theme.css` | 13 dari 15 |
| `locales/en.default.json`, `locales/id.json` | 12 dari 15 |
| `assets/pdp3.css`, `assets/pdp3.js`, `assets/pdp4.css`, `assets/pdp4.js` | 8 dari 15 |
| `assets/gift-auto-add.js` | 11 dari 15 |

### Yang berubah sejak pemeriksaan 4 September

Dulu penyebab utamanya adalah **theme basi** — preview dicabang dari live versi lama, lalu live berkembang. Sebagian itu masih benar untuk theme Agustus ke bawah.

Tapi theme yang baru (PDP v3 dan v4, 4–10 September) **tidak basi**. Blokirnya turun drastis, dari 28+ menjadi 5–9, dan sisanya bukan file yang tertinggal melainkan file yang **sengaja dibuat**:

```
assets/pdp3.css   assets/pdp3.js
assets/pdp4.css   assets/pdp4.js
```

Inilah temuan yang paling penting di dokumen ini.

### Cara kerja yang sekarang dipakai tidak bisa di-A/B-test — dan itu bisa diperbaiki

Desain PDP baru dikerjakan dengan menulis **file CSS dan JS tersendiri di `assets/`**, lalu memanggilnya dari `layout/theme.liquid`. Untuk pengembangan biasa itu rapi dan masuk akal.

Untuk A/B test, itu jalan buntu — dan bukan karena aplikasinya rewel:

> `assets/pdp4.css` dimuat oleh `layout/theme.liquid`, dan layout membungkus **semua** halaman. Tidak ada mekanisme di Shopify untuk memuat CSS berbeda per alternate template. Kalau file itu dipindahkan ke live, ia berlaku untuk **variant A juga**, dan yang kamu bandingkan bukan lagi A lawan B.

Selama variant B dibangun seperti ini, **tidak akan pernah ada theme preview yang lolos**, seberapa baru pun.

**Yang harus diubah**, dan hanya ini:

| Sekarang | Untuk bisa di-A/B-test |
|---|---|
| `assets/pdp4.css` + panggilan di `layout/theme.liquid` | blok `{% stylesheet %}` di dalam `sections/MainProductDetail.liquid` |
| `assets/pdp4.js` + panggilan di `layout/theme.liquid` | blok `{% javascript %}` di dalam section yang sama |

CSS di dalam `{% stylesheet %}` ikut ke file section-nya. Section itu masuk kelas **perlu isolasi**, jadi aplikasi menyalinnya dengan nama baru (`MainProductDetail-abb.liquid`) dan variant A tetap utuh — lengkap dengan gaya lamanya. Itulah satu-satunya cara dua desain PDP hidup berdampingan di satu theme.

Hasil praktisnya: `PDP v4 — Perf` yang sekarang punya 5 blokir akan turun ke **0 blokir** kalau `pdp4.css` dan `pdp4.js` dipindahkan ke dalam section, dan `locales/*.json` dikembalikan ke isi live (§4).

Kabar baiknya, pekerjaan desainnya sendiri tidak perlu diulang — yang berpindah hanya tempat CSS dan JS-nya tinggal.

---

## 7. Checklist sebelum menjalankan test

- [ ] Theme diduplikat dari live **hari ini atau kemarin**, bukan minggu lalu
- [ ] Namanya menjelaskan hipotesis, bukan nomor versi
- [ ] Hanya satu hal yang diubah
- [ ] Tidak menyentuh Theme settings
- [ ] Tidak mengedit `layout/theme.liquid`
- [ ] Tidak mengedit file di `assets/`
- [ ] CSS khusus ditulis dalam `{% stylesheet %}` di dalam section
- [ ] Tidak menerjemahkan **string milik theme** (Default theme content)
- [ ] Teks variant B yang kamu ubah **sudah diterjemahkan** ke Indonesia di theme preview
- [ ] Tidak menginstall app baru di theme itu
- [ ] CSS/JS variant B ada di dalam section (`{% stylesheet %}` / `{% javascript %}`), **bukan** file baru di `assets/` (§6)
- [ ] Suffix template **baru**, belum pernah dipakai test lain (§5a)
- [ ] App embed **"A/B Test PDP" tetap aktif** di theme live (§11)
- [ ] Tidak memasang snippet PostHog / analitik sendiri di theme (§11)
- [ ] Wizard menunjukkan **0 blokir** dan **0 perlu diterjemahkan manual**
- [ ] Snapshot A dan B hanya berbeda pada yang dimaksudkan
- [ ] Sudah dicek di tampilan **mobile** — dan mobile yang diprioritaskan (§11)

---

## 8. Cara memperbaiki theme yang terlanjur basi

> Untuk theme PDP v3/v4 yang baru, penyebabnya **bukan** basi melainkan CSS/JS di `assets/` — perbaikannya ada di §6, dan tidak perlu duplikat ulang.

Untuk theme lama yang memang sudah tertinggal dari live: jangan mencoba memperbaikinya. **Mulai dari duplikat baru.**

1. Buka theme lama, catat / screenshot apa saja yang kamu ubah
2. Duplikat theme live sekarang
3. Terapkan ulang perubahan itu di duplikat baru
4. Cek lewat wizard sampai blokir = 0

Terdengar boros, tapi menerapkan ulang beberapa perubahan itu lebih murah daripada menelusuri 100+ file untuk mencari mana yang basi dan mana yang disengaja. Dan hasilnya pasti benar.

---

## 9. Jebakan yang sering terjadi

**Menyimpan di theme editor bisa menyentuh file yang tidak kamu duga.** Kalau kamu membuka Theme settings lalu menutupnya, `settings_data.json` bisa ikut tertulis ulang. Kalau wizard menandai file itu padahal kamu merasa tidak mengubah apa-apa, kemungkinan besar theme-nya memang basi — lihat §6.

**Theme preview yang dipakai berulang untuk banyak test.** Tiap kali kamu memakai ulang theme yang sama, jaraknya dengan live makin jauh. Satu theme untuk satu test, lalu arsipkan.

**Mengedit variant B saat test sedang berjalan.** Data sebelum dan sesudah perubahan tidak bisa digabungkan. Dashboard mendeteksi ini lewat checksum dan menampilkan peringatan "Template variant B berubah saat test berjalan". Kalau terjadi, mulai ulang test.

**Menyangka theme live yang menang otomatis diterapkan.** Tidak. Kalau variant B menang, kamu masih harus menerapkannya sebagai desain utama secara manual — aplikasi ini hanya menjalankan test dan mengukurnya.

**Test yang berjalan sambil theme live juga terus diedit.** Kalau kamu mengubah section yang dipakai variant A saat test berjalan, kamu mengubah kelompok kontrol di tengah jalan. Hindari mengedit theme live selama test berlangsung.

---

## 10. Pertanyaan yang sering muncul

**Kenapa tidak menayangkan dua theme sekaligus saja?**
Shopify hanya bisa menayangkan satu theme. Theme preview bisa dibuka lewat URL, tapi tidak di-cache CDN — halamannya jadi jauh lebih lambat, dan itu sendiri akan mengubah konversi. Yang terukur bukan lagi desainnya, melainkan kecepatannya.

**Apakah variant B lebih lambat dari A?**
Tidak. Keduanya adalah alternate template di theme live yang sama, sama-sama di-cache Shopify. Grup B hanya mengalami satu redirect tambahan pada halaman pertama yang dibuka.

**Bagaimana kalau saya cuma mau menguji teks tombol?**
Dari sisi file itu ideal — hanya menyentuh `templates/*.json`, hasilnya 1 aman, 0 isolasi, 0 blokir. Tapi justru test seperti inilah yang paling rawan pada terjemahan: begitu teks Inggrisnya kamu ubah, terjemahan lamanya tidak berlaku lagi, dan tanpa terjemahan baru pengunjung Indonesia akan membaca tombol B dalam bahasa Inggris sementara tombol A tetap Indonesia.

Jadi: duplikat theme, ubah teksnya lewat theme editor, **lalu terjemahkan teks barunya** di Translate & Adapt → Theme → Templates, baru jalankan. Wizard akan menunjukkan 0 perlu diterjemahkan manual kalau sudah beres.

**Kenapa variant B saya berbahasa Inggris padahal variant A berbahasa Indonesia?**
Karena teks variant B belum diterjemahkan, dan Shopify jatuh ke bahasa primary. Perbaikannya di theme preview (Translate & Adapt → Theme → Templates), lalu ambil snapshot ulang di wizard. Kalau ini terjadi pada test yang sudah berjalan, hentikan test itu — angkanya mengukur bahasa, bukan desain.

**Berapa lama theme preview boleh menganggur sebelum dianggap basi?**
Tidak ada batas waktu pasti — yang menentukan adalah seberapa sering theme live berubah. Di toko ini live cukup aktif, jadi anggap lebih dari seminggu sudah berisiko. Wizard akan memberi tahu dengan pasti.

**Apakah bisa A/B test halaman selain produk?**
Theme ini punya banyak tipe halaman ber-template JSON (beranda, koleksi, halaman statis, blog, artikel). Tapi **skrip pembagi variant saat ini hanya bekerja di halaman produk** — pengunjung di halaman lain tidak pernah dibagi. Jadi untuk sekarang: PDP saja.

**Kalau semua file cuma "perlu isolasi", aman?**
Aman. Aplikasi menyalinnya dengan nama baru dan variant A tetap utuh. Yang perlu diingat cuma: salinan itu terputus dari aslinya, jadi edit berikutnya pada file asli tidak ikut ke variant B.

---

## 11. Pelacakan: yang harus tetap utuh supaya angkanya ada

Sejak 17 September 2026 aplikasi tidak hanya menghitung konversi. Ia juga mengumpulkan **heatmap, session replay, scroll depth, rage click, dan Core Web Vitals — terpisah per variant** — dan menampilkannya di halaman **Audit lengkap** di dashboard.

Semua itu berjalan dari satu tempat: **app embed "A/B Test PDP" di theme live**. Kalau app embed itu mati, bukan cuma heatmap yang hilang — pembagian variant ikut berhenti, dan test tidak berjalan sama sekali.

### Yang tidak boleh dilakukan di variant B

| Jangan | Kenapa |
|---|---|
| Menonaktifkan app embed "A/B Test PDP" | Seluruh mekanisme A/B mati. Tidak ada variant, tidak ada data. |
| Menghapus pixel **A/B Test Treelogy** di Settings → Customer events | Langkah "Mulai checkout" di funnel berhenti terisi. Konversi tetap aman (dari webhook), tapi kamu kehilangan kemampuan melihat di mana funnel bocor. |
| Memasang snippet PostHog sendiri di `layout/theme.liquid` | Dua instance posthog-js di satu halaman menggandakan pageview dan memecah session replay. App embed sudah memuatnya. |
| Memindahkan app embed ke urutan paling akhir | Skrip harus jalan sebelum halaman dirender supaya tidak ada kedipan. |
| Menambah CSS yang menyembunyikan elemen dengan `display:none` di variant B saja | Heatmap tetap mencatat posisi lamanya; peta jadi tidak bisa dibaca. Hapus elemennya lewat theme editor, jangan disembunyikan. |

### Kenapa mobile lebih dulu

Dari data yang benar-benar terekam di toko ini pada 17 September:

| Hal yang diukur | Angka |
|---|---|
| Pangsa trafik dengan heatmap **mobile** | 100% |
| Pangsa pageview di halaman berbahasa Indonesia (`/id/…`) | ±84% |
| Rata-rata kedalaman scroll per pageview | ±15% tinggi halaman |
| Durasi sesi rata-rata | ±115 detik |
| Bounce rate | ±19% |

Dua di antaranya mengubah cara kerja:

1. **Semua pengunjung yang terekam memakai mobile.** Desain yang "kelihatan bagus di desktop" tidak menentukan apa pun di sini. Kerjakan dan periksa variant B di lebar mobile lebih dulu; desktop belakangan.

2. **Kedalaman scroll rata-rata hanya ±15%.** Artinya sebagian besar pengunjung tidak pernah melihat bagian bawah halaman produk. Test yang mengubah sesuatu di bawah lipatan kemungkinan besar tidak akan menghasilkan selisih apa pun — bukan karena desainnya jelek, tapi karena hampir tidak ada yang melihatnya. Pakai **scroll map** di halaman Audit untuk memastikan bagian yang kamu ubah memang terlihat, **sebelum** membuang dua minggu menguji.

### Bahasa dan heatmap

Shopify menyajikan halaman yang sama pada dua alamat berbeda per bahasa:

```
/products/organic-moringa-capsules        (Inggris)
/id/products/organic-moringa-capsules/    (Indonesia — ±84% trafik)
```

Keduanya punya heatmap **sendiri-sendiri**, karena tinggi halaman dan panjang teksnya berbeda. Di halaman Audit, pilih alamat yang trafiknya paling besar — biasanya versi `/id/`. Ini juga alasan lain kenapa terjemahan variant B wajib beres sebelum test jalan (§4).

---

## 12. Setelah test jalan: 10 menit pertama

Test yang tidak terlacak terlihat persis seperti test yang sepi. Karena itu jangan tinggalkan test yang baru dinyalakan sebelum tiga hal ini terbukti.

**1. Variant B benar-benar tampil.** Buka halaman produk yang ditargetkan di ponsel, dalam mode penyamaran. Kalau kamu masuk grup B, alamatnya akan berubah sendiri menjadi `?view=<suffix>`. Ulangi beberapa kali dengan jendela penyamaran baru sampai kamu pernah melihat kedua variant.

**2. Angka pengunjung mulai bergerak.** Buka halaman eksperimen di dashboard. Dalam 10 menit pertama, "Pengunjung terpapar" A dan B harus sudah lebih dari nol. Kalau tetap nol padahal kamu sendiri sudah membuka halamannya, ada yang salah — jangan biarkan semalaman.

**2b. Web pixel hijau.** Buka `Settings → Customer events` di Shopify Admin. Pixel **A/B Test Treelogy** harus bertitik **hijau**, bukan abu-abu. Titik abu-abu berarti pixel terdaftar tapi tidak berjalan, dan langkah "Mulai checkout" akan selalu nol. Halaman eksperimen juga menampilkan peringatan ini lengkap dengan tombol **Aktifkan web pixel**.

**3. Acuan PostHog tersambung.** Di panel **Acuan PostHog** pada halaman yang sama:

- Statusnya **berjalan di PostHog**, bukan "Belum tersambung"
- **Tidak ada** peringatan antrean event tertunda
- Kalau ada pesan sinkronisasi gagal, tekan **Sinkronkan**

Lalu buka **Audit lengkap**. Dalam 10–15 menit pertama sudah harus terlihat pageview, klik, dan sesi replay pertama. Heatmap butuh sedikit lebih banyak kunjungan sebelum polanya terbaca.

### Kalau angkanya tetap nol

Urutan pemeriksaan, dari yang paling sering jadi penyebab:

1. **App embed mati.** `Online Store → Themes → Customize → App embeds → "A/B Test PDP"` harus menyala.
2. **Produk tidak masuk target.** Cek daftar handle di pengaturan eksperimen.
3. **Produk memakai template khusus lain.** Produk yang memakai `product.context.europe` sengaja tidak pernah ikut test.
4. **Kamu sendiri dikecualikan.** Crawler, Lighthouse, dan mode otomasi selalu melihat variant A. Kalau kamu sedang memakai alat semacam itu, kamu tidak akan pernah masuk grup B.
5. **Kill switch aktif.** Panel aksi di halaman eksperimen. Kill switch menghentikan pembagian variant, tapi **tidak** menghentikan heatmap dan replay — jadi kalau heatmap jalan sementara pengunjung terpapar nol, kemungkinan besar inilah penyebabnya.

### Sinyal bahaya yang membatalkan test

Dashboard menampilkannya sendiri, tapi kenali artinya:

| Peringatan | Artinya | Yang harus dilakukan |
|---|---|---|
| **Sample Ratio Mismatch** | Pembagian menyimpang jauh dari yang diminta | Hentikan. Jangan simpulkan apa pun. |
| **Bucketing tidak sinkron** | Hitungan browser dan server berbeda | Hentikan. Ini bug, bukan hasil. |
| **Template variant B berubah saat test berjalan** | Ada yang mengedit variant B di tengah jalan | Mulai ulang dari nol. |
| **Antrean event tertunda terus naik** | PostHog tidak bisa dihubungi | Angka lokal tetap benar; tekan Sinkronkan setelah pulih. |

---

## 13. Sebelum test sungguhan: jalankan A/A dulu

Buat satu eksperimen yang variant B-nya **salinan persis** variant A — suffix baru, isi sama. Jalankan 3–5 hari.

Yang sedang diuji di sini bukan desain, melainkan pipelinenya sendiri. Kalau muncul SRM, bucket drift, atau selisih konversi yang signifikan padahal kedua halaman identik, berarti ada yang rusak. Jauh lebih murah ketahuan sekarang daripada setelah kamu mengambil keputusan desain senilai dua minggu kerja.

A/A yang sehat terlihat begini: selisih konversi kecil dan tidak signifikan, split mendekati target, nol bucket drift, dan heatmap kedua sisi mirip.
