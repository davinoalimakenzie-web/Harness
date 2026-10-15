/* =========================================================
   nava-trader.js - Antarmuka Nava Trader (mobile-first)

   Berada di Lainnya > Alat, satu baris dengan Kalkulator
   Servis HP dan Catatan/Pengingat.

   Yang ditampilkan:
     - IHSG (indeks) + watchlist
     - Verdict tiap saham: Beli / Tunggu / Jual / Tidak Ada Setup
     - Alasan, sumber data, waktu data, area masuk, batas rugi,
       target, dan risiko
     - Backtest + paper trading (HASIL SETELAH BIAYA)
     - Pengubahan strategi WAJIB lewat usulan + persetujuan

   TIDAK ADA transaksi otomatis. Tidak ada koneksi ke bursa
   untuk tujuan eksekusi. Semua hanya laporan dan simulasi.

   Data: EOD (End of Day) / Delayed dari Yahoo Finance.
   Diberi label jelas di mana-mana. Tidak pernah diklaim real-time.

   Struktur modul mengikuti modul Mas Cim (overlay layar penuh)
   supaya konsisten dengan aplikasi.
   ========================================================= */
(function (w) {
  'use strict';

  var $ = function (s) { return w.document.querySelector(s); };
  var $$ = function (s) { return [].slice.call(w.document.querySelectorAll(s)); };
  var C = function () { return w.NavaTraderCore; };
  // Modul kutipan real-time (intraday) - harga terkini saat bursa buka.
  var Q = function () { return w.NavaTraderQuote; };
  // Modul analisa fundamentals lanjutan (Valuation, Cash Flow, Utang, dll).
  var F = function () { return w.NavaTraderFund; };

  var M = {
    view: 'home',
    pasar: null,
    hasil: null,
    meta: null,
    cari: '',
    filter: 'Semua',
    muat: false,
    galat: null,
    // upgrade tampilan detail: simpan kode saham yang detail terbuka
    detail: null
  };

  var VERDICT_LIST = ['Semua', 'Beli', 'Tunggu', 'Jual', 'Tidak Ada Setup'];

  /* ---------------------------------------------------------
     FORMAT
     --------------------------------------------------------- */

  function rp(n) {
    var v = Number(n);
    if (!isFinite(v)) return '-';
    return 'Rp' + Math.round(v).toLocaleString('id-ID');
  }

  function angka(n, d) {
    var v = Number(n);
    if (!isFinite(v)) return '-';
    return v.toFixed(d === undefined ? 2 : d);
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toast(msg) {
    if (w.App && w.App.toast) w.App.toast(msg, 2600);
  }

  function verdictClass(v) {
    return v === 'Beli' ? 'nt-buy' : v === 'Jual' ? 'nt-sell' :
           v === 'Tunggu' ? 'nt-wait' : 'nt-none';
  }

  /* ---------------------------------------------------------
     MUAT DATA PASAR (dari berkas market.json, origin sama)
     --------------------------------------------------------- */

  var DATA_URL = 'data/market.json';

  function muatPasar() {
    M.muat = true; M.galat = null; render();
    if (typeof w.fetch !== 'function') {
      M.galat = 'Browser ini tidak mendukung fetch.';
      M.muat = false; render(); return;
    }
    w.fetch(DATA_URL + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (json) {
        M.pasar = C().muatPasar(json);
        M.meta = M.pasar.meta;
        M.hasil = C().analisaSemua(M.pasar);
        M.muat = false;
        render();
      })
      .catch(function (e) {
        M.muat = false;
        M.galat = 'Gagal memuat data pasar: ' + (e && e.message ? e.message : e);
        render();
      });
  }

  /* ---------------------------------------------------------
     RINGKASAN VERDICT
     --------------------------------------------------------- */

  function hasilTersaring() {
    var list = (M.hasil && M.hasil.hasil) || [];
    var q = M.cari.trim().toUpperCase();
    return list.filter(function (a) {
      if (M.filter !== 'Semua' && a.verdict !== M.filter) return false;
      if (!q) return true;
      return (a.kode || '').toUpperCase().indexOf(q) >= 0 ||
             (a.nama || '').toUpperCase().indexOf(q) >= 0;
    });
  }

  function kartuRingkas() {
    if (M.hasil) return C().ringkasVerdict(M.hasil.hasil);
    return { 'Beli': 0, 'Tunggu': 0, 'Jual': 0, 'Tidak Ada Setup': 0 };
  }

  /* ---------------------------------------------------------
     KESEGARAN DATA - ganti "basi senyap" jadi "basi yang terlihat"
     --------------------------------------------------------- */

  function Kesegaran() { return w.NavaKesegaran || null; }

  /**
   * Nilai kesegaran data pasar (EOD). Memakai NavaKesegaran kalau
   * tersedia; kalau modul belum termuat, hitung kasar dari tanggal
   * agar tetap tidak diam-diam menampilkan angka basi tanpa catatan.
   */
  function kesegaranPasar() {
    var meta = M.meta || {};
    var K = Kesegaran();
    if (K && K.nilai) return K.nilai(meta.terakhirOleh);
    // Fallback konservatif: bila tidak ada tanggal, tandai tidak diketahui.
    if (!meta.terakhirOleh) {
      return {
        status: 'tidak diketahui', warna: 'warn', sesiTerlewat: null,
        label: 'Tanggal data tidak diketahui',
        detail: 'Data pasar tidak mencantumkan tanggal terakhir.'
      };
    }
    return {
      status: 'tidak diketahui', warna: 'warn', sesiTerlewat: null,
      label: 'Data per ' + meta.terakhirOleh,
      detail: 'Modul kesegaran belum termuat, status belum bisa dipastikan.'
    };
  }

  /** Simbol yang datanya tertinggal dari yang lain (mis. IHSG). */
  function tertinggalData() {
    return (M.meta && Array.isArray(M.meta.tertinggal)) ? M.meta.tertinggal : [];
  }

  /**
   * Banner peringatan kesegaran. Hanya muncul kalau memang ada
   * masalah (terlambat / tidak diketahui / ada simbol tertinggal),
   * supaya tidak membosankan saat data sedang segar.
   */
  function bannerKesegaran() {
    var seg = kesegaranPasar();
    var tert = tertinggalData();
    var perluPeringat = seg.status === 'terlambat' ||
                        seg.status === 'tidak diketahui' ||
                        tert.length > 0;
    if (!perluPeringat) return '';

    var h = '';
    h += '<div class="nt-card nt-banner-kesegaran nt-kes-' + esc(seg.warna || 'warn') + '">';
    h += '<div class="nt-card-title">Perhatian: Kesegaran Data</div>';

    if (seg.status === 'terlambat' || seg.status === 'tidak diketahui') {
      h += '<div class="nt-note"><b>' + esc(seg.label) + '</b> - ' + esc(seg.detail) + '</div>';
    }
    if (tert.length) {
      var nama = tert.map(function (t) {
        return t.kode + ' (' + t.tanggal + ', tertinggal dari ' + t.tertinggalDari + ')';
      }).join(', ');
      h += '<div class="nt-note">Bar terakhir simbol berikut lebih tua dari data terbaru: ' +
           esc(nama) + '. Angka untuk simbol itu ditampilkan apa adanya ' +
           'dengan tanggalnya, jangan disamakan dengan yang lain.</div>';
    }
    h += '<div class="nt-note">Sumber data: ' +
         esc(M.meta && M.meta.sumber ? M.meta.sumber.nama : 'Yahoo Finance (EOD)') +
         '. Untuk harga terkini saat bursa buka, pakai tombol Refresh Harga Real-time.</div>';
    h += '</div>';
    return h;
  }

  /* ---------------------------------------------------------
     LAYAR: BERANDA
     --------------------------------------------------------- */

  function layarHome() {
    var ih = M.hasil ? M.hasil.ihsg : null;
    var k = kartuRingkas();
    var s = C().strategiLoad();

    var h = '';

    // --- Peringatan kesegaran data (tampil hanya bila ada masalah) ---
    h += bannerKesegaran();

    // --- Sumber & waktu data (WAJIB terlihat, tidak disembunyikan) ---
    h += '<div class="nt-src">';
    h += '<div class="nt-src-row"><b>Sumber</b> ' +
         esc(M.meta && M.meta.sumber ? M.meta.sumber.nama : 'Tidak diketahui') + '</div>';
    h += '<div class="nt-src-row"><b>Jenis</b> <span class="nt-badge nt-delayed">' +
         esc(M.meta && M.meta.sumber ? M.meta.sumber.jenis : 'EOD / Delayed') +
         '</span> <span class="nt-warnmini">bukan real-time</span></div>';
    h += '<div class="nt-src-row"><b>Data terakhir</b> ' +
         esc(M.meta && M.meta.terakhirOleh ? M.meta.terakhirOleh : '-') + '</div>';
    // Status kesegaran selalu tampil (bukan hanya saat bermasalah),
    // supaya jelas angka ini seberapa baru.
    var seg = kesegaranPasar();
    h += '<div class="nt-src-row"><b>Kesegaran</b> <span class="nt-badge nt-kes-' +
         esc(seg.warna || 'warn') + '">' + esc(seg.label) + '</span></div>';
    if (M.meta && M.meta.diambilPada) {
      var t = new Date(M.meta.diambilPada);
      h += '<div class="nt-src-row"><b>Diambil</b> ' +
           esc(isNaN(t) ? M.meta.diambilPada : t.toLocaleString('id-ID')) + '</div>';
    }
    h += '<div class="nt-src-row"><b>Jumlah saham</b> ' +
         ((M.pasar && M.pasar.saham ? M.pasar.saham.length : 0)) + ' simbol</div>';
    h += '</div>';

    // --- IHSG ---
    h += '<div class="nt-card nt-ihsg">';
    if (ih && ih.tersedia) {
      h += '<div class="nt-ihsg-top">';
      h += '<div><div class="nt-ihsg-label">IHSG</div>' +
           '<div class="nt-ihsg-price">' + angka(ih.harga, 2) + '</div>' +
           // Tanggal data IHSG sendiri. Penting karena ^JKSE sering
           // tertinggal satu sesi dari saham, jadi angkanya bisa beda
           // dengan baris saham di bawah.
           '<div class="nt-ihsg-tgl">Data ' +
           esc(ih.waktuData || (M.meta && M.meta.terakhirOleh) || '-') + '</div></div>';
      h += '<div class="nt-ihsg-side">' +
           '<div class="nt-chg ' + (ih.chg >= 0 ? 'up' : 'down') + '">' +
           (ih.chg >= 0 ? '▲ +' : '▼ ') + angka(ih.chg, 2) + '%</div>' +
           '<div class="nt-tren">' + ih.emoji + ' ' + esc(ih.tren) + '</div></div>';
      h += '</div>';
      h += '<div class="nt-kv"><span>Skor teknikal</span><b>' + angka(ih.skor, 1) + '</b></div>';
      h += '<div class="nt-kv"><span>RSI (14)</span><b>' + angka(ih.rsi14, 1) + '</b></div>';
      h += '<div class="nt-kv"><span>SMA20 / SMA50</span><b>' +
           angka(ih.sma20, 0) + ' / ' + angka(ih.sma50, 0) + '</b></div>';
      h += '<div class="nt-note">' + esc(ih.ringkasan) + '</div>';
      // Harga intraday di bawah harga EOD, bila sudah diambil.
      if (Q() && Q().barisLive) {
        try { h += Q().barisLive('IHSG'); } catch (err) { /* noop */ }
      }
    } else {
      h += '<div class="nt-note">Data IHSG belum tersedia.</div>';
    }
    h += '</div>';

    // --- Data real-time (intraday) ---
    // Panel refresh + overlay harga live. Bila Q() belum termuat
    // (mis. skrip gagal), panelnya dilewati diam-diam supaya
    // tampilan sisa tetap utuh.
    if (Q() && Q().panelRefresh) {
      try { h += Q().panelRefresh(codesWatchlist()); } catch (err) { /* noop */ }
    }

    // --- Ringkasan verdict ---
    h += '<div class="nt-card">';
    h += '<div class="nt-card-title">Ringkasan Sinyal</div>';
    h += '<div class="nt-sum">';
    VERDICT_LIST.slice(1).forEach(function (v) {
      h += '<button class="nt-sumcell ' + verdictClass(v) + '" data-nv-filter="' + esc(v) + '">' +
           '<b>' + (k[v] || 0) + '</b><span>' + esc(v) + '</span></button>';
    });
    h += '</div>';
    h += '<div class="nt-note">Ketuk untuk menyaring daftar di bawah.</div>';
    h += '</div>';

    // --- Strategi aktif ---
    h += '<div class="nt-card">';
    h += '<div class="nt-card-title">Strategi Aktif</div>';
    h += '<div class="nt-kv"><span>Nama</span><b>' + esc(s.nama) + '</b></div>';
    h += '<div class="nt-kv"><span>Versi</span><b>v' + esc(s.versi) + '</b></div>';
    h += '<div class="nt-kv"><span>Status</span><b class="' +
         (s.status === 'Aktif' ? 'nt-ok' : 'nt-warnmini') + '">' + esc(s.status) + '</b></div>';
    h += '<div class="nt-kv"><span>Ambang Beli</span><b>skor ≥ ' + esc(s.minSkorEntry) + '</b></div>';
    h += '<div class="nt-kv"><span>Ambang Jual</span><b>skor ≤ ' + esc(s.minSkorJual) + '</b></div>';
    h += '<div class="nt-kv"><span>Risk/Reward min</span><b>' + esc(s.rrMinimal) + 'x</b></div>';
    h += '<div class="nt-rowbtns">';
    h += '<button class="nt-b nt-b-ghost" data-nv-go="strategi">Ubah Strategi</button>';
    h += '<button class="nt-b nt-b-ghost" data-nv-go="backtest">Backtest</button>';
    h += '<button class="nt-b nt-b-ghost" data-nv-go="alert">🔔 Notifikasi</button>';
    h += '</div>';
    h += '<div class="nt-note">Perubahan strategi hanya berlaku setelah kamu menyetujuinya.</div>';
    h += '</div>';

    // --- Daftar saham (ringkas) ---
    var list = hasilTersaring();
    h += '<div class="nt-card">';
    h += '<div class="nt-card-title">Watchlist &amp; Analisa (' + list.length + ')</div>';
    h += '<input class="nt-search" id="ntSearch" placeholder="Cari kode atau nama saham..." ' +
         'value="' + esc(M.cari) + '" inputmode="search" autocomplete="off">';
    h += '<div class="nt-chips">';
    VERDICT_LIST.forEach(function (v) {
      h += '<button class="nt-chip' + (M.filter === v ? ' on' : '') +
           '" data-nv-filter="' + esc(v) + '">' + esc(v) + '</button>';
    });
    h += '</div>';

    if (!list.length) {
      h += '<div class="nt-empty">Tidak ada saham yang cocok dengan filter.</div>';
    } else {
      h += '<div class="nt-list">';
      list.forEach(function (a) { h += barisSaham(a); });
      h += '</div>';
    }
    h += '</div>';

    // --- Disclaimer ---
    h += '<div class="nt-card nt-disclaimer">';
    h += '<b>⚠️ Penting</b>';
    h += '<p>Alat bantu riset, <b>bukan nasihat keuangan</b>. Aplikasi ini ' +
         'tidak pernah mengirim order ke bursa. Semua keputusan dan ' +
         'eksekusi transaksi adalah tanggung jawab Anda sepenuhnya.</p>';
    h += '<p>Data bersifat EOD/Delayed. Harga,fundamental, dan kondisi pasar ' +
         'bisa berubah setiap hari. Verifikasi ke sumber resmi IDX sebelum bertindak.</p>';
    h += '</div>';

    return h;
  }

  function barisSaham(a) {
    var h = '';
    h += '<button class="nt-row ' + verdictClass(a.verdict) + '" data-nv-detail="' + esc(a.kode) + '">';
    h += '<div class="nt-row-left">';
    h += '<div class="nt-row-kode">' + esc(a.kode) +
         (a.watchlist ? '<span class="nt-star">★</span>' : '') + '</div>';
    h += '<div class="nt-row-nama">' + esc(a.nama) +
         (a.bandaran && a.bandaran.ada
           ? (function () {
               var st = a.bandaran.status;
               var up = st.indexOf('Akumulasi') === 0;
               var dn = st.indexOf('Distribusi') === 0;
               var cls = up ? 'up' : dn ? 'down' : 'flat';
               var gl = up ? '▲' : dn ? '▼' : '■';
               var lab = st.replace('Akumulasi ', 'Ak. ').replace('Distribusi ', 'Dist. ');
               return '<span class="nt-bmini ' + cls + '">' + gl + ' ' + esc(lab) + '</span>';
             })()
           : '') +
         '</div>';
    h += '</div>';
    h += '<div class="nt-row-right">';
    h += '<div class="nt-row-harga">' + (a.level ? rp(a.level.harga) : '-') + '</div>';
    // Harga intraday (bila sudah diambil refresh), tetap satu baris ringkas.
    if (Q() && Q().hargaLive && Q().hargaLive(a.kode)) {
      try {
        var lq = Q().hargaLive(a.kode);
        h += '<div class="nt-row-live">' + lq.labelData + ' ' +
             Math.round(Number(lq.harga) || 0).toLocaleString('id-ID') + '</div>';
      } catch (err) { /* noop */ }
    }
    h += '<div class="nt-row-verdict"><span class="nt-tag ' + verdictClass(a.verdict) + '">' +
         a.emoji + ' ' + esc(a.verdict) + '</span></div>';
    h += '</div>';
    h += '</button>';
    return h;
  }

  /* ---------------------------------------------------------
     LAYAR: DETAIL SAHAM
     --------------------------------------------------------- */

  function cariAnalisa(kode) {
    var list = (M.hasil && M.hasil.hasil) || [];
    for (var i = 0; i < list.length; i++) if (list[i].kode === kode) return list[i];
    return null;
  }

  /* Kartu bandarmology: status akumulasi/distribusi + area Dukung (PnV).
   * Data ini adalah DISTRIBUSI HARGA-VOLUME dari harga EOD - bukan ringkasan
   * broker asli (A/R/L/P/SM/DM), karena data broker bersifat proprietary. */
  function renderBandar(b) {
    if (!b || !b.ada) return '';
    var tone = b.arah === 'Akumulasi' ? 'nt-ok' : b.arah === 'Distribusi' ? 'nt-neg' : '';
    var h = '';
    h += '<div class="nt-card nt-bandar">';
    h += '<div class="nt-card-title">Bandarmology (distribusi harga-volume)</div>';
    h += '<div class="nt-kv"><span>Status</span><b class="' + tone + '">' + esc(b.status) + '</b></div>';
    h += '<div class="nt-kv"><span>Net aliran dana (60 hari)</span><b class="' + tone + '">' +
         (b.netPersen > 0 ? '+' : '') + angka(b.netPersen, 1) + '%</b></div>';
    h += '<div class="nt-kv"><span>Skor bandaran</span><b>' + angka(b.skor, 1) + ' / 100</b></div>';
    h += '<div class="nt-kv"><span>Posisi harga vs PnV</span><b>' + esc(b.posisi) + '</b></div>';
    if (b.pnv) {
      h += '<div class="nt-kv"><span>Area PnV</span><b>' + rp(b.pnv.mulai) + ' – ' + rp(b.pnv.akhir) + '</b></div>';
    }
    if (b.dukungBawah && b.dukungAtas) {
      h += '<div class="nt-kv"><span>Area Dukung</span><b>' + rp(b.dukungBawah) + ' – ' + rp(b.dukungAtas) + '</b></div>';
    }
    h += '<div class="nt-kv"><span>Tren volume</span><b>' + esc(b.trenVolume) + '</b></div>';
    if (b.exhaustion) {
      h += '<div class="nt-kv"><span>Pola kelelahan</span><b class="nt-warnmini">' + esc(b.exhaustion) + '</b></div>';
    }
    if (b.alasan && b.alasan.length) {
      h += '<ul class="nt-list-alasan">';
      b.alasan.forEach(function (t) { h += '<li>' + esc(t) + '</li>'; });
      h += '</ul>';
    }
    h += '<div class="nt-note">Bandaran dihitung dari harga &amp; volume harian (EOD). ' +
         'Ini proksi distribusi harga-volume, bukan ringkasan broker A/R/L/P/SM/DM ' +
         '(data broker tidak publik). Arah dana tidak bisa diklaim real-time.</div>';
    h += '</div>';
    return h;
  }

  /* ========================================================
     RENDER MODUL ANALISA LANJUTAN
     Modul ini melengkapi modul yang sudah ada (bandarmology,
     teknikal, fundamental). Tidak ada skor atau ranking baru.
     Semua nilai yang tidak tersedia ditampilkan apa adanya.
     ======================================================== */

  function kvRow(label, nilai, kelas) {
    return '<div class="nt-kv"><span>' + esc(label) + '</span><b class="' +
      (kelas || '') + '">' + esc(nilai) + '</b></div>';
  }
  function tanpa() {
    var m = F();
    return (m && m.TANPA) || 'Data tidak tersedia';
  }
  function lbl(obj, key, fallback) {
    if (!obj) return fallback || tanpa();
    var v = obj[key];
    return (v === null || v === undefined || v === '') ? (fallback || tanpa()) : String(v);
  }
  function lblValuasi(v, key) {
    return v && v.label && v.label[key] ? v.label[key] : tanpa();
  }
  function lblUmum(m, key) {
    return m && m.label && m.label[key] ? m.label[key] : tanpa();
  }
  function ntList(arr) {
    if (!arr || !arr.length) return '';
    var h = '<ul class="nt-list-alasan">';
    arr.forEach(function (t) { h += '<li>' + esc(t) + '</li>'; });
    return h + '</ul>';
  }
  function ntJudul(judul, isi, cls) {
    if (!isi || !isi.length) return '';
    return '<div class="nt-card-title">' + esc(judul) + '</div>' + ntList(isi);
  }

  /* --- 1. Valuation --- */
  function renderValuasi(v) {
    if (!v) return '';
    var h = '<div class="nt-card nt-mod">';
    h += '<div class="nt-card-title">Valuation</div>';
    h += kvRow('PER', lblValuasi(v, 'per'));
    h += kvRow('PER Obligasi', lblValuasi(v, 'perForward'));
    h += kvRow('PBV', lblValuasi(v, 'pbv'));
    h += kvRow('EV/EBITDA', lblValuasi(v, 'evEbitda'));
    h += kvRow('EV/Revenue', lblValuasi(v, 'evRevenue'));
    h += kvRow('PEG', lblValuasi(v, 'peg'));
    h += kvRow('Free Cash Flow Yield', lblValuasi(v, 'fcfYield'));
    var bs = v.bandingkanSektor;
    if (bs) {
      h += ntJudul('Dibanding rata-rata sektor (peer di watchlist)',
        [bs.per ? 'PER: ' + bs.per : null,
         bs.pbv ? 'PBV: ' + bs.pbv : null,
         bs.peg ? 'PEG: ' + bs.peg : null].filter(Boolean));
    }
    var bh = v.bandingkanHistoris;
    if (bh) {
      h += ntJudul('Dibanding rata-rata historis',
        [bh.per ? 'PER: ' + bh.per : null,
         bh.pbv ? 'PBV: ' + bh.pbv : null].filter(Boolean));
    }
    h += '<div class="nt-note">Sumber: Yahoo Finance (EOD). Rata-rata sektor dihitung ' +
         'dari saham se-sektor yang benar-benar ada di watchlist ini, bukan dari ' +
         'basis data pasar lengkap. EV/EBITDA tidak berlaku untuk bank.</div>';
    h += '</div>';
    return h;
  }

  /* --- 2. Cash Flow Quality --- */
  function renderCashFlow(c) {
    if (!c) return '';
    var h = '<div class="nt-card nt-mod">';
    h += '<div class="nt-card-title">Kualitas Arus Kas</div>';
    h += kvRow('Arus kas operasi', lblUmum(c, 'ocf'));
    h += kvRow('Free cash flow', lblUmum(c, 'fcf'));
    h += kvRow('Margin arus kas operasi', lblUmum(c, 'ocfMargin'));
    h += kvRow('Margin free cash flow', lblUmum(c, 'fcfMargin'));
    h += kvRow('Konversi laba ke kas', lblUmum(c, 'konversiKas'));
    h += kvRow('Laba bersih', c.labaAdalahProksi
      ? 'Proksi (EPS x saham)' : lbl(c, 'labelLaba', tanpa()));
    if (c.peringatan) {
      h += '<div class="nt-warnmini">Perhatian: ' + esc(c.peringatan) + '</div>';
    }
    if (c.catatan) h += '<div class="nt-note">' + esc(c.catatan) + '</div>';
    h += '<div class="nt-note">Sumber: Yahoo Finance (EOD). Pada bank, arus kas ' +
         'operasi dipengaruhi pertumbuhan pinjaman sehingga tidak bisa dibaca ' +
         'langsung sebagai kualitas laba.</div>';
    h += '</div>';
    return h;
  }

  /* --- 3. Debt & Financial Health --- */
  function renderUtang(u) {
    if (!u) return '';
    var h = '<div class="nt-card nt-mod">';
    h += '<div class="nt-card-title">Utang & Kesehatan Keuangan</div>';
    h += kvRow('DER (utang/ekuitas)', lblUmum(u, 'der'));
    h += kvRow('Net debt', lblUmum(u, 'netDebt'));
    h += kvRow('Net debt / EBITDA', lblUmum(u, 'netDebtToEbitda'));
    h += kvRow('Interest coverage', lblUmum(u, 'interestCoverage'));
    h += kvRow('Current ratio', lblUmum(u, 'currentRatio'));
    h += kvRow('Quick ratio', lblUmum(u, 'quickRatio'));
    h += ntJudul('Catatan', u.catatan);
    h += '<div class="nt-note">Sumber: Yahoo Finance (EOD). DER dan interest coverage ' +
         'tidak berlaku untuk bank karena struktur neracanya berbeda.</div>';
    h += '</div>';
    return h;
  }

  /* --- 4. Earnings & Growth --- */
  function renderPertumbuhan(g) {
    if (!g) return '';
    var h = '<div class="nt-card nt-mod">';
    h += '<div class="nt-card-title">Pertumbuhan & Profitabilitas</div>';
    h += kvRow('Pertumbuhan revenue (YoY)', lblUmum(g, 'revGrowth'));
    h += kvRow('Pertumbuhan laba (YoY)', lblUmum(g, 'earnGrowth'));
    h += kvRow('Pertumbuhan EPS', lblUmum(g, 'epsGrowth'));
    h += kvRow('Margin operasi', lblUmum(g, 'marginOperasi'));
    h += kvRow('Margin bersih', lblUmum(g, 'marginBersih'));
    h += kvRow('ROE', lblUmum(g, 'roe'));
    h += kvRow('ROA', lblUmum(g, 'roa'));
    if (g.kuartal && g.kuartal.length) {
      h += '<div class="nt-card-title">Riwayat kuartal (EPS aktual vs estimasi)</div>';
      h += '<ul class="nt-list-alasan">';
      g.kuartal.forEach(function (q) {
        var bagian = [];
        if (q.period || q.tanggal) bagian.push(esc(q.period || q.tanggal));
        if (q.eps !== undefined && q.eps !== null) bagian.push('EPS ' + esc(String(q.eps)));
        if (q.estimate !== undefined && q.estimate !== null) bagian.push('estimasi ' + esc(String(q.estimate)));
        h += '<li>' + bagian.join(' - ') + '</li>';
      });
      h += '</ul>';
    } else {
      h += kvRow('Riwayat kuartal', 'Data tidak tersedia');
    }
    h += '<div class="nt-note">Sumber: Yahoo Finance financialData dan earningsSummary (EOD). ' +
         'Pertumbuhan QoQ dihitung dari riwayat kuartal; bila historial kurang maka ' +
         'tidak ditampilkan.</div>';
    h += '</div>';
    return h;
  }

  /* --- 5. Corporate Action & Catalyst --- */
  function renderCatalyst(c) {
    if (!c) return '';
    var h = '<div class="nt-card nt-mod">';
    h += '<div class="nt-card-title">Catalyst & Aksi Perusahaan</div>';
    if (c.items && c.items.length) {
      h += '<ul class="nt-list-alasan">';
      c.items.forEach(function (it) {
        h += '<li><b>' + esc(it.jenis || 'Katalis') + '</b>' +
             (it.tanggal ? ' (' + esc(it.tanggal) + ')' : '') +
             (it.detail ? ' - ' + esc(it.detail) : '') + '</li>';
      });
      h += '</ul>';
    } else {
      h += kvRow('Katalis terdeteksi', c.tersedia === false ? tanpa() : 'Tidak ada');
    }
    if (c.tidakTersedia && c.tidakTersedia.length) {
      h += '<div class="nt-card-title">Tidak tersedia dari sumber data gratis</div>';
      h += '<ul class="nt-list-alasan">';
      c.tidakTersedia.forEach(function (t) {
        h += '<li>' + esc(t.jenis) + ': ' + esc(t.alasan) + '</li>';
      });
      h += '</ul>';
    }
    h += '<div class="nt-note">Sumber: Yahoo Finance. Tidak ada angka yang dibuat-buat: ' +
         'jenis katalis yang tidak tersedia dicatat apa adanya.</div>';
    h += '</div>';
    return h;
  }

  /* --- 6. Sector & Macro --- */
  function renderMakro(m) {
    if (!m) return '';
    var h = '<div class="nt-card nt-mod">';
    h += '<div class="nt-card-title">Sektor & Konteks Makro</div>';
    h += kvRow('Sektor', m.sektor || tanpa());
    h += kvRow('Industri', m.industri || tanpa());
    h += kvRow('Tren IHSG', m.ihsgTren || tanpa());
    var mk = m.makro || {};
    h += kvRow('Rupiah (USD/IDR)', mk.rupiah || tanpa());
    h += kvRow('Yield obligasi AS 10Y', mk.us10y || tanpa());
    h += kvRow('Emas (USD/oz)', mk.emas || tanpa());
    h += kvRow('Minyak (WTI)', mk.minyak || tanpa());
    h += ntJudul('Pengaruh terhadap saham', m.catatan);
    h += '<div class="nt-note">Proksi makro: emas, minyak, dan yield AS 10 tahun sebagai ' +
         'sentimen global. Data EOD, tidak real-time.</div>';
    h += '</div>';
    return h;
  }

  /* --- 7. Risk & Reward --- */
  function renderRR(r) {
    if (!r) return '';
    var h = '<div class="nt-card nt-mod">';
    h += '<div class="nt-card-title">Risk / Reward</div>';
    if (!r.tersedia) {
      h += kvRow('Risk/Reward', r.pesan || tanpa());
      h += '<div class="nt-note">Support, resistance, dan rasio risk/reward dihitung dari ' +
           'data swing harian. Bila data swing tidak cukup, bagian ini tidak ' +
           'diisi agar tidak menebak.</div></div>';
      return h;
    }
    h += kvRow('Support utama', lbl(r, 'support'));
    h += kvRow('Resistance utama', lbl(r, 'resistance'));
    h += kvRow('Potensi upside', lbl(r, 'upside'));
    h += kvRow('Potensi downside', lbl(r, 'downside'));
    h += kvRow('Risk/Reward ratio', lbl(r, 'rr'), r.toneRR);
    h += kvRow('Risiko volatilitas', lbl(r, 'volatilitas'));
    h += ntJudul('Risiko utama', r.risiko);
    h += '<div class="nt-note">Support dan resistance dari data swing harian. ' +
         'Bukan jaminan pergerakan harga.</div>';
    h += '</div>';
    return h;
  }

  /* --- 8. Market Regime --- */
  function renderRegime(g) {
    if (!g) return '';
    var h = '<div class="nt-card nt-mod nt-regime">';
    h += '<div class="nt-card-title">Kondisi Pasar (Regime)</div>';
    h += kvRow('Regime', g.regime || tanpa(), g.tone);
    if (g.pesan) h += '<div class="nt-note">' + esc(g.pesan) + '</div>';
    h += '</div>';
    return h;
  }

  /* --- 9. Final Analysis --- */
  function renderFinal(f) {
    if (!f) return '';
    var h = '<div class="nt-card nt-mod nt-final">';
    h += '<div class="nt-card-title">Ringkasan Akhir</div>';
    h += kvRow('Market Condition', f.marketCondition || tanpa());
    h += kvRow('Fundamental Quality', f.fundamentalQuality || tanpa());
    h += kvRow('Valuation', f.valuation || tanpa());
    h += kvRow('Cash Flow Quality', f.cashFlowQuality || tanpa());
    h += kvRow('Financial Health', f.financialHealth || tanpa());
    h += kvRow('Catalyst', f.catalyst || tanpa());
    h += kvRow('Sector / Macro', f.sectorMacro || tanpa());
    h += kvRow('Risk / Reward', f.riskReward || tanpa());
    h += ntJudul('Risiko kunci', f.keyRisks);
    h += ntJudul('Catalyst kunci', f.keyCatalysts);
    h += '<div class="nt-note">Ringkasan ini menyatukan modul yang sudah ada ' +
         '(bandarmology, teknikal, fundamental) dengan modul lanjutan. ' +
         'Tidak ada skor baru yang ditambahkan. Keputusan dan eksekusi tetap ' +
         'dilakukan manual. Bukan nasihat investasi.</div>';
    h += '</div>';
    return h;
  }

  function layarDetail(kode) {
    var a = cariAnalisa(kode);
    if (!a) {
      return '<div class="nt-empty">Data saham ' + esc(kode) + ' tidak ditemukan.</div>';
    }
    var L = a.level;
    var h = '';

    h += '<div class="nt-card nt-dhead ' + verdictClass(a.verdict) + '">';
    h += '<div class="nt-dhead-top">';
    h += '<div><div class="nt-dhead-kode">' + esc(a.kode) + '</div>' +
         '<div class="nt-dhead-nama">' + esc(a.nama) + '</div></div>';
    h += '<div class="nt-dhead-verdict"><span class="nt-tag big ' + verdictClass(a.verdict) + '">' +
         a.emoji + ' ' + esc(a.verdict) + '</span></div>';
    h += '</div>';
    if (L) {
      h += '<div class="nt-dhead-price">' + rp(L.harga) + '</div>';
    }
    h += '<div class="nt-kv"><span>Skor gabungan</span><b>' + angka(a.skor, 1) + ' / 100</b></div>';
    h += '<div class="nt-kv"><span>Skor teknikal</span><b>' + angka(a.skorTeknikal, 1) + '</b></div>';
    h += '<div class="nt-kv"><span>Skor fundamental</span><b>' +
         (a.skorFundamental === null ? 'tidak tersedia' : angka(a.skorFundamental, 1)) + '</b></div>';
    if (a.skorBandar !== null && a.skorBandar !== undefined) {
      h += '<div class="nt-kv"><span>Skor bandaran</span><b>' + angka(a.skorBandar, 1) + '</b></div>';
    }
    h += '</div>';

    // --- Bandarmology (distribusi harga-volume) ---
    h += renderBandar(a.bandaran);

    // --- Modul analisa lanjutan (dari nava-trader-fund.js) ---
    // Tidak ada skor baru: modul ini melengkapi, bukan menggandakan.
    (function () {
      var m = F();
      if (!m) return;
      var L2 = a.lanjutan || {};
      try {
        h += renderValuasi(L2.valuasi);
        h += renderCashFlow(L2.cashflow);
        h += renderUtang(L2.utang);
        h += renderPertumbuhan(L2.pertumbuhan);
        h += renderCatalyst(L2.catalyst);
        h += renderMakro(L2.makro);
        h += renderRR(L2.riskReward);
        h += renderRegime(L2.regime);
        h += renderFinal(L2.finalAnalisis);
      } catch (e) {
        console.error('nava-trader: render modul lanjutan gagal', e);
      }
    })();

    // --- Level harga ---
    if (L) {
      h += '<div class="nt-card">';
      h += '<div class="nt-card-title">Level Harga</div>';
      h += '<div class="nt-kv"><span>Harga sekarang</span><b>' + rp(L.harga) + '</b></div>';
      h += '<div class="nt-kv"><span>Area masuk</span><b>' + rp(L.areaMasuk.bawah) +
           ' – ' + rp(L.areaMasuk.atas) + '</b></div>';
      h += '<div class="nt-kv"><span>Batas rugi</span><b class="nt-neg">' + rp(L.batasRugi) + '</b></div>';
      h += '<div class="nt-kv"><span>Target 1</span><b class="nt-pos">' + rp(L.target1) + '</b></div>';
      h += '<div class="nt-kv"><span>Target 2</span><b class="nt-pos">' + rp(L.target2) + '</b></div>';
      h += '<div class="nt-kv"><span>Risk / lembar</span><b>' + rp(L.riskPerShares) + '</b></div>';
      h += '<div class="nt-kv"><span>Risk / Reward</span><b class="' +
           (L.rasioRR >= C().getConfig().rrMinimal ? 'nt-ok' : 'nt-warnmini') + '">' +
           angka(L.rasioRR, 2) + 'x</b></div>';
      h += '<div class="nt-kv"><span>ATR (14)</span><b>' + rp(L.atr) + '</b></div>';
      h += '<div class="nt-note">Target 1 berdasarkan ' + esc(L.target1Asal) +
           '. Batas rugi memakai ' + angka(C().getConfig().atrMultSL, 1) + 'x ATR.</div>';
      h += '</div>';
    }

    // --- Alasan ---
    h += '<div class="nt-card">';
    h += '<div class="nt-card-title">Alasan</div>';
    h += '<ul class="nt-list-alasan">';
    (a.alasan || []).forEach(function (t) {
      h += '<li>' + esc(t) + '</li>';
    });
    h += '</ul>';
    h += '</div>';

    // --- Risiko ---
    h += '<div class="nt-card nt-risk">';
    h += '<div class="nt-card-title">Risiko</div>';
    h += '<ul class="nt-list-alasan">';
    (a.risiko || []).forEach(function (t) {
      h += '<li>' + esc(t) + '</li>';
    });
    h += '</ul>';
    h += '</div>';

    // --- Rincian skor teknikal ---
    if (a.breakdown && a.breakdown.length) {
      h += '<div class="nt-card">';
      h += '<div class="nt-card-title">Rincian Skor Teknikal</div>';
      a.breakdown.forEach(function (p) {
        var pct = Math.round((p.nilai / p.maks) * 100);
        h += '<div class="nt-sbar-row">';
        h += '<div class="nt-sbar-top"><span>' + esc(p.nama) + '</span><b>' +
             angka(p.nilai, 0) + '/' + p.maks + '</b></div>';
        h += '<div class="nt-sbar"><i class="' + (pct >= 60 ? 'hi' : pct >= 40 ? 'mid' : 'lo') +
             '" style="width:' + pct + '%"></i></div>';
        h += '<div class="nt-sbar-desc">' + esc(p.deskripsi) + '</div>';
        h += '</div>';
      });
      h += '</div>';
    }

    // --- Rincian fundamental ---
    if (a.breakdownFundamental && a.breakdownFundamental.length) {
      h += '<div class="nt-card">';
      h += '<div class="nt-card-title">Rincian Fundamental</div>';
      a.breakdownFundamental.forEach(function (p) {
        var pct = Math.round((p.nilai / p.maks) * 100);
        h += '<div class="nt-sbar-row">';
        h += '<div class="nt-sbar-top"><span>' + esc(p.nama) + '</span><b>' +
             angka(p.nilai, 0) + '/' + p.maks + '</b></div>';
        h += '<div class="nt-sbar"><i class="' + (pct >= 60 ? 'hi' : pct >= 40 ? 'mid' : 'lo') +
             '" style="width:' + pct + '%"></i></div>';
        h += '<div class="nt-sbar-desc">' + esc(p.deskripsi) + '</div>';
        h += '</div>';
      });
      h += '</div>';
    }

    // --- Sumber & waktu ---
    h += '<div class="nt-card">';
    h += '<div class="nt-card-title">Sumber &amp; Waktu Data</div>';
    h += '<div class="nt-kv"><span>Sumber</span><b>' + esc(a.sumber.nama) + '</b></div>';
    h += '<div class="nt-kv"><span>Jenis</span><b class="nt-delayed">' + esc(a.sumber.jenis) + '</b></div>';
    h += '<div class="nt-kv"><span>Data terakhir</span><b>' + esc(a.waktuData) + '</b></div>';
    h += '<div class="nt-note">' + esc(a.sumber.catatan) + '</div>';
    h += '<div class="nt-note">Verifikasi ke IDX (idx.co.id) atau aplikasi broker resmi sebelum bertindak.</div>';
    h += '</div>';

    // --- Harga real-time + refresh untuk saham ini saja ---
    // Tombol refresh dipakai BEFORE mencatat simulasi, supaya harga yang
    // dimasukkan benar-benar harga terbaru, bukan penutupan lama.
    (function () {
      var q = Q();
      if (!q || !q.panelRefreshSatu) return;
      try { h += q.panelRefreshSatu(a.kode); } catch (err) { /* noop */ }
    })();

    // --- Aksi: PAPER TRADING (simulasi, bukan order nyata) ---
    if (L) {
      h += '<div class="nt-card">';
      h += '<div class="nt-card-title">Catat Paper Trading</div>';
      h += '<div class="nt-note">Simulasi saja. Tidak mengirim order ke bursa mana pun.</div>';
      h += '<div class="nt-rowbtns">';
      h += '<button class="nt-b nt-b-soft" data-nv-paper="beli|' + esc(a.kode) + '">Simulasi Beli</button>';
      h += '<button class="nt-b nt-b-soft" data-nv-paper="jual|' + esc(a.kode) + '">Simulasi Jual</button>';
      h += '</div>';
      h += '<div class="nt-rowbtns">';
      h += '<button class="nt-b nt-b-ghost" data-nv-go="paper">Buka Paper Trading</button>';
      h += '</div>';
      h += '</div>';
    }

    h += '<div class="nt-card nt-disclaimer">';
    h += '<b>⚠️ Penting</b>';
    h += '<p>Analisa ini <b>bukan nasihat keuangan</b>. Verdict di atas ' +
         'dihitung dari data historis EOD, bukan ramalan. Aplikasi ini tidak ' +
         'pernah mengirim order ke bursa. Keputusan dan eksekusi transaksi ' +
         'adalah tanggung jawab Anda sepenuhnya.</p>';
    h += '<p>Verifikasi ke sumber resmi (idx.co.id atau aplikasi broker resmi) ' +
         'sebelum mengambil keputusan.</p>';
    h += '</div>';

    h += '<div class="nt-rowbtns">';
    h += '<button class="nt-b nt-b-ghost" data-nv-go="home">‹ Kembali ke daftar</button>';
    h += '</div>';

    return h;
  }

  /* ---------------------------------------------------------
     LAYAR: BACKTEST
     --------------------------------------------------------- */

  function layarBacktest() {
    var list = (M.hasil && M.hasil.hasil) || [];
    var h = '';

    h += '<div class="nt-card">';
    h += '<div class="nt-card-title">Backtest (Historis)</div>';
    h += '<div class="nt-note">Menguji aturan teknikal pada data masa lalu. ' +
         'Fee, minimum fee, dan stamp duty sudah dihitung. ' +
         'Hasil masa lalu <b>tidak menjamin</b> hasil mendatang.</div>';
    h += '<div class="nt-fld"><label>Pilih saham</label><select id="btKode" class="nt-sel">' +
         list.map(function (a) {
           return '<option value="' + esc(a.kode) + '"' +
                  (M.btKode === a.kode ? ' selected' : '') + '>' +
                  esc(a.kode) + ' — ' + esc(a.nama) + '</option>';
         }).join('') + '</select></div>';
    h += '<div class="nt-row2">';
    h += '<div class="nt-fld"><label>Stop loss (%)</label>' +
         '<input type="number" id="btSL" class="nt-inp" value="' + (M.btSL || 5) + '" inputmode="decimal"></div>';
    h += '<div class="nt-fld"><label>Take profit (%)</label>' +
         '<input type="number" id="btTP" class="nt-inp" value="' + (M.btTP || 10) + '" inputmode="decimal"></div>';
    h += '</div>';
    h += '<div class="nt-fld"><label>Modal awal (Rp)</label>' +
         '<input type="number" id="btModal" class="nt-inp" value="' + (M.btModal || 10000000) + '" inputmode="numeric"></div>';
    h += '<button class="nt-b nt-b-primary block" data-nv-runbt>Jalankan Backtest</button>';
    h += '</div>';

    if (M.bt) {
      var b = M.bt;
      h += '<div class="nt-card">';
      h += '<div class="nt-card-title">Hasil Backtest</div>';
      if (!b.ok) {
        h += '<div class="nt-empty">' + esc(b.pesan) + '</div>';
      } else {
        var pos = b.returnPersen >= 0;
        h += '<div class="nt-kv"><span>Modal awal</span><b>' + rp(b.modalAwal) + '</b></div>';
        h += '<div class="nt-kv"><span>Modal akhir</span><b>' + rp(b.equityAkhir) + '</b></div>';
        h += '<div class="nt-kv"><span>Return</span><b class="' + (pos ? 'nt-pos' : 'nt-neg') + '">' +
             (pos ? '+' : '') + angka(b.returnPersen, 2) + '%</b></div>';
        h += '<div class="nt-kv"><span>Jumlah transaksi</span><b>' + b.jumlahTrade + '</b></div>';
        h += '<div class="nt-kv"><span>Win / Loss</span><b>' + b.win + ' / ' + b.loss + '</b></div>';
        h += '<div class="nt-kv"><span>Win rate</span><b>' + angka(b.winRate, 1) + '%</b></div>';
        h += '<div class="nt-kv"><span>Rata-rata per trade</span><b>' +
             (b.rataHasilPerTrade >= 0 ? '+' : '') + angka(b.rataHasilPerTrade, 2) + '%</b></div>';
        h += '<div class="nt-kv"><span>Total biaya</span><b class="nt-neg">' + rp(b.totalBiaya) + '</b></div>';
        h += '<div class="nt-note">' + esc(b.catatan) + '</div>';
        h += '</div>';

        if (b.trades && b.trades.length) {
          h += '<div class="nt-card">';
          h += '<div class="nt-card-title">Riwayat Transaksi (' + b.trades.length + ')</div>';
          h += '<div class="nt-list">';
          b.trades.slice().reverse().forEach(function (t) {
            var p = t.hasilPct >= 0;
            h += '<div class="nt-row static">';
            h += '<div class="nt-row-left"><div class="nt-row-kode">' +
                 esc(t.tglMasuk) + ' → ' + esc(t.tglKeluar) + '</div>';
            h += '<div class="nt-row-nama">' + rp(t.hargaMasuk) + ' → ' + rp(t.hargaKeluar) +
                 ' · ' + esc(t.alasanKeluar) + '</div></div>';
            h += '<div class="nt-row-right"><div class="nt-row-harga ' + (p ? 'nt-pos' : 'nt-neg') + '">' +
                 (p ? '+' : '') + angka(t.hasilPct, 2) + '%</div>' +
                 '<div class="nt-row-verdict"><span class="nt-mini">biaya ' + rp(t.fee) + '</span></div></div>';
            h += '</div>';
          });
          h += '</div></div>';
        }
      }
    }

    h += '<div class="nt-rowbtns">';
    h += '<button class="nt-b nt-b-ghost" data-nv-go="home">‹ Kembali</button>';
    h += '</div>';

    return h;
  }

  /* ---------------------------------------------------------
     LAYAR: PAPER TRADING
     --------------------------------------------------------- */

  function layarPaper() {
    var p = C().paperLoad();
    var s = C().paperSummary();
    var h = '';

    h += '<div class="nt-card">';
    h += '<div class="nt-card-title">Paper Trading (Simulasi)</div>';
    h += '<div class="nt-warnbox">Ini <b>simulasi</b>. Tidak ada order yang dikirim ke bursa. ' +
         'Dipakai untuk menguji ide strategi dan mencatat hasil setelah biaya.</div>';
    h += '<div class="nt-fld"><label>Modal awal (Rp)</label>' +
         '<input type="number" id="ppModal" class="nt-inp" value="' + p.modal + '" inputmode="numeric"></div>';
    h += '<button class="nt-b nt-b-soft block" data-nv-setmodal>Simpan Modal</button>';
    h += '<div class="nt-kv"><span>Modal tunai</span><b>' + rp(s.modal) + '</b></div>';
    h += '<div class="nt-kv"><span>Nilai posisi</span><b>' + rp(s.nilaiPosisi) + '</b></div>';
    h += '<div class="nt-kv"><span>Total nilai</span><b>' + rp(s.totalNilai) + '</b></div>';
    h += '<div class="nt-kv"><span>Return</span><b class="' + (s.returnPersen >= 0 ? 'nt-pos' : 'nt-neg') + '">' +
         (s.returnPersen >= 0 ? '+' : '') + angka(s.returnPersen, 2) + '%</b></div>';
    h += '<div class="nt-kv"><span>Total biaya</span><b class="nt-neg">' + rp(s.totalBiaya) + '</b></div>';
    h += '</div>';

    h += '<div class="nt-card">';
    h += '<div class="nt-card-title">Posisi Terbuka (' + p.posisi.length + ')</div>';
    if (!p.posisi.length) {
      h += '<div class="nt-empty">Belum ada posisi. Catat simulasi beli dari halaman detail saham.</div>';
    } else {
      h += '<div class="nt-list">';
      p.posisi.forEach(function (pos) {
        var hargaBeli = (C().util.isNum(pos.hargaMasuk) ? pos.hargaMasuk : pos.harga);
        var harga = (C().util.isNum(pos.hargaSekarang) ? pos.hargaSekarang : hargaBeli);
        var pnl = hargaBeli > 0 ? (harga - hargaBeli) / hargaBeli * 100 : 0;
        h += '<div class="nt-row static">';
        h += '<div class="nt-row-left"><div class="nt-row-kode">' + esc(pos.kode) + ' · ' + pos.lots + ' lot</div>';
        h += '<div class="nt-row-nama">Beli ' + rp(hargaBeli) + ' · fee ' + rp(pos.fee) + '</div></div>';
        h += '<div class="nt-row-right"><div class="nt-row-harga ' + (pnl >= 0 ? 'nt-pos' : 'nt-neg') + '">' +
             rp(harga) + '</div><div class="nt-row-verdict"><span class="nt-mini ' +
             (pnl >= 0 ? 'nt-pos' : 'nt-neg') + '">' + (pnl >= 0 ? '+' : '') + angka(pnl, 2) + '%</span></div></div>';
        h += '</div>';
      });
      h += '</div>';
    }
    h += '</div>';

    if (p.riwayat && p.riwayat.length) {
      h += '<div class="nt-card">';
      h += '<div class="nt-card-title">Riwayat Realisasi (' + p.riwayat.length + ')</div>';
      h += '<div class="nt-list">';
      p.riwayat.slice().reverse().forEach(function (t) {
        h += '<div class="nt-row static">';
        h += '<div class="nt-row-left"><div class="nt-row-kode">' + esc(t.kode) + ' · ' + esc(t.tgl) + '</div>';
        h += '<div class="nt-row-nama">' + t.lots + ' lot · ' + rp(t.hargaBeli) + ' → ' + rp(t.hargaJual) + '</div></div>';
        h += '<div class="nt-row-right"><div class="nt-row-harga ' + (t.pnl >= 0 ? 'nt-pos' : 'nt-neg') + '">' +
             (t.pnl >= 0 ? '+' : '') + rp(t.pnl) + '</div></div>';
        h += '</div>';
      });
      h += '</div></div>';
    }

    h += '<div class="nt-rowbtns">';
    h += '<button class="nt-b nt-b-ghost" data-nv-go="home">‹ Kembali</button>';
    h += '<button class="nt-b nt-b-danger" data-nv-paperreset>Reset Paper Trading</button>';
    h += '</div>';

    return h;
  }

  /* ---------------------------------------------------------
     LAYAR: STRATEGI (perubahan WAJIB lewat persetujuan)
     --------------------------------------------------------- */

  function layarStrategi() {
    var s = C().strategiLoad();
    var menunggu = s.status === 'Menunggu Persetujuan';
    var h = '';

    h += '<div class="nt-card">';
    h += '<div class="nt-card-title">Strategi</div>';
    h += '<div class="nt-note">Perubahan parameter <b>tidak langsung aktif</b>. ' +
         'Kamu harus melakukan evaluasi backtest dulu, lalu menyetujuikannya secara eksplisit.</div>';
    h += '<div class="nt-kv"><span>Status</span><b class="' +
         (menunggu ? 'nt-warnmini' : 'nt-ok') + '">' + esc(s.status) + '</b></div>';
    h += '<div class="nt-kv"><span>Versi</span><b>v' + esc(s.versi) + '</b></div>';
    h += '<div class="nt-kv"><span>Disetujui</span><b>' + esc(s.disetujuiPada || '-') + '</b></div>';
    if (s.diusulkan) h += '<div class="nt-kv"><span>Diusulkan</span><b>' + esc(s.diusulkan) + '</b></div>';
    h += '</div>';

    h += '<div class="nt-card">';
    h += '<div class="nt-card-title">Usulan Perubahan</div>';
    h += '<div class="nt-fld"><label>Ambang skor Beli (minSkorEntry)</label>' +
         '<input type="number" id="stEntry" class="nt-inp" value="' +
         (menunggu ? s.minSkorEntry : M.stEntry || s.minSkorEntry) + '" inputmode="numeric"></div>';
    h += '<div class="nt-fld"><label>Ambang skor Jual (minSkorJual)</label>' +
         '<input type="number" id="stJual" class="nt-inp" value="' +
         (menunggu ? s.minSkorJual : M.stJual || s.minSkorJual) + '" inputmode="numeric"></div>';
    h += '<div class="nt-fld"><label>Multiplier ATR untuk batas rugi</label>' +
         '<input type="number" id="stSL" class="nt-inp" step="0.1" value="' +
         (menunggu ? s.atrMultSL : M.stSL || s.atrMultSL) + '" inputmode="decimal"></div>';
    h += '<div class="nt-fld"><label>Risk/Reward minimal</label>' +
         '<input type="number" id="stRR" class="nt-inp" step="0.1" value="' +
         (menunggu ? s.rrMinimal : M.stRR || s.rrMinimal) + '" inputmode="decimal"></div>';
    h += '<button class="nt-b nt-b-soft block" data-nv-usulkan>Ajukan Perubahan</button>';
    h += '<div class="nt-note">Setelah diajukan, status menjadi "Menunggu Persetujuan" ' +
         'dan parameter lama tetap dipakai sampai kamu menyetujui.</div>';
    h += '</div>';

    if (menunggu) {
      h += '<div class="nt-card nt-approve">';
      h += '<div class="nt-card-title">Persetujuan Diperlukan</div>';
      h += '<div class="nt-note">Periksa dulu lewat Backtest. Kalau hasilnya tetap detrimental, jangan disetujui.</div>';
      h += '<div class="nt-rowbtns">';
      h += '<button class="nt-b nt-b-ok" data-nv-setujui>Setujui &amp; Terapkan</button>';
      h += '<button class="nt-b nt-b-ghost" data-nv-tolak>Tolak</button>';
      h += '</div>';
      h += '</div>';
    }

    h += '<div class="nt-rowbtns">';
    h += '<button class="nt-b nt-b-ghost" data-nv-go="backtest">‹ Uji Backtest dulu</button>';
    h += '</div>';

    return h;
  }

  /* ---------------------------------------------------------
     LAYAR: MUAT DATA
     --------------------------------------------------------- */

  function layarMuat() {
    var h = '';
    h += '<div class="nt-card">';
    h += '<div class="nt-card-title">Memuat Data Pasar…</div>';
    if (M.galat) {
      h += '<div class="nt-warnbox">' + esc(M.galat) + '</div>';
      h += '<div class="nt-note">Data pasar dibentuk oleh berkas <code>data/market.json</code> ' +
           'yang dihasilkan skrip <code>trader/fetch.js</code>. Jalankan ' +
           '<code>node trader/fetch.js</code> lalu deploy ulang.</div>';
    } else {
      h += '<div class="nt-skel"></div><div class="nt-skel"></div><div class="nt-skel"></div>';
    }
    h += '<button class="nt-b nt-b-soft block" data-nv-muat>Muat Ulang</button>';
    h += '</div>';
    h += '<div class="nt-rowbtns">';
    h += '<button class="nt-b nt-b-ghost" data-nv-go="home">‹ Kembali</button>';
    h += '</div>';
    return h;
  }

  /* ---------------------------------------------------------
     RENDER
     --------------------------------------------------------- */

  function render() {
    var host = $('#ntScreen');
    if (!host) return;
    // Modul alert memakai layar yang sama; serahkan render ke sana
    // supaya tidak saling menimpa.
    if (M.view === 'alert' || M.view === 'alert-saham' || M.view === 'alert-saham2') {
      if (w.NavaTraderAlert) {
        w.NavaTraderAlert.setPasar(M.pasar);
        w.NavaTraderAlert.render();
        return;
      }
    }
    var body;
    if (!M.pasar && !M.hasil) body = layarMuat();
    else if (M.view === 'detail') body = layarDetail(M.detail);
    else if (M.view === 'backtest') body = layarBacktest();
    else if (M.view === 'paper') body = layarPaper();
    else if (M.view === 'strategi') body = layarStrategi();
    else body = layarHome();
    host.innerHTML = body;
    var sub = $('#ntBarSub');
    if (sub) {
      sub.textContent = M.view === 'home' ? 'IHSG & watchlist'
        : M.view === 'detail' ? (M.detail || 'Detail')
        : M.view === 'backtest' ? 'Backtest'
        : M.view === 'paper' ? 'Paper trading'
        : M.view === 'strategi' ? 'Strategi' : 'Data';
    }
    if (M.view === 'home' || M.view === 'detail') host.scrollTop = 0;
  }

  /* ---------------------------------------------------------
     AKSI
     --------------------------------------------------------- */

  function go(v, kode) {
    M.view = v;
    if (kode) M.detail = kode;
    render();
  }

  function jalankanBacktest() {
    var kode = ($('#btKode') || {}).value;
    var sl = Number(($('#btSL') || {}).value);
    var tp = Number(($('#btTP') || {}).value);
    var modal = Number(($('#btModal') || {}).value);
    M.btKode = kode; M.btSL = sl; M.btTP = tp; M.btModal = modal;
    found = null;
    if (M.pasar) {
      M.pasar.saham.forEach(function (s) { if (s.kode === kode) found = s; });
    }
    if (!found) { M.bt = { ok: false, pesan: 'Data saham tidak ditemukan.' }; render(); return; }
    M.bt = C().backtest(found.bar, C().getConfig(), {
      stopPct: sl, takePct: tp, modal: modal
    });
    render();
  }

  function sheetPaper(jenis, kode) {
    var a = cariAnalisa(kode);
    if (!a || !a.level) return;
    if (jenis === 'jual') {
      var p = C().paperLoad();
      var ada = false;
      p.posisi.forEach(function (x) { if (x.kode === kode) ada = true; });
      if (!ada) { toast('Tidak ada posisi ' + kode + ' untuk dijual.'); return; }
    }
    var harga = a.level.harga;
    if (!w.App || !w.App.sheet) { toast('Form tidak bisa dibuka.'); return; }
    w.App.sheet(jenis === 'beli' ? 'Simulasi Beli' : 'Simulasi Jual', function (body) {
      var nama = w.document.createElement('div');
      nama.className = 'nt-sheet-in';
      nama.innerHTML =
        '<div class="nt-note">Simulasi — tidak mengirim order ke bursa.</div>' +
        '<div class="nt-kv"><span>Saham</span><b>' + esc(kode) + ' — ' + esc(a.nama) + '</b></div>' +
        '<div class="nt-fld"><label>Harga (Rp)</label>' +
        '<input type="number" id="ppHarga" class="nt-inp" value="' + harga + '" inputmode="numeric"></div>' +
        '<div class="nt-fld"><label>Jumlah lot (1 lot = 100 lembar)</label>' +
        '<input type="number" id="ppLots" class="nt-inp" value="1" min="1" inputmode="numeric"></div>';
      var btn = w.document.createElement('button');
      btn.className = 'nt-b nt-b-primary block';
      btn.textContent = 'Catat Simulasi';
      btn.addEventListener('click', function () {
        var h = Number(w.document.querySelector('#ppHarga').value);
        var l = Number(w.document.querySelector('#ppLots').value);
        var r = C().paperOrder({ kode: kode, nama: a.nama }, jenis, h, l, 'simulasi manual');
        if (!r.ok) { toast(r.pesan); return; }
        w.App.closeSheet();
        toast('Simulasi ' + jenis + ' ' + kode + ' tercatat.');
        M.view = 'paper';
        render();
      });
      body.appendChild(nama);
      body.appendChild(btn);
    });
  }

  function bindGlobal() {
    if (M._bound) return;
    M._bound = true;
    var root = $('#nt');
    if (!root) return;
    root.addEventListener('click', function (e) {
      var t = e.target;
      var el;
      if ((el = t.closest('[data-nv-go]'))) { go(el.getAttribute('data-nv-go')); return; }
      if ((el = t.closest('[data-nv-detail]'))) { go('detail', el.getAttribute('data-nv-detail')); return; }
      if ((el = t.closest('[data-nv-filter]'))) {
        M.filter = el.getAttribute('data-nv-filter');
        M.view = 'home'; render(); return;
      }
      if ((el = t.closest('[data-nv-muat]'))) { muatPasar(); return; }
      if ((el = t.closest('[data-nv-runbt]'))) { jalankanBacktest(); return; }
      if ((el = t.closest('[data-nv-paper]'))) {
        var parts = el.getAttribute('data-nv-paper').split('|');
        sheetPaper(parts[0], parts[1]); return;
      }
      if (t.closest('[data-nv-paperreset]')) {
        C().paperReset(); toast('Paper trading direset.'); render(); return;
      }
      if (t.closest('[data-nv-setmodal]')) {
        var v = Number(($('#ppModal') || {}).value);
        C().paperSetModal(v); toast('Modal disimpan.'); render(); return;
      }
      if (t.closest('[data-nv-usulkan]')) {
        C().strategiUsulkan({
          minSkorEntry: Number(($('#stEntry') || {}).value),
          minSkorJual: Number(($('#stJual') || {}).value),
          atrMultSL: Number(($('#stSL') || {}).value),
          rrMinimal: Number(($('#stRR') || {}).value)
        });
        toast('Diajukan. Menunggu persetujuanmu.');
        render(); return;
      }
      if (t.closest('[data-nv-setujui]')) {
        var r = C().strategiSetujui();
        toast(r.ok ? 'Strategi disetujui & diterapkan.' : r.pesan);
        if (r.ok && M.hasil) { M.hasil = C().analisaSemua(M.pasar); }
        render(); return;
      }
      if (t.closest('[data-nv-tolak]')) {
        C().strategiTolak(); toast('Usulan ditolak.'); render(); return;
      }
    });
    // pencarian (live)
    root.addEventListener('input', function (e) {
      if (e.target && e.target.id === 'ntSearch') {
        M.cari = e.target.value;
        var pos = e.target.selectionStart;
        render();
        var box = w.document.querySelector('#ntSearch');
        if (box) { box.focus(); try { box.setSelectionRange(pos, pos); } catch (x) {} }
      }
    });
  }

  /* ---------------------------------------------------------
     API PUBLIK
     --------------------------------------------------------- */

  function open() {
    var ov = $('#nt');
    if (!ov) return;
    ov.classList.remove('hidden');
    ov.setAttribute('aria-hidden', 'false');
    if (w.TG && w.TG.back) w.TG.back.show(function () { close(); });
    M.view = 'home'; M.cari = ''; M.filter = 'Semua';
    if (!M.hasil) muatPasar(); else render();
  }

  function close() {
    var ov = $('#nt');
    if (!ov) return;
    ov.classList.add('hidden');
    ov.setAttribute('aria-hidden', 'true');
    if (w.TG && w.TG.back) w.TG.back.hide();
  }

  function init() {
    if (M._inited) return;
    M._inited = true;
    bindGlobal();
    var back = $('#ntBack');
    if (back) back.addEventListener('click', function () {
      if (M.view === 'home') close(); else go('home');
    });
    var rf = $('#ntRefresh');
    if (rf) rf.addEventListener('click', function () { muatPasar(); });

    // Tombol di tab Lainnya. Pakai data-nt-open (bukan data-goto)
    // supaya tidak ikut ditangani router App.go() milik view utama.
    var tool = w.document.querySelector('[data-nt-open]');
    if (tool) {
      tool.addEventListener('click', function (e) { e.preventDefault(); open(); });
    }
  }

  /** Kode saham hasil filter saat ini - dipakai Nava Trader Quote. */
  function codesWatchlist() {
    return hasilTersaring().map(function (a) { return a.kode; });
  }

  w.NavaTraderUI = {
    open: open, close: close, init: init, render: render,
    codesWatchlist: codesWatchlist,
    isOpen: function () {
      var ov = $('#nt');
      return !!(ov && !ov.classList.contains('hidden'));
    },
    _state: M, muatPasar: muatPasar, go: go,
    viewName: function () { return M.view; }
  };

})(typeof window !== 'undefined' ? window : this);
