/* =====================================================================
 * NAVA TRADER - MODUL BANDARMOLOGY (bandaran)
 * ---------------------------------------------------------------------
 * Sumber konsep & ambang (riset GitHub, lihat trader/LICENSE-NOTES.md):
 *
 *  1. milyas26/quant-bdm  (broker-summary/interface.ts + lib/utils.ts)
 *     Model bandarmology IDX: 6 kategori investor
 *       A  = Asing / Foreign          L  = Local ( fonds, dll)
 *       R  = Ritel                    P  = Produsen / Produser
 *       SM = Sarjana Muda             DM = Dana Manager
 *     Fungsi `getBandarStatus(netVol, totalVol)` di repo tersebut
 *     memakai ambang PERSEN volume bersih:
 *        |persen| < 3          -> Netral
 *        3 .. 10              -> Akumulasi Kecil
 *        10 .. 20             -> Akumulasi Normal
 *        >= 20                -> Akumulasi Besar
 *        (distribusi = cermin dari akumulasi)
 *     Konsep turunan yang juga dipesan di repo itu:
 *       - Retail Exhaustion (kekuatan posisi ritel vs puncak)
 *       - Floor Price (titik bantu dari net lot SM)
 *       - Top Accumulator / Top Distributor
 *
 *  2. sherwinchia/bandarmology, INo-xious/stockbit-mcp
 *     Konsep yang sama (analisa akumulasi/distribusi pasar Indonesia).
 *
 * ---------------------------------------------------------------------
 * ⚠️ KETERBATASAN YANG DISAMPINGKAN DENGAN JUJUR — BACA INI DULU
 * ---------------------------------------------------------------------
 * Bandarmoliogi SEBENARNYA memakai data "broker summary" milik Stockbit/
 * IDX: angka lot beli/jual tiap kode broker (mandiri, BII, dll) yang
 * dikelompokkan jadi A/R/L/P/SM/DM. Data itu PROPRIETARY dan tidak
 * tersedia untuk aplikasi ini — endpoint publiknya menolak permintaan
 * tanpa header aplikasi resmi (sudah diuji).
 *
 * Mini app ini HANYA punya data OHLCV harian (Yahoo Finance, EOD).
 * Jadi modul ini menghitung BANDARAN PERKIRAAN berbasis
 * "distribusi harga-volume" (mirip Volume Profile / A-D histogram),
 * BUKAN ringkasan broker asli.
 *
 * Semua hasil modul ini diberi label "estimasi" dan TIDAK BOLEH
 * dibaca sebagai data bandarmology asli. Jangan pernah menampilkan
 * angka A/R/L/P/SM/DM di sini - itu akan menjadi data fabrikasi.
 *
 * Yang diambil dari riset: struktur ambang (%), kategori, dan
 * terminologi. Yang dihitung sendiri: distribusi harga-volume.
 * ===================================================================== */
(function (w) {
  'use strict';

  /* ---------- ambang bandaran (dari getBandarStatus, lihat header) ---- */
  var AMBANG = {
    netral: 3,        // |persen| < 3  -> Netral
    kecil: 10,        // 3..10        -> Akumulasi/Distribusi Kecil
    normal: 20,       // 10..20       -> Normal
                      // >= 20        -> Besar
    naikMinimal: 50   // alien >= 50% bar volume di atas harga -> Tren Naik
  };

  var KATEGORI = [
    { kode: 'A',  nama: 'Asing' },
    { kode: 'R',  nama: 'Ritel' },
    { kode: 'L',  nama: 'Lokal' },
    { kode: 'P',  nama: 'Produsen' },
    { kode: 'SM', nama: 'Sarjana Muda' },
    { kode: 'DM', nama: 'Dana Manager' }
  ];

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(x, fb) { var n = Number(x); return isFinite(n) ? n : (fb === undefined ? 0 : fb); }
  function round(n, d) { var f = Math.pow(10, d === undefined ? 2 : d); return Math.round(num(n) * f) / f; }
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

  /* ------------------------------------------------------------------
   * statusBandar(persen) - cerminan persis getBandarStatus di repo acuan
   * ------------------------------------------------------------------ */
  function statusBandar(persen) {
    var p = num(persen);
    if (Math.abs(p) < AMBANG.netral) return 'Netral';
    if (p >= AMBANG.normal) return 'Akumulasi Besar';
    if (p >= AMBANG.kecil) return 'Akumulasi Normal';
    if (p >= AMBANG.netral) return 'Akumulasi Kecil';
    if (p <= -AMBANG.normal) return 'Distribusi Besar';
    if (p <= -AMBANG.kecil) return 'Distribusi Normal';
    return 'Distribusi Kecil';
  }

  /* ------------------------------------------------------------------
   * Klasifikasi arah banding (acc/dist/neutral) + skor -50..+50
   * ------------------------------------------------------------------ */
  function arahBandar(status) {
    if (status.indexOf('Akumulasi') === 0) return 'Akumulasi';
    if (status.indexOf('Distribusi') === 0) return 'Distribusi';
    return 'Netral';
  }

  function skorDariStatus(status) {
    switch (status) {
      case 'Akumulasi Besar': return 50;
      case 'Akumulasi Normal': return 32;
      case 'Akumulasi Kecil': return 16;
      case 'Distribusi Besar': return -50;
      case 'Distribusi Normal': return -32;
      case 'Distribusi Kecil': return -16;
      default: return 0;
    }
  }

  /* ------------------------------------------------------------------
   * volumeProfile - distribusi volume per bucket harga.
   * Inti "perbandingan volume" yang dipakai bandarmologi, dihitung dari
   * OHLCV: kapan harga tinggi, volume besar?
   * ------------------------------------------------------------------ */
  function volumeProfile(bar, bucket) {
    var n = bar && bar.length ? bar.length : 0;
    if (!n) return null;
    var jml = bucket || 20;

    var lo = Infinity, hi = -Infinity, i;
    for (i = 0; i < n; i++) {
      var l = num(bar[i].low), h = num(bar[i].high);
      if (l > 0 && l < lo) lo = l;
      if (h > hi) hi = h;
    }
    if (!isFinite(lo) || !isFinite(hi) || hi <= lo) return null;

    var lebar = (hi - lo) / jml;
    if (lebar <= 0) return null;

    var vol = new Array(jml), hls = new Array(jml), tip = new Array(jml), nBuy = new Array(jml);
    for (i = 0; i < jml; i++) { vol[i] = 0; hls[i] = 0; tip[i] = 0; nBuy[i] = 0; }

    // Panjang candle = tekanan beli (close > open) vs jual.
    for (i = 0; i < n; i++) {
      var o = num(bar[i].open), c = num(bar[i].close),
          h = num(bar[i].high), l = num(bar[i].low), v = num(bar[i].volume);
      if (v <= 0) continue;
      var tengah = (h + l) / 2;
      var idx = Math.floor((tengah - lo) / lebar);
      if (idx < 0) idx = 0;
      if (idx >= jml) idx = jml - 1;
      vol[idx] += v;
      hls[idx] += v * (h + l) / 2;
      if (c >= o) { nBuy[idx] += v; tip[idx] += v; }
      else { tip[idx] -= v; }
    }

    var totalVol = 0, totalBeli = 0, totalJual = 0;
    for (i = 0; i < jml; i++) {
      totalVol += vol[i];
      if (tip[i] >= 0) totalBeli += tip[i];
      else totalJual += -tip[i];
    }
    if (totalVol <= 0) return null;

    // TitikPnV = bucket dengan volume terbesar (area bandaran/"base").
    var idxPnv = 0;
    for (i = 1; i < jml; i++) if (vol[i] > vol[idxPnv]) idxPnv = i;
    var pnvMulai = lo + idxPnv * lebar;
    var pnvAkhir = pnvMulai + lebar;

    // TitikDidukung = bucket teratas yang volumenya >= 40% dari PnV.
    var idxSup = idxPnv;
    for (i = idxPnv + 1; i < jml; i++) {
      if (vol[idxPnv] > 0 && vol[i] >= 0.4 * vol[idxPnv]) idxSup = i;
      else break;
    }
    var idxSup2 = idxPnv;
    for (i = idxPnv - 1; i >= 0; i--) {
      if (vol[idxPnv] > 0 && vol[i] >= 0.4 * vol[idxPnv]) idxSup2 = i;
      else break;
    }

    // Volume di atas / di bawah harga sekarang -> "aliran" pasar.
    var harga = num(bar[n - 1].close);
    var volAtas = 0, volBawah = 0, idxHarga = Math.floor((harga - lo) / lebar);
    for (i = idxHarga + 1; i < jml; i++) volAtas += vol[i];
    for (i = 0; i < idxHarga && i < jml; i++) volBawah += vol[i];
    var totalJml = volAtas + volBawah;
    var persenAtas = totalJml > 0 ? (volAtas / totalJml) * 100 : 50;

    return {
      lo: lo, hi: hi, lebar: lebar, jml: jml,
      vol: vol, hls: hls, totalVol: totalVol,
      totalBeli: totalBeli, totalJual: totalJual,
      netVol: totalBeli - totalJual,
      netPersen: totalJml > 0 ? ((volAtas - volBawah) / totalJml) * 100 : 0,
      persenAtas: persenAtas,
      pnvMulai: pnvMulai, pnvAkhir: pnvAkhir,
      idxPnv: idxPnv,
      dukungBawah: lo + idxSup2 * lebar,
      dukungAtas: lo + idxSup * lebar + lebar
    };
  }

  /* ------------------------------------------------------------------
   * moneyFlowRecen - "aliran dana" memakai garis Accumulation/Distribution.
   *
   * Kenapa bukan "volume di atas vs bawah harga"? Karena cara itu salah
   * untuk analisa: pada saham yang sedang turun, hampir semua bar berada
   * di atas harga sekarang, sehingga ALWAYS terbaca "Akumulasi Besar"
   * padahal justru sahamnya melemah. Itu cuma posisi dalam rentang.
   *
   * Garis A-D (Chaikin Accumulation/Distribution) menghitung MANA tutup
   * berada dalam range harian, lalu menambahkan volume sekalian:
   *
   *   multiplier = ((close - low) - (high - close)) / (high - low)
   *   moneyFlow = multiplier x volume
   *
   * Close di dekat high  -> multiplier positif -> volume dianggap BELI
   * Close di dekat low   -> multiplier negatif -> volume dianggap JUAL
   * Hallebt sich echte Kauf-/Verkaufsdruck ab, statt nur Preisposition.
   *
   * Dari moneyFlow kita ambil rata-rata 60 bar terakhir, lalu diskalakan
   * menjadi "% volume" agar sebanding dengan ambang 3 / 10 / 20.
   * ------------------------------------------------------------------ */
  function moneyFlowRecen(bar, jendela) {
    var n = bar && bar.length ? bar.length : 0;
    if (!n) return { net: 0, total: 0, persen: 0, garis: [], jendela: 0, slope: 0 };
    var win = Math.min(n, jendela || 60);
    var mulai = n - win;

    // Bangun garis A-D kumulatif untuk seluruh riwayat, lalu ambil
    // selisihnya pada jendela terakhir.
    var garis = new Array(n);
    var kumulatif = 0;
    for (var i = 0; i < n; i++) {
      var h = num(bar[i].high), l = num(bar[i].low),
          c = num(bar[i].close), v = num(bar[i].volume);
      var mult = 0;
      if (h > l) mult = ((c - l) - (h - c)) / (h - l);
      kumulatif += mult * v;
      garis[i] = kumulatif;
    }

    // Jumlah money flow (bukan selisih garis kumulatif) pada jendela.
    // MF per-bulan = jumlah MF / (total volume / jumlah bar) ->parable dengan
    // angka ambang 3/10/20 dalam satuan "% volume".
    var net = 0, totalVol = 0;
    for (i = mulai; i < n; i++) {
      var hh = num(bar[i].high), ll = num(bar[i].low),
          cc = num(bar[i].close), vv = num(bar[i].volume);
      var mm = 0;
      if (hh > ll) mm = ((cc - ll) - (hh - cc)) / (hh - ll);
      net += mm * vv;
      totalVol += vv;
    }

    // Rata-rata money flow per bar, diskalakan ke "% volume" agar
    // berada di rentang -100..+100 (dibanding volume rata-rata bar).
    var volRataBar = win > 0 ? totalVol / win : 0;
    var perBar = volRataBar > 0 ? (net / win) / volRataBar : 0;
    var slope = perBar * 100;

    return {
      net: net,
      total: totalVol,
      persen: perBar * 100,
      garis: garis,
      slope: slope,
      jendela: win
    };
  }

  /* ------------------------------------------------------------------
   * analisisBandar - hasil utama.
   * Menghasilkan "bandar" (status + skor) dari beberapa sudut:
   *   1. Distribusi harga-volume (net volume di atas vs bawah harga)
   *   2. Tekanan beli/jual dari arah candle
   *   3. Posisi harga terhadap area Dukung (PnV)
   *   4. Tren volume (ekspansi/kontraksi)
   * ------------------------------------------------------------------ */
  function analisisBandar(bar, opts) {
    var o = opts || {};
    var n = bar && bar.length ? bar.length : 0;
    if (n < 10) {
      return {
        ada: false, status: 'Netral', arah: 'Netral', skor: 0,
        netPersen: 0, netVol: 0, totalVol: 0,
        pnv: null, dukungBawah: null, dukungAtas: null,
        posisi: 'Tidak diketahui',
        tekanan: 0, trenVolume: 'Tidak diketahui',
        exhaustion: null, alasan: ['Data kurang dari 10 hari - belum bisa dihitung.'],
        peringatan: ['Butuh minimal 10 bar harian.']
      };
    }

    var vp = volumeProfile(bar, o.bucket || 20);
    if (!vp) {
      return {
        ada: false, status: 'Netral', arah: 'Netral', skor: 0,
        netPersen: 0, netVol: 0, totalVol: 0,
        pnv: null, dukungBawah: null, dukungAtas: null,
        posisi: 'Tidak diketahui',
        tekanan: 0, trenVolume: 'Tidak dikenal',
        exhaustion: null, alasan: ['Rentang harga tidak valid.'],
        peringatan: ['Data tidak bisa dihitung.']
      };
    }

    var alasan = [], peringatan = [];
    var close = num(bar[n - 1].close);

    /* 1. Status utama: net volume JENDELA 60 BAR TERAKHIR (bukan seluruh
     * riwayat), supaya angkanya mencerminkan aliran dana yang baru. */
    var nv = moneyFlowRecen(bar, o.jendela || 60);
    var persenAliran = nv.persen;
    var status = statusBandar(persenAliran);
    var arah = arahBandar(status);
    var skor = skorDariStatus(status);

    /* 2. Tekanan arah candle, memakai JENDELA YANG SAMA (60 bar) supaya
     * tidak bertentangan dengan status utama di atas. */
    var win = nv.jendela || 60, mulaiWin = n - win;
    var volNaik = 0, volTurun = 0;
    for (var ic = mulaiWin; ic < n; ic++) {
      var cv = num(bar[ic].volume);
      if (cv <= 0) continue;
      if (num(bar[ic].close) >= num(bar[ic].open)) volNaik += cv;
      else volTurun += cv;
    }
    var totalCandle = volNaik + volTurun;
    var tekanan = totalCandle > 0 ? ((volNaik - volTurun) / totalCandle) * 100 : 0;
    if (Math.abs(tekanan) >= 8) {
      if (tekanan > 0) {
        alasan.push('Dalam ' + win + ' hari terakhir, volume pada candle naik ' +
                     round(tekanan, 1) + '% lebih besar dari candle turun - tekanan beli.');
      } else {
        alasan.push('Dalam ' + win + ' hari terakhir, volume pada candle turun ' +
                     round(-tekanan, 1) + '% lebih besar dari candle naik - tekanan jual.');
      }
    }

    /* 3. Posisi harga terhadap area Dukung (PnV) */
    var posisi = 'Di Atas Dukungan';
    var diAtasPnv = close > vp.pnvAkhir;
    var diBawahPnv = close < vp.pnvMulai;
    if (diAtasPnv) {
      posisi = 'Di Atas PnV';
      skor += 6;
      alasan.push('Harga ' + round(close, 0) + ' berada di atas area PnV (Point of Control) ' +
                  round(vp.pnvMulai, 0) + '-' + round(vp.pnvAkhir, 0) + '.');
    } else if (diBawahPnv) {
      posisi = 'Di Bawah PnV';
      skor -= 6;
      alasan.push('Harga ' + round(close, 0) + ' turun ke bawah area PnV ' +
                  round(vp.pnvMulai, 0) + '-' + round(vp.pnvAkhir, 0) + '.');
    } else {
      alasan.push('Harga masih berada di dalam area PnV (belum ada arah jelas).');
    }

    /* 4. Tren volume: volume terakhir vs rata-rata 20 hari */
    var volRata = 0, cnt = Math.min(20, n);
    for (var i = n - cnt; i < n; i++) volRata += num(bar[i].volume);
    volRata = cnt > 0 ? volRata / cnt : 0;
    var volAkhir = num(bar[n - 1].volume);
    var trenVolume = 'Tidak diketahui';
    if (volRata > 0) {
      var rasio = volAkhir / volRata;
      if (rasio >= 1.4) {
        trenVolume = 'Ekspansi';
        alasan.push('Volume hari ini ' + round(rasio, 2) + 'x rata-rata 20 hari - ekspansi, ada pendorong.');
      } else if (rasio <= 0.6) {
        trenVolume = 'Kontraksi';
        alasan.push('Volume hari ini hanya ' + round(rasio, 2) + 'x rata-rata - kontraksi, dorongan melemah.');
      } else {
        trenVolume = 'Normal';
      }
    }

    /* 5. Exhaustion (kelelahan): volume naik tetapi harga tidak ikut naik
       menandakan kelelahan buyer / rally tanpa dukungan. */
    var ex = null;
    if (n >= 6) {
      var naik = num(bar[n - 1].close) > num(bar[n - 6].close);
      var volNaik = num(bar[n - 1].volume) > num(bar[n - 6].volume);
      if (!naik && volNaik) {
        ex = 'kelelahan jual';
        skor -= 8;
        peringatan.push('Pola kelelahan: 5 hari terakhir turun padahal volume naik - risiko untuk reversal.');
      } else if (naik && !volNaik) {
        ex = 'rally lemah';
        skor += 4;
        alasan.push('Harga naik 5 hari tetapi volume mengecil - rally tanpa dukungan volume.');
      }
    }

    skor = clamp(skor, -100, 100);

    /* 6. Gabungkan dengan tekanan candle (bobot kecil) */
    var skorFinal = clamp(skor + tekanan * 0.15, -100, 100);
    // Status akhir tetap memakai arah UTAMA dari net volume; kalau skor
    // gabungan berlawanan arah dengan itu, status diturunkan ke Netral
    // supaya tidak kontradiktif.
    var statusGabungan;
    if (arah === 'Akumulasi') {
      statusGabungan = skorFinal > 0 ? statusBandar(Math.abs(skorFinal)) : 'Netral';
    } else if (arah === 'Distribusi') {
      statusGabungan = skorFinal < 0 ? statusBandar(-Math.abs(skorFinal)) : 'Netral';
    } else {
      statusGabungan = 'Netral';
    }

    // Arah akhir harus sinkron dengan status akhir supaya UI tidak
    // menampilkan panah "Akumulasi" bersamaan dengan teks "Netral".
    var arahFinal = arahBandar(statusGabungan);

    if (arah === 'Netral') {
      alasan.push('Net volume ' + win + ' hari terakhir dalam zona netral (|selisih| < ' +
                  AMBANG.netral + '%) - tidak ada aliran dana yang domina.');
    }
    if (arah === 'Akumulasi') {
      alasan.push('Bandaran akumulasi: ' + round(persenAliran, 1) +
                  '% volume berbobot berada di atas harga sekarang (jendela ' + win + ' hari).');
    } else if (arah === 'Distribusi') {
      alasan.push('Bandaran distribusi: ' + round(-persenAliran, 1) +
                  '% volume berbobot berada di bawah harga sekarang (jendela ' + win + ' hari).');
    }

    return {
      ada: true,
      status: statusGabungan,
      statusDasar: status,
      arah: arahFinal,
      arahDasar: arah,
      skor: round(skorFinal, 1),
      netPersen: round(persenAliran, 1),
      moneyFlow: round(nv.net, 0),
      slopeAD: round(nv.slope, 3),
      netVol: round(nv.net, 0),
      totalVol: round(nv.total, 0),
      jendela: nv.jendela,
      persenAtas: round(vp.persenAtas, 1),
      pnv: { mulai: round(vp.pnvMulai, 0), akhir: round(vp.pnvAkhir, 0) },
      pnvMulai: round(vp.pnvMulai, 0),
      pnvAkhir: round(vp.pnvAkhir, 0),
      dukungBawah: round(vp.dukungBawah, 0),
      dukungAtas: round(vp.dukungAtas, 0),
      posisi: posisi,
      tekanan: round(tekanan, 1),
      trenVolume: trenVolume,
      exhaustion: ex,
      alasan: alasan,
      peringatan: peringatan,
      // Nilaikasar untuk grafik volume profile (bar).
      profil: vp.vol
    };
  }

  /* ------------------------------------------------------------------
   * ringkasanPasar - bandaran agregat IHSG + watchlist.
   * Untuk memberi gambaran kasar arah dana pasar.
   * ------------------------------------------------------------------ */
  function ringkasanPasar(hasilPerSaham) {
    var arr = hasilPerSaham || [];
    var nAcc = 0, nDist = 0, nNetral = 0, jmlSkor = 0, ada = 0;
    for (var i = 0; i < arr.length; i++) {
      var b = arr[i];
      if (!b || !b.ada) continue;
      ada++;
      jmlSkor += b.skor;
      if (b.arah === 'Akumulasi') nAcc++;
      else if (b.arah === 'Distribusi') nDist++;
      else nNetral++;
    }
    var rerata = ada > 0 ? round(jmlSkor / ada, 1) : 0;
    var statusPasar = 'Netral';
    if (ada > 0) {
      if (rerata >= 25) statusPasar = 'Akumulasi Besar';
      else if (rerata >= 12) statusPasar = 'Akumulasi Normal';
      else if (rerata >= 5) statusPasar = 'Akumulasi Kecil';
      else if (rerata <= -25) statusPasar = 'Distribusi Besar';
      else if (rerata <= -12) statusPasar = 'Distribusi Normal';
      else if (rerata <= -5) statusPasar = 'Distribusi Kecil';
    }
    return {
      jumlah: ada,
      nAcc: nAcc, nDist: nDist, nNetral: nNetral,
      rerataSkor: rerata,
      status: statusPasar,
      arah: arahBandar(statusPasar)
    };
  }

  w.NavaTraderBandar = {
    AMBANG: AMBANG,
    KATEGORI: KATEGORI,
    statusBandar: statusBandar,
    arahBandar: arahBandar,
    skorDariStatus: skorDariStatus,
    volumeProfile: volumeProfile,
    moneyFlowRecen: moneyFlowRecen,
    analisisBandar: analisisBandar,
    ringkasanPasar: ringkasanPasar
  };
})(typeof window !== 'undefined' ? window : this);
