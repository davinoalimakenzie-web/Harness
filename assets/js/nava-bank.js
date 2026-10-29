/* =========================================================
   nava-bank.js — Dana Bank milik Project Nava

   Dipindah dari modul Mas Cim ke sini, karena Dana Bank adalah
   alat keuangan Projects Nava, bukan alat servis HP. Sekarang
   kartu "Dana Bank" berdiri di Beranda, sebelah kartu
   "Tunai"/"Rekening Saya".

   Sumber kebenaran: localStorage (kunci "nava.bank.v1") supaya
   tetap berfungsi penuh saat offline. Tidak ada jaringan.

   Aturan baru:
     Setiap bulan, 10% dari total PEMASUKAN bulan itu wajib
     disetor ke Dana Bank, dengan keterangan "Setoran Kas Wajib".
     Bulan dihitung per kalender (WIB), dan setoran wajib hanya
     boleh tercatat SATU KALI per bulan (idempoten) supaya tidak
     dobel saat koneksi putus atau tombol ditekan berkali-kali.

   Semua nominal uang bulat, tidak ada pecahan.
   ========================================================= */
(function (w) {
  'use strict';

  var KEY = 'nava.bank.v1';

  // 10% dari pemasukan bulanan wajib masuk Dana Bank.
  var RASIO_WAJIB = 0.10;
  var KETERANGAN_WAJIB = 'Setoran Kas Wajib';

  var cache = null;

  function blank() {
    return {
      initial: 0,      // saldo awal / total setoran masuk
      entries: [],     // riwayat: { id, description, moneyIn, moneyOut, date, note, kind }
      wajibBulanan: {}, // { '2025-03': { amount, at, id } } -> penanda sudah disetor
      pelunasanBulanan: {} // { '2025-03': { amount, at, id } } -> penanda settlement monthly ke Project Nava
    };
  }

  function load() {
    if (cache) return cache;
    try {
      var raw = w.localStorage.getItem(KEY);
      cache = raw ? norm(JSON.parse(raw)) : blank();
      if (raw) {
        // Simpan versi hasil normalisasi/migrasi agar split 5% + 5% permanen
        try { w.localStorage.setItem(KEY, JSON.stringify(cache)); } catch (e2) {}
      }
    } catch (e) { cache = blank(); }
    return cache;
  }

  function isReturnDesc(desc) {
    var d = String(desc || '').toLowerCase();
    return d.indexOf('kembalikan') !== -1 ||
      d.indexOf('batal') !== -1 ||
      d.indexOf('lunasi') !== -1 ||
      d.indexOf('pelunasan') !== -1 ||
      d.indexOf('pengembalian') !== -1 ||
      d.indexOf('reversal') !== -1 ||
      d.indexOf('pembatalan') !== -1;
  }

  function norm(s) {
    var d = blank();
    if (!s || typeof s !== 'object') return d;
    if (typeof s.initial === 'number' && isFinite(s.initial) && s.initial > 0) d.initial = Math.round(s.initial);
    if (Array.isArray(s.entries)) {
      var newEntries = [];
      s.entries.forEach(function (e) {
        if (!e || typeof e !== 'object') return;
        var kind = e.kind === 'wajib' ? 'wajib' : (e.kind || 'manual');
        var desc = String(e.description || '').slice(0, 120);
        var descUpper = desc.toUpperCase();
        var mi = Math.max(0, Math.round(Number(e.moneyIn) || 0));
        var mo = Math.max(0, Math.round(Number(e.moneyOut) || 0));
        var dt = String(e.date || '').slice(0, 10);
        var nt = String(e.note || '').slice(0, 200);

        // Jika ada entri setoran wajib 10% lama yang belum terbagi 5% darurat & 5% sdh:
        if (kind === 'wajib' && mi > 0 && descUpper.indexOf('5%') === -1 && descUpper.indexOf('SDH') === -1) {
          var half1 = Math.round(mi / 2);
          var half2 = mi - half1;
          var ymMatch = desc.match(/\d{4}-\d{2}/);
          var ymSuffix = ymMatch ? ' ' + ymMatch[0] : '';
          newEntries.push({
            id: (e.id || uid()) + '_darurat',
            description: KETERANGAN_WAJIB + ' 5% (Kas Darurat)' + ymSuffix,
            moneyIn: half1,
            moneyOut: 0,
            date: dt,
            note: nt,
            kind: 'wajib',
            fund: 'darurat'
          });
          newEntries.push({
            id: (e.id || uid()) + '_sdh',
            description: KETERANGAN_WAJIB + ' 5% (Kas SDH)' + ymSuffix,
            moneyIn: half2,
            moneyOut: 0,
            date: dt,
            note: nt,
            kind: 'wajib',
            fund: 'sdh'
          });
          return;
        }

        // Setoran umum / manual: MASUK KE KAS SDH (Kas Darurat HANYA menerima dari pengembalian sparepart & 50% kas wajib 10%)
        if (kind !== 'wajib' && kind !== 'sparepart' && kind !== 'bon' && mi > 0 && !isReturnDesc(desc)) {
          newEntries.push({
            id: e.id || uid(),
            description: desc,
            moneyIn: mi,
            moneyOut: 0,
            date: dt,
            note: nt,
            kind: kind,
            fund: 'sdh'
          });
          return;
        }

        var isReturn = (kind === 'sparepart' || kind === 'bon' || isReturnDesc(desc));
        var isSDH = !isReturn && (e.fund === 'sdh' || descUpper.indexOf('(KAS SDH)') !== -1 || descUpper.indexOf('SDH') !== -1);
        newEntries.push({
          id: e.id || uid(),
          description: desc,
          moneyIn: mi,
          moneyOut: mo,
          date: dt,
          note: nt,
          kind: kind,
          fund: isSDH ? 'sdh' : 'darurat'
        });
      });

      // Rebalance unequal 5% + 5% setoran wajib per bulan (mis. 225.000 & 224.000 -> 224.500 & 224.500)
      var wajibByYM = {};
      newEntries.forEach(function (e) {
        if (e.kind !== 'wajib' || !e.moneyIn) return;
        var ymMatch = (e.description || '').match(/\d{4}-\d{2}/) || (e.date || '').slice(0, 7).match(/\d{4}-\d{2}/);
        var ym = ymMatch ? ymMatch[0] : '';
        if (!ym) return;
        wajibByYM[ym] = wajibByYM[ym] || { darurat: null, sdh: null };
        if (e.fund === 'sdh') wajibByYM[ym].sdh = e;
        else wajibByYM[ym].darurat = e;
      });
      Object.keys(wajibByYM).forEach(function (ym) {
        var pair = wajibByYM[ym];
        if (pair.darurat && pair.sdh) {
          var sum = (pair.darurat.moneyIn || 0) + (pair.sdh.moneyIn || 0);
          if (sum > 0 && pair.darurat.moneyIn !== pair.sdh.moneyIn) {
            var h = Math.round(sum / 2);
            pair.darurat.moneyIn = h;
            pair.sdh.moneyIn = sum - h;
          }
        }
      });
      d.entries = newEntries;
    }
    if (s.wajibBulanan && typeof s.wajibBulanan === 'object') {
      Object.keys(s.wajibBulanan).forEach(function (k) {
        if (!/^\d{4}-\d{2}$/.test(k)) return;
        var v = s.wajibBulanan[k];
        if (!v) return;
        d.wajibBulanan[k] = { amount: Math.max(0, Math.round(Number(v.amount) || 0)), at: String(v.at || '') };
      });
    }
    return d;
  }

  function save() {
    try { w.localStorage.setItem(KEY, JSON.stringify(cache)); } catch (e) {}
  }

  function uid() {
    var r = '';
    try {
      if (w.crypto && w.crypto.getRandomValues) {
        var a = new Uint32Array(4); w.crypto.getRandomValues(a);
        for (var i = 0; i < a.length; i++) r += a[i].toString(36);
        return r.slice(0, 20);
      }
    } catch (e) {}
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* ---------------- perhitungan ---------------- */

  // Saldo awal (diatur manual lewat "Atur Saldo Awal").
  function initialValue(d) {
    d = d || load();
    return d.initial;
  }
  // Total dana SETOR: setoran awal, setoran kas wajib, dan pengembalian
  // modal part saat nota sudah diambil.
  function totalIn(d) {
    d = d || load();
    return (d.initial || 0) + d.entries.reduce(function (a, e) { return a + (e.moneyIn || 0); }, 0);
  }
  // Total dana DIPAKAI: modal sparepart, pengeluaran, dan bon.
  function totalOut(d) {
    d = d || load();
    return d.entries.reduce(function (a, e) { return a + (e.moneyOut || 0); }, 0);
  }
  // Total dana kembali saja (dipakai untuk laporan, bukan untuk saldo).
  function totalReturned(d) {
    d = d || load();
    return d.entries.reduce(function (a, e) {
      return a + (e.moneyIn && e.kind !== 'wajib' ? e.moneyIn : 0);
    }, 0);
  }
  // Breakdown dua variabel: Kas Darurat & Kas SDH
  // ATURAN WAJIB: Saldo awal terbagi 50% Kas Darurat & 50% Kas SDH.
  function getBreakdown(d) {
    d = d || load();
    var init = initialValue(d);
    var halfInit = Math.round(init / 2);
    var inDarurat = halfInit, outDarurat = 0;
    var inSDH = init - halfInit, outSDH = 0;

    d.entries.forEach(function (e) {
      var mi = (e.moneyIn || 0);
      var mo = (e.moneyOut || 0);
      var descU = String(e.description || '').toUpperCase();
      var isReturn = (e.kind === 'sparepart' || isReturnDesc(e.description));
      var isWajibDarurat = (e.kind === 'wajib' && (e.fund === 'darurat' || descU.indexOf('(KAS DARURAT)') !== -1 || descU.indexOf('5% (KAS DARURAT)') !== -1));

      // Dana Masuk: HANYA pengembalian sparepart Mas Cim & 50% kas wajib (5%) yang boleh masuk ke Kas Darurat
      if (mi > 0) {
        if (isReturn || isWajibDarurat) {
          inDarurat += mi;
        } else {
          inSDH += mi;
        }
      }

      // Dana Keluar: pengeluaran dari Kas SDH (e.fund === 'sdh' atau ada teks SDH), sisanya dari Kas Darurat
      if (mo > 0) {
        if (e.fund === 'sdh' || descU.indexOf('SDH') !== -1) {
          outSDH += mo;
        } else {
          outDarurat += mo;
        }
      }
    });

    var availDarurat = Math.max(0, inDarurat - outDarurat);
    var availSDH = Math.max(0, inSDH - outSDH);

    return {
      darurat: {
        totalIn: inDarurat,
        totalOut: outDarurat,
        available: availDarurat
      },
      sdh: {
        totalIn: inSDH,
        totalOut: outSDH,
        available: availSDH
      },
      totalAvailable: availDarurat + availSDH
    };
  }

  // Sisa yang boleh dipakai = total sisa kedua kas
  function available(d) {
    d = d || load();
    return getBreakdown(d).totalAvailable;
  }

  function get() {
    var d = load();
    var bd = getBreakdown(d);
    return {
      initial: initialValue(d),
      totalIn: totalIn(d),
      totalOut: totalOut(d),
      totalReturned: totalReturned(d),
      available: bd.totalAvailable,
      daruratAvailable: bd.darurat.available,
      sdhAvailable: bd.sdh.available,
      count: d.entries.length
    };
  }

  /* ---------------- mutasi ---------------- */

  // Aturan Wajib Revisi Khusus:
  // 1. Kas Darurat HANYA bisa menerima dari:
  //    (a) Pengembalian sparepart dari kalkulator-mascim (100% Kas Darurat).
  //    (b) Pembagian 50% dari kas wajib dana bank 10% tiap bulan sekali (5% Darurat & 5% SDH).
  // 2. Setoran otomatis / jalur manapun lainnya TIDAK BOLEH masuk ke Kas Darurat (masuk ke Kas SDH).
  // 3. Peminjaman modal sparepart Mascim keluar dari Kas Darurat.
  // 4. Out manual: Out Darurat dari Kas Darurat, Out Kas SDH via PIN dari Kas SDH.
  function add(rec) {
    var d = load();
    rec = rec || {};
    var mi = Math.max(0, Math.round(Number(rec.moneyIn) || 0));
    var mo = Math.max(0, Math.round(Number(rec.moneyOut) || 0));
    if (mi === 0 && mo === 0) throw new Error('Nominal harus lebih dari 0');

    var desc = String(rec.description || '').slice(0, 120);
    var date = String(rec.date || todayStr()).slice(0, 10);
    var note = String(rec.note || '').slice(0, 200);
    var kind = rec.kind === 'wajib' ? 'wajib' : (rec.kind || 'manual');

    // DANA MASUK (INFLOW)
    if (mi > 0) {
      var isReturn = (kind === 'sparepart' || kind === 'bon' || isReturnDesc(desc) || rec.isReturn);
      if (isReturn) {
        // (1) Pengembalian sparepart Mas Cim masuk 100% ke Kas Darurat
        var eReturn = {
          id: rec.id || uid(),
          description: desc,
          moneyIn: mi,
          moneyOut: 0,
          date: date,
          note: note,
          kind: 'sparepart',
          fund: 'darurat'
        };
        d.entries.push(eReturn);
        save();
        return eReturn;
      }

      // (2) Pembagian 50% dari kas wajib dana bank 10% tiap bulan sekali
      if (kind === 'wajib') {
        if (rec._noSplit && (rec.fund === 'sdh' || rec.fund === 'darurat')) {
          var eExplicit = {
            id: rec.id || uid(),
            description: desc,
            moneyIn: mi,
            moneyOut: 0,
            date: date,
            note: note,
            kind: 'wajib',
            fund: rec.fund
          };
          d.entries.push(eExplicit);
          save();
          return eExplicit;
        }

        var half1 = Math.round(mi / 2);
        var half2 = mi - half1;
        var cleanWajibDesc = desc.replace(/\s*\((?:50%|5%|\d+%)?\s*(?:Kas )?(?:Darurat|SDH)\)/gi, '').trim() || KETERANGAN_WAJIB;

        var eDarurat = {
          id: (rec.id || uid()) + '_d',
          description: cleanWajibDesc + ' 5% (Kas Darurat)',
          moneyIn: half1,
          moneyOut: 0,
          date: date,
          note: note,
          kind: 'wajib',
          fund: 'darurat'
        };
        var eSDH = {
          id: (rec.id || uid()) + '_s',
          description: cleanWajibDesc + ' 5% (Kas SDH)',
          moneyIn: half2,
          moneyOut: 0,
          date: date,
          note: note,
          kind: 'wajib',
          fund: 'sdh'
        };
        d.entries.push(eDarurat);
        d.entries.push(eSDH);
        save();
        return eDarurat;
      }

      // (3) SEMUA pemasukan / setoran lainnya MASUK KE KAS SDH (TIDAK BOLEH KE KAS DARURAT).
      var eSDHOther = {
        id: rec.id || uid(),
        description: desc + (desc.toUpperCase().indexOf('SDH') === -1 ? ' (Kas SDH)' : ''),
        moneyIn: mi,
        moneyOut: 0,
        date: date,
        note: note,
        kind: kind,
        fund: 'sdh'
      };
      d.entries.push(eSDHOther);
      save();
      return eSDHOther;
    }

    // DANA KELUAR (OUTFLOW)
    // Pengeluaran default dan wajib dari Kas Darurat, kecuali pengeluaran khusus Kas SDH via PIN
    var fund = rec.fund === 'sdh' ? 'sdh' : 'darurat';
    var bd = getBreakdown(d);

    if (fund === 'sdh') {
      if (mo > bd.sdh.available) {
        throw new Error('Kas SDH tidak cukup. Tersisa ' + fmtIDR(bd.sdh.available));
      }
    } else {
      // Kas Darurat: untuk pinjaman otomatis sparepart Mascim, catat peminjaman tanpa memblokir servis
      if (kind !== 'sparepart' && !rec.allowNegative && mo > bd.darurat.available) {
        throw new Error('Kas Darurat tidak cukup. Tersisa ' + fmtIDR(bd.darurat.available));
      }
    }

    var eOut = {
      id: rec.id || uid(),
      description: desc,
      moneyIn: 0,
      moneyOut: mo,
      date: date,
      note: note,
      kind: kind,
      fund: fund
    };
    d.entries.push(eOut);
    save();
    return eOut;
  }

  // Ubah saldo awal (men jadi total setoran masuk).
  function setInitial(v) {
    var d = load();
    var n = Math.round(Number(v) || 0);
    if (n < 0) return false;
    d.initial = n;
    save();
    return true;
  }

  function remove(id) {
    var d = load();
    var i = d.entries.findIndex(function (e) { return e.id === id; });
    if (i < 0) return false;
    d.entries.splice(i, 1);
    save();
    return true;
  }

  function listEntries() {
    return load().entries.slice();
  }

  /* ---------------- aturan setoran kas wajib 10% ---------------- */

  // Total pemasukan pada satu bulan (format bulan "YYYY-MM").
  function pemasukanBulan(txs, ym) {
    ym = String(ym || '');
    if (!/^\d{4}-\d{2}$/.test(ym)) return 0;
    return (txs || []).reduce(function (a, t) {
      if (!t || t.type !== 'in') return a;
      if (t.deleted_at) return a;
      var d = String(t.transaction_date || t.date || '').slice(0, 7);
      if (d !== ym) return a;
      return a + (Math.round(Number(t.amount) || 0));
    }, 0);
  }

  // Nominal yang WAJIB disetor bulan itu = 10% dari pemasukan, dibulatkan
  // ke ribuan terdekat supaya mudah dihitung manual.
  function wajibSetoranBulanan(txs, ym) {
    var income = pemasukanBulan(txs, ym);
    if (income <= 0) return 0;
    return Math.round((income * RASIO_WAJIB) / 1000) * 1000;
  }

  // Pencatatan setoran wajib. Idempoten: bulan yang sama tidak dobel,
  // walau tombol ditekan berkali-kali atau koneksi terputus.
  function tambahSetoranWajib(amount, ym, dateStr) {
    var d = load();
    ym = String(ym || todayStr().slice(0, 7));
    var already = d.wajibBulanan[ym];
    if (already) return { inserted: false, reason: 'sudah tercatat', entry: null, amount: already.amount };

    var amt = Math.round((Number(amount) || 0) / 1000) * 1000;
    if (amt <= 0) return { inserted: false, reason: 'nominal tidak valid', entry: null, amount: 0 };

    var amtDarurat = Math.round(amt / 2);
    var amtSDH = amt - amtDarurat;

    var e1 = add({
      description: KETERANGAN_WAJIB + ' 5% (Kas Darurat) ' + ym,
      moneyIn: amtDarurat,
      moneyOut: 0,
      date: dateStr || todayStr(),
      kind: 'wajib',
      fund: 'darurat',
      _noSplit: true
    });

    var e2 = add({
      description: KETERANGAN_WAJIB + ' 5% (Kas SDH) ' + ym,
      moneyIn: amtSDH,
      moneyOut: 0,
      date: dateStr || todayStr(),
      kind: 'wajib',
      fund: 'sdh',
      _noSplit: true
    });

    d.wajibBulanan[ym] = { amount: amt, at: todayStr() };
    save();
    return { inserted: true, reason: '', entry: e1, amount: amt };
  }

  // Sudah disetor untuk bulan itu?
  function sudahWajib(ym) {
    var d = load();
    return !!d.wajibBulanan[String(ym || '')];
  }

  // Otomatis: kalau belum disetor, catat 10% bulan itu sekarang.
  // Dipanggil dari aplikasi setelah ada pemasukan baru.
  function applyOtomatis(txs, ym) {
    ym = String(ym || todayStr().slice(0, 7));
    var due = wajibSetoranBulanan(txs, ym);
    if (due <= 0) return { inserted: false, reason: 'belum ada pemasukan', amount: 0 };
    return tambahSetoranWajib(due, ym);
  }

  // Berapa persen pemasukan bulan ini yang sudah disetor.
  function persenTerpenuhi(txs, ym) {
    var d = load();
    var income = pemasukanBulan(txs, ym);
    if (income <= 0) return 100;
    var done = d.wajibBulanan[ym] ? d.wajibBulanan[ym].amount : 0;
    var due = wajibSetoranBulanan(txs, ym);
    if (due <= 0) return 100;
    return Math.min(100, Math.round((done / due) * 100));
  }

  /* ---------------- util ---------------- */

  function todayStr() {
    var t = new Date();
    return t.getFullYear() + '-' +
      String(t.getMonth() + 1).padStart(2, '0') + '-' +
      String(t.getDate()).padStart(2, '0');
  }
  function fmtIDR(n) {
    return 'Rp' + String(Math.round(Number(n) || 0))
      .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  /* ---------------- ekspor/impor ---------------- */

  function exportJSON() {
    var d = load();
    return { initial: d.initial, entries: d.entries, wajibBulanan: d.wajibBulanan, version: 1 };
  }
  function importJSON(obj) {
    if (!obj || typeof obj !== 'object') return false;
    cache = norm(obj);
    save();
    return true;
  }
  function clearAll() {
    cache = blank();
    save();
  }
  // Dipakai test: benar-benar menghapus penyimpanan, lalu memuat ulang
  // dari keadaan kosong (reset biasa hanya membuang cache di memori).
  function reset() {
    try { w.localStorage.removeItem(KEY); } catch (e) {}
    cache = blank();
    save();
  }

  /* ---------------- Pelunasan otomatis ke Project Nava ---------------- */
  function autoSettlePelunasanToNava() {
    var today = todayStr();
    var ym = today.slice(0, 7);
    var day = parseInt(today.slice(8, 10), 10) || 0;
    if (day < 5) return { inserted: false, reason: 'belum tanggal 5', amount: 0 };

    var d = load();
    var already = d.pelunasanBulanan[ym];
    if (already) return { inserted: false, reason: 'sudah dicatat', amount: already.amount };

    var totalManualOut = d.entries.reduce(function (a, e) {
      if (e.kind === 'wajib') return a;
      return a + (Number(e.moneyOut) || 0);
    }, 0);
    var totalSettled = Object.keys(d.pelunasanBulanan || {}).reduce(function (a, k) {
      return a + ((d.pelunasanBulanan[k] && Number(d.pelunasanBulanan[k].amount)) || 0);
    }, 0);
    var due = Math.max(0, totalManualOut - totalSettled);
    if (due <= 0) {
      d.pelunasanBulanan[ym] = { amount: 0, at: today };
      save();
      return { inserted: false, reason: 'tidak ada nominal', amount: 0 };
    }

    var S = w.Store;
    if (!S || !S.Tx || typeof S.Tx.create !== 'function') {
      return { inserted: false, reason: 'Project Nava belum siap', amount: due };
    }

    var detail = d.entries.filter(function (e) {
      return e.kind !== 'wajib' && e.moneyOut > 0;
    }).map(function (e) {
      return e.description || ('Rp ' + fmtIDR(e.moneyOut));
    }).slice(0, 5).join('; ');

    var payload = {
      type: 'out',
      group: 'Out Tak Terduga',
      sub: null,
      amount: due,
      date: today,
      note: 'Pelunasan DanaBank ' + ym +
        ' — Settlement nominal Rp ' + fmtIDR(due) + (detail ? ' — ' + detail : '')
    };
    var r = S.Tx.create(payload, 'dana-bank-settle:' + ym);
    d.pelunasanBulanan[ym] = { amount: due, at: today };
    save();
    return { inserted: true, reason: '', amount: due, id: r && r.tx && r.tx.id };
  }
  try { w.setTimeout(autoSettlePelunasanToNava, 3000); } catch (e) {}

  w.NavaBank = {
    KEY: KEY,
    RASIO_WAJIB: RASIO_WAJIB,
    KETERANGAN_WAJIB: KETERANGAN_WAJIB,
    get: get,
    getBreakdown: getBreakdown,
    add: add,
    setInitial: setInitial,
    remove: remove,
    entries: listEntries,
    totalIn: totalIn,
    totalOut: totalOut,
    totalReturned: totalReturned,
    available: available,
    pemasukanBulan: pemasukanBulan,
    wajibSetoranBulanan: wajibSetoranBulanan,
    tambahSetoranWajib: tambahSetoranWajib,
    sudahWajib: sudahWajib,
    applyOtomatis: applyOtomatis,
    autoSettlePelunasanToNava: autoSettlePelunasanToNava,
    persenTerpenuhi: persenTerpenuhi,
    exportJSON: exportJSON,
    importJSON: importJSON,
    clearAll: clearAll,
    reset: reset,
    fmtIDR: fmtIDR,
    todayStr: todayStr
  };
})(window);
