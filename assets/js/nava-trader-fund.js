/* =========================================================
   nava-trader-fund.js - Modul analisa fundamentals lanjutan
   (Valuation, Cash Flow Quality, Debt/Financial Health,
    Earnings & Growth, Corporate Action & Catalyst,
    Sector & Macro, Risk/Reward, Market Regime)

   TRANSAKSI OTOMATIS: TIDAK ADA.
   Modul ini murni MENGANALISA dan MELAPORKAN. Tidak pernah
   mengirim order ke bursa. Keputusan dan eksekusi tetap
   100% di tangan pengguna.

   KETENTUAN PENTING:
     - Modul ini TIDAK membuat skor/ranking baru. Skor yang
       sudah ada (teknikal, fundamental, bandarmology) milik
       nava-trader-core.js dan nava-trader-bandar.js dan TIDAK
       diubah di sini. Modul ini hanya menambah LAPORAN.
     - Modul ini TIDAK menduplikasi angka yang sudah tampil.
       Yang dihitung ulang hanya yang benar-benar baru
       (mis. FCF Yield, Net Debt, interest coverage, growth).
     - kalau sebuah metrik tidak tersedia di sumber data,
       hasilnya null dan ditampilkan "Data tidak tersedia".
       TIDAK PERNAH mengarang angka.

   Data: Yahoo Finance quoteSummary (EOD / Delayed).
   Tidak intraday, tidak real-time.

   SELURUH KODE DITULIS DARI NOL. Tidak ada baris yang disalin
   dari OpenBB / Qlib / vectorbt / library lain. Yang diadaptasi
   hanya rumus keuangan publishik (PER = harga / EPS, DER =
   utang / modal, dst) yang merupakan definisi baku.
   ========================================================= */
(function (w) {
  'use strict';

  var TANPA = 'Data tidak tersedia';

  /* ---------------------------------------------------------
     UTILITAS
     --------------------------------------------------------- */

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(x) { var n = Number(x); return isFinite(n) ? n : null; }
  function round(n, d) {
    if (!isNum(n)) return null;
    var f = Math.pow(10, d === undefined ? 2 : d);
    return Math.round(n * f) / f;
  }
  function bagi(a, b) {
    if (!isNum(a) || !isNum(b) || b === 0) return null;
    return a / b;
  }

  // Ambil nilai numerik dari Objek Yahoo (bisa {raw:x} atau angka).
  function v(node) {
    if (node === null || node === undefined) return null;
    if (typeof node === 'number') return isFinite(node) ? node : null;
    if (node.raw !== undefined && node.raw !== null) {
      return isFinite(Number(node.raw)) ? Number(node.raw) : null;
    }
    return null;
  }

  // Format rupiah besar jadi ringkas (mis. 1.82 T / 375.9 M / 1.250 J).
  function fmtRupiah(x) {
    if (!isNum(x)) return TANPA;
    var a = Math.abs(x);
    if (a >= 1e12) return fmt(x / 1e12, 2) + ' T';
    if (a >= 1e9) return fmt(x / 1e9, 1) + ' M';
    if (a >= 1e6) return fmt(x / 1e6, 1) + ' J';
    return fmt(x, 0);
  }

  // Ambil dari dua modul sekaligus: quoteSummary stores {modul:{field:{raw}}}.
  function ambil(fund, modul, field) {
    if (!fund) return null;
    var m = fund[modul];
    if (!m) return null;
    return v(m[field]);
  }

  /* ---------------------------------------------------------
     SEKTOR KEUANGAN
     Untuk bank dan multifinance, metrik OCF/FCF/EBITDA tidak
     berlaku sebagai sinyal kualitas laba. Pada bank, pertumbuhan
     pinjaman masuk ke arus operasi sehingga OCF bisa sangat
     negatif meski laba positif. Melaporkannya sebagai
     "laba naik tapi kas negatif" adalah kesimpulan yang salah,
     jadi modul ini menandai metrik tersebut tidak berlaku
     alih-alih mengeluarkan peringatan palsu.
     --------------------------------------------------------- */
  var POLA_SEKTOR_KEUANGAN = /financial|bank|insurance|multi ?finance/i;

  function sektorKeuangan(fund) {
    if (!fund) return false;
    var p = fund.profil || {};
    var teks = [p.sector, p.industry].filter(Boolean).join(' ');
    if (!teks) return false;
    return POLA_SEKTOR_KEUANGAN.test(teks);
  }

  function fmt(x, d) {
    if (!isNum(x)) return TANPA;
    return String(round(x, d === undefined ? 2 : d));
  }
  function fmtPersen(x, d) {
    if (!isNum(x)) return TANPA;
    return fmt(x * 100, d === undefined ? 1 : d) + '%';
  }

  /* ---------------------------------------------------------
     1. VALUATION
     PER, PBV, EV/EBITDA, PEG, Free Cash Flow Yield.
     Dibanding secara historis: dengan rata-rata sektor dari peer
     yang benar-benar ada di watchlist (bukan angka karangan),
     dan dengan level historis harga/eps sendiri bila tersedia.
     --------------------------------------------------------- */

  // Ambil metrik valuasi satu saham (dinormalisasi ke bentuk datar).
  function metrikValuasi(fund) {
    if (!fund) return null;
    var per = ambil(fund, 'summaryDetail', 'trailingPE');
    var perFwd = ambil(fund, 'summaryDetail', 'forwardPE');
    var pbv = ambil(fund, 'defaultKeyStatistics', 'priceToBook');
    var peg = ambil(fund, 'defaultKeyStatistics', 'pegRatio');
    var evEbitda = ambil(fund, 'defaultKeyStatistics', 'enterpriseToEbitda');
    var evRev = ambil(fund, 'defaultKeyStatistics', 'enterpriseToRevenue');
    var bv = ambil(fund, 'defaultKeyStatistics', 'bookValue');
    var eps = ambil(fund, 'defaultKeyStatistics', 'trailingEps');
    var harga = ambil(fund, 'financialData', 'currentPrice');
    var fcf = ambil(fund, 'financialData', 'freeCashflow');
    var ocf = ambil(fund, 'financialData', 'operatingCashflow');
    var ebitda = ambil(fund, 'financialData', 'ebitda');
    var mcap = ambil(fund, 'defaultKeyStatistics', 'marketCap');
    if (isNum(mcap) && isNum(shares)) { /* dipakai di bawah */ }

    // Free Cash Flow Yield = FCF / Market Cap.
    // Kalau marketCap tidak ada, turunkan dari harga x jumlah saham.
    var kap = mcap;
    if (!isNum(kap)) {
      var sh = ambil(fund, 'defaultKeyStatistics', 'sharesOutstanding');
      if (isNum(harga) && isNum(sh)) kap = harga * sh;
    }
    var fcfYield = bagi(fcf, kap);

    return {
      per: per, perForward: perFwd, pbv: pbv, peg: peg,
      evEbitda: evEbitda, evRevenue: evRev,
      bookValue: bv, epsTrailing: eps, harga: harga,
      ebitda: ebitda, ocf: ocf, fcf: fcf, marketCap: kap,
      fcfYield: fcfYield
    };
  }

  // Bandingkan satu saham dengan rata-rata sektor (dari peer nyata).
  function bandingkanSektor(metrik, listMetrikSektor) {
    var arr = (listMetrikSektor || []).filter(function (m) { return m && m; });
    if (!metrik || arr.length === 0) return null;
    function hitung(field) {
      var vals = arr.map(function (m) { return m[field]; })
                     .filter(function (x) { return isNum(x) && x > 0; });
      if (vals.length === 0) return null;
      var sum = vals.reduce(function (a, b) { return a + b; }, 0);
      return { rata: round(sum / vals.length, 2), jumlah: vals.length };
    }
    var out = {
      per: hitung('per'), pbv: hitung('pbv'), peg: hitung('peg'),
      evEbitda: hitung('evEbitda'), fcfYield: hitung('fcfYield')
    };
    // Posisi relatif tiap metrik (lebih murah = lebih rendah).
    function pos(nilai, ref) {
      if (!isNum(nilai) || !ref) return null;
      if (nilai < ref * 0.75) return 'Jauh lebih murah dari rata-rata sektor';
      if (nilai < ref) return 'Lebih murah dari rata-rata sektor';
      if (nilai <= ref * 1.25) return 'Sebagian di sekitar rata-rata sektor';
      if (nilai <= ref * 1.75) return 'Lebih mahal dari rata-rata sektor';
      return 'Jauh lebih mahal dari rata-rata sektor';
    }
    out.relative = {
      per: pos(metrik.per, out.per && out.per.rata),
      pbv: pos(metrik.pbv, out.pbv && out.pbv.rata),
      peg: pos(metrik.peg, out.peg && out.peg.rata),
      evEbitda: pos(metrik.evEbitda, out.evEbitda && out.evEbitda.rata),
      fcfYield: pos(metrik.fcfYield, out.fcfYield && out.fcfYield.rata)
    };
    return out;
  }

  // Rata-rata historis sendiri: pakai series PER/PBV yang disimpan
  // dari snapshot sebelumnya (kalau ada). Tanpa snapshot -> null.
  function bandingkanHistoris(metrik, histori) {
    if (!metrik || !histori) return null;
    var out = {};
    ['per', 'pbv', 'peg'].forEach(function (f) {
      var arr = (histori[f] || []).filter(function (x) { return isNum(x) && x > 0; });
      if (!isNum(metrik[f]) || arr.length < 3) { out[f] = null; return; }
      var sum = arr.reduce(function (a, b) { return a + b; }, 0);
      var rata = sum / arr.length;
      var posisi = metrik[f] < rata * 0.8 ? 'di bawah rata-rata historis' :
                   metrik[f] > rata * 1.25 ? 'di atas rata-rata historis' :
                   'sekitar rata-rata historis';
      out[f] = { rata: round(rata, 2), jumlah: arr.length, posisi: posisi };
    });
    return out;
  }

  function laporanValuasi(fund, opts) {
    opts = opts || {};
    var metrik = metrikValuasi(fund);
    if (!metrik) return { tersedia: false, pesan: 'Data valuasi tidak tersedia.' };
    var sek = bandingkanSektor(metrik, opts.sektor);
    var hist = bandingkanHistoris(metrik, opts.historis);
    return {
      tersedia: true,
      metrik: metrik,
      label: {
        per: fmt(metrik.per, 2) + 'x',
        perForward: fmt(metrik.perForward, 2) + 'x',
        pbv: fmt(metrik.pbv, 2) + 'x',
        peg: fmt(metrik.peg, 2) + 'x',
        evEbitda: fmt(metrik.evEbitda, 2) + 'x',
        evRevenue: fmt(metrik.evRevenue, 2) + 'x',
        fcfYield: fmtPersen(metrik.fcfYield, 2)
      },
      bandingkanSektor: sek,
      bandingkanHistoris: hist
    };
  }

  /* ---------------------------------------------------------
     2. CASH FLOW QUALITY
     Operating Cash Flow, Free Cash Flow, banding laba vs OCF.
     Deteksi "laba naik tapi kas melemah/negatif".
     --------------------------------------------------------- */

  function laporanCashFlow(fund, opts) {
    opts = opts || {};
    if (!fund) return { tersedia: false, pesan: 'Data arus kas tidak tersedia.' };
    var ocf = ambil(fund, 'financialData', 'operatingCashflow');
    var fcf = ambil(fund, 'financialData', 'freeCashflow');
    var revenue = ambil(fund, 'financialData', 'totalRevenue');
    var ebitda = ambil(fund, 'financialData', 'ebitda');
    var kap = ambil(fund, 'defaultKeyStatistics', 'marketCap');
    var harga = ambil(fund, 'financialData', 'currentPrice');
    if (!isNum(kap)) {
      var sh = ambil(fund, 'defaultKeyStatistics', 'sharesOutstanding');
      if (isNum(harga) && isNum(sh)) kap = harga * sh;
    }
    // Laba bersih: netIncomeToCommon ada di defaultKeyStatistics (bukan
    // financialData). Fallback ke EPS x saham hanya bila field itu kosong,
    // dan hasilnya tetap dilabeli proksi.
    var sh2 = ambil(fund, 'defaultKeyStatistics', 'sharesOutstanding');
    var eps = ambil(fund, 'defaultKeyStatistics', 'trailingEps');
    var laba = ambil(fund, 'defaultKeyStatistics', 'netIncomeToCommon');
    var labaProksi = null;
    var labaAdalahProksi = false;
    if (isNum(laba)) {
      labaProksi = laba;
    } else if (isNum(eps) && isNum(sh2)) {
      labaProksi = eps * sh2;
      labaAdalahProksi = true;
    }

    var ocfMargin = bagi(ocf, revenue);
    var fcfMargin = bagi(fcf, revenue);
    var ocfPerShare = (isNum(ocf) && isNum(sh2)) ? ocf / sh2 : null;
    var cashKonversi = (isNum(ocf) && isNum(labaProksi) && labaProksi > 0)
      ? ocf / labaProksi : null;

    // Deteksi kondisi: laba tumbuh tapi kas melemah / negatif.
    var labaTumbuh = ambil(fund, 'financialData', 'earningsGrowth');
    var revTumbuh = ambil(fund, 'financialData', 'revenueGrowth');
    var ocfSebelumnya = opts.ocfSebelumnya;
    var warning = null;
    var catatan = null;
    var keuangan = sektorKeuangan(fund);
    if (keuangan) {
      // Pada bank, OCF negatif adalah artefak akuntansi karena
      // pertumbuhan pinjaman masuk ke arus operasi. Melaporkannya
      // sebagai "laba naik tapi kas negatif" adalah kesimpulan salah.
      catatan = 'Sektor keuangan: metrik arus kas operasi tidak ' +
        'mewingatkan kualitas laba. Fokus pada NPL, CASA, dan margin bunga.';
    } else if (isNum(ocf) && ocf < 0) {
      warning = 'Arus kas operasi negatif walau laba tercatat positif - kualitas laba perlu diwaspadai.';
    } else if (isNum(labaTumbuh) && labaTumbuh > 0.05 &&
               isNum(ocf) && isNum(ocfSebelumnya) && ocfSebelumnya !== 0 &&
               ocf < ocfSebelumnya) {
      warning = 'Laba tumbuh tetapi arus kas operasi melemah dibanding periode sebelumnya.';
    } else if (isNum(labaTumbuh) && labaTumbuh > 0.05 && isNum(cashKonversi) && cashKonversi < 0.5) {
      warning = 'Laba tumbuh tetapi konversi laba ke kas rendah (<50%).';
    }

    return {
      tersedia: isNum(ocf) || isNum(fcf),
      ocf: ocf, fcf: fcf,
      ocfMargin: ocfMargin, fcfMargin: fcfMargin,
      ocfPerShare: ocfPerShare,
      labaProksi: labaProksi,
      labaAdalahProksi: labaAdalahProksi,
      laba: labaAdalahProksi ? null : labaProksi,
      konversiKas: cashKonversi,
      sektorKeuangan: keuangan,
      catatan: catatan,
      label: {
        ocf: fmtRupiah(ocf),
        fcf: fmtRupiah(fcf),
        ocfMargin: fmtPersen(ocfMargin, 1),
        fcfMargin: fmtPersen(fcfMargin, 1),
        konversiKas: isNum(cashKonversi) ? fmt(cashKonversi, 2) + 'x' : TANPA
      },
      peringatan: warning
    };
  }

  // Catatan: perbandingan arus kas antar periode hanya dihitung bila
  // pemanggil menyediakan `opts.ocfSebelumnya` (dari snapshot historis).
  // Bila tidak ada, modul tidak mengklaim "kas melemah" - itu mencegah
  // peringatan palsu.

  /* ---------------------------------------------------------
     3. DEBT & FINANCIAL HEALTH
     DER, Net Debt, Interest Coverage, tren utang, likuiditas.
     --------------------------------------------------------- */

  function laporanUtang(fund) {
    if (!fund) return { tersedia: false, pesan: 'Data utang tidak tersedia.' };
    var debt = ambil(fund, 'financialData', 'totalDebt');
    var cash = ambil(fund, 'financialData', 'totalCash');
    var der = ambil(fund, 'financialData', 'debtToEquity');
    var curRatio = ambil(fund, 'financialData', 'currentRatio');
    var quickRatio = ambil(fund, 'financialData', 'quickRatio');
    var ebitda = ambil(fund, 'financialData', 'ebitda');
    var revenue = ambil(fund, 'financialData', 'totalRevenue');
    // Interest coverage butuh EBIT dan beban bunga. Yahoo financialData
    // tidak menyediakan interestExpense -> coverage tidak bisa dihitung
    // tanpa mengarang. Dibiarkan null (tampil "Data tidak tersedia").
    var interestCoverage = null;
    var netDebt = (isNum(debt) && isNum(cash)) ? debt - cash : null;
    var debtToEbitda = bagi(debt, ebitda);
    var netDebtToEbitda = bagi(netDebt, ebitda);

    var label = {
      der: isNum(der) ? fmt(der, 1) + '%' : TANPA,
      netDebt: fmtRupiah(netDebt),
      debtToEbitda: isNum(debtToEbitda) ? fmt(debtToEbitda, 2) + 'x' : TANPA,
      netDebtToEbitda: isNum(netDebtToEbitda) ? fmt(netDebtToEbitda, 2) + 'x' : TANPA,
      interestCoverage: TANPA,
      currentRatio: isNum(curRatio) ? fmt(curRatio, 2) + 'x' : TANPA,
      quickRatio: isNum(quickRatio) ? fmt(quickRatio, 2) + 'x' : TANPA
    };
    var catatan = [];
    if (netDebt < 0) catatan.push('Net debt negatif - kas perusahaan melebihi utang (positif untuk kesehatan).');
    if (isNum(curRatio) && curRatio < 1) catatan.push('Current ratio di bawah 1 - risiko likuiditas jangka pendek.');
    return {
      tersedia: isNum(debt) || isNum(der) || isNum(netDebt),
      debt: debt, cash: cash, der: der,
      netDebt: netDebt, interestCoverage: interestCoverage,
      debtToEbitda: debtToEbitda, netDebtToEbitda: netDebtToEbitda,
      currentRatio: curRatio, quickRatio: quickRatio,
      label: label, catatan: catatan
    };
  }

  /* ---------------------------------------------------------
     4. EARNINGS & BUSINESS GROWTH
     Revenue YoY, Net Profit YoY, EPS growth, margin trend,
     ROE/ROA. (YoY berasal dari growth field Yahoo; QoQ dari
     earningsHistory bila tersedia.)
     --------------------------------------------------------- */

  function laporanPertumbuhan(fund, opts) {
    opts = opts || {};
    if (!fund) return { tersedia: false, pesan: 'Data pertumbuhan tidak tersedia.' };
    var revGrowth = ambil(fund, 'financialData', 'revenueGrowth');
    var earnGrowth = ambil(fund, 'financialData', 'earningsGrowth');
    var opMargin = ambil(fund, 'financialData', 'operatingMargins');
    var profitMargin = ambil(fund, 'financialData', 'profitMargins');
    var roe = ambil(fund, 'financialData', 'returnOnEquity');
    var roa = ambil(fund, 'financialData', 'returnOnAssets');
    var eps = ambil(fund, 'defaultKeyStatistics', 'trailingEps');
    var epsFwd = ambil(fund, 'defaultKeyStatistics', 'forwardEps');
    var epsGrowth = (isNum(eps) && isNum(epsFwd) && eps > 0)
      ? (epsFwd - eps) / eps : null;

    // Kuartalan dari earningsHistory (bila tersedia) untuk arah momentum.
    var kuartal = opts.kuartal || null;

    return {
      tersedia: isNum(revGrowth) || isNum(earnGrowth) || isNum(roe),
      revGrowth: revGrowth, earnGrowth: earnGrowth,
      epsGrowth: epsGrowth,
      margin: { operasi: opMargin, bersih: profitMargin },
      roe: roe, roa: roa,
      kuartal: kuartal,
      label: {
        revGrowth: fmtPersen(revGrowth, 1),
        earnGrowth: fmtPersen(earnGrowth, 1),
        epsGrowth: fmtPersen(epsGrowth, 1),
        marginOperasi: fmtPersen(opMargin, 1),
        marginBersih: fmtPersen(profitMargin, 1),
        roe: fmtPersen(roe, 1),
        roa: fmtPersen(roa, 1)
      }
    };
  }

  /* ---------------------------------------------------------
     5. CORPORATE ACTION & CATALYST
     Deteksi dari data yang benar-benar tersedia:
     - jadwal laporan keuangan (calendarEvents.earningsDate)
     - dividen (summaryDetail.dividendDate/exDividendDate/dividendYield)
     - Buyback / rights issue / stock split / akuisisi / kontrak
       besar / ekspansi / perubahan manajemen TIDAK tersedia
       di sumber data EOD gratis ini -> ditandai
       "Data tidak tersedia", tidak dikarang.
     Kontrak katalis ini selalu jujur soal batas datanya.
     --------------------------------------------------------- */

  function laporanCatalyst(fund) {
    var items = [];
    var tidakTersedia = [];
    if (!fund) return { tersedia: false, items: [], tidakTersedia: [], pesan: 'Data katalis tidak tersedia.' };

    // Earnings date (kalender).
    var ev = fund.calendarEvents || {};
    var ed = ev.earningsDate && ev.earningsDate[0] && ev.earningsDate[0].raw;
    if (isNum(ed)) {
      items.push({
        jenis: 'Laporan Kinerja',
        tanggal: new Date(ed * 1000).toISOString().slice(0, 10),
        detail: 'Jadwal rilis laporan keuangan berikutnya.',
        sumber: 'Yahoo Finance calendarEvents'
      });
    }
    // Dividend.
    var exDiv = ambil(fund, 'summaryDetail', 'exDividendDate');
    var divYield = ambil(fund, 'summaryDetail', 'dividendYield');
    if (isNum(divYield)) {
      items.push({
        jenis: 'Dividen',
        tanggal: isNum(exDiv) ? new Date(exDiv * 1000).toISOString().slice(0, 10) : null,
        detail: 'Implied dividend yield ' + fmtPersen(divYield, 2) + '.',
        sumber: 'Yahoo Finance summaryDetail'
      });
    }
    // Kinerja unexpected quarter terakhir (dari earningsHistory, bila ada).
    var eh = fund.earningsHistory && fund.earningsHistory.history;
    if (Array.isArray(eh) && eh.length) {
      var last = eh[eh.length - 1];
      var sp = v(last.surprisePercent);
      if (isNum(sp)) {
        items.push({
          jenis: 'Kinerja Kuartal',
          tanggal: v(last.quarter) ? new Date(v(last.quarter) * 1000).toISOString().slice(0, 10) : null,
          detail: 'EPS aktual vs estimasi: ' + fmtPersen(sp, 1) + ' (positif = melampaui estimasi).',
          sumber: 'Yahoo Finance earningsHistory'
        });
      }
    }
    // Yang tidak ada di sumber data gratis:
    ['Buyback', 'Rights Issue', 'Stock Split', 'Akuisisi',
     'Kontrak/Proyek Besar', 'Ekspansi', 'Perubahan Manajemen']
      .forEach(function (j) {
        tidakTersedia.push({
          jenis: j,
          alasan: 'Sumber data EOD gratis tidak menyediakan jenis katalis ini - tidak ditampilkan agar tidak mengarang.'
        });
      });

    return {
      tersedia: items.length > 0,
      items: items,
      tidakTersedia: tidakTersedia,
      pesan: items.length ? null : 'Tidak ada katalis terdeteksi pada sumber data saat ini.'
    };
  }

  /* ---------------------------------------------------------
     6. SECTOR & MACRO CONTEXT
     Dari data pasar: sektor/industri perusahaan + makro global
     (rupiah, US 10y, emas, minyak, indeks regional) + kondisi IHSG.
     --------------------------------------------------------- */

  function laporanMakro(saham, makro, ihsg) {
    var sektor = (saham && saham.profil) ? saham.profil.sector : null;
    var industri = (saham && saham.profil) ? saham.profil.industry : null;
    var m = makro || {};
    var rupiah = v(m.rupiah);
    var us10y = v(m.us10y);
    var emas = v(m.emas);
    var minyak = v(m.minyak);
    var regional = v(m.indeksRegional);

    // Arah makro sederhana dari perubahan 1 hari (%).naik/turun.
    function arah(node) {
      if (!node || !isNum(node.close) || !isNum(node.prev)) return null;
      if (!isNum(node.prev) || node.prev === 0) return null;
      var ch = (node.close - node.prev) / node.prev;
      return { persen: ch, arah: ch > 0.0005 ? 'Naik' : (ch < -0.0005 ? 'Turun' : 'Datar') };
    }
    var aRupiah = arah(m.rupiah);
    var aUs10y = arah(m.us10y);
    var aEmas = arah(m.emas);
    var aMinyak = arah(m.minyak);
    var aRegional = arah(m.indeksRegional);

    var catatan = [];
    // Rupiah melemah ->argin bagi emiten berbasis impor; kuat -> mengelUH.
    if (aRupiah && aRupiah.arah === 'Naik') catatan.push('Rupiah menguat - manfaat kecil bagi emiten impor, tekanan pada biaya bahan baku impor.');
    if (aRupiah && aRupiah.arah === 'Turun') catatan.push('Rupiah melemah - risiko biaya impor naik; emiten eksportir cenderung diuntungkan.');
    if (aUs10y && aUs10y.arah === 'Naik') catatan.push('Yield obligasi AS naik -orasidu global mengetat, risk-on bergeser.');
    if (aMinyak && aMinyak.arah === 'Naik') catatan.push('Harga minyak naik - tekanan biaya bahan bakar / energi.');

    var ihsgTren = null;
    if (ihsg && ihsg.tren) ihsgTren = ihsg.tren;

    return {
      tersedia: true,
      sektor: sektor || TANPA,
      industri: industri || TANPA,
      makro: {
        rupiah: isNum(rupiah) ? { nilai: round(rupiah, 0), perubahan: aRupiah } : null,
        us10y: isNum(us10y) ? { nilai: round(us10y, 3), perubahan: aUs10y } : null,
        emas: isNum(emas) ? { nilai: round(emas, 2), perubahan: aEmas } : null,
        minyak: isNum(minyak) ? { nilai: round(minyak, 2), perubahan: aMinyak } : null,
        indeksRegional: isNum(regional) ? { nilai: round(regional, 2), perubahan: aRegional } : null
      },
      ihsgTren: ihsgTren || TANPA,
      catatan: catatan
    };
  }

  /* ---------------------------------------------------------
     7. RISK & REWARD
     Support, resistance, upside, downside, RR, dan risiko
     lintas kategori (fundamental/valuasi/sektor/volatilitas).
     Mengipelinekan level yang sudah ada di core (tanpa diduplikasi):
     caller meneruskan `level` hasil susunLevel core bila tersedia.
     --------------------------------------------------------- */

  function dukungResistensiTerdekat(bar, harga) {
    if (!Array.isArray(bar) || bar.length < 10 || !isNum(harga)) {
      return { dukung: null, resistance: null };
    }
    var n = bar.length;
    // Support = titik terendah 20 bar terakhir; resistance = tertinggi.
    var low = Infinity, high = -Infinity;
    var mulai = Math.max(0, n - 20);
    for (var i = mulai; i < n; i++) {
      if (isNum(bar[i].low) && bar[i].low < low) low = bar[i].low;
      if (isNum(bar[i].high) && bar[i].high > high) high = bar[i].high;
    }
    return {
      dukung: isNum(low) ? round(low, 0) : null,
      resistance: isNum(high) ? round(high, 0) : null
    };
  }

  function laporanRiskReward(saham, level, volatilitas) {
    var bar = saham && saham.bar;
    var harga = (saham && SahamHarga) ? SahamHarga : null;
    var hargaNow = harga;
    if (!isNum(hargaNow) && level && isNum(level.harga)) hargaNow = level.harga;
    if (!isNum(hargaNow)) return { tersedia: false, pesan: 'Harga tidak tersedia.' };

    var dr = dukungResistensiTerdekat(bar, hargaNow);
    var support = dr.dukung;
    var resistance = dr.resistance;

    // Level dari core (batas rugi, target) bila tersedia - reuse, bukan hitung ulang.
    var sl = (level && isNum(level.batasRugi)) ? level.batasRugi : null;
    var target = (level && isNum(level.target1)) ? level.target1 : null;
    var risk = isNum(sl) ? Math.max(0, hargaNow - sl) : null;
    var upside = isNum(target) ? Math.max(0, (target - hargaNow) / hargaNow) : null;
    var downside = isNum(sl) ? Math.max(0, (hargaNow - sl) / hargaNow) : null;
    var rr = (isNum(upside) && isNum(downside) && downside > 0)
      ? upside / downside : null;

    // Risiko volatilitas dari ATR% (bila tersedia lewat level.atr).
    var volPct = (level && isNum(level.atr) && isNum(hargaNow) && hargaNow > 0)
      ? level.atr / hargaNow : null;

    return {
      tersedia: true,
      harga: round(hargaNow, 0),
      support: support,
      resistance: resistance,
      upside: upside, downside: downside, rr: rr,
      volatilitasPersen: volPct,
      volatilitasLevel: (!isNum(volPct)) ? TANPA
        : (volPct > 0.05 ? 'Tinggi' : (volPct > 0.025 ? 'Sedang' : 'Rendah')),
      label: {
        upside: isNum(upside) ? fmtPersen(upside, 1) : TANPA,
        downside: isNum(downside) ? fmtPersen(downside, 1) : TANPA,
        rr: isNum(rr) ? fmt(rr, 2) + 'x' : TANPA
      }
    };
  }

  // SahamHarga adalah helper kecil supaya harga dari sumber lain (financialData
  // currentPrice atau bar terakhir) bila core level tidak ada.
  var SahamHarga = null;
  function setHargaSaham(x) { SahamHarga = isNum(x) ? x : null; }

  /* ---------------------------------------------------------
     8. MARKET REGIME
     Bullish / Bearish / Sideways + volatilitas.
     Mengipelinekan kondisi IHSG & tren yang sudah ada (tanpa skor baru).
     --------------------------------------------------------- */

  function regimePasar(ihsg) {
    if (!ihsg || !ihsg.tersedia) {
      return { tersedia: false, regime: TANPA,
        pesan: 'Data IHSG belum cukup untuk menentukan regime pasar.' };
    }
    var tren = ihsg.tren;                 // 'Bullish' | 'Bearish' (dari core)
    var vol = isNum(ihsg.volatilitas) ? ihsg.volatilitas : null;
    var regime;
    if (tren === 'Bullish' && vol !== null && vol > 0.035) regime = 'Bullish (Volatilitas Tinggi)';
    else if (tren === 'Bullish') regime = 'Bullish';
    else if (tren === 'Bearish' && vol !== null && vol > 0.035) regime = 'Bearish (Volatilitas Tinggi)';
    else if (tren === 'Bearish') regime = 'Bearish';
    else regime = 'Sideways';

    var mode = 'Normal';
    if (regime.indexOf('Volatilitas Tinggi') >= 0) mode = 'High Volatility';
    return {
      tersedia: true, regime: regime, mode: mode,
      tren: tren || TANPA,
      volatilitasPersen: vol
    };
  }

  /* ---------------------------------------------------------
     RINGKASAN UNTUK DITAMPILKAN (FINAL ANALYSIS)
     Menggabungkan modul di atas menjadi 10 baris ringkas.
     Tidak membuat skor; hanya merangkum yang sudah dihitung.
     --------------------------------------------------------- */

  function finalAnalisis(parts) {
    parts = parts || {};
    var v = parts.valuasi, cf = parts.cashflow, ut = parts.utang,
        gr = parts.pertumbuhan, cat = parts.catalyst, mk = parts.makro,
        rr = parts.riskReward, rg = parts.regime;

    function baris(label, nilai) {
      return { label: label, nilai: (nilai === null || nilai === undefined || nilai === '') ? TANPA : nilai };
    }

    // Fundamental quality: dari valuasi+pertumbuhan+utang yang SUDAH ada.
    var fq = [];
    if (gr && isNum(gr.roe)) fq.push('ROE ' + fmtPersen(gr.roe, 1));
    if (gr && isNum(gr.roa)) fq.push('ROA ' + fmtPersen(gr.roa, 1));
    if (gr && isNum(gr.earnGrowth)) fq.push('laba ' + fmtPersen(gr.earnGrowth, 1));
    var fundamentalQuality = fq.length ? fq.join(' · ') : TANPA;

    // Valuation summary.
    var valSummary = (v && v.tersedia)
      ? 'PER ' + v.label.per + ' · PBV ' + v.label.pbv + ' · FCF Yield ' + v.label.fcfYield
      : TANPA;

    // Cash flow quality.
    var cfSummary = (cf && cf.tersedia)
      ? 'OCF ' + cf.label.ocf + ' · konversi ' + cf.label.konversiKas
      : TANPA;

    // Financial health.
    var fhSummary = (ut && ut.tersedia)
      ? 'DER ' + ut.label.der + ' · Net Debt ' + ut.label.netDebt
      : TANPA;

    // Catalyst ringkas.
    var catalyst = (cat && cat.tersedia)
      ? cat.items.map(function (i) { return i.jenis; }).join(', ')
      : ((cat && cat.items && cat.items.length === 0) ? 'Tidak ada terdeteksi' : TANPA);

    return {
      marketCondition: (rg && rg.tersedia) ? rg.regime : TANPA,
      fundamentalQuality: fundamentalQuality,
      valuation: valSummary,
      cashFlowQuality: cfSummary,
      financialHealth: fhSummary,
      catalyst: catalyst,
      sectorMacro: (mk && mk.tersedia) ? (mk.sektor + ' · IHSG ' + mk.ihsgTren) : TANPA,
      riskReward: (rr && rr.tersedia) ? ('RR ' + rr.label.rr + ' · upside ' + rr.label.upside + ' · downside ' + rr.label.downside) : TANPA,
      keyRisks: (rr && rr.tersedia ? [
        'Volatilitas ' + rr.volatilitasLevel,
        ut && ut.catatan && ut.catatan.length ? ut.catatan[0] : null
      ].filter(Boolean) : []).concat(parts.risikoTambahan || []),
      keyCatalysts: cat && cat.tersedia ? cat.items.map(function (i) {
        return i.jenis + (i.tanggal ? ' (' + i.tanggal + ')' : '');
      }) : [],
      baris: [
        baris('Market Condition', (rg && rg.tersedia) ? rg.regime : null),
        baris('Fundamental Quality', fundamentalQuality),
        baris('Valuation', valSummary),
        baris('Cash Flow Quality', cfSummary),
        baris('Financial Health', fhSummary),
        baris('Catalyst', catalyst),
        baris('Sector / Macro', (mk && mk.tersedia) ? (mk.sektor + ' · IHSG ' + mk.ihsgTren) : null),
        baris('Risk / Reward', (rr && rr.tersedia) ? ('RR ' + rr.label.rr) : null)
      ]
    };
  }

  /* ---------------------------------------------------------
     EXPORT
     --------------------------------------------------------- */

  w.NavaTraderFund = {
    TANPA: TANPA,
    metrikValuasi: metrikValuasi,
    laporanValuasi: laporanValuasi,
    laporanCashFlow: laporanCashFlow,
    laporanUtang: laporanUtang,
    laporanPertumbuhan: laporanPertumbuhan,
    laporanCatalyst: laporanCatalyst,
    laporanMakro: laporanMakro,
    laporanRiskReward: laporanRiskReward,
    setHargaSaham: setHargaSaham,
    regimePasar: regimePasar,
    finalAnalisis: finalAnalisis,
    // helper yang dipakai core/UI
    bandingkanSektor: bandingkanSektor,
    dukungResistensiTerdekat: dukungResistensiTerdekat,
    util: { v: v, ambil: ambil, round: round, isNum: isNum, fmt: fmt, fmtPersen: fmtPersen }
  };
})(typeof window !== 'undefined' ? window : this);
