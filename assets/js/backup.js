/*
 * Auto-backup data Project Nava + Mas Cim.
 *
 * Tujuannya: kalau HP ganti, browser dibersihkan, atau ada kesalahan input,
 * data masih bisa dipulihkan tanpa perlu ingat melakukan ekspor manual.
 *
 * Cara kerja:
 *   - Setiap APP_SNAP_EVERY_MS, simpan salinan data ke localStorage
 *     (dengan menyimpan maksimal N salinan terbaru, yang lama dibuang).
 *   - Salinan disimpan sebagai string JSON supaya tidak ikut ter-serialize
 *     dua kali dan tetap terbaca meski struktur data berubah.
 *   - Halaman "Lainnya" menampilkan waktu backup terakhir + tombol pulihkan.
 *
 * Catatan: ini snapshot LOKAL di perangkat yang sama. Untuk pindah antar HP,
 * gunakan tombol unduh JSON (lihat exportJSON di app.js) atau sinkronisasi
 * ke server lewat modul sync.js.
 */
(function (w) {
  'use strict';
  if (w.AutoBackup) return;

  var STORE_KEY = 'nava.autobackup.v1';
  var LIST_KEY = 'nava.autobackup.list.v1';
  var APP_SNAP_EVERY_MS = 30 * 60 * 1000; // tiap 30 menit
  var MAX_SNAPSHOTS = 5;                  // simpan 5 snapshot terakhir
  // Batas total byte. localStorage di WebView Telegram kecil; kalau
  // penuh, penulisan bisa gagal dan destabilkan aplikasi.
  var MAX_TOTAL_BYTES = 2 * 1024 * 1024;  // 2 MB

  var timer = null;
  var listeners = [];

  function readList() {
    try {
      var raw = w.localStorage.getItem(LIST_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function writeList(list) {
    try { w.localStorage.setItem(LIST_KEY, JSON.stringify(list)); return true; }
    catch (e) { return false; }
  }

  function nowIso() { return new Date().toISOString(); }

  function makeId() {
    return 'bk_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  // Kumpulkan data dari Project Nava (dan Mas Cim bila termuat).
  function collect() {
    var payload = { app: 'project-nava', savedAt: nowIso() };
    try {
      if (w.Store && w.Store.Data && typeof w.Store.Data.exportJSON === 'function') {
        payload.nava = JSON.parse(w.Store.Data.exportJSON());
      }
    } catch (e) { payload.navaError = String(e && e.message || e); }

    // Mas Cim memakai mesin data sendiri (localStorage terpisah). Simpan
    // mentah apa adanya supaya tidak bergantung pada versi kode.
    try {
      if (w.MascimLocal && typeof w.MascimLocal._db === 'function') {
        payload.mascim = w.MascimLocal._db();
      }
    } catch (e) { payload.mascimError = String(e && e.message || e); }

    return payload;
  }

  // Simpan satu snapshot baru, pangkas yang lama.
  function run(force) {
    var data = collect();
    if (!data.nava && !data.mascim) return null; // belum ada apa-apa
    var id = makeId();
    var snap = { id: id, savedAt: data.savedAt, data: data };
    var raw;
    try { raw = JSON.stringify(snap); }
    catch (e) { return null; }

    var list = readList();

    // Pangkas SEBELUM menulis: jaga storage tetap di bawah batas
    // byte dan jumlah snapshot.
    function totalBytes(l) {
      return l.reduce(function (a, x) { return a + (x.bytes || 0); }, 0);
    }
    while (list.length && (list.length + 1 > MAX_SNAPSHOTS ||
                           totalBytes(list) + raw.length > MAX_TOTAL_BYTES)) {
      var drop = list.pop();
      try { w.localStorage.removeItem(STORE_KEY + '.' + drop.id); } catch (e) {}
    }

    try {
      w.localStorage.setItem(STORE_KEY + '.' + id, raw);
    } catch (e) {
      // Storage penuh: buang satu yang paling lama lalu coba sekali lagi.
      prune(1);
      try { w.localStorage.setItem(STORE_KEY + '.' + id, raw); }
      catch (e2) { return null; }
    }

    list = readList();
    list.unshift({ id: id, savedAt: snap.savedAt, bytes: raw.length });
    while (list.length > MAX_SNAPSHOTS) {
      var drop2 = list.pop();
      try { w.localStorage.removeItem(STORE_KEY + '.' + drop2.id); } catch (e) {}
    }
    if (!writeList(list)) return null;

    emit();
    return snap;
  }

  function prune(n) {
    var list = readList();
    for (var i = 0; i < n && list.length; i++) {
      var drop = list.pop();
      try { w.localStorage.removeItem(STORE_KEY + '.' + drop.id); } catch (e) {}
    }
    writeList(list);
  }

  function list() { return readList(); }

  function latest() {
    var l = readList();
    return l.length ? l[0] : null;
  }

  function get(id) {
    try {
      var raw = w.localStorage.getItem(STORE_KEY + '.' + id);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  // Pulihkan sebuah snapshot ke data aplikasi.
  function restore(id) {
    var snap = get(id || (latest() || {}).id);
    if (!snap || !snap.data) return { ok: false, error: 'Snapshot tidak ditemukan' };
    var d = snap.data;
    try {
      if (d.nava && w.Store && w.Store.Data && typeof w.Store.Data.importJSON === 'function') {
        w.Store.Data.importJSON(JSON.stringify(d.nava));
      }
    } catch (e) { return { ok: false, error: 'Gagal memulihkan Project Nava: ' + (e.message || e) }; }
    try {
      if (d.mascim && w.MascimLocal && typeof w.MascimLocal._db === 'function') {
        // Pulihkan storage Mas Cim apa adanya.
        w.localStorage.setItem('nava.mascim.local.v1', JSON.stringify(d.mascim));
        // Beri tahu modul supaya membaca ulang dari storage.
        if (typeof w.MascimLocal.reset === 'function') w.MascimLocal.reset();
      }
    } catch (e) { /* Mas Cim opsional */ }
    return { ok: true };
  }

  function remove(id) {
    try { w.localStorage.removeItem(STORE_KEY + '.' + id); } catch (e) {}
    writeList(readList().filter(function (x) { return x.id !== id; }));
    emit();
  }

  function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }
  function emit() { listeners.forEach(function (fn) { try { fn(); } catch (e) {} }); }

  function start(intervalMs) {
    stop();
    // Jaga agar error di dalam timer tidak mematikan WebView Telegram.
    timer = w.setInterval(function () {
      try { run(false); } catch (e) { console.error('backup: snapshot gagal', e); }
    }, intervalMs || APP_SNAP_EVERY_MS);
    // Snap pertama dibuat setelah app stabil sebentar, supaya data awal
    // sudah lengkap (seed Mas Cim, transaksi pertama, dll).
    w.setTimeout(function () { run(false); }, 4000);
  }

  function stop() { if (timer) { w.clearInterval(timer); timer = null; } }

  function fmtWaktu(iso) {
    if (!iso) return '-';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '-';
    return d.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
  }

  w.AutoBackup = {
    run: run,
    list: list,
    latest: latest,
    get: get,
    restore: restore,
    remove: remove,
    onChange: onChange,
    start: start,
    stop: stop,
    fmtWaktu: fmtWaktu,
    EVERY: APP_SNAP_EVERY_MS,
    MAX: MAX_SNAPSHOTS
  };
})(window);
