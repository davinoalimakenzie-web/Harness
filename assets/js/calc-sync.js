/* ===================================================================
   calc-sync.js — Sinkronisasi harga tersimpan (Kalkulator Service HP)

   Harga tersimpan disimpan di server supaya isinya sama di SEMUA tautan
   dan SEMUA perangkat: link lama (index.html) maupun link baru
   (service.html), HP karyawan maupun HP pemilik.

   Transport (dua-duanya didukung, dipilih otomatis):
   - Telegram Serverless: kalau Mini App dibuka dari host Telegram
     Serverless (tgcloud.ai), pakai endpoint loadPrices/savePrices —
     identitas pemanggil diverifikasi Telegram lewat initData.
   - Supabase vault: untuk hosting lain (mis. GitHub Pages) selama
     masa transisi.

   Aturan penting:
   - Data lokal tetap sumber kebenaran. Kalau jaringan mati, aplikasi jalan
     seperti biasa dan kiriman ditahan di antrean Supa lalu dikirim nanti.
   - Setiap perubahan lokal menaikkan `templatesRev` lalu isinya dikirim.
   - Tarik otomatis: saat halaman siap, tiap 15 detik, saat aplikasi kembali
     aktif (visibilitychange/focus), dan saat tab/halaman lain di perangkat
     yang sama mengubah localStorage (`storage` event).
   - Kalau versi server lebih baru, data server dipakai apa adanya (termasuk
     penghapusan entri) lalu daftar digambar ulang + diberi notifikasi.
   - Server kosong + perangkat punya data -> kirim (migrasi otomatis).
   =================================================================== */
(function (w) {
  'use strict';

  var KEY = 'calc_templates';   // nama baris di tabel vault / endpoint
  var PULL_MS = 15000;          // tarik tiap 15 detik (biar terasa real-time)
  var PUSH_GAP = 1200;          // jeda minimum antar kiriman

  var sedangKirim = false, sedangTarik = false, timer = null, terakhirKirim = 0;

  function st() { return (w.Store && w.Store.state) || {}; }
  function daftar() { return st().templates || []; }
  function rev() { return st().templatesRev || ''; }
  function cap() { return new Date().toISOString(); }

  function gambarUlang() {
    try {
      var f = w.CalcUI && (w.CalcUI.renderList || w.CalcUI.renderTpl);
      if (f) f();
    } catch (e) {}
  }

  /* ---------- Transport: Telegram Serverless (endpoint) ---------- */
  function serverlessAktif() {
    try {
      return !!(w.Telegram && w.Telegram.WebApp && w.Telegram.WebApp.Serverless &&
                typeof w.Telegram.WebApp.Serverless.call === 'function');
    } catch (e) { return false; }
  }

  function panggil(nama, input) {
    return new Promise(function (selesai, gagal) {
      try {
        w.Telegram.WebApp.Serverless.call(nama, input || {}, function (err, hasil) {
          if (err) { gagal(err); return; }
          selesai(hasil || {});
        });
      } catch (e) { gagal(e); }
    });
  }

  /* ---------- Transport: Supabase vault ---------- */
  function kirim() {
    if (sedangKirim) return;

    /* Lewat endpoint Serverless (tgcloud.ai). */
    if (serverlessAktif()) {
      panggil('savePrices', { rev: rev(), templates: daftar() }).catch(function () {});
      return;
    }

    if (!w.Supa || typeof w.Supa.vaultPut !== 'function') return;
    var tunggu = PUSH_GAP - (Date.now() - terakhirKirim);
    if (tunggu > 0) {
      w.clearTimeout(kirim._t);
      kirim._t = w.setTimeout(function () { sedangKirim = false; kirim(); }, tunggu + 50);
      return;
    }
    sedangKirim = true;
    terakhirKirim = Date.now();
    w.Supa.vaultPut(KEY, { rev: rev(), templates: daftar() });
    w.setTimeout(function () { sedangKirim = false; }, PUSH_GAP);
  }

  /* Dipanggil setiap data harga berubah di perangkat ini. */
  function tandaiBerubah() {
    if (!w.Store || !w.Store.state) return;
    w.Store.state.templatesRev = cap();
    try { w.Store.save(); } catch (e) {}
    kirim();
  }

  /* Gabungkan data lokal & server per entri (yang lebih baru menang).
     Dipakai saat sinkronisasi PERTAMA kali (belum ada rev) supaya data
     lokal yang sudah ada tidak tertimpa data server. */
  function gabung(lokal, jauh) {
    var peta = {};
    function kunci(t) {
      return (w.Store && w.Store.templateKey) ? w.Store.templateKey(t.payload || t) : (t.id || '');
    }
    function waktu(t) { return Date.parse(t.updatedAt || t.createdAt || 0) || 0; }
    (lokal || []).forEach(function (t) { peta[kunci(t)] = t; });
    (jauh || []).forEach(function (t) {
      var k = kunci(t);
      if (!peta[k] || waktu(t) > waktu(peta[k])) peta[k] = t;
    });
    return Object.keys(peta).map(function (k) { return peta[k]; });
  }

  /* Terima data dari server lalu terapkan ke perangkat ini.
     Bentuk yang diterima: { rev, templates } (hasil endpoint langsung,
     atau isi dari baris vault Supabase). */
  function terapkan(isi, diam) {
    var revCloud = (isi && isi.rev) || '';
    var templatesCloud = isi && isi.templates;

    /* Server masih kosong / belum punya isi: kirim data lokal sekarang —
       kalau tidak, data yang sudah ada di perangkat ini tidak pernah sampai
       ke server dan perangkat lain selamanya tidak melihatnya. Ini juga
       yang membuat migrasi ke server baru berjalan otomatis. */
    if (!revCloud || !Array.isArray(templatesCloud)) {
      if (!daftar().length && !rev()) return false;   // dua-duanya kosong
      w.Store.state.templatesRev = cap();
      try { w.Store.save(); } catch (e) {}
      kirim();
      if (!diam && w.App && w.App.toast) {
        w.App.toast('Data harga dikirim ke server', 2600, 'ok');
      }
      return true;
    }

    /* Belum pernah sinkron (rev lokal kosong): GABUNG, jangan timpa —
       perangkat lama bisa saja sudah punya data sendiri. */
    if (!rev()) {
      var gabungan = gabung(daftar(), templatesCloud);
      w.Store.state.templates = gabungan;
      w.Store.state.templatesRev = cap();
      try { w.Store.save(); } catch (e) {}
      gambarUlang();
      kirim();                      // kirim hasil gabungan ke server
      if (!diam && w.App && w.App.toast) {
        w.App.toast('Data harga digabung dengan yang ada di server', 2800, 'ok');
      }
      return true;
    }

    if (revCloud <= rev()) return false;   // lokal sama atau lebih baru
    w.Store.state.templates = templatesCloud;
    w.Store.state.templatesRev = revCloud;
    try { w.Store.save(); } catch (e) {}
    gambarUlang();
    if (!diam && w.App && w.App.toast) {
      w.App.toast('Harga tersimpan disamakan dari perangkat lain', 2600, 'ok');
    }
    return true;
  }

  /* Tarik data server; pakai kalau lebih baru dari versi lokal. */
  function tarik(diam) {
    if (sedangTarik) return Promise.resolve(false);
    sedangTarik = true;

    if (serverlessAktif()) {
      return panggil('loadPrices', {})
        .then(function (hasil) {
          sedangTarik = false;
          return terapkan({ rev: hasil.rev || '', templates: hasil.templates }, diam);
        })
        .catch(function () { sedangTarik = false; return false; });
    }

    if (!w.Supa || typeof w.Supa.vaultGet !== 'function') return Promise.resolve(false);
    return w.Supa.vaultGet(KEY).then(function (baris) {
      sedangTarik = false;
      return terapkan(baris && baris.isi, diam);
    }).catch(function () { sedangTarik = false; return false; });
  }

  function mulai() {
    /* Perubahan dari tab/halaman lain di perangkat yang sama: langsung.
       localStorage sudah sama, yang perlu hanya menggambar ulang. */
    w.addEventListener('storage', function (e) {
      if (!e || !e.key || e.key.indexOf('projectnava') !== 0) return;
      try { if (w.Store && w.Store.load) w.Store.load(); } catch (err) {}
      gambarUlang();
    });
    /* Aplikasi kembali aktif -> tarik segera. */
    w.document.addEventListener('visibilitychange', function () {
      if (!w.document.hidden) tarik(true);
    });
    w.addEventListener('focus', function () { tarik(true); });
    /* Tarik berkala supaya perubahan dari HP lain cepat terlihat. */
    if (timer) w.clearInterval(timer);
    timer = w.setInterval(function () { tarik(true); }, PULL_MS);
    /* Tarikan pertama sesaat setelah halaman siap. */
    w.setTimeout(function () { tarik(true); }, 1500);
  }

  w.CalcSync = {
    KEY: KEY,
    mulai: mulai,
    kirim: kirim,
    tarik: tarik,
    tandaiBerubah: tandaiBerubah,
    rev: rev
  };
})(window);
