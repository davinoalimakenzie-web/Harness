/* ===================================================================
   ronce-sync.js — Sinkronisasi data Kalkulator Ronce antar perangkat.

   KENAPA PERLU: data Ronce (daftar mitra, tugas, komisi) dulu HANYA
   tersimpan di localStorage perangkat owner. Akibatnya link akses mitra
   (?m=ID) tidak mengenali ID mitra di HP mitra (perangkat baru) — mitra
   mendarat di beranda Project Nava, bukan di Kalkulator Garapan.

   TRANSPORT: tabel `vault` Supabase, kunci `ronce_data`
   (w.Supa.vaultPut / w.Supa.vaultGet). Satu dokumen berisi seluruh data
   Ronce + stempel `updatedAt` + tombstone `hapus` supaya penghapusan
   tidak "hidup lagi" saat digabung.

   ATURAN:
   - Data lokal tetap sumber kebenaran; kalau jaringan mati, aplikasi jalan
     seperti biasa dan tarikan berikutnya menyusul.
   - Gabung (merge) per-item berdasarkan id + stempel waktu item, jadi
     perubahan owner (tugas baru) dan mitra (lapor selesai, pengajuan
     pembayaran) TIDAK saling menimpa.
   - Tarik otomatis: saat mulai, tiap 15 detik, saat aplikasi kembali aktif
     (visibilitychange/focus), dan saat localStorage berubah (storage).
   =================================================================== */
(function (w) {
  'use strict';

  var KEY = 'ronce_data';
  var PULL_MS = 15000;   // tarik tiap 15 detik
  var GAP = 1500;        // jeda minimum antar kiriman

  var timer = null, sedangKirim = false, sedangTarik = false, terakhirKirim = 0;

  function R() { return w.Ronce; }
  function siap() {
    return !!(R() && typeof R()._doc === 'function' && typeof R()._gabung === 'function' &&
              w.Supa && typeof w.Supa.vaultGet === 'function' && typeof w.Supa.vaultPut === 'function');
  }

  /* Tarik dokumen dari server lalu gabung ke data lokal.
     senyap=true dipakai saat dipanggil internal (tidak melempar error). */
  function tarik() {
    if (!siap() || sedangTarik) return Promise.resolve(false);
    sedangTarik = true;
    return w.Supa.vaultGet(KEY).then(function (baris) {
      sedangTarik = false;
      var jauh = baris && baris.isi;
      if (!jauh) return false;
      if (typeof jauh === 'string') {
        try { jauh = JSON.parse(jauh); } catch (e) { return false; }
      }
      var berubah = R()._gabung(jauh);
      if (berubah) R()._refresh();
      return berubah;
    }).catch(function () { sedangTarik = false; return false; });
  }

  /* Kirim data lokal ke server. Tarik+gabung dulu supaya kiriman dari
     perangkat lain tidak tertimpa. */
  function kirim() {
    if (!siap() || sedangKirim) return;
    var tunggu = GAP - (Date.now() - terakhirKirim);
    if (tunggu > 0) {
      w.clearTimeout(kirim._t);
      kirim._t = w.setTimeout(function () { sedangKirim = false; kirim(); }, tunggu + 50);
      return;
    }
    sedangKirim = true;
    terakhirKirim = Date.now();
    tarik().then(function () {
      return w.Supa.vaultPut(KEY, R()._doc());
    }).then(function () {
      sedangKirim = false;
    }).catch(function () { sedangKirim = false; });
  }

  function mulai() {
    if (!siap()) return;
    /* Tarik dulu, baru kirim: perangkat yang sudah punya data otomatis jadi
       penyemai server (owner cukup membuka aplikasi sekali), dan perangkat
       baru (HP mitra) langsung menerima datanya. */
    tarik().then(function () { kirim(); });
    if (timer) w.clearInterval(timer);
    timer = w.setInterval(function () { tarik(); }, PULL_MS);
    w.document.addEventListener('visibilitychange', function () {
      if (!w.document.hidden) tarik();
    });
    w.addEventListener('focus', function () { tarik(); });
    w.addEventListener('storage', function (e) {
      if (e && e.key && String(e.key).indexOf('nava_ronce') === 0) {
        try { R()._muat(); } catch (err) {}
        R()._refresh();
      }
    });
  }

  w.RonceSync = { mulai: mulai, tarik: tarik, kirim: kirim };
})(window);
