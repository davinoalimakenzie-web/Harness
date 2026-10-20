/* ===================================================================
   ronce.js - Kalkulator Ronce, native view di Project Nava.

   Empat tab: Input, Rekap, Servis HP, Setting.
  Tab Log diganti Kalkulator Servis HP. Setiap Mitra punya link
  akses sendiri (?m=ID) + PIN; akses mitra terbatas pada datanya sendiri.
   Data tersimpan di localStorage. Auto-seed Davino Alima PIN 1234.
   =================================================================== */
(function (w) {
  'use strict';

  var KUNCI = 'nava_ronce_v3';
  var KUNCI_SESI = 'nava_ronce_sesi_v3';

  /* ---------------- Default data ---------------- */

  var GARAPAN_AWAL = [
    { id: 'g_minti', name: 'MINTI', price: 10000 },
    { id: 'g_ronce', name: 'RONCE', price: 2000 },
    { id: 'g_keris', name: 'KERIS', price: 2500, isSetEnabled: true, itemsPerSet: 10, pricePerSet: 25000 },
    { id: 'g_blendok', name: 'BLENDOK', price: 5000 }
  ];

  var AKUN_AWAL = [
    { id: 'u_davino', name: 'Davino Alima', role: 'owner', pin: '1234' }
  ];

  /* ---------------- State ---------------- */

  var data = {
    services: null,
    users: null,
    jobs: [],
    transactions: [],
    tasks: [],
    paymentRequests: [],
    bonRequests: [],
    centralBalance: 0,
    log: [],
    bon: { total: 0, remaining: 0, history: [] },
    /* Sinkronisasi antar perangkat: stempel waktu dokumen + tombstone
       supaya item yang dihapus tidak "hidup lagi" saat digabung. */
    updatedAt: '',
    hapus: { users: [], tasks: [], services: [] }
  };

  var sesi = null;
  var layar = 'pilih'; // pilih | pin | app
  var tabAktif = 'input';
  var filter = 'month';
  var selectedMonth = -1;
  var pinTempu = '';
  var pesanPin = '';
  var pilihPin = null;
  /* Garapan selesai yang diceklis mitra untuk diajukan pelunasannya. */
  var terpilih = {};
  /* Tampungan sementara garapan sebelum dikirim ke mitra. */
  var draftJobs = [];
  /* Mitra yang dipilih owner di tab Kasbon (untuk catat BON langsung). */
  var kasbonMitraPick = '';
  /* Rincian pelunasan BON yang menunggu konfirmasi mitra. */
  var bonKonfirmasi = null;

  /* ---------------- Utils ---------------- */

  function $(s) { return w.document.querySelector(s); }
  function esc(t) {
    return String(t === undefined || t === null ? '' : t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function num(v) {
    var s = String(v === undefined || v === null ? '' : v).replace(/[^0-9-]/g, '');
    var n = parseInt(s, 10);
    return isNaN(n) ? 0 : n;
  }
  function uid() {
    return Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
  }
  function hariIni() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function formatIDR(n) {
    try {
      return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(num(n));
    } catch (e) { return 'Rp' + num(n).toLocaleString('id-ID'); }
  }
  function formatTanggal(iso) {
    if (!iso) return '-';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    var bulan = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
    return d.getDate() + ' ' + bulan[d.getMonth()] + ' ' + d.getFullYear();
  }
  function jam(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  /* ---------------- Storage ---------------- */

  function muat() {
    try {
      var d = JSON.parse(w.localStorage.getItem(KUNCI) || 'null');
      if (d && typeof d === 'object') {
        for (var k in data) if (d[k] !== undefined) data[k] = d[k];
      }
    } catch (e) {}
    if (!Array.isArray(data.services) || !data.services.length) {
      data.services = GARAPAN_AWAL.map(function (g) { return JSON.parse(JSON.stringify(g)); });
    }
    if (!Array.isArray(data.users) || !data.users.length) {
      data.users = AKUN_AWAL.map(function (u) { return JSON.parse(JSON.stringify(u)); });
    }
    ['jobs','transactions','tasks','paymentRequests','log'].forEach(function (k) {
      if (!Array.isArray(data[k])) data[k] = [];
    });
    if (!data.bon || typeof data.bon !== 'object') data.bon = { total: 0, remaining: 0, history: [] };
    if (!Array.isArray(data.bon.history)) data.bon.history = [];
    if (typeof data.centralBalance !== 'number') data.centralBalance = 0;
    if (typeof data.updatedAt !== 'string') data.updatedAt = '';
    if (!data.hapus || typeof data.hapus !== 'object') data.hapus = { users: [], tasks: [], services: [] };
    ['users','tasks','services'].forEach(function (k) {
      if (!Array.isArray(data.hapus[k])) data.hapus[k] = [];
    });
    /* Migrasi: user lama belum punya field `aktif`/`wa`. Mitra yang sudah
       punya PIN sendiri (bukan 0000) dianggap sudah aktif. */
    data.users.forEach(function (u) {
      if (u.wa === undefined) u.wa = '';
      if (u.role === 'owner') { u.aktif = true; return; }
      if (u.aktif === undefined) u.aktif = !!(u.pin && String(u.pin) !== '0000');
    });
  }

  function simpan() {
    data.updatedAt = new Date().toISOString();
    try { w.localStorage.setItem(KUNCI, JSON.stringify(data)); } catch (e) {}
    /* Dorong ke server supaya perangkat lain (HP mitra) ikut dapat. */
    try { if (w.RonceSync && w.RonceSync.kirim) w.RonceSync.kirim(); } catch (e) {}
  }

  function catat(teks) {
    data.log.unshift({ teks: teks, waktu: new Date().toISOString() });
    if (data.log.length > 300) data.log.length = 300;
  }

  /* ---------------- Pricing ---------------- */

  function hargaPerSet(s) {
    if (!s) return 0;
    if (s.isSetEnabled) return num(s.pricePerSet || (num(s.price) * (num(s.itemsPerSet) || 10)));
    return num(s.price);
  }
  function feeOtomatis(serviceId, qty) {
    var s = cariGarapan(serviceId), q = num(qty);
    if (!s || q <= 0) return 0;
    if (s.isSetEnabled) return Math.round(q * hargaPerSet(s));
    return Math.round(q * num(s.price));
  }
  function cariGarapan(id) {
    for (var i = 0; i < data.services.length; i++) if (data.services[i].id === id) return data.services[i];
    return null;
  }
  function namaGarapan(id) { var s = cariGarapan(id); return s ? s.name : 'Hapus'; }
  function cariMitra(id) {
    for (var i = 0; i < data.users.length; i++) if (data.users[i].id === id) return data.users[i];
    return null;
  }

  /* ---------------- Akses Mitra ----------------
     Mitra (role 'mitra') hanya melihat datanya sendiri dan tidak boleh
     masuk tab Setting. Owner (Davino) melihat semuanya. */
  var mitraDariLink = null;

  function adalahOwner() { return !!(sesi && sesi.role === 'owner'); }

  /* Baca ID mitra dari link akses (?m=ID) atau start_param Telegram.
     Dipakai untuk login otomatis: buka link -> langsung PIN pad mitra itu. */
  function idMitraDariSumber() {
    try {
      var sp = (w.TG && TG.wa && TG.wa.initDataUnsafe) ? TG.wa.initDataUnsafe.start_param : null;
      if (sp) { var v = String(sp).replace(/^mitra_/, ''); if (v) return v; }
    } catch (e) {}
    try {
      var m = new URLSearchParams(w.location.search).get('m');
      if (m) return m;
    } catch (e) {}
    return null;
  }

  function linkMitra(u) {
    try { return w.location.origin + w.location.pathname + '?m=' + encodeURIComponent(u.id); }
    catch (e) { return '?m=' + u.id; }
  }

  /* Nomor WA Indonesia (08xx / 8xx) -> format internasional 62xx untuk wa.me */
  function waInternasional(wa) {
    var s = String(wa || '').replace(/\D/g, '');
    if (!s) return '';
    if (s.charAt(0) === '0') s = '62' + s.slice(1);
    else if (s.charAt(0) === '8') s = '62' + s;
    return s;
  }

  /* Buka WhatsApp berisi link akses mitra + instruksi ganti PIN. */
  function kirimLinkWa(u) {
    if (!u) return;
    var link = linkMitra(u);
    var NL = String.fromCharCode(10);
    var pesan = [
      'Hai ' + u.name + ',',
      'ini adalah link akses Garapan kamu:',
      link,
      '',
      'Klik link diatas 👆👆👆',
      'Lalu masuk menggunakan Pin default 0000,',
      'Setelah masuk Ubah Pin default untuk aktivasi ya,',
      'terimakasih dan selamat bertugas semoga berkah🤲😊👍'
    ].join(NL);
    var wa = waInternasional(u.wa);
    if (!wa) { w.App.toast('Isi No. WA dulu supaya link bisa dikirim'); return; }
    try {
      w.open('https://wa.me/' + wa + '?text=' + encodeURIComponent(pesan), '_blank');
      w.App.toast('Membuka WhatsApp untuk ' + u.name);
    } catch (e) { w.App.toast('Link: ' + link); }
  }

  function salinLink(id) {
    var u = cariMitra(id);
    if (!u) return;
    var link = linkMitra(u);
    var ok = function () { w.App.toast('Link tersalin — kirim ke ' + u.name); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link).then(ok, function () { salinLinkFallback(link); });
        return;
      }
    } catch (e) {}
    salinLinkFallback(link);
  }

  function salinLinkFallback(link) {
    try {
      var ta = w.document.createElement('textarea');
      ta.value = link; ta.style.position = 'fixed'; ta.style.opacity = '0';
      w.document.body.appendChild(ta); ta.select();
      try { w.document.execCommand('copy'); w.App.toast('Link tersalin'); }
      catch (e) { w.App.toast('Link: ' + link, 5000); }
      w.document.body.removeChild(ta);
    } catch (e) { w.App.toast('Link: ' + link, 5000); }
  }

  /* ---------------- Saldo mitra ---------------- */

  /* Komisi mitra = jasa pekerjaan lama (data.jobs) + garapan yang sudah
     SELESAI (data.tasks). Input Garapan sekarang mengirim TUGAS, jadi tanpa
     ini komisi mitra tidak pernah bertambah. */
  function komisiMitra(id) {
    var k = 0, i;
    for (i = 0; i < data.jobs.length; i++) if (data.jobs[i].employeeId === id) k += num(data.jobs[i].deliveryFee);
    for (i = 0; i < data.tasks.length; i++) {
      var t = data.tasks[i];
      if (t.employeeId === id && t.status === 'completed') k += num(t.deliveryFee);
    }
    return k;
  }
  function saldoMitra(id) {
    var keluar = 0, i;
    for (i = 0; i < data.transactions.length; i++) {
      var t = data.transactions[i];
      if (t.employeeId !== id) continue;
      /* 'bon' = kasbon yang diambil mitra (uang muka dari komisi). */
      if (t.type === 'pelunasan' || t.type === 'penarikan' || t.type === 'bon') keluar += num(t.amount);
    }
    return komisiMitra(id) - keluar;
  }
  function totalKomisiSemua() {
    var t = 0, i;
    for (i = 0; i < data.jobs.length; i++) t += num(data.jobs[i].deliveryFee);
    for (i = 0; i < data.tasks.length; i++) if (data.tasks[i].status === 'completed') t += num(data.tasks[i].deliveryFee);
    return t;
  }
  function rekapMitra() {
    var peta = {}, urutan = [], i, k;
    var sumber = [data.jobs, data.transactions, data.tasks];
    for (i = 0; i < sumber.length; i++) for (k = 0; k < sumber[i].length; k++) {
      var m = sumber[i][k].employeeId;
      if (m && !peta[m]) { peta[m] = 1; urutan.push(m); }
    }
    var hasil = [];
    for (i = 0; i < urutan.length; i++) {
      var id = urutan[i], kerjaan = 0, komisi = 0;
      for (k = 0; k < data.jobs.length; k++) if (data.jobs[k].employeeId === id) kerjaan++;
      for (k = 0; k < data.tasks.length; k++) if (data.tasks[k].employeeId === id && data.tasks[k].status === 'completed') kerjaan++;
      komisi = komisiMitra(id);
      var u = cariMitra(id);
      hasil.push({ id: id, nama: u ? u.name : id, kerjaan: kerjaan, komisi: komisi, saldo: saldoMitra(id) });
    }
    hasil.sort(function (a, b) { return b.saldo - a.saldo; });
    return hasil;
  }

  /* ---------------- BON (Kasbon Mitra) ----------------
     BON = pinjaman dari owner ke mitra. Max 500rb.
     Pelunasan: via jasa garapan (potong komisi) atau cash. */
  var BON_MAX = 500000;

  function bonInfo(mitraId) {
    var total = 0, lunas = 0, i;
    for (i = 0; i < data.transactions.length; i++) {
      var t = data.transactions[i];
      if (t.employeeId !== mitraId) continue;
      if (t.type === 'bon') total += num(t.amount);
      else if (t.type === 'bon_lunas') lunas += num(t.amount);
    }
    return { total: total, lunas: lunas, remaining: Math.max(0, total - lunas) };
  }

  /* Mitra MENGAJUKAN BON (tidak langsung dicatat) — owner yang menyetujui
     lewat tab Kasbon. Alur: ajukan -> diajukan -> disetujui/ditolak. */
  function ajukanBon(mitraId, amount) {
    var u = cariMitra(mitraId);
    if (!u) return;
    if (amount <= 0) { w.App.toast('Nominal tidak valid'); return; }
    var info = bonInfo(mitraId);
    var tertahan = (data.bonRequests || []).filter(function (r) {
      return r.employeeId === mitraId && r.status === 'diajukan';
    }).reduce(function (s, r) { return s + num(r.amount); }, 0);
    if (info.total + tertahan + amount > BON_MAX) {
      w.App.toast('Maksimal BON ' + formatIDR(BON_MAX));
      return;
    }
    data.bonRequests.push({
      id: uid(), employeeId: mitraId, employeeName: u.name,
      amount: amount, date: hariIni(), status: 'diajukan',
      createdAt: new Date().toISOString()
    });
    catat('Pengajuan BON ' + formatIDR(amount) + ' oleh ' + u.name);
    simpan();
    w.App.toast('Pengajuan BON terkirim ke owner');
  }

  /* Owner mencatat BON langsung (kasbon tunai diserahkan tanpa pengajuan). */
  function catatBonLangsung(mitraId, amount) {
    var u = cariMitra(mitraId);
    if (!u) return;
    if (amount <= 0) { w.App.toast('Nominal tidak valid'); return; }
    var info = bonInfo(mitraId);
    if (info.total + amount > BON_MAX) {
      w.App.toast('Maksimal BON ' + formatIDR(BON_MAX));
      return;
    }
    data.transactions.push({
      id: uid(), employeeId: mitraId, type: 'bon', amount: amount,
      date: hariIni(), note: 'BON dicatat owner', createdAt: new Date().toISOString()
    });
    catat('BON ' + formatIDR(amount) + ' dicatat untuk ' + u.name);
    simpan();
    w.App.toast('BON ' + formatIDR(amount) + ' dicatat');
  }

  function cariBonReq(id) {
    var arr = data.bonRequests || [];
    for (var i = 0; i < arr.length; i++) { if (arr[i].id === id) return arr[i]; }
    return null;
  }

  /* Owner MENYETUJUI pengajuan BON -> baru dicatat sebagai transaksi 'bon'. */
  function setujuiBon(id) {
    if (!adalahOwner()) return;
    var r = cariBonReq(id);
    if (!r || r.status !== 'diajukan') return;
    var info = bonInfo(r.employeeId);
    if (info.total + num(r.amount) > BON_MAX) {
      w.App.toast('Melebihi batas BON ' + formatIDR(BON_MAX));
      return;
    }
    data.transactions.push({
      id: uid(), employeeId: r.employeeId, type: 'bon', amount: num(r.amount),
      date: hariIni(), note: 'BON disetujui owner', createdAt: new Date().toISOString()
    });
    r.status = 'disetujui';
    r._u = new Date().toISOString();
    catat('BON ' + formatIDR(r.amount) + ' disetujui untuk ' + r.employeeName);
    simpan();
    w.App.toast('BON ' + formatIDR(r.amount) + ' disetujui');
    renderKasbon();
  }

  function tolakBon(id) {
    if (!adalahOwner()) return;
    var r = cariBonReq(id);
    if (!r || r.status !== 'diajukan') return;
    r.status = 'ditolak';
    r._u = new Date().toISOString();
    catat('Pengajuan BON ' + formatIDR(r.amount) + ' ditolak (' + r.employeeName + ')');
    simpan();
    w.App.toast('Pengajuan BON ditolak');
    renderKasbon();
  }

  function lunasiBon(mitraId, amount, mode, taskIds) {
    var u = cariMitra(mitraId);
    if (!u) return;
    var info = bonInfo(mitraId);
    if (amount > info.remaining) amount = info.remaining;
    if (amount <= 0) { w.App.toast('BON sudah lunas'); return; }
    data.transactions.push({
      id: uid(), employeeId: mitraId, type: 'bon_lunas', amount: amount,
      taskIds: taskIds || [],
      date: hariIni(), note: mode === 'jasa' ? 'Pelunasan BON via jasa garapan' : 'Pelunasan BON cash',
      createdAt: new Date().toISOString()
    });
    /* Bayar via JASA: potong komisi mitra (saldo ikut berkurang). */
    if (mode === 'jasa') {
      data.transactions.push({
        id: uid(), employeeId: mitraId, type: 'pelunasan', amount: amount,
        date: hariIni(), note: 'Potong jasa untuk BON', createdAt: new Date().toISOString()
      });
    }
    catat('Pelunasan BON ' + formatIDR(amount) + ' (' + mode + ') untuk ' + u.name);
    simpan();
    w.App.toast('BON lunas ' + formatIDR(amount));
  }

  /* Pelunasan BON dari JASA: pakai garapan selesai yang diceklis.
     pakaiCash=true -> sisa BON langsung dibayar cash (BON lunas).
     pakaiCash=false -> dicicil: hanya bagian jasa yang dilunasi sekarang.

     Alur dibuat DUA LANGKAH supaya tidak terasa "kepencet lalu hilang":
     (1) siapkanBonSettle() hanya MENYIAPKAN rincian + menampilkan kartu
         konfirmasi; (2) jalankanBonSettle() baru benar-benar mencatat. */
  function siapkanBonSettle(mitraId, pakaiCash) {
    var info = bonInfo(mitraId);
    if (info.remaining <= 0) { w.App.toast('BON sudah lunas'); return; }
    var d = bonSettleNilai();
    /* "Cicil Dulu" butuh jasa terceklis; "Bayar Sisa via Cash" tetap jalan
       walau tidak ada garapan (sisa dibayar penuh cash). */
    if (!pakaiCash && d.nilai <= 0) { w.App.toast('Ceklis garapan yang mau dipakai'); return; }
    var dipakaiNilai = Math.min(d.nilai, info.remaining);
    var sisa = Math.max(0, info.remaining - dipakaiNilai);
    var cash = pakaiCash ? sisa : 0;
    bonKonfirmasi = {
      mitraId: mitraId, mode: pakaiCash ? 'cash' : 'cicil',
      dipakai: d.dipakai, nilai: dipakaiNilai, cash: cash, sisa: sisa
    };
    renderKasbon();
  }

  function batalBonSettle() {
    bonKonfirmasi = null;
    renderKasbon();
  }

  function jalankanBonSettle() {
    if (!bonKonfirmasi) return;
    var k = bonKonfirmasi;
    bonKonfirmasi = null;
    if (k.nilai > 0) lunasiBon(k.mitraId, k.nilai, 'jasa', k.dipakai.map(function (x) { return x.id; }));
    if (k.cash > 0) lunasiBon(k.mitraId, k.cash, 'cash');
    w.App.toast(k.mode === 'cash'
      ? 'BON lunas — jasa ' + formatIDR(k.nilai) + ' + cash ' + formatIDR(k.cash)
      : 'Dicicil ' + formatIDR(k.nilai) + ' — sisa ' + formatIDR(bonInfo(k.mitraId).remaining));
    renderKasbon();
  }

  /* Baca ceklis + nominal yang DIEDIT mitra. Nilai tiap baris tidak boleh
     melebihi jasa garapan itu sendiri. */
  function bonSettleNilai() {
    var cek = document.querySelectorAll('#bonSettleList .bon-pilih');
    var dipakai = [], nilai = 0;
    for (var i = 0; i < cek.length; i++) {
      var c = cek[i];
      if (!c.checked) continue;
      var t = cariTugas(c.dataset.pid);
      if (!t) continue;
      var max = num(t.deliveryFee);
      var inp = document.querySelector('#bonSettleList .bon-row-inp[data-pid="' + c.dataset.pid + '"]');
      var v = num(inp ? inp.value : max);
      if (v > max) v = max;
      if (v <= 0) continue;
      dipakai.push({ id: t.id, nilai: v });
      nilai += v;
    }
    return { dipakai: dipakai, nilai: nilai };
  }

  /* Nominal BON di input dalam kartu BON tempat tombol itu berada. */
  function nomorBonDari(btn) {
    var root = btn.closest('#ronceBonMitra') || btn.closest('#ronceBonSection');
    var inp = root ? root.querySelector('.bon-amt') : null;
    return num(inp ? inp.value : '');
  }

  /* Kartu BON (kasbon mitra).
     MITRA: ajukan BON (menunggu persetujuan owner) + pelunasan via jasa
     (garapan selesai otomatis terceklis, ada perhitungan sisa BON) atau cash.
     OWNER: catat BON langsung untuk mitra terpilih. */
  function renderBon(mitraId, isMitra) {
    var el = isMitra ? $('#ronceBonMitra') : $('#ronceBonSection');
    if (!el) return;
    if (!mitraId) { el.innerHTML = '<div class="empty">Pilih mitra untuk melihat BON.</div>'; return; }
    var info = bonInfo(mitraId);
    var u = cariMitra(mitraId);
    var h = '<div class="card"><div class="list-head tight"><strong>BON (Kasbon)</strong></div>'
      + '<div class="item"><div class="item-body"><div class="item-title">' + esc(u ? u.name : '') + '</div>'
      + '<div class="item-sub"><span>Sisa BON <b>' + formatIDR(info.remaining) + '</b></span>'
      + '<span>Maks ' + formatIDR(BON_MAX) + '</span></div></div></div>'
      + '<div class="mitra-add"><input type="number" class="bon-amt" placeholder="Nominal BON">'
      + '<button class="btn primary" data-bon-ajukan="' + esc(mitraId) + '">'
      + (isMitra ? 'Ajukan BON' : 'Catat BON') + '</button></div>';

    /* Panel pelunasan via jasa (khusus mitra, hanya kalau masih ada sisa BON). */
    if (isMitra && info.remaining > 0) {
      var done = (data.tasks || []).filter(function (t) {
        return t.employeeId === mitraId && t.status === 'completed' && !sudahLunas(t);
      });
      h += '<div class="bon-settle"><div class="list-head tight"><strong>Pelunasan BON via Jasa</strong></div>';
      if (done.length) {
        h += '<p class="hint xs">Garapan selesai otomatis terceklis. Buka ceklis yang tidak mau dipakai, '
          + 'atau ubah nominal yang mau dipotong (maks sesuai jasa).</p>'
          + '<div id="bonSettleList" class="list">'
          + done.map(function (t) {
              return '<label class="bon-row">'
                + '<input type="checkbox" class="bon-pilih" data-pid="' + esc(t.id) + '" checked>'
                + '<span class="bon-row-info"><b>' + esc(namaGarapan(t.serviceId)) + ' x' + t.quantity + '</b>'
                + '<i>' + formatTanggal(t.date) + ' &middot; jasa ' + formatIDR(t.deliveryFee) + '</i></span>'
                + '<input type="number" class="bon-row-inp" data-pid="' + esc(t.id) + '"'
                +   ' value="' + num(t.deliveryFee) + '" inputmode="numeric" aria-label="Nominal dipotong">'
                + '</label>';
            }).join('')
          + '</div>';
      } else {
        h += '<p class="hint xs">Belum ada garapan selesai yang bisa dipakai melunasi BON. '
          + 'Sisa BON masih bisa dibayar cash.</p><div id="bonSettleList" class="list"></div>';
      }
      h += '<div class="bon-calc">'
        + '<div class="bon-calc-row"><span>Total BON</span><b id="bonCalcTotal">' + formatIDR(info.remaining) + '</b></div>'
        + '<div class="bon-calc-row"><span>Total jasa terceklis</span><b id="bonCalcJasa">Rp0</b></div>'
        + '<div class="bon-calc-row total"><span>Sisa BON</span><b id="bonCalcSisa">' + formatIDR(info.remaining) + '</b></div>'
        + '</div>';

      /* Kartu konfirmasi: pelunasan TIDAK langsung dieksekusi. */
      if (bonKonfirmasi && bonKonfirmasi.mitraId === mitraId) {
        var k = bonKonfirmasi;
        h += '<div class="bon-confirm">'
          + '<div class="bon-confirm-head">⚠️ Periksa dulu sebelum dicatat</div>'
          + '<div class="bon-confirm-body">'
          + '<div class="bon-calc-row"><span>Dipotong dari jasa</span><b>' + formatIDR(k.nilai) + '</b></div>'
          + (k.mode === 'cash'
              ? '<div class="bon-calc-row"><span>Dibayar cash</span><b>' + formatIDR(k.cash) + '</b></div>'
              : '')
          + '<div class="bon-calc-row total"><span>Sisa BON setelah ini</span><b>'
          +   formatIDR(k.mode === 'cash' ? 0 : k.sisa) + '</b></div>'
          + '</div>'
          + '<div class="bon-confirm-acts">'
          + '<button class="btn primary" data-bon-yakin="1">Ya, Catat Sekarang</button>'
          + '<button class="btn ghost" data-bon-batal="1">Batal</button>'
          + '</div>'
          + '<p class="hint xs">Setelah dicatat, pelunasan masuk ke rekap owner dan tidak bisa dibatalkan dari sini.</p>'
          + '</div>';
      } else {
        h += '<div class="row-2 mt">'
          + '<button class="btn primary" data-bon-cashjasa="' + esc(mitraId) + '">Bayar Sisa via Cash</button>'
          + '<button class="btn ghost" data-bon-cicil="' + esc(mitraId) + '">Cicil Dulu</button>'
          + '</div>'
          + '<p class="hint xs" style="margin-top:8px">Cicil = hanya jasa terceklis yang dipotong sekarang; sisanya tetap jadi BON.</p>';
      }
      h += '</div>';
    }
    h += '</div>';

    var hist = [];
    for (var i = 0; i < data.transactions.length; i++) {
      var t = data.transactions[i];
      if (t.employeeId === mitraId && (t.type === 'bon' || t.type === 'bon_lunas')) hist.push(t);
    }
    if (hist.length) {
      h += '<div class="mt-head"><strong>RIWAYAT BON</strong></div>';
      hist.slice().reverse().forEach(function (t) {
        var ambil = t.type === 'bon';
        h += '<div class="mt-pay ' + (ambil ? 'wait' : 'ok') + '">'
          + '<div class="mt-pay-l"><b>' + (ambil ? 'BON' : 'LUNAS BON') + ' ' + formatIDR(t.amount) + '</b>'
          + '<span>' + formatTanggal(t.date) + (t.note ? ' &middot; ' + esc(t.note) : '') + '</span></div>'
          + '<span class="mt-tag ' + (ambil ? 'tunggu' : 'done') + '">' + (ambil ? 'BON' : 'LUNAS') + '</span></div>';
      });
    }

    /* Riwayat pengajuan BON mitra ini. */
    var reqs = (data.bonRequests || []).filter(function (r) { return r.employeeId === mitraId; });
    if (reqs.length) {
      h += '<div class="mt-head"><strong>PENGAJUAN BON</strong></div>';
      reqs.slice().reverse().forEach(function (r) {
        var st = r.status;
        var tag = st === 'disetujui' ? '<span class="mt-tag done">DISETUJUI</span>'
          : st === 'ditolak' ? '<span class="mt-tag">DITOLAK</span>'
          : '<span class="mt-tag tunggu">MENUNGGU</span>';
        h += '<div class="mt-pay ' + (st === 'disetujui' ? 'ok' : 'wait') + '">'
          + '<div class="mt-pay-l"><b>Pengajuan ' + formatIDR(r.amount) + '</b>'
          + '<span>' + formatTanggal(r.date) + '</span></div>' + tag + '</div>';
      });
    }
    el.innerHTML = h;

    if (isMitra && info.remaining > 0) hitungBonSettle(mitraId);
  }

  /* Hitung ulang Total BON - jasa terceklis = sisa BON (dipanggil saat
     ceklis atau nominal diubah, dan saat kartu BON baru digambar). */
  function hitungBonSettle(mitraId) {
    var info = bonInfo(mitraId);
    var d = bonSettleNilai();
    var total = d.nilai;
    var dipakai = Math.min(total, info.remaining);
    var sisa = Math.max(0, info.remaining - dipakai);
    var set = function (sel, v) { var e = $(sel); if (e) e.textContent = v; };
    set('#bonCalcTotal', formatIDR(info.remaining));
    set('#bonCalcJasa', formatIDR(total));
    set('#bonCalcSisa', formatIDR(sisa));
  }

  /* ---------------- Periode filter ---------------- */

  var BULAN = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
  function dalamPeriode(iso) {
    if (!iso) return true;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return true;
    var now = new Date();
    if (filter === 'today') return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    if (filter === 'week') {
      var hari = d.getDay(); if (hari === 0) hari = 7;
      var nowHari = now.getDay(); if (nowHari === 0) nowHari = 7;
      var dSenin = new Date(d); dSenin.setDate(d.getDate() - (hari - 1));
      var nSenin = new Date(now); nSenin.setDate(now.getDate() - (nowHari - 1));
      return dSenin.getTime() === nSenin.getTime();
    }
    if (filter === 'month') return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();

    return true;
  }

  /* Pelunasan/cicil manual dari owner DIHAPUS — pembayaran mitra mengalir
     lewat pengajuan (payment request) + BON di tab Rekap. */

  /* ---------------- Option builders ---------------- */

  /* hanyaAktif = true: hanya mitra yang sudah ganti PIN (aktif) yang muncul.
     Dipakai di tab Input supaya mitra belum aktif tidak bisa diberi tugas. */
  function optsMitra(hanyaAktif) {
    var h = '<option value="">-- Pilih Mitra --</option>', i;
    for (i = 0; i < data.users.length; i++) {
      var u = data.users[i];
      if (u.role === 'owner') continue;   /* owner bukan penerima tugas */
      if (hanyaAktif && !u.aktif) continue;
      h += '<option value="' + esc(u.id) + '">' + esc(u.name) +
        (u.aktif ? '' : ' (belum aktif)') + '</option>';
    }
    return h;
  }
  function optsGarapan() {
    var h = '<option value="">-- Pilih Garapan --</option>', i;
    for (i = 0; i < data.services.length; i++) {
      var g = data.services[i];
      var harga = g.isSetEnabled ? hargaPerSet(g) : num(g.price);
      h += '<option value="' + esc(g.id) + '">' + esc(g.name) + ' (' + formatIDR(harga) + ')' + (g.isSetEnabled ? ' / Set' : '') + '</option>';
    }
    return h;
  }

  /* ---------------- Login / PIN ---------------- */

  function renderLogin() {
    var list = $('#ronceUserList');
    if (!list) return;
    /* Link akses per-mitra: buka link -> langsung PIN pad mitra itu,
       tanpa harus memilih dari daftar. */
    if (mitraDariLink) {
      var u = cariMitra(mitraDariLink);
      if (u) { pilihPin = u; layar = 'pin'; renderPin(); return; }
      /* Akun belum ketemu — biasanya karena data mitra belum tersinkron ke
         perangkat ini (HP mitra masih baru). Tampilkan status menunggu,
         JANGAN lempar mitra ke daftar akun Project Nava. */
      list.innerHTML = '<div class="empty"><b>Menghubungkan ke akun mitra…</b>'
        + 'Sedang menyinkronkan data dari server. Tunggu sebentar ya.</div>';
      if (!renderLogin._t) {
        renderLogin._t = w.setTimeout(function () {
          renderLogin._t = null;
          if (!mitraDariLink || cariMitra(mitraDariLink)) return;
          var l2 = $('#ronceUserList');
          if (l2) {
            l2.innerHTML = '<div class="empty"><b>Akun mitra belum tersedia</b>'
              + 'Data belum tersinkron ke perangkat ini. Pastikan perangkat terhubung internet, '
              + 'lalu minta owner membuka aplikasi sebentar supaya data terkirim.</div>';
          }
        }, 10000);
      }
      return;
    }
    var h = '';
    for (var i = 0; i < data.users.length; i++) {
      var u = data.users[i];
      h += '<button class="btn ghost block" data-ruser="' + esc(u.id) + '" style="text-align:left;padding:12px 14px">'
        + '<span style="display:inline-flex;width:32px;height:32px;border-radius:50%;background:var(--tap);place-items:center;margin-right:10px;font-weight:700;font-size:13px;vertical-align:middle">'
        + esc(u.name.slice(0,2).toUpperCase()) + '</span>'
        + '<span style="vertical-align:middle"><b>' + esc(u.name) + '</b> <span class="muted" style="font-size:12px">(' + esc(u.role) + ')</span></span></button>';
    }
    list.innerHTML = h;
  }

  function pilihUser(id) {
    pilihPin = cariMitra(id);
    if (!pilihPin) return;
    pinTempu = ''; pesanPin = '';
    layar = 'pin';
    renderPin();
  }

  function renderPin() {
    var u = pilihPin || {};
    var avatar = $('#roncePinAvatar'), name = $('#roncePinName'), role = $('#roncePinRole');
    if (avatar) avatar.textContent = String(u.name || '?').slice(0, 2).toUpperCase();
    if (name) name.textContent = u.name || '';
    if (role) role.textContent = u.role || '';
    updatePinDots();
    var err = $('#roncePinError'); if (err) err.textContent = pesanPin;
    $('#ronceLogin').style.display = '';
    $('#ronceUserList').parentElement.style.display = 'none';
    $('#roncePinPad').hidden = false;
  }

  function updatePinDots() {
    var dots = document.querySelectorAll('.ronce-pin-dot');
    dots.forEach(function (d, i) {
      d.style.width = '14px'; d.style.height = '14px'; d.style.borderRadius = '50%';
      d.style.background = i < pinTempu.length ? 'var(--accent)' : 'var(--line)';
      d.style.display = 'inline-block';
    });
  }

  function ketikPin(k) {
    if (k === 'clear') { pinTempu = ''; pesanPin = ''; updatePinDots(); return; }
    if (k === 'del') { pinTempu = pinTempu.slice(0, -1); updatePinDots(); return; }
    pinTempu += k;
    if (pinTempu.length > 4) pinTempu = pinTempu.slice(-4);
    updatePinDots();
    if (pinTempu.length === 4) {
      if (pinTempu === String((pilihPin || {}).pin)) {
        sesi = pilihPin;
        try { w.localStorage.setItem(KUNCI_SESI, sesi.id); } catch (e) {}
        pinTempu = ''; pesanPin = '';
        layar = 'app';
        showApp();
      } else {
        pinTempu = ''; pesanPin = 'PIN salah, coba lagi.';
        updatePinDots();
      }
    }
  }

  function showApp() {
    $('#ronceLogin').style.display = 'none';
    $('#ronceApp').hidden = false;
    renderTab();
  }

  function showLogin() {
    layar = 'pilih';
    sesi = null;
    /* Setelah logout, reset pilihan dari link supaya daftar akun tampil
       penuh lagi — kalau tidak, owner tidak bisa masuk dan malah "terkunci"
       di PIN pad mitra yang barusan keluar. */
    mitraDariLink = null;
    try { w.localStorage.removeItem(KUNCI_SESI); } catch (e) {}
    $('#ronceApp').hidden = true;
    $('#ronceLogin').style.display = '';
    $('#ronceUserList').parentElement.style.display = '';
    $('#roncePinPad').hidden = true;
    renderLogin();
  }

  function logout() {
    showLogin();
  }

  /* ---------------- Tab rendering ---------------- */

  function renderTab() {
    if (!sesi) { showLogin(); return; }
    var own = adalahOwner();
    /* Normalisasi tabAktif DULU, sebelum tombol di-highlight — kalau tidak,
       tombol lama tetap tampak aktif padahal isinya sudah tab lain. */
    if (!own) {
      if (tabAktif === 'input' || tabAktif === 'servis') tabAktif = 'tugas';
    } else if (tabAktif === 'tugas') {
      tabAktif = 'input';
    }
    var bar = $('#ronceTabs');
    if (bar) bar.style.display = '';
    document.querySelectorAll('#ronceTabs .seg-btn').forEach(function (b) {
      var t = b.dataset.rtab;
      /* Owner: Input | Rekap | Kasbon | Servis HP | Setting.
         Mitra: Dashboard | Rekap | Kasbon | Setting (tab lain disembunyikan). */
      var show = own
        ? (t !== 'tugas')
        : (t === 'tugas' || t === 'rekap' || t === 'kasbon' || t === 'setting');
      b.style.display = show ? '' : 'none';
      if (t === 'tugas') b.textContent = 'Dashboard';
      b.classList.toggle('active', t === tabAktif);
    });
    /* SEMUA tab (termasuk 'tugas') dikelola di satu loop. Sebelumnya
       #ronceTab-tugas hanya disembunyikan untuk owner, sehingga untuk mitra
       dashboard (Total Jasa Kamu + Akun Saya) ikut tampil di tab Rekap/Kasbon. */
    var tabs = ['input','rekap','servis','setting','kasbon','tugas'];
    /* Konfirmasi pelunasan BON tidak boleh "nyangkut" saat pindah tab. */
    if (tabAktif !== 'kasbon') bonKonfirmasi = null;
    tabs.forEach(function (t) {
      var el = $('#ronceTab-' + t);
      if (el) el.hidden = (t !== tabAktif);
    });
    if (tabAktif === 'input') renderInput();
    else if (tabAktif === 'tugas') renderTugasMitra();
    else if (tabAktif === 'rekap') renderRekap();
    else if (tabAktif === 'servis') renderServis();
    else if (tabAktif === 'kasbon') renderKasbon();
    else renderSetting();
  }

  /* ---------------- Tab: Servis HP ----------------
     Kalkulator Servis HP kini hidup di dalam Kalkulator Ronce (menggantikan
     tab Log). Cukup gambar ulang daftar harganya; seluruh logika kalkulator
     ada di calc.js. */
  function renderServis() {
    if (w.CalcUI && w.CalcUI.renderList) w.CalcUI.renderList();
  }

  /* ---------------- Tab: Input ---------------- */

  function renderInput() {
    renderAkun();
    var m = $('#rjMitra'), g = $('#rjGarapan');
    if (m) m.innerHTML = optsMitra(true);
    if (g) g.innerHTML = optsGarapan();

    /* Ringkasan & daftar: HANYA garapan yang masih PROSES dan yang sudah
       TITIP BAYAR (selesai tapi belum dilunasi). Pelunasan & cicil
       pelunasan dilakukan di tab Rekap. */
    var tasks = data.tasks.slice().sort(function (a, b) {
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });
    var proses = tasks.filter(function (t) { return t.status === 'terkirim' || t.status === 'pending'; });
    var titip = tasks.filter(function (t) { return t.status === 'completed' && !sudahLunas(t); });
    var jml = function (a) { return a.reduce(function (s, t) { return s + num(t.deliveryFee); }, 0); };
    var set = function (sel, v) { var e = $(sel); if (e) e.textContent = v; };
    set('#rjProsesTotal', formatIDR(jml(proses)));
    set('#rjProsesCount', proses.length + ' garapan');
    set('#rjTitipTotal', formatIDR(jml(titip)));
    set('#rjTitipCount', titip.length + ' garapan');

    var h = $('#rjHistory');
    if (!h) return;
    var tampil = proses.concat(titip);
    if (!tampil.length) { h.innerHTML = '<div class="empty">Belum ada garapan berjalan</div>'; return; }
    h.innerHTML = tampil.map(function (t) { return rjRow(t); }).join('');
    renderDraft();
  }

  /* Satu baris garapan di tab Input (owner). */
  function rjRow(t) {
    var s = cariGarapan(t.serviceId);
    var set = s && s.isSetEnabled;
    var selesai = t.status === 'completed';
    return '<div class="mt-row' + (selesai ? ' done' : '') + '">'
      + '<div class="mt-row-top">'
      +   '<span class="mt-row-nama">' + esc(namaGarapan(t.serviceId)) + '</span>'
      +   '<span class="mt-tag ' + (selesai ? 'titip' : 'proses') + '">' + (selesai ? 'TITIP BAYAR' : 'TERKIRIM') + '</span>'
      + '</div>'
      + '<div class="mt-row-mid">' + esc(t.employeeName) + ' &middot; ' + t.quantity + (set ? ' Set' : ' pcs') + ' &middot; ' + formatTanggal(t.date) + '</div>'
      + (t.note ? '<div class="mt-row-note">Catatan: ' + esc(t.note) + '</div>' : '')
      + '<div class="mt-row-bottom">'
      +   '<span class="mt-row-jasa">' + formatIDR(t.deliveryFee) + '</span>'
      +   '<span class="mt-row-ok">' + (selesai ? 'Menunggu pelunasan di Rekap' : 'Menunggu laporan mitra') + '</span>'
      + '</div>'
      + '</div>';
  }

  /* Garapan LUNAS = id-nya ada di pengajuan yang sudah dibayar, ATAU
     dipakai untuk melunasi BON (transaksi bon_lunas menyimpan taskIds). */
  function sudahLunas(t) {
    var reqs = data.paymentRequests || [];
    for (var i = 0; i < reqs.length; i++) {
      var r = reqs[i];
      if (r.status !== 'dibayar' || !r.taskIds) continue;
      if (r.taskIds.indexOf(t.id) >= 0) return true;
    }
    var txs = data.transactions || [];
    for (var j = 0; j < txs.length; j++) {
      var x = txs[j];
      if (x.type !== 'bon_lunas' || !x.taskIds) continue;
      if (x.taskIds.indexOf(t.id) >= 0) return true;
    }
    return false;
  }

  /* Garapan yang sudah masuk pengajuan tapi belum dibayar. */
  function sudahDiajukan(tid) {
    var reqs = data.paymentRequests || [];
    for (var i = 0; i < reqs.length; i++) {
      if (reqs[i].status === 'dibayar' || !reqs[i].taskIds) continue;
      if (reqs[i].taskIds.indexOf(tid) >= 0) return true;
    }
    return false;
  }

  function cariTugas(id) {
    for (var i = 0; i < data.tasks.length; i++) if (data.tasks[i].id === id) return data.tasks[i];
    return null;
  }

  /* ---------------- Tab: Tugas ---------------- */



  /* ---------------- Dashboard Mitra (tab Tugas, tampilan mitra) ----------------
     Satu layar saja: ringkasan jasa + tabel garapan proses/selesai +
     pengajuan pembayaran + laporan pelunasan. Semua angka dihitung dari
     data.tasks (jasa per garapan) dan data.transactions (pelunasan). */
  function mtRow(t, selesai) {
    var s = cariGarapan(t.serviceId);
    var set = s && s.isSetEnabled;
    /* Garapan selesai dapat CEKLIS untuk diajukan pelunasannya. */
    var cek = selesai
      ? '<label class="mt-cek"><input type="checkbox" class="mt-pilih" data-pid="' + esc(t.id) + '"' + (terpilih[t.id] ? ' checked' : '') + '></label>'
      : '';
    return '<div class="mt-row' + (selesai ? ' done' : '') + '">'
      + '<div class="mt-row-top">'
      +   '<span class="mt-row-nama">' + esc(namaGarapan(t.serviceId)) + '</span>'
      +   '<span class="mt-tag ' + (selesai ? 'done' : 'proses') + '">' + (selesai ? 'SELESAI' : 'PROSES') + '</span>'
      + '</div>'
      + '<div class="mt-row-mid">' + t.quantity + (set ? ' Set' : ' pcs') + ' &middot; ' + formatTanggal(t.date) + '</div>'
      + (t.note ? '<div class="mt-row-note">Catatan: ' + esc(t.note) + '</div>' : '')
      + '<div class="mt-row-bottom">'
      +   '<span class="mt-row-jasa">' + formatIDR(t.deliveryFee) + '</span>'
      +   (selesai
          ? cek
          : '<button class="mt-btn-done" data-rt-done="' + esc(t.id) + '">&#10003; LAPOR SELESAI</button>')
      + '</div>'
      + '</div>';
  }

  function mtHitung() {
    var id = sesi ? sesi.id : '';
    var tasks = data.tasks.filter(function (t) { return t.employeeId === id; });
    var proses = tasks.filter(function (t) { return t.status !== 'completed'; });
    var done = tasks.filter(function (t) { return t.status === 'completed'; });
    var jml = function (a) { return a.reduce(function (s, t) { return s + num(t.deliveryFee); }, 0); };
    var jasaProses = jml(proses), jasaDone = jml(done);
    var dibayar = data.transactions.filter(function (x) {
      return x.employeeId === id && x.type === 'pelunasan';
    }).reduce(function (s, x) { return s + num(x.amount); }, 0);
    var diajukan = data.paymentRequests.filter(function (r) {
      return r.employeeId === id && r.status !== 'dibayar';
    }).reduce(function (s, r) { return s + num(r.amount); }, 0);
    var tunggu = Math.max(0, jasaDone - dibayar);
    return {
      proses: proses, done: done, jasaProses: jasaProses, jasaDone: jasaDone,
      dibayar: dibayar, tunggu: tunggu, bisaAjukan: Math.max(0, tunggu - diajukan)
    };
  }

  function renderTugasMitra() {
    if (!sesi) return;
    var id = sesi.id;
    var tasks = data.tasks.filter(function (t) { return t.employeeId === id; });
    var proses = tasks.filter(function (t) { return t.status !== 'completed'; });
    var done = tasks.filter(function (t) { return t.status === 'completed'; });
    var jml = function (a) { return a.reduce(function (s, t) { return s + num(t.deliveryFee); }, 0); };

    var set = function (sel, v) { var e = $(sel); if (e) e.textContent = v; };
    set('#mtTotalJasa', formatIDR(jml(proses)));
    set('#mtCntProses', proses.length);
    set('#mtCntDone', done.length);

    /* Kasbon (BON) yang masih berjalan ditampilkan di dalam kartu Total Jasa. */
    var info = bonInfo(id);
    var kb = $('#mtHeroKasbon');
    if (kb) {
      kb.hidden = info.remaining <= 0;
      set('#mtKasbonBerjalan', formatIDR(info.remaining));
    }

    /* Dashboard = HANYA tugas yang sedang berjalan (tugas baru). Garapan
       selesai & pengajuan pembayaran ada di tab Rekap. */
    var lp = $('#mtListProses');
    if (lp) lp.innerHTML = proses.length
      ? proses.map(function (t) { return mtRow(t, false); }).join('')
      : '<div class="mt-empty">Tidak ada garapan yang sedang dikerjakan</div>';
  }

  /* Mitra mengajukan pelunasan untuk garapan selesai yang DICEKLIS.
     Hanya yang memenuhi syarat (min. 1 minggu / Rp200rb) yang ikut. */
  function ajukanPembayaran() {
    if (!sesi || sesi.role === 'owner') return;
    var cek = document.querySelectorAll('.mt-pilih:checked');
    if (!cek.length) { w.App.toast('Ceklis dulu garapan yang mau diajukan'); return; }
    var ids = [];
    for (var i = 0; i < cek.length; i++) ids.push(cek[i].dataset.pid);
    var eligible = [];
    for (var j = 0; j < ids.length; j++) {
      var t = cariTugas(ids[j]);
      /* Syarat lama (1 minggu / Rp200rb) TIDAK lagi memblokir pengajuan. */
      if (t && t.status === 'completed' && !sudahLunas(t) && !sudahDiajukan(t.id)) eligible.push(t);
    }
    if (!eligible.length) { w.App.toast('Belum ada garapan yang bisa diajukan'); return; }
    var totalAjukan = eligible.reduce(function (s, t) { return s + num(t.deliveryFee); }, 0);
    data.paymentRequests.push({
      id: uid(), employeeId: sesi.id, employeeName: sesi.name,
      amount: totalAjukan, taskIds: eligible.map(function (t) { return t.id; }),
      date: hariIni(), status: 'diajukan',
      createdAt: new Date().toISOString()
    });
    eligible.forEach(function (t) { delete terpilih[t.id]; });
    catat('Pengajuan pelunasan ' + formatIDR(totalAjukan) + ' oleh ' + sesi.name);
    simpan();
    w.App.toast('Pengajuan terkirim ke owner');
    renderRekapMitra();
  }

  /* Owner menandai pengajuan mitra sudah dibayar -> tercatat sebagai pelunasan
     supaya angka "Sudah dibayar" di dashboard mitra ikut naik. */
  function bayarPengajuan(id) {
    if (!adalahOwner()) return;
    var r = null;
    for (var i = 0; i < data.paymentRequests.length; i++) {
      if (data.paymentRequests[i].id === id) r = data.paymentRequests[i];
    }
    if (!r) return;
    if (r.status === 'dibayar') { w.App.toast('Pengajuan ini sudah dibayar'); return; }
    if (!w.confirm('Tandai pengajuan ' + formatIDR(r.amount) + ' dari ' + r.employeeName + ' sudah dibayar?')) return;
    data.transactions.push({
      id: uid(), employeeId: r.employeeId, type: 'pelunasan', amount: num(r.amount),
      date: hariIni(), note: 'Pelunasan pengajuan ' + formatTanggal(r.date),
      createdAt: new Date().toISOString()
    });
    r.status = 'dibayar';
    r.paidAt = new Date().toISOString();
    r._u = new Date().toISOString();
    catat('Pengajuan ' + formatIDR(r.amount) + ' dari ' + r.employeeName + ' dibayar');
    simpan();
    w.App.toast('Ditandai sudah dibayar');
    renderRekap();
  }

  /* ---------------- Tab: Rekap ---------------- */

  var selectedMitraFilter = '';

  function isEligibleForPayment(t) {
    if (t.status !== 'completed') return false;
    var val = num(t.deliveryFee);
    if (val >= 200000) return true;
    if (t.completedAt) {
      var done = new Date(t.completedAt);
      var now = new Date();
      var diffDays = Math.floor((now - done) / (1000 * 60 * 60 * 24));
      if (diffDays >= 7) return true;
    }
    return false;
  }

  function renderRekap() {
    var own = adalahOwner();
    if (filter !== 'today' && filter !== 'week' && filter !== 'month') filter = 'month';
    document.querySelectorAll('#ronceFilters .chip').forEach(function (c) {
      c.classList.toggle('on', c.dataset.rfilter === filter);
    });
    var ro = $('#ronceRekapOwner'), rm = $('#ronceRekapMitra');
    if (ro) ro.hidden = !own;
    if (rm) rm.hidden = own;
    if (!own) { renderRekapMitra(); return; }

    /* ---- OWNER: filter mitra + rekap per mitra ---- */
    var mf = $('#ronceMitraFilter');
    if (mf) {
      var opts = '<option value="">Semua Mitra</option>';
      data.users.forEach(function (u) {
        if (u.role === 'owner') return;
        opts += '<option value="' + esc(u.id) + '"' + (selectedMitraFilter === u.id ? ' selected' : '') + '>' + esc(u.name) + '</option>';
      });
      mf.innerHTML = opts;
    }
    var tk = $('#ronceTotalKomisi');
    if (tk) tk.textContent = formatIDR(totalKomisiSemua());
    renderRekapSummary();

    var pr = $('#roncePayReq');
    if (pr) {
      var reqs = data.paymentRequests.slice().reverse();
      if (selectedMitraFilter) reqs = reqs.filter(function (r) { return r.employeeId === selectedMitraFilter; });
      pr.innerHTML = reqs.length ? reqs.map(function (r) {
        var ok = r.status === 'dibayar';
        return '<div class="mt-pay ' + (ok ? 'ok' : 'wait') + '">'
          + '<div class="mt-pay-l"><b>' + esc(r.employeeName) + ' &middot; ' + formatIDR(r.amount) + '</b>'
          + '<span>' + formatTanggal(r.date) + '</span></div>'
          + (ok
              ? '<span class="mt-tag done">DIBAYAR</span>'
              : '<button class="mini-btn" data-rpay="' + esc(r.id) + '">Tandai Dibayar</button>')
          + '</div>';
      }).join('') : '<div class="mt-empty">Belum ada pengajuan dari mitra</div>';
    }
  }

  /* Ringkasan per mitra: garapan done, pengajuan pembayaran, sudah lunas. */
  function renderRekapSummary() {
    var el = $('#ronceMitraSummary');
    if (!el) return;
    var users = data.users.filter(function (u) { return u.role !== 'owner'; });
    if (selectedMitraFilter) users = users.filter(function (u) { return u.id === selectedMitraFilter; });
    if (!users.length) { el.innerHTML = '<div class="empty">Belum ada mitra</div>'; return; }
    el.innerHTML = users.map(function (u) {
      var tasks = data.tasks.filter(function (t) { return t.employeeId === u.id; });
      var done = tasks.filter(function (t) { return t.status === 'completed'; });
      var reqs = data.paymentRequests.filter(function (r) { return r.employeeId === u.id; });
      var diajukan = reqs.filter(function (r) { return r.status !== 'dibayar'; })
        .reduce(function (s, r) { return s + num(r.amount); }, 0);
      var lunas = reqs.filter(function (r) { return r.status === 'dibayar'; })
        .reduce(function (s, r) { return s + num(r.amount); }, 0);
      return '<div class="item"><div class="item-body"><div class="item-title">' + esc(u.name) + '</div>'
        + '<div class="item-sub"><span>' + done.length + ' garapan done</span>'
        + '<span>Pengajuan ' + formatIDR(diajukan) + '</span>'
        + '<span>Lunas ' + formatIDR(lunas) + '</span></div></div></div>';
    }).join('');
  }

  /* Tampilan Rekap untuk MITRA: HANYA rekapan garapan selesai
     (belum dibayar / sudah dibayar) + ceklist pengajuan pelunasan. */
  function renderRekapMitra() {
    var list = $('#ronceRekapList');
    if (!list) return;
    var mitraId = sesi ? sesi.id : '';
    var doneTasks = data.tasks.filter(function (t) {
      return t.employeeId === mitraId && t.status === 'completed';
    });
    var belum = doneTasks.filter(function (t) { return !sudahLunas(t); });
    var lunas = doneTasks.filter(function (t) { return sudahLunas(t); });
    var jml = function (a) { return a.reduce(function (s, t) { return s + num(t.deliveryFee); }, 0); };
    var set = function (sel, v) { var e = $(sel); if (e) e.textContent = v; };
    set('#rkBelumTotal', formatIDR(jml(belum)));
    set('#rkBelumN', belum.length + ' garapan');
    set('#rkLunasTotal', formatIDR(jml(lunas)));
    set('#rkLunasN', lunas.length + ' garapan');

    var h = '';
    h += doneTasks.length ? doneTasks.map(function (t) {
      var eligibleT = isEligibleForPayment(t);
      var diajukan = sudahDiajukan(t.id);
      var sudahLunasT = sudahLunas(t);
      var badge, action, cek = '';
      if (sudahLunasT) {
        badge = '<span class="mt-tag done">LUNAS</span>';
        action = '<span class="mt-row-ok">Sudah dibayar</span>';
      } else if (diajukan) {
        badge = '<span class="mt-tag tunggu">DIAJUKAN</span>';
        action = '<span class="mt-row-ok">Menunggu owner</span>';
      } else if (eligibleT) {
        badge = '<span class="mt-tag proses">SIAP AJUKAN</span>';
        action = '<span class="mt-row-ok">Ceklis untuk ajukan</span>';
        cek = '<label class="mt-cek"><input type="checkbox" class="mt-pilih" data-pid="'
          + esc(t.id) + '"' + (terpilih[t.id] ? ' checked' : '') + '></label>';
      } else {
        /* Belum memenuhi syarat lama (1 minggu / Rp200rb), TAPI tetap bisa
           diceklis — syarat tidak boleh menghambat mitra mengajukan pelunasan. */
        badge = '<span class="mt-tag">BISA AJUKAN</span>';
        action = '<span class="mt-row-ok">Ceklis untuk ajukan</span>';
        cek = '<label class="mt-cek"><input type="checkbox" class="mt-pilih" data-pid="'
          + esc(t.id) + '"' + (terpilih[t.id] ? ' checked' : '') + '></label>';
      }
      return '<div class="mt-row done">'
        + '<div class="mt-row-top">'
        +   '<span class="mt-row-nama">' + esc(namaGarapan(t.serviceId)) + '</span>'
        +   badge
        + '</div>'
        + '<div class="mt-row-mid">' + t.quantity + ' &middot; ' + formatTanggal(t.date) + '</div>'
        + '<div class="mt-row-bottom">'
        +   '<span class="mt-row-jasa">' + formatIDR(t.deliveryFee) + '</span>'
        +   cek + action
        + '</div>'
        + '</div>';
    }).join('') : '<div class="empty">Belum ada garapan selesai</div>';
    list.innerHTML = h;

    /* Tombol Ajukan Pelunasan aktif kalau ada garapan selesai yang belum
       dibayar & belum diajukan (syarat lama tidak lagi menghambat). */
    var aj = $('#mtAjukan');
    if (aj) {
      var siap = doneTasks.filter(function (t) {
        return !sudahLunas(t) && !sudahDiajukan(t.id);
      }).length;
      var n = document.querySelectorAll('#ronceRekapList .mt-pilih:checked').length;
      aj.hidden = !siap;
      aj.textContent = n > 0 ? ('Ajukan Pelunasan (' + n + ')') : 'Ajukan Pelunasan';
    }
  }

  /* ---------------- Tab: Kasbon (mitra & owner) ----------------
     Kasbon dipisah ke tab sendiri supaya fokus ke kasbon, tidak
     bercampur dengan totalan garapan. */
  function renderKasbon() {
    var own = adalahOwner();
    var ro = $('#ronceKasbonOwner'), rm = $('#ronceKasbonMitra');
    if (ro) ro.hidden = !own;
    if (rm) rm.hidden = own;
    if (!own) { if (sesi) renderBon(sesi.id, true); return; }

    /* Owner: pengajuan BON dari mitra yang perlu direspons + total + per mitra. */
    var reqs = (data.bonRequests || []).filter(function (r) { return r.status === 'diajukan'; });
    var pr = $('#kasbonPendingList');
    if (pr) {
      pr.innerHTML = reqs.length ? reqs.map(function (r) {
        return '<div class="mt-pay wait">'
          + '<div class="mt-pay-l"><b>' + esc(r.employeeName) + ' &middot; ' + formatIDR(r.amount) + '</b>'
          + '<span>' + formatTanggal(r.date) + '</span></div>'
          + '<span class="mt-pay-act">'
          + '<button class="mini-btn ok" data-bon-ok="' + esc(r.id) + '">Setujui</button>'
          + '<button class="mini-btn danger" data-bon-no="' + esc(r.id) + '">Tolak</button>'
          + '</span></div>';
      }).join('') : '<div class="mt-empty">Tidak ada pengajuan BON</div>';
    }
    var pb = $('#kasbonPendingBadge');
    if (pb) { pb.textContent = reqs.length; pb.hidden = !reqs.length; }

    /* Total BON semua mitra + daftar per mitra. */
    var users = data.users.filter(function (u) { return u.role !== 'owner'; });
    var total = 0;
    users.forEach(function (u) { total += bonInfo(u.id).remaining; });
    var ta = $('#kasbonTotalAll');
    if (ta) ta.textContent = formatIDR(total);
    var list = $('#kasbonOwnerList');
    if (list) list.innerHTML = users.length ? users.map(function (u) {
      var info = bonInfo(u.id);
      var adaBON = info.total > 0;
      return '<div class="item"><div class="item-body"><div class="item-title">' + esc(u.name) + '</div>'
        + '<div class="item-sub"><span>BON ' + formatIDR(info.total) + '</span>'
        + '<span>Dilunasi ' + formatIDR(info.lunas) + '</span>'
        + '<span>Sisa <b>' + formatIDR(info.remaining) + '</b></span></div></div>'
        + (adaBON ? '<span class="mt-tag ' + (info.remaining > 0 ? 'tunggu' : 'done') + '">'
            + (info.remaining > 0 ? 'ADA BON' : 'LUNAS') + '</span>' : '')
        + '</div>';
    }).join('') : '<div class="empty">Belum ada mitra</div>';

    /* Rekap pelunasan BON yang masuk dari mitra (jasa / cash) — supaya owner
       ikut tahu garapan mana yang dipakai dan berapa yang dibayar cash. */
    var rl = $('#kasbonLunasList');
    if (rl) {
      var lunas = (data.transactions || []).filter(function (t) { return t.type === 'bon_lunas'; });
      rl.innerHTML = lunas.length ? lunas.slice().reverse().map(function (t) {
        var u2 = cariMitra(t.employeeId);
        var nama = [];
        (t.taskIds || []).forEach(function (id) {
          var tk = cariTugas(id);
          if (tk) nama.push(namaGarapan(tk.serviceId) + ' x' + tk.quantity);
        });
        var viaJasa = nama.length > 0;
        return '<div class="mt-pay ok">'
          + '<div class="mt-pay-l"><b>' + esc(u2 ? u2.name : '-') + ' &middot; ' + formatIDR(t.amount) + '</b>'
          + '<span>' + formatTanggal(t.date) + ' &middot; '
          + (viaJasa ? 'dipotong dari jasa' : 'dibayar cash') + '</span>'
          + (viaJasa ? '<span class="bon-used">' + esc(nama.join(', ')) + '</span>' : '')
          + '</div>'
          + '<span class="mt-tag done">' + (viaJasa ? 'JASA' : 'CASH') + '</span></div>';
      }).join('') : '<div class="mt-empty">Belum ada pelunasan BON</div>';
    }

    /* Catat BON langsung: pilih mitra dulu, lalu kartu BON owner digambar. */
    var pick = $('#kasbonMitraPick');
    if (pick) {
      var opt = '<option value="">-- Pilih Mitra --</option>';
      users.forEach(function (u) {
        opt += '<option value="' + esc(u.id) + '"' + (kasbonMitraPick === u.id ? ' selected' : '') + '>' + esc(u.name) + '</option>';
      });
      pick.innerHTML = opt;
    }
    renderBon(kasbonMitraPick, false);
  }
  /* ---------------- Tab: Setting ---------------- */

  function renderSetting() {
    /* Setting dipisah per peran: OWNER (komisi + mitra) vs MITRA (Akun Saya).
       Wadah mitra jadi tempat fitur mitra berikutnya. */
    var own = adalahOwner();
    var so = $('#rsSettingOwner'), sm = $('#rsSettingMitra');
    if (so) so.hidden = !own;
    if (sm) sm.hidden = own;
    renderAkun();
    if (!own) return;

    var sl = $('#rsServiceList');
    if (sl) {
      sl.innerHTML = data.services.map(function (g) {
        return '<div class="item"><div class="item-body"><div class="item-title">' + esc(g.name) + '</div>'
          + '<div class="item-sub"><span>' + formatIDR(g.isSetEnabled ? hargaPerSet(g) : num(g.price)) + '</span>'
          + (g.isSetEnabled ? '<span>Set ' + (num(g.itemsPerSet) || 10) + ' item</span>' : '') + '</div></div>'
          + '<div style="display:flex;gap:6px"><button class="mini-btn" data-rs-set="' + esc(g.id) + '">' + (g.isSetEnabled ? 'Off' : 'Set') + '</button>'
          + '<button class="mini-btn danger" data-rs-del="' + esc(g.id) + '">Hapus</button></div></div>';
      }).join('');
    }

    var ul = $('#rsUserList');
    if (ul) {
      /* Urut rapi: owner dulu, lalu mitra AKTIF, lalu yang belum aktif. */
      var urut = data.users.slice().sort(function (a, b) {
        var pa = a.role === 'owner' ? 0 : (a.aktif ? 1 : 2);
        var pb = b.role === 'owner' ? 0 : (b.aktif ? 1 : 2);
        return pa - pb;
      });
      ul.innerHTML = urut.map(function (u) {
        var owner = u.role === 'owner';
        var label = owner ? 'OWNER' : (u.aktif ? 'AKTIF' : 'BELUM AKTIF');
        var badge = owner ? '' : (u.aktif ? ' ok' : ' wait');
        return '<div class="mitra-item' + (u.aktif ? ' on' : '') + '">'
          + '<div class="mitra-head">'
          +   '<span class="mitra-ava">' + esc(String(u.name || '?').slice(0, 2).toUpperCase()) + '</span>'
          +   '<div class="mitra-id">'
          +     '<div class="mitra-nama">' + esc(u.name) + '</div>'
          +     '<div class="mitra-meta">' + (u.wa ? 'WA ' + esc(u.wa) : 'No. WA belum diisi') + ' &middot; PIN ' + esc(u.pin || '-') + '</div>'
          +   '</div>'
          +   '<span class="tag' + badge + '">' + label + '</span>'
          + '</div>'
          + (owner ? ''
              : '<div class="mitra-aksi">'
                + '<button class="mini-btn" data-rwa="' + esc(u.id) + '">' + (u.wa ? 'Kirim Link' : 'Salin Link') + '</button>'
                + '<button class="mini-btn danger" data-rdeluser="' + esc(u.id) + '">Hapus</button>'
                + '</div>')
          + '</div>';
      }).join('');
    }
  }

  /* ---------------- Actions ---------------- */

  /* Tambah garapan ke tampungan sementara (draft) sebelum dikirim ke mitra. */
  function tambahDraftJob() {
    var serviceId = ($('#rjGarapan') || {}).value || '';
    var quantity = ($('#rjQty') || {}).value || '';
    if (!serviceId) { w.App.toast('Pilih jenis garapan!'); return; }
    if (num(quantity) <= 0) { w.App.toast('Jumlah minimal 1!'); return; }
    draftJobs.push({
      serviceId: serviceId,
      quantity: num(quantity),
      deliveryFee: feeOtomatis(serviceId, num(quantity))
    });
    var q = $('#rjQty'); if (q) q.value = '';
    w.App.toast('Garapan ditambahkan ke tampungan');
    renderDraft();
  }

  /* Hapus garapan dari tampungan sementara. */
  function hapusDraftJob(idx) {
    draftJobs.splice(idx, 1);
    renderDraft();
  }

  /* Render daftar tampungan sementara garapan. */
  function renderDraft() {
    var list = $('#rjDraftList');
    if (!list) return;
    if (!draftJobs.length) {
      list.innerHTML = '<div class="empty">Belum ada garapan. Tambahkan garapan dulu, lalu kirim.</div>';
      return;
    }
    list.innerHTML = draftJobs.map(function (d, i) {
      return '<div class="rj-draft">'
        + '<div class="rj-draft-info">'
        + '<div class="rj-draft-name">' + esc(namaGarapan(d.serviceId)) + ' x' + d.quantity + '</div>'
        + '<div class="rj-draft-sub">Jasa: ' + formatIDR(d.deliveryFee) + '</div>'
        + '</div>'
        + '<button class="rj-draft-del" data-draft-del="' + i + '" title="Hapus">&times;</button>'
        + '</div>';
    }).join('');
  }

  /* Kirim semua garapan di tampungan ke mitra. */
  function kirimDraftJobs() {
    if (!draftJobs.length) { w.App.toast('Tampungan kosong!'); return; }
    var employeeId = ($('#rjMitra') || {}).value || '';
    var catatan = (($('#rjCatatan') || {}).value || '').trim();
    if (!employeeId) { w.App.toast('Pilih mitra dulu!'); return; }
    var u = cariMitra(employeeId);
    if (!u) { w.App.toast('Data mitra tidak ditemukan!'); return; }
    var count = 0;
    draftJobs.forEach(function (d) {
      data.tasks.unshift({
        id: uid(), employeeId: employeeId, employeeName: u.name,
        serviceId: d.serviceId, quantity: d.quantity,
        deliveryFee: d.deliveryFee,
        date: hariIni(), note: catatan, status: 'terkirim',
        createdAt: new Date().toISOString()
      });
      count++;
    });
    catat(count + ' garapan dikirim ke ' + u.name);
    simpan();
    w.App.toast(count + ' garapan terkirim ke ' + u.name);
    draftJobs = [];
    var c = $('#rjCatatan'); if (c) c.value = '';
    renderDraft();
    renderInput();
  }



  function selesaiTugas(id) {
    for (var i = 0; i < data.tasks.length; i++) {
      if (data.tasks[i].id === id) {
        data.tasks[i].status = 'completed';
        data.tasks[i].completedAt = new Date().toISOString();
        data.tasks[i]._u = new Date().toISOString();
        catat('Tugas ' + namaGarapan(data.tasks[i].serviceId) + ' selesai oleh ' + data.tasks[i].employeeName);
      }
    }
    simpan();
    /* Mitra: begitu lapor selesai, otomatis pindah ke tab Rekap supaya
       langsung bisa mengajukan pembayaran. Owner tetap di tempat. */
    if (sesi && sesi.role !== 'owner') {
      tabAktif = 'rekap';
      terpilih = {};
      renderTab();
      w.App.toast('Garapan selesai — silakan ajukan pembayaran di Rekap');
    } else {
      renderTugasMitra();
    }
  }

  function tambahGarapan() {
    var name = (($('#rsNama') || {}).value || '').trim().toUpperCase();
    if (!name) { w.App.toast('Isi nama garapan!'); return; }
    var price = num(($('#rsHarga') || {}).value);
    if (price <= 0) { w.App.toast('Harga harus lebih dari 0!'); return; }
    data.services.push({ id: uid(), name: name, price: price });
    catat('Garapan ' + name + ' ditambahkan ' + formatIDR(price));
    simpan();
    w.App.toast('Garapan ditambahkan');
    renderSetting();
  }

  function hapusGarapan(id) {
    data.services = data.services.filter(function (g) { return g.id !== id; });
    data.hapus.services.push({ id: id, t: new Date().toISOString() });
    simpan();
    renderSetting();
  }

  /* ---------------- Manajemen Mitra ---------------- */
  function tambahMitra() {
    if (!adalahOwner()) return;
    var name = (($('#rsNamaMitra') || {}).value || '').trim().toUpperCase();
    var wa = (($('#rsWaMitra') || {}).value || '').replace(/\D/g, '');
    if (!name) { w.App.toast('Isi nama mitra!'); return; }
    var ada = data.users.some(function (u) { return u.name.toUpperCase() === name; });
    if (ada) { w.App.toast('Nama mitra sudah terdaftar!'); return; }
    /* PIN default 0000 — akun belum aktif sampai mitra mengganti PIN-nya. */
    var u = { id: 'u_' + uid(), name: name, role: 'mitra', pin: '0000', wa: wa, aktif: false };
    data.users.push(u);
    catat('Mitra ' + name + ' ditambahkan (PIN default 0000)');
    simpan();
    var nm = $('#rsNamaMitra'); if (nm) nm.value = '';
    var wm = $('#rsWaMitra'); if (wm) wm.value = '';
    renderSetting();
    kirimLinkWa(u);
  }

  function hapusMitra(id) {
    if (!adalahOwner()) return;
    var u = cariMitra(id);
    if (!u || u.role === 'owner') { w.App.toast('Akun owner tidak bisa dihapus'); return; }
    if (!w.confirm('Hapus mitra "' + u.name + '"? Riwayat pekerjaan mereka tetap ada.')) return;
    data.users = data.users.filter(function (x) { return x.id !== id; });
    data.hapus.users.push({ id: id, t: new Date().toISOString() });
    catat('Mitra ' + u.name + ' dihapus');
    simpan();
    renderSetting();
  }

  /* Mitra ganti PIN. Begitu PIN default (0000) diganti pertama kali,
     akun otomatis jadi AKTIF dan siap menerima tugas dari tab Tugas. */
  function gantiPin() {
    if (!sesi || sesi.role === 'owner') return;
    var pin = (($('#rsPinBaru') || {}).value || '').replace(/\D/g, '').slice(0, 4);
    if (pin.length !== 4) { w.App.toast('PIN harus 4 digit angka!'); return; }
    if (pin === '0000') { w.App.toast('PIN tidak boleh 0000 — pilih PIN lain'); return; }
    var pertamaKali = !sesi.aktif;
    sesi.pin = pin;
    sesi.aktif = true;
    sesi._u = new Date().toISOString();
    catat('Mitra ' + sesi.name + (pertamaKali ? ' AKTIF (PIN diganti)' : ' ganti PIN'));
    simpan();
    var ip = $('#rsPinBaru'); if (ip) ip.value = '';
    w.App.toast(pertamaKali ? 'PIN tersimpan — akunmu AKTIF!' : 'PIN berhasil diganti');
    renderAkun();
  }

  /* Kartu "Akun Saya" — hanya untuk mitra, menampilkan status aktif/belum. */
  function renderAkun() {
    var wadah = $('#rsSettingMitra');
    if (!wadah) return;
    var mitra = !!(sesi && sesi.role !== 'owner');
    wadah.hidden = !mitra;
    if (!mitra) return;
    var st = $('#rsAkunStatus');
    if (st) {
      st.innerHTML = sesi.aktif
        ? '<span class="tag ok">AKTIF</span> Akunmu aktif — siap terima tugas.'
        : '<span class="tag wait">BELUM AKTIF</span> Ganti PIN default (0000) untuk mengaktifkan akun.';
    }
  }

  function toggleSet(id) {
    for (var i = 0; i < data.services.length; i++) {
      if (data.services[i].id === id) {
        var g = data.services[i];
        g.isSetEnabled = !g.isSetEnabled;
        if (g.isSetEnabled && !g.itemsPerSet) g.itemsPerSet = 10;
        if (g.isSetEnabled && !g.pricePerSet) g.pricePerSet = num(g.price) * num(g.itemsPerSet || 10);
        g._u = new Date().toISOString();
      }
    }
    simpan();
    renderSetting();
  }

  function bersihkanSemua() {
    data.jobs = []; data.transactions = []; data.tasks = [];
    data.paymentRequests = []; data.centralBalance = 0; data.log = [];
    simpan();
    catat('Seluruh data riwayat dan saldo direset');
    simpan();
    renderSetting();
  }

  /* ---------------- Sinkronisasi antar perangkat ----------------
     Dokumen = seluruh `data` + `updatedAt` + tombstone `hapus`.
     Digabung per-item (berdasarkan id + stempel waktu item) supaya
     perubahan owner (tugas baru) dan mitra (lapor selesai, pengajuan)
     TIDAK saling menimpa. Dipakai oleh ronce-sync.js. */
  function stempel(it) {
    return String((it && (it._u || it.updatedAt || it.paidAt || it.completedAt || it.createdAt)) || '');
  }

  function doc() { return data; }

  function gabung(jauh) {
    if (!jauh || typeof jauh !== 'object') return false;
    var berubah = false;
    var KH = ['users', 'tasks', 'services'];

    /* 1. Tombstone dari kedua sisi digabung. */
    KH.forEach(function (k) {
      var a = data.hapus[k] || [], b = (jauh.hapus && jauh.hapus[k]) || [];
      var ada = {};
      a.concat(b).forEach(function (x) { ada[String(x && x.id ? x.id : x)] = 1; });
      var hasil = Object.keys(ada).map(function (id) { return { id: id }; });
      if (hasil.length !== a.length) berubah = true;
      data.hapus[k] = hasil;
    });

    /* 2. Tiap daftar digabung berdasarkan id; stempel lebih baru menang. */
    ['users','tasks','jobs','transactions','paymentRequests','bonRequests','services','log'].forEach(function (k) {
      var lokal = Array.isArray(data[k]) ? data[k] : [];
      var jauhArr = Array.isArray(jauh[k]) ? jauh[k] : [];
      if (!jauhArr.length) return;
      var peta = {}, urut = [];
      lokal.forEach(function (it) {
        var id = String(it && it.id);
        if (!peta[id]) { peta[id] = it; urut.push(id); }
      });
      jauhArr.forEach(function (it) {
        var id = String(it && it.id);
        if (!peta[id]) { peta[id] = it; urut.push(id); berubah = true; return; }
        if (stempel(it) > stempel(peta[id])) { peta[id] = it; berubah = true; }
      });
      data[k] = urut.map(function (id) { return peta[id]; });
    });

    /* 3. Buang item yang sudah dihapus. */
    KH.forEach(function (k) {
      var buang = {};
      data.hapus[k].forEach(function (x) { buang[String(x.id)] = 1; });
      var sebelum = data[k].length;
      data[k] = data[k].filter(function (it) { return !buang[String(it.id)]; });
      if (data[k].length !== sebelum) berubah = true;
    });

    /* 4. Saldo terpusat: pakai dokumen yang lebih baru. */
    if (String(jauh.updatedAt || '') > String(data.updatedAt || '')) {
      data.centralBalance = num(jauh.centralBalance);
      data.updatedAt = jauh.updatedAt;
      berubah = true;
    }

    /* 5. Batasi tombstone & log. */
    KH.forEach(function (k) { if (data.hapus[k].length > 300) data.hapus[k] = data.hapus[k].slice(-300); });
    if (data.log.length > 300) data.log.length = 300;

    if (berubah) {
      try { w.localStorage.setItem(KUNCI, JSON.stringify(data)); } catch (e) {}
      if (sesi) {
        var ul = cariMitra(sesi.id);
        if (ul) sesi = ul;
        else { sesi = null; try { w.localStorage.removeItem(KUNCI_SESI); } catch (e) {} }
      }
    }
    return berubah;
  }

  /* Gambar ulang tampilan setelah data digabung dari server. */
  function refresh() {
    try {
      if (sesi) renderTab();
      else renderLogin();
    } catch (e) {}
  }

  /* ---------------- Init ---------------- */

  var _inited = false;
  function init() {
    if (_inited) return;
    _inited = true;
    muat();
    /* Tandai mode mitra dari PARAMETER LINK — bukan dari apakah akunnya sudah
       ketemu di perangkat ini. Di HP mitra (perangkat baru) datanya belum ada,
       jadi kalau menunggu akun ketemu dulu, mitra akan mendarat di beranda
       Project Nava. */
    var dariLink = idMitraDariSumber();
    mitraDariLink = dariLink;
    try {
      var uidSesi = w.localStorage.getItem(KUNCI_SESI);
      var u = uidSesi ? cariMitra(uidSesi) : null;
      if (u) { sesi = u; layar = 'app'; }
    } catch (e) {}
    renderLogin();
    if (layar === 'app') showApp();

    /* Buka link mitra (?m=ID / start_param Telegram): mitra harus langsung
       mendarat di Kalkulator Garapan (view ronce) — bukan beranda Project
       Nava. Header Project Nava disembunyikan (body.mitra-mode) supaya yang
       tampak hanya kalkulator garapan yang sudah dibatasi aksesnya.
       Sengaja TIDAK lewat App.go(): onShow() -> showLogin() akan
       mengosongkan mitraDariLink dan merusak login-langsung mitra. */
    if (dariLink) {
      try {
        w.document.body.classList.add('mitra-mode');
        if (w.App) w.App.view = 'ronce';
        var navb = w.document.querySelector('.tabbar');
        if (navb) navb.style.display = 'none';
        Array.prototype.forEach.call(w.document.querySelectorAll('.view'), function (s) {
          s.classList.toggle('active', s.id === 'view-ronce');
        });
        var pt = w.document.querySelector('#pageTitle');
        if (pt) pt.textContent = 'Kalkulator Garapan';
        var ps = w.document.querySelector('#pageSub');
        if (ps) ps.textContent = 'Akses mitra';
      } catch (e) {}
    }

    /* Sinkronisasi data Ronce antar perangkat (owner <-> HP mitra). */
    try { if (w.RonceSync && w.RonceSync.mulai) w.RonceSync.mulai(); } catch (e) {}

    // Login: pilih user
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-ruser]');
      if (btn && $('#ronceLogin') && !$('#ronceLogin').style.display.includes('none') && $('#roncePinPad').hidden) {
        pilihUser(btn.dataset.ruser);
      }
      // PIN keys
      var pk = e.target.closest('[data-pin]');
      if (pk && !$('#roncePinPad').hidden) {
        ketikPin(pk.dataset.pin);
      }
    });

    var pb = $('#roncePinBack');
    if (pb) pb.addEventListener('click', function () { showLogin(); });

    // Tabs
    document.addEventListener('click', function (e) {
      var tb = e.target.closest('[data-rtab]');
      if (tb) { tabAktif = tb.dataset.rtab; renderTab(); }
    });

    // Input tab — event delegation untuk semua tombol di tab Input
    document.addEventListener('click', function (e) {
      var tambah = e.target.closest('#rjTambahGarapan');
      if (tambah) { w.Ronce.tambahDraftJob(); return; }
      var kirim = e.target.closest('#rjSimpan');
      if (kirim) { w.Ronce.kirimDraftJobs(); return; }
      var del = e.target.closest('[data-draft-del]');
      if (del) { w.Ronce.hapusDraftJob(parseInt(del.dataset.draftDel, 10)); return; }
    });



    // Rekap filter
    document.addEventListener('click', function (e) {
      var f = e.target.closest('[data-rfilter]');
      if (f) {
        filter = f.dataset.rfilter;
        renderRekap();
      }
    });
    // Tugas actions (delegated) — mitra lapor selesai, ajukan pelunasan, BON
    document.addEventListener('click', function (e) {
      var done = e.target.closest('[data-rt-done]');
      if (done) { selesaiTugas(done.dataset.rtDone); return; }
      var mj = e.target.closest('#mtAjukan');
      if (mj) { ajukanPembayaran(); return; }
      var bonBtn = e.target.closest('[data-bon-ajukan]');
      if (bonBtn) {
        var amt = nomorBonDari(bonBtn);
        if (amt <= 0) { w.App.toast('Isi nominal BON dulu'); return; }
        /* Owner = pencatat/persetuju: langsung catat. Mitra = mengajukan. */
        if (adalahOwner()) catatBonLangsung(bonBtn.dataset.bonAjukan, amt);
        else ajukanBon(bonBtn.dataset.bonAjukan, amt);
        renderKasbon();
        return;
      }
      /* Pelunasan BON via jasa: siapkan rincian -> konfirmasi -> baru dicatat. */
      var bcs = e.target.closest('[data-bon-cashjasa]');
      if (bcs) { siapkanBonSettle(bcs.dataset.bonCashjasa, true); return; }
      var bci = e.target.closest('[data-bon-cicil]');
      if (bci) { siapkanBonSettle(bci.dataset.bonCicil, false); return; }
      var byk = e.target.closest('[data-bon-yakin]');
      if (byk) { jalankanBonSettle(); return; }
      var bbt = e.target.closest('[data-bon-batal]');
      if (bbt) { batalBonSettle(); return; }
      /* Owner merespons pengajuan BON mitra. */
      var bok = e.target.closest('[data-bon-ok]');
      if (bok) { setujuiBon(bok.dataset.bonOk); return; }
      var bno = e.target.closest('[data-bon-no]');
      if (bno) { tolakBon(bno.dataset.bonNo); return; }
    });
        // Filter mitra dropdown di tab Rekap + ceklist garapan selesai (mitra)
    document.addEventListener('change', function (e) {
      var c = e.target.closest('.mt-pilih');
      if (c) {
        if (c.checked) terpilih[c.dataset.pid] = 1; else delete terpilih[c.dataset.pid];
        renderRekapMitra();   /* perbarui label "Ajukan Pelunasan (N)" */
        return;
      }
      var bp = e.target.closest('.bon-pilih');
      if (bp) { if (sesi) hitungBonSettle(sesi.id); return; }
      var kp = e.target.closest('#kasbonMitraPick');
      if (kp) { kasbonMitraPick = kp.value; renderKasbon(); return; }
      var mf = e.target.closest('#ronceMitraFilter');
      if (mf) { selectedMitraFilter = mf.value; renderRekap(); }
    });

    /* Nominal pelunasan BON diketik -> perhitungan ikut berubah (tanpa
       menggambar ulang kartu, supaya fokus ketikan tidak hilang). */
    document.addEventListener('input', function (e) {
      var bi = e.target.closest('.bon-row-inp');
      if (bi && sesi) { hitungBonSettle(sesi.id); }
    });

    // Setting actions
    var ta = $('#rsTambah');
    if (ta) ta.addEventListener('click', tambahGarapan);
    var tm = $('#rsTambahMitra');
    if (tm) tm.addEventListener('click', tambahMitra);
    var gp = $('#rsGantiPin');
    if (gp) gp.addEventListener('click', gantiPin);
    document.addEventListener('click', function (e) {
      var rl = e.target.closest('[data-rlink]');
      if (rl) { salinLink(rl.dataset.rlink); return; }
      var rw = e.target.closest('[data-rwa]');
      if (rw) {
        var mu = cariMitra(rw.dataset.rwa);
        if (mu) { if (mu.wa) kirimLinkWa(mu); else salinLink(mu.id); }
        return;
      }
      var rd = e.target.closest('[data-rdeluser]');
      if (rd) { hapusMitra(rd.dataset.rdeluser); return; }
      var rp = e.target.closest('[data-rpay]');
      if (rp) { bayarPengajuan(rp.dataset.rpay); return; }
      var sg = e.target.closest('[data-rs-set]');
      if (sg) { toggleSet(sg.dataset.rsSet); return; }
      var dg = e.target.closest('[data-rs-del]');
      if (dg) { hapusGarapan(dg.dataset.rsDel); return; }
    });
  }

  w.Ronce = {
    init: init,
    onShow: function () { if (sesi) { showApp(); } else { showLogin(); } },
    _data: function () { return data; },
    _muat: muat, _simpan: simpan,
    _doc: doc, _gabung: gabung, _refresh: refresh,
    feeOtomatis: feeOtomatis, hargaPerSet: hargaPerSet,
    saldoMitra: saldoMitra, rekapMitra: rekapMitra,
    dalamPeriode: dalamPeriode,
    tambahDraftJob: tambahDraftJob,
    kirimDraftJobs: kirimDraftJobs,
    hapusDraftJob: hapusDraftJob,
    renderDraft: renderDraft,
    ajukanBon: ajukanBon,
    catatBonLangsung: catatBonLangsung,
    setujuiBon: setujuiBon,
    tolakBon: tolakBon,
    siapkanBonSettle: siapkanBonSettle,
    jalankanBonSettle: jalankanBonSettle,
    batalBonSettle: batalBonSettle,
    hitungBonSettle: hitungBonSettle,
    _bonKonfirmasi: function () { return bonKonfirmasi; },
    _draftJobs: function () { return draftJobs; }
  };
})(window);
