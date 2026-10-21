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
  /* Dua penyimpanan server yang dipakai bergantian: tabel `priceLists` di
     tgcloud (lewat endpoint Serverless) dan tabel `vault` di Supabase.
     Keduanya adalah salinan TERPISAH, dan salah satunya bisa berisi data
     lama — pernah kejadian: endpoint berisi 6 sedangkan vault berisi 73.
     Karena itu kiriman selalu ditulis ke DUA-DUANYA (bukan salah satu),
     dan tarikan selalu membaca DUA-DUANYA lalu digabung. */
  function kirimVault() {
    if (!w.Supa || typeof w.Supa.vaultPut !== 'function') return;
    w.Supa.vaultPut(KEY, { rev: rev(), templates: daftar() });
  }

  function kirim() {
    if (sedangKirim) return;
    sedangKirim = true;
    terakhirKirim = Date.now();
    w.setTimeout(function () { sedangKirim = false; }, PUSH_GAP);

    /* Lewat endpoint Serverless (tgcloud.ai) kalau tersedia. */
    if (serverlessAktif()) {
      panggil('savePrices', { rev: rev(), templates: daftar() }).catch(function () {});
    }
    /* Selalu tulis juga ke vault Supabase: dua salinan server membuat
       data harga tetap bisa dipulihkan walau satu jalur bermasalah. */
    kirimVault();
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
    /* Penggabungan murni: TIDAK ADA entri yang dibuang dari daftar.
       Pencegahan daftar tumbuh sendiri dilakukan di sisi lain — entri
       contoh hanya dipasang kalau daftar benar-benar kosong (lihat
       seedIfNeeded + pemanggilannya di init calc.js). */
    (lokal || []).forEach(function (t) { peta[kunci(t)] = t; });
    (jauh || []).forEach(function (t) {
      var k = kunci(t);
      if (!peta[k] || waktu(t) > waktu(peta[k])) peta[k] = t;
    });
    return Object.keys(peta).map(function (k) { return peta[k]; });
  }

  /* ---------- Jaring pengaman harga tersimpan ----------
     Sebelum daftar lokal ditimpa data server, salinan daftar lokal
     disimpan lebih dulu (3 salinan terakhir). Jadi berapa pun entri yang
     lenyap, isinya masih bisa dipulihkan lewat CalcSync.pulihkanCadangan(). */
  var SAFETY = 'nava.templates.safety';

  function cadangkanLokal() {
    try {
      var kini = daftar();
      if (!kini.length) return;
      var arr;
      try { arr = JSON.parse(w.localStorage.getItem(SAFETY) || '[]'); } catch (e) { arr = []; }
      if (!Array.isArray(arr)) arr = [];
      arr.unshift({ at: cap(), rev: rev(), jumlah: kini.length, templates: kini });
      while (arr.length > 3) arr.pop();
      w.localStorage.setItem(SAFETY, JSON.stringify(arr));
    } catch (e) { /* storage penuh: jangan ganggu jalannya sinkronisasi */ }
  }

  function kunciEntri(t) {
    return (w.Store && w.Store.templateKey) ? w.Store.templateKey(t.payload || t) : (t.id || '');
  }

  /* Entri lokal yang TIDAK ada di daftar server = bakal hilang kalau ditimpa. */
  function bakalHilang(lokal, jauh) {
    var ada = {};
    (jauh || []).forEach(function (t) { ada[kunciEntri(t)] = true; });
    return (lokal || []).filter(function (t) { return !ada[kunciEntri(t)]; });
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
      cadangkanLokal();
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

    /* PENJAGA: kalau data server akan menghapus BANYAK entri lokal, itu
       tanda salinan server lebih sedikit/lebih tua (mis. perangkat lain
       yang datanya belum lengkap). Gabung saja, jangan timpa — supaya
       harga yang sudah dibuat tidak pernah lenyap tanpa jejak. */
    var hilang = bakalHilang(daftar(), templatesCloud);
    if (hilang.length >= 3 && hilang.length > templatesCloud.length * 0.3) {
      cadangkanLokal();
      w.Store.state.templates = gabung(daftar(), templatesCloud);
      w.Store.state.templatesRev = cap();
      try { w.Store.save(); } catch (e) {}
      gambarUlang();
      kirim();
      if (!diam && w.App && w.App.toast) {
        w.App.toast('Harga tersimpan digabung — ' + hilang.length + ' harga lokal diselamatkan', 4000, 'ok');
      }
      return true;
    }

    cadangkanLokal();
    w.Store.state.templates = templatesCloud;
    w.Store.state.templatesRev = revCloud;
    try { w.Store.save(); } catch (e) {}
    gambarUlang();
    if (!diam && w.App && w.App.toast) {
      w.App.toast('Harga tersimpan disamakan dari perangkat lain', 2600, 'ok');
    }
    return true;
  }

  /* Baca SATU jalur cadangan: tabel vault Supabase. Mengembalikan isi
     atau null (tanpa pernah melempar). */
  function tarikVault() {
    if (!w.Supa || typeof w.Supa.vaultGet !== 'function') return Promise.resolve(null);
    return w.Supa.vaultGet(KEY)
      .then(function (baris) { return (baris && baris.isi) || null; })
      .catch(function () { return null; });
  }

  /* Ambil isi dari SEMUA jalur yang tersedia lalu gabungkan daftarnya.
     Tidak ada jalur yang boleh dilewati: endpoint Serverless bisa saja
     menjawab dengan salinan lama/lebih sedikit, dan itu dulu membuat harga
     di layar tinggal 6 walaupun vault berisi 73. */
  function ambilSemua() {
    var janjiServerless = serverlessAktif()
      ? panggil('loadPrices', {})
          .then(function (h) { return h || null; })
          .catch(function () { return null; })
      : Promise.resolve(null);

    return Promise.all([janjiServerless, tarikVault()]).then(function (hasil) {
      var tpl = [], revPakai = '';
      hasil.forEach(function (x) {
        if (!x) return;
        if (Array.isArray(x.templates) && x.templates.length) tpl = tpl.concat(x.templates);
        if (x.rev && String(x.rev) > revPakai) revPakai = String(x.rev);
      });
      return { rev: revPakai, templates: tpl };
    });
  }

  /* Tarik data server (kedua jalur) lalu terapkan ke perangkat ini. */
  function tarik(diam) {
    if (sedangTarik) return Promise.resolve(false);
    sedangTarik = true;

    return ambilSemua().then(function (g) {
      sedangTarik = false;
      if (!g.templates.length) {
        /* Kosong di semua jalur: kirim data lokal (migrasi pertama). */
        return terapkan({ rev: '', templates: undefined }, diam);
      }
      /* rev kosong tapi ada isi: pakai rev baru supaya isi server tetap
         dipakai (tanpa ini isi server diabaikan dan yang dikirim justru
         salinan lokal yang lebih sedikit). */
      return terapkan({ rev: g.rev || cap(), templates: g.templates }, diam);
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

  /* Pulihkan daftar harga dari salinan pengaman lokal.
     Mengembalikan jumlah entri yang dipulihkan (0 = tidak ada salinan). */
  function pulihkanCadangan() {
    try {
      var arr = JSON.parse(w.localStorage.getItem(SAFETY) || '[]');
      if (!Array.isArray(arr) || !arr.length) return 0;
      var isi = arr[0].templates || [];
      if (!isi.length) return 0;
      w.Store.state.templates = gabung(daftar(), isi);
      w.Store.state.templatesRev = cap();
      try { w.Store.save(); } catch (e) {}
      gambarUlang();
      kirim();
      return isi.length;
    } catch (e) { return 0; }
  }

  /* Daftar salinan pengaman yang tersimpan di perangkat ini. */
  function daftarCadangan() {
    try {
      var arr = JSON.parse(w.localStorage.getItem(SAFETY) || '[]');
      if (!Array.isArray(arr)) return [];
      return arr.map(function (x) { return { at: x.at, jumlah: x.jumlah }; });
    } catch (e) { return []; }
  }

  w.CalcSync = {
    KEY: KEY,
    mulai: mulai,
    kirim: kirim,
    tarik: tarik,
    tandaiBerubah: tandaiBerubah,
    rev: rev,
    pulihkanCadangan: pulihkanCadangan,
    daftarCadangan: daftarCadangan
  };
})(window);
