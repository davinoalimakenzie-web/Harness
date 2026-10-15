/* =========================================================
   nava-trader-core.js - Mesin analisa saham BEI (Nava Trader)

   TRANSAKSI OTOMATIS: TIDAK ADA.
   Modul ini hanya MENGANALISA dan MELAPORKAN. Tidak pernah
   mengirim order ke bursa manapun. Keputusan beli/jual dan
   eksekusinya 100% dilakukan manual oleh pengguna.

   Yang dilakukan modul ini:
     1. Menghitung indikator teknikal dari data EOD (harga harian).
     2. Menyusun skor teknikal + fundamental.
     3. Menghasilkan verdict: Beli / Tunggu / Jual / Tidak Ada Setup.
     4. Menyertakan alasan, sumber data, waktu data, area masuk,
        batas rugi, target, dan catatan risiko.

   SELURUH KODE DI SINI DITULIS DARI NOL.
   Tidak ada baris kode yang disalin dari OpenBB, Qlib, atau
   vectorbt. Yang diadaptasi hanya STRUKTUR PIRSAWAHANA:
     - OpenBB  : pemisahan sumber data vs. engine analisa
     - Qlib    : workflow riset -> backtest -> paper trading
     - vectorbt: mesin backtest + biaya transaksi
   Rumus indikator (SMA/EMA/RSI/MACD/Bollinger/ATR) bersifat
   publik seperti rumus matematika, bukan kode milik siapa pun.

   Data: EOD (End of Day). BUKAN real-time, BUKAN intraday.
   Modul ini tidak pernah mengklaim data real-time.
   ========================================================= */
(function (w) {
  'use strict';

  /* ---------------------------------------------------------
     1. KONSTANTA & KONFIGURASI
     --------------------------------------------------------- */

  var SUMBER = {
    yahoo: {
      id: 'yahoo',
      nama: 'Yahoo Finance (chart API)',
      url: 'https://finance.yahoo.com',
      jenis: 'EOD / Delayed',
      catatan: 'Harga penutupan harian bursa Jakarta (IDX). ' +
               'Tidak intraday, tidak real-time. Bisa jeda 1-2 hari bursa.'
    }
  };

  var BIAYA_DEFAULT = {
    beliFeePersen: 0.15,
    jualFeePersen: 0.25,
    minFee: 50000,
    minBuyLot: 1,
    slippagePersen: 0.15,
    stampDutyPersen: 0.1
  };

  var DEFAULT_CONFIG = {
    biaya: BIAYA_DEFAULT,
    atrMultSL: 1.8,
    rrMinimal: 1.5,
    minSkorEntry: 60,
    minSkorJual: 40,
    maksPeriodeEvaluasi: 400
  };

  var cacheConfig = null;

  function clone(o) {
    if (o === null || typeof o !== 'object') return o;
    if (Array.isArray(o)) return o.map(clone);
    var r = {};
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = clone(o[k]);
    return r;
  }

  function getConfig() {
    if (!cacheConfig) cacheConfig = clone(DEFAULT_CONFIG);
    return cacheConfig;
  }

  function setConfig(patch) {
    var c = getConfig();
    if (patch && typeof patch === 'object') {
      for (var k in patch) {
        if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
        var v = patch[k];
        if (k === 'biaya' && v && typeof v === 'object') {
          for (var b in v) {
            if (!Object.prototype.hasOwnProperty.call(v, b)) continue;
            var nb = Number(v[b]);
            if (isFinite(nb) && nb >= 0) c.biaya[b] = nb;
          }
        } else {
          var nv = Number(v);
          if (isFinite(nv)) c[k] = nv;
        }
      }
    }
    return clone(c);
  }

  function resetConfig() { cacheConfig = clone(DEFAULT_CONFIG); return getConfig(); }

  /* ---------------------------------------------------------
     2. UTILITAS NUMERIK
     --------------------------------------------------------- */

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(x, fb) { var n = Number(x); return isFinite(n) ? n : (fb === undefined ? 0 : fb); }
  function round(n, d) { var f = Math.pow(10, d === undefined ? 2 : d); return Math.round(num(n) * f) / f; }
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

  function mean(a) {
    if (!a || !a.length) return 0;
    var s = 0;
    for (var i = 0; i < a.length; i++) s += num(a[i]);
    return s / a.length;
  }

  function sma(arr, n) {
    var out = new Array(arr.length);
    for (var i = 0; i < arr.length; i++) out[i] = null;
    if (n <= 0) return out;
    var sum = 0;
    for (var j = 0; j < arr.length; j++) {
      sum += num(arr[j]);
      if (j >= n) sum -= num(arr[j - n]);
      if (j >= n - 1) out[j] = sum / n;
    }
    return out;
  }

  function ema(arr, n) {
    var out = new Array(arr.length);
    for (var i = 0; i < arr.length; i++) out[i] = null;
    if (n <= 0 || !arr.length) return out;
    var k = 2 / (n + 1);
    var prev = num(arr[0]);
    out[0] = prev;
    for (var j = 1; j < arr.length; j++) {
      prev = num(arr[j]) * k + prev * (1 - k);
      out[j] = prev;
    }
    return out;
  }

  function atr(high, low, close, n) {
    var tr = new Array(close.length);
    for (var i = 0; i < close.length; i++) tr[i] = null;
    if (!close.length) return { tr: tr, atr: sma(tr, n) };
    tr[0] = num(high[0]) - num(low[0]);
    for (var j = 1; j < close.length; j++) {
      var h = num(high[j]), l = num(low[j]), pc = num(close[j - 1]);
      tr[j] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    }
    var trClean = tr.map(function (x) { return x === null ? 0 : x; });
    return { tr: tr, atr: sma(trClean, n) };
  }

  function rsi(close, n) {
    var out = new Array(close.length);
    for (var i = 0; i < close.length; i++) out[i] = null;
    if (close.length < 2) return out;
    var gain = 0, loss = 0;
    for (var j = 1; j < close.length; j++) {
      var d = num(close[j]) - num(close[j - 1]);
      var g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
      if (j <= n) {
        gain += g; loss += l;
        if (j < n) continue;
      } else {
        gain = (gain * (n - 1) + g) / n;
        loss = (loss * (n - 1) + l) / n;
      }
      if (loss === 0) out[j] = 100;
      else { var rs = gain / loss; out[j] = 100 - (100 / (1 + rs)); }
    }
    return out;
  }

  function macd(close, fast, slow, signal) {
    var ef = ema(close, fast), es = ema(close, slow);
    var line = close.map(function (_, i) {
      return (ef[i] === null || es[i] === null) ? null : ef[i] - es[i];
    });
    var valid = line.filter(function (x) { return x !== null; });
    var sigValid = ema(valid, signal);
    var sig = new Array(close.length);
    for (var i = 0; i < close.length; i++) sig[i] = null;
    var hist = line.map(function (_, i) { return null; });
    var off = close.length - valid.length;
    for (var j = 0; j < sigValid.length; j++) {
      sig[j + off] = sigValid[j];
      var v = line[j + off], s = sigValid[j];
      hist[j + off] = (v === null || s === null) ? null : v - s;
    }
    return { line: line, signal: sig, hist: hist };
  }

  function bollinger(close, n, mult) {
    var mid = sma(close, n);
    var up = new Array(close.length);
    var lo = new Array(close.length);
    var width = new Array(close.length);
    for (var i = 0; i < close.length; i++) { up[i] = null; lo[i] = null; width[i] = null; }
    for (var j = n - 1; j < close.length; j++) {
      if (mid[j] === null) continue;
      var win = close.slice(j - n + 1, j + 1);
      var sq = win.map(function (x) { return Math.pow(num(x) - mid[j], 2); });
      var sd = Math.sqrt(mean(sq));
      up[j] = mid[j] + mult * sd;
      lo[j] = mid[j] - mult * sd;
      width[j] = mid[j] ? ((up[j] - lo[j]) / mid[j]) * 100 : 0;
    }
    return { mid: mid, upper: up, lower: lo, width: width };
  }

  function stochastic(high, low, close, n) {
    var k = new Array(close.length);
    var d = new Array(close.length);
    for (var i = 0; i < close.length; i++) { k[i] = null; d[i] = null; }
    for (var j = n - 1; j < close.length; j++) {
      var hh = Math.max.apply(null, high.slice(j - n + 1, j + 1).map(num));
      var ll = Math.min.apply(null, low.slice(j - n + 1, j + 1).map(num));
      k[j] = (hh === ll) ? 50 : ((num(close[j]) - ll) / (hh - ll)) * 100;
    }
    var kv = k.filter(function (x) { return x !== null; });
    var dv = sma(kv, 3);
    var off = close.length - kv.length;
    for (var m = 0; m < dv.length; m++) d[m + off] = dv[m];
    return { k: k, d: d };
  }

  function pctChange(arr, i) {
    if (i <= 0 || i >= arr.length) return null;
    var prev = num(arr[i - 1]), cur = num(arr[i]);
    if (!prev) return null;
    return ((cur - prev) / prev) * 100;
  }

  function lastValid(arr, i) {
    for (var j = i; j >= 0; j--) if (isNum(arr[j])) return arr[j];
    return null;
  }

  /* ---------------------------------------------------------
     3. ANALISA TEKNIKAL
     --------------------------------------------------------- */

  function hitungIndikator(bar) {
    var c = bar.map(function (b) { return num(b.close); });
    var h = bar.map(function (b) { return num(b.high); });
    var l = bar.map(function (b) { return num(b.low); });
    var v = bar.map(function (b) { return num(b.volume); });
    var i = bar.length - 1;
    var a = atr(h, l, c, 14);
    var m = macd(c, 12, 26, 9);
    var bb = bollinger(c, 20, 2);
    var st = stochastic(h, l, c, 14);
    var win52 = Math.max(0, i - 251);
    return {
      close: c[i],
      prevClose: i > 0 ? c[i - 1] : null,
      chg: pctChange(c, i),
      sma20: lastValid(sma(c, 20), i),
      sma50: lastValid(sma(c, 50), i),
      sma200: lastValid(sma(c, 200), i),
      ema12: lastValid(ema(c, 12), i),
      ema26: lastValid(ema(c, 26), i),
      rsi14: lastValid(rsi(c, 14), i),
      macd: lastValid(m.line, i),
      macdSignal: lastValid(m.signal, i),
      macdHist: lastValid(m.hist, i),
      macdHistPrev: i > 0 ? lastValid(m.hist, i - 1) : null,
      bbUpper: lastValid(bb.upper, i),
      bbLower: lastValid(bb.lower, i),
      bbMid: lastValid(bb.mid, i),
      bbWidth: lastValid(bb.width, i),
      stochK: lastValid(st.k, i),
      stochD: lastValid(st.d, i),
      atr14: lastValid(a.atr, i),
      vol: v[i],
      volAvg20: lastValid(sma(v, 20), i),
      high52: h.length ? Math.max.apply(null, h.slice(win52)) : null,
      low52: l.length ? Math.min.apply(null, l.slice(win52)) : null
    };
  }

  function skorTeknikal(ind, cfg) {
    var C = cfg || getConfig();
    var parts = [];
    var total = 0, maksTotal = 0;

    function add(nama, nilai, maks, deskripsi, arah) {
      nilai = clamp(num(nilai), 0, maks);
      total += nilai; maksTotal += maks;
      parts.push({ nama: nama, nilai: round(nilai, 1), maks: maks,
                   deskripsi: deskripsi, arah: arah || 'netral' });
    }

    if (!ind || !isNum(ind.close) || ind.close <= 0) {
      return { skor: 0, parts: [], catatan: 'Data harga tidak valid.' };
    }

    if (isNum(ind.sma20)) {
      var tren = 50;
      if (isNum(ind.sma50)) tren += (ind.close > ind.sma50 ? 15 : -15);
      if (isNum(ind.sma200)) tren += (ind.close > ind.sma200 ? 20 : -20);
      if (isNum(ind.sma50)) tren += (ind.sma20 > ind.sma50 ? 15 : -15);
      var trenDesc = 'Harga ' + (ind.close > ind.sma20 ? 'di atas' : 'di bawah') + ' SMA20';
      if (isNum(ind.sma200)) trenDesc += ', SMA50, dan SMA200';
      else if (isNum(ind.sma50)) trenDesc += ' dan SMA50';
      add('Tren Harga', clamp(tren, 0, 100), 100, trenDesc + '.',
          ind.close > ind.sma20 ? 'positif' : 'negatif');
    }

    if (isNum(ind.macd) && isNum(ind.macdSignal)) {
      var mScore = ind.macd > ind.macdSignal ? 70 : 25;
      if (isNum(ind.macdHistPrev) && isNum(ind.macdHist)) {
        mScore += (ind.macdHist > ind.macdHistPrev) ? 20 : -10;
      }
      add('Momentum MACD', mScore, 100,
        ind.macd > ind.macdSignal
          ? 'MACD di atas garis sinyal, momentum naik.'
          : 'MACD di bawah garis sinyal, momentum melemah.',
        ind.macd > ind.macdSignal ? 'positif' : 'negatif');
    }

    if (isNum(ind.rsi14)) {
      var r = ind.rsi14, rScore, rDesc;
      if (r >= 75) { rScore = 40; rDesc = 'RSI ' + round(r, 1) + ' - zona jenuh beli, rawan koreksi.'; }
      else if (r >= 55) { rScore = 85; rDesc = 'RSI ' + round(r, 1) + ' - momentum bullish sehat.'; }
      else if (r >= 45) { rScore = 70; rDesc = 'RSI ' + round(r, 1) + ' - netral ke sedikit bullish.'; }
      else if (r >= 30) { rScore = 40; rDesc = 'RSI ' + round(r, 1) + ' - momentum lemah, belum pulih.'; }
      else { rScore = 20; rDesc = 'RSI ' + round(r, 1) + ' - zona jenuh jual.'; }
      add('RSI (14)', rScore, 100, rDesc, r >= 45 ? 'positif' : 'negatif');
    }

    if (isNum(ind.bbUpper) && isNum(ind.bbLower)) {
      var pos = (ind.close - ind.bbLower) / ((ind.bbUpper - ind.bbLower) || 1);
      var bScore;
      if (ind.close > ind.bbUpper) bScore = 35;
      else if (pos > 0.6) bScore = 75;
      else if (pos > 0.4) bScore = 65;
      else if (pos > 0.2) bScore = 45;
      else bScore = 30;
      add('Bollinger (20,2)', bScore, 100,
        'Posisi harga ' + round(pos * 100, 0) + '% dalam pita Bollinger' +
        (ind.close > ind.bbUpper ? ' - menembus pita atas.' : '.'),
        bScore >= 45 ? 'positif' : 'negatif');
    }

    if (isNum(ind.stochK) && isNum(ind.stochD)) {
      var sScore = ind.stochK > ind.stochD ? 70 : 30;
      if (ind.stochK < 20) sScore = 75;
      if (ind.stochK > 80) sScore = 35;
      add('Stochastic (14)', sScore, 100,
        'Stochastic K ' + round(ind.stochK, 1) + (ind.stochK > ind.stochD ? ' di atas D' : ' di bawah D') + '.',
        sScore >= 50 ? 'positif' : 'negatif');
    }

    if (isNum(ind.vol) && isNum(ind.volAvg20) && ind.volAvg20 > 0) {
      var vRatio = ind.vol / ind.volAvg20;
      var naik = isNum(ind.chg) && ind.chg > 0;
      var vScore = 60;
      if (vRatio > 1.3 && naik) vScore = 85;
      else if (vRatio > 1.3 && !naik) vScore = 35;
      else if (vRatio < 0.7) vScore = 45;
      add('Volume', vScore, 100,
        'Volume ' + round(vRatio, 2) + 'x rata-rata 20 hari' +
        (vRatio > 1.3 ? ' - aktivitas tinggi.' : '.'),
        vScore >= 50 ? 'positif' : 'negatif');
    }

    if (isNum(ind.high52) && isNum(ind.low52) && ind.high52 > ind.low52) {
      var p52 = (ind.close - ind.low52) / (ind.high52 - ind.low52);
      add('Posisi 52 Mingguan', round(p52 * 100, 0), 100,
        'Harga di ' + round(p52 * 100, 0) + '% dari rentang 52 minggu (low ' +
        round(ind.low52, 0) + ' - high ' + round(ind.high52, 0) + ').',
        p52 > 0.5 ? 'positif' : 'netral');
    }

    var skor = maksTotal ? round((total / maksTotal) * 100, 1) : 0;
    return { skor: skor, parts: parts };
  }

  /* ---------------------------------------------------------
     4. ANALISA FUNDAMENTAL
     --------------------------------------------------------- */

  function skorFundamental(f) {
    var parts = [];
    var total = 0, maksTotal = 0;
    function add(nama, nilai, maks, deskripsi) {
      nilai = clamp(num(nilai), 0, maks);
      total += nilai; maksTotal += maks;
      parts.push({ nama: nama, nilai: round(nilai, 1), maks: maks, deskripsi: deskripsi });
    }

    if (!f || typeof f !== 'object') {
      return { skor: null, parts: [], ada: false,
               catatan: 'Data fundamental tidak tersedia untuk saham ini.' };
    }

    if (isNum(f.per) && f.per > 0) {
      var per = f.per;
      add('PER', per <= 8 ? 90 : per <= 12 ? 75 : per <= 18 ? 55 : per <= 30 ? 35 : 15, 100,
        'PER ' + round(per, 2) + 'x - ' + (per <= 12 ? 'relatif murah.' : per <= 18 ? 'wajar.' : 'mahal.'));
    }
    if (isNum(f.pbv) && f.pbv > 0) {
      var pbv = f.pbv;
      add('PBV', pbv <= 1 ? 90 : pbv <= 2 ? 70 : pbv <= 4 ? 45 : 20, 100, 'PBV ' + round(pbv, 2) + 'x.');
    }
    if (isNum(f.dividendYield) && f.dividendYield > 0) {
      var dy = f.dividendYield;
      add('Dividend Yield', dy >= 8 ? 90 : dy >= 5 ? 75 : dy >= 3 ? 55 : dy >= 1 ? 40 : 25, 100,
        'Dividend yield ' + round(dy, 2) + '%.');
    }
    if (isNum(f.roe) && f.roe > 0) {
      var roe = f.roe;
      add('ROE', roe >= 20 ? 90 : roe >= 15 ? 75 : roe >= 10 ? 55 : roe >= 5 ? 35 : 20, 100,
        'ROE ' + round(roe, 2) + '% - ' + (roe >= 15 ? 'efisien.' : 'moderate.'));
    }
    if (isNum(f.earningsGrowth)) {
      var g = f.earningsGrowth;
      add('Pertumbuhan Laba', g >= 25 ? 90 : g >= 10 ? 70 : g >= 0 ? 50 : g >= -10 ? 30 : 10, 100,
        'Pertumbuhan laba (yoy) ' + round(g, 1) + '%' + (g >= 10 ? ' - positif.' : ' - lemah atau negatif.'));
    }

    if (!parts.length) {
      return { skor: null, parts: [], ada: false,
               catatan: 'Metrik fundamental tidak cukup untuk dinilai.' };
    }
    return { skor: round((total / maksTotal) * 100, 1), parts: parts, ada: true };
  }

  /* ---------------------------------------------------------
     5. VERDICT
     --------------------------------------------------------- */

  // Susun level harga: area masuk, batas rugi, target.
  // Target TIDAK dihitung dari rasio minimal (itu akan selalu pas).
  // Target diambil dari resistensi nyata (puncak swing terakhir),
  // lalu diperiksa apakah risk/reward-nya layak.
  function resistensiTerdekat(bar, harga, lookback) {
    var lb = lookback || 60;
    var start = Math.max(0, bar.length - lb);
    var puncak = 0;
    for (var i = start; i < bar.length; i++) {
      var h = num(bar[i].high);
      if (h > harga && h > puncak) puncak = h;
    }
    if (puncak > 0) return puncak;
    // Tidak ada resistance di atas harga: pakai ekstensi ATR.
    return null;
  }

  function susunLevel(ind, cfg, bar) {
    var C = cfg || getConfig();
    var close = num(ind.close);
    var atrV = (isNum(ind.atr14) && ind.atr14 > 0) ? ind.atr14 : close * 0.03;
    var sl = close - C.atrMultSL * atrV;
    if (sl < 0) sl = close * 0.9;
    var risk = close - sl;
    if (risk <= 0) risk = atrV;

    // Target utama = resistance swing terdekat (bukan angka bulat).
    var res = (bar && bar.length) ? resistensiTerdekat(bar, close, 60) : null;
    var t1, asalTarget;
    if (res && res > close) {
      t1 = res;
      asalTarget = 'resistensi swing terakhir';
    } else {
      t1 = close + atrV * 3;
      asalTarget = 'ekstensi ATR (tidak ada resistance di atas harga)';
    }
    var t2 = close + risk * C.rrMinimal * 2;

    return {
      harga: round(close, 0),
      atr: round(atrV, 0),
      areaMasuk: { atas: round(close, 0), bawah: round(close - 0.5 * atrV, 0) },
      batasRugi: round(sl, 0),
      target1: round(t1, 0),
      target2: round(t2, 0),
      target1Asal: asalTarget,
      riskPerShares: round(risk, 0),
      rasioRR: round((t1 - close) / risk, 2)
    };
  }

  // Modul bandarmology dimuat terpisah (nava-trader-bandar.js). Bila belum
  // ada, analisa tetap jalan tanpa skor bandaran.
  function modulBandar() {
    return (w && w.NavaTraderBandar) ? w.NavaTraderBandar : null;
  }

  // Modul fundamentals lanjutan dimuat terpisah (nava-trader-fund.js).
  // Bila belum ada, analisa tetap jalan dan modul baru hanya "Data tidak
  // tersedia". Modul ini TIDAK membuat skor baru - hanya melapor.
  function modulFund() {
    return (w && w.NavaTraderFund) ? w.NavaTraderFund : null;
  }

  // Konteks pasar yang dipakai modul fundamentals lanjutan:
  // ringkasan IHSG, proksi makro, dan peta metrik valuasi per sektor
  // (dihitung dari saham yang benar-benar ada, bukan angka karangan).
  var konteksPasar = { ihsg: null, makro: null, sektor: null };

  function setKonteksPasar(pasar) {
    konteksPasar.ihsg = null;
    konteksPasar.makro = (pasar && pasar.makro) ? pasar.makro : null;
    konteksPasar.sektor = null;
  }

  function sumberDari(saham) {
    if (saham && saham.sumber && SUMBER[saham.sumber]) {
      var s = SUMBER[saham.sumber];
      return { nama: s.nama, url: s.url, jenis: s.jenis, catatan: s.catatan };
    }
    return { nama: 'Tidak diketahui', url: '', jenis: 'Tidak diketahui', catatan: '' };
  }

  function waktuDari(saham, bar) {
    if (saham && saham.diperbarui) return saham.diperbarui;
    if (bar && bar.length && bar[bar.length - 1].tgl) return bar[bar.length - 1].tgl;
    return 'Tidak diketahui';
  }

  function analisaSaham(saham, cfg) {
    var C = cfg || getConfig();
    var kode = saham && saham.kode ? saham.kode : '?';
    var nama = saham && saham.nama ? saham.nama : '';
    var bar = saham && Array.isArray(saham.bar) ? saham.bar : [];

    if (bar.length < 30) {
      return {
        kode: kode, nama: nama, verdict: 'Tidak Ada Setup', emoji: '⚪',
        skor: 0, skorTeknikal: 0, skorFundamental: null,
        breakdown: [], breakdownFundamental: [],
        alasan: ['Riwayat harga belum cukup - butuh minimal 30 hari, tersedia ' + bar.length + '.'],
        level: null,
        risiko: ['Data historis tidak cukup untuk analisa.'],
        sumber: sumberDari(saham), waktuData: waktuDari(saham, bar)
      };
    }

    var ind = hitungIndikator(bar);
    var tek = skorTeknikal(ind, C);
    var fun = skorFundamental(saham.fundamental);

    // --- BANDARMOLOGY (distribusi harga-volume) ---
    var B = modulBandar();
    var band = B ? B.analisisBandar(bar, {}) : null;
    // Konversi skor bandaran (-100..100) ke skala 0..100 supaya bisa
    // digabung dengan skor teknikal.
    var skorBandar = (band && band.ada) ? round((band.skor + 100) / 2, 1) : null;

    var skorGabung = tek.skor;
    if (isNum(fun.skor)) skorGabung = round(tek.skor * 0.7 + fun.skor * 0.3, 1);
    if (isNum(skorBandar)) {
      // bobot: teknik 60%, fundamental 20%, bandaran 20%
      skorGabung = round(tek.skor * 0.6 +
        (isNum(fun.skor) ? fun.skor * 0.2 : tek.skor * 0.2) +
        skorBandar * 0.2, 1);
    }

    var level = susunLevel(ind, C, bar);
    var alasan = [];
    var top = tek.parts.slice().sort(function (a, b) {
      return (b.nilai / b.maks) - (a.nilai / a.maks);
    }).slice(0, 3);
    for (var j = 0; j < top.length; j++) {
      alasan.push(top[j].nama + ': ' + top[j].deskripsi);
    }
    if (fun.ada) {
      alasan.push('Fundamental: ' + fun.parts.map(function (p) { return p.nama; }).join(', ') + '.');
    }

    var trenNaik = isNum(ind.sma50) && ind.close > ind.sma50;
    var trenTurun = isNum(ind.sma50) && ind.close < ind.sma50;
    var macdPos = isNum(ind.macd) && isNum(ind.macdSignal) && ind.macd > ind.macdSignal;
    var macdNeg = isNum(ind.macd) && isNum(ind.macdSignal) && ind.macd < ind.macdSignal;
    var overbought = isNum(ind.rsi14) && ind.rsi14 > 75;
    var rr = level.rasioRR;

    var verdict, tambahan = [], risiko = [];

    // Bandaran: distribusi besar = tekanan jual -> veto untuk "Beli".
    var bandDistribusi = band && band.ada && band.arah === 'Distribusi';
    var bandDistribusiBesar = band && band.ada && band.status === 'Distribusi Besar';
    var bandAkumulasi = band && band.ada && band.arah === 'Akumulasi';

    if (band && band.ada) {
      if (band.arah === 'Akumulasi') {
        tambahan.push('Bandaran: ' + band.status + ' (net aliran dana ' +
                      (band.netPersen > 0 ? '+' : '') + band.netPersen + '% dari volume 60 hari).');
      } else if (band.arah === 'Distribusi') {
        tambahan.push('Bandaran: ' + band.status + ' (net aliran dana ' +
                      band.netPersen + '% dari volume 60 hari) - tekanan jual.');
      } else {
        tambahan.push('Bandaran netral (aliran dana seimbang).');
      }
    }

    if (skorGabung >= C.minSkorEntry && trenNaik && macdPos && !overbought && rr >= C.rrMinimal) {
      verdict = 'Beli';
      tambahan.push('Tren naik, momentum positif, dan risk/reward ' + rr + 'x ke target ' +
                    level.target1 + ' (berdasarkan ' + level.target1Asal + ') memenuhi ambang ' + C.rrMinimal + '.');
      if (isNum(fun.skor) && fun.skor < 40) {
        tambahan.push('Fundamental relatif lemah - pertimbangkan ukuran posisi kecil.');
        risiko.push('Fundamental lemah dibanding teknikal.');
      }
    } else if (skorGabung <= C.minSkorJual && (trenTurun || macdNeg)) {
      verdict = 'Jual';
      tambahan.push('Skor lemah dan tren atau momentum bearish - pertimbangkan keluar posisi.');
      risiko.push('Sinyal Jual berbasis teknikal. Konfirmasi fundamental & manajemen sebelum bertindak.');
    } else if (bar.length < 60) {
      verdict = 'Tidak Ada Setup';
      tambahan.push('Riwayat harga baru ' + bar.length + ' hari - pola belum terbentuk.');
    } else if (overbought) {
      verdict = 'Tunggu';
      tambahan.push('RSI zona jenuh beli (>75) - tunggu koreksi sebelum entry.');
    } else if (rr < C.rrMinimal) {
      verdict = 'Tunggu';
      tambahan.push('Risk/reward hanya ' + rr + 'x ke resistance terdekat ' + level.target1 +
                    ', di bawah ambang ' + C.rrMinimal + ' - tidak ada entry yang layak.');
    } else {
      verdict = 'Tunggu';
      tambahan.push('Belum ada konfirmasi tren dan momentum searah untuk entry.');
    }

    if (verdict === 'Beli' && !isNum(fun.skor) && tek.skor < 70) {
      verdict = 'Tunggu';
      tambahan.push('Sinyal diturunkan ke Tunggu: fundamental tidak tersedia dan teknikal belum kuat.');
    }

    // Veto bandaran: dengan "Beli" saat bandaran menunjukkan distribusi
    // besar -> turunkan ke "Tunggu" (tunggu konfirmasi, jangan buru-buru entry).
    if (verdict === 'Beli' && bandDistribusiBesar) {
      verdict = 'Tunggu';
      tambahan.push('Sinyal diturunkan ke Tunggu: bandaran menunjukkan Distribusi Besar - ada tekanan jual, tunggu konfirmasi.');
      risiko.push('Bandaran Distribusi Besar - risiko tekanan jual lanjutan.');
    }

    risiko.push('Data EOD (bukan real-time, bukan intraday) - harga bisa sudah berubah.');
    if (isNum(ind.atr14) && ind.close > 0 && (ind.atr14 / ind.close) * 100 > 6) {
      risiko.push('Volatilitas tinggi (ATR > 6% harga) - gunakan ukuran posisi kecil.');
    }
    if (trenTurun) risiko.push('Tren jangka pendek masih turun.');
    if (overbought) risiko.push('Terindikasi jenuh beli, rawan koreksi tajam.');

    var emoji = verdict === 'Beli' ? '🟢' : verdict === 'Jual' ? '🔴' :
                verdict === 'Tunggu' ? '🟡' : '⚪';

    // --- MODUL FUNDAMENTALS LANJUTAN (nava-trader-fund.js) ---
    // Menambah LAPORAN saja. Tidak mengubah skorGabung, tidak mengubah
    // verdict, tidak menduplikasi angka yang sudah tampil di atas.
    var F = modulFund();
    var lanjut = null;
    if (F) {
      var hargaNow = isNum(ind.close) ? ind.close : null;
      if (isNum(hargaNow)) F.setHargaSaham(hargaNow);
      // Cari peer sektor yang tersedia di watchlist (data nyata).
      var sektorSaya = (saham.profil && saham.profil.sector) ? saham.profil.sector : null;
      var peerSektor = null;
      if (sektorSaya && konteksPasar.sektor && konteksPasar.sektor[sektorSaya]) {
        peerSektor = konteksPasar.sektor[sektorSaya];
      }
      var val = F.laporanValuasi(saham.fundamental, { sektor: peerSektor });
      var cf = F.laporanCashFlow(saham.fundamental, {});
      var ut = F.laporanUtang(saham.fundamental);
      var gr = F.laporanPertumbuhan(saham.fundamental, {});
      var cat = F.laporanCatalyst(saham.fundamental);
      var mk = F.laporanMakro(saham, konteksPasar.makro, konteksPasar.ihsg);
      var rr = F.laporanRiskReward(saham, level, null);
      var rg = F.regimePasar(konteksPasar.ihsg);
      var fin = F.finalAnalisis({
        valuasi: val, cashflow: cf, utang: ut, pertumbuhan: gr,
        catalyst: cat, makro: mk, riskReward: rr, regime: rg,
        risikoTambahan: (val && val.bandingkanSektor && val.bandingkanSektor.relative &&
          val.bandingkanSektor.relative.per === 'Jauh lebih mahal dari rata-rata sektor')
          ? ['Valuasi PER jauh lebih mahal dari rata-rata sektor.'] : []
      });
      lanjut = {
        valuasi: val, cashflow: cf, utang: ut, pertumbuhan: gr,
        catalyst: cat, makro: mk, riskReward: rr, regime: rg,
        finalAnalisis: fin
      };
    }

    return {
      kode: kode, nama: nama, verdict: verdict, emoji: emoji,
      skor: skorGabung, skorTeknikal: tek.skor, skorFundamental: fun.skor,
      breakdown: tek.parts, breakdownFundamental: fun.parts,
      skorBandar: isNum(skorBandar) ? skorBandar : null,
      bandaran: band,
      lanjutan: lanjut,
      alasan: alasan.concat(tambahan),
      level: level, risiko: risiko,
      sumber: sumberDari(saham), waktuData: waktuDari(saham, bar)
    };
  }

  function analisaIHSG(dataIHSG) {
    if (!dataIHSG || !Array.isArray(dataIHSG.bar) || dataIHSG.bar.length < 30) {
      return { tersedia: false, pesan: 'Data IHSG belum tersedia (butuh minimal 30 hari).' };
    }
    var ind = hitungIndikator(dataIHSG.bar);
    var tek = skorTeknikal(ind, getConfig());
    var tren = (isNum(ind.sma50) && ind.close > ind.sma50) ? 'Bullish' : 'Bearish';
    // Bandaran IHSG: hitung dari bar IHSG sebagai proxy arah dana pasar.
    var B0 = modulBandar();
    var bandIHSG = B0 ? B0.analisisBandar(dataIHSG.bar, {}) : null;
    return {
      tersedia: true,
      bandaranIHSG: bandIHSG && bandIHSG.ada ? {
        status: bandIHSG.status, arah: bandIHSG.arah, netPersen: bandIHSG.netPersen
      } : null,
      harga: ind.close,
      chg: isNum(ind.chg) ? round(ind.chg, 2) : null,
      tren: tren, emoji: tren === 'Bullish' ? '🟢' : '🔴',
      volatilitas: (isNum(ind.atr14) && isNum(ind.close) && ind.close > 0)
        ? round(ind.atr14 / ind.close, 4) : null,
      skor: tek.skor,
      rsi14: isNum(ind.rsi14) ? round(ind.rsi14, 1) : null,
      sma20: isNum(ind.sma20) ? round(ind.sma20, 0) : null,
      sma50: isNum(ind.sma50) ? round(ind.sma50, 0) : null,
      waktuData: waktuDari(dataIHSG, dataIHSG.bar),
      sumber: sumberDari(dataIHSG),
      ringkasan: 'IHSG ' + tren.toLowerCase() + ', skor teknikal ' + tek.skor + '.'
    };
  }

  /* ---------------------------------------------------------
     6. BACKTEST
     --------------------------------------------------------- */

  function backtest(bar, cfg, params) {
    var C = cfg || getConfig();
    var P = params || {};
    var ambangMasuk = P.ambangMasuk || C.minSkorEntry;
    var ambangKeluar = P.ambangKeluar || C.minSkorJual;
    var stopPct = P.stopPct || 5;
    var takePct = P.takePct || 10;
    var B = C.biaya;
    var modal = num(P.modal, 10000000);

    if (!bar || bar.length < 60) {
      return { ok: false, pesan: 'Butuh minimal 60 bar untuk backtest.' };
    }

    var hasil = [];
    var posisi = null;
    var equity = modal;
    var win = 0, loss = 0, biayaTotal = 0;

    function biayaTrade(nilai, tipe) {
      var p = tipe === 'beli' ? B.beliFeePersen : B.jualFeePersen;
      return Math.max(B.minFee, (nilai * p / 100) + (nilai * B.stampDutyPersen / 100));
    }

    for (var i = 30; i < bar.length; i++) {
      var price = num(bar[i].close);
      var slice = bar.slice(0, i + 1);
      var ind = hitungIndikator(slice);
      var tek = skorTeknikal(ind, C).skor;
      var trenNaik = isNum(ind.sma50) && price > ind.sma50;
      var tgl = bar[i].tgl;

      if (posisi) {
        var ubah = ((price - posisi.hargaMasuk) / posisi.hargaMasuk) * 100;
        var keluar = null;
        if (ubah <= -stopPct) keluar = 'Stop Loss';
        else if (ubah >= takePct) keluar = 'Take Profit';
        else if (tek <= ambangKeluar && !trenNaik) keluar = 'Sinyal Jual';

        if (keluar) {
          var nilaiJual = posisi.lots * 100 * price;
          var fee = biayaTrade(nilaiJual, 'jual');
          equity += nilaiJual - fee;
          biayaTotal += fee;
          hasil.push({
            tglMasuk: posisi.tglMasuk, tglKeluar: tgl,
            hargaMasuk: posisi.hargaMasuk, hargaKeluar: price,
            hasilPct: round(ubah, 2),
            hasilRupiah: round(nilaiJual - fee - posisi.modalAwal, 0),
            alasanKeluar: keluar, fee: round(fee, 0)
          });
          if (keluar === 'Stop Loss') loss++; else win++;
          posisi = null;
        }
      }

      if (!posisi && tek >= ambangMasuk && trenNaik) {
        var lots = Math.floor(modal / (price * 100 * (1 + B.beliFeePersen / 100)));
        if (lots >= B.minBuyLot) {
          var modalAwal = lots * 100 * price;
          var feeBeli = biayaTrade(modalAwal, 'beli');
          equity -= feeBeli;
          biayaTotal += feeBeli;
          posisi = { tglMasuk: tgl, hargaMasuk: price, lots: lots, modalAwal: modalAwal };
        }
      }
    }

    if (posisi) {
      var pl = num(bar[bar.length - 1].close);
      var nilaiAkhir = posisi.lots * 100 * pl;
      var feeAkhir = biayaTrade(nilaiAkhir, 'jual');
      equity += nilaiAkhir - feeAkhir;
      biayaTotal += feeAkhir;
      var uah = ((pl - posisi.hargaMasuk) / posisi.hargaMasuk) * 100;
      hasil.push({
        tglMasuk: posisi.tglMasuk, tglKeluar: bar[bar.length - 1].tgl,
        hargaMasuk: posisi.hargaMasuk, hargaKeluar: pl,
        hasilPct: round(uah, 2),
        hasilRupiah: round(nilaiAkhir - feeAkhir - posisi.modalAwal, 0),
        alasanKeluar: 'Ditutup (akhir data)', fee: round(feeAkhir, 0)
      });
      if (uah > 0) win++; else loss++;
    }

    var winRate = (win + loss) ? (win / (win + loss)) * 100 : 0;
    var rataHasil = hasil.length ? mean(hasil.map(function (h) { return h.hasilPct; })) : 0;

    return {
      ok: true,
      modalAwal: modal,
      equityAkhir: round(equity, 0),
      returnPersen: round(((equity - modal) / modal) * 100, 2),
      jumlahTrade: hasil.length,
      win: win, loss: loss,
      winRate: round(winRate, 1),
      rataHasilPerTrade: round(rataHasil, 2),
      totalBiaya: round(biayaTotal, 0),
      trades: hasil,
      catatan: 'Backtest long-only. Fee beli/jual, minimum fee, dan stamp duty sudah dihitung. ' +
               'Tidak memprediksi pasar. Hasil masa lalu tidak menjamin hasil mendatang.'
    };
  }

  /* ---------------------------------------------------------
     7. PAPER TRADING
     --------------------------------------------------------- */

  var PAPER_KEY = 'nava.trader.paper.v1';
  var cachePaper = null;

  function paperDefault() { return { modal: 10000000, modalAwal: 10000000, posisi: [], riwayat: [], totalBiaya: 0 }; }

  /**
   * Harga masuk sebuah posisi paper.
   * Data lama bisa punya `harga` (dipakai paperOrder) atau `hargaMasuk`.
   * Dua-duanya dibaca supaya posisi dari versi sebelumnya tidak rusak.
   */
  function hargaMasukPosisi(pos) {
    if (!pos) return 0;
    if (isNum(pos.hargaMasuk) && pos.hargaMasuk > 0) return pos.hargaMasuk;
    if (isNum(pos.harga) && pos.harga > 0) return pos.harga;
    return 0;
  }

  function paperLoad() {
    if (cachePaper) return cachePaper;
    try {
      var raw = w.localStorage ? w.localStorage.getItem(PAPER_KEY) : null;
      cachePaper = raw ? JSON.parse(raw) : paperDefault();
    } catch (e) { cachePaper = paperDefault(); }
    if (!Array.isArray(cachePaper.posisi)) cachePaper.posisi = [];
    if (!Array.isArray(cachePaper.riwayat)) cachePaper.riwayat = [];
    if (!isNum(cachePaper.totalBiaya)) cachePaper.totalBiaya = 0;
    // Data versi lama belum punya modalAwal & belum konsisten soal harga masuk.
    // Migrasi sekali di sini supaya seluruh hitungan memakai sumber yang sama.
    var perluSimpan = false;
    if (!isNum(cachePaper.modalAwal) || cachePaper.modalAwal <= 0) {
      cachePaper.modalAwal = num(cachePaper.modal) || 0;
      perluSimpan = true;
    }
    for (var mi = 0; mi < cachePaper.posisi.length; mi++) {
      var mp = cachePaper.posisi[mi];
      if (isNum(mp.hargaMasuk) && !isNum(mp.harga)) { mp.harga = mp.hargaMasuk; perluSimpan = true; }
      if (!isNum(mp.hargaMasuk) && isNum(mp.harga)) { mp.hargaMasuk = mp.harga; perluSimpan = true; }
      if (!isNum(mp.hargaSekarang)) { mp.hargaSekarang = hargaMasukPosisi(mp); perluSimpan = true; }
    }
    if (perluSimpan) paperSave();
    return cachePaper;
  }

  function paperSave() {
    if (w.localStorage) {
      try { w.localStorage.setItem(PAPER_KEY, JSON.stringify(cachePaper)); } catch (e) {}
    }
  }

  function paperReset() {
    cachePaper = paperDefault();
    paperSave();
    return clone(cachePaper);
  }

  function paperSetModal(v) {
    var p = paperLoad();
    p.modal = Math.max(0, Math.round(num(v)));
    // Baseline return = total ekuitas saat modal disetel. Jadi menambah/
    // mengurangi tunai tidak terlihat sebagai keuntungan/kerugian.
    p.modalAwal = p.modal + nilaiPosisiSekarang(p);
    paperSave();
    return clone(p);
  }

  /** Nilai posisi berjalan memakai harga terakhir yang diketahui. */
  function nilaiPosisiSekarang(p) {
    var total = 0;
    var arr = (p && p.posisi) || [];
    for (var i = 0; i < arr.length; i++) {
      var pos = arr[i];
      var harga = isNum(pos.hargaSekarang) ? pos.hargaSekarang : hargaMasukPosisi(pos);
      total += num(pos.lots) * 100 * harga;
    }
    return round(total, 0);
  }

  function paperSummary() {
    var p = paperLoad();
    var nilaiPosisi = nilaiPosisiSekarang(p);
    var totalNilai = p.modal + nilaiPosisi;
    // Return diukur terhadap modal awal, BUKAN saldo tunai saat ini.
    // Kalau pakai saldo tunai, setiap kali membeli tampak langsung untung.
    var basis = isNum(p.modalAwal) && p.modalAwal > 0 ? p.modalAwal : 0;
    return {
      modal: p.modal,
      modalAwal: basis,
      jumlahPosisi: p.posisi.length,
      nilaiPosisi: nilaiPosisi,
      totalNilai: round(totalNilai, 0),
      returnPersen: basis ? round(((totalNilai - basis) / basis) * 100, 2) : 0,
      totalBiaya: round(num(p.totalBiaya), 0)
    };
  }

  // Order PAPER (simulasi). TIDAK pernah menyentuh bursa sungguhan.
  function paperOrder(saham, jenis, harga, lots, catatan) {
    var p = paperLoad();
    var C = getConfig();
    var h = num(harga);
    var l = Math.floor(num(lots));
    var kode = saham && saham.kode ? saham.kode : '';
    var nama = saham && saham.nama ? saham.nama : '';

    if (h <= 0 || l < C.biaya.minBuyLot) {
      return { ok: false, pesan: 'Harga/lots tidak valid (minimal ' + C.biaya.minBuyLot + ' lot).' };
    }

    var nilai = l * 100 * h;
    var feePersen = (jenis === 'beli') ? C.biaya.beliFeePersen : C.biaya.jualFeePersen;
    // Pajak transaksi (stamp duty) di bursa Indonesia hanya dikenakan saat
    // PENJUALAN. Kalau ikut ditambah saat beli, biaya simulasi jadi berlebihan.
    var fee = Math.max(C.biaya.minFee, nilai * feePersen / 100 +
      (jenis === 'beli' ? 0 : nilai * C.biaya.stampDutyPersen / 100));

    if (jenis === 'beli') {
      var butuh = nilai + fee;
      // Cegah simulasi memakai uang yang tidak ada (beli melebihi modal tunai).
      if (butuh > p.modal) {
        return { ok: false, pesan: 'Modal tunai tidak cukup. Butuh Rp' +
          Math.round(butuh).toLocaleString('id-ID') + ', tersedia Rp' +
          Math.round(p.modal).toLocaleString('id-ID') + '.' };
      }
      var entry = {
        id: 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        kode: kode, nama: nama, jenis: 'beli', harga: h, hargaMasuk: h, lots: l,
        nilai: round(nilai, 0), fee: round(fee, 0),
        modalAwal: round(nilai + fee, 0), hargaSekarang: h,
        tgl: new Date().toISOString().slice(0, 10),
        catatan: catatan || '', paper: true
      };
      p.posisi.push(entry);
      p.totalBiaya = num(p.totalBiaya) + fee;
      p.modal = Math.max(0, p.modal - entry.modalAwal);
      paperSave();
      return { ok: true, order: clone(entry), summary: paperSummary() };
    }

    if (jenis === 'jual') {
      var idxs = [];
      for (var i = 0; i < p.posisi.length; i++) {
        if (p.posisi[i].kode === kode) idxs.push(i);
      }
      if (!idxs.length) return { ok: false, pesan: 'Tidak ada posisi ' + kode + ' untuk dijual.' };

      // Total lot yang benar-benar dimiliki untuk kode ini.
      var lotDimiliki = 0;
      for (var a = 0; a < idxs.length; a++) lotDimiliki += num(p.posisi[idxs[a]].lots);

      // Cegah OVERSELL. Tanpa ini, simulasi bisa menjual 999 lot padahal hanya
      // pegang 10 lot sehingga modal tunai berubah jadi angka karangan.
      if (l > lotDimiliki) {
        return { ok: false, pesan: 'Lot melebihi posisi. Dimiliki ' +
          lotDimiliki + ' lot, diminta ' + l + ' lot.' };
      }

      // Jual sebagian (FIFO: posisi terlama lebih dulu). Menjual 4 dari 10 lot
      // harus menyisakan 6 lot, BUKAN menghapus seluruh posisi.
      var feePerLot = fee / l;
      var sisa = l;
      var proceeds = 0;
      var pnlTotal = 0;
      var digeser = 0;
      var tglJual = new Date().toISOString().slice(0, 10);

      for (var k = 0; k < idxs.length && sisa > 0; k++) {
        var pos = p.posisi[idxs[k] - digeser];
        var lotPos = num(pos.lots);
        var take = Math.min(sisa, lotPos);
        var nilaiTake = take * 100 * h;
        var feeTake = round(feePerLot * take, 0);
        var modalPos = num(pos.modalAwal);
        var porsi = lotPos > 0 ? take / lotPos : 1;
        var pnlTake = nilaiTake - feeTake - round(modalPos * porsi, 0);

        p.riwayat.push({
          kode: kode, nama: nama, tgl: tglJual,
          pnl: round(pnlTake, 0), hargaBeli: hargaMasukPosisi(pos), hargaJual: h,
          lots: take, fee: feeTake
        });
        pnlTotal += pnlTake;
        proceeds += nilaiTake - feeTake;

        if (take >= lotPos) {
          p.posisi.splice(idxs[k] - digeser, 1);
          digeser++;
        } else {
          pos.lots = lotPos - take;
          pos.modalAwal = round(modalPos * (1 - porsi), 0);
          pos.nilai = round(pos.lots * 100 * hargaMasukPosisi(pos), 0);
        }
        sisa -= take;
      }

      p.totalBiaya = num(p.totalBiaya) + fee;
      p.modal += proceeds;
      paperSave();
      return {
        ok: true,
        order: {
          kode: kode, nama: nama, jenis: 'jual', harga: h, lots: l,
          nilai: round(nilai, 0), fee: round(fee, 0), pnl: round(pnlTotal, 0), tgl: tglJual
        },
        summary: paperSummary()
      };
    }

    return { ok: false, pesan: 'Jenis order tidak dikenal.' };
  }

  // Perbarui harga posisi (hanya penandaan, bukan transaksi).
  function paperMark(hargaTerbaru) {
    var p = paperLoad();
    for (var i = 0; i < p.posisi.length; i++) {
      var k = p.posisi[i].kode;
      if (hargaTerbaru && isNum(hargaTerbaru[k])) {
        p.posisi[i].hargaSekarang = hargaTerbaru[k];
      }
    }
    paperSave();
    return paperSummary();
  }

  /* ---------------------------------------------------------
     8. STRATEGI - WAJIB PERSETUJUAN PENGGUNA
     --------------------------------------------------------- */

  var STRATEGI_KEY = 'nava.trader.strategi.v1';
  var cacheStrategi = null;
  var FIELD_STRATEGI = ['minSkorEntry', 'minSkorJual', 'atrMultSL', 'rrMinimal'];

  function defaultStrategi() {
    var C = getConfig();
    var hari = new Date().toISOString().slice(0, 10);
    return {
      versi: 1, status: 'Aktif', nama: 'Momentum-Breakout v1',
      minSkorEntry: C.minSkorEntry, minSkorJual: C.minSkorJual,
      atrMultSL: C.atrMultSL, rrMinimal: C.rrMinimal,
      dibuat: hari, disetujuiPada: hari,
      catatan: 'Strategi bawaan. Parameter hanya bisa diubah lewat usulan, dan baru aktif setelah disetujui pengguna.'
    };
  }

  function strategiLoad() {
    if (cacheStrategi) return cacheStrategi;
    try {
      var raw = w.localStorage ? w.localStorage.getItem(STRATEGI_KEY) : null;
      cacheStrategi = raw ? JSON.parse(raw) : defaultStrategi();
    } catch (e) { cacheStrategi = defaultStrategi(); }
    if (!cacheStrategi || typeof cacheStrategi !== 'object') cacheStrategi = defaultStrategi();
    return cacheStrategi;
  }

  function strategiSave() {
    if (w.localStorage) {
      try { w.localStorage.setItem(STRATEGI_KEY, JSON.stringify(cacheStrategi)); } catch (e) {}
    }
  }

  // Usulan perubahan -> "Menunggu Persetujuan". TIDAK langsung aktif.
  function strategiUsulkan(patch) {
    var s = clone(strategiLoad());
    if (patch && typeof patch === 'object') {
      for (var k = 0; k < FIELD_STRATEGI.length; k++) {
        var f = FIELD_STRATEGI[k];
        if (Object.prototype.hasOwnProperty.call(patch, f)) {
          var n = Number(patch[f]);
          if (isFinite(n)) s[f] = n;
        }
      }
    }
    s.status = 'Menunggu Persetujuan';
    s.diusulkan = new Date().toISOString().slice(0, 10);
    cacheStrategi = s;
    strategiSave();
    return clone(s);
  }

  // Persetujuan pengguna -> baru Aktif dan diterapkan ke config.
  function strategiSetujui() {
    var s = clone(strategiLoad());
    if (s.status !== 'Menunggu Persetujuan') {
      return { ok: false, pesan: 'Tidak ada usulan yang menunggu persetujuan.' };
    }
    s.status = 'Aktif';
    s.versi += 1;
    s.disetujuiPada = new Date().toISOString().slice(0, 10);
    delete s.diusulkan;
    cacheStrategi = s;
    strategiSave();
    setConfig({ minSkorEntry: s.minSkorEntry, minSkorJual: s.minSkorJual,
                atrMultSL: s.atrMultSL, rrMinimal: s.rrMinimal });
    return { ok: true, strategi: clone(s) };
  }

  function strategiTolak() {
    var s = clone(strategiLoad());
    s.status = 'Aktif';
    delete s.diusulkan;
    cacheStrategi = s;
    strategiSave();
    return clone(s);
  }

  /* ---------------------------------------------------------
     9. DATA PASAR
     --------------------------------------------------------- */

  function muatPasar(json) {
    if (!json || typeof json !== 'object') return { ihsg: null, saham: [], meta: null, watchlist: [] };
    return {
      ihsg: json.ihsg || null,
      saham: Array.isArray(json.saham) ? json.saham : [],
      meta: json.meta || null,
      makro: json.makro || null,
      watchlist: Array.isArray(json.watchlist) ? json.watchlist.map(String) : []
    };
  }

  function watchlistKode(pasar) {
    if (!pasar) return [];
    if (pasar.watchlist && pasar.watchlist.length) return pasar.watchlist;
    return (pasar.saham || []).map(function (s) { return s.kode; });
  }

  function analisaSemua(pasar) {
    var C = getConfig();
    var iHSG = analisaIHSG(pasar.ihsg);
    var wl = (pasar.watchlist || []).map(String);

    // Siapkan konteks untuk modul fundamentals lanjutan:
    // ringkasan IHSG, proksi makro, dan peta metrik valuasi per sektor
    // (dihitung dari saham yang benar-benar ada di watchlist).
    setKonteksPasar(pasar);
    konteksPasar.ihsg = iHSG;
    var F = modulFund();
    if (F) {
      var petaSektor = {};
      (pasar.saham || []).forEach(function (s) {
        var sek = (s.profil && s.profil.sector) ? s.profil.sector : null;
        if (!sek || !s.fundamental) return;
        var m = F.metrikValuasi(s.fundamental);
        if (!m) return;
        if (!petaSektor[sek]) petaSektor[sek] = [];
        petaSektor[sek].push(m);
      });
      konteksPasar.sektor = petaSektor;
    }

    var hasil = [];
    (pasar.saham || []).forEach(function (s) {
      var a = analisaSaham(s, C);
      a.watchlist = wl.indexOf(String(s.kode)) >= 0;
      hasil.push(a);
    });
    var rank = { 'Beli': 0, 'Tunggu': 1, 'Jual': 2, 'Tidak Ada Setup': 3 };
    hasil.sort(function (a, b) {
      if (rank[a.verdict] !== rank[b.verdict]) return rank[a.verdict] - rank[b.verdict];
      return b.skor - a.skor;
    });
    var out = { ihsg: iHSG, hasil: hasil, meta: pasar.meta || null };
    if (F) {
      out.regime = F.regimePasar(iHSG);
      out.makro = laporanMakroRingkas(konteksPasar.makro);
    }
    return out;
  }

  // Ringkasan proksi makro (dipakai FINAL ANALYSIS di level pasar).
  function laporanMakroRingkas(makro) {
    var F = modulFund();
    if (!F) return null;
    return F.laporanMakro(null, makro, null);
  }

  // Ambil verdict per kategori.
  function ringkasVerdict(hasil) {
    var r = { 'Beli': 0, 'Tunggu': 0, 'Jual': 0, 'Tidak Ada Setup': 0 };
    (hasil || []).forEach(function (a) { r[a.verdict] = (r[a.verdict] || 0) + 1; });
    return r;
  }

  /* ---------------------------------------------------------
     10. EXPORT
     --------------------------------------------------------- */

  w.NavaTraderCore = {
    SUMBER: SUMBER,
    BIAYA_DEFAULT: BIAYA_DEFAULT,
    getConfig: getConfig, setConfig: setConfig, resetConfig: resetConfig,
    sma: sma, ema: ema, rsi: rsi, macd: macd, bollinger: bollinger,
    atr: atr, stochastic: stochastic, hitungIndikator: hitungIndikator,
    pctChange: pctChange, mean: mean,
    skorTeknikal: skorTeknikal, skorFundamental: skorFundamental, susunLevel: susunLevel,
    resistensiTerdekat: resistensiTerdekat, modulBandar: modulBandar,
    analisaSaham: analisaSaham, analisaIHSG: analisaIHSG,
    analisaSemua: analisaSemua, ringkasVerdict: ringkasVerdict,
    muatPasar: muatPasar, watchlistKode: watchlistKode,
    backtest: backtest,
    paperLoad: paperLoad, paperReset: paperReset, paperSetModal: paperSetModal,
    paperSummary: paperSummary, paperOrder: paperOrder, paperMark: paperMark,
    strategiLoad: strategiLoad, strategiUsulkan: strategiUsulkan,
    strategiSetujui: strategiSetujui, strategiTolak: strategiTolak,
    util: { clamp: clamp, round: round, num: num, isNum: isNum, clone: clone }
  };

})(typeof window !== 'undefined' ? window : this);
