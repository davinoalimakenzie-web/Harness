/* ===================================================================
   ronce.js - Kalkulator Ronce, port penuh ke miniapps NAVA.

   Diambil dari aplikasi kalkulator-garapan (AI Studio). Struktur lima
   tab, aturan harga set, dan aturan pelunasanCICIL disalin apa adanya
   dari RekapGaji.tsx, InputPekerjaan.tsx, dan TugasMitra.tsx.

   Lima tab:
     Input   -> Input Pekerjaan +Riwayat jobs
     Tugas   -> Form penugasan multi-item + tugas belum selesai
     Rekap   -> Pelunasan komisi mitra dengan filter periode
     Log     -> Log semua aktivitas
     Setting -> Tema, daftar garapan, akses mitra, pembersih data

   Penyimpanan memakai localStorage + Supabase (lewat Supa.vault bila
   tersedia). Semua perhitungan murni dan bisa diuji tanpa DOM.
   =================================================================== */
(function (w) {
  'use strict';

  var KUNCI = 'mascim_ronce_v2';
  var KUNCI_AKUN = 'mascim_ronce_akun_v2';
  var KUNCI_SESI = 'mascim_ronce_sesi';

  /* ------------------------------------------------------------------
     Data awal - sama dengan isi yang terlihat di aplikasi asal
     ------------------------------------------------------------------ */

  var GARAPAN_AWAL = [
    { id: 'g_minti', name: 'MINTI', price: 10000 },
    { id: 'g_ronce', name: 'RONCE', price: 2000 },
    { id: 'g_keris', name: 'KERIS', price: 2500, isSetEnabled: true, itemsPerSet: 10, pricePerSet: 25000 },
    { id: 'g_blendok', name: 'BLENDOK', price: 5000 }
  ];

  var AKUN_AWAL = [
    { id: 'u_davino', name: 'Davino Alima kenzie', role: 'owner', pin: '1234' },
    { id: 'u_hima', name: 'HIMA', role: 'admin', pin: '1234' },
    { id: 'u_umi', name: 'UMI', role: 'admin', pin: '1234' }
  ];

  /* ------------------------------------------------------------------
     Util
     ------------------------------------------------------------------ */

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
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + mm + '-' + dd;
  }
  function formatIDR(n) {
    //Intl tidak tersedia di WebView lama, pakai penggCadangan.
    try {
      return new Intl.NumberFormat('id-ID', {
        style: 'currency', currency: 'IDR', maximumFractionDigits: 0
      }).format(num(n));
    } catch (e) {
      return 'Rp' + num(n).toLocaleString('id-ID');
    }
  }
  function formatTanggal(iso) {
    if (!iso) return '-';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    var bulan = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun',
      'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
    return d.getDate() + ' ' + bulan[d.getMonth()] + ' ' + d.getFullYear();
  }
  function jam(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return String(d.getHours()).padStart(2, '0') + ':' +
      String(d.getMinutes()).padStart(2, '0');
  }

  /* ------------------------------------------------------------------
     Penyimpanan
     ------------------------------------------------------------------ */

  var data = {
    services: null,   // null = belum pernah disimpan, pakai bawaan
    users: null,
    jobs: [],
    transactions: [],
    tasks: [],
    paymentRequests: [],
    centralBalance: 0,
    log: []
  };

  function muat() {
    try {
      var d = JSON.parse(w.localStorage.getItem(KUNCI) || 'null');
      if (d && typeof d === 'object') {
        for (var k in data) if (d[k] !== undefined) data[k] = d[k];
      }
    } catch (e) {}
    if (!Array.isArray(data.services) || !data.services.length) {
      data.services = GARAPAN_AWAL.map(function (g) {
        return JSON.parse(JSON.stringify(g));
      });
    }
    if (!Array.isArray(data.users) || !data.users.length) {
      data.users = AKUN_AWAL.map(function (u) {
        return JSON.parse(JSON.stringify(u));
      });
    }
    ['jobs', 'transactions', 'tasks', 'paymentRequests', 'log'].forEach(function (k) {
      if (!Array.isArray(data[k])) data[k] = [];
    });
    if (typeof data.centralBalance !== 'number') data.centralBalance = 0;
  }

  function simpan() {
    try { w.localStorage.setItem(KUNCI, JSON.stringify(data)); } catch (e) {}
  }

  function catat(teks) {
    data.log.unshift({ teks: teks, waktu: new Date().toISOString() });
    if (data.log.length > 300) data.log.length = 300;
  }

  /* ------------------------------------------------------------------
     HITUNG HARGA - disalin dari useEffect di InputPekerjaan.tsx
       isSetEnabled  -> qty * (pricePerSet || price * itemsPerSet||10)
       selain itu    -> qty * price
     ------------------------------------------------------------------ */

  function hargaPerSet(s) {
    if (!s) return 0;
    if (s.isSetEnabled) {
      return num(s.pricePerSet || (num(s.price) * (num(s.itemsPerSet) || 10)));
    }
    return num(s.price);
  }

  function feeOtomatis(serviceId, qty) {
    var s = cariGarapan(serviceId);
    var q = num(qty);
    if (!s || q <= 0) return 0;
    if (s.isSetEnabled) return Math.round(q * hargaPerSet(s));
    return Math.round(q * num(s.price));
  }

  function cariGarapan(id) {
    for (var i = 0; i < data.services.length; i++) {
      if (data.services[i].id === id) return data.services[i];
    }
    return null;
  }
  function namaGarapan(id) {
    var s = cariGarapan(id);
    return s ? s.name : 'Hapus';
  }
  function cariMitra(id) {
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === id) return data.users[i];
    }
    return null;
  }

  /* ------------------------------------------------------------------
     SALDO MITRA - disalin dari allTimeEmployeeBalances di RekapGaji.tsx
       saldo =  job.deliveryFee - (transaksi pelunasan + penarikan)
       > 0 sisa komisi, < 0 kasbon. titip TIDAK mengurangi saldo.
     ------------------------------------------------------------------ */

  function saldoMitra(id) {
    var komisi = 0, keluar = 0, i;
    for (i = 0; i < data.jobs.length; i++) {
      if (data.jobs[i].employeeId === id) komisi += num(data.jobs[i].deliveryFee);
    }
    for (i = 0; i < data.transactions.length; i++) {
      var t = data.transactions[i];
      if (t.employeeId !== id) continue;
      if (t.type === 'pelunasan' || t.type === 'penarikan') keluar += num(t.amount);
    }
    return komisi - keluar;
  }

  function totalKomisiSemua() {
    var t = 0;
    for (var i = 0; i < data.jobs.length; i++) t += num(data.jobs[i].deliveryFee);
    return t;
  }

  function rekapMitra() {
    var peta = {}, urutan = [], i, k;
    var sumber = [data.jobs, data.transactions, data.tasks];
    for (i = 0; i < sumber.length; i++) {
      for (k = 0; k < sumber[i].length; k++) {
        var m = sumber[i][k].employeeId;
        if (m && !peta[m]) { peta[m] = 1; urutan.push(m); }
      }
    }
    var hasil = [];
    for (i = 0; i < urutan.length; i++) {
      var id = urutan[i], kerjaan = 0, komisi = 0;
      for (k = 0; k < data.jobs.length; k++) {
        if (data.jobs[k].employeeId === id) {
          kerjaan++;
          komisi += num(data.jobs[k].deliveryFee);
        }
      }
      var u = cariMitra(id);
      hasil.push({
        id: id, nama: u ? u.name : id, kerjaan: kerjaan,
        komisi: komisi, saldo: saldoMitra(id)
      });
    }
    hasil.sort(function (a, b) { return b.saldo - a.saldo; });
    return hasil;
  }

  /* ------------------------------------------------------------------
     Filter periode - disalin dari filteredJobs (date-fns)
     ------------------------------------------------------------------ */

  var filter = 'month';        // today | week | month | year | all
  var selectedMonth = -1;      // -1 = semua bulan
  var BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
    'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

  function dalamPeriode(iso) {
    if (!iso) return true;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return true;
    var now = new Date();
    if (filter === 'today') {
      return d.getFullYear() === now.getFullYear()
        && d.getMonth() === now.getMonth()
        && d.getDate() === now.getDate();
    }
    if (filter === 'week') {
      // weekStartsOn: 1 (Senin)
      var hari = d.getDay(); if (hari === 0) hari = 7;
      var nowHari = now.getDay(); if (nowHari === 0) nowHari = 7;
      var dSenin = new Date(d); dSenin.setDate(d.getDate() - (hari - 1));
      var nSenin = new Date(now); nSenin.setDate(now.getDate() - (nowHari - 1));
      return dSenin.getTime() === nSenin.getTime();
    }
    if (filter === 'month') {
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    }
    if (filter === 'year') {
      if (d.getFullYear() !== now.getFullYear()) return false;
      if (selectedMonth !== -1) return d.getMonth() === selectedMonth;
      return true;
    }
    return true;
  }

  /* ------------------------------------------------------------------
     PELUNASAN - disalin dari executePaymentConfirmation
       cicil > sisa  -> pelunasan(sisa) + penarikan(selisih)  [kasbon]
       cicil <= sisa -> pelunasan
       kasbon        -> penarikan
     ------------------------------------------------------------------ */

  function eksekusiPelunasan(mitraId, amount, mode) {
    var unpaid = saldoMitra(mitraId);
    var tanggal = hariIni();
    var dibuat = [];

    function tambahTx(type, nilai, note) {
      if (nilai <= 0) return;
      var tx = {
        id: uid(), employeeId: mitraId, type: type,
        amount: nilai, date: tanggal, note: note,
        createdAt: new Date().toISOString()
      };
      data.transactions.push(tx);
      dibuat.push(tx);
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
      var note = mode === 'full' ? 'Pelunasan komisi (Full)'
        : mode === 'cicil' ? 'Cicilan komisi' : 'Kasbon mitra';
      tambahTx(tipe, amount, note);
    }

    // Jika lunas, tandai job pending milik mitra jadi lunas.
    if (mode !== 'kasbon' && (amount >= unpaid || mode === 'full')) {
      for (var i = 0; i < data.jobs.length; i++) {
        var j = data.jobs[i];
        if ((j.employeeId === mitraId) && (j.status || 'pending') === 'pending') {
          j.status = 'lunas';
        }
      }
    }

    catat('Pembayaran ' + mode + ' ' + formatIDR(amount) + ' ke '
      + (cariMitra(mitraId) || {}).name);
    simpan();
    return dibuat;
  }

  /* ------------------------------------------------------------------
     Aksi tab Input
     ------------------------------------------------------------------ */

  function tambahJob() {
    var employeeId = ($('#rjMitra') || {}).value || '';
    var serviceId = ($('#rjGarapan') || {}).value || '';
    var quantity = ($('#rjQty') || {}).value || '';
    var fee = ($('#rjFee') || {}).value || '';

    if (!employeeId) return { galat: 'Pilih mitra!' };
    if (!serviceId) return { galat: 'Pilih jenis garapan!' };
    if (num(quantity) <= 0) return { galat: 'Jumlah garapan minimal 1!' };
    var u = cariMitra(employeeId);
    if (!u) return { galat: 'Data mitra tidak ditemukan!' };

    var s = cariGarapan(serviceId);
    data.jobs.unshift({
      id: uid(), employeeId: employeeId, employeeName: u.name,
      date: ($('#rjTanggal') || {}).value || hariIni(),
      serviceId: serviceId, quantity: num(quantity),
      deliveryFee: fee === '' ? feeOtomatis(serviceId, quantity) : num(fee),
      status: 'pending', createdAt: new Date().toISOString()
    });
    catat(namaGarapan(serviceId) + ' x' + quantity + ' oleh ' + u.name);
    simpan();
    return { ok: true };
  }

  /* ------------------------------------------------------------------
     Aksi tab Tugas
     ------------------------------------------------------------------ */

  var taskItems = [{ serviceId: '', quantity: '', note: '' }];

  function tambahItemTugas() {
    taskItems.push({ serviceId: '', quantity: '', note: '' });
  }
  function hapusItemTugas(i) {
    if (taskItems.length > 1) taskItems.splice(i, 1);
  }

  function serahkanTugas() {
    var employeeId = ($('#rtMitra') || {}).value || '';
    var tanggal = ($('#rtTanggal') || {}).value || hariIni();
    if (!employeeId) return { galat: 'Pilih mitra tujuan.' };
    var u = cariMitra(employeeId);
    if (!u) return { galat: 'Data mitra tujuan tidak ditemukan.' };

    // Baca isi baris dari DOM, lalu simpan ke taskItems.
    taskItems = taskItems.map(function (item, i) {
      return {
        serviceId: (($('#rtSv' + i) || {}).value) || '',
        quantity: (($('#rtQty' + i) || {}).value) || '',
        note: (($('#rtNote' + i) || {}).value) || ''
      };
    });

    var valid = taskItems.filter(function (it) {
      return it.serviceId && num(it.quantity) > 0;
    });
    if (!valid.length) {
      return { galat: 'Pastikan setidaknya ada satu garapan dengan jumlah > 0.' };
    }

    for (var i = 0; i < valid.length; i++) {
      var it = valid[i];
      data.tasks.unshift({
        id: uid(), employeeId: employeeId, employeeName: u.name,
        serviceId: it.serviceId, quantity: num(it.quantity),
        deliveryFee: feeOtomatis(it.serviceId, it.quantity),
        date: tanggal, note: it.note, status: 'pending',
        createdAt: new Date().toISOString()
      });
      catat('Tugas ' + namaGarapan(it.serviceId) + ' x' + it.quantity
        + ' ke ' + u.name);
    }
    simpan();
    taskItems = [{ serviceId: '', quantity: '', note: '' }];
    return { ok: true };
  }

  function selesaiTugas(id) {
    for (var i = 0; i < data.tasks.length; i++) {
      if (data.tasks[i].id === id) {
        data.tasks[i].status = 'completed';
        data.tasks[i].completedAt = new Date().toISOString();
        catat('Tugas ' + namaGarapan(data.tasks[i].serviceId)
          + ' selesai oleh ' + data.tasks[i].employeeName);
      }
    }
    simpan();
  }
  function hapusTugas(id) {
    data.tasks = data.tasks.filter(function (x) { return x.id !== id; });
    simpan();
  }

  /* ------------------------------------------------------------------
     Aksi tab Setting
     ------------------------------------------------------------------ */

  var gelap = true;

  function tambahGarapan() {
    var name = (($('#rsNama') || {}).value || '').trim().toUpperCase();
    if (!name) return { galat: 'Isi nama garapan!' };
    var price = num(($('#rsHarga') || {}).value);
    if (price <= 0) return { galat: 'Harga harus lebih dari 0!' };
    data.services.push({ id: uid(), name: name, price: price });
    catat('Garapan ' + name + ' ditambahkan ' + formatIDR(price));
    simpan();
    return { ok: true };
  }
  function hapusGarapan(id) {
    data.services = data.services.filter(function (g) { return g.id !== id; });
    simpan();
  }
  function toggleSet(id) {
    for (var i = 0; i < data.services.length; i++) {
      if (data.services[i].id === id) {
        var g = data.services[i];
        g.isSetEnabled = !g.isSetEnabled;
        if (g.isSetEnabled && !g.itemsPerSet) g.itemsPerSet = 10;
        if (g.isSetEnabled && !g.pricePerSet) {
          g.pricePerSet = num(g.price) * num(g.itemsPerSet || 10);
        }
      }
    }
    simpan();
  }

  function bersihkanSemua() {
    data.jobs = [];
    data.transactions = [];
    data.tasks = [];
    data.paymentRequests = [];
    data.centralBalance = 0;
    data.log = [];
    simpan();
    catat('Seluruh data riwayat dan saldo direset');
    simpan();
  }

  /* ------------------------------------------------------------------
     Tampilan
     ------------------------------------------------------------------ */

  var el = {};
  var tabAktif = 'input';
  var sesi = null;         // userProfile yang login
  var layar = 'pilih';     // pilih | pin | app

  var TABS = [
    { id: 'input', label: 'Input' },
    { id: 'tugas', label: 'Tugas' },
    { id: 'rekap', label: 'Rekap' },
    { id: 'log', label: 'Log' },
    { id: 'setting', label: 'Setting' }
  ];

  function optsMitra() {
    var h = '<option value="">-- Pilih Mitra --</option>', i;
    for (i = 0; i < data.users.length; i++) {
      h += '<option value="' + esc(data.users[i].id) + '">'
        + esc(data.users[i].name) + '</option>';
    }
    return h;
  }
  function optsGarapan() {
    var h = '<option value="">-- Pilih Garapan --</option>', i;
    for (i = 0; i < data.services.length; i++) {
      var g = data.services[i];
      var harga = g.isSetEnabled ? hargaPerSet(g) : num(g.price);
      h += '<option value="' + esc(g.id) + '">'
        + esc(g.name) + ' (' + formatIDR(harga) + ')'
        + (g.isSetEnabled ? ' / Set' : '') + '</option>';
    }
    return h;
  }

  function tabInput() {
    var h = '';
    // Form
    h += '<div class="rn-kartu"><h3 class="rn-kartu-judul">Input Pekerjaan</h3>';
    h += '<div class="rn-field"><label>Mitra</label><select id="rjMitra">'
      + optsMitra() + '</select></div>';
    h += '<div class="rn-field"><label>Jenis Garapan</label><select id="rjGarapan">'
      + optsGarapan() + '</select></div>';
    h += '<div class="rn-dua">'
      + '<div class="rn-field"><label>Jumlah</label>'
      + '<input id="rjQty" type="number" inputmode="numeric" min="1" placeholder="1"></div>'
      + '<div class="rn-field"><label>Tanggal</label>'
      + '<input id="rjTanggal" type="date" value="' + hariIni() + '"></div></div>';
    h += '<div class="rn-field"><label>Jasa (Rp)</label>'
      + '<input id="rjFee" inputmode="numeric" placeholder="otomatis"></div>';
    h += '<button class="rn-aksi-utama" id="rjSimpan">Simpan Pekerjaan</button>';
    h += '</div>';

    // Ringkasan
    var pending = data.jobs.filter(function (j) {
      return (j.status || 'pending') === 'pending';
    }).reduce(function (s, j) { return s + num(j.deliveryFee); }, 0);
    h += '<div class="rn-kv"><span>Total Pending</span><b>' + formatIDR(pending) + '</b></div>';

    // Riwayat
    h += '<h3 class="rn-sec">Riwayat Pekerjaan</h3>';
    if (!data.jobs.length) {
      h += '<div class="rn-kosong">Belum ada pekerjaan.</div>';
      return h;
    }
    for (var i = 0; i < data.jobs.length; i++) {
      var j = data.jobs[i];
      var s = cariGarapan(j.serviceId);
      var set = s && s.isSetEnabled;
      h += '<div class="rn-kartu rn-kartu-tipis">'
        + '<div class="rn-kanan">'
        + '<div class="rn-judul2">' + esc(j.employeeName) + '</div>'
        + '<div class="rn-subkecil">' + formatTanggal(j.date) + ' · '
        + j.quantity + (set ? ' Set' : ' Pcs') + ' ' + esc(namaGarapan(j.serviceId))
        + '</div></div>'
        + '<div class="rn-kanan-kanan">'
        + '<div class="rn-uang">' + formatIDR(j.deliveryFee) + '</div>'
        + '<span class="rn-pil ' + (j.status === 'lunas' ? 'rn-pil-hijau' : 'rn-pil-kuning') + '">'
        + (j.status === 'lunas' ? 'Lunas' : 'Pending') + '</span></div></div>';
    }
    return h;
  }

  function tabTugas() {
    var h = '';
    h += '<div class="rn-kartu"><div class="rn-kanan"><h3 class="rn-kartu-judul">'
      + 'Tugas Garapan</h3><p class="rn-subkecil">Admin/Owner memberikan tugas '
      + 'garapan yang diselesaikan mitra.</p></div></div>';

    // Form penugasan
    h += '<div class="rn-kartu"><h3 class="rn-kartu-judul">Formulir Penugasan Baru</h3>';
    h += '<div class="rn-dua">'
      + '<div class="rn-field"><label>Mitra Tujuan</label><select id="rtMitra">'
      + optsMitra() + '</select></div>'
      + '<div class="rn-field"><label>Tanggal Tugas</label>'
      + '<input id="rtTanggal" type="date" value="' + hariIni() + '"></div></div>';
    h += '<div class="rn-label-garapan">Daftar Garapan</div>';
    for (var i = 0; i < taskItems.length; i++) {
      h += '<div class="rn-item">'
        + '<select id="rtSv' + i + '" class="rn-item-sv">' + optsGarapan() + '</select>'
        + '<input id="rtQty' + i + '" class="rn-item-qty" placeholder="Qty" inputmode="numeric">'
        + '<input id="rtNote' + i + '" class="rn-item-note" placeholder="Catatan...">'
        + '</div>';
    }
    h += '<div class="rn-item-aksi"><button class="rn-tambah" id="rtTambah">+</button>'
      + '<button class="rn-aksi-utama" id="rtKirim">Serahkan Tugas</button></div>';
    h += '</div>';

    // Tugas belum selesai
    var pending = data.tasks.filter(function (t) { return t.status === 'pending'; });
    h += '<h3 class="rn-sec">Tugas Belum Selesai (' + pending.length + ')</h3>';
    if (!pending.length) {
      h += '<div class="rn-kosong">Tidak ada tugas belum selesai.</div>';
      return h;
    }
    for (var k = 0; k < pending.length; k++) {
      var t = pending[k];
      h += '<div class="rn-kartu rn-kartu-tipis">'
        + '<div class="rn-kanan"><div class="rn-judul2">' + formatTanggal(t.date)
        + '</div><div class="rn-subkecil">' + esc(t.employeeName) + '</div></div>'
        + '<div class="rn-kanan-kanan"><div class="rn-uang">'
        + t.quantity + ' Pcs ' + esc(namaGarapan(t.serviceId)) + '</div>'
        + '<button class="rn-hapus" data-rn-hapustugas="' + esc(t.id) + '">Hapus</button>'
        + '</div></div>';
    }
    return h;
  }

  function tabRekap() {
    var h = '';
    h += '<h3 class="rn-kartu-judul rn-judul-atas">Pelunasan Komisi Mitra</h3>';
    h += '<p class="rn-subkecil">Kelola dan selesaikan kewajiban pembayaran komisi mitra</p>';

    // Filter
    h += '<div class="rn-filter">';
    var labels = { today: 'Hari Ini', week: 'Minggu Ini', month: 'Bulan Ini',
      year: 'Tahun Ini', all: 'Semua' };
    ['today', 'week', 'month', 'year', 'all'].forEach(function (f) {
      h += '<button class="rn-filter-btn'
        + (filter === f ? ' rn-filter-on' : '') + '" data-rn-filter="' + f + '">'
        + labels[f] + '</button>';
    });
    h += '</div>';
    if (filter === 'year') {
      h += '<select class="rn-bulan" id="rreBulan"><option value="-1">'
        + 'Semua Bulan (Jan - Des)</option>';
      BULAN.forEach(function (b, i) {
        h += '<option value="' + i + '"' + (selectedMonth === i ? ' selected' : '')
          + '>' + b + '</option>';
      });
      h += '</select>';
    }

    // Jatah bayar
    var rekap = rekapMitra();
    var totalHak = 0;
    for (var i = 0; i < rekap.length; i++) if (rekap[i].saldo > 0) totalHak += rekap[i].saldo;
    h += '<div class="rn-label-atas">Jatah Bayar Komisi'
      + '<span class="rn-total-komi">Total Komisi: ' + formatIDR(totalKomisiSemua()) + '</span></div>';

    var pendingMitra = rekap.filter(function (m) { return m.saldo > 0; });
    if (!pendingMitra.length) {
      h += '<div class="rn-kosong-garis">Semua komisi mitra telah dilunasi!</div>';
      return h;
    }

    for (var k = 0; k < pendingMitra.length; k++) {
      var m = pendingMitra[k];
      h += '<div class="rn-kartu">'
        + '<div class="rn-kanan"><div class="rn-judul2">' + esc(m.nama) + '</div>'
        + '<div class="rn-subkecil">' + m.kerjaan + ' kerjaan · sisa '
        + formatIDR(m.saldo) + '</div></div></div>'
        + '<div class="rn-pil-bayar">'
        + '<button class="rn-bayar" data-rn-bayar="' + esc(m.id) + '" data-rn-mode="full">'
        + 'Lunasi Semua</button>'
        + '<button class="rn-bayar rn-bayar-sekunder" data-rn-bayar="' + esc(m.id)
        + '" data-rn-mode="cicil">Bayar Sebagian</button></div>';
    }
    return h;
  }

  function tabLog() {
    var h = '<h3 class="rn-kartu-judul rn-judul-atas">Log Semua Aktivitas</h3>';
    h += '<p class="rn-subkecil">Daftar log pencatatan garapan dan pelunasan komisi</p>';
    if (!data.log.length) {
      h += '<div class="rn-kosong-garis">Belum ada aktivitas.</div>';
      return h;
    }
    for (var i = 0; i < data.log.length; i++) {
      var l = data.log[i];
      h += '<div class="rn-log"><span class="rn-log-jam">' + jam(l.waktu)
        + '</span><span class="rn-log-teks">' + esc(l.teks) + '</span></div>';
    }
    return h;
  }

  function tabSetting() {
    var h = '';
    // Tema
    h += '<div class="rn-kartu"><div class="rn-kanan"><h3 class="rn-kartu-judul">'
      + 'Tema Aplikasi</h3><p class="rn-subkecil">Ganti tema gelap atau terang '
      + 'dengan satu sentuhan.</p></div><button class="rn-bayar" id="rsTema">'
      + (gelap ? 'Mode Terang' : 'Mode Gelap') + '</button></div>';

    // Garapan
    h += '<div class="rn-kartu"><h3 class="rn-kartu-judul">Komisi Garapan</h3>'
      + '<p class="rn-subkecil">Kelola jenis garapan dan tarif per item.</p>'
      + '<div class="rn-label-garapan">Daftar Garapan</div>';
    for (var i = 0; i < data.services.length; i++) {
      var g = data.services[i];
      h += '<div class="rn-garapan">'
        + '<div class="rn-kanan"><div class="rn-judul2">' + esc(g.name) + '</div>'
        + (g.isSetEnabled ? '<div class="rn-subkecil">' + formatIDR(num(g.price))
          + ' · set ' + (num(g.itemsPerSet) || 10) + ' item</div>' : '')
        + '</div><div class="rn-kanan-kanan"><div class="rn-uang">'
        + formatIDR(g.isSetEnabled ? hargaPerSet(g) : num(g.price)) + '</div>'
        + '<button class="rn-hapus" data-rn-setgarapan="' + esc(g.id) + '">Set</button>'
        + '<button class="rn-hapus" data-rn-hapusgarapan="' + esc(g.id) + '">X</button>'
        + '</div></div>';
    }
    h += '<div class="rn-dua"><input id="rsNama" placeholder="Nama garapan">'
      + '<input id="rsHarga" placeholder="Harga" inputmode="numeric">'
      + '<button class="rn-bayar" id="rsTambah">Tambah</button></div></div>';

    // Akses mitra
    h += '<div class="rn-kartu"><div class="rn-kanan"><h3 class="rn-kartu-judul">'
      + 'Akses Mitra</h3><p class="rn-subkecil">Kelola profil mitra dan level akses.</p>'
      + '</div><span class="rn-total-komi">' + data.users.length + ' Akun</span></div>';

    // Pembersih
    h += '<div class="rn-kartu rn-kartu-bahaya"><h3 class="rn-kartu-judul">'
      + 'Alat Pembersih Data System</h3>'
      + '<p class="rn-subkecil">Gunakan panel ini untuk membersihkan semua data '
      + 'pengguna dan log riwayat sebelum mulai debug build.</p>'
      + '<ul class="rn-daftar-bahaya"><li>Logs & Aktivitas garapan akan dibersihkan</li>'
      + '<li>Riwayat tugas selesai & laporan garapan akan dihapus</li>'
      + '<li>Isian job bayar komisi & saldo pusat akan di-reset (Rp 0)</li></ul>'
      + '<button class="rn-aksi-bahaya" id="rsBersihkan">Mulai Bersihkan Data</button></div>';

    return h;
  }

  /* ------------------------------------------------------------------
     Layar: pilih akun + PIN
     ------------------------------------------------------------------ */

  function layarPilih() {
    var h = '<div class="rn-aksen">Kalkulator Ronce</div>'
      + '<div class="rn-sub">Sistem Pencatatan Finansial &amp; Gaji Mitra</div>'
      + '<div class="rn-aksen2">Pilih Akun Mitra</div>';
    for (var i = 0; i < data.users.length; i++) {
      h += '<button class="rn-akun" data-rn-pilih="' + esc(data.users[i].id) + '">'
        + '<span class="rn-avatar">' + esc(data.users[i].name.slice(0, 2).toUpperCase())
        + '</span><span class="mc-grow rn-akun-teks">'
        + '<span class="rn-akun-nama">' + esc(data.users[i].name) + '</span>'
        + '<span class="rn-akun-peran">' + esc(data.users[i].role) + '</span></span>'
        + '<span class="rn-panah">&rsaquo;</span></button>';
    }
    el.ronceBody.innerHTML = h + '<div class="rn-kaki">&copy; 2026 Kalkulator Ronce</div>';
  }

  var pinTempu = '', pesanPin = '', pilihPin = null;

  function layarPin() {
    var u = pilihPin || {};
    var h = '<div class="rn-aksen">Kalkulator Ronce</div>'
      + '<div class="rn-sub">Sistem Pencatatan Finansial &amp; Gaji Mitra</div>'
      + '<div class="rn-atas"><button class="rn-tombol" data-rn-kembali="1">Kembali</button>'
      + '<button class="rn-tombol" data-rn-ganti="1">Ubah PIN Login</button></div>'
      + '<div class="rn-avatar rn-avatar-besar">'
      + esc(String(u.name || '?').slice(0, 2).toUpperCase()) + '</div>'
      + '<div class="rn-nama">' + esc(u.name || '') + '</div>'
      + '<div class="rn-peran">' + esc(u.role || '') + '</div>'
      + '<div class="rn-judul">Masukkan PIN</div>'
      + '<div class="rn-ket">Masukkan 4 digit PIN Anda untuk masuk</div>';
    if (pesanPin) h += '<div class="rn-salah">' + esc(pesanPin) + '</div>';
    h += '<div class="rn-kolom">';
    '1 2 3 4 5 6 7 8 9 Clear 0 Delete'.split(' ').forEach(function (k) {
      h += '<button class="rn-key' + (k.length > 1 ? ' rn-key-ket' : '')
        + '" data-rn-pin="' + k + '">' + k + '</button>';
    });
    h += '</div><div class="rn-kaki">&copy; 2026 Kalkulator Ronce</div>';
    el.ronceBody.innerHTML = h;
  }

  /* ------------------------------------------------------------------
     Rangka tab
     ------------------------------------------------------------------ */

  function kerangka() {
    var h = '<div class="mc-nav">'
      + '<button class="mc-back" data-rn-tutup="1" aria-label="Tutup">&times;</button>'
      + '<div class="mc-grow"><div class="mc-bar-title">Kalkulator Ronce</div>'
      + '<div class="rn-mitra">' + esc(sesi ? sesi.name : '') + '</div></div>'
      + '<button class="rn-keluar" data-rn-keluar="1">Keluar</button></div>';
    h += '<div class="rn-tabs"><div class="rn-tabs-dalam">';
    TABS.forEach(function (t) {
      h += '<button class="rn-tab' + (t.id === tabAktif ? ' rn-tab-on' : '')
        + '" data-rn-tab="' + t.id + '">' + t.label + '</button>';
    });
    h += '</div></div>';
    h += '<div class="rn-isi' + (gelap ? '' : ' rn-terang') + '" id="rnIsi"></div>';
    el.ronceBody.innerHTML = h;
    el.rnIsi = $('#rnIsi');
  }

  function gambarIsi() {
    if (!el.rnIsi) return;
    var h = '';
    if (tabAktif === 'input') h = tabInput();
    else if (tabAktif === 'tugas') h = tabTugas();
    else if (tabAktif === 'rekap') h = tabRekap();
    else if (tabAktif === 'log') h = tabLog();
    else h = tabSetting();
    el.rnIsi.innerHTML = h;
  }

  function gambar() {
    if (layar === 'pilih') { layarPilih(); return; }
    if (layar === 'pin') { layarPin(); return; }
    kerangka();
    gambarIsi();
  }

  /* ------------------------------------------------------------------
     Peristiwa
     ------------------------------------------------------------------ */

  function ketikPin(k) {
    if (k === 'Kembali') { layar = 'pilih'; pesanPin = ''; pinTempu = ''; gambar(); return; }
    if (k === 'Ganti') { w.App && w.App.toast('Ubah PIN dari daftar akun'); return; }
    if (k === 'Clear') { pinTempu = ''; pesanPin = ''; gambar(); return; }
    if (k === 'Delete') { pinTempu = pinTempu.slice(0, -1); return; }
    pinTempu += k;
    if (pinTempu.length > 4) pinTempu = pinTempu.slice(-4);
    if (pinTempu.length === 4) {
      if (pinTempu === String((pilihPin || {}).pin)) {
        sesi = pilihPin;
        try { w.localStorage.setItem(KUNCI_SESI, sesi.id); } catch (e) {}
        pinTempu = ''; pesanPin = ''; layar = 'app'; tabAktif = 'input';
      } else {
        pinTempu = ''; pesanPin = 'PIN yang Anda masukkan salah. Silakan coba lagi.';
      }
    }
    gambar();
  }

  function padaKlik(e) {
    var t = e.target;
    var ambil = function (a) {
      var n = (t.closest) ? t.closest('[' + a + ']') : null;
      return n ? n.getAttribute(a) : null;
    };

    var pilih = ambil('data-rn-pilih');
    if (pilih) {
      pilihPin = cariMitra(pilih); pinTempu = ''; pesanPin = '';
      layar = 'pin'; gambar(); return;
    }
    if (ambil('data-rn-pin') !== null) { ketikPin(ambil('data-rn-pin')); return; }
    if (ambil('data-rn-kembali')) { layar = 'pilih'; pesanPin = ''; pinTempu = ''; gambar(); return; }
    if (ambil('data-rn-ganti')) { w.App && w.App.toast('Ubah PIN dari daftar akun'); return; }
    if (ambil('data-rn-keluar')) {
      sesi = null; layar = 'pilih'; pesanPin = '';
      try { w.localStorage.removeItem(KUNCI_SESI); } catch (er) {}
      gambar(); return;
    }
    if (ambil('data-rn-tutup')) { close(); return; }

    var tab = ambil('data-rn-tab');
    if (tab) { tabAktif = tab; kerangka(); gambarIsi(); return; }

    var f = ambil('data-rn-filter');
    if (f) {
      filter = f;
      if (f !== 'year') selectedMonth = -1;
      gambarIsi(); return;
    }

    var bayar = ambil('data-rn-bayar');
    if (bayar) {
      var mode = ambil('data-rn-mode') || 'full';
      var unpaid = saldoMitra(bayar);
      var nominal = mode === 'full' ? unpaid : unpaid;
      if (mode === 'cicil') {
        var v = w.prompt('Masukkan nominal pelunasan sebagian untuk '
          + (cariMitra(bayar) || {}).name, String(Math.round(unpaid / 2)));
        if (v === null) return;
        nominal = num(v);
        if (nominal <= 0) { w.App && w.App.toast('Nominal tidak valid'); return; }
      }
      eksekusiPelunasan(bayar, nominal, mode);
      gambarIsi();
      w.App && w.App.toast('Pembayaran dicatat ' + formatIDR(nominal));
      return;
    }

    var ht = ambil('data-rn-hapustugas');
    if (ht) { hapusTugas(ht); gambarIsi(); return; }
    var hg = ambil('data-rn-hapusgarapan');
    if (hg) { hapusGarapan(hg); gambarIsi(); return; }
    var sg = ambil('data-rn-setgarapan');
    if (sg) { toggleSet(sg); gambarIsi(); return; }

    if (t.id === 'rjSimpan') {
      var r = tambahJob();
      if (r.galat) { w.App && w.App.toast(r.galat); return; }
      gambarIsi(); w.App && w.App.toast('Pekerjaan tersimpan'); return;
    }
    if (t.id === 'rtTambah') { tambahItemTugas(); gambarIsi(); return; }
    if (t.id === 'rtKirim') {
      var r2 = serahkanTugas();
      if (r2.galat) { w.App && w.App.toast(r2.galat); return; }
      gambarIsi(); w.App && w.App.toast('Tugas diserahkan'); return;
    }
    if (t.id === 'rsTambah') {
      var r3 = tambahGarapan();
      if (r3.galat) { w.App && w.App.toast(r3.galat); return; }
      gambarIsi(); return;
    }
    if (t.id === 'rsTema') { gelap = !gelap; kerangka(); gambarIsi(); return; }
    if (t.id === 'rsBersihkan') {
      if (w.confirm('Bersihkan semua data riwayat dan reset saldo?')) {
        bersihkanSemua(); gambarIsi();
        w.App && w.App.toast('Data dibersihkan');
      }
      return;
    }
  }

  function padaUbah(e) {
    var t = e.target;
    if (t.id === 'rjGarapan') {
      var fee = feeOtomatis(t.value, ($('#rjQty') || {}).value);
      var f = $('#rjFee'); if (f) f.value = fee > 0 ? String(fee) : '';
    }
    if (t.id === 'rjQty') {
      var fee2 = feeOtomatis(($('#rjGarapan') || {}).value, t.value);
      var f2 = $('#rjFee'); if (f2) f2.value = fee2 > 0 ? String(fee2) : '';
    }
    if (t.id === 'rreBulan') { selectedMonth = num(t.value); gambarIsi(); }
  }

  /* ------------------------------------------------------------------
     Pembuka
     ------------------------------------------------------------------ */

  function open() {
    if (!el.ronce || !el.ronceBody) init();
    if (!el.ronce || !el.ronceBody) return;
    muat();
    // Pulihkan sesi bila ada akun login tersimpan.
    try {
      var uid = w.localStorage.getItem(KUNCI_SESI);
      var u = uid ? cariMitra(uid) : null;
      if (u) { sesi = u; layar = 'app'; }
    } catch (e) {}
    el.ronce.classList.remove('hidden');
    el.ronce.setAttribute('aria-hidden', 'false');
    gambar();
  }
  function close() {
    if (!el.ronce) return;
    el.ronce.classList.add('hidden');
    el.ronce.setAttribute('aria-hidden', 'true');
  }
  function init() {
    el.ronce = $('#ronce');
    el.ronceBody = $('#ronceBody');
    if (!el.ronce || !el.ronceBody) return;
    el.ronceBody.addEventListener('click', padaKlik);
    el.ronceBody.addEventListener('change', padaUbah);
    var t = w.document.querySelector('[data-ronce-open]');
    if (t) t.addEventListener('click', open);
  }

  w.Ronce = {
    init: init, open: open, close: close,
    // API untuk pengujian
    _data: function () { return data; },
    _muat: muat, _simpan: simpan,
    feeOtomatis: feeOtomatis, hargaPerSet: hargaPerSet,
    saldoMitra: saldoMitra, rekapMitra: rekapMitra,
    eksekusiPelunasan: eksekusiPelunasan,
    dalamPeriode: dalamPeriode,
    _setFilter: function (f, bulan) {
      filter = f;
      if (bulan !== undefined) selectedMonth = bulan;
      return filter;
    }
  };
})(window);