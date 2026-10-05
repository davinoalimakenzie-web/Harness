/* ===================================================================
   ronce.js - Kalkulator Ronce untuk miniapps NAVA.

   Struktur mengikuti aplikasi aslinya di kalkulator-garapan.ai.studio:

     Pilih Akun Mitra
        -> Masukkan PIN (4 digit)
             -> Lima tab: Setting, Input Pekerjaan, Tugas Mitra,
                           Rekap Gaji, Log Semua Aktivitas

   Perhitungan memakai rumus yang sama persis dengan aplikasi asal:

     saldo = jumlah ongkir setiap pekerjaan
             - jumlah pelunasan - jumlah penarikan

   Saldo positif berarti mitra punya sisa komisi. Saldo negatif berarti
   mitra masih punya kasbon. Transaksi bertipe titip tidak mengurangi
   saldo karena uangnya ditahan di kas, bukan dibayarkan ke mitra.

   Semua kelas tampilan memakai kelas mc- yang sudah ada di style.css.
   Kelas khusus layar akun dan keypad PIN ada di blok rn- pada
   style.css.
   =================================================================== */
(function (w) {
  'use strict';

  var KUNCI = 'mascim_ronce_v1';
  var KUNCI_AKUN = 'mascim_ronce_akun_v1';

  var AKUN_AWAL = [
    { id: 'davino', nama: 'Davino Alima kenzie', peran: 'Owner', pin: '1234' },
    { id: 'hima', nama: 'HIMA', peran: 'Admin', pin: '1234' },
    { id: 'umi', nama: 'UMI', peran: 'Admin', pin: '1234' }
  ];

  var el = {};
  var layar = 'pilih';        // pilih | pin | app
  var akunTerpilih = null;
  var tabAktif = 'masuk';
  var pesanPin = '';
  var pinTempu = '';

  var TABS = [
    { id: 'setting', label: 'Setting' },
    { id: 'masuk', label: 'Input Pekerjaan' },
    { id: 'tugas', label: 'Tugas Mitra' },
    { id: 'rekap', label: 'Rekap Gaji' },
    { id: 'log', label: 'Log Aktivitas' }
  ];

  function $(s) { return w.document.querySelector(s); }
  function esc(t) {
    return String(t === undefined || t === null ? '' : t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function num(v) {
    var n = parseInt(String(v === undefined || v === null ? '' : v)
      .replace(/[^0-9-]/g, ''), 10);
    return isNaN(n) ? 0 : n;
  }
  function rp(n) { return 'Rp' + num(n).toLocaleString('id-ID'); }

  /* ------------------------------------------------------------------
     Penyimpanan
     ------------------------------------------------------------------ */

  function akun() {
    try {
      var a = JSON.parse(w.localStorage.getItem(KUNCI_AKUN) || 'null');
      if (Array.isArray(a) && a.length) return a;
    } catch (e) {}
    return AKUN_AWAL.slice();
  }

  function simpanAkun(a) {
    try { w.localStorage.setItem(KUNCI_AKUN, JSON.stringify(a)); } catch (e) {}
  }

  var data = { pekerjaan: [], transaksi: [], tugas: [], log: [] };

  function muat() {
    try {
      var d = JSON.parse(w.localStorage.getItem(KUNCI) || 'null');
      if (d && typeof d === 'object') data = d;
    } catch (e) {}
    if (!Array.isArray(data.pekerjaan)) data.pekerjaan = [];
    if (!Array.isArray(data.transaksi)) data.transaksi = [];
    if (!Array.isArray(data.tugas)) data.tugas = [];
    if (!Array.isArray(data.log)) data.log = [];
  }

  function simpan() {
    try { w.localStorage.setItem(KUNCI, JSON.stringify(data)); } catch (e) {}
  }

  function catat(teks) {
    data.log.unshift({ waktu: new Date().toISOString(), teks: teks });
    if (data.log.length > 200) data.log.length = 200;
  }

  function uid() {
    return 'x' + Math.random().toString(36).slice(2, 9)
      + Date.now().toString(36).slice(-4);
  }

  /* ------------------------------------------------------------------
     Perhitungan - sama dengan allTimeEmployeeBalances di aplikasi asal
     ------------------------------------------------------------------ */

  function saldoMitra(id) {
    var komisi = 0, keluar = 0, i;
    for (i = 0; i < data.pekerjaan.length; i++) {
      if (data.pekerjaan[i].mitra === id) komisi += num(data.pekerjaan[i].ongkir);
    }
    for (i = 0; i < data.transaksi.length; i++) {
      var t = data.transaksi[i];
      if (t.mitra !== id) continue;
      // titip hanya ditahan di kas, jadi tidak mengurangi saldo.
      if (t.jenis === 'pelunasan' || t.jenis === 'penarikan') {
        keluar += num(t.nominal);
      }
    }
    return komisi - keluar;
  }

  function namaMitra(id) {
    var a = akun();
    for (var i = 0; i < a.length; i++) if (a[i].id === id) return a[i].nama;
    return id;
  }

  function rekapMitra() {
    var peta = {}, urutan = [], i, k;
    var sumber = [data.pekerjaan, data.transaksi, data.tugas];
    for (i = 0; i < sumber.length; i++) {
      for (k = 0; k < sumber[i].length; k++) {
        var m = sumber[i][k].mitra;
        if (m && !peta[m]) { peta[m] = 1; urutan.push(m); }
      }
    }
    var hasil = [];
    for (i = 0; i < urutan.length; i++) {
      var id = urutan[i], kerjaan = 0, komisi = 0;
      for (k = 0; k < data.pekerjaan.length; k++) {
        if (data.pekerjaan[k].mitra === id) {
          kerjaan++;
          komisi += num(data.pekerjaan[k].ongkir);
        }
      }
      hasil.push({
        id: id, nama: namaMitra(id), kerjaan: kerjaan,
        komisi: komisi, saldo: saldoMitra(id)
      });
    }
    hasil.sort(function (a, b) { return b.saldo - a.saldo; });
    return hasil;
  }

  function totalHak() {
    var r = rekapMitra(), t = 0, i;
    for (i = 0; i < r.length; i++) if (r[i].saldo > 0) t += r[i].saldo;
    return t;
  }

  /* ------------------------------------------------------------------
     Layar 1 - Pilih Akun Mitra
     ------------------------------------------------------------------ */

  function layarPilih() {
    var a = akun(), html = '', i;
    html += '<div class="rn-aksen">Kalkulator Ronce</div>';
    html += '<div class="rn-sub">Sistem Pencatatan Finansial &amp; Gaji Mitra</div>';
    html += '<div class="rn-aksen2">Pilih Akun Mitra</div>';
    if (!a.length) html += '<div class="mc-empty">Belum ada akun mitra.</div>';
    for (i = 0; i < a.length; i++) {
      html += '<button class="rn-akun" data-rn-pilih="' + esc(a[i].id) + '">'
        + '<span class="rn-avatar">'
        + esc(a[i].nama.slice(0, 2).toUpperCase()) + '</span>'
        + '<span class="mc-grow rn-akun-teks"><span class="rn-akun-nama">'
        + esc(a[i].nama) + '</span>'
        + '<span class="rn-akun-peran">' + esc(a[i].peran) + '</span></span>'
        + '<span class="rn-panah">›</span></button>';
    }
    el.ronceBody.innerHTML = html + '<div class="rn-kaki">© 2026 Kalkulator Ronce</div>';
  }

  /* ------------------------------------------------------------------
     Layar 2 - Masukkan PIN
     ------------------------------------------------------------------ */

  function layarPin() {
    var pin = akunTerpilih || {};
    var html = '';
    html += '<div class="rn-aksen">Kalkulator Ronce</div>';
    html += '<div class="rn-sub">Sistem Pencatatan Finansial &amp; Gaji Mitra</div>';
    html += '<div class="rn-atas"><button class="mc-ghost-btn" data-rn-pin="Kembali">'
      + 'Kembali</button><button class="mc-ghost-btn" data-rn-pin="Ganti">'
      + 'Ubah PIN Login</button></div>';
    html += '<div class="rn-avatar rn-avatar-besar">'
      + esc(String(pin.nama || '?').slice(0, 2).toUpperCase()) + '</div>';
    html += '<div class="rn-nama">' + esc(pin.nama || '') + '</div>';
    html += '<div class="rn-peran">' + esc(pin.peran || '') + '</div>';
    html += '<div class="rn-judul">Masukkan PIN</div>';
    html += '<div class="rn-ket">Masukkan 4 digit PIN Anda untuk masuk</div>';
    if (pesanPin) html += '<div class="rn-salah">' + esc(pesanPin) + '</div>';
    html += '<div class="rn-kolom">';
    var tombol = '1 2 3 4 5 6 7 8 9 Clear 0 Delete'.split(' ');
    for (var i = 0; i < tombol.length; i++) {
      html += '<button class="rn-key'
        + (tombol[i].length > 1 ? ' rn-key-ket' : '')
        + '" data-rn-pin="' + esc(tombol[i]) + '">' + esc(tombol[i]) + '</button>';
    }
    html += '</div>';
    html += '<div class="rn-kaki">© 2026 Kalkulator Ronce • PIN Auth Protocol</div>';
    el.ronceBody.innerHTML = html;
  }

  /* ------------------------------------------------------------------
     Layar 3 - Lima tab
     ------------------------------------------------------------------ */

  function kerangka() {
    var html = '';
    html += '<div class="mc-nav">'
      + '<button class="mc-back" data-rn-keluar="1" aria-label="Kembali">‹</button>'
      + '<div class="mc-grow"><div class="mc-bar-title">Kalkulator Ronce</div>'
      + '<div class="rn-mitra">' + esc(akunTerpilih.nama) + '</div></div>'
      + '<button class="mc-back" data-rn-tutup="1" aria-label="Tutup">×</button>'
      + '</div>';
    // Lima tab tidak muat dalam satu baris di layar sempit, jadi tabnya
    // digeser mendatar dan hanya tab aktif yang terlihat penuh.
    html += '<div class="rn-tabs"><div class="rn-tabs-dalam">';
    for (var i = 0; i < TABS.length; i++) {
      html += '<button class="rn-tab'
        + (TABS[i].id === tabAktif ? ' rn-tab-on' : '')
        + '" data-rn-tab="' + TABS[i].id + '">' + esc(TABS[i].label) + '</button>';
    }
    html += '</div></div>';
    html += '</div><div class="rn-isi" id="rnIsi"></div>';
    el.ronceBody.innerHTML = html;
    el.rnIsi = $('#rnIsi');
  }

  function opsiMitra() {
    var r = rekapMitra(), html = '', i;
    for (i = 0; i < r.length; i++) {
      html += '<option value="' + esc(r[i].id) + '">' + esc(r[i].nama) + '</option>';
    }
    if (!html) html = '<option value="">- belum ada mitra -</option>';
    return html;
  }

  function tabSetting() {
    var a = akun(), html = '', i;
    html += '<div class="mc-sec">Akun Mitra</div>';
    for (i = 0; i < a.length; i++) {
      html += '<div class="mc-card mc-prow"><div class="mc-grow">'
        + '<div class="rn-akun-nama">' + esc(a[i].nama) + '</div>'
        + '<div class="rn-akun-peran">' + esc(a[i].peran) + '</div></div>'
        + '<button class="mc-ghost-btn" data-rn-hapusakun="' + esc(a[i].id)
        + '">Hapus</button></div>';
    }
    html += '<div class="mc-row2"><input class="mc-inp" id="rnAkunNama" '
      + 'placeholder="Nama mitra">'
      + '<button class="mc-ghost-btn" id="rnAkunTambah">Tambah</button></div>';
    html += '<div class="mc-sec">Perhitungan</div>';
    html += '<div class="mc-note">Komisi mitra dihitung dari ongkir setiap pekerjaan. '
      + 'Pelunasan dan penarikan mengurangi saldo; titip hanya ditahan di kas.</div>';
    html += '<div class="mc-sec">Data</div>';
    html += '<button class="mc-ghost-btn mc-submit" id="rnHapusSemua">'
      + 'Hapus Semua Data</button>';
    return html;
  }

  function tabMasuk() {
    var html = '';
    html += '<div class="mc-sec">Tambah Pekerjaan</div>';
    html += '<div class="mc-card">';
    html += '<div class="mc-field"><div class="mc-lbl">Mitra</div>'
      + '<select class="mc-inp" id="rnMitra">' + opsiMitra() + '</select></div>';
    html += '<div class="mc-field"><div class="mc-lbl">Jenis Pekerjaan</div>'
      + '<input class="mc-inp" id="rnJenis" placeholder="contoh: Ganti LCD"></div>';
    html += '<div class="mc-row2">'
      + '<div class="mc-field mc-grow"><div class="mc-lbl">Jumlah</div>'
      + '<input class="mc-inp" id="rnJumlah" type="number" inputmode="numeric" '
      + 'value="1"></div>'
      + '<div class="mc-field mc-grow"><div class="mc-lbl">Ongkir / japan</div>'
      + '<input class="mc-inp" id="rnOngkir" inputmode="numeric" '
      + 'placeholder="20000"></div></div>';
    html += '<button class="mc-primary mc-submit" id="rnSimpan">Tambah</button>';
    html += '</div>';

    html += '<div class="mc-sec">Catat Transaksi Mitra</div>';
    html += '<div class="mc-card">';
    html += '<div class="mc-row2">'
      + '<div class="mc-field mc-grow"><div class="mc-lbl">Mitra</div>'
      + '<select class="mc-inp" id="rnTrxMitra">' + opsiMitra() + '</select></div>'
      + '<div class="mc-field mc-grow"><div class="mc-lbl">Jenis</div>'
      + '<select class="mc-inp" id="rnTrxJenis">'
      + '<option>Pelunasan</option><option>Penarikan</option><option>Titip</option>'
      + '</select></div></div>';
    html += '<div class="mc-field"><div class="mc-lbl">Nominal</div>'
      + '<input class="mc-inp" id="rnNominal" inputmode="numeric" '
      + 'placeholder="50000"></div>';
    html += '<button class="mc-primary mc-submit" id="rnCatat">'
      + 'Catat Transaksi</button>';
    html += '</div>';
    return html;
  }

  function tabTugas() {
    var html = '', i;
    html += '<div class="mc-sec">Tugas Mitra</div>';
    if (!data.tugas.length) {
      html += '<div class="mc-empty">Belum ada tugas mitra.</div>';
      return html;
    }
    for (i = 0; i < data.tugas.length; i++) {
      var g = data.tugas[i];
      html += '<div class="mc-card mc-prow"><div class="mc-grow">'
        + '<div class="rn-akun-nama">' + esc(g.judul) + '</div>'
        + '<div class="rn-akun-peran">' + esc(g.mitraNama || g.mitra)
        + '</div></div><button class="mc-ghost-btn" data-rn-hapustugas="'
        + esc(g.id) + '">Selesai</button></div>';
    }
    return html;
  }

  function tabRekap() {
    var r = rekapMitra(), html = '', i;
    var totalKerjaan = 0, totalKomisi = 0;
    for (i = 0; i < r.length; i++) {
      totalKerjaan += r[i].kerjaan;
      totalKomisi += r[i].komisi;
    }
    html += '<div class="mc-sec">Rekap Gaji Mitra</div>';
    html += '<div class="mc-kpi"><div class="mc-kpi-i"><div class="mc-lbl">'
      + 'Total kerjaan</div><div class="mc-money">' + totalKerjaan + '</div></div>'
      + '<div class="mc-kpi-i"><div class="mc-lbl">Total komisi</div>'
      + '<div class="mc-money">' + rp(totalKomisi) + '</div></div></div>';
    html += '<div class="mc-kv"><span>Total hak</span><b class="rn-hak">'
      + rp(totalHak()) + '</b></div>';
    if (!r.length) {
      html += '<div class="mc-empty">Belum ada kerjaan mitra.</div>';
      return html;
    }
    for (i = 0; i < r.length; i++) {
      var m = r[i], positif = m.saldo >= 0;
      html += '<div class="mc-card mc-prow"><div class="mc-grow">'
        + '<div class="rn-akun-nama">' + esc(m.nama) + '</div>'
        + '<div class="rn-akun-peran">' + m.kerjaan + ' kerjaan · komisi '
        + rp(m.komisi) + '</div></div><div class="mc-row-r">'
        + '<div class="mc-money">' + rp(Math.abs(m.saldo)) + '</div>'
        + '<div class="mc-badge' + (positif ? ' mc-badge-grn' : ' mc-warn')
        + '">' + (positif ? 'Sisa Komisi' : 'Sisa Kasbon') + '</div></div></div>';
    }
    return html;
  }

  function tabLog() {
    var html = '', i;
    html += '<div class="mc-sec">Log Semua Aktivitas</div>';
    if (!data.log.length) {
      html += '<div class="mc-empty">Belum ada aktivitas.</div>';
      return html;
    }
    for (i = 0; i < data.log.length; i++) {
      var l = data.log[i];
      html += '<div class="mc-card mc-prow"><div class="mc-grow">'
        + '<div class="rn-log-teks">' + esc(l.teks) + '</div>'
        + '<div class="rn-akun-peran">' + esc(waktuSingkat(l.waktu))
        + '</div></div></div>';
    }
    return html;
  }

  function waktuSingkat(iso) {
    try {
      return new Date(iso).toLocaleString('id-ID', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
    } catch (e) { return iso; }
  }

  function gambarIsi() {
    if (!el.rnIsi) return;
    var html = '';
    if (tabAktif === 'setting') html = tabSetting();
    else if (tabAktif === 'masuk') html = tabMasuk();
    else if (tabAktif === 'tugas') html = tabTugas();
    else if (tabAktif === 'rekap') html = tabRekap();
    else html = tabLog();
    el.rnIsi.innerHTML = html;
  }

  function gambar() {
    if (layar === 'pilih') { layarPilih(); return; }
    if (layar === 'pin') { layarPin(); return; }
    kerangka();
    gambarIsi();
  }

  /* ------------------------------------------------------------------
     Aksi
     ------------------------------------------------------------------ */

  function tambahPekerjaan() {
    var mitra = (($('#rnMitra') || {}).value) || '';
    var jenis = ((($('#rnJenis') || {}).value) || '').trim();
    var jumlah = Math.max(1, num(($('#rnJumlah') || {}).value) || 1);
    var ongkir = num(($('#rnOngkir') || {}).value);
    if (!mitra) { w.App && w.App.toast('Pilih mitra dulu'); return; }
    if (!jenis) { w.App && w.App.toast('Isi jenis pekerjaan'); return; }
    if (ongkir <= 0) { w.App && w.App.toast('Ongkir harus lebih dari 0'); return; }
    data.pekerjaan.push({
      id: uid(), mitra: mitra, jenis: jenis, jumlah: jumlah,
      ongkir: ongkir, waktu: new Date().toISOString()
    });
    catat(jenis + ' oleh ' + namaMitra(mitra) + ' - ongkir ' + rp(ongkir));
    simpan();
    gambar();
    w.App && w.App.toast('Pekerjaan ditambahkan');
  }

  function catatTransaksi() {
    var mitra = (($('#rnTrxMitra') || {}).value) || '';
    var jenis = (($('#rnTrxJenis') || {}).value) || 'Pelunasan';
    var nominal = num(($('#rnNominal') || {}).value);
    if (!mitra) { w.App && w.App.toast('Pilih mitra dulu'); return; }
    if (nominal <= 0) { w.App && w.App.toast('Nominal harus lebih dari 0'); return; }
    var kunci = jenis.toLowerCase();
    if (kunci !== 'penarikan' && kunci !== 'titip') kunci = 'pelunasan';
    data.transaksi.push({
      id: uid(), mitra: mitra, jenis: kunci, nominal: nominal,
      waktu: new Date().toISOString()
    });
    catat(jenis + ' ' + rp(nominal) + ' untuk ' + namaMitra(mitra));
    simpan();
    gambar();
    w.App && w.App.toast('Transaksi dicatat');
  }

  function tambahAkun() {
    var n = ((($('#rnAkunNama') || {}).value) || '').trim();
    if (!n) { w.App && w.App.toast('Isi nama mitra'); return; }
    var a = akun();
    a.push({ id: uid(), nama: n, peran: 'Mitra', pin: '1234' });
    simpanAkun(a);
    gambar();
    w.App && w.App.toast('Mitra ditambahkan');
  }

  function ketikPin(tombol) {
    var pin = akunTerpilih || {};
    if (tombol === 'Kembali') {
      layar = 'pilih'; pesanPin = ''; pinTempu = ''; gambar(); return;
    }
    if (tombol === 'Ganti') {
      w.App && w.App.toast('Ubah PIN dilakukan dari tab Setting setelah masuk');
      return;
    }
    if (tombol === 'Clear') { pinTempu = ''; pesanPin = ''; gambar(); return; }
    if (tombol === 'Delete') { pinTempu = pinTempu.slice(0, -1); return; }
    pinTempu += tombol;
    if (pinTempu.length > 4) pinTempu = pinTempu.slice(-4);
    if (pinTempu.length === 4) {
      if (pinTempu === String(pin.pin)) {
        pinTempu = '';
        layar = 'app';
        tabAktif = 'masuk';
        catat('Masuk sebagai ' + pin.nama);
        simpan();
      } else {
        pinTempu = '';
        pesanPin = 'PIN yang Anda masukkan salah. Silakan coba lagi.';
      }
    }
    gambar();
  }

  /* ------------------------------------------------------------------
     Peristiwa
     ------------------------------------------------------------------ */

  function padaKlik(e) {
    var t = e.target;
    var ambil = function (attr) {
      var n = (t.closest) ? t.closest('[' + attr + ']') : null;
      return n ? n.getAttribute(attr) : null;
    };

    if (el.ronceBody.contains && !el.ronceBody.contains(t)) return;

    var buka = ambil('data-rn-pilih');
    if (buka) {
      var a = akun(), i;
      for (i = 0; i < a.length; i++) {
        if (a[i].id === buka) { akunTerpilih = a[i]; break; }
      }
      pesanPin = ''; pinTempu = '';
      layar = 'pin';
      gambar();
      return;
    }

    if (ambil('data-rn-pin') !== null) { ketikPin(ambil('data-rn-pin')); return; }

    if (ambil('data-rn-keluar')) {
      layar = 'pilih'; pesanPin = ''; pinTempu = ''; akunTerpilih = null;
      gambar(); return;
    }
    if (ambil('data-rn-tutup')) { close(); return; }

    var tab = ambil('data-rn-tab');
    if (tab) { tabAktif = tab; kerangka(); gambarIsi(); return; }

    var ha = ambil('data-rn-hapusakun');
    if (ha) { simpanAkun(akun().filter(function (x) { return x.id !== ha; })); gambar(); return; }

    var ht = ambil('data-rn-hapustugas');
    if (ht) {
      data.tugas = data.tugas.filter(function (x) { return x.id !== ht; });
      simpan(); gambar(); return;
    }

    if (t.id === 'rnSimpan') { tambahPekerjaan(); return; }
    if (t.id === 'rnCatat') { catatTransaksi(); return; }
    if (t.id === 'rnAkunTambah') { tambahAkun(); return; }
    if (t.id === 'rnHapusSemua') {
      if (w.confirm('Hapus semua pekerjaan, transaksi, tugas, dan log?')) {
        data = { pekerjaan: [], transaksi: [], tugas: [], log: [] };
        simpan(); gambar();
        w.App && w.App.toast('Semua data dihapus');
      }
    }
  }

  /* ------------------------------------------------------------------
     Pembuka
     ------------------------------------------------------------------ */

  function open() {
    // init() biasanya sudah berjalan dari app.js, tetapi open() tidak
    // boleh melempar galat bila dipanggil lebih dulu.
    if (!el.ronce || !el.ronceBody) init();
    if (!el.ronce || !el.ronceBody) return;
    muat();
    el.ronce.classList.remove('hidden');
    el.ronce.setAttribute('aria-hidden', 'false');
    el.ronceBody.scrollTop = 0;
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
    var tombol = w.document.querySelector('[data-ronce-open]');
    if (tombol) tombol.addEventListener('click', open);
  }

  w.Ronce = {
    init: init, open: open, close: close,
    hitung: saldoMitra, rekap: rekapMitra, totalHak: totalHak
  };
})(window);