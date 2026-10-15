/* =====================================================================
   NAVATraderQuote - Kutipan REAL-TIME (intraday) untuk Mini App

   Default-nya Nava Trader memakai data EOD (penutupan harian).
   Modul ini mengambil kutipan INTRADAY lewat server agar harga
   bisa mendekati real-time saat bursa sedang buka.

   ATURAN KEHUJURAN DATA (WAJIB):
     - Label "Real-time" HANYA tampil bila server benar-benar
       mengembalikan tick intraday yang masih di dalam jam bursa.
     - Bila bursa tutup / data basi, label otomatis "Delayed"
       beserta jam pembaruan terakhir.
     - Tidak ada harga yang dikarang. Gagal = "Data tidak tersedia".
     - Tidak pernah menyebut order bursa / hasil eksekusi.

   Cache server 20 detik + rate limit, jadi tombol refresh aman
   diketuk berulang kali.
   ===================================================================== */
(function (w) {
  'use strict';

  var $ = function (s) { return w.document.querySelector(s); };
  var Sync = function () { return w.Sync; };

  var M = {
   sibuk: false,       // sedang mengambil data
    quote: null,        // hasil terakhir dari /api/quote
    waktuAmbil: null,   // timestamp pengambilan terakhir
    galat: '',
    gagalSeq: 0,        // counter, biar pesan error tak berduplikasi
    terakhirCoba: 0,
  };

  /* ---------------------------------------------------------
     UTIL
     --------------------------------------------------------- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function api(method, path) {
    var S = Sync();
    if (!S || !S.mascimApi) return Promise.reject(new Error('Sinkronisasi belum siap'));
    return S.mascimApi(method, path);
  }

  function toast(p) {
    if (w.App && w.App.toast) w.App.toast(p);
  }

  /** Badge label data: hijau saat Real-time, kuning saat Delayed, merah saat Sengketa. */
  function badgeLive(label) {
    var t = String(label || '').toLowerCase();
    var cls = 'nt-dly';
    if (t.indexOf('real') === 0) cls = 'nt-rt';
    else if (t.indexOf('sengketa') === 0) cls = 'nt-skt';
    return '<span class="nt-rbadge ' + cls + '">' + esc(label || 'Delayed') + '</span>';
  }

  /** Badge keyakinan data: tinggi / sedang / rendah. */
  function badgeKeyakinan(keyakinan) {
    var k = String(keyakinan || '').toLowerCase();
    var cls = 'nt-key-sedang';
    if (k.indexOf('tinggi') === 0) cls = 'nt-key-tinggi';
    else if (k.indexOf('rendah') === 0) cls = 'nt-key-rendah';
    return '<span class="nt-kbadge ' + cls + '">Keyakinan: ' +
           esc(keyakinan || 'tidak diketahui') + '</span>';
  }

  /** Ubah waktu reset kuota (ISO UTC) menjadi waktu lokal WIB yang enak dibaca. */
  function waktuResetWIB(iso) {
    var t = new Date(iso);
    if (isNaN(t)) return iso;
    try {
      return t.toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short',
        hour: '2-digit', minute: '2-digit'
      }) + ' WIB';
    } catch (e) {
      return t.toISOString();
    }
  }

  /* ---------------------------------------------------------
     PENGAMBILAN DATA
     --------------------------------------------------------- */

  /**
   * Ambil kutipan intraday.
   * @param {string[]} codes - kode saham (tanpa ekstensi)
   * @param {boolean} denganIHSG - ikut ambil IHSG
   */
  /**
   * Gabungkan hasil baru ke cache lama per simbol.
   *
   * Penting: saat hanya satu saham yang di-refresh (mis. dari halaman detail),
   * server hanya mengembalikan kode itu. Kalau respons baru langsung
   * menggantikan cache, harga live 19 saham lain ikut hilang dari tampilan.
   * Jadi simbol yang tidak ada di respons baru tetap dipertahankan.
   */
  function gabungQuote(lama, baru) {
    if (!baru) return lama;
    if (!lama) return baru;
    var peta = {};
    var urutan = [];
    function taruh(s) {
      if (!s || !s.kode) return;
      var k = String(s.kode).toUpperCase();
      if (!(k in peta)) urutan.push(k);
      peta[k] = s;
    }
    (lama.saham || []).forEach(taruh);
    (baru.saham || []).forEach(taruh);

    // Tetap berupa array supaya cari() & perulangan lain tidak berubah.
    var saham = urutan.map(function (k) { return peta[k]; });

    return {
      ok: true,
      saham: saham,
      // IHSG hanya diganti kalau respons baru benar-benar menyertakan IHSG.
      ihsg: baru.ihsg || lama.ihsg || null,
      ringkasan: baru.ringkasan || lama.ringkasan || {},
      sumber: baru.sumber || lama.sumber || '',
      dariCache: !!baru.dariCache
    };
  }

  function muatQuote(codes, denganIHSG) {
    var cs = (codes || []).slice(0, 20);
    var q = '/api/quote?ihsg=' + (denganIHSG === false ? '0' : '1');
    if (cs.length) q += '&codes=' + encodeURIComponent(cs.join(','));

    M.sibuk = true;
    M.galat = '';
    M.terakhirCoba = Date.now();

    return api('GET', q)
      .then(function (r) {
        if (r && r.ok) {
          M.quote = gabungQuote(M.quote, r);
          M.waktuAmbil = Date.now();
          var ring = M.quote.ringkasan || {};
          var label = ring.labelDataIHSG || 'Delayed';
          toast((r.dariCache ? 'Data (cache) ' : 'Data ') + label + ' - ' +
                (ring.jumlahBerhasil || 0) + '/' + (ring.jumlahDiminta || 0) + ' simbol');
        } else {
          M.gagalSeq++;
          M.galat = (r && r.error) || 'Gagal mengambil data real-time';
        }
      })
      .catch(function (e) {
        M.gagalSeq++;
        M.galat = (e && e.message) || 'Gagal menghubungi server';
      })
      .then(function () {
        M.sibuk = false;
        if (w.NavaTraderUI && w.NavaTraderUI.render) {
          try { w.NavaTraderUI.render(); } catch (err) { /* noop */ }
        }
      });
  }

  /**
   * Cari kutipan satu kode dari cache terakhir.
   * IHSG berada di field terpisah (q.ihsg), jadi ikut dicari di sana.
   */
  function cari(kode) {
    var q = M.quote;
    if (!q) return null;
    var k = String(kode || '').toUpperCase();
    var arr = q.saham || [];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && String(arr[i].kode || '').toUpperCase() === k) return arr[i];
    }
    // IHSG tidak ada di q.saham - disimpan terpisah oleh server.
    var ih = q.ihsg;
    if (ih && ih.ok && String(ih.kode || 'IHSG').toUpperCase() === k) return ih;
    return null;
  }

  /** Kutipan IHSG dari cache terakhir. */
  function ihsg() {
    return (M.quote && M.quote.ihsg) || null;
  }

  /**
   * Overlay harga real-time pada objek analisa saham.
   * Mengembalikan harga intraday + perubahan bila tersedia,
   * tanpa mengubah field analisa yang sudah ada.
   */
  function hargaLive(kode) {
    var q = cari(kode);
    if (!q || !q.ok) return null;
    return {
      harga: q.harga,
      perubahan: q.perubahan,
      volume: q.volumeSesi != null ? q.volumeSesi : q.volume,
      labelData: q.labelData,
      keyakinan: q.keyakinan || 'tidak diketahui',
      jumlahSumber: q.jumlahSumber || 1,
      dariCacheBasi: !!q.dariCacheBasi,
      keterangan: q.keteranganData,
      waktuDataWIB: q.waktuDataWIB,
      sumber: q.sumber,
      alasan: q.alasanLabel
    };
  }

  /* ---------------------------------------------------------
     RENDER (dipakai nava-trader.js)
     --------------------------------------------------------- */

  /** Baris live di bawah harga EOD pada kartu IHSG / baris saham. */
  function barisLive(kode) {
    var l = hargaLive(kode);
    if (!l) return '';
    var h = '';
    h += '<div class="nt-live">';
    h += '<span class="nt-live-harga">' + angkaHarga(l.harga) + '</span>';
    if (typeof l.perubahan === 'number') {
      h += '<span class="nt-live-chg ' + (l.perubahan >= 0 ? 'up' : 'down') + '">' +
           (l.perubahan >= 0 ? '▲ +' : '▼ ') + angkaPersen(l.perubahan) + '</span>';
    }
    h += badgeLive(l.labelData);
    // Sumber + waktu selalu ikut, supaya angka tidak berdiri tanpa asal.
    if (l.waktuDataWIB) {
      h += '<span class="nt-live-waktu">' + esc(l.waktuDataWIB) + '</span>';
    }
    h += '</div>';
    return h;
  }

  function angkaHarga(n) {
    var v = Number(n);
    if (!isFinite(v)) return '-';
    return Math.round(v).toLocaleString('id-ID');
  }

  function angkaPersen(n) {
    var v = Number(n);
    if (!isFinite(v)) return '-';
    return Math.abs(v).toFixed(2) + '%';
  }

  /** Panel kendali refresh (dipakai di Beranda). */
  function panelRefresh(codes) {
    var h = '';
    h += '<div class="nt-card nt-rtpanel">';
    h += '<div class="nt-card-title">Data Real-time</div>';

    if (M.sibuk) {
      h += '<div class="nt-note">Mengambil data real-time...</div>';
    } else if (M.galat) {
      h += '<div class="nt-note nt-err">' + esc(M.galat) + '</div>';
    } else if (!M.quote) {
      h += '<div class="nt-note">Belum diambil. Tekan Refresh untuk harga terkini ' +
           'saat bursa buka.</div>';
    } else {
      var ring = M.quote.ringkasan || {};
      h += '<div class="nt-kv"><span>Label IHSG</span><b>' +
           badgeLive(ring.labelDataIHSG || 'Delayed') + '</b></div>';
      if (ring.keyakinanIHSG) {
        h += '<div class="nt-kv"><span>Keyakinan data</span><b>' +
             badgeKeyakinan(ring.keyakinanIHSG) + '</b></div>';
      }
      if (ring.keyakinanTerendah && ring.keyakinanTerendah !== 'tidak diketahui') {
        h += '<div class="nt-kv"><span>Keyakinan terendah (watchlist)</span><b>' +
             badgeKeyakinan(ring.keyakinanTerendah) + '</b></div>';
      }
      h += '<div class="nt-kv"><span>Kondisi IHSG</span><b>' +
           esc(ring.kondisiIHSG || 'Data tidak tersedia') + '</b></div>';
      h += '<div class="nt-kv"><span>Waktu data IHSG</span><b>' +
           esc(ring.waktuDataIHSG || '-') + '</b></div>';
      h += '<div class="nt-kv"><span>Naik / Turun / Datar</span><b>' +
           (ring.naik || 0) + ' / ' + (ring.turun || 0) + ' / ' + (ring.datar || 0) + '</b></div>';
      h += '<div class="nt-kv"><span>Berhasil diambil</span><b>' +
           (ring.jumlahBerhasil || 0) + '/' + (ring.jumlahDiminta || 0) + '</b></div>';
      h += '<div class="nt-kv"><span>Sumber</span><b>' +
           esc(M.quote.sumber || 'Data tidak tersedia') + '</b></div>';
      // Status kuota feed utama (DataSectors). Penting supaya pengguna tahu
      // KENAPA angka memakai sumber cadangan: kuota harian terbatas.
      var kq = M.quote.kuota;
      if (kq && kq.aktif) {
        if (kq.habis) {
          h += '<div class="nt-note nt-err">Kuota feed IDX (DataSectors) habis ' +
               'untuk hari ini (' + esc(kq.terpakai + '/' + kq.batas) + ' permintaan). ' +
               'Harga di atas memakai sumber cadangan (Yahoo Finance, delayed)' +
               (kq.resetUTC ? '. Reset: ' + esc(waktuResetWIB(kq.resetUTC)) : '.') +
               '</div>';
        } else {
          h += '<div class="nt-kv"><span>Sisa kuota feed</span><b>' +
               esc(kq.sisa + '/' + kq.batas + ' hari ini') + '</b></div>';
        }
      }
      if (M.quote.catatan) {
        h += '<div class="nt-note">' + esc(M.quote.catatan) + '</div>';
      }
      if (M.waktuAmbil) {
        var t = new Date(M.waktuAmbil);
        h += '<div class="nt-kv"><span>Diambil</span><b>' +
             esc(isNaN(t) ? '-' : t.toLocaleString('id-ID')) + '</b></div>';
      }
      if (M.quote.dariCache) {
        h += '<div class="nt-note">Ini dari cache server (maks 20 detik).</div>';
      }
      // Simbol yang hanya tersedia dari cache basi (upstream bermasalah).
      var basi = (M.quote.saham || []).filter(function (q) { return q && q.dariCacheBasi; });
      if (basi.length) {
        h += '<div class="nt-note nt-err">Sumber sedang bermasalah. ' +
             basi.length + ' simbol (' +
             esc(basi.map(function (q) { return q.kode; }).join(', ')) +
             ') memakai harga terakhir yang tersimpan - bukan real-time.</div>';
      }
      // Simbol yang sumbernya berbeda jauh -> sengketa, tidak pernah real-time.
      var sengketa = [].concat(M.quote.ihsg ? [M.quote.ihsg] : [], M.quote.saham || [])
        .filter(function (q) { return q && q.labelData === 'Sengketa'; });
      if (sengketa.length) {
        h += '<div class="nt-note nt-err">Sumber data berbeda untuk: ' +
             esc(sengketa.map(function (q) { return q.kode; }).join(', ')) +
             '. Angka ditampilkan apa adanya sebagai sengketa, bukan real-time.</div>';
      }
    }

    h += '<div class="nt-rowbtns">';
    h += '<button class="nt-b nt-b-primary" data-nv-quote-refresh' +
         (M.sibuk ? ' disabled' : '') + '>' +
         (M.sibuk ? 'Mengambil...' : 'Refresh Harga Real-time') + '</button>';
    h += '</div>';
    h += '<div class="nt-note">Label Real-time hanya tampil bila data intraday ' +
         'benar-benar ada di dalam jam bursa. Selain itu ditandai Delayed; ' +
         'bila dua sumber berbeda jauh ditandai Sengketa. ' +
         'Aplikasi ini tidak pernah mengirim order ke bursa.</div>';
    h += '</div>';
    return h;
  }

  /**
   * Panel ringkas untuk SATU saham, dipakai di halaman detail.
   * Menyertakan harga live + tombol refresh yang hanya meminta kode tsb,
   * supaya tidak menghabiskan kuota feed IDX untuk seluruh watchlist.
   */
  function panelRefreshSatu(kode) {
    if (!kode) return '';
    var h = '';
    h += '<div class="nt-card nt-rtpanel nt-rtpanel-1">';
    h += '<div class="nt-card-title">Harga Real-time</div>';
    var live = barisLive(kode);
    if (live) {
      h += live;
    } else if (M.sibuk) {
      h += '<div class="nt-note">Mengambil data real-time...</div>';
    } else {
      h += '<div class="nt-note">Belum diambil. Tekan Refresh untuk harga ' +
           'terkini ' + esc(kode) + ' saat bursa buka.</div>';
    }
    if (M.galat && !live) {
      h += '<div class="nt-note nt-err">' + esc(M.galat) + '</div>';
    }
    h += '<div class="nt-rowbtns">';
    h += '<button class="nt-b nt-b-primary" data-nv-quote-refresh ' +
         'data-nv-quote-codes="' + esc(kode) + '"' +
         (M.sibuk ? ' disabled' : '') + '>' +
         (M.sibuk ? 'Mengambil...' : 'Refresh Harga ' + esc(kode)) + '</button>';
    h += '</div>';
    h += '</div>';
    return h;
  }

  /* ---------------------------------------------------------
     EVENTS
     --------------------------------------------------------- */

  function bindGlobal() {
    var doc = w.document;
    doc.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('[data-nv-quote-refresh]')) {
        e.preventDefault();
        // Kalau tombol menyebut kode spesifik (mis. di halaman detail satu
        // saham), pakai kode itu saja supaya kuota feed IDX tidak terbuang.
        var btn = t.closest('[data-nv-quote-refresh]');
        var attr = btn.getAttribute && btn.getAttribute('data-nv-quote-codes');
        var codes = [];
        if (attr) {
          codes = attr.split(',').map(function (s) { return s.trim(); })
                    .filter(function (s) { return !!s; });
        }
        if (!codes.length && w.NavaTraderUI && w.NavaTraderUI.codesWatchlist) {
          codes = w.NavaTraderUI.codesWatchlist() || [];
        }
        muatQuote(codes, true);
        return;
      }
    });
  }

  function init() {
    if (M._inited) return;
    M._inited = true;
    bindGlobal();
  }

  w.NavaTraderQuote = {
    init: init,
    muat: muatQuote,
    cari: cari,
    ihsg: ihsg,
    hargaLive: hargaLive,
    panelRefresh: panelRefresh,
    panelRefreshSatu: panelRefreshSatu,
    barisLive: barisLive,
    badgeLive: badgeLive,
    badgeKeyakinan: badgeKeyakinan,
    gabungQuote: gabungQuote,
    state: M,
    _M: M
  };
})(typeof window !== 'undefined' ? window : this);