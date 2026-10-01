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
      wajibBulanan: {} // { '2025-03': { amount, at, id } } -> penanda sudah disetor
    };
  }

  function load() {
    if (cache) return cache;
    try {
      var raw = w.localStorage.getItem(KEY);
      cache = raw ? norm(JSON.parse(raw)) : blank();
    } catch (e) { cache = blank(); }
    return cache;
  }

  function norm(s) {
    var d = blank();
    if (!s || typeof s !== 'object') return d;
    if (typeof s.initial === 'number' && isFinite(s.initial) && s.initial > 0) d.initial = Math.round(s.initial);
    if (Array.isArray(s.entries)) {
      d.entries = s.entries.filter(function (e) {
        return e && typeof e === 'object';
      }).map(function (e) {
        return {
          id: e.id || uid(),
          description: String(e.description || '').slice(0, 120),
          moneyIn: Math.max(0, Math.round(Number(e.moneyIn) || 0)),
          moneyOut: Math.max(0, Math.round(Number(e.moneyOut) || 0)),
          date: String(e.date || '').slice(0, 10),
          note: String(e.note || '').slice(0, 200),
          kind: e.kind === 'wajib' ? 'wajib' : (e.kind || 'manual')
        };
      });
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
    return d.entries.reduce(function (a, e) { return a + (e.moneyIn || 0); }, 0);
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
  // Sisa yang boleh dipakai = saldo awal + semua setoran - semua pemakaian.
  function available(d) {
    d = d || load();
    return initialValue(d) + totalIn(d) - totalOut(d);
  }

  function get() {
    var d = load();
    return {
      initial: initialValue(d),
      totalIn: totalIn(d),
      totalOut: totalOut(d),
      totalReturned: totalReturned(d),
      available: available(d),
      count: d.entries.length
    };
  }

  /* ---------------- mutasi ---------------- */

  // Catat satu mutasi. moneyIn = dana masuk, moneyOut = dana keluar.
  // Penting: dana keluar tidak boleh melebihi sisa yang tersedia.
  function add(rec) {
    var d = load();
    rec = rec || {};
    var mi = Math.max(0, Math.round(Number(rec.moneyIn) || 0));
    var mo = Math.max(0, Math.round(Number(rec.moneyOut) || 0));
    if (mi === 0 && mo === 0) throw new Error('Nominal harus lebih dari 0');
    if (mo > 0 && mo > available(d)) {
      throw new Error('Dana Bank tidak cukup. Tersisa ' + fmtIDR(available(d)));
    }
    var e = {
      id: uid(),
      description: String(rec.description || '').slice(0, 120),
      moneyIn: mi,
      moneyOut: mo,
      date: String(rec.date || todayStr()).slice(0, 10),
      note: String(rec.note || '').slice(0, 200),
      kind: rec.kind === 'wajib' ? 'wajib' : 'manual'
    };
    d.entries.push(e);
    save();
    return e;
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

    var e = add({
      description: KETERANGAN_WAJIB + ' ' + ym,
      moneyIn: amt,
      moneyOut: 0,
      date: dateStr || todayStr(),
      kind: 'wajib'
    });
    d.wajibBulanan[ym] = { amount: amt, at: todayStr() };
    save();
    return { inserted: true, reason: '', entry: e, amount: amt };
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

  w.NavaBank = {
    KEY: KEY,
    RASIO_WAJIB: RASIO_WAJIB,
    KETERANGAN_WAJIB: KETERANGAN_WAJIB,
    get: get,
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
    persenTerpenuhi: persenTerpenuhi,
    exportJSON: exportJSON,
    importJSON: importJSON,
    clearAll: clearAll,
    reset: reset,
    fmtIDR: fmtIDR,
    todayStr: todayStr
  };
})(window);
