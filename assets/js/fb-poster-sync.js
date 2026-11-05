/* ===================================================================
   fb-poster-sync.js — Sinkronisasi FB Auto-Poster via tabel vault.

   Mengikuti pola ronce-sync.js:
   - Tarik dokumen konfigurasi `fbposter_data` tiap 15 detik +
     saat aplikasi aktif kembali + saat localStorage berubah.
   - Tarik status daemon `fbposter_status` bersamaan supaya panel
     menampilkan status server & log tanpa perlu refresh manual.
   - Kirim: tarik+gabung dulu supaya perubahan daemon (runNow
     dimatikan, indeks poster/caption maju, postedToday) TIDAK
     tertimpa kiriman lokal.
   =================================================================== */
(function (w) {
  'use strict';

  var KEY = 'fbposter_data';
  var KEY_STATUS = 'fbposter_status';
  var PULL_MS = 15000;
  var GAP = 1500;

  var timer = null, sedangKirim = false, sedangTarik = false, terakhirKirim = 0;

  function UI() { return w.FbPosterUI; }
  function siap() {
    return !!(UI() && typeof UI()._doc === 'function' && typeof UI()._gabung === 'function' &&
              w.Supa && typeof w.Supa.vaultGet === 'function' && typeof w.Supa.vaultPut === 'function');
  }

  function tarik() {
    if (!siap() || sedangTarik) return Promise.resolve(false);
    sedangTarik = true;
    return w.Supa.vaultGet(KEY).then(function (baris) {
      sedangTarik = false;
      var jauh = baris && baris.isi;
      if (!jauh) return tarikStatus();
      if (typeof jauh === 'string') {
        try { jauh = JSON.parse(jauh); } catch (e) { return tarikStatus(); }
      }
      var berubah = UI()._gabung(jauh);
      if (berubah) UI()._refresh();
      return tarikStatus();
    }).catch(function () { sedangTarik = false; return false; });
  }

  function tarikStatus() {
    return w.Supa.vaultGet(KEY_STATUS).then(function (baris) {
      var st = baris && baris.isi;
      if (st && typeof st === 'string') {
        try { st = JSON.parse(st); } catch (e) { st = null; }
      }
      if (st && UI()) UI()._setStatus(st);
      return !!st;
    }).catch(function () { return false; });
  }

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
      return w.Supa.vaultPut(KEY, UI()._doc());
    }).then(function () {
      sedangKirim = false;
    }).catch(function () { sedangKirim = false; });
  }

  function mulai() {
    if (!siap()) return;
    tarik().then(function () { kirim(); });
    if (timer) w.clearInterval(timer);
    timer = w.setInterval(function () { tarik(); }, PULL_MS);
    w.document.addEventListener('visibilitychange', function () {
      if (!w.document.hidden) tarik();
    });
    w.addEventListener('focus', function () { tarik(); });
    w.addEventListener('storage', function (e) {
      if (e && e.key === 'nava_fbposter_v1') UI()._refresh();
    });
  }

  w.FbPosterSync = { mulai: mulai, tarik: tarik, kirim: kirim };
})(window);
