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

  /* ---------------------------------------------------------
     FALLBACK: Yahoo Finance (dipakai saat sumber utama gagal)
     --------------------------------------------------------- */

  /**
   * Cek apakah waktu saat ini berada di dalam jam perdagangan BEI / IDX (WIB).
   * Senin - Kamis:
   *   Sesi 1: 09:00 - 12:00 WIB
   *   Sesi 2: 13:30 - 16:00 WIB
   * Jumat:
   *   Sesi 1: 09:00 - 11:30 WIB
   *   Sesi 2: 14:00 - 16:00 WIB
   */
  function cekStatusBursa() {
    var now = new Date();
    var utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    var wib = new Date(utc + (7 * 3600000));
    var day = wib.getDay(); // 0=Min, 1=Sen ... 5=Jum, 6=Sab
    var jam = wib.getHours();
    var menit = wib.getMinutes();
    var totalMenit = jam * 60 + menit;

    var buka = false;
    if (day >= 1 && day <= 4) {
      if ((totalMenit >= 540 && totalMenit <= 720) || (totalMenit >= 810 && totalMenit <= 960)) {
        buka = true;
      }
    } else if (day === 5) {
      if ((totalMenit >= 540 && totalMenit <= 690) || (totalMenit >= 840 && totalMenit <= 960)) {
        buka = true;
      }
    }

    var jamStr = String(jam).padStart(2, '0') + ':' + String(menit).padStart(2, '0') + ' WIB';
    return {
      buka: buka,
      hariKerja: day >= 1 && day <= 5,
      jamWIB: jamStr
    };
  }

  /**
   * Ambil data satu simbol dari Yahoo Finance chart API via CORS proxy.
   * IDX stocks pakai ekstensi .JK, IHSG pakai ^JKSE.
   *
   * Mencoba beberapa proxy secara sekuensial dengan timeout 6 detik per percobaan.
   */
  function fetchYahooSymbol(symbol) {
    var sym = String(symbol || '').trim();
    if (sym.indexOf('%5E') === 0 || sym.indexOf('%5e') === 0) {
      sym = '^' + sym.substring(3);
    }

    var baseUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
      encodeURIComponent(sym) + '?interval=1m&range=1d';

    var proxies = [
      'https://proxy.cors.dev/?url=',
      'https://api.allorigins.win/raw?url='
    ];

    function tryProxy(index) {
      if (index >= proxies.length) {
        return Promise.reject(new Error('Semua CORS proxy gagal'));
      }
      var url = proxies[index] + encodeURIComponent(baseUrl);
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 6000) : null;

      return fetch(url, { signal: ctrl ? ctrl.signal : undefined })
        .then(function (resp) {
          if (timer) clearTimeout(timer);
          if (!resp.ok) throw new Error('Yahoo Finance HTTP ' + resp.status);
          return resp.json();
        })
        .then(function (data) {
          var r = (data && data.chart && data.chart.result && data.chart.result[0]) || {};
          var meta = r.meta || {};

          var price = meta.regularMarketPrice;
          if (price == null || isNaN(price)) {
            throw new Error('Data harga tidak valid untuk ' + sym);
          }

          var prevClose = meta.chartPreviousClose || meta.previousClose;
          var change = null;
          if (price != null && prevClose != null && prevClose !== 0) {
            change = ((price - prevClose) / prevClose) * 100;
          }

          var volume = 0;
          if (r.indicators && r.indicators.quote && r.indicators.quote[0]) {
            var q = r.indicators.quote[0];
            if (q.volume && q.volume.length) {
              volume = q.volume[q.volume.length - 1] || 0;
            }
          }

          var time = meta.regularMarketTime;
          var waktuWIB = '';
          if (time) {
            try {
              waktuWIB = new Date(time * 1000).toLocaleString('id-ID', {
                timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short',
                hour: '2-digit', minute: '2-digit'
              }) + ' WIB';
            } catch (e) {
              waktuWIB = new Date(time * 1000).toISOString();
            }
          }

          return {
            kode: meta.symbol || sym,
            harga: price,
            perubahan: change,
            volume: volume,
            waktuDataWIB: waktuWIB,
            waktuEpoch: time
          };
        })
        .catch(function () {
          if (timer) clearTimeout(timer);
          // Proxy ini gagal — coba proxy berikutnya
          return tryProxy(index + 1);
        });
    }

    return tryProxy(0);
  }

  /**
   * Fallback: ambil kutipan dari Yahoo Finance untuk daftar kode.
   * Mengembalikan respons dalam format yang sama dengan API utama.
   */
  function fetchYahooFallback(codes, denganIHSG) {
    // Bersihkan kode: hilangkan 'IHSG' atau '^JKSE' dari daftar saham biasa
    var cleanCodes = (codes || []).map(function (c) { return String(c || '').trim().toUpperCase(); })
      .filter(function (c) {
        return c && c !== 'IHSG' && c !== '^JKSE' && c !== '%5EJKSE';
      });

    var cs = cleanCodes.slice(0, 20);
    var symbols = cs.map(function (code) {
      return code.replace(/\.JK$/, '') + '.JK';
    });
    if (denganIHSG !== false) {
      symbols.push('^JKSE');
    }
    if (!symbols.length) return Promise.resolve(null);

    var bursa = cekStatusBursa();
    var defaultLabel = bursa.buka ? 'Real-time' : 'Delayed';

    var promises = symbols.map(function (sym) {
      return fetchYahooSymbol(sym).catch(function () {
        return null;
      });
    });

    return Promise.all(promises).then(function (results) {
      var saham = [];
      var ihsg = null;
      var berhasil = 0;
      var naik = 0, turun = 0, datar = 0;

      results.forEach(function (r) {
        if (!r || r.harga == null || isNaN(r.harga)) return;
        berhasil++;
        var code = String(r.kode || '').toUpperCase();
        var isIHSG = code === '^JKSE' || code === '%5EJKSE' || code === 'IHSG';

        if (typeof r.perubahan === 'number') {
          if (r.perubahan > 0.001) naik++;
          else if (r.perubahan < -0.001) turun++;
          else datar++;
        } else {
          datar++;
        }

        var qd = {
          ok: true,
          kode: isIHSG ? 'IHSG' : code.replace('.JK', ''),
          harga: r.harga,
          perubahan: r.perubahan,
          volume: r.volume,
          volumeSesi: r.volume,
          labelData: defaultLabel,
          keyakinan: 'sedang',
          keteranganData: 'Sumber: Yahoo Finance (' + defaultLabel + ')',
          waktuDataWIB: r.waktuDataWIB,
          sumber: 'Yahoo Finance' + (bursa.buka ? ' (real-time)' : ' (delayed)'),
          dariCacheBasi: false,
          alasanLabel: bursa.buka ? 'Intraday jam bursa' : 'Bursa tutup - harga sesi penutupan'
        };

        if (isIHSG) {
          ihsg = qd;
        } else {
          saham.push(qd);
        }
      });

      if (!berhasil) return null;

      var kondisi = 'Netral';
      if (ihsg && typeof ihsg.perubahan === 'number') {
        if (ihsg.perubahan > 0.3) kondisi = 'Bullish (▲ +' + ihsg.perubahan.toFixed(2) + '%)';
        else if (ihsg.perubahan < -0.3) kondisi = 'Bearish (▼ ' + ihsg.perubahan.toFixed(2) + '%)';
        else kondisi = 'Netral (' + (ihsg.perubahan >= 0 ? '+' : '') + ihsg.perubahan.toFixed(2) + '%)';
      }

      var note = bursa.buka
        ? 'Data harga real-time intraday Yahoo Finance saat jam bursa.'
        : 'Bursa sedang tutup (' + bursa.jamWIB + '). Menampilkan harga penutupan sesi terakhir (' + defaultLabel + '). Jam bursa: Senin-Jumat 09:00-16:00 WIB.';

      return {
        ok: true,
        saham: saham,
        ihsg: ihsg,
        ringkasan: {
          jumlahBerhasil: berhasil,
          jumlahDiminta: symbols.length,
          labelDataIHSG: defaultLabel,
          kondisiIHSG: kondisi,
          waktuDataIHSG: ihsg ? ihsg.waktuDataWIB : (saham[0] ? saham[0].waktuDataWIB : '-'),
          naik: naik,
          turun: turun,
          datar: datar,
          keyakinanIHSG: 'sedang'
        },
        sumber: 'Yahoo Finance' + (bursa.buka ? ' (real-time)' : ' (delayed)'),
        dariCache: false,
        catatan: note
      };
    });
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

    var S = Sync();
    /* Backend bot sync sudah dimatikan (sync.json kosong sejak 2026-10-03),
       jadi Yahoo Finance adalah SUMBER UTAMA — bukan "cadangan". Kalau backend
       belum dikonfigurasi, jangan tembak endpoint yang pasti gagal (dulu itu
       yang membuat label "fallback" muncul terus tiap muat). */
    var hasApi = !!(S && S.mascimApi && typeof S.isConfigured === 'function' && S.isConfigured());

    var primaryPromise = hasApi
      ? api('GET', q)
          .then(function (r) {
            if (r && r.ok) {
              M.quote = gabungQuote(M.quote, r);
              M.waktuAmbil = Date.now();
              var ring = M.quote.ringkasan || {};
              var label = ring.labelDataIHSG || 'Delayed';
              toast((r.dariCache ? 'Data (cache) ' : 'Data ') + label + ' - ' +
                    (ring.jumlahBerhasil || 0) + '/' + (ring.jumlahDiminta || 0) + ' simbol');
            } else {
              throw new Error((r && r.error) || 'Gagal mengambil data real-time');
            }
          })
      : Promise.reject(new Error('Backend bot tidak aktif'));

    return primaryPromise
      .catch(function () {
        return fetchYahooFallback(cs, denganIHSG)
          .then(function (fr) {
            if (fr && fr.ok) {
              M.gagalSeq = 0; // reset error counter saat berhasil
              M.galat = ''; // bersihkan pesan galat
              M.quote = gabungQuote(M.quote, fr);
              M.waktuAmbil = Date.now();
              var ring = fr.ringkasan || {};
              toast('Data ' + (ring.labelDataIHSG || 'Delayed') + ' - ' +
                    (ring.jumlahBerhasil || 0) + '/' + (ring.jumlahDiminta || 0) + ' simbol');
            } else {
              M.gagalSeq++;
              M.galat = (fr && fr.error) || 'Gagal mengambil data';
            }
          })
          .catch(function (e2) {
            M.gagalSeq++;
            M.galat = (e2 && e2.message) || 'Gagal mengambil data';
          });
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
         (M.sibuk ? 'Memuat...' : 'Refresh Harga Real-time') + '</button>';
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
         (M.sibuk ? 'Memuat...' : 'Refresh Harga ' + esc(kode)) + '</button>';
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
        if (!codes.length && w.NavaTraderUI) {
          if (w.NavaTraderUI.codesWatchlist) codes = w.NavaTraderUI.codesWatchlist() || [];
          if (!codes.length && w.NavaTraderUI._state && w.NavaTraderUI._state.pasar && w.NavaTraderUI._state.pasar.saham) {
            codes = w.NavaTraderUI._state.pasar.saham.map(function (s) { return s.kode; });
          }
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