/* ===================================================================
   ronce.js - Kalkulator Komisi Mitra ("Kalkulator Ronce").

   Diambil dari aplikasi kalkulator-garapan. Yang dibawa ke sini hanya
   inti perhitungannya, tanpa Firebase, tanpa login, tanpa gaji karyawan.
   Yang dipindah:

     salary      = jumlah ongkir dari seluruh kerjaan mitra
     saldo       = salary - (pelunasan + penarikan)
     transaksi bertipe "titip" tidak mengurangi saldo, karena uangnya
                   ditahan di kas dan baru jadi milik mitra saat
                   dilunaskan.

  Sisa komisi positif berarti mitra masih punya hak. Saldo negatif
   berarti mitra masih punya kasbon, jadi owe-nya balik ke mitra.

   Rumus ini disalin apa adanya dari RekapGaji.tsx:

     jobs.forEach(job => {
       const earning = job.deliveryFee || 0;
       balances[job.employeeId] = (balances[job.employeeId] || 0) + earning;
     });
     transactions.forEach(tx => {
       if (tx.type === 'pelunasan' || tx.type === 'penarikan') {
         balances[tx.employeeId] = (balances[tx.employeeId] || 0) - tx.amount;
       }
     });
   =================================================================== */
(function (w) {
  'use strict';

  var JENIS = ['pelunasan', 'penarikan', 'titip'];

  /* ------------------------------------------------------------------
     Perhitungan inti. Murni, tanpa DOM, supaya bisa diuji langsung.
     ------------------------------------------------------------------ */
  function saldo(jobs, transaksi) {
    var out = {};
    function tambah(kunci, angka) {
      out[kunci] = (out[kunci] || 0) + angka;
    }
    (jobs || []).forEach(function (j) {
      // Kunci mitra memakai id, dan nama hanya sebagai cadangan untuk
      // data lama yang belum punya id.
      var k = j.employeeId || j.employeeName || 'Tanpa Nama';
      tambah(k, Number(j.deliveryFee) || 0);
    });
    (transaksi || []).forEach(function (t) {
      // Titip tidak mengurangi: uangnya masih di kas.
      if (t.type !== 'pelunasan' && t.type !== 'penarikan') return;
      var k = t.employeeId || t.employeeName || 'Tanpa Nama';
      tambah(k, -(Number(t.amount) || 0));
    });
    return out;
  }

  /* Rekap satu mitra: total kerjaan, komisi, sudah dibayar, sisa. */
  function rekap(jobs, transaksi, employeeId) {
    var milik = (jobs || []).filter(function (j) {
      return (j.employeeId || j.employeeName) === employeeId;
    });
    var jumlahKerjaan = milik.reduce(function (n, j) { return n + (Number(j.quantity) || 0); }, 0);
    var komisi = milik.reduce(function (n, j) { return n + (Number(j.deliveryFee) || 0); }, 0);
    var sudah = (transaksi || []).filter(function (t) {
      return (t.employeeId || t.employeeName) === employeeId &&
        (t.type === 'pelunasan' || t.type === 'penarikan');
    }).reduce(function (n, t) { return n + (Number(t.amount) || 0); }, 0);
    var titip = (transaksi || []).filter(function (t) {
      return (t.employeeId || t.employeeName) === employeeId && t.type === 'titip';
    }).reduce(function (n, t) { return n + (Number(t.amount) || 0); }, 0);
    var sisa = komisi - sudah;
    return {
      employeeId: employeeId,
      totalKerjaan: jumlahKerjaan,
      komisi: komisi,
      sudahDibayar: sudah,
      titip: titip,
      sisa: sisa,
      kasbon: sisa < 0 ? -sisa : 0,
      punyaHak: sisa > 0 ? sisa : 0
    };
  }

  /* Urutan baris rekap: yang paling besar komisinya dulu. */
  function semuaMitra(jobs, transaksi) {
    var ids = {};
    (jobs || []).forEach(function (j) {
      var k = j.employeeId || j.employeeName;
      if (k) ids[k] = j.employeeName || k;
    });
    (transaksi || []).forEach(function (t) {
      var k = t.employeeId || t.employeeName;
      if (k) ids[k] = t.employeeName || ids[k] || k;
    });
    var semua = saldo(jobs, transaksi);
    var hasil = [];
    for (var k in semua) {
      if (!Object.prototype.hasOwnProperty.call(semua, k)) continue;
      var r = rekap(jobs, transaksi, k);
      r.nama = ids[k] || k;
      hasil.push(r);
    }
    hasil.sort(function (a, b) { return b.komisi - a.komisi; });
    return hasil;
  }

  /* ------------------------------------------------------------------
     Penyimpanan lokal, terpisah dari data nota supaya tidak bercampur.
     ------------------------------------------------------------------ */
  var KUNCI = 'mascim_ronce_v1';

  function muat() {
    try {
      var mentah = w.localStorage.getItem(KUNCI);
      var d = mentah ? JSON.parse(mentah) : null;
      if (!d || typeof d !== 'object') d = {};
      if (!Array.isArray(d.jobs)) d.jobs = [];
      if (!Array.isArray(d.transaksi)) d.transaksi = [];
      return d;
    } catch (e) { return { jobs: [], transaksi: [] }; }
  }

  function simpan(d) {
    try { w.localStorage.setItem(KUNCI, JSON.stringify(d)); } catch (e) {}
    return d;
  }

  /* ------------------------------------------------------------------
     Antarmuka. Ditaruh di panel "Lainnya" pada Kalkulator.
     ------------------------------------------------------------------ */
  var host = null;
  var draf = null;

  function esc(t) {
    return String(t == null ? '' : t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function angka(v) {
    var n = Math.round(Number(v) || 0);
    if (isNaN(n)) n = 0;
    return 'Rp' + n.toLocaleString('id-ID');
  }

  function rupiah(v) {
    return String(v == null ? '' : v).replace(/\D/g, '');
  }

  function tambahJob(nama, layanan, jumlah, ongkir, tanggal) {
    var d = muat();
    d.jobs.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      employeeId: nama, employeeName: nama,
      serviceId: layanan || '', quantity: Math.max(1, Number(jumlah) || 1),
      deliveryFee: Math.max(0, Math.round(Number(ongkir) || 0)),
      date: tanggal || new Date().toISOString().slice(0, 10),
      status: 'pending'
    });
    simpan(d);
  }

  function tambahTransaksi(nama, tipe, jumlah, tanggal) {
    var d = muat();
    d.transaksi.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      employeeId: nama, employeeName: nama,
      type: JENIS.indexOf(tipe) >= 0 ? tipe : 'pelunasan',
      amount: Math.max(0, Math.round(Number(jumlah) || 0)),
      date: tanggal || new Date().toISOString().slice(0, 10),
      createdAt: Date.now()
    });
    simpan(d);
  }

  function hapus(id) {
    var d = muat();
    d.jobs = d.jobs.filter(function (x) { return x.id !== id; });
    d.transaksi = d.transaksi.filter(function (x) { return x.id !== id; });
    simpan(d);
  }

  function kosongkan() {
    simpan({ jobs: [], transaksi: [] });
  }

  function ringkas() {
    var d = muat();
    var list = semuaMitra(d.jobs, d.transaksi);
    var totalKomisi = list.reduce(function (n, r) { return n + r.komisi; }, 0);
    var totalHak = list.reduce(function (n, r) { return n + r.punyaHak; }, 0);
    var totalKasbon = list.reduce(function (n, r) { return n + r.kasbon; }, 0);
    var totalTitip = list.reduce(function (n, r) { return n + r.titip; }, 0);
    return {
      list: list, totalKomisi: totalKomisi, totalHak: totalHak,
      totalKasbon: totalKasbon, totalTitip: totalTitip,
      totalKerjaan: d.jobs.reduce(function (n, j) { return n + (Number(j.quantity) || 0); }, 0)
    };
  }

  /* ------------------------------------------------------------------
     Render. Sengaja memakai kelas yang sudah ada supaya tidak perlu CSS
     baru dan tidak risiko merusak tampilan Kalkulator.
     ------------------------------------------------------------------ */
  function render() {
    if (!host) return;
    var r = ringkas();

    var baris = r.list.map(function (x) {
      var ket = x.sisa < 0
        ? '<span style="color:#e05a5a">Sisa Kasbon ' + angka(x.kasbon) + '</span>'
        : '<span style="color:#35d07f">Sisa Komisi ' + angka(x.punyaHak) + '</span>';
      return '<tr>' +
        '<td style="padding:6px 4px">' + esc(x.nama) + '</td>' +
        '<td style="padding:6px 4px;text-align:right">' + x.totalKerjaan + '</td>' +
        '<td style="padding:6px 4px;text-align:right">' + angka(x.komisi) + '</td>' +
        '<td style="padding:6px 4px;text-align:right">' + angka(x.sudahDibayar) + '</td>' +
        '<td style="padding:6px 4px;text-align:right">' + ket + '</td>' +
        '</tr>';
    }).join('');

    host.innerHTML =
      '<div class="mc-sec" style="margin-bottom:8px">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px">' +
          '<span>Kalkulator Ronce</span>' +
          '<button type="button" class="mc-ghost-btn" data-ronce-reset>Hapus Semua</button>' +
        '</div>' +
        '<div class="mc-hint sm" style="margin-top:6px">' +
          'Komisi mitra dihitung dari ongkir setiap kerjaan. Pelunasan dan ' +
          'penarikan mengurangi saldo; titip hanya ditahan di kas.' +
        '</div>' +
      '</div>' +

      '<div class="k-card" style="margin-bottom:8px">' +
        '<div class="k-label">Nama Mitra</div>' +
        '<input id="rNama" class="k-input" value="' + esc(draf.nama) + '" placeholder="contoh: Budi">' +
        '<div class="k-label" style="margin-top:8px">Jenis Pekerjaan</div>' +
        '<input id="rLayanan" class="k-input" value="' + esc(draf.layanan) + '" placeholder="contoh: Ganti LCD">' +
        '<div style="display:flex;gap:8px;margin-top:8px">' +
          '<div style="flex:1">' +
            '<div class="k-label">Jumlah</div>' +
            '<input id="rJumlah" class="k-input" type="number" inputmode="numeric" value="' + esc(draf.jumlah) + '">' +
          '</div>' +
          '<div style="flex:1">' +
            '<div class="k-label">Ongkir / japan</div>' +
            '<input id="rOngkir" class="k-input" inputmode="numeric" value="' + esc(draf.ongkir) + '" placeholder="20000">' +
          '</div>' +
        '</div>' +
        '<button type="button" class="mc-primary-btn" data-ronce-add style="margin-top:10px;width:100%">' +
          'Tambah Kerjaan' +
        '</button>' +
      '</div>' +

      '<div class="k-card" style="margin-bottom:8px">' +
        '<div class="k-label">Catat Transaksi Mitra</div>' +
        '<div style="display:flex;gap:8px;margin-top:4px">' +
          '<div style="flex:1">' +
            '<div class="k-label">Jenis</div>' +
            '<select id="rTipe" class="k-input">' +
              '<option value="pelunasan"' + (draf.tipe === 'pelunasan' ? ' selected' : '') + '>Pelunasan</option>' +
              '<option value="penarikan"' + (draf.tipe === 'penarikan' ? ' selected' : '') + '>Penarikan</option>' +
              '<option value="titip"' + (draf.tipe === 'titip' ? ' selected' : '') + '>Titip (kas)</option>' +
            '</select>' +
          '</div>' +
          '<div style="flex:1">' +
            '<div class="k-label">Nominal</div>' +
            '<input id="rNominal" class="k-input" inputmode="numeric" value="' + esc(draf.nominal) + '" placeholder="50000">' +
          '</div>' +
        '</div>' +
        '<button type="button" class="mc-ghost-btn" data-ronce-trx style="margin-top:10px;width:100%">' +
          'Catat Transaksi' +
        '</button>' +
      '</div>' +

      '<div class="k-card">' +
        '<div class="k-label">Rekap Gaji Mitra</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 4px;font-size:12px">' +
          '<span>Total kerjaan: <b>' + r.totalKerjaan + '</b></span>' +
          '<span>Total komisi: <b>' + angka(r.totalKomisi) + '</b></span>' +
        '</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;font-size:12px">' +
          '<span style="color:#35d07f">Total hak: <b>' + angka(r.totalHak) + '</b></span>' +
          (r.totalKasbon > 0 ? '<span style="color:#e05a5a">Total kasbon: <b>' + angka(r.totalKasbon) + '</b></span>' : '') +
          (r.totalTitip > 0 ? '<span style="color:#e0b400">Total titip: <b>' + angka(r.totalTitip) + '</b></span>' : '') +
        '</div>' +
        (baris
          ? '<div style="overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">' +
            '<thead><tr style="opacity:.7;text-align:left">' +
              '<th style="padding:4px">Mitra</th><th style="text-align:right">Qty</th>' +
              '<th style="text-align:right">Komisi</th><th style="text-align:right">Dibayar</th>' +
              '<th style="text-align:right">Sisa</th></tr></thead>' +
            '<tbody>' + baris + '</tbody></table></div>'
          : '<div class="mc-empty">Belum ada kerjaan mitra.</div>') +
      '</div>';

    ikat();
  }

  /* ------------------------------------------------------------------
     Pembaruan draf dan penangan peristiwa. Dipisah dari render supaya
     ketikan tidak membangun ulang seluruh panel.
     ------------------------------------------------------------------ */
  function bacaDraf() {
    if (!draf) draf = { nama: '', layanan: '', jumlah: 1, ongkir: '', tipe: 'pelunasan', nominal: '' };
    return draf;
  }

  function ikat() {
    var n = host.querySelector('#rNama'); if (n) n.oninput = function () { bacaDraf().nama = this.value; };
    var l = host.querySelector('#rLayanan'); if (l) l.oninput = function () { bacaDraf().layanan = this.value; };
    var j = host.querySelector('#rJumlah'); if (j) j.oninput = function () { bacaDraf().jumlah = this.value; };
    var o = host.querySelector('#rOngkir'); if (o) o.oninput = function () { bacaDraf().ongkir = rupiah(this.value); };
    var t = host.querySelector('#rTipe'); if (t) t.onchange = function () { bacaDraf().tipe = this.value; };
    var m = host.querySelector('#rNominal'); if (m) m.oninput = function () { bacaDraf().nominal = rupiah(this.value); };

    var add = host.querySelector('[data-ronce-add]');
    if (add) add.onclick = function () {
      var d = bacaDraf();
      if (!d.nama.trim()) { w.App && w.App.toast('Nama mitra wajib diisi'); return; }
      if (!(Number(d.ongkir) > 0)) { w.App && w.App.toast('Ongkir / japan harus lebih dari nol'); return; }
      tambahJob(d.nama.trim(), d.layanan.trim(), d.jumlah, d.ongkir);
      d.layanan = ''; d.jumlah = 1; d.ongkir = '';
      render();
      if (w.TG) w.TG.haptic('success');
    };

    var trx = host.querySelector('[data-ronce-trx]');
    if (trx) trx.onclick = function () {
      var d = bacaDraf();
      if (!d.nama.trim()) { w.App && w.App.toast('Nama mitra wajib diisi'); return; }
      if (!(Number(d.nominal) > 0)) { w.App && w.App.toast('Nominal harus lebih dari nol'); return; }
      tambahTransaksi(d.nama.trim(), d.tipe, d.nominal);
      d.nominal = '';
      render();
      if (w.TG) w.TG.haptic('success');
    };

    var reset = host.querySelector('[data-ronce-reset]');
    if (reset) reset.onclick = function () {
      if (w.confirm) w.confirm('Hapus semua rekap gaji mitra?');
      kosongkan();
      render();
    };
  }

  w.Ronce = {
    // Logika murni, bisa dipakai dan diuji tanpa peramban.
    saldo: saldo,
    rekap: rekap,
    semuaMitra: semuaMitra,
    ringkas: ringkas,
    muat: muat,
    simpan: simpan,
    tambahJob: tambahJob,
    tambahTransaksi: tambahTransaksi,
    hapus: hapus,
    kosongkan: kosongkan,
    render: function (el) { host = el; bacaDraf(); render(); },

    /* ----------------------------------------------------------------
       Overlay penuh, mengikuti pola modul Mas Cim: satu panel yang
       menutupi layar dan punya tombol kembali sendiri.
       ---------------------------------------------------------------- */
    open: function () {
      var m = w.document.getElementById('ronce');
      if (!m) return;
      host = w.document.getElementById('ronceBody');
      m.classList.remove('hidden');
      m.setAttribute('aria-hidden', 'false');
      if (w.document.body && w.document.body.classList) {
        w.document.body.classList.add('mc-open');
      }
      bacaDraf();
      render();
    },

    close: function () {
      var m = w.document.getElementById('ronce');
      if (!m) return;
      m.classList.add('hidden');
      m.setAttribute('aria-hidden', 'true');
      if (w.document.body && w.document.body.classList) {
        w.document.body.classList.remove('mc-open');
      }
    },

    init: function () {
      // Tombol di tab Lainnya. Pakai data-ronce-open supaya tidak ikut
      // ditangani router App.go() yang hanya untuk view utama.
      var tool = w.document.querySelector('[data-ronce-open]');
      if (tool && !tool.dataset.ronceBound) {
        tool.dataset.ronceBound = '1';
        tool.addEventListener('click', function (e) {
          e.preventDefault();
          w.Ronce.open();
        });
      }
      var back = w.document.getElementById('ronceBack');
      if (back && !back.dataset.ronceBound) {
        back.dataset.ronceBound = '1';
        back.addEventListener('click', function () {
          w.Ronce.close();
          if (w.TG) w.TG.haptic('select');
        });
      }
      var reset = w.document.getElementById('ronceReset');
      if (reset && !reset.dataset.ronceBound) {
        reset.dataset.ronceBound = '1';
        reset.addEventListener('click', function () {
          var ok = true;
          if (w.confirm) ok = w.confirm('Hapus semua rekap gaji mitra?');
          if (!ok) return;
          kosongkan();
          render();
          if (w.TG) w.TG.haptic('warning');
        });
      }
    },

    JENIS: JENIS
  };
})(window);