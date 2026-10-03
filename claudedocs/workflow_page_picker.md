# Workflow — Page Picker, Snapshot, dan Audit Tracking

Tanggal: 2026-09-04

Mengubah alur dari "isi form template suffix" menjadi wizard: **pilih halaman →
pilih sumber variant B → lihat snapshot → audit tracking → jalankan**.

---

## 1. Kelayakan yang sudah dibuktikan (bukan asumsi)

| Kemampuan | Cara | Bukti |
|---|---|---|
| Ambil HTML theme **live** | `GET https://treelogy.com/<path>` | 200, 654 KB |
| Ambil HTML theme **preview** | `?preview_theme_id=<id>&_fd=0&_ab=0` + cookie jar + ikuti redirect | 200, 484 KB, `Shopify.theme.role = "unpublished"` |
| Daftar & checksum file theme | `theme(id).files { filename checksumMd5 }` | query tersedia di Admin API 2026-07 |
| Deteksi tracking | pencocokan signature pada HTML | 7 tracker terdeteksi di homepage, ID terbaca: `GTM-5M855J4V`, `AW-11239241094` |

**Temuan penting:** preview theme bisa diambil **tanpa token Admin** — Shopify
memang membuatnya `previewable`. Jadi snapshot dan audit tracking berjalan penuh
dari Vercel, tidak perlu bolak-balik ke bridge.

**Temuan penting kedua:** token offline **kedaluwarsa tiap 1 jam** dan di-refresh
otomatis oleh library di Fly. Terbukti saat token lama mati lalu bridge tetap
membalas `ok` dengan token baru. Konsekuensinya mutlak: apa pun yang butuh Admin
API **harus** lewat bridge. Dashboard tidak boleh menyimpan token sama sekali.

---

## 2. Alur wizard

```
① PILIH HALAMAN
   Tipe halaman  → home / product / collection / page / blog / article / search
   Contoh nyata  → /products/kapsul-moringa-60
   Sumber: template dari theme live + resource nyata dari Admin API

② PILIH SUMBER VARIANT B
   (a) Theme preview yang sudah ada   ← alur kerja kamu sekarang, 18 theme tersedia
   (b) Alternate template baru        ← salin dari live, digarap di theme editor

③ SNAPSHOT BERDAMPINGAN
   A = theme live            B = theme preview / alternate template
   Ditampilkan sebagai halaman sungguhan, bukan gambar
   + diff file theme, diklasifikasi aman / perlu isolasi / tidak bisa

④ AUDIT TRACKING
   Apa saja yang menyala di halaman itu, dan mana yang tahu soal A/B test

⑤ KONFIGURASI & JALANKAN
   Metric, MDE, split, sample size
```

---

## 3. Bagian tersulit: preview theme → alternate template

Alur kerja kamu sekarang: duplikat theme, edit, preview. Tapi A/B test butuh
**kedua variant hidup bersamaan di theme yang sama**. Jadi isi preview theme harus
dipindahkan ke theme live sebagai alternate template.

Di sinilah letak jebakannya. Diff antara live dan preview harus **diklasifikasi**,
karena tidak semua perubahan bisa dipindahkan dengan aman:

| Yang berubah | Klasifikasi | Alasan |
|---|---|---|
| `templates/*.json` saja | ✅ **AMAN** | template baru berdiri sendiri, variant A tidak tersentuh |
| `sections/*.liquid`, `snippets/*.liquid` | ⚠ **PERLU ISOLASI** | file ini dipakai bersama; menimpanya mengubah variant A juga |
| `assets/*.css`, `assets/*.js` | ⛔ **TIDAK BISA** | dimuat global oleh layout, mustahil dipisah per template |
| `layout/theme.liquid` | ⛔ **TIDAK BISA** | membungkus seluruh halaman, termasuk variant A |
| `config/settings_data.json` | ⛔ **TIDAK BISA** | setting theme berlaku ke seluruh toko |

### Isolasi otomatis untuk kasus ⚠

Kalau yang berubah hanya section/snippet, tool menyalinnya dengan **nama baru**
lalu menulis ulang rujukan di template B:

```
preview: sections/MainProductDetail.liquid  (diubah)
         templates/product.json             (diubah)

live   : sections/MainProductDetail.liquid       ← TIDAK disentuh, milik variant A
         sections/MainProductDetail-abb.liquid   ← salinan dari preview
         templates/product.ab-b.json             ← type-nya ditulis ulang ke -abb
```

Variant A tetap utuh byte-per-byte. Rujukan `{% render %}` dan `{% section %}` di
dalam file yang diisolasi ikut ditelusuri satu tingkat; kalau ia merujuk snippet
yang **juga** berubah, snippet itu ikut diisolasi.

Kalau penelusuran menemukan perubahan pada file kategori ⛔, proses **berhenti** dan
menjelaskan file mana yang bermasalah. Lebih baik menolak daripada diam-diam
mengubah tampilan variant A dan membuat seluruh hasil test tidak berarti.

---

## 4. Snapshot: kenapa script dibuang

Snapshot dirender dari HTML sungguhan di dalam iframe ber-sandbox, bukan gambar —
supaya bisa di-scroll dan responsif.

Tapi seluruh tag `<script>` **dibuang** sebelum ditampilkan, karena:

1. **Mencemari data analitik kamu.** Halaman toko memuat GA4, GTM, Google Ads, Meta
   Pixel, dan Klaviyo. Kalau dibiarkan hidup, setiap kali seseorang membuka preview
   di dashboard, semua tracker itu ikut menyala dan tercatat sebagai kunjungan
   sungguhan. Sepuluh kali buka preview = sepuluh pageview palsu di GA4 kamu.
2. Script theme bisa melakukan redirect atau membuka cart drawer di dalam iframe.
3. Yang ingin dilihat adalah tata letak dan gaya, dan itu urusan CSS.

`<base href="https://treelogy.com/">` disisipkan supaya CSS, font, dan gambar tetap
termuat dari CDN Shopify. Iframe diberi `sandbox` tanpa `allow-same-origin`.

---

## 5. Audit tracking

Dua sumber digabung:

1. **Signature pada HTML** — 16 tracker dikenali: GA4, GTM, Google Ads, Meta, TikTok,
   Pinterest, Snap, Klaviyo, Hotjar, Clarity, Criteo, Bing, LinkedIn, X, Shopify
   Analytics, Shopify Web Pixels. ID diekstrak kalau ada.
2. **Admin API** — web pixel dan script tag yang terdaftar resmi.

Yang ditampilkan bukan sekadar daftar, tapi **jawaban atas pertanyaan yang penting**:
tracker mana yang tahu tentang variant A/B, dan mana yang tidak.

| Sumber | Tahu variant? | Keterangan |
|---|---|---|
| Webhook `orders/paid` app ini | ✅ sumber kebenaran | lewat cart attribute |
| Web pixel app ini | ✅ | baca cookie `_tl_ab_last` |
| GA4 / GTM / Meta / TikTok milik toko | ❌ | tetap mencatat, tapi tidak bisa memisahkan A dan B |

Ini penting supaya tidak ada yang mengira GA4 akan otomatis memisahkan hasil test.

---

## 6. Pembagian tanggung jawab

| Kemampuan | Di mana | Alasan |
|---|---|---|
| Ambil HTML live & preview | Vercel | publik, tidak butuh token |
| Deteksi tracker | Vercel | murni parsing teks |
| Render snapshot | Vercel | route proxy + iframe sandbox |
| Daftar theme & file | **Bridge** | butuh token Admin |
| Diff & klasifikasi | **Bridge** | butuh isi file |
| Buat template B + isolasi | **Bridge** | menulis ke theme |

---

## 7. Urutan implementasi

1. Bridge: aksi `themes.list`, `theme.pages`, `theme.diff`, `theme.prepareVariant`
2. Vercel: `lib/storefront.ts` (fetch live/preview), `lib/trackers.ts` (16 signature)
3. Route `/api/snapshot` — proxy HTML, buang script, sisipkan base href
4. Wizard 5 langkah dengan indikator progres
5. Sambungkan ke pembuatan eksperimen
6. Verifikasi ujung-ke-ujung pada halaman produk sungguhan


---

## 8. Hasil implementasi — 2026-09-04

Semua diverifikasi terhadap toko sungguhan, bukan data contoh.

| Yang diuji | Hasil |
|---|---|
| `themes.list` | 19 theme terbaca |
| `theme.pages` | 42 template, 14 tipe halaman (24 di antaranya alternate template `page.*`) |
| `theme.diff` live vs "Kotak Ringkasan 3 Baris" | 6 aman · 22 perlu isolasi · **3 blokir** |
| Penemuan URL contoh | 6 tipe halaman dapat URL nyata dari sitemap |
| Deteksi tracker di halaman produk | 7 tracker, ID terbaca `GTM-5M855J4V`, `AW-11239241094` |
| `/api/snapshot` tanpa login | HTTP 401 |
| Script dibuang dari snapshot | 0 tag `<script>` tersisa, `<base href>` tersisip |

### Nilai yang langsung terbukti

Theme preview "Kotak Ringkasan 3 Baris (27 Agu)" **tidak bisa** dipakai sebagai
variant B: `layout/theme.liquid`, `locales/en.default.json`, dan `locales/id.json`
ikut berubah. Ketiganya berlaku untuk seluruh halaman dan tidak bisa dipisahkan per
template.

Tanpa pemeriksaan ini, template-nya akan tersalin, perubahan layout tidak ikut, dan
variant B di theme live tampil berbeda dari yang dilihat di preview — tanpa error,
tanpa peringatan, sampai hasil test terlanjur dipakai mengambil keputusan.

### Bug yang ditemukan dan diperbaiki saat implementasi

| # | Masalah | Perbaikan |
|---|---|---|
| 1 | `npm ci` gagal di Fly: `@emnapi/*` adalah dependency opsional khusus Linux yang tidak tercatat di lockfile buatan macOS | `npm install` di tahap deps, dengan alasannya ditulis di Dockerfile |
| 2 | Manifest workspace `extensions/tl-ab-pixel/package.json` tidak ikut ter-COPY padahal tercatat di lockfile | disalin eksplisit sebelum install |
| 3 | Flag regex `/s` butuh target ES2018 | diganti `[\s\S]` |
| 4 | URL sub-sitemap kehilangan query string `?from=&to=` | dipakai `pathname + search` |
| 5 | `&amp;` di XML sitemap tidak di-decode sehingga query rusak | di-decode sebelum di-parse |

### Catatan yang belum ditindaklanjuti

`package-lock.json` masuk `.gitignore` (bawaan template Shopify). Untuk build yang
benar-benar dapat direproduksi, lockfile seharusnya ikut di-commit — tanpa itu, dua
mesin bisa menghasilkan pohon dependency berbeda dari `package.json` yang sama.
