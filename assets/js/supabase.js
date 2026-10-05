/* ===================================================================
   supabase.js  Penyimpanan terpusat untuk Mas Cim Service HP.

   Dua tabel yang dipakai:

   1. notas   satu baris per nota. Dipakai supaya tautan nota publik
      bisa dibuka pelanggan dari HP mana pun lewat ?t=<token>.
   2. vault   satu baris per kunci data aplikasi (cadangan terpusat).

   Sifat penting modul ini: TIDAK PERNAH menggagalkan aplikasi. Local
   tetap jadi sumber kebenaran. Supabase hanya salinan. Kalau jaringan
   mati atau tabel belum dibuat, semua antrean ditahan di localStorage
   dan dikirim ulang nanti. Tidak ada satu pun alur yang bergantung
   pada Supabase supaya berhasil.

   Tidak memakai SDK. Hanya fetch, supaya tetap jalan di WebView lama.
   =================================================================== */
(function (w) {
  'use strict';

  var URL = 'https://tpolunkalvyrrwodvdov.supabase.co';
  var KEY = 'sb_publishable_vduwEVS4aridpmkQiW6PnA_jRws3g2R';
  // Kunci publik (publishable). Ini aman ditaruh di frontend. Kunci
  // service_role TIDAK boleh pernah muncul di berkas ini.

  var ANTARE = 'mascim_sb_queue';
  var KUNCI_VAULT = 'mascim_sb_status';
  var KADAR_MS = 20000;           // jeda minimum antar pengiriman
  var BAWAAN = 400;               // timeout satu permintaan

  var antrean = null;
  var status = null;
  var terakhirKirim = 0;
  var berjalan = false;

  /* ------------------------------------------------------------------
     Pembantu kecil
     ------------------------------------------------------------------ */

  function baca() {
    if (antrean !== null) return antrean;
    try {
      var mentah = w.localStorage.getItem(ANTARE);
      antrean = mentah ? JSON.parse(mentah) : [];
    } catch (e) { antrean = []; }
    if (!Array.isArray(antrean)) antrean = [];
    return antrean;
  }

  function tulis() {
    try { w.localStorage.setItem(ANTARE, JSON.stringify(baca())); } catch (e) {}
  }

  function st(kunci, nilai) {
    try {
      var d = status ? status : (status = JSON.parse(w.localStorage.getItem(KUNCI_VAULT) || '{}'));
      if (nilai === undefined) return d[kunci];
      d[kunci] = nilai;
      w.localStorage.setItem(KUNCI_VAULT, JSON.stringify(d));
      return nilai;
    } catch (e) { return undefined; }
  }

  // Token nota harus berbentuk UUIDv4, bukan string acak sembarang.
  // Kolom token bertipe UUID di PostgreSQL, dan string acak akan ditolak
  // dengan "invalid input syntax for type uuid" sehingga tidak ada nota
  // yang tersimpan sama sekali.
  function tokenBaru() {
    var h = '0123456789abcdef';
    var out = '';
    for (var i = 0; i < 36; i++) {
      if (i === 8 || i === 13 || i === 18 || i === 23) { out += '-'; continue; }
      if (i === 14) { out += '4'; continue; }
      if (i === 19) { out += h[(Math.floor(Math.random() * 4) + 8) % 16]; continue; }
      out += h.charAt(Math.floor(Math.random() * 16));
    }
    return out;
  }

  /* ------------------------------------------------------------------
     Satu permintaan ke Supabase. Tidak pernah melempar ke pemanggil.
     ------------------------------------------------------------------ */
  function req(method, jalur, body, kirimBalik) {
    return new Promise(function (res) {
      var kendali = null;
      var selesai = false;
      function tutup(hasil) {
        if (selesai) return;
        selesai = true;
        if (kendali) { try { clearTimeout(kendali); } catch (e) {} }
        res(hasil);
      }
      try {
        kendali = setTimeout(function () { tutup({ ok: false, err: 'timeout' }); }, BAWAAN + 4000);
      } catch (e) { kendali = null; }

      var opsi = {
        method: method,
        headers: {
          'apikey': KEY,
          'Authorization': 'Bearer ' + KEY,
          'Content-Type': 'application/json'
        }
      };
      if (body !== undefined) opsi.body = JSON.stringify(body);
      if (kirimBalik) opsi.headers['Prefer'] = 'return=representation';

      // fetch tidak ada di WebView sangat lama. Abaikan diam-diam.
      if (typeof w.fetch !== 'function') { tutup({ ok: false, err: 'no-fetch' }); return; }

      w.fetch(URL + jalur, opsi).then(function (r) {
        return r.text().then(function (t) {
          var data = null;
          try { data = t ? JSON.parse(t) : null; } catch (e) { data = t; }
          if (r.ok) tutup({ ok: true, data: data });
          else tutup({ ok: false, err: (data && data.message) ? data.message : ('HTTP ' + r.status), code: r.status });
        });
      }).catch(function (e) {
        tutup({ ok: false, err: (e && e.message) ? e.message : 'jaringan' });
      });
    });
  }

  /* ------------------------------------------------------------------
     Bentuk baris nota. Hanya field yang benar-benar tampil di nota
     pelanggan; tidak ada harga part, modal, atau sparepart.
     ------------------------------------------------------------------ */
  var GARANSI_HARI = { '7 Hari': 7, '30 Hari': 30, '60 Hari': 60 };

  function nomorNota(o) {
    var sumber = [o && o.number, o && o.noteNumberRaw, o && o.noteNumber];
    for (var i = 0; i < sumber.length; i++) {
      if (sumber[i] === undefined || sumber[i] === null || sumber[i] === '') continue;
      var n = parseInt(sumber[i], 10);
      if (!isNaN(n) && n > 0) return n;
    }
    return 0;
  }

  function keNota(o, note) {
    note = note || {};
    var hari = GARANSI_HARI[o.warranty || note.warrantyLabel] || 0;
    var tanpaGaransi = !hari;
    var terbit = note.issuedAt || o.completedAt || o.updatedAt || new Date().toISOString();
    var sampai = tanpaGaransi ? null : new Date(new Date(terbit).getTime() + hari * 86400000).toISOString();
    return {
      local_id: o.id,
      // Nomor nota datang dalam beberapa bentuk: o.number dari nota
      // garansi, o.noteNumberRaw berupa angka, dan o.noteNumber berupa
      // teks yang sudah dipadding misalnya "0007". Semua harus
      // diturnipkan jadi angka supaya kolom integer di server tidak
      // menerima teks dan nomor nota tidak ikut menjadi nol.
      no_nota: nomorNota(o),
      token: note.token || tokenBaru(),
      customer_name: o.customerName || o.customer_name || '',
      whatsapp: o.whatsapp || '',
      device: o.device || '',
      complaint: o.complaint || '',
      intake_condition: o.intakeCondition || o.intake_condition || '',
      handling: o.handling || '',
      total_cost: Number(o.totalCost || o.total_cost || 0),
      payment_method: o.paymentMethod || o.payment_method || '',
      // paid_at hanya diisi kalau benar-benar lunas.
      paid_at: o.paidAt || (Number(o.remaining || 0) === 0 ? o.updatedAt || null : null),
      service_status: o.serviceStatus || o.service_status || 'Progress',
      warranty: o.warranty || note.warrantyLabel || 'Non Garansi',
      warranty_days: hari,
      warranty_until: sampai,
      // Tanpa garansi berarti tanpa kedaluwarsa, bukan kedaluwarsa sekarang.
      expires_at: tanpaGaransi ? null : sampai,
      received_at: o.receivedAt || o.received_at || null,
      taken_at: o.takenAt || o.completedAt || null,
      dicabut: !!note.revoked,
      dibuat: o.createdAt || o.created_at || new Date().toISOString()
    };
  }

  /* ------------------------------------------------------------------
     Antrean: setiap pekerjaan disimpan penuh supaya bisa diulang.
     ------------------------------------------------------------------ */
  function taruh(kerja) {
    kerja.asa = Date.now();
    var a = baca();
    a.push(kerja);
    // Batasi antrean supaya localStorage tidak membengkak.
    if (a.length > 300) a = a.slice(-300);
    antrean = a;
    tulis();
    st('nilai', baca().length);
  }

  /* ------------------------------------------------------------------
     Kirim satu pekerjaan. Mengembalikan Promise yang SELALU selesai
     (tidak pernah menolak) supaya antrean tidak macet.
     ------------------------------------------------------------------ */
  function kirim(kerja) {
    if (kerja.tipe === 'nota') {
      var kolom = [
        'local_id', 'no_nota', 'token', 'customer_name', 'whatsapp', 'device',
        'complaint', 'intake_condition', 'handling', 'total_cost',
        'payment_method', 'paid_at', 'service_status', 'warranty',
        'warranty_days', 'warranty_until', 'expires_at', 'received_at',
        'taken_at', 'dicabut', 'dibuat'
      ].join(',');
      return req('POST', '/rest/v1/notas', kerja.baris, true).then(function (r) {
        return r.ok ? { ok: true } : { ok: false, err: r.err };
      });
    }
    if (kerja.tipe === 'nota-patch') {
      return req('PATCH', '/rest/v1/notas?local_id=eq.' + encodeURIComponent(kerja.id),
        kerja.baris, false).then(function (r) {
          return r.ok ? { ok: true } : { ok: false, err: r.err };
        });
    }
    if (kerja.tipe === 'vault') {
      return req('POST', '/rest/v1/vault', { kunci: kerja.kunci, isi: kerja.isi }, true)
        .then(function (r) {
          if (r.ok) return { ok: true };
          // Konflik: sudah ada, jadi perbarui.
          if (r.code === 409) {
            return req('PATCH', '/rest/v1/vault?kunci=eq.' + encodeURIComponent(kerja.kunci),
              { isi: kerja.isi }, false).then(function (r2) {
                return r2.ok ? { ok: true } : { ok: false, err: r2.err };
              });
          }
          return { ok: false, err: r.err };
        });
    }
    return Promise.resolve({ ok: true });
  }

  /* ------------------------------------------------------------------
     Kirim antrean satu per satu. Berhenti saat gagal supaya urutan
     perubahan tetap terjaga.
     ------------------------------------------------------------------ */
  function kuras() {
    if (berjalan) return Promise.resolve();
    if (typeof w.fetch !== 'function') { st('status', 'offline'); return Promise.resolve(); }
    var a = baca();
    if (!a.length) { st('status', 'selesai'); st('nilai', 0); return Promise.resolve(); }
    // Cooldown hanya menahan pengiriman yang sukses. Kalau percobaan
    // tadi gagal, percobaan berikutnya boleh langsung jalan supaya
    // data tidak tertahan lama saat jaringan baru saja kembali.
    if (st('status') !== 'gagal' && Date.now() - terakhirKirim < KADAR_MS) {
      return Promise.resolve();
    }

    berjalan = true;
    st('status', 'mengirim');
    terakhirKirim = Date.now();

    function langkah() {
      var a2 = baca();
      if (!a2.length) {
        berjalan = false; st('status', 'selesai'); st('nilai', 0);
        if (w.SBFallback) { try { w.SBFallback(); } catch (e) {} }
        return Promise.resolve();
      }
      var kerja = a2[0];
      return kirim(kerja).then(function (r) {
        if (r && r.ok) {
          var b = baca();
          if (b[0] === kerja) { b.shift(); antrean = b; tulis(); }
          return langkah();
        }
        // Gagal: tahan pekerjaan itu, jangan membuang.
        berjalan = false;
        st('status', 'gagal');
        st('kesalahan', r && r.err ? r.err : 'tidak diketahui');
        st('coba_lagi', (st('coba_lagi') || 0) + 1);
        return Promise.resolve();
      }).catch(function () {
        berjalan = false; st('status', 'gagal');
      });
    }
    return langkah();
  }

  /* ------------------------------------------------------------------
     Dipanggil dari lapisan data setiap kali ada perubahan.
     Tidak pernah melempar ke pemanggil.
     ------------------------------------------------------------------ */
  function antar(ethod, path, body, hasil) {
    try {
      if (!URL || !KEY) return;
      var seg = String(path).split('?')[0].split('/').filter(Boolean);
      if (seg[0] !== 'api' || seg[1] !== 'mascim') return;
      var r = seg.slice(2);

      var svc = (hasil && hasil.service) ? hasil.service : null;

      if (r[0] === 'services' && (ethod === 'POST' || (ethod === 'PATCH' && r.length === 2))) {
        if (!svc) return;
        taruh({ tipe: 'nota', baris: keNota(svc, (svc.warrantyNote) || {}) });
        w.setTimeout(kuras, 30);
        return;
      }
      if (r[0] === 'services' && r[2] === 'confirm-taken' && svc) {
        // Nota baru terbit di sini: kirim ulang agar token dan masa
        // berlaku garansi ikut tersimpan di server.
        taruh({ tipe: 'nota', baris: keNota(svc, svc.warrantyNote || {}) });
        w.setTimeout(kuras, 30);
        return;
      }
      if (r[0] === 'services' && r[2] === 'status' && svc) {
        taruh({
          tipe: 'nota-patch', id: svc.id,
          baris: {
            service_status: svc.serviceStatus,
            taken_at: svc.takenAt || null,
            completed_at: svc.completedAt || null,
            warranty: svc.warranty || 'Non Garansi'
          }
        });
        w.setTimeout(kuras, 30);
      }
    } catch (e) { /* sinkronisasi tidak boleh mengganggu alur utama */ }
  }

  /* ------------------------------------------------------------------
     Cadangan terpusat: kirim seluruh isi localStorage aplikasi.
     Dipanggil berkala dan saat pengguna menekan tombol Sinkronkan.
     ------------------------------------------------------------------ */
  function cadangan() {
    try {
      var isi = {};
      for (var i = 0; i < w.localStorage.length; i++) {
        var k = w.localStorage.key(i);
        if (!k) continue;
        if (k === ANTARE) continue;
        if (k === KUNCI_VAULT) continue;
        var v = w.localStorage.getItem(k);
        if (v && v.length < 400000) isi[k] = v;
      }
      var kunci = 'app:' + new Date().toISOString().slice(0, 10);
      taruh({ tipe: 'vault', kunci: kunci, isi: isi });
      st('cadangan', kunci);
      w.setTimeout(kuras, 30);
      return kunci;
    } catch (e) { return null; }
  }

  /* ------------------------------------------------------------------
     Baca nota publik dari server. Dipakai nota.html.
     Mengembalikan Promise; menolak kalau tidak ditemukan.
     ------------------------------------------------------------------ */
  function ambilNota(token) {
    if (!token) return Promise.reject(new Error('token kosong'));
    return req('GET', '/rest/v1/notas?token=eq.' + encodeURIComponent(token) +
      '&select=no_nota,token,customer_name,whatsapp,device,complaint,intake_condition,' +
      'handling,total_cost,payment_method,paid_at,service_status,warranty,warranty_days,' +
      'warranty_until,expires_at,received_at,taken_at,dicabut', undefined, false)
      .then(function (r) {
        if (!r.ok) throw new Error(r.err || 'gagal');
        if (!Array.isArray(r.data) || !r.data.length) throw new Error('nota tidak ditemukan');
        if (r.data[0].dicabut) throw new Error('nota dicabut');
        return r.data[0];
      });
  }

  /* ------------------------------------------------------------------
     Bersihkan baris nota yang kedaluwarsa lebih dari 90 hari supaya
     tabel tidak menumpuk. Aman: hanya baris yang sudah lewat masa
     berlaku DAN lewat 90 hari.
     ------------------------------------------------------------------ */
  function bersihkan() {
    var batas = new Date(Date.now() - 90 * 86400000).toISOString();
    return req('DELETE', '/rest/v1/notas?expires_at=lt.' + encodeURIComponent(batas) +
      '&expires_at=not.is.null&taken_at=lt.' + encodeURIComponent(batas), undefined, false);
  }

  /* ------------------------------------------------------------------
     Lencana status. Ditambahkan sendiri oleh modul ini, tidak
    menyentuh elemen yang sudah ada, jadi tidak mungkin merusak tata
     letak layar yang sekarang.
     ------------------------------------------------------------------ */
  var lencana = null;
  var posI = 'mascim_sb_pos';

  function loadPosisi() {
    try { return JSON.parse(w.localStorage.getItem(posI) || 'null'); }
    catch (e) { return null; }
  }

  function simpanPosisi(x, y) {
    try { w.localStorage.setItem(posI, JSON.stringify({ x: x, y: y })); } catch (e) {}
  }

  function buatLencana() {
    if (lencana || !w.document || !w.document.body) return;

    // Bentuk kecil: cuma titik 26px yang tidak menutupi tombol lain.
    // Disentuh untuk membuka, dan bisa diseret ke mana saja. Posisi
    // terakhir diingat supaya tidak muncul di tempat yang sama tiap kali.
    var b = w.document.createElement('div');
    b.id = 'mascim-sb';

    var titik = w.document.createElement('span');
    titik.id = 'mascim-sb-titik';
    titik.style.cssText = 'width:9px;height:9px;border-radius:50%;background:#35d07f;' +
      'display:block;flex:0 0 auto';

    var teks = w.document.createElement('span');
    teks.id = 'mascim-sb-teks';
    teks.textContent = 'Tersambung';
    teks.style.cssText = 'display:none;white-space:nowrap';

    var tombol = w.document.createElement('button');
    tombol.textContent = 'Sinkron';
    tombol.style.cssText = 'display:none;border:0;border-radius:999px;padding:4px 10px;' +
      'cursor:pointer;font:700 11px/1.2 system-ui,sans-serif;background:#35d07f;color:#06240f';

    b.appendChild(titik); b.appendChild(teks); b.appendChild(tombol);
    b.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:9999;' +
      'display:flex;align-items:center;gap:7px;padding:8px;border-radius:999px;' +
      'font:600 11px/1.2 system-ui,sans-serif;color:#d7ffe4;background:#0d3b1c;' +
      'border:1px solid #1f6b39;opacity:.75;box-shadow:0 2px 8px rgba(0,0,0,.35);' +
      'touch-action:none;user-select:none;-webkit-user-select:none';

    // Pulihkan posisi tersimpan.
    var pos = loadPosisi();
    if (pos && typeof pos.x === 'number') {
      b.style.left = pos.x + 'px';
      b.style.top = pos.y + 'px';
      b.style.bottom = 'auto';
    }

    var buka = false;
    function setBuka(nilai) {
      buka = nilai;
      teks.style.display = nilai ? 'inline' : 'none';
      tombol.style.display = nilai ? 'inline-block' : 'none';
      b.style.opacity = nilai ? '1' : '.55';
    }

    // Seret: pakai Pointer Event, tersedia di WebView modern. Bila tidak
    // ada, lencana tetap bisa disentuh untuk membuka.
    var seret = null;
    function mulaiSeret(x, y) {
      var kotak = b.getBoundingClientRect ? b.getBoundingClientRect() : { left: 10, top: 10 };
      seret = { dx: x - (kotak.left || 0), dy: y - (kotak.top || 0), geser: false };
    }
    function jalanSeret(x, y) {
      if (!seret) return;
      var nx = x - seret.dx, ny = y - seret.dy;
      if (Math.abs(nx - (seret.x0 || nx)) > 3 || seret.geser) seret.geser = true;
      b.style.left = nx + 'px';
      b.style.top = ny + 'px';
      b.style.bottom = 'auto';
      b.style.right = 'auto';
    }
    function selesaiSeret() {
      if (!seret) return;
      var l = parseInt(b.style.left, 10), t = parseInt(b.style.top, 10);
      if (!isNaN(l) && !isNaN(t)) simpanPosisi(l, t);
      var cumaGeser = seret.geser;
      seret = null;
      // Lepas tanpa gerak berarti menyentuh: buka atau tutup.
      if (!cumaGeser) setBuka(!buka);
    }

    if (w.PointerEvent) {
      b.addEventListener('pointerdown', function (e) {
        if (e.target === tombol) return;
        mulaiSeret(e.clientX, e.clientY);
      });
      b.addEventListener('pointermove', function (e) {
        if (seret) { jalanSeret(e.clientX, e.clientY); e.preventDefault(); }
      });
      b.addEventListener('pointerup', selesaiSeret);
      b.addEventListener('pointercancel', selesaiSeret);
    } else {
      // Peramban lama: ketuk untuk buka atau tutup.
      b.addEventListener('click', function (e) {
        if (e.target === tombol) return;
        setBuka(!buka);
      });
    }

    tombol.addEventListener('click', function (e) {
      e.stopPropagation();
      teks.textContent = 'Mengirim...';
      if (w.Supa.cadangan) w.Supa.cadangan();
      w.Supa.kuras();
      w.setTimeout(tampilStatus, 900);
      setBuka(false);
    });

    w.document.body.appendChild(b);
    lencana = b;
    setBuka(false);
    tampilStatus();
  }

  function tampilStatus() {
    if (!lencana) return;
    var s2 = w.Supa.status();
    var t = w.document.getElementById('mascim-sb-teks');
    var dot = w.document.getElementById('mascim-sb-titik');
    if (!t || !dot) return;
    var label, warna;
    if (!s2.ada) { label = 'Tanpa server'; warna = '#8a8a8a'; }
    else if (s2.antrean > 0) { label = 'Menunggu ' + s2.antrean; warna = '#e0b400'; }
    else if (s2.status === 'gagal') { label = 'Server belum bisa'; warna = '#e05a5a'; }
    else { label = 'Tersambung'; warna = '#35d07f'; }
    t.textContent = label;
    dot.style.background = warna;
    // Kalau ada antrean, pancing supaya pengguna melihat.
    if (s2.antrean > 0 && lencana.style.opacity === '.55') lencana.style.opacity = '.8';
    w.setTimeout(tampilStatus, 6000);
  }

  if (w.document) {
    if (w.document.readyState === 'loading') {
      w.document.addEventListener('DOMContentLoaded', buatLencana);
    } else {
      w.setTimeout(buatLencana, 900);
    }
  }

  w.Supa = {
    url: URL,
    // Kunci publik ikut dikembalikan supaya halaman nota bisa memanggil
    // fungsi baca lewat modul yang sama.
    ambilNota: ambilNota,
    antar: antar,
    cadangan: cadangan,
    kuras: kuras,
    bersihkan: bersihkan,
    status: function () {
      return {
        status: st('status') || 'belum',
        antrean: baca().length,
        cadangan: st('cadangan') || null,
        kesalahan: st('kesalahan') || null,
        coba_lagi: st('coba_lagi') || 0,
        ada: !!URL
      };
    },
    // Mengemptysetkan antrean setelah server dipastikan jalan. Dipakai
    // hanya dari halaman pengaturan setelah pengguna menekan tombol
    // "Tersambung".
    konfirmasi: function () {
      st('status', 'selesai');
      try { w.localStorage.removeItem(ANTARE); } catch (e) {}
      antrean = null;
    }
  };

})(window);