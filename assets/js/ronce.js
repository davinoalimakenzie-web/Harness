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
    centralBalance: 0,
    log: [],
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
      if (t.type === 'pelunasan' || t.type === 'penarikan') keluar += num(t.amount);
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

  /* ---------------- Pelunasan ---------------- */

  function eksekusiPelunasan(mitraId, amount, mode) {
    var unpaid = saldoMitra(mitraId);
    var tanggal = hariIni();
    var dibuat = [];
    function tambahTx(type, nilai, note) {
      if (nilai <= 0) return;
      data.transactions.push({ id: uid(), employeeId: mitraId, type: type, amount: nilai, date: tanggal, note: note, createdAt: new Date().toISOString() });
      dibuat.push(data.transactions[data.transactions.length - 1]);
    }
    if (mode === 'cicil' && amount > unpaid) {
      if (unpaid > 0) {
        tambahTx('pelunasan', unpaid, 'Cicilan komisi (melunasi semua sisa)');
        tambahTx('penarikan', amount - unpaid, 'Kelebihan pembayaran otomatis jadi Kasbon');
      } else {
        tambahTx('penarikan', amount, 'Pembayaran saat komisi nol jadi Kasbon');
      }
    } else {
      var tipe = mode === 'kasbon' ? 'penarikan' : 'pelunasan';
      var note = mode === 'full' ? 'Pelunasan komisi (Full)' : mode === 'cicil' ? 'Cicilan komisi' : 'Kasbon mitra';
      tambahTx(tipe, amount, note);
    }
    if (mode !== 'kasbon' && (amount >= unpaid || mode === 'full')) {
      for (var i = 0; i < data.jobs.length; i++) {
        var j = data.jobs[i];
        if ((j.employeeId === mitraId) && (j.status || 'pending') === 'pending') j.status = 'lunas';
      }
    }
    catat('Pembayaran ' + mode + ' ' + formatIDR(amount) + ' ke ' + (cariMitra(mitraId) || {}).name);
    simpan();
    return dibuat;
  }

  /* ---------------- Option builders ---------------- */

  /* hanyaAktif = true: hanya mitra yang sudah ganti PIN (aktif) yang muncul.
     Dipakai di tab Input supaya mitra belum aktif tidak bisa diberi tugas. */
  function optsMitra(hanyaAktif) {
    var h = '<option value="">-- Pilih Mitra --</option>', i;
    for (i = 0; i < data.users.length; i++) {
      var u = data.users[i];
      var owner = u.role === 'owner';
      if (hanyaAktif && !owner && !u.aktif) continue;
      h += '<option value="' + esc(u.id) + '">' + esc(u.name) +
        (owner || u.aktif ? '' : ' (belum aktif)') + '</option>';
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
    /* Owner: semua tab (Setting khusus owner). Mitra: dashboard garapan saja,
       tab bar disembunyikan. */
    if (!own) tabAktif = 'tugas';
    var bar = $('#ronceTabs');
    if (bar) bar.style.display = own ? '' : 'none';
    document.querySelectorAll('#ronceTabs .seg-btn').forEach(function (b) {
      var t = b.dataset.rtab;
      b.style.display = own ? '' : 'none';
      b.classList.toggle('active', t === tabAktif);
    });
    /* Tab Tugas sudah dihapus dari navigasi — mitra tetap dapat dashboardnya. */
    var tabs = ['input','rekap','servis','setting'];
    tabs.forEach(function (t) {
      var el = $('#ronceTab-' + t);
      if (el) el.hidden = (t !== tabAktif);
    });
    var tugasEl = $('#ronceTab-tugas');
    if (tugasEl) tugasEl.hidden = own;
    if (tabAktif === 'input') renderInput();
    else if (tabAktif === 'tugas') renderTugasMitra();
    else if (tabAktif === 'rekap') renderRekap();
    else if (tabAktif === 'servis') renderServis();
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

  /* Garapan LUNAS = id-nya ada di pengajuan yang sudah dibayar. */
  function sudahLunas(t) {
    var reqs = data.paymentRequests || [];
    for (var i = 0; i < reqs.length; i++) {
      var r = reqs[i];
      if (r.status !== 'dibayar' || !r.taskIds) continue;
      if (r.taskIds.indexOf(t.id) >= 0) return true;
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

  /* ---------------- Tab: Tugas ---------------- */



  /* ---------------- Dashboard Mitra (tab Tugas, tampilan mitra) ----------------
     Satu layar saja: ringkasan jasa + tabel garapan proses/selesai +
     pengajuan pembayaran + laporan pelunasan. Semua angka dihitung dari
     data.tasks (jasa per garapan) dan data.transactions (pelunasan). */
  function mtRow(t, selesai) {
    var s = cariGarapan(t.serviceId);
    var set = s && s.isSetEnabled;
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
          ? '<span class="mt-row-ok">&#10003; Sudah dilaporkan</span>'
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
    renderAkun();
    var h = mtHitung();
    var set = function (sel, v) { var e = $(sel); if (e) e.textContent = v; };
    set('#mtTotalJasa', formatIDR(h.jasaProses + h.jasaDone));
    set('#mtJasaProses', formatIDR(h.jasaProses));
    set('#mtJasaDone', formatIDR(h.jasaDone));
    set('#mtJasaDibayar', formatIDR(h.dibayar));
    set('#mtJasaTunggu', formatIDR(h.tunggu));
    set('#mtCntProses', h.proses.length);
    set('#mtCntDone', h.done.length);

    var sub = $('#mtAjukanSub');
    if (sub) sub.textContent = h.bisaAjukan > 0
      ? ('Siap diajukan: ' + formatIDR(h.bisaAjukan))
      : 'Belum ada jasa menunggu bayar';
    var cta = $('#mtAjukan');
    if (cta) { cta.disabled = h.bisaAjukan <= 0; cta.classList.toggle('off', h.bisaAjukan <= 0); }

    var lp = $('#mtListProses'), ld = $('#mtListDone');
    if (lp) lp.innerHTML = h.proses.length
      ? h.proses.map(function (t) { return mtRow(t, false); }).join('')
      : '<div class="mt-empty">Tidak ada garapan yang sedang dikerjakan</div>';
    if (ld) ld.innerHTML = h.done.length
      ? h.done.map(function (t) { return mtRow(t, true); }).join('')
      : '<div class="mt-empty">Belum ada garapan selesai</div>';

    var lb = $('#mtListBayar');
    if (lb) {
      var rows = [];
      data.paymentRequests.filter(function (r) { return r.employeeId === sesi.id; })
        .slice().reverse().forEach(function (r) {
          var ok = r.status === 'dibayar';
          rows.push('<div class="mt-pay ' + (ok ? 'ok' : 'wait') + '">'
            + '<div class="mt-pay-l"><b>Pengajuan ' + formatIDR(r.amount) + '</b>'
            + '<span>' + formatTanggal(r.date) + '</span></div>'
            + '<span class="mt-tag ' + (ok ? 'done' : 'tunggu') + '">' + (ok ? 'DIBAYAR' : 'DIAJUKAN') + '</span>'
            + '</div>');
        });
      data.transactions.filter(function (x) { return x.employeeId === sesi.id && x.type === 'pelunasan'; })
        .slice().reverse().forEach(function (x) {
          rows.push('<div class="mt-pay ok">'
            + '<div class="mt-pay-l"><b>Pelunasan ' + formatIDR(x.amount) + '</b>'
            + '<span>' + formatTanggal(x.date) + (x.note ? ' &middot; ' + esc(x.note) : '') + '</span></div>'
            + '<span class="mt-tag done">DIBAYAR</span>'
            + '</div>');
        });
      lb.innerHTML = rows.length ? rows.join('') : '<div class="mt-empty">Belum ada pengajuan atau pelunasan</div>';
    }
  }

  /* Mitra mengajukan pembayaran untuk jasa selesai yang belum dibayar. */
  function ajukanPembayaran() {
    if (!sesi || sesi.role === 'owner') return;
    var h = mtHitung();
    if (h.bisaAjukan <= 0) { w.App.toast('Belum ada jasa menunggu bayar'); return; }
    /* Catat juga garapan mana saja yang diajukan, supaya owner bisa tahu
       mana yang masih "titip bayar" dan mana yang sudah lunas. */
    var belum = h.done.filter(function (t) { return !sudahDiajukan(t.id); });
    data.paymentRequests.push({
      id: uid(), employeeId: sesi.id, employeeName: sesi.name,
      amount: h.bisaAjukan, taskIds: belum.map(function (t) { return t.id; }),
      date: hariIni(), status: 'diajukan',
      createdAt: new Date().toISOString()
    });
    catat('Pengajuan pembayaran ' + formatIDR(h.bisaAjukan) + ' oleh ' + sesi.name);
    simpan();
    w.App.toast('Pengajuan terkirim ke owner');
    renderTugasMitra();
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

  function renderRekap() {
    /* Chip "Tahun Ini" & "Semua" sudah dihapus — pastikan filternya valid. */
    if (filter !== 'today' && filter !== 'week' && filter !== 'month') filter = 'month';
    document.querySelectorAll('#ronceFilters .chip').forEach(function (c) {
      c.classList.toggle('on', c.dataset.rfilter === filter);
    });
    var tk = $('#ronceTotalKomisi');
    if (tk) tk.textContent = formatIDR(totalKomisiSemua());

    /* Pengajuan pembayaran dari mitra (khusus owner). */
    var pr = $('#roncePayReq');
    if (pr && adalahOwner()) {
      var reqs = data.paymentRequests.slice().reverse();
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

    var list = $('#ronceRekapList');
    if (!list) return;
    var rekap = rekapMitra().filter(function (m) { return m.saldo > 0; });
    if (!adalahOwner()) rekap = rekap.filter(function (m) { return m.id === sesi.id; });
    if (!rekap.length) { list.innerHTML = '<div class="empty">Semua komisi mitra telah dilunasi!</div>'; return; }
    list.innerHTML = rekap.map(function (m) {
      return '<div class="item">'
        + '<div class="item-body"><div class="item-title">' + esc(m.nama) + '</div>'
        + '<div class="item-sub"><span>' + m.kerjaan + ' kerjaan</span><span>Sisa ' + formatIDR(m.saldo) + '</span></div></div>'
        + (adalahOwner()
            ? '<div style="display:flex;gap:6px"><button class="mini-btn" data-rn-bayar="' + esc(m.id) + '" data-rn-mode="full">Lunasi</button>'
            + '<button class="mini-btn" data-rn-bayar="' + esc(m.id) + '" data-rn-mode="cicil">Cicil</button></div>'
            : '<span class="item-sub">Menunggu pelunasan owner</span>') + '</div>';
    }).join('');
  }

  /* ---------------- Tab: Setting ---------------- */

  function renderSetting() {
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

  function tambahJob() {
    /* Input Garapan = pengirim TUGAS ke mitra. Tanggal otomatis hari ini,
       jasa otomatis dari komisi garapan — tidak ada isian tanggal/jasa. */
    var serviceId = ($('#rjGarapan') || {}).value || '';
    var quantity = ($('#rjQty') || {}).value || '';
    var employeeId = ($('#rjMitra') || {}).value || '';
    var catatan = (($('#rjCatatan') || {}).value || '').trim();
    if (!serviceId) { w.App.toast('Pilih jenis garapan!'); return; }
    if (num(quantity) <= 0) { w.App.toast('Jumlah minimal 1!'); return; }
    if (!employeeId) { w.App.toast('Pilih mitra!'); return; }
    var u = cariMitra(employeeId);
    if (!u) { w.App.toast('Data mitra tidak ditemukan!'); return; }
    data.tasks.unshift({
      id: uid(), employeeId: employeeId, employeeName: u.name,
      serviceId: serviceId, quantity: num(quantity),
      deliveryFee: feeOtomatis(serviceId, quantity),
      date: hariIni(), note: catatan, status: 'terkirim',
      createdAt: new Date().toISOString()
    });
    catat('Tugas ' + namaGarapan(serviceId) + ' x' + quantity + ' dikirim ke ' + u.name);
    simpan();
    w.App.toast('Tugas terkirim ke ' + u.name);
    var q = $('#rjQty'); if (q) q.value = '';
    var c = $('#rjCatatan'); if (c) c.value = '';
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
    renderTugasMitra();
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
    var card = $('#rsAkunCard');
    if (!card) return;
    var mitra = !!(sesi && sesi.role !== 'owner');
    card.hidden = !mitra;
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
    ['users','tasks','jobs','transactions','paymentRequests','services','log'].forEach(function (k) {
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

    // Input tab
    var sj = $('#rjSimpan');
    if (sj) sj.addEventListener('click', tambahJob);



    // Rekap filter
    document.addEventListener('click', function (e) {
      var f = e.target.closest('[data-rfilter]');
      if (f) {
        filter = f.dataset.rfilter;
        renderRekap();
      }
      var b = e.target.closest('[data-rn-bayar]');
      if (b) {
        var mode = b.dataset.rnMode || 'full';
        var unpaid = saldoMitra(b.dataset.rnBayar);
        var nominal = mode === 'full' ? unpaid : unpaid;
        if (mode === 'cicil') {
          var v = w.prompt('Masukkan nominal pelunasan sebagian untuk ' + (cariMitra(b.dataset.rnBayar) || {}).name, String(Math.round(unpaid / 2)));
          if (v === null) return;
          nominal = num(v);
          if (nominal <= 0) { w.App.toast('Nominal tidak valid'); return; }
        }
        eksekusiPelunasan(b.dataset.rnBayar, nominal, mode);
        renderRekap();
        w.App.toast('Pembayaran dicatat ' + formatIDR(nominal));
      }
    });
    // Tugas actions (delegated) — mitra lapor selesai
    document.addEventListener('click', function (e) {
      var done = e.target.closest('[data-rt-done]');
      if (done) { selesaiTugas(done.dataset.rtDone); return; }
    });

    // Setting actions
    var ta = $('#rsTambah');
    if (ta) ta.addEventListener('click', tambahGarapan);
    var tm = $('#rsTambahMitra');
    if (tm) tm.addEventListener('click', tambahMitra);
    var gp = $('#rsGantiPin');
    if (gp) gp.addEventListener('click', gantiPin);
    var ma = $('#mtAjukan');
    if (ma) ma.addEventListener('click', ajukanPembayaran);
    var mh = $('#mtHelp');
    if (mh) mh.addEventListener('click', function () {
      var g = $('#mtGuide'); if (g) g.hidden = !g.hidden;
    });
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
    eksekusiPelunasan: eksekusiPelunasan,
    dalamPeriode: dalamPeriode
  };
})(window);
