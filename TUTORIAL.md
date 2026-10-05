# Tutorial: dari Figma ke halaman Astro

Tutorial ini membawa Anda dari nol sampai satu halaman Figma menjadi halaman Astro yang identik di desktop (1440), tablet (834) dan mobile (393).

## Yang dibutuhkan

- Node.js 22.12 atau lebih baru
- Figma **desktop** (bukan browser), dengan akses Dev Mode
- Agent yang membaca skill: omp atau Claude Code
- Opsional: GitHub CLI (`gh`)

## 1. Buat situs baru

Pilih salah satu:

```bash
# A. Sebagai repo GitHub Anda sendiri
gh repo create situs-saya --private --template myuzara02/figma-slice-slicer --clone

# B. Tanpa GitHub
npx degit myuzara02/figma-slice-slicer situs-saya
```

Lalu:

```bash
cd situs-saya
npm install        # juga mengunduh Chromium untuk visual check
npm run dev        # buka http://localhost:4321/style-guide/ untuk melihat base Relume
```

## 2. Siapkan desain di Figma

Skill mengandalkan file Figma yang rapi. Pastikan:

1. **Satu halaman = satu node berisi tiga frame**: desktop 1440, tablet 834, mobile 393.
2. **Anak langsung tiap frame adalah Section** (hero, features, footer, …) dengan **nama yang sama** di ketiga frame. Kalau berbeda, skill akan bertanya.
3. **Nilai memakai Figma Variables** (font size, spacing, radius, warna), dengan satu mode per Breakpoint untuk variable responsif.

## 3. Export Variables ke folder `figma/`

Export Variables dari Figma (format `.tokens.json`, yang berisi `$extensions` `com.figma.*`) dan susun seperti ini:

```text
figma/
  modes/
    desktop.tokens.json     ← satu file per mode collection responsif
    tablet.tokens.json
    mobile.tokens.json
  static.json               ← collection satu mode: warna, font family, weight
  token-map.json            ← pemetaan nama variable Figma → Token Relume
```

Nama mode dibaca dari isi file, bukan dari nama file.

**`token-map.json`** memetakan path variable Figma ke nama Token Relume lewat aturan prefix. Contoh minimal:

```json
{
  "modes": { "desktop": "desktop", "tablet": "tablet", "mobile": "mobile" },
  "variables": {
    "rules": [
      { "prefix": "font-size/heading/", "token": "--_typography---font-size--" },
      { "prefix": "spacing/", "token": "--_sizing---space--" },
      { "prefix": "color/", "token": "--_primitives---colors--" }
    ],
    "aliases": {}
  }
}
```

`modes` berisi nama mode **persis seperti di Figma** (misalnya `"dekstop"` kalau di Figma tertulis begitu). Variable yang belum terpetakan akan dilaporkan oleh skill, jadi Token Map bisa dilengkapi sambil jalan.

## 4. Nyalakan Figma MCP

1. Buka file desain di Figma desktop.
2. Masuk Dev Mode, lalu aktifkan **MCP server** (berjalan di `http://127.0.0.1:3845/mcp`).
3. Biarkan Figma tetap terbuka selama skill bekerja.

## 5. Slice halaman

1. Di Figma, klik kanan node halaman (yang berisi ketiga frame) → **Copy link to selection**.
2. Buka agent di folder `situs-saya`, lalu ketik:

```text
/figma-slice slice halaman ini: <link Figma>
```

Agent akan bekerja sendiri:

1. Membuat `src/styles/tokens.css` dari export di `figma/`.
2. Mencari semua Section di ketiga frame dan mengunduh asset ke `src/assets/<section>/`.
3. Membangun satu komponen per Section di `src/components/content/`, navbar dan footer di `src/layouts/Page.astro`, dan halamannya di `src/pages/`.
4. Membandingkan hasil dengan Figma (gambar di `visual-check/`), mengecek teks dan scroll horizontal.
5. Menutup dengan laporan.

### Agent hanya berhenti untuk dua hal

| Pertanyaan | Jawaban Anda |
|---|---|
| Nama Section tidak sama di ketiga frame (contoh `Alt - 01` vs `header`) | Sebutkan mana yang sepasang, atau rename di Figma |
| Warna di export berbeda dari Figma live (export basi) | Export ulang, atau setujui memakai warna live |

Semua keputusan dicatat di `.agents/skills/figma-slice/SKILL.md` bagian **This project**, jadi sesi berikutnya tidak bertanya ulang.

## 6. Periksa hasil

```bash
npm run dev
```

- Buka halaman di 1440, 834, 393 dan lebih lebar (misalnya 1920).
- Lihat `visual-check/<section>/{desktop,tablet,mobile}.png`: kiri Figma, kanan Astro.
- Baca laporan agent:

| Bagian | Isi |
|---|---|
| New variables | Token baru di Token Map / tokens.css |
| New components | Komponen yang dibuat atau diperluas |
| Guesses | Yang ditebak agent (warna tanpa peran, asset pengganti) |
| Unbound values | Nilai di Figma yang tidak memakai variable |
| Mode Pin | Bagian yang memakai mode Breakpoint lain |
| Visual check | Hasil cek dan perbedaan yang masih terlihat |
| MCP calls | Pemakaian kuota MCP |
| Still open | Pertanyaan untuk desain atau Anda |

Minta agent memperbaiki yang belum cocok. Perbedaan yang asalnya dari desain (misalnya teks beda antar frame) dijawab sebagai keputusan, lalu agent mencatatnya.

## 7. Halaman berikutnya

Ulangi langkah 5 dengan link halaman lain. Komponen yang sudah ada dipakai ulang, dan hasil MCP yang sudah tersimpan di `.figma-cache/` tidak dipanggil lagi.

## Tips

- **Commit `.figma-cache/`**: menjalankan ulang jadi gratis. Kuota desktop MCP terbatas (sekitar 200 panggilan per hari; satu homepage 13 Section ≈ 70–90 panggilan pertama kali).
- **Build**: `npm run build` menghasilkan `dist/` tanpa atribut debug `data-figma-node`.
- **Kalau ada yang salah**: kirim pesan error ke agent; ia akan membaca skill dan memperbaikinya.

## Masalah umum

| Gejala | Penyebab / solusi |
|---|---|
| `ECONNREFUSED 127.0.0.1:3845` | Figma desktop tertutup atau MCP server belum aktif |
| `UNMAPPED Figma Variables` | Tambahkan aturan atau alias di `figma/token-map.json` |
| `no Token Mode export named …` | Nama di `modes` pada Token Map tidak sama dengan nama mode di Figma |
| `STOP: tokens.css not written` | Export warna basi: export ulang atau setujui warna live |
| Visual check `NOT CHECKED` | Class pembungkus Section tidak bernama `<section>_wrap`; agent memakai `--selector` |
