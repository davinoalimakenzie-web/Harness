/* =========================================================
   mascim.js — Modul "Mas Cim Service HP"
   =========================================================
   Modul mandiri di dalam Project Nava, dibuka dari tab
   Lainnya > Alat (atau perintah /mascim di bot).

   Data nota disimpan LOKAL di perangkat (localStorage lewat mesin
   data mascim-local.js), bukan di server, supaya modul tetap
   berfungsi penuh saat offline atau koneksi putus. Server/hosting
   (kalau nanti aktif) hanya dipakai untuk sinkron antar perangkat.
   Semua nominal tetap dihitung satu kali di mesin data agar tidak
   mungkin berbeda antar tampilan.

   Navigasi modul (maksimal empat menu sesuai PRD):
     Beranda | Servis | [ + ] Tambah | Keuangan
   Keuangan hanya satu tampilan: Cashflow modul servis. Dana Bank sudah
   pindah ke Beranda Project Nava.
   ========================================================= */
(function (w) {
  'use strict';

  // Helper DOM — module ini tidak punya $ bawaan, jadi definisikan di sini
  // supaya setiap $(...) di bawah tidak ReferenceError. Ini akar penyebab
  // tombol Tambah Pembayaran "tidak berfungsi" di produksi: onOpen callback
  // tidak pernah diuji karena test-nya stub App.sheet.
  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  // Pengait event yang tahan banting: kalau elemennya tidak ada (mis. tombol
  // hanya dirender pada status tertentu), fungsi ini dilewati tanpa error.
  // Tanpa ini, satu .addEventListener pada elemen null melempar error dan
  // SEMUA pengait lain di fungsi yang sama ikut mati — bug yang pernah membuat
  // seluruh tombol Mas Cim tidak berfungsi sekaligus.
  var on = function (el, ev, fn) {
    if (!el) return false;
    try { el.addEventListener(ev, fn); return true; } catch (e) { return false; }
  };
  var onAll = function (list, ev, fn) {
    if (!list) return 0;
    var n = 0;
    for (var i = 0; i < list.length; i++) { if (on(list[i], ev, fn)) n++; }
    return n;
  };

  // Semua akses data modul ini lewat fungsi `api` di bagian bawah, yang
  // langsung memanggil mesin data lokal (mascim-local.js). Tidak ada
  // jaringan, tidak ada server.

  /* ---------------- state modul ---------------- */
  // Dipasang satu kali saja supaya listener "klik di luar" tidak menumpuk
  // setiap kali layar detail dirender ulang.
  var dropOutsideBound = false;

  var M = {
    view: 'home',        // home | list | form | detail | money
    tab: 'cashflow',     // cashflow | bank
    editing: null,       // id nota saat edit
    draft: null,         // isian form
    lock: false,         // kunci tombol Simpan saat proses berjalan
    settings: null,
    list: [],
    current: null,
    search: '',
    filter: 'all',       // all | today | month | range
    status: '',          // filter status dari kartu status di Beranda
    from: '', to: ''
  };

  /*
     Status & jenis kunci diambil dari mesin data lokal (mascim-local.js)
     supaya hanya ada satu daftar kebenaran. Kalau modul lokal belum termuat,
     dipakai daftar cadangan yang sama persis.
  */
  var L = w.MascimLocal || {};
  var SERVICE_STATUSES = L.SERVICE_STATUSES ||
    ['Progress', 'Done', 'Done Diambil', 'Cancel', 'Cancel Diambil', 'Nggandul'];
  var PAYMENT_STATUSES = ['Belum Bayar', 'DP', 'Lunas'];
  // "Pola" sengaja tidak ada: underpin garis/coratnya tidak berfungsi,
  // jadi jenis kunci itu dihapus supaya tidak dipilih.
  var LOCK_TYPES = L.LOCK_TYPES || ['Tanpa Kunci', 'PIN', 'Password'];
  // Sparepart selalu memakai Dana Bank, jadi tidak ada pilihan sumber dana.

  // Pilihan status yang VALID saat mengubah status (dropdown konteks).
  // Dibaca dari mesin data supaya aturan UI dan aturan penyimpanan tidak
  // pernah berbeda: hanya status yang masuk akal secara bisnis yang ditawarkan.
  var STATUS_TRANS = L.STATUS_TRANS || {
    'Progress': ['Done', 'Cancel'],
    'Done': ['Done Diambil'],
    'Cancel': ['Cancel Diambil'],
    'Done Diambil': [],
    'Cancel Diambil': [],
    'Nggandul': ['Progress', 'Done', 'Cancel', 'Done Diambil', 'Cancel Diambil']
  };
  // Garansi & metode pembayaran juga ikut dari mesin data.
  var WARRANTY_OPTIONS = L.WARRANTY_OPTIONS || ['30 Hari', '60 Hari', 'Non Garansi'];
  var PAYMENT_METHODS = L.PAYMENT_METHODS || ['Tunai', 'Qriss', 'Campuran (Tunai dan Qriss)'];
  var INITIAL_STATUS = L.INITIAL_STATUS || 'Progress';

  /* ---------------- util ---------------- */
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }

  /* Pengaman: satu elemen hilang tidak boleh mematikan semua tombol lain.
     Semua pemanggilan addEventListener pada elemen tunggal memakai ini. */
  function on(sel, ev, fn, root) {
    var el = $(sel, root);
    if (!el) return false;
    try { el.addEventListener(ev, fn); } catch (e) { return false; }
    return true;
  }
  function onAll(sel, ev, fn, root) {
    var list = $$(sel, root);
    for (var i = 0; i < list.length; i++) {
      try { list[i].addEventListener(ev, fn); } catch (e) { /* abaikan satu elemen */ }
    }
    return list.length;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function rupiah(n) {
    return 'Rp' + Math.round(Number(n) || 0).toLocaleString('id-ID');
  }
  function ringkas(n) {
    n = Math.round(Number(n) || 0);
    if (Math.abs(n) >= 1000000000) return (n / 1000000000).toFixed(1).replace('.0', '') + ' M';
    if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(1).replace('.0', '') + ' jt';
    if (Math.abs(n) >= 1000) return Math.round(n / 1000) + ' rb';
    return String(n);
  }
  function tgl(iso) {
    if (!iso) return '-';
    var d = new Date(iso);
    if (isNaN(d)) return '-';
    return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function tglJam(iso) {
    if (!iso) return '-';
    var d = new Date(iso);
    if (isNaN(d)) return '-';
    return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) +
      ' ' + d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  }
  function hariIni() { return new Date().toISOString().slice(0, 10); }
  function bulanIni() { return new Date().toISOString().slice(0, 8) + '01'; }
  function toast(msg) { if (w.App && w.App.toast) w.App.toast(msg); }

  /** Ambil screen modul, atau buat bila belum ada. */
  function screen() { return $('#mcScreen'); }

  function setBar(sub) {
    var el = $('#mcBarSub');
    if (el) el.textContent = sub;
  }

  function render() {
    var s = screen();
    if (!s) return;
    if (M.view === 'home') renderHome(s);
    else if (M.view === 'list') renderList(s);
    else if (M.view === 'form') renderForm(s);
    else if (M.view === 'detail') renderDetail(s);
    else if (M.view === 'money') renderMoney(s);
  }

  /* =========================================================
     BERANDA — ringkasan + tombol utama + 5 servis terbaru
     ========================================================= */
  function renderHome(s) {
    setBar('Beranda');
    var d = M.dash;
    if (!d) { s.innerHTML = skeleton(); return; }

    s.innerHTML =
      '<div class="mc-pad">' +
        '<div class="mc-hero">' +
          '<div class="mc-hero-lbl">Saldo Cashflow</div>' +
          '<div class="mc-hero-val ' + (d.saldoCashflow >= 0 ? 'pos' : 'neg') + '">' + rupiah(d.saldoCashflow) + '</div>' +
          '<div class="mc-hero-sub">Dana Bank ada di Beranda Nava: ' + rupiah(d.saldoBank) + '</div>' +
        '</div>' +

        '<div class="mc-stats">' + statusCards(d) + '</div>' +

        '<div class="mc-nggwrap">' + nggantungCard(d) + '</div>' +

        (d.nggandul > 0
          ? '<button class="mc-ngg" data-mv="list" data-ngg="1">' +
              '<b>' + d.nggandul + ' nota Nggandul</b>' +
              '<span>Data nota berubah — status perlu dikonfirmasi. Ketuk untuk lihat.</span>' +
            '</button>'
          : '') +

        '<div class="mc-nav">' +
          '<button data-mv="list"><b>Servis</b><span>Daftar &amp; pencarian</span></button>' +
          '<button data-mv="money"><b>Keuangan</b><span>Cashflow servis</span></button>' +
        '</div>' +

        '<button class="mc-primary" data-mv="form">+&nbsp; Tambah Servis</button>' +

        '<div class="mc-sec">5 Servis Terbaru</div>' +
        (d.recent.length
          ? d.recent.map(orderCard).join('')
          : '<p class="mc-empty">Belum ada servis. Tekan <b>Tambah Servis</b> untuk mulai.</p>') +
      '</div>';
  }

  /* ------------------------------------------------------------------
     Area pola 3x3.

     Menyimpan koordinat titik yang BENAR-BENAR disentuh jarinya, jadi pola
     hanya bisa dibuka dengan coretan yang sama. Grid 3x3 dipakai hanya
     sebagai alat bantu visual + penangkap titik; yang dibandingkan
     nanti adalah jarak antar titik (lihat matchPattern di mesin data).
  ------------------------------------------------------------------ */
  function patternPad(value) {
    var saved = (window.MascimLocal && MascimLocal.parsePattern) ? MascimLocal.parsePattern(value || '') : [];
    var dots = '';
    for (var i = 0; i < 9; i++) dots += '<i class="mc-pdot" data-dot="' + i + '"></i>';
    return '<div class="mc-pat-wrap">' +
      '<input type="hidden" id="fPatSecret" value="' + esc(value || '') + '">' +
      '<div class="mc-pat" id="fPat" role="group" aria-label="Area pola">' +
        '<svg class="mc-pcanvas" id="fPatLine" viewBox="0 0 100 100" preserveAspectRatio="none"></svg>' +
        '<div class="mc-pgrid">' + dots + '</div>' +
        '<div class="mc-phint" id="fPatHint">Ketuk lalu tarik untuk menggambar pola</div>' +
      '</div>' +
      '<button type="button" class="mc-primary full" id="fPatSave">Simpan Pola</button>' +
    '</div>';
  }

  /**
     Pasang perekam pola pada area #fPat. Pointer dipakai (bukan touch/ mouse)
     supaya tetap jalan di HP maupun di browser desktop.
  */
  function bindPatternPad(secretOut) {
    // Area pola dicari dari INDUK input tersembunyinya, bukan dari seluruh
    // dokumen. Area uji di halaman Data memakai kode yang sama seperti
    // form, jadi keduanya bisa hidup berdampingan; pencarian global akan
    // terpasang ke area yang salah.
    var wrap = secretOut ? secretOut.parentNode : null;
    var pad = wrap ? wrap.querySelector('.mc-pat')
                   : document.getElementById('fPat');
    if (!pad) return;
    var line = pad.querySelector('.mc-pcanvas');
    var hint = pad.querySelector('.mc-phint');
    if (!line) return;
    var grid = pad.querySelector('.mc-pgrid');
    var nodeList = pad.querySelectorAll('.mc-dot, .mc-pdot');
    var tracing = false, pts = [], drawn = [];

    function rect() { return grid.getBoundingClientRect(); }
    function clearLine() {
      line.innerHTML = '';
      for (var i = 0; i < nodeList.length; i++) nodeList[i].classList.remove('on', 'hit');
    }
    function drawLine() {
      if (pts.length < 2) { line.innerHTML = ''; return; }
      var r = rect();
      if (!r.width || !r.height) return;
      var d = '';
      for (var i = 0; i < pts.length; i++) {
        var x = ((pts[i].x - r.left) / r.width) * 100;
        var y = ((pts[i].y - r.top) / r.height) * 100;
        d += (i ? 'L' : 'M') + x.toFixed(2) + ' ' + y.toFixed(2) + ' ';
      }
      line.innerHTML = '<path d="' + d + '" fill="none" stroke="currentColor" stroke-width="2.5" ' +
        'stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>';
    }
    function light(idx) {
      var el = pad.querySelector('[data-dot="' + idx + '"]');
      if (el) el.classList.add('hit');
    }
    // Titik terdekat dalam radius wajar -> dianggap menyentuh titik pola.
    function nearest(cx, cy) {
      var r = rect();
      if (!r.width) return -1;
      var radius = Math.max(r.width, r.height) * 0.13;
      var best = -1, bestD = radius;
      nodeList.forEach(function (el, i) {
        var b = el.getBoundingClientRect();
        var dx = (b.left + b.width / 2) - cx, dy = (b.top + b.height / 2) - cy;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d < bestD) { bestD = d; best = i; }
      });
      return best;
    }
    function down(ev) {
      ev.preventDefault();
      tracing = true; pts = []; drawn = [];
      clearLine();
      var r = rect();
      pts.push({ x: ev.clientX, y: ev.clientY });
      var n = nearest(ev.clientX, ev.clientY);
      if (n >= 0) { drawn.push(n); light(n); }
      if (hint) hint.textContent = 'Lanjutkan sampai pola selesai';
      try { pad.setPointerCapture(ev.pointerId); } catch (e) { /* abaikan */ }
    }
    function move(ev) {
      if (!tracing) return;
      ev.preventDefault();
      var last = pts[pts.length - 1];
      // Jarak antar titik Sampling supaya jalan tetap halus di HP.
      if (last && Math.abs(ev.clientX - last.x) + Math.abs(ev.clientY - last.y) < 4) return;
      pts.push({ x: ev.clientX, y: ev.clientY });
      var n = nearest(ev.clientX, ev.clientY);
      if (n >= 0 && drawn.indexOf(n) < 0) { drawn.push(n); light(n); }
      drawLine();
    }
    function selesai() {
      if (hint) hint.textContent = 'Pola tersimpan: ' + drawn.length + ' titik. Ketuk ulang untuk mengganti.';
      pad.dispatchEvent(new Event('patternchange'));
    }
    function up() {
      if (!tracing) return;
      tracing = false;
      if (!drawn.length) { clearLine(); if (hint) hint.textContent = 'Ketuk lalu tarik untuk menggambar pola'; return; }
      // Simpan sebagai koordinat ternormalisasi 0..1 milik tiap titik.
      var out = [];
      for (var i = 0; i < drawn.length; i++) {
        var el = pad.querySelector('[data-dot="' + drawn[i] + '"]');
        var b = el.getBoundingClientRect();
        var r = rect();
        out.push((((b.left + b.width / 2) - r.left) / r.width).toFixed(4) + ',' +
                 (((b.top + b.height / 2) - r.top) / r.height).toFixed(4));
      }
      if (secretOut) secretOut.value = out.join(';');
      // Beri tahu bagian luar. Tanpa event ini, draft tidak pernah ikut
      // terisi dan pola yang digambar hilang saat form disimpan.
      selesai();
    }
    // Listener sentuh di beberapa WebView Treats sebagai pasif secara
    // default, sehingga preventDefault diabaikan dan gesture browser
    // membatalkan pointer di tengah jalan.
    pad.addEventListener('pointerdown', down, { passive: false });
    pad.addEventListener('pointermove', move, { passive: false });
    pad.addEventListener('pointerup', up, { passive: false });
    pad.addEventListener('pointercancel', function () {
      // Dibatalkan bukan berarti gagal: selesaikan saja apa yang sudah
      // digambar, jangan hapus.
      tracing = false;
      if (drawn.length) selesai();
      else clearLine();
    }, { passive: false });
    clearLine();
  }

  /*
     Kartu status servis (6 status sesuai permintaan) + "Nggantung".
     Setiap kartu bisa diketuk untuk menyaring daftar servis.
  */
  function statusCards(d) {
    // Satu baris sejajar dari kiri: Progress, Done, Done Diambil, Cancel,
    // Cancel Diambil. Tiap kartu hanya menampilkan ANGKA, warna membedakan
    // statusnya (kuning, hijau, biru, orange, merah). Nggantung tampil
    // terpisah sebagai kartu ungu di bawahnya.
    return [
      { k: 'Progress', n: d.proses, tone: 'warn', desc: 'Unit baru masuk, masih dikerjakan teknisi' },
      { k: 'Done', n: d.selesai, tone: 'ok', desc: 'Sudah selesai, belum diambil' },
      { k: 'Done Diambil', n: d.doneDiambil, tone: 'ok2', desc: 'Sudah selesai dan sudah diambil' },
      { k: 'Cancel', n: d.cancel, tone: 'neg', desc: 'Dibatalkan, belum diambil' },
      { k: 'Cancel Diambil', n: d.cancelDiambil, tone: 'neg2', desc: 'Dibatalkan dan sudah diambil' }
    ].map(function (s) {
      return '<button class="mc-stat ' + s.tone + '" data-mv="list" data-status="' + esc(s.k) +
        '" title="' + esc(s.k) + ' — ' + esc(s.desc) + '" aria-label="' + esc(s.k) + ': ' + s.n + '">' +
        '<b>' + s.n + '</b><span>' + esc(pendekStatus(s.k)) + '</span>' +
      '</button>';
    }).join('');
  }

  // Ringkas nama status supaya muat di kartu sempit tanpa terpotong.
  function pendekStatus(s) {
    return s === 'Done Diambil' ? 'Diambil' : (s === 'Cancel Diambil' ? 'C. Diambil' : s);
  }

  /*
     Kartu "Nggantung": jumlah akumulasi nota yang masih menggantung, yaitu
     Progress + Cancel + Done. Warnanya ungu (lihat CSS) dan tetap seperti
     sebelumnya — hanya beda warna. Ketuk untuk menyaring daftar Nggandul.
  */
  function nggantungCard(d) {
    var total = d.nggantung || 0;
    return '<button class="mc-nggcnt' + (total ? ' on' : '') + '" data-mv="list" data-status="Nggandul"' +
      ' aria-label="Nggantung: ' + total + ' nota">' +
      '<div class="mc-nggcnt-l"><b>' + total + '</b><span>Nggantung</span>' +
        '<em>Total garapan yang masih Progress, Cancel, atau Done</em></div>' +
      '<div class="mc-nggcnt-r">' +
        '<span>Progress ' + (d.proses || 0) + '</span>' +
        '<span>Done ' + (d.selesai || 0) + '</span>' +
        '<span>Cancel ' + (d.cancel || 0) + '</span>' +
      '</div>' +
    '</button>';
  }

  // Catatan: kartu Dana Bank TIDAK lagi ada di Beranda modul ini. Dana Bank
  // dipindahkan ke Project Nava (lihat assets/js/nava-bank.js) karena itu alat
  // keuangan, bukan alat servis HP. Di Beranda modul hanya tampil ringkasan
  // kas masuk/keluar.

  function kpi(label, n, tone) {
    return '<div class="mc-kpi-i ' + tone + '"><b>' + n + '</b><span>' + label + '</span></div>';
  }

  function skeleton() {
    return '<div class="mc-pad"><div class="mc-skel"></div><div class="mc-skel short"></div></div>';
  }

  function orderCard(o) {
    var badge = badgeServis(o.serviceStatus);
    var sisa = o.remaining > 0
      ? '<span class="mc-remain">Sisa ' + rupiah(o.remaining) + '</span>'
      : '<span class="mc-done">Lunas</span>';
    return '<button class="mc-card" data-open="' + esc(o.id) + '">' +
      '<div class="mc-card-top">' +
        '<span class="mc-note">' + esc(refNota(o)) + '</span>' +
        badge +
      '</div>' +
      '<div class="mc-card-name">' + esc(o.customerName) + '</div>' +
      '<div class="mc-card-dev">' + esc(o.device) + '</div>' +
      '<div class="mc-card-btm">' +
        '<span class="mc-total">' + rupiah(o.totalCost) + '</span>' +
        sisa +
      '</div>' +
    '</button>';
  }

  function badgeServis(s) {
    // Tiap status punya warna sendiri, sama seperti kartu di Beranda:
    // Progress kuning, Done hijau, Done Diambil biru, Cancel orange,
    // Cancel Diambil merah, Nggandul ungu.
    //
    // Kelas khusus status dipakai, bukan ok/neg/warn yang sudah ada,
    // karena kelas badge those juga dipakai untuk hal lain di preview
    // nota. Mengubah artinya akan mengubah warna yang tidak ada
    // hubungannya dengan status.
    var TONE = {
      'Progress': 'st-prog', 'Done': 'st-done', 'Done Diambil': 'st-ambil',
      'Cancel': 'st-cancel', 'Cancel Diambil': 'st-cambil', 'Nggandul': 'st-ngg'
    };
    return '<span class="mc-badge ' + (TONE[s] || 'info') + '">' + esc(s) + '</span>';
  }

  /* ==========================================================
     BACKUP OTOMATIS
     ========================================================== */
  /* Backup otomatis ke HP setiap 10 nota baru tersimpan.

     Berbeda dengan snapshot berkala, ini menyimpan salinan yang benar-benar
     keluar dari aplikasi: file JSON yang mendarat di penyimpanan HP. Kalau
     Telegram dihapus atau cache dibersihkan, localStorage ikut hilang — ini
     satu-satunya jaring pengaman yang tidak bergantung pada app.

     Penanda disimpan sebagai JUMLAH nota terakhir yang sudah diekspor, bukan
     sebagai waktu. Kalau app ditutup selama beberapa nota, celah yang hilang
     tetap ditemukan di buka berikutnya dan langsung diekspor.

     Semua dibungkus try: kegagalan unduhan tidak boleh menggagalkan
     penyimpanan nota. */
  var AUTO_EKSPOR_KEY = 'projectnava.autoExport';

  function autoEksporSetiap10() {
    try {
      var db = (w.MascimLocal && typeof w.MascimLocal._db === 'function')
        ? w.MascimLocal._db() : null;
      if (!db || !Array.isArray(db.orders)) return;
      var total = db.orders.length;
      if (!total) return;
      var last = parseInt(localStorage.getItem(AUTO_EKSPOR_KEY) || '0', 10) || 0;
      if (total < last + 10) return;
      // Tandai dulu: kalau unduhan gagal, nota ini tidak diulang
      // setiap kali ada yang menyimpan berikutnya.
      localStorage.setItem(AUTO_EKSPOR_KEY, String(total));
      if (w.App && typeof w.App.exportJSON === 'function') {
        w.App.exportJSON(true);
      }
    } catch (e) {
      console.warn('mascim: auto-ekspor dilewati', e);
    }
  }

  /* ==========================================================
     DAFTAR SERVIS — kartu (bukan tabel), cari & filter
     ========================================================== */
  function renderList(s) {
    setBar('Servis');
    var f = M.search.trim();
    var html = '<div class="mc-pad">' +
      '<input class="mc-search" id="mcSearch" type="search" placeholder="Cari nota, nama, HP, atau WhatsApp" value="' + esc(M.search) + '">';

    // Filter sederhana
    html += '<div class="mc-filters">' +
      ['all:Semua', 'today:Hari ini', 'month:Bulan ini', 'ngg:Nggandul'].map(function (x) {
        var k = x.split(':');
        return '<button class="mc-chip' + (M.filter === k[0] ? ' on' : '') + '" data-filter="' + k[0] + '">' + k[1] + '</button>';
      }).join('') +
    '</div>';

    if (M.filter === 'range') {
      html += '<div class="mc-row2">' +
        '<input class="mc-inp" id="mcFrom" type="date" value="' + esc(M.from) + '">' +
        '<input class="mc-inp" id="mcTo" type="date" value="' + esc(M.to) + '">' +
      '</div>';
    }
    html += '<button class="mc-chip range' + (M.filter === 'range' ? ' on' : '') + '" data-filter="range">Rentang tanggal</button>';

    var items = M.list;
    html += '<div class="mc-count">' + items.length + ' servis' + (f ? ' untuk "' + esc(f) + '"' : '') + '</div>';
    html += items.length
      ? items.map(orderCard).join('')
      : '<p class="mc-empty">Tidak ada servis yang cocok.</p>';

    html += '</div>';
    s.innerHTML = html;
  }

  /* =========================================================
     FORM — satu kolom, isian sesingkat mungkin
     ========================================================= */
  function blankDraft() {
    return {
      customer_name: '', whatsapp: '', device: '', complaint: '', seri_lain: '',
      intake_condition: '',
      screen_lock_type: 'Tanpa Kunci', screen_lock_secret: '', screenLockSaved: false,
      // Status buka/tutup area kunci disimpan di draft, bukan di DOM,
      // supaya bertahan meski form digambar ulang.
      lockHidden: false,
      handling: '', total_cost: '', service_status: INITIAL_STATUS,
      parts: [],
    };
  }

  function draftFromOrder(o) {
    return {
      customer_name: o.customerName, whatsapp: o.whatsapp, device: o.device,
      complaint: o.complaint, intake_condition: o.intakeCondition || '',
      screen_lock_type: o.screenLockType, screen_lock_secret: '',
      handling: o.handling, total_cost: o.totalCost ? String(o.totalCost) : '',
      service_status: o.serviceStatus,
      parts: o.parts.map(function (p) {
        return { part_name: p.partName, capital_cost: String(p.capitalCost) };
      }),
    };
  }

  function renderForm(s) {
    var d = M.draft || (M.draft = blankDraft());
    var editing = !!M.editing;
    setBar(editing ? 'Edit Servis' : 'Servis Baru');

    // Hitung preview angka turunan supaya pemilik langsung melihat
    // jasa & sisa pelunasan sebelum menekan Simpan.
    var total = parseInt(String(d.total_cost).replace(/\D/g, ''), 10) || 0;
    var modal = d.parts.reduce(function (a, p) { return a + (parseInt(String(p.capital_cost).replace(/\D/g, ''), 10) || 0); }, 0);
    var jasa = total - modal;
    var warn = jasa < 0;
    // Modal dibekukan untuk render ini. Saat teknisi mengubah Total Biaya,
    // Perkiraan Jasa dihitung ulang dari angka beku ini, bukan dari
    // menghitung ulang baris sparepart — supaya Total Modal Part tidak
    // ikut bergeser sendiri saat yang diedit sebenarnya hanya total.
    d.modalFrozen = modal;

    var html = '<div class="mc-pad">';

    /* Nomor nota dan tanggal masuk TIDAK ditampilkan di form. Keduanya dibuat
       sistem: nota terbit otomatis saat order pertama kali tersimpan berstatus
       Progress, dan tanggal masuk selalu hari ini. Ditampilkan hanya bikin form
       panjang tanpa gunanya — datanya tetap ada di record, cuma tidak perlu
       ditanyakan. */

    // Pelanggan
    // Nama dan WhatsApp berdampingan dalam satu baris supaya tidak
    // memakan tinggi form di layar HP. Tombol Chat ikut pindah ke dalam
    // baris yang sama, jadi tidak lagi butuh blok field tersendiri.
    html += '<div class="mc-field mc-pelanggan"><span class="mc-lbl">Nama Pelanggan *</span>' +
      '<div class="mc-row2">' +
        '<input class="mc-inp" id="fName" value="' + esc(d.customer_name) +
          '" placeholder="Contoh: Pak Budi" autocomplete="name">' +
        '<div class="mc-wa">' +
          '<input class="mc-inp" id="fWa" inputmode="tel" value="' + esc(d.whatsapp) +
            '" placeholder="WhatsApp (opsional)">' +
          '<a class="mc-wa-btn' + (validWa(d.whatsapp) ? '' : ' hidden') + '" id="fWaBtn" ' +
            (validWa(d.whatsapp) ? 'href="https://wa.me/' + waNum(d.whatsapp) + '"' : '') +
            ' target="_blank" rel="noopener">Chat</a>' +
        '</div>' +
      '</div></div>';

    // Unit
    html += field('Device *',
      '<div class="mc-row2">' +
        '<select class="mc-inp" id="fBrand"><option value="">Pilih brand</option>' +
          w.CalcUI.BRANDS.map(function (b) {
            return '<option value="' + esc(b.id) + '">' + esc(b.name) + '</option>';
          }).join('') +
        '</select>' +
        '<select class="mc-inp" id="fSeries"><option value="">Pilih seri</option></select>' +
      '</div>' +
      // Kolom ini hanya dipakai kalau seri dipilih "Lainnya…", supaya model yang
      // tidak ada di katalog tetap bisa dicatat sebagai "Brand + model".
      '<input class="mc-inp sm" id="fSeriLain" value="' + esc(d.seri_lain || '') +
      '" placeholder="Model lain (hanya jika pilih Lainnya…)">');
    // Kendala dan kondisi unit digabung jadi satu isian. Memisahkannya hanya
    // menambah tinggi form tanpa menambah informasi: yang dicari teknisi tetap
    // "apa yang rusak dan kondisi barang saat masuk". Satu teks ini disimpan di
    // field `complaint` DAN disalin ke `intake_condition`, jadi bagian kondisi
    // di nota pelanggan tetap terisi tanpa ada isian kedua.
    // Urutan membaca teknisi: device -> hitung biaya -> baru isi keluhan,
    // kunci layar, dan penanganan. Ketiganya karena itu diletakkan di
    // bawah blok Perkiraan Jasa, bukan di bawah Device.

    // Sparepart
    html += '<div class="mc-sec">Sparepart <span class="mc-sec-note">boleh kosong</span></div>';
    html += renderPemilihHarga(d);
    if (d.parts.length) {
      html += '<div class="mc-parts">';
      d.parts.forEach(function (p, i) {
        html += '<div class="mc-part">' +
          '<input class="mc-inp sm" data-pi="' + i + '" data-pf="part_name" value="' + esc(p.part_name) + '" placeholder="Nama part">' +
          '<input class="mc-inp sm" data-pi="' + i + '" data-pf="capital_cost" inputmode="numeric" value="' + esc(p.capital_cost) + '" placeholder="Modal">' +
          '<button class="mc-x" data-delpart="' + i + '" aria-label="Hapus">✕</button>' +
        '</div>';
      });
      html += '</div>';
    }
    html += '<button class="mc-ghost-btn" id="fAddPart">+ Tambah Sparepart</button>';

    // Biaya. Ketiganya satu kotak dengan gaya sama supaya tidak terlihat
    // seperti kolom isian yang kebetulan berada di antara dua angka hasil
    // hitungan.
    // Total Biaya tetap berupa input supaya masih bisa dikoreksi manual.
    html += '<div class="mc-calc">' +
      '<div><span>Total Biaya</span><b class="mc-edit">' +
        '<input class="mc-in-edit" id="fTotal" inputmode="numeric" placeholder="0" value="' + esc(d.total_cost) + '">' +
      '</b></div>' +
      '<div><span>Total Modal Part</span><b id="calcModal">' + rupiah(modal) + '</b></div>' +
      '<div><span>Perkiraan Jasa</span><b id="calcJasa" class="' + (warn ? 'neg' : 'pos') + '">' + rupiah(jasa) + '</b></div>' +
    '</div>';
    if (warn) {
      html += '<p class="mc-warn">Total modal sparepart lebih besar dari total biaya. Periksa datanya sebelum menyimpan.</p>';
    }

    // Tiga blok berikut dipindahkan ke sini, lihat catatan urutan di atas.

    // Kendala & kondisi unit
    html += field('Kendala &amp; kondisi unit *' +
      '<span class="mc-sec-note"> tampil di nota pelanggan</span>',
      '<textarea class="mc-inp" id="fComplaint" rows="3" ' +
      'placeholder="Contoh: Layar pecah tidak bisa disentuh. Body penyok, kartu SIM tidak ada, speaker normal">'
      + esc(d.complaint || d.intake_condition) + '</textarea>');

    // Kunci layar. Dipakai daftar centang (chip), bukan dropdown, karena
    // teknisi tahu pilihannya tanpa perlu membuka menu. Kolom isian hanya
    // muncul setelah ada yang dicentang, dan langsung disembunyikan lagi
    // setelah terisi, supaya tidak memakan tempat di layar HP.
    html += '<div class="mc-field"><span class="mc-lbl">Kunci Layar</span>' +
      '<div class="mc-locks" id="fLockChips">' +
      LOCK_TYPES.map(function (t) {
        return '<button type="button" class="mc-lockchip' +
          (d.screen_lock_type === t ? ' on' : '') + '" data-lock="' + esc(t) + '">' +
          esc(t) + '</button>';
      }).join('') +
      '</div>' +
      '<button type="button" class="mc-locktoggle" id="fLockToggle">' +
        (d.lockHidden ? '\u25B8 Tampilkan isi kunci' : '\u25BE Sembunyikan isi kunci') +
      '</button>' +
      // Kolom isian menyesuaikan jenis kunci. Untuk "Pola" yang yang tampil
      // adalah area gambar, BUKAN kolom teks: memakai kolom teks untuk pola
      // membuat pengguna mengetik angka-angka pola, dan kunci yang digambar
      // tidak pernah ikut terbaca.
      '<div class="mc-lockwrap' +
          (d.screen_lock_type === 'Tanpa Kunci' ? ' mc-none' : '') +
          '" id="fLockWrap">' +
        (d.screen_lock_type === 'Pola'
          ? patternPad(d.screen_lock_secret)
          : '<input class="mc-inp" id="fSecret" type="password" inputmode="' +
              (d.screen_lock_type === 'PIN' ? 'numeric' : 'text') +
              // autocorrect dan otomatis kapital di keyboard Android bisa
              // mengubah password yang diketik menjadi teks yang berbeda,
              // sehingga kunci yang tersimpan tidak sama dengan yang diketik.
              '" autocapitalize="off" autocomplete="new-password"' +
              ' autocorrect="off" spellcheck="false"' +
              '" value="' + esc(d.screen_lock_secret) + '" placeholder="' +
              (d.screen_lock_type === 'PIN' ? 'misal: 1234' : 'isi kunci layar') + '">' +
            '<button class="mc-eye" id="fEye" type="button" aria-label="Tampilkan">👁</button>') +
        '<span class="mc-lockok" id="fLockOk"' +
          (d.screen_lock_secret ? '' : ' hidden') + '>✓ tersimpan</span>' +
      '</div>' +
      // Kalau sudah ada kunci yang tersimpan, tampilkan rangkuman supaya
      // teknisi tahu ada kunci tanpa perlu membongkar area gambar pola.
      (d.screen_lock_type !== 'Tanpa Kunci' && d.screen_lock_secret
        ? '<button type="button" class="mc-lockclear" id="fLockClear">Hapus Kunci (' +
          esc(d.screen_lock_type) + ')</button>'
        : '') +
      '</div>';


    // Status
    // Tidak ada pilihan status di form tambah service. Nota baru SELALU
    // berstatus "Progress" dan diubah lewat tombol "Ubah Status" di layar
    // detail. Mesinya juga mengunci nilai ini, jadi mustahil nota dibuat
    // langsung jadi Done / Cancel lewat form.

    // Hanya satu tombol aksi. Setelah tersimpan, warnanya berubah kuning
    // sebagai tanda progres, jadi tidak perlu tombol "Simpan" terpisah —
    // yang diklik tetap "Simpan & Buka Detail".
    html += '<div class="mc-submit">' +
      '<button class="mc-ghost-btn" id="fSaveOpen">Simpan &amp; Buka Detail</button>' +
      '<button class="mc-ghost-btn danger" id="fExit">Exit</button>' +
    '</div>';

    html += '</div>';
    s.innerHTML = html;
    bindForm();
  }

  function field(label, control) {
    return '<label class="mc-field"><span class="mc-lbl">' + label + '</span>' + control + '</label>';
  }

  function validWa(v) { return /^(\+?62|0)\d{8,14}$/.test(String(v || '').replace(/[\s-]/g, '')); }
  function waNum(v) { return String(v).replace(/[\s-]/g, '').replace(/^0/, '62'); }

  // Pembayaran hanya boleh dicatat saat status "Done". Satu sumber kebenaran
  // dipakai bersama oleh renderDetail (tombol di layar) dan bindDetail (opsi
  // di sheet "Ubah Status") supaya keduanya tidak pernah berbeda.
  function payLocked(status) { return status !== 'Done'; }

  /*
     Ref nota untuk ditampilkan ke pengguna.

     Nomor nota pelanggan hanya ada setelah nota garansi diterbitkan. Sebelum
     itu nota hanya punya ID internal, jadi itulah yang ditampilkan. Fungsi
     ini satu-satunya sumber untuk hal ini supaya daftar, detail, form, dan
     toast tidak pernah berbeda.
  */
  function refNota(o) {
    if (!o) return '';
    if (o.noteNumber) return '#' + o.noteNumber;
    return o.internalRef || '-';
  }

  /* ---------------- form: ambil isian ---------------- */
  function readDraft() {
    var d = M.draft;
    d.customer_name = ($('#fName') || {}).value || '';
    d.whatsapp = ($('#fWa') || {}).value || '';
    // Device disusun dari dua dropdown, lalu digabung jadi satu string
    // "Brand Seri" supaya seluruh kode lain yang membaca o.device tetap utuh.
    var bSel = $('#fBrand'), sSel = $('#fSeries');
    var brandName = '';
    if (bSel && bSel.value) {
      var b = w.CalcUI.BRANDS.filter(function (x) { return x.id === bSel.value; })[0];
      brandName = b ? b.name : '';
    }
    var seri = (sSel && sSel.value) || '';
    // "Lainnya…" berarti modelnya diketik sendiri di kolom tambahan, bukan
    // nama seri dari katalog.
    d.seri_lain = (($('#fSeriLain') || {}).value || '').trim();
    if (seri === 'Lainnya') seri = d.seri_lain;
    d.device = brandName ? (seri && seri !== 'Lainnya' ? brandName + ' ' + seri : brandName) : '';

    d.complaint = ($('#fComplaint') || {}).value || '';
    // Satu isian untuk kendala sekaligus kondisi unit; disalin agar bagian
    // kondisi di nota pelanggan tidak ikut kosong.
    d.intake_condition = d.complaint;
    // Chip kunci layar menyimpan pilihan aktif di atribut data, jadi
    // tidak ada <select> yang perlu dibaca.
    var chipOn = $('#fLockChips .on');
    d.screen_lock_type = chipOn ? chipOn.dataset.lock : 'Tanpa Kunci';
    // Kunci bisa berupa teks (PIN/Password) ATAU pola. Membaca hanya kolom
    // teks membuat pola yang sudah digambar hilang begitu form ini disalin.
    var secTeks = $('#fSecret');
    var secPola = $('#fPatSecret');
    d.screen_lock_secret = (secPola ? secPola.value : (secTeks ? secTeks.value : '')) || '';
    // Status buka/tutup area kunci ikut dibawa, kalau tidak setiap ketukan
    // pada chip akan membukanya lagi tanpa diminta.
    var lockToggleNow = $('#fLockToggle');
    if (lockToggleNow) d.lockHidden = lockToggleNow.textContent.indexOf('Tampilkan') >= 0;
    // Penanganan TIDAK lagi diambil di form ini. Kolomnya hanya muncul di
    // layar Detail dan hanya ketika status sudah Done, jadi di sini
    // nilai lama dibiarkan apa adanya supaya tidak terhapus oleh edit lain.
    d.total_cost = ($('#fTotal') || {}).value || '';
    // Status tidak bisa dipilih di form: selalu Progress untuk nota baru,
    // dan saat mengedit status lama nota tidak ikut berubah karena field ini
    // diabaikan mesin data saat status tidak dikirim eksplisit.
    d.service_status = INITIAL_STATUS;
    return d;
  }

  /* Isi dropdown seri sesuai brand terpilih.
     WAJIB berada di scope modul: dipanggil dari bindForm() dan
     openPartSheet(), bukan hanya dari renderForm(). Kalau dideklarasikan di
     dalam renderForm, kedua pemanggil itu dapat ReferenceError — gejalanya
     dropdown seri tidak pernah terisi DAN sheet sparepart tidak pernah terbuka. */
  function isiSeri(brandSel, seriSel, seriDipilih) {
    if (!brandSel || !seriSel) return;
    var list = (w.CalcUI.SERIES[brandSel.value] || []);
    seriSel.innerHTML = '<option value="">Pilih seri</option>' +
      list.map(function (s) {
        return '<option value="' + esc(s) + '"' +
          (s === seriDipilih ? ' selected' : '') + '>' + esc(s) + '</option>';
      }).join('') +
      '<option value="Lainnya"' + (seriDipilih && list.indexOf(seriDipilih) < 0
        ? ' selected' : '') + '>Lainnya…</option>';
  }

  /* Pecah device yang tersimpan jadi [idBrand, seri] supaya form edit bisa
     menandai ulang dropdownnya.
     Brand tidak selalu satu kata: "Samsung Galaxy A54" tapi juga bisa cuma
     "Samsung" (seri dikosongkan). Jadi coba prefiks dari yang panjang dulu —
     pecah di spasi pertama saja akan menganggap "Samsung" bukan brand sama
     sekali. Kalau tidak ada yang cocok, kembalikan string utuh sebagai seri
     supaya tidak ada yang terpotong. */
  function pisahDevice(device) {
    var d = String(device || '').trim();
    if (!d) return ['', ''];
    var kata = d.split(/\s+/);
    for (var n = Math.min(3, kata.length); n >= 1; n--) {
      var kandidat = kata.slice(0, n).join(' ');
      var brand = w.CalcUI.BRANDS.filter(function (b) {
        return b.name.toLowerCase() === kandidat.toLowerCase();
      })[0];
      if (brand) return [brand.id, kata.slice(n).join(' ')];
    }
    return ['', d];
  }

  /* ============================================================
     PEMILIH HARGA SPAREPART DARI KALKULATOR

     Berdiri sendiri,inline di form tambah service. Sheet detail
     tidak bisa dipakai untuk ini: saat nota baru, part masih bagian
     dari draft dan belum punya orderId, jadi tidak bisa POST sendiri.

     Alurnya dua dropdown berjajar:
       Jenis  -> LCD / Baterai / Lainnya
       Varian -> varian yang BENAR-BENAR ada di Kalkulator untuk
                 (brand, seri) device ini saja, jadi tidak pernah
                 menampilkan daftar kosong yang membingungkan.
     Tombol centang dipakai untuk konfirmasi sebelum harga benar-benar
     ditambahkan ke daftar sparepart.

     Kalau belum ada harga untuk jenis itu, muncul kalkulator kecil
     untuk membuat estimasi baru — rumusnya sama persis dengan
     Kalkulator Service, dan hasilnya langsung tersimpan supaya nota
     berikutnya untuk device yang sama tinggal pilih.
     ============================================================ */

  function jenisDariRule(rule) {
    return /baterai/i.test(rule.id) ? 'baterai' : 'lcd';
  }

  function ruleByRuleId(id) {
    return (w.CalcUI.RULES || []).filter(function (r) { return r.id === id; })[0] || null;
  }

  /* Semua entri Kalkulator untuk device ini, dikelompokkan per jenis. */
  function katalogUntukDevice(brandId, seri) {
    var out = { lcd: [], baterai: [], lain: [] };
    if (!brandId || !seri) return out;
    (w.Store.state.templates || []).forEach(function (t) {
      var p = t.payload || {};
      if (p.brandId !== brandId || p.series !== seri) return;
      var rule = ruleByRuleId(p.ruleId);
      if (!rule) { out.lain.push({ tpl: t, rule: null }); return; }
      out[jenisDariRule(rule)].push({ tpl: t, rule: rule });
    });
    return out;
  }

  function labelVarian(v) {
    var p = v.tpl.payload || {};
    var nama = v.rule ? (v.rule.name || v.rule.id) : (p.ruleId || 'Lainnya');
    return nama + ' · modal ' + rupiah(p.part) + ' → ' + rupiah(p.est);
  }

  function renderPemilihHarga(d) {
    var bits = pisahDevice(d && d.device);
    var brandId = bits[0], seri = bits[1];
    var kat = katalogUntukDevice(brandId, seri);
    var ada = kat.lcd.length + kat.baterai.length + kat.lain.length;

    if (!brandId || !seri) {
      return '<div class="mc-harga">' +
        '<p class="mc-hint">Pilih brand dan seri di atas dulu, supaya harga ' +
        'dari Kalkulator bisa dipakai.</p></div>';
    }

    // Ketiga jenis SELALU ditawarkan, walau belum ada harga tersimpan untuk
    // device ini — justru itu jalur untuk membuat estimasi baru. Kalau jenis
    // disembunyikan saat datanya kosong, tidak ada cara membuat harga baru.
    var opsiJenis = '<option value="">— jenis sparepart —</option>' +
      '<option value="lcd">LCD' + (kat.lcd.length ? ' (' + kat.lcd.length + ')' : '') + '</option>' +
      '<option value="baterai">Baterai' + (kat.baterai.length ? ' (' + kat.baterai.length + ')' : '') + '</option>' +
      '<option value="lain">Lainnya' + (kat.lain.length ? ' (' + kat.lain.length + ')' : '') + '</option>';

    return '<div class="mc-harga" id="pPick" data-brand="' + esc(brandId) + '" data-seri="' + esc(seri) + '">' +
      '<div class="mc-row2">' +
        '<select class="mc-inp sm" id="pJenis">' + opsiJenis + '</select>' +
        '<select class="mc-inp sm" id="pVarian"><option value="">— pilih varian —</option></select>' +
      '</div>' +
      '<div id="pVarianInfo" class="mc-hint"></div>' +
      '<button class="mc-ghost-btn" id="pPakai" disabled>' +
        '✓ Pakai harga ini</button>' +
      // Kalkulator mini untuk device ini: dipakai hanya kalau jenis yang
      // dipilih belum punya harga tersimpan di Kalkulator.
      '<div id="pBaru" class="mc-harga-baru mc-none">' +
        '<p class="mc-hint" id="pBaruInfo"></p>' +
        '<div class="mc-row2">' +
          '<label class="mc-field"><span class="mc-lbl">Harga part (Rp)</span>' +
            '<input class="mc-inp sm" id="pBaruPart" inputmode="numeric" placeholder="0"></label>' +
          '<label class="mc-field"><span class="mc-lbl">Estimasi (Rp)</span>' +
            '<input class="mc-inp sm" id="pBaruEst" inputmode="numeric" placeholder="otomatis"></label>' +
        '</div>' +
        '<button class="mc-ghost-btn" id="pBaruSimpan">✓ Simpan harga ini ke Kalkulator</button>' +
      '</div>' +
      (ada ? '' : '<p class="mc-hint">Belum ada harga untuk ' + esc(seri) +
        ' di Kalkulator. Pilih jenis, lalu buat estimasi baru di bawah.</p>') +
    '</div>';
  }

  /* Menerjemahkan pilihan Jenis+Varian menjadi draft part baru. */
  function pakaiHargaDariKatalog() {
    var pick = $('#pPick');
    if (!pick) return;
    var brandId = pick.dataset.brand, seri = pick.dataset.seri;
    var jenis = ($('#pJenis') || {}).value;
    var varianId = ($('#pVarian') || {}).value;
    if (!jenis || !varianId) return;
    var kat = katalogUntukDevice(brandId, seri);
    var v = (kat[jenis] || []).filter(function (x) {
      return (x.tpl.payload.ruleId || '') === varianId;
    })[0];
    if (!v) return;
    var p = v.tpl.payload;
    dPushPart();
    var part = M.draft.parts[M.draft.parts.length - 1];
    part.part_name = v.rule ? namaPartDariRule(v.rule) : (p.ruleId || 'Sparepart');
    part.capital_cost = p.part;
    // Total Biaya memakai ESTIMASI dari Kalkulator, yaitu harga yang ditawarkan
    // ke pelanggan, bukan harga modal part — modal sudah tampil sendiri di
    // baris "Total Modal Part" jadi tidak boleh ikut ditambah dua kali.
    // TIDAK dikunci: kalau harga berubah, teknisi tetap boleh mengoreksi.
    var lama = parseInt(String(M.draft.total_cost || '').replace(/\D/g, ''), 10) || 0;
    M.draft.total_cost = lama + (parseInt(p.est, 10) || 0);
    render();
    toast('Part ditambahkan, total biaya diperbarui');
  }

/* Hitung ulang kotak Total Modal Part + Perkiraan Jasa tanpa menggambar ulang
     seluruh form, supaya kursor di input yang sedang diketik tidak hilang.
     Perkiraan Jasa = Total Biaya - Total Modal Part, dan Total Modal Part
     memakai angka beku dari render ini supaya tidak ikut bergeser. */
  function syncKalkula(s) {
    var box = (s || document).querySelector('.mc-calc');
    if (!box) return;
    var totalIn = $('#fTotal');
    var total = parseInt(String(
      (totalIn ? totalIn.value : M.draft.total_cost) || ''
    ).replace(/\D/g, ''), 10) || 0;
    var modal = (M.draft.modalFrozen != null)
      ? M.draft.modalFrozen
      : M.draft.parts.reduce(function (a, p) {
        return a + (parseInt(String(p.capital_cost).replace(/\D/g, ''), 10) || 0);
      }, 0);
    var jasa = total - modal;
    // Hanya dua nilai yang dihitung ulang. Kotak ini TIDAK ditulis ulang
    // dengan innerHTML, karena input #fTotal ada di dalam kotak yang sama
    // dan akan ikut terhapus beserta angka yang sedang diketik.
    var elModal = box.querySelector('#calcModal');
    var elJasa = box.querySelector('#calcJasa');
    if (elModal) elModal.textContent = rupiah(modal);
    if (elJasa) {
      elJasa.textContent = rupiah(jasa);
      elJasa.className = (jasa < 0 ? 'neg' : 'pos');
    }
  }

  function bindPemilihHarga() {
    var pick = $('#pPick');
    if (!pick) return;
    var brandId = pick.dataset.brand, seri = pick.dataset.seri;
    var jenisSel = $('#pJenis'), varianSel = $('#pVarian');
    var info = $('#pVarianInfo'), pakai = $('#pPakai');
    var baru = $('#pBaru'), baruInfo = $('#pBaruInfo');

    function isiVarian() {
      var jenis = jenisSel.value;
      varianSel.innerHTML = '<option value="">— pilih perhitungan —</option>';
      info.textContent = '';
      pakai.disabled = true;
      baru.classList.add('mc-none');
      if (!jenis) return;

      // Varian menampilkan seluruh perhitungan Kalkulator, jadi selalu ada
      // pilihan. Yang sudah punya harga untuk device ini memakai harga
      // tersimpan, sisanya menampilkan rumusnya.
      var semua = (w.CalcUI.RULES || []).filter(function (r) {
        return jenisDariRule(r) === jenis;
      });
      if (!semua.length) {
        baru.classList.remove('mc-none');
        baruInfo.textContent = 'Jenis ini tidak punya rumus di Kalkulator.';
        return;
      }

      var kat = katalogUntukDevice(brandId, seri);
      var tersimpan = {};
      (kat[jenis] || []).forEach(function (v) {
        tersimpan[(v.tpl.payload || {}).ruleId] = v;
      });

      // Yang punya harga tersimpan ditampilkan paling dulu.
      semua.sort(function (a, b) {
        var x = tersimpan[a.id] ? 0 : 1, y = tersimpan[b.id] ? 0 : 1;
        return x - y;
      });

      semua.forEach(function (r) {
        var v = tersimpan[r.id];
        var label = v ? labelVarian(v)
          : r.name + ' · belum ada harga (' + rumusLabel(r) + ')';
        varianSel.innerHTML += '<option value="' + esc(r.id) + '">' +
          esc(label) + '</option>';
      });

      if (!kat[jenis].length) {
        baruInfo.textContent = 'Pilih perhitungan, lalu tulis harga part. ' +
          'Estimasi dihitung dengan rumus Kalkulator yang sama.';
      }
    }

    function rumusLabel(r) {
      return 'part × 2 + ' + (r.pct != null ? r.pct : 0) + '%';
    }

    jenisSel.addEventListener('change', isiVarian);
    varianSel.addEventListener('change', function () {
      var id = varianSel.value;
      if (!id) { info.textContent = ''; pakai.disabled = true; return; }
      var kat = katalogUntukDevice(brandId, seri);
      var all = kat.lcd.concat(kat.baterai, kat.lain);
      var v = all.filter(function (x) {
        return (x.tpl.payload || {}).ruleId === id;
      })[0];

      if (v) {
        // Sudah ada harga tersimpan untuk perhitungan ini.
        var p = v.tpl.payload;
        baru.classList.add('mc-none');
        info.textContent = 'Modal ' + rupiah(p.part) + ' · estimasi ' + rupiah(p.est) +
          ' — masukkan sebagai modal part.';
        pakai.disabled = false;
        return;
      }

      // Belum ada harga: buka kalkulator mini supaya bisa dibuat sekarang
      // dengan rumus Kalkulator yang sama.
      pakai.disabled = true;
      baru.classList.remove('mc-none');
      hitungBaru();
      if (partIn) partIn.focus();
    });

    pakai.addEventListener('click', pakaiHargaDariKatalog);

    // Kalkulator kecil: harga part -> estimasi dengan rumus yang sama.
    var partIn = $('#pBaruPart'), estIn = $('#pBaruEst');

    // Rule yang dipakai adalah varian yang SEDANG DIPILIH di dropdown, bukan
    // rule representatif per jenis. Kalau tidak, memilih "LCD Bagus" (20%)
    // tetap dihitung dengan rumus jenis pertama, jadi estimasinya salah.
    function ruleTerpilih() {
      var id = varianSel.value;
      if (!id) return null;
      return (w.CalcUI.RULES || []).filter(function (r) {
        return r.id === id;
      })[0] || null;
    }

    function hitungBaru() {
      var part = parseInt(String(partIn.value || '').replace(/\D/g, ''), 10) || 0;
      var rule = ruleTerpilih();
      if (!rule || !part) { estIn.value = ''; return; }
      estIn.value = w.CalcUI.hitung(part, rule).est;
    }
    partIn.addEventListener('input', hitungBaru);
    $('#pBaruSimpan').addEventListener('click', function () {
      var part = parseInt(String(partIn.value || '').replace(/\D/g, ''), 10) || 0;
      var est = parseInt(String(estIn.value || '').replace(/\D/g, ''), 10) || 0;
      var rule = ruleTerpilih();
      if (!rule) { alertErr('Pilih perhitungan dulu'); return; }
      if (!part) { alertErr('Isi harga part'); return; }
      if (!est) est = w.CalcUI.hitung(part, rule).est;
      var simpan = upsertTplBrandSeri(brandId, seri, rule, part, est);
      if (!simpan.ok) { alertErr('Gagal menyimpan: ' + simpan.reason); return; }
      render();
      toast(simpan.replaced
        ? 'Harga lama untuk kombinasi ini diganti'
        : 'Tersimpan di Kalkulator — pakai lagi kapan saja');
    });
  }

  function bindForm() {
    var s = screen();

    // Brand -> seri. Seri hanya menampilkan model milik brand yang dipilih,
    // jadi tidak mungkin memilih seri yang tidak cocok. Saat form dibuka untuk
    // edit, device yang sudah tersimpan dipecah lalu ditandai ulang.
    var brandSel = $('#fBrand'), seriSel = $('#fSeries');
    if (brandSel && seriSel) {
      var sudah = pisahDevice(M.draft && M.draft.device);
      if (sudah[0]) brandSel.value = sudah[0];
      isiSeri(brandSel, seriSel, sudah[1]);
      brandSel.addEventListener('change', function () {
        isiSeri(brandSel, seriSel, '');
        // readDraft() dulu supaya M.draft.device terisi dari select yang barusan
        // berubah, dan field lain yang sudah diketik tidak ikut hilang saat
        // form digambar ulang. Sebelumnya device dikosongkan di sini, lalu
        // bindForm() membaca pisahDevice('') dan me-reset brand ke kosong —
        // itu yang membuat dropdown seri selalu terisi lalu langsung hilang.
        readDraft();
        render();
      });
      seriSel.addEventListener('change', function () {
        readDraft();
        render();
      });
    }
    bindPemilihHarga();

    // Tombol Chat WhatsApp muncul begitu nomornya valid, tanpa perlu
    // menggambar ulang seluruh form (supaya kursor tidak hilang).
    var waIn = $('#fWa');
    if (waIn) {
      waIn.addEventListener('input', function () {
        var btn = $('#fWaBtn');
        if (!btn) return;
        var v = waIn.value.trim();
        if (validWa(v)) {
          btn.setAttribute('href', 'https://wa.me/' + waNum(v));
          btn.classList.remove('hidden');
        } else {
          btn.removeAttribute('href');
          btn.classList.add('hidden');
        }
      });
    }

    // Kunci layar: daftar centang. Memilih chip langsung menyimpan ke draft
    // tanpa menggambar ulang seluruh form, supaya layar tidak berkedip.
    // Kolom isian muncul setelah ada yang dicentang dan disembunyikan lagi
    // begitu terisi, jadi tidak memakan tempat di layar HP.
    var chips = document.querySelectorAll('#fLockChips .mc-lockchip');
    var wrap = $('#fLockWrap'), lockOk = $('#fLockOk'), lockIn = $('#fSecret');
    var on = $('#fLockChips .on');

    function syncLockUI() {
      if (!wrap) return;
      var tipe = (on ? on.dataset.lock : 'Tanpa Kunci');
      // Isi kunci bisa ada di kolom teks ATAU di area pola, tergantung
      // jenis kuncinya. Hanya membaca kolom teks membuat "tersimpan" tidak
      // pernah muncul untuk pola.
      var patSecret = $('#fPatSecret');
      var isi = ((patSecret ? patSecret.value : (lockIn ? lockIn.value : '')) || '').trim();
      // Dua jenis kunci punya aturan berbeda, dan dicampur jadi satu akan
      // merusak salah satunya:
      //  - PIN / Password: disembunyikan begitu terisi, seperti diminta.
      //  - Pola: TIDAK cukup digambar, harus disimpan lewat tombol dulu.
      //    Kalau langsung disembunyikan begitu ada isi, pola yang baru
      //    digambar hilang sebelum sempat dilihat.
      // Area kunci SELALU terbuka selama jenisnya sudah dipilih. Menyembunyikan
      // otomatis adalah sumber bug yang berulang: pad disembunyikan selama
      // belum ada yang tersimpan, padahal tombol Simpan justru berada DI
      // DALAM pad itu — jadi tidak ada jalan masuk sama sekali.
      // Sembunyikan hanya lewat tombol yang ditekan pengguna.
      var tampil = tipe !== 'Tanpa Kunci' && !M.draft.lockHidden;
      wrap.classList.toggle('mc-none', !tampil);
      if (lockOk) lockOk.hidden = !(tipe !== 'Tanpa Kunci' && !!isi);
      var tog = $('#fLockToggle');
      if (tog) {
        tog.textContent = M.draft.lockHidden
          ? '\u25B8 Tampilkan isi kunci'
          : '\u25BE Sembunyikan isi kunci';
      }
    }

    for (var ci = 0; ci < chips.length; ci++) {
      chips[ci].addEventListener('click', function () {
        var pilih = this.dataset.lock;
        // Chip yang sama dicentang lagi berarti membatalkan kunci.
        var aktif = this.classList.contains('on');
        M.draft.screen_lock_type = aktif ? 'Tanpa Kunci' : pilih;
        M.draft.screen_lock_secret = '';
        // Form digambar ulang, BUKAN hanya mengubah kelas chip. Setiap jenis
        // kunci punya isian yang berbeda: PIN dan Password memakai kolom
        // teks, Pola memakai area gambar. Tanpa menggambar ulang, memilih
        // Pola hanya menampilkan kolom teks dan area gambarnya tidak pernah
        // muncul — karena juga bindPatternPad tidak pernah menemukan
        // elemen #fPat untuk dipasangkan.
        render();
      });
    }

    // Sembunyikan/tampilkan isi kunci: pilihan pengguna, bukan otomatis, dan
    // tetap berlaku di status apa pun karena ini milik field kunci layar.
    var lockToggle = $('#fLockToggle');
    if (lockToggle) {
      lockToggle.addEventListener('click', function () {
        M.draft.lockHidden = !M.draft.lockHidden;
        syncLockUI();
      });
    }

    var clear = $('#fLockClear');
    if (clear) {
      clear.addEventListener('click', function () {
        M.draft.screen_lock_secret = '';
        render();
      });
    }

    if (lockIn) {
      lockIn.addEventListener('input', function () {
        M.draft.screen_lock_secret = lockIn.value;
        syncLockUI();
      });
    }

    // Pola: simpan hasil gambar ke draft setiap kali selesai.
    var patSecret = $('#fPatSecret');
    var pat = $('#fPat');
    if (pat && patSecret) {
      pat.addEventListener('patternchange', function () {
        M.draft.screen_lock_secret = patSecret.value || '';
        // Digambar BUKAN tersimpan. Area tetap terbuka sampai tombol Simpan
        // ditekan.
        M.draft.screenLockSaved = false;
        syncLockUI();
      });
    }

    // Tombol Simpan pola: satu-satunya cara menutup area pola, dan berlaku
    // di status apa pun karena area ini milik field kunci layar.
    var patSave = $('#fPatSave');
    if (patSave) {
      patSave.addEventListener('click', function () {
        var secret = $('#fPatSecret');
        if (!secret || !secret.value) { alertErr('Gambar pola dulu'); return; }
        M.draft.screen_lock_secret = secret.value;
        M.draft.screenLockSaved = true;
        render();
      });
    }
    syncLockUI();

    var eye = $('#fEye');
    if (eye) {
      eye.addEventListener('click', function () {
        var i = $('#fSecret');
        if (!i) return;
        i.type = i.type === 'password' ? 'text' : 'password';
        eye.textContent = i.type === 'password' ? '👁' : '🙈';
      });
    }

    // Perekam pola (hanya saat jenis kunci = Pola)
    if (document.getElementById('fPat')) bindPatternPad($('#fPatSecret'));

    // Part: tambah
    var add = $('#fAddPart');
    if (add) {
      add.addEventListener('click', function () {
        readDraft();
        dPushPart();
        render();
      });
    }
    // Part: ubah & hapus
    var pw = s.querySelectorAll('[data-pi]');
    for (var i = 0; i < pw.length; i++) {
      pw[i].addEventListener('input', function () {
        readDraft();
        var pi = +this.dataset.pi, pf = this.dataset.pf;
        if (M.draft.parts[pi]) M.draft.parts[pi][pf] = this.value;
        syncKalkula(s);
      });
    }
    var del = s.querySelectorAll('[data-delpart]');
    for (var j = 0; j < del.length; j++) {
      del[j].addEventListener('click', function () {
        readDraft();
        M.draft.parts.splice(+this.dataset.delpart, 1);
        render();
      });
    }

    // Status tidak lagi bisa dipilih di form ini; lihat catatan di renderForm.

    // Total Biaya: setiap ketikan langsung memperbarui Perkiraan Jasa.
    // Sebelumnya tidak ada listener sama sekali di kolom ini, jadi angkanya
    // hanya ikut berubah ketika baris sparepart yang diubah. Akibatnya
    // Perkiraan Jasa menampilkan nilai lama yang tidak lagi sesuai.
    var totalIn = $('#fTotal');
    if (totalIn) {
      totalIn.addEventListener('input', function () {
        M.draft.total_cost = this.value;
        syncKalkula(s);
      });
    }

    // fSave tidak ada lagi — satu-satunya aksi adalah "Simpan & Buka Detail".
    // Tombol diklik -> berubah kuning dulu, baru submit(). Submit() sendiri
    // memanggil render() yang menghapus elemen ini, jadi tanpa jeda singkat
    // kuningnya tidak pernah sempat terlihat sama sekali.
    var so = $('#fSaveOpen');
    var saving = false;
    if (so) {
      so.addEventListener('click', function () {
        if (M.lock || saving) return;
        saving = true;
        so.classList.add('tersimpan');
        so.innerHTML = '✓ Tersimpan';
        setTimeout(function () { submit(true); }, 700);
      });
    }
    var ex = $('#fExit');
    if (ex) ex.addEventListener('click', exitForm);
  }

  function dPushPart() {
    M.draft.parts.push({ part_name: '', capital_cost: '' });
  }

  /** Keluar dari form; kalau ada perubahan belum disimpan, konfirmasi dulu. */
  function exitForm() {
    if (isDirty()) {
      // App.confirm tidak tersedia di app ini, jadi konfirmasi dibangun lewat
      // sheet. Tanpa ini, tombol keluar jadi tidak berfungsi sama sekali
      // karena penjaga di bawahnya tidak pernah terpenuhi.
      sheetOrWarn('Keluar Tanpa Simpan?',
        '<p class="mc-hint">Ada perubahan yang belum disimpan. ' +
        'Kalau keluar sekarang, perubahan ini hilang.</p>',
        function (body) {
          var row = document.createElement('div');
          row.style.display = 'grid';
          row.style.gridTemplateColumns = '1fr 1fr';
          row.style.gap = '8px';
          row.style.marginTop = '12px';

          var btnLanjut = document.createElement('button');
          btnLanjut.className = 'mc-ghost-btn';
          btnLanjut.textContent = 'Lanjut Isi';
          btnLanjut.addEventListener('click', function () { tutupSheet(); });

          var btnKeluar = document.createElement('button');
          btnKeluar.className = 'mc-primary';
          btnKeluar.textContent = 'Keluar';
          btnKeluar.addEventListener('click', function () {
            tutupSheet();
            M.draft = null; M.editing = null; M.view = 'home'; reload();
          });

          row.appendChild(btnLanjut);
          row.appendChild(btnKeluar);
          body.appendChild(row);
        });
      return;
    }
    M.draft = null; M.editing = null; M.view = 'home'; reload();
  }

  function isDirty() {
    var d = M.draft;
    if (!d) return false;
    var b = blankDraft();
    if (!M.editing) {
      return !!(d.customer_name || d.device || d.complaint || d.total_cost || d.parts.length);
    }
    return JSON.stringify(d) !== JSON.stringify(draftFromOrder(M.current || {}));
  }

  /* ---------------- form: simpan (idempoten) ---------------- */
  function submit(openAfter) {
    if (M.lock) return;               // kunci: klik berulang tidak jadi dobel
    var d = readDraft();
    M.lock = true;
    render();

    var payload = {
      customer_name: d.customer_name.trim(),
      whatsapp: d.whatsapp.trim(),
      device: d.device.trim(),
      complaint: d.complaint.trim(),
      intake_condition: String(d.intake_condition || '').trim(),
      screen_lock_type: d.screen_lock_type,
      screen_lock_secret: d.screen_lock_secret,
      handling: d.handling.trim(),
      total_cost: d.total_cost === '' ? 0 : parseInt(String(d.total_cost).replace(/\D/g, ''), 10),
      parts: d.parts.filter(function (p) { return String(p.part_name || '').trim()})
        .map(function (p) {
          return {
            part_name: String(p.part_name).trim(),
            capital_cost: parseInt(String(p.capital_cost).replace(/\D/g, ''), 10) || 0,
          };
        }),
    };

    // Nota baru SELALU berstatus Progress (mesin data juga mengunci ini).
    // Saat mengedit, service_status sengaja TIDAK dikirim supaya status
    // yang sedang berjalan (mis. Done) tidak terpaksa balik jadi Progress.
    if (!M.editing) payload.service_status = INITIAL_STATUS;

    var req;
    if (M.editing) {
      req = api('PATCH', '/api/mascim/services/' + encodeURIComponent(M.editing), payload);
    } else {
      // Kunci idempotensi per isi form: menekan Simpan berkali-kali
      // hanya menghasilkan SATU nota.
      if (!d._idem) d._idem = 'nota-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      payload.idem_key = d._idem;
      req = api('POST', '/api/mascim/services', payload);
    }

    req.then(function (r) {
      M.lock = false;
      M.draft = null;
      var wasEdit = !!M.editing;   // dibaca SEBELUM dikosongkan
      M.editing = null;
      var svc = r.service;

      // Simpan nomor pelanggan ke kontak perangkat dalam format
      // "(nomor nota - nama pelanggan)". Aplikasi web tidak boleh menulis
      // langsung ke buku kontak HP, jadi yang dibuat adalah file vCard
      // (.vcf) — Android/iOS akan menawarinya saat mengimpor. Kalau perangkat
      // mendukung berbagi, file-nya dibagikan agar bisa langsung simpan.
      if (!wasEdit) {
        simpanKontak(svc);
        // Backup otomatis ke HP setiap 10 nota baru.
        autoEksporSetiap10();
      }

      if (openAfter) {
        M.view = 'detail';
        M.current = svc;
        M.id = svc.id;
        loadDetail(svc.id);
      } else {
        M.view = 'home';
        toast((wasEdit ? 'Perubahan tersimpan' : refNota(svc) + ' tersimpan'));
        reload();
        return;
      }
      reload();
    }).catch(function (e) {
      M.lock = false;
      render();
      alertErr(e.message);
    });
  }

  /* ------------------------------------------------------------
     Simpan pelanggan ke kontak perangkat.

     Nama kontak memakai format "(nomor nota - nama pelanggan)" supaya
     mudah dikenali di daftar kontak. Nomor HP disimpan sebagai nomor
     telepon. Berkas .vcf dibuat lalu diunduh; perangkat yang mendukung
     berbagi (Web Share) akan membuka dialog berbagi supaya pengguna bisa
     langsung menekan "Simpan ke Kontak".
  ------------------------------------------------------------ */
  function simpanKontak(svc) {
    if (!svc) return;
    var wa = String(svc.whatsapp || '').trim();
    // Nomor WA hanya disimpan kalau resembles nomor telepon yang valid.
    if (!validWa(wa)) return;

    var nama = String(svc.customerName || '').trim() || 'Pelanggan';
    // Kontak memakai ref nota: nomor nota kalau sudah terbit, kalau belum
    // pakai ID internal. Tidak pernah kosong, dan tidak pernah "undefined".
    var ref = svc.noteNumber || svc.internalRef || 'nota';
    var display = '(' + ref + ' - ' + nama + ')';
    // Nomor disimpan dalam format internasional agar bisa dipakai dialing.
    var tel = waNum(wa);

    var vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:' + display,
      'N:' + nama + ';;;;',
      'TEL;TYPE=CELL:' + tel,
      'NOTE:Nota ' + ref + ' - ' + (svc.device || ''),
      'END:VCARD'
    ].join('\r\n');

    var fileName = 'kontak-' + ref + '.vcf';
    var blob = new Blob([vcard], { type: 'text/vcard;charset=utf-8' });
    unduhKontak(blob, fileName);
  }

  function unduhKontak(blob, fileName) {
    try {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    } catch (e) {
      // Tidak bisa mengunduh (mis. browser membatasi) — abaikan, jangan
      // ganggu alur simpan nota yang sudah berhasil.
    }
  }

  function alertErr(msg) { toast(msg || 'Gagal menyimpan'); }

  /* =========================================================
     DETAIL SERVIS — semua data satu halaman
     ========================================================= */
  // Tentukan di langkah berapa nota ini dan apa aksi berikutnya. Satu fungsi
  // ini menjadi sumber kebenaran untuk seluruh alur nota, jadi tampilan,
  // tombol, dan aturan mesin data tidak pernah berbeda.
  function flowOf(o) {
    var st = o.serviceStatus;
    var sisa = o.remaining;
    if (st === 'Done Diambil') return { step: 3, kode: 'selesai', label: 'Selesai & Lunas', tone: 'gray' };
    if (st === 'Cancel Diambil') return { step: 3, kode: 'batal', label: 'Dibatalkan & Taken', tone: 'gray' };
    if (st === 'Done') {
      // Sudah lunas: langkah terakhir bukan langsung "Diambil". Pengguna
      // wajib mengonfirmasi garansi & metode pembayaran lebih dulu, baru
      // statusnya ditutup jadi "Done Diambil".
      if (sisa <= 0) return { step: 3, kode: 'konfirmasi', label: 'Konfirmasi Garansi & Metode', tone: '' };
      return { step: 2, kode: 'bayar', label: 'Catat Pembayaran', tone: '' };
    }
    if (st === 'Cancel') return { step: 2, kode: 'taken-cancel', label: 'Tandai Sudah Diambil', tone: 'ghost' };
    if (st === 'Nggandul') return { step: 1, kode: 'status', label: 'Tentukan Status', tone: 'ghost' };
    return { step: 1, kode: 'done', label: 'Selesaikan Garapan (Done)', tone: '' };
  }

  function renderDetail(s) {
    var o = M.current;
    if (!o) { s.innerHTML = skeleton(); return; }
    setBar((o.noteIssued ? 'Nota ' : 'Servis ') + refNota(o));

    // Pembayaran hanya sah saat status "Done" (lihat helper payLocked).
    var payIsLocked = payLocked(o.serviceStatus);
    var flow = flowOf(o);

    var html = '<div class="mc-pad">';

    // Panel alur: dua baris info (langkah sekarang + sisa tagihan) dan tiga
    // chip langkah. Ini yang membuat alur tidak membingungkan — user selalu
    // tahu "saya di mana, dan selanjutnya apa".
    var stepCls = function (n) {
      if (n < flow.step) return 'ok';
      if (n === flow.step) return 'on';
      return '';
    };
    var batal = o.serviceStatus === 'Cancel' || o.serviceStatus === 'Cancel Diambil';
    html += '<div class="mc-flow">' +
      '<div class="mc-flow-top">' +
        '<span class="mc-flow-step">Langkah ' + flow.step + ' dari 3</span>' +
        '<span class="mc-flow-sisa">' +
          (o.remaining > 0 ? 'Sisa <b>' + rupiah(o.remaining) + '</b>' : '<b>Lunas</b>') +
        '</span>' +
      '</div>' +
      '<div class="mc-steps">' +
        '<div class="mc-step ' + stepCls(1) + '"><i>' + (flow.step > 1 ? '\u2713' : '1') + '</i><span>Selesaikan</span></div>' +
        '<div class="mc-step ' + stepCls(2) + ' ' + (batal ? 'cancel' : '') + '"><i>' + (flow.step > 2 ? '\u2713' : '2') + '</i><span>Bayar</span></div>' +
        '<div class="mc-step ' + stepCls(3) + ' ' + (batal ? 'cancel' : '') + '"><i>' + (flow.step > 3 ? '\u2713' : '3') + '</i><span>Konfirmasi</span></div>' +
      '</div>' +
    '</div>';

    // No. Nota dan Tanggal Masuk selalu tampil di semua status. Nomor resmi
    // baru ada setelah nota garansi diterbitkan; sebelum itu yang ditampilkan
    // adalah ref internal, tetap memakai kolom yang sama.
    html += '<div class="mc-dhead">' +
      '<div class="mc-dnote' + (o.noteIssued ? '' : ' ref') + '"' +
        (o.noteIssued ? '' : ' title="Nomor nota terbit setelah nota garansi diterbitkan"') + '>' +
        '<span class="mc-dlbl">No. Nota</span>' +
        (o.noteIssued ? '#' + esc(o.noteNumber) : esc(o.internalRef || 'Tanpa ref')) +
      '</div>' +
      '<div class="mc-dtgl"><span class="mc-dlbl">Tanggal Masuk</span>' + tglJam(o.receivedAt) + '</div>' +
      '<div class="mc-dbadges">' + badgeServis(o.serviceStatus) +
        '<span class="mc-badge ' + (o.paymentStatus === 'Lunas' ? 'ok' : o.paymentStatus === 'DP' ? 'warn' : 'neg') + '">' +
        esc(o.paymentStatus) + '</span></div>' +
    '</div>';

    // Nggandul: data nota berubah sehingga status sebelumnya tidak lagi
    // pasti. Kasih tahu alasannya supaya pemilik tahu kenapa harus memilih
    // ulang statusnya (bukan status sembarang).
    if (o.serviceStatus === 'Nggandul') {
      html += '<div class="mc-nggbox"><b>Status Nggandul \u2014 perlu dikonfirmasi</b>' +
        '<span>' + esc(o.nggandulReason || 'Data nota berubah, status sebenarnya belum pasti.') + '</span>' +
        '<span>Pilih status yang benar di bawah: Done, Done Diambil, Progress, Cancel, atau Cancel Diambil.</span></div>';
    }

    // Pelanggan & unit
    html += '<div class="mc-sec">Pelanggan &amp; Unit</div>' +
      kv('Nama', o.customerName) +
      (o.whatsapp
        ? kv('WhatsApp', '<a class="mc-link" href="https://wa.me/' + waNum(o.whatsapp) + '" target="_blank" rel="noopener">' + esc(o.whatsapp) + '</a>')
        : '') +
      kv('Device', o.device) +
      kv('Kunci Layar', o.screenLockType + (o.hasScreenLock ? ' (tersimpan)' : ''));

    // Kendala & penanganan
    html += '<div class="mc-sec">Kendala &amp; Penanganan</div>' +
      kv('Kendala', o.complaint) +
      (o.intakeCondition ? kv('Kondisi saat Diterima', o.intakeCondition) : '') +
      kv('Penanganan', o.handling || '-');

    // Sparepart
    html += '<div class="mc-sec">Sparepart</div>';
    if (o.parts.length) {
      html += '<div class="mc-ptable">';
      o.parts.forEach(function (p) {
        html += '<div class="mc-prow"><span>' + esc(p.partName) +
          '<em>' + esc(p.fundingSource) + '</em></span><b>' + rupiah(p.capitalCost) + '</b></div>';
      });
      html += '</div>';
    } else {
      html += '<p class="mc-empty sm">Belum ada sparepart.</p>';
    }
    html += '<button class="mc-ghost-btn" id="dAddPart">+ Tambah Sparepart</button>';

    // Angka
    html += '<div class="mc-sec">Rincian Biaya</div>' +
      '<div class="mc-money"><div><span>Total Biaya</span><b>' + rupiah(o.totalCost) + '</b></div>' +
      '<div><span>Modal Sparepart</span><b class="neg">' + rupiah(o.totalPart) + '</b></div></div>' +
      '<div class="mc-money"><div><span>Jasa</span><b class="pos">' + rupiah(o.serviceFee) + '</b></div>' +
      '<div><span>Sudah Dibayar</span><b class="pos">' + rupiah(o.paid) + '</b></div></div>' +
      '<div class="mc-money big"><div><span>Sisa Pelunasan</span><b class="' + (o.remaining > 0 ? 'neg' : 'pos') + '">' +
      rupiah(o.remaining) + '</b></div></div>';
    if (o.serviceFeeWarning) html += '<p class="mc-warn">' + esc(o.serviceFeeWarning) + '</p>';
    if (o.overpaidAmount) {
      html += '<p class="mc-warn">Kelebihan bayar ' + rupiah(o.overpaidAmount) + '. Catat sebagai refund atau koreksi.</p>';
    }

    // Pembayaran
    html += '<div class="mc-sec">Pembayaran</div>';
    if (o.payments.length) {
      html += '<div class="mc-ptable">';
      o.payments.forEach(function (p) {
        var extra = [];
        if (p.paymentMethod) extra.push('Metode: ' + esc(p.paymentMethod));
        if (p.warranty) extra.push('Garansi: ' + esc(p.warranty));
        html += '<div class="mc-prow"><span>' + tglJam(p.paidAt) + '<em>' + esc(p.paymentType) +
          (extra.length ? ' · ' + extra.join(' · ') : '') + '</em></span><b class="pos">+' +
          rupiah(p.amount) + '</b></div>';
      });
      html += '</div>';
    } else {
      html += '<p class="mc-empty sm">Belum ada pembayaran.</p>';
    }

    // Garansi & metode pembayaran. Dua tempat: nilai konfirmasi di level nota
    // (dipakai setelah nota ditutup), dan nilai yang ikut tersimpan di riwayat
    // pembayaran. Kalau nota sudah lunas tapi belum dikonfirmasi, tampilkan
    // pengingat supaya pengguna tahu langkah terakhir apa yang kurang.
    if (o.warranty || o.paymentMethod) {
      html += '<div class="mc-money"><div><span>Garansi</span><b>' + esc(o.warranty || '-') + '</b></div>' +
        '<div><span>Metode Bayar</span><b>' + esc(o.paymentMethod || '-') + '</b></div></div>';
    } else if (o.serviceStatus === 'Done' && o.remaining <= 0) {
      html += '<p class="mc-hint sm">Pembayaran lunas. Pilih <b>garansi</b> &amp; ' +
        '<b>metode pembayaran</b> lewat tombol di bawah untuk menutup nota.</p>';
    }

    // Pembayaran hanya bisa dicatat saat garapan sudah "Done".
    // Alurnya satu dropdown status di bawah.
    //   Progress -> Done -> Catat Pembayaran -> (lunas) Konfirmasi -> Diambil
    if (payIsLocked) {
      html += '<p class="mc-hint sm">Pembayaran dicatat setelah garapan ditandai <b>Done</b>.' +
        (o.serviceStatus === 'Done Diambil'
          ? ' Nota ini sudah diambil dan pembayaran sudah lunas.'
          : ' Status saat ini: <b>' + esc(o.serviceStatus) + '</b>.') + '</p>';
    }

    // Dana Bank
    // Catatan: tombol "Kembalikan ke Dana Bank" sengaja dihapus. Modal part
    // sudah otomatis kembali begitu nota berubah jadi "Done Diambil", jadi
    // tombol manual hanya dobel dan berisiko mengembalikan dana dua kali.
    if (o.bankUsed > 0) {
      var bankSisa = o.bankUsed - o.bankReturned;
      html += '<div class="mc-sec">Dana Bank</div>' +
        '<div class="mc-money"><div><span>Dipakai dari Dana Bank</span><b class="neg">' + rupiah(o.bankUsed) + '</b></div>' +
        '<div><span>Sudah dikembalikan</span><b class="pos">' + rupiah(o.bankReturned) + '</b></div></div>';
      if (bankSisa > 0) {
        html += '<p class="mc-hint sm">Sisa tertahan <b>' + rupiah(bankSisa) +
          '</b> — otomatis kembali saat status jadi <b>Done Diambil</b>.</p>';
      } else {
        html += '<p class="mc-hint sm ok">Dana Bank nota ini sudah lunas.</p>';
      }
    }

    // Nota garansi pelanggan.
    //
    // Dua tahap, sesuai permintaan: selama pekerjaan belum selesai atau
    // pembayaran belum lunas, nota ini BELUM punya nomor dan belum punya
    // link. Tombol terbit baru muncul setelah syaratnya benar-benar terpenuhi,
    // dan mesin data menegakkannya juga.
    html += '<div class="mc-sec">Nota Garansi</div>';
    if (o.noteIssued && o.warrantyNote) {
      var wn = o.warrantyNote;
      html += '<div class="mc-noteok">' +
        '<div class="mc-noteok-head"><b>Nota #' + esc(wn.numberLabel) + '</b>' +
        (wn.revoked
          ? '<span class="mc-badge neg">Link dicabut</span>'
          : '<span class="mc-badge ok">Aktif</span>') +
        '</div>' +
        '<div class="mc-kv"><span>Terbit</span><b>' + tglJam(wn.issuedAt) + '</b></div>' +
        '<div class="mc-kv"><span>Garansi</span><b>' + wn.warrantyDays + ' hari &middot; sampai ' +
          tglJam(wn.warrantyUntil) + '</b></div>' +
        (wn.revoked
          ? '<p class="mc-hint sm">Link nota ini sudah dicabut, jadi tidak bisa dibuka lagi. ' +
            'Nomor nota tetap ada dan tidak berubah.</p>'
          : '<p class="mc-hint sm">"Bagikan WhatsApp" dan "Salin Link" memakai <b>link mandiri</b>, ' +
            'yang bisa dibuka pelanggan dari HP-nya sendiri. Buka "Lihat Nota" untuk melihat ' +
            'link lokal (bisa dicabut).</p>') +
        '<div class="mc-acts" style="margin-top:8px">' +
          '<button class="mc-primary" id="nOpen">Lihat Nota</button>' +
          '<button class="mc-ghost-btn" id="nCopy">Salin Link</button>' +
          '<button class="mc-ghost-btn" id="nWa"' + (wn.whatsapp || '' ? '' : ' hidden') + '>Bagikan WhatsApp</button>' +
          '<button class="mc-ghost-btn" id="nPrint">Cetak / PDF</button>' +
        '</div>' +
        (wn.revoked
          ? '<button class="mc-ghost-btn danger" id="nRevoke" style="margin-top:6px">Batalkan Pencabutan</button>'
          : '<button class="mc-ghost-btn danger" id="nRevoke" style="margin-top:6px">Cabut Link Nota</button>') +
      '</div>';
    } else {
      html += '<p class="mc-hint sm">Nomor nota terbit setelah pekerjaan selesai dan pembayaran lunas. ' +
        'Sampai saat itu nota ini hanya memakai ID internal.</p>' +
        '<button class="mc-next" id="nIssue"' + (o.canIssueNote ? '' : ' disabled') + '>' +
        (o.canIssueNote
          ? 'Terbitkan Nota Garansi <em>\u00b7 buat nomor, garansi 60 hari, dan link</em>'
          : 'Terbitkan Nota Garansi <em>\u00b7 ' + esc(o.noteIssueBlock || 'belum bisa') + '</em>') +
        '</button>';
    }

    // Aksi. Hanya dropdown "Ubah Status"
    // sesuai status nota (lihat flowOf). Jadi tidak ada lagi tebakan "tombol
    // mana yang harus saya tekan". Di bawahnya dropdown status lengkap dan
    // tombol edit data.
    var statusOpts = STATUS_TRANS[o.serviceStatus] || [];

    // Penanganan hanya muncul ketika nota sudah berstatus Done. Field ini
    // sengaja tidak ada di form Tambah/Edit karena saat membuat nota statusnya
    // masih Progress dan penanganan belum ada artinya; kolomnya dimunculkan
    // di sini begitu pengerjaan dinyatakan selesai.
    // Penanganan dan Total Biaya bisa langsung diketik di layar ini, di
    // SEMUA status. Tidak ada tombol simpan terpisah: nilai tersimpan saat
    // kursor keluar dari kolomnya. Tombol Simpan dahulu disembunyikan selalu
    // dan teksnya tidak pernah terlihat karena pembungkusnya membawa kelas
    // mc-none sejak awal.
    html += '<div class="mc-sec">Biaya &amp; Penanganan</div>' +
      '<label class="mc-field"><span class="mc-lbl">Total Biaya (Rp)</span>' +
        '<input class="mc-inp" id="dTotal" inputmode="numeric" placeholder="0" value="' +
        esc(o.totalCost != null && o.totalCost !== '' ? String(o.totalCost) : '') + '">' +
      '</label>' +
      '<label class="mc-field"><span class="mc-lbl">Penanganan</span>' +
        '<textarea class="mc-inp" id="dHandling" rows="2" placeholder="Contoh: ganti LCD, ganti baterai, bersihkan bagian dalam">' +
          esc(o.handling || '') + '</textarea>' +
      '</label>' +
      '<p class="mc-hint sm" id="dSavedHint"></p>' +
      '<p class="mc-hint sm">Tersimpan otomatis saat kursor berpindah. ' +
        'Atau tekan <b>Simpan</b> di sebelah tombol Ubah Status — ' +
        'lalu ubah status ke Done Diambil.</p>';

    // Tombol aksi besar ("Selesaikan Garapan", "Catat Pembayaran") dan tombol
    // Hapus sudah dihapus di SEMUA status. Status hanya berubah lewat dropdown
    // "Ubah Status" di bawah, supaya tidak ada lagi dua jalan mengubah status
    // yang bisa berbeda satu sama lain.
    html += '<div class="mc-sec">Ubah Status</div>';
    html += '<div class="mc-acts mc-side">' +
      // Simpan dan Ubah Status berdampingan. kejelasan tombol simpan
      // khusus: penanganan harus benar-benar tersimpan sebelum status diubah, dan
      // sekarang bisa dipastikan tanpa menebak-nebak apakah blur sempat
      // terjadi.
      '<button class="mc-ghost-btn mc-save-side" id="dSaveSide">Simpan</button>' +
      '<div class="mc-drop mc-grow" id="dStatusDrop">' +
        '<button class="mc-ghost-btn" id="dStatusBtn">Ubah Status \u25be</button>' +
        (statusOpts.length
          ? '<div class="mc-dropmenu" id="dStatusMenu">' +
            statusOpts.map(function (st) {
              return '<button class="mc-pick" data-st="' + esc(st) + '">' + esc(st) + '</button>';
            }).join('') + '</div>'
          : '<div class="mc-dropmenu"><span class="mc-hint sm">Status sudah final.</span></div>') +
      '</div>' +
    '</div>';

    html += '</div>';
    s.innerHTML = html;
    bindDetail();
  }

  function kv(k, v) {
    return '<div class="mc-kv"><span>' + esc(k) + '</span><b>' + (v === '' ? '-' : v) + '</b></div>';
  }

  // Ubah status nota. Dipakai oleh dropdown "Ubah Status" dan oleh tombol
  // dari dropdown "Ubah Status", jadi semuanya lewat satu jalur yang sama (satu tempat
  // untuk validasi, pesan sukses, dan penanganan error).
  function applyStatus(orderId, want) {
    api('POST', '/api/mascim/services/' + encodeURIComponent(orderId) + '/status',
      { service_status: want })
      .then(function () {
        loadDetail(orderId); reload();
        toast('Status: ' + want);
      })
      .catch(function (er) { alertErr(er.message); });
  }

  function bindDetail() {
    // Penyimpanan otomatis: nilai dikirim saat kursor berpindah dari kolom,
    // bukan lewat tombol. Dua kolom memakai satu jalur supaya tidak ada
    // permintaan yang saling menimpa ketika keduanya berubah berdekatan.
    var sedangSimpan = false;
    // Penanda kecil di bawah kolom: memberi tahu penanganan sudah benar-benar
    // tersimpan, jadi tidak perlu menebak apakah tombol status bisa dipakai.
    function markTersimpan(pesan) {
      var el = $('#dSavedHint');
      if (el) el.textContent = pesan || '\u2713 Tersimpan';
    }

    function simpanOtomatis(bidang, nilai, label) {
      if (sedangSimpan) return;
      var id = idNota();
      if (!id) { alertErr('Nota ini belum punya identitas. Muat ulang halamannya.'); return; }
      sedangSimpan = true;
      api('PATCH', '/api/mascim/services/' + encodeURIComponent(id), bidang)
        .then(function (r) {
          sedangSimpan = false;
          if (r.service) { M.current = r.service; M.id = r.service.id; }
          toast(label + ' tersimpan');
          markTersimpan('\u2713 ' + label + ' tersimpan');
          reload();
        })
        .catch(function (err) {
          sedangSimpan = false;
          alertErr('Gagal menyimpan ' + label.toLowerCase() + ': ' + (err && err.message || err));
        });
    }
    // Id nota selalu diambil dari nota yang sedang tampil, bukan dari
    // penanda yang bisa saja tertinggal.
    function idNota() {
      return (M.current && M.current.id) || M.id;
    }

    // Tombol Simpan di sebelah Ubah Status: menyimpan penanganan DAN total
    // biaya sekaligus, dengan umpan balik yang jelas.
    var sideSave = $('#dSaveSide');
    if (sideSave) {
      sideSave.addEventListener('click', function () {
        if (sedangSimpan || M.lock) return;
        var id = idNota();
        if (!id) { alertErr('Nota ini belum punya identitas. Muat ulang halamannya.'); return; }
        var tEl = $('#dTotal'), hEl = $('#dHandling');
        var biaya = tEl ? (parseInt(String(tEl.value || '').replace(/\D/g, ''), 10) || 0) : null;
        var handling = hEl ? hEl.value.trim() : '';
        sedangSimpan = true;
        sideSave.disabled = true;
        var isi = {};
        if (biaya !== null && (!M.current || biaya !== M.current.totalCost)) isi.total_cost = biaya;
        if (handling !== (M.current ? (M.current.handling || '') : '')) isi.handling = handling;
        if (!Object.keys(isi).length) {
          sedangSimpan = false;
          sideSave.disabled = false;
          sideSave.textContent = '\u2713 Sudah tersimpan';
          setTimeout(function () { sideSave.textContent = 'Simpan'; }, 1400);
          return;
        }
        api('PATCH', '/api/mascim/services/' + encodeURIComponent(id), isi)
          .then(function (r) {
            sedangSimpan = false;
            if (r.service) { M.current = r.service; M.id = r.service.id; }
            sideSave.textContent = '\u2713 Tersimpan';
            setTimeout(function () { sideSave.textContent = 'Simpan'; }, 1400);
            markTersimpan();
            loadDetail(id);
          })
          .catch(function (err) {
            sedangSimpan = false;
            sideSave.disabled = false;
            sideSave.textContent = 'Simpan';
            alertErr('Gagal menyimpan: ' + (err && err.message || err));
          });
      });
    }

    var dTotal = $('#dTotal');
    if (dTotal) {
      dTotal.addEventListener('blur', function () {
        var v = parseInt(String(dTotal.value || '').replace(/\D/g, ''), 10) || 0;
        if (M.current && v === M.current.totalCost) return;
        simpanOtomatis({ total_cost: v }, v, 'Total Biaya');
      });
    }
    var dHandling = $('#dHandling');
    if (dHandling) {
      dHandling.addEventListener('blur', function () {
        var v = dHandling.value.trim();
        if (M.current && v === (M.current.handling || '')) return;
        simpanOtomatis({ handling: v }, v, 'Penanganan');
      });
    }
    var s = screen();
    var o = M.current;

    // Tombol "Ubah Status" sekarang dropdown inline (bukan sheet). Hanya
    // pilihan status yang valid sesuai status saat ini yang ditawarkan.
    var statusBtn = $('#dStatusBtn');
    if (statusBtn) statusBtn.addEventListener('click', function () {
      var menu = $('#dStatusMenu');
      if (!menu) return;
      var open = menu.style.display === 'block';
      menu.style.display = open ? '' : 'block';
    });
    // Tutup dropdown kalau user mengklik di luar. Listener dipasang satu kali
    // saja (dijaga flag) — kalau ditambah tiap kali detail dirender, penumpukan
    // listener membuat satu klik memicu banyak handler sekaligus.
    if (!dropOutsideBound) {
      dropOutsideBound = true;
      document.addEventListener('click', function (e) {
        var menu = $('#dStatusMenu');
        var drop = $('#dStatusDrop');
        if (!menu || !drop) return;
        if (drop.contains(e.target)) return;
        menu.style.display = '';
      });
    }
    var statusMenu = $('#dStatusMenu');
    // Status final tidak punya pilihan berikutnya, jadi menu-nya memang tidak
    // ada. Jangan pernah dereference langsung — kalau tidak, error ini
    // menghentikan seluruh penempelan listener di bawah (Ubah Status/Simpan/
    // Tambah Pembayaran/Hapus ikut mati semua).
    if (statusMenu) statusMenu.addEventListener('click', function (e) {
      var st = e.target.closest('[data-st]');
      if (!st) return;
      var want = st.dataset.st;
      statusMenu.style.display = '';
      // Menutup nota jadi "Done Diambil" tidak langsung mengubah status:
      // garansi dan metode pembayaran harus dipilih dulu lewat sheet, dan
      // tombol submit di sheet itulah yang benar-benar menutup nota. Jadi
      // tidak ada nota "Done Diambil" yang tanpa garansi.
      if (want === 'Done Diambil') {
        // Syarat wajib: penanganan harus terisi lebih dulu. Nota yang ditutup
        // tanpa keterangan pekerjaan tidak bisa ditindaklanjuti Exceptions,
        // dan biaya pun tidak bisa dipertanggungjawabkan ke pelanggan.
        // Ditahan di sini, bukan hanya di lapisan data, supaya sheet garansi tidak
        // pernah terbuka untuk nota yang belum lengkap.
        // Yang dibaca adalah kolom yang SEDANG diketik, bukan salinan nota
        // di memori. Kolom bisa sudah berisi teks sementara catatannya masih
        // kosong karena simpan otomatisnya belum selesai; membaca yang lama
        // membuat penanganan yang sudah diketik tetap dianggap kosong.
        var el = $('#dHandling');
        var ketik = el ? el.value.trim() : '';
        var tersimpan = (o.handling || '').trim();
        if (!ketik && !tersimpan) {
          alertErr('Penanganan wajib diisi sebelum status diubah ke Done Diambil.\n\n' +
            'Tulis dulu apa yang dikerjakan pada nota ini — kolomnya ada di ' +
            'bagian "Biaya & Penanganan" pada layar ini.');
          statusMenu.style.display = 'none';
          if (el) { el.focus(); el.scrollIntoView({ block: 'center' }); }
          return;
        }
        // Tombol status bisa ditekan sebelum blur sempat menyimpan. Simpan
        // dulu, baru buka sheet — kalau tidak, nota bisa tertutup tanpa
        // penanganan ikut tersimpan.
        if (ketik && ketik !== tersimpan) {
          statusMenu.style.display = 'none';
          var idGuard = idNota();
          if (!idGuard) { alertErr('Nota ini belum punya identitas. Muat ulang halamannya.'); return; }
          api('PATCH', '/api/mascim/services/' + encodeURIComponent(idGuard), { handling: ketik })
            .then(function () {
              markTersimpan('\u2713 Penanganan tersimpan');
              return loadDetail(idGuard).catch(function () { return null; });
            })
            .then(function () { openConfirmSheet(); })
            .catch(function (err) {
              alertErr('Gagal menyimpan penanganan: ' + (err && err.message || err));
              statusMenu.style.display = '';
            });
          return;
        }
        statusMenu.style.display = 'none';
        openConfirmSheet();
        return;
      }
      applyStatus(o.id, want);
    });

    // Tombol aksi besar dihapus: perubahan status hanya lewat dropdown
    // "Ubah Status", jadi tidak ada dua jalur yang bisa berbeda.

    // Tombol "Edit Data" membuka form isian nota.
    // Tombol Edit dihapus: Penanganan dan Total Biaya bisa langsung diketik
    // di layar ini, jadi tidak perlu membuka form.

    // --- Nota garansi pelanggan ---
    // Terbitkan: hanya aktif setelah syarat terpenuhi. Mesin data tetap
    // memeriksa lagi, jadi menekan lewat Developer Tools tidak bisa membuat
    // nota terbit lebih awal.
    var issueBtn = $('#nIssue');
    if (issueBtn) issueBtn.addEventListener('click', function () {
      if (issueBtn.disabled) return;
      issueBtn.disabled = true;
      api('POST', '/api/mascim/services/' + encodeURIComponent(M.current.id) + '/issue-note')
        .then(function (r) {
          loadDetail(M.current.id);
          toast(r.reused
            ? 'Nota #' + r.note.numberLabel + ' sudah ada — link sama, tidak dibuat baru'
            : 'Nota #' + r.note.numberLabel + ' terbit \u00b7 garansi ' + r.note.warrantyDays + ' hari');
          setTimeout(function () { openNoteSheet(r.note); }, 250);
        })
        .catch(function (e) {
          issueBtn.disabled = false;
          toast(errMsg(e));
        });
    });

    var noteOpen = $('#nOpen');
    if (noteOpen) noteOpen.addEventListener('click', function () {
      openNoteSheet(M.current.warrantyNote);
    });
    var noteCopy = $('#nCopy');
    if (noteCopy) noteCopy.addEventListener('click', function () {
      var wn = M.current.warrantyNote;
      if (!wn) return;
      if (wn.revoked) { toast('Link sudah dicabut, tidak bisa disalin'); return; }
      // Tombol "salin" memakai link mandiri supaya bisa langsung dikirim
      // ke pelanggan dan tetap terbuka di HP-nya.
      var link = noteLink(wn, 'mandiri') || noteLink(wn, 'lokal');
      copyText(link, 'Link nota disalin');
    });
    var noteWa = $('#nWa');
    if (noteWa) noteWa.addEventListener('click', function () {
      bagikanWhatsapp(M.current.warrantyNote);
    });
    var notePrint = $('#nPrint');
    if (notePrint) notePrint.addEventListener('click', function () {
      cetakNota(M.current.warrantyNote);
    });
    var noteRevoke = $('#nRevoke');
    if (noteRevoke) noteRevoke.addEventListener('click', function () {
      konfirmasiCabutNota(M.current.warrantyNote);
    });

    var partBtn = $('#dAddPart');
    if (partBtn) partBtn.addEventListener('click', function () { openPartSheet(); });

    // Tombol Hapus dihapus di semua status.
  }

  // Menutup sheet dengan aman. Semua aksi Simpan memanggil ini; kalau w.App
  // tidak tersedia, menutup sheet tidak boleh melempar error karena itu
  // akan membatalkan penyimpanan yang sedang berjalan.
  /* =========================================================
     NOTA GARANSI — tampilan, link, berbagi, cetak
     =========================================================

     Semua isi yang ditampilkan ke pelanggan dibangun dari objek nota yang
     sudah disaring mesin data (lihat publicNote). Fungsi-fungsi di bawah
     TIDAK membaca data nota mentah, jadi tidak ada jalan bagi PIN, pola
     layar, modal sparepart, Dana Bank, atau catatan internal untuk ikut
     terbawa ke link, pesan WhatsApp, maupun cetakan.

  */
  function noteLink(wn, jenis) {
    if (!wn) return '';
    var dir = '';
    try { dir = w.location.href.split('#')[0].replace(/[^/]+$/, ''); } catch (e) { dir = ''; }

    if (jenis === 'mandiri') {
      // Isi nota ikut di dalam tautan, jadi bisa dibuka dari HP mana pun.
      var muatan = '';
      try { muatan = (L && L.encodePublicNote) ? L.encodePublicNote(wn) : ''; } catch (e) { muatan = ''; }
      if (!muatan) return '';
      return dir + 'nota.html#/s/' + muatan;
    }
    if (!wn.token) return '';
    // Link lokal berbasis token: bisa dicabut, tapi hanya berlaku di
    // perangkat ini.
    return dir + 'nota.html#/nota/' + wn.token;
  }

  // Satu-satunya sumber isi nota. Dipakai LIHAT, SALIN, WHATSAPP, dan CETAK
  // supaya keempat tampilan itu dijamin sama persis.
  function noteHtml(wn) {
    if (!wn) return '<p class="mc-empty">Nota belum diterbitkan.</p>';
    if (wn.revoked) {
      return '<div class="mc-noterevoked">' +
        '<b>Nota ini sudah dicabut</b>' +
        '<span>Link-nya tidak berlaku lagi. Hubungi Mas Cim Service HP bila ' +
        'masih membutuhkan info nota.</span></div>';
    }
    var h = '<div class="mc-note-doc">' +
      '<div class="mc-note-doc-head">' +
        '<div><span>Nota Service</span><b>#' + esc(wn.numberLabel) + '</b></div>' +
      '</div>';

    // Wajib sama persis dengan htmlNota() di nota.html. Kalau isinya berbeda,
    // apa yang terlihat saat preview bisa berbeda dari yang dilihat pelanggan
    // dari link — dan itu tidak boleh terjadi.
    h += '<div class="mc-sec">Pelanggan &amp; Unit</div>' +
      kv('Nama', esc(wn.customerName)) +
      kv('Unit', esc(wn.device)) +
      (wn.whatsapp ? kv('WhatsApp', esc(waSamar(wn.whatsapp))) : '');

    h += '<div class="mc-sec">Penanganan</div>' +
      kv('Penanganan akhir', esc(wn.handling || 'Tidak ada penanganan tambahan'));

    h += '<div class="mc-sec">Biaya &amp; Garansi</div>' +
      '<div class="mc-money big"><div><span>Total Biaya</span><b>' + rupiah(wn.totalCost) + '</b></div></div>' +
      kv('Masa Garansi', wn.warrantyDays + ' hari · berlaku sampai ' +
        tglJam(wn.warrantyUntil)) +
      kv('Tanggal Pengambilan', wn.takenAt ? tglJam(wn.takenAt) : 'Belum diambil');

    h += '</div>';
    return h;
  }

  // Nomor WhatsApp ditampilkan sebagian saja di nota. Link nota bisa
  // diteruskan, jadi nomor penuh tidak perlu ikut.
  function waSamar(wa) {
    var s = String(wa || '').replace(/[\s-]/g, '');
    if (s.length <= 6) return s;
    return s.slice(0, 5) + '*****' + s.slice(-3);
  }

  function copyText(text, pesan) {
    var selesai = function () { toast(pesan || 'Disalin'); };
    var gagal = function () { alertErr('Tidak bisa menyalin otomatis. Salin manual dari layar nota.'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(selesai, function () { fallbackCopy(text, selesai, gagal); });
    } else {
      fallbackCopy(text, selesai, gagal);
    }
  }

  function fallbackCopy(text, ok, no) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      var copied = document.execCommand && document.execCommand('copy');
      document.body.removeChild(ta);
      if (copied) ok(); else no();
    } catch (e) { no(); }
  }

  // Sheet "Lihat Nota": pratinjau persis seperti yang dilihat pelanggan,
  // ditambah link supaya bisa disalin.
  function openNoteSheet(wn) {
    if (!wn) return;
    var linkMandiri = noteLink(wn, 'mandiri');
    var linkLokal = noteLink(wn, 'lokal');

    var body = '';
    if (!wn.revoked) {
      if (linkMandiri) {
        body += '<div class="mc-note-link">' +
          '<span>Link mandiri &mdash; untuk dikirim ke pelanggan</span>' +
          '<code id="nLinkText">' + esc(linkMandiri) + '</code>' +
          '<small>Bisa dibuka dari HP mana pun. Hanya berisi data nota yang memang ' +
          'boleh dilihat pelanggan.</small>' +
        '</div>';
      }
      if (linkLokal) {
        body += '<div class="mc-note-link alt">' +
          '<span>Link lokal &mdash; bisa dicabut</span>' +
          '<code>' + esc(linkLokal) + '</code>' +
          '<small>Hanya berlaku di perangkat ini, tapi bisa dicabut bila ' +
          'link-nya tidak ingin dibagikan lagi.</small>' +
        '</div>';
      }
    }
    body += noteHtml(wn);

    sheetOrWarn('Nota #' + wn.numberLabel, body, function () {
      function tombol(teks, fn, mati) {
        var b = document.createElement('button');
        b.className = 'mc-primary';
        b.style.marginTop = '12px';
        b.textContent = teks;
        b.disabled = !!mati;
        b.addEventListener('click', fn);
        return b;
      }
      var wrap = document.querySelector('.mc-sheet-foot') || document.querySelector('.mc-sheet-body') || null;
      function taruh(b) { if (wrap) wrap.appendChild(b); else b.style.display = 'block'; }

      if (linkMandiri) {
        taruh(tombol('Salin Link Mandiri', function () {
          copyText(linkMandiri, 'Link mandiri disalin');
        }, wn.revoked));
      }
      if (linkLokal) {
        taruh(tombol('Salin Link Lokal (bisa dicabut)', function () {
          copyText(linkLokal, 'Link lokal disalin');
        }, wn.revoked));
      }
    });
  }

  // Pesan WhatsApp. Isinya ringkas: identitas, penanganan, biaya, garansi,
  // dan link. Tidak ada PIN, tidak ada modal part, tidak ada Dana Bank.
  function pesanWhatsapp(wn) {
    if (!wn || wn.revoked) return null;
    var lines = [];
    lines.push('*NOTA SERVICE — MAS CIM SERVICE HP*');
    lines.push('No. Nota: #' + wn.numberLabel);
    lines.push('Diterbitkan: ' + tglJam(wn.issuedAt));
    lines.push('');
    lines.push('Pelanggan: ' + wn.customerName);
    lines.push('Unit: ' + wn.device);
    lines.push('Keluhan: ' + wn.complaint);
    if (wn.intakeCondition) lines.push('Kondisi saat diterima: ' + wn.intakeCondition);
    if (wn.parts && wn.parts.length) lines.push('Sparepart: ' + wn.parts.join(', '));
    lines.push('Penanganan: ' + (wn.handling || '-'));
    lines.push('');
    lines.push('Total biaya: ' + rupiah(wn.totalCost));
    if (wn.paidAt) lines.push('Tanggal lunas: ' + tglJam(wn.paidAt));
    if (wn.warrantyDays > 0) {
      lines.push('Masa garansi: ' + wn.warrantyDays + ' hari (sampai ' + tglJam(wn.warrantyUntil) + ')');
    } else {
      // Non garansi berarti link tanpa batas waktu. Menuliskan "0 hari"
      // akan disalahartikan sebagai kedaluwarsa.
      lines.push('Masa garansi: tanpa batas waktu (non garansi)');
    }
    lines.push('');
    lines.push('Lihat nota (baca saja):');
    // Ke pelanggan dikirim link mandiri, karena hanya itu yang bisa dibuka
    // dari HP dia. Isinya sudah disaring sejak dibuat.
    var link = noteLink(wn, 'mandiri') || noteLink(wn, 'lokal');
    if (link) lines.push(link);
    return lines.join('\n');
  }

  /* Salin teks ke papan klip. navigator.clipboard sering tidak ada di
     WebView Telegram atau hanya boleh jalan di konteks aman, jadi ada
     jalur cadangan berbasis textarea. */
  function salin(teks) {
    if (!teks) return false;
    try {
      if (navigator.clipboard && w.isSecureContext) {
        navigator.clipboard.writeText(teks);
        return true;
      }
    } catch (e) { /* lanjut ke jalur cadangan */ }
    try {
      var ta = document.createElement('textarea');
      ta.value = teks;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      var ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  function bagikanWhatsapp(wn) {
    if (!wn) return;
    if (wn.revoked) { toast('Link sudah dicabut, tidak bisa dibagikan'); return; }
    var pesan = pesanWhatsapp(wn);
    if (!pesan) return;
    var target = (M.current && M.current.whatsapp) ? waNum(M.current.whatsapp) : '';
    var url = 'https://wa.me/' + (target || '') + '?text=' + encodeURIComponent(pesan);

    // Membuka wa.me dari WebView bisa ditolak tanpa pesan apa pun, jadi
    // selalu siapkan jalan kedua: salin pesannya ke papan klip sehingga
    // teknisi cukup menempelkannya di WhatsApp. Peringatan baru muncul setelah jeda singkat, karena tidak ada
    // cara pasti mengetahui apakah jendela wa.me benar-benar terbuka.
    var belumTerbuka = setTimeout(function () {
      var msg = 'Tidak ada WhatsApp yang terbuka otomatis. '
        + 'Pesan + link nota sudah disalin — tempel di chat pelanggan.';
      try { salin(pesan); } catch (e) {}
      alertErr(msg);
    }, 2500);
    var tandai = function () { clearTimeout(belumTerbuka); };

    try {
      var win = w.open(url, '_blank', 'noopener');
      if (win) { win.addEventListener('pagehide', tandai); setTimeout(tandai, 2000); }
      else tandai();
    } catch (e) {
      tandai();
      try { salin(pesan); } catch (e2) {}
      alertErr('Pesan + link nota sudah disalin — tempel di chat pelanggan.');
    }
  }

  // Cetak / PDF. Cetak ke printer atau simpan jadi PDF lewat dialog cetak
  // perangkat. Isinya sama persis dengan noteHtml, jadi tidak ada data
  // tambahan yang bocor saat dicetak.
  function cetakNota(wn) {
    if (!wn) return;
    if (wn.revoked) { toast('Link sudah dicabut, nota tidak bisa dicetak'); return; }
    var host = document.getElementById('mcPrint');
    if (!host) {
      host = document.createElement('div');
      host.id = 'mcPrint';
      host.className = 'mc-print';
      document.body.appendChild(host);
    }
    host.innerHTML =
      '<div class="mc-print-doc">' +
        '<div class="mc-print-head">' +
          '<div class="mc-print-brand">MAS CIM SERVICE HP</div>' +
          '<div class="mc-print-no">NOTA #<b>' + esc(wn.numberLabel) + '</b></div>' +
        '</div>' +
        noteHtml(wn) +
        '<p class="mc-print-foot">Nota ini bersifat baca saja dan berlaku ' +
        wn.warrantyDays + ' hari sejak tanggal terbit.</p>' +
      '</div>';
    // Beri jeda supaya browser sempat menghitung ulang tampilan sebelum
    // membuka dialog cetak.
    setTimeout(function () {
      try { w.print(); } catch (e) { toast('Tidak bisa membuka dialog cetak'); }
    }, 60);
  }

  function konfirmasiCabutNota(wn) {
    if (!wn) return;
    var mencabut = !wn.revoked;
    sheetOrWarn(mencabut ? 'Cabut Link Nota' : 'Batalkan Pencabutan',
      '<p class="mc-hint">' + (mencabut
        ? 'Setelah dicabut, link yang sudah dibagikan ke pelanggan tidak bisa ' +
          'dibuka lagi. Nomor nota dan datanya tetap tersimpan.'
        : 'Link nota akan aktif lagi dan bisa dibuka dari tautan yang sebelumnya.') + '</p>',
      function (body) {
        var b = document.createElement('button');
        b.className = 'mc-primary' + (mencabut ? ' danger' : '');
        b.style.marginTop = '12px';
        b.textContent = mencabut ? 'Ya, Cabut Link' : 'Ya, Aktifkan Lagi';
        b.addEventListener('click', function () {
          tutupSheet();
          api('POST', '/api/mascim/services/' + encodeURIComponent(M.current.id) +
            (mencabut ? '/revoke-note' : '/unrevoke-note'))
            .then(function () {
              loadDetail(M.current.id);
              toast(mencabut ? 'Link nota dicabut' : 'Link nota aktif lagi');
            })
            .catch(function (e) { alertErr(errMsg(e)); });
        });
        body.appendChild(b);
      });
  }

  function tutupSheet() {
    try { if (w.App && w.App.closeSheet) w.App.closeSheet(); } catch (e) {}
  }

  // Semua form Mas Cim lewat sheet. Kalau App.sheet tidak tersedia (mis.
  // modul app.js belum termuat) jangan diam-diam gagal: beri tahu user.
  function sheetOrWarn(title, html, onOpen) {
    if (!w.App || typeof w.App.sheet !== 'function') {
      alertErr('Form tidak bisa dibuka. Muat ulang aplikasi.');
      return;
    }
    w.App.sheet(title, html, onOpen);
  }

  /* Label satu harga tersimpan di Kalkulator Service.
       Dipakai ulang oleh sheet Tambah Sparepart supaya labelnya sama persis
       dengan yang tampil di daftar "Harga tersimpan". */
  function labelTplSingkat(p) {
    var brand = p.brandName || 'Tanpa brand';
    var seri = p.series || '-';
    return brand + ' ' + seri;
  }

  /* Simpan harga sparepart ke Kalkulator Service supaya bisa dipakai lagi
     di nota berikutnya tanpa diketik ulang.
     Bentuk payload-nya sengaja dibuat sama persis dengan calc.js (lihat
     saveTpl di sana) supaya keduanya membaca koleksi yang sama: kunci unik
     brand + seri + ruleId, sama seperti logika anti-duplikat di Kalkulator. */
  /* Menyimpan harga ke Kalkulator lewat satu fungsi di store.js, sama dengan
     yang dipakai Kalkulator Service. Fungsi itu memakai kunci
     brand|seri|rule yang deterministik: kombinasi sama SELALU mengganti
     harga lamanya, tidak pernah menumpuk. Hasilnya dikembalikan supaya
     kegagalan bisaditunjukkan ke pengguna, bukan diam-diam hilang. */
  function upsertTplBrandSeri(brandId, seri, rule, part, est) {
    if (!brandId || !seri || !rule) {
      return { ok: false, reason: 'Pilih brand, seri, dan perhitungan dulu' };
    }
    var brand = (w.CalcUI.BRANDS || []).filter(function (b) {
      return b.id === brandId;
    })[0];
    if (!brand) return { ok: false, reason: 'Brand tidak dikenal' };
    return w.Store.upsertTemplate({
      brandId: brandId, brandName: brand.name,
      series: seri, ruleId: rule.id, part: part, est: est
    });
  }


  /* Harga tersimpan untuk device + jenis part tertentu, kalau ada. */
  function cariTplBrandSeri(brandId, seri, ruleId) {
    return (w.Store.state.templates || []).filter(function (t) {
      var p = t.payload || {};
      return p.brandId === brandId && p.series === seri && p.ruleId === ruleId;
    })[0] || null;
  }

  /* Nama jenis sparepart yang wajar dipakai di nota, dari id rule Kalkulator.
     Rule-nya sebenarnya soal rumus harga (LCD/Baterai/dll), jadi nama part
     diturunkan dari situ supaya konsisten dengan Kalkulator. */
  function namaPartDariRule(rule) {
    if (/iphone/i.test(rule.id)) return rule.id.indexOf('baterai') === 0 ? 'Baterai iPhone' : 'LCD iPhone';
    if (/baterai/i.test(rule.id)) return 'Baterai';
    if (/oled/i.test(rule.id)) return 'LCD OLED';
    if (/bagus/i.test(rule.id)) return 'LCD Premium';
    return 'LCD';
  }

  function openPartSheet() {
    // Dua sumber, tapi tujuannya nol ketik: kalau harga untuk device ini sudah
    // pernah tersimpan di Kalkulator, modal dan estimasi terisi otomatis
    // begitu jenis sparepart dipilih. Kalau belum pernah, form membuka isian
    // manual — dan begitu disimpan, harga itu otomatis masuk Kalkulator
    // sehingga nota berikutnya untuk device yang sama tinggal pilih.
    var deviceBits = pisahDevice(M.current && M.current.device);
    var brandId = deviceBits[0], seri = deviceBits[1];
    var RULES = w.CalcUI.RULES || [];

    var head = '';
    if (brandId && seri) {
      head = '<p class="mc-hint">Unit: ' + esc(seri) + '</p>';
    }

    // Dropdown jenis sparepart. Tanpa brand/seri yang jelas, jenis tetap
    // bisa dipilih supaya teknisi tetap bisa mencatat apa pun.
    var jenis = RULES.length
      ? '<div class="mc-field">' +
          '<span class="mc-lbl">Jenis sparepart</span>' +
          '<select class="mc-inp" id="pRule">' +
            '<option value="">— pilih jenis —</option>' +
            RULES.map(function (r) { return '<option value="' + esc(r.id) + '">' + esc(namaPartDariRule(r)) + '</option>'; }).join('') +
          '</select>' +
        '</div>'
      : '';

    sheetOrWarn('Tambah Sparepart',
      '<div class="mc-pad">' + head + jenis +
        '<div class="mc-row2">' +
          '<label class="mc-field"><span class="mc-lbl">Nama Part *</span>' +
            '<input class="mc-inp" id="pName" placeholder="Contoh: LCD AMOLED"></label>' +
          '<label class="mc-field"><span class="mc-lbl">Modal (Rp) *</span>' +
            '<input class="mc-inp" id="pCost" inputmode="numeric" placeholder="0"></label>' +
        '</div>' +
        '<label class="mc-field"><span class="mc-lbl">Estimasi harga jual (Rp)</span>' +
          '<input class="mc-inp" id="pEst" inputmode="numeric" placeholder="otomatis dari modal"></label>' +
        '<p class="mc-hint" id="pHint"></p>' +
      '</div>',
      function (body) {
        var ruleSel = $('#pRule', body);
        var estIn = $('#pEst', body);
        var nameIn = $('#pName', body);
        var costIn = $('#pCost', body);
        var hint = $('#pHint', body);

        function ruleById(id) {
          return RULES.filter(function (r) { return r.id === id; })[0] || null;
        }

        function terisiOtomatis(rule) {
          // Kalau harga device ini sudah pernah tersimpan, isi modal + estimasi
          // dan kunci agar tidak berubah tak sengaja. Ini inti "nol ketik".
          var tpl = cariTplBrandSeri(brandId, seri, rule.id);
          if (!tpl || !(tpl.payload.part > 0)) return false;
          costIn.value = tpl.payload.part;
          estIn.value = w.CalcUI.hitung(tpl.payload.part, rule).est;
          costIn.readOnly = true;
          estIn.readOnly = true;
          return true;
        }

        if (ruleSel) {
          ruleSel.addEventListener('change', function () {
            var rule = ruleById(ruleSel.value);
            costIn.readOnly = false;
            estIn.readOnly = false;
            costIn.value = '';
            estIn.value = '';
            if (!rule) { hint.textContent = ''; return; }
            nameIn.value = namaPartDariRule(rule);
            if (!brandId || !seri) {
              hint.textContent = 'Brand atau seri belum lengkap, isi harga manual.';
              return;
            }
            if (terisiOtomatis(rule)) {
              hint.textContent = 'Terisi otomatis dari Kalkulator — harga ini tersimpan untuk ' +
                seri + '. Bisa dibuka dengan edit.';
            } else {
              hint.textContent = 'Belum ada harga tersimpan untuk ' + seri +
                '. Isi modal dan estimasinya manual — nanti tersimpan otomatis untuk nota berikutnya.';
              costIn.focus();
            }
            TG.haptic('success');
          });
        }

        var b = document.createElement('button');
        b.className = 'mc-primary';
        b.style.marginTop = '12px';
        b.textContent = 'Simpan Sparepart';
        b.addEventListener('click', function () {
          var name = (nameIn.value || '').trim();
          if (!name) { alertErr('Nama part wajib diisi'); return; }
          var cost = parseInt(String(costIn.value).replace(/\D/g, ''), 10) || 0;
          var est = parseInt(String(estIn.value).replace(/\D/g, ''), 10) || 0;
          var rule = ruleSel ? ruleById(ruleSel.value) : null;
          // Estimasi boleh kosong — kalau diisi dipakai, kalau tidak dihitung
          // dari modal memakai rumus Kalkulator yang sama.
          if (!est && rule && cost > 0) est = w.CalcUI.hitung(cost, rule).est;

          tutupSheet();
          api('POST', '/api/mascim/services/' + encodeURIComponent(M.current.id) + '/parts',
            { part_name: name, capital_cost: cost })
            .then(function () {
              // Otomatis tersimpan di Kalkulator supaya nota berikutnya nol ketik.
              upsertTplBrandSeri(brandId, seri, rule, cost, est);
              toast('Sparepart ditambahkan');
              loadDetail(M.current.id);
              reload();
            })
            .catch(function (e) { alertErr(e.message); });
        });
        body.appendChild(b);
      });
  }

  /*
     Step 2 — Catat pembayaran.

     Sengaja dibuat sesingkat mungkin: hanya nominal, tombol Lunasi, penanda DP,
     dan catatan. Garansi & metode pembayaran TIDAK ditanyakan di sini karena
     keduanya baru bermakna setelah pelunasan, dan menanyakannya di awal hanya
     membuat sheet ini panjang tanpa ada gunanya. Keduanya dipindah ke step 3
     (konfirmasi) — lihat openConfirmSheet.
  */
  function openPaySheet() {
    var o = M.current;
    var sisa = o.remaining;
    var dp = o.paid === 0 && sisa > 0;

    sheetOrWarn('Catat Pembayaran',
      '<p class="mc-hint">Sisa tagihan: <b class="' + (sisa > 0 ? 'neg' : 'pos') + '">' + rupiah(sisa) + '</b></p>' +
      '<div class="mc-amtrow">' +
        '<label class="mc-field"><span class="mc-lbl">Nominal (Rp) *</span>' +
        '<input class="mc-inp" id="payAmt" inputmode="numeric" value="' + (sisa > 0 ? sisa : '') + '"></label>' +
        (sisa > 0 ? '<button class="mc-lunasi" id="payFull">Lunasi</button>' : '') +
      '</div>' +
      (dp ? '<label class="mc-check"><input type="checkbox" id="payDp"> Tandai sebagai DP</label>' : '') +
      '<label class="mc-field"><span class="mc-lbl">Catatan (opsional)</span>' +
        '<input class="mc-inp" id="payNote" placeholder="mis. lewat transfer"></label>' +
      '<p class="mc-hint sm">Garansi &amp; metode pembayaran diminta setelah lunas, satu langkah lagi.</p>' +
      (sisa > 0 ? '' : '<p class="mc-warn">Nota ini sudah lunas. Pembayaran lagi hanya untuk refund atau koreksi.</p>'),
      function (body) {
        // Tombol Lunasi: isi nominal dengan sisa tagihan, satu ketukan.
        var fullBtn = $('#payFull');
        if (fullBtn) fullBtn.addEventListener('click', function () {
          var amtInp = $('#payAmt');
          if (amtInp) amtInp.value = sisa;
        });

        var b = document.createElement('button');
        b.className = 'mc-primary';
        b.style.marginTop = '12px';
        b.textContent = 'Simpan Pembayaran';
        b.addEventListener('click', function () {
          var amt = parseInt(String($('#payAmt').value).replace(/\D/g, ''), 10) || 0;
          if (amt <= 0) { alertErr('Nominal harus lebih dari 0'); return; }
          var isDp = dp && $('#payDp') && $('#payDp').checked;
          var note = ($('#payNote').value || '').trim();
          tutupSheet();
          api('POST', '/api/mascim/services/' + encodeURIComponent(M.current.id) + '/payments', {
            amount: amt,
            payment_type: isDp ? 'DP' : 'Pelunasan',
            note: note,
            // allow_overpay hanya bila nota sudah lunas & nominal sengaja lebih
            allow_overpay: sisa === 0 ? true : undefined,
            idem_key: 'pay-' + M.current.id + '-' + amt + '-' + (isDp ? 'dp' : 'pel'),
          })
            .then(function () {
              // Pelunasan penuh tidak lagi menutup nota dengan sendirinya. Nota
              // sekarang menunggu konfirmasi garansi & metode pembayaran —
              // tombol utama berubah jadi "Konfirmasi Garansi & Metode".
              toast('Pembayaran tersimpan');
              loadDetail(M.current.id);
              reload();
            })
            .catch(function (e) { alertErr(e.message); });
        });
        body.appendChild(b);
      });
  }

  /*
     Step 3 — Konfirmasi garansi & metode pembayaran.

     Ini validasi terakhir sebelum nota ditutup jadi "Done Diambil". Sheet-nya
     sengaja dibuat sangat pendek: dua dropdown (garansi + metode bayar) dan
     satu tombol. Nilai lama diisi ulang otomatis dari pembayaran terakhir /
     konfirmasi sebelumnya, jadi pada kasus umum pengguna tinggal menekan satu
     tombol tanpa memilih ulang.
  */
  function openConfirmSheet() {
    var o = M.current;

    // Isi ulang dari pembayaran terakhir, lalu dari konfirmasi sebelumnya.
    // Dengan begitu registroan tidak perlu memilih ulang setiap kali.
    var lastPay = o.payments && o.payments.length ? o.payments[o.payments.length - 1] : null;
    var warNow = (lastPay && lastPay.warranty) || o.warranty || WARRANTY_OPTIONS[0];
    var metNow = (lastPay && lastPay.paymentMethod) || o.paymentMethod || PAYMENT_METHODS[0];

    var garansiOpts = WARRANTY_OPTIONS.map(function (g) {
      return '<option value="' + esc(g) + '"' + (g === warNow ? ' selected' : '') + '>' + esc(g) + '</option>';
    }).join('');
    var metodeOpts = PAYMENT_METHODS.map(function (m) {
      return '<option value="' + esc(m) + '"' + (m === metNow ? ' selected' : '') + '>' + esc(m) + '</option>';
    }).join('');

    sheetOrWarn('Konfirmasi Pelunasan',
      '<p class="mc-hint">Pembayaran <b class="pos">lunas</b>. Pilih garansi &amp; metode pembayaran untuk menutup nota.</p>' +
      '<div class="mc-row2">' +
        '<label class="mc-field"><span class="mc-lbl">Garansi *</span>' +
          '<select class="mc-inp" id="cfWarranty">' + garansiOpts + '</select></label>' +
        '<label class="mc-field"><span class="mc-lbl">Metode Bayar *</span>' +
          '<select class="mc-inp" id="cfMethod">' + metodeOpts + '</select></label>' +
      '</div>' +
      '<p class="mc-hint sm">Setelah dikonfirmasi, nota menjadi <b>Done Diambil</b> dan Dana Bank nota ini otomatis lunas.</p>',
      function (body) {
        var b = document.createElement('button');
        b.className = 'mc-primary';
        b.style.marginTop = '12px';
        b.textContent = 'Selesaikan & Tandai Diambil';
        b.addEventListener('click', function () {
          var war = $('#cfWarranty') ? $('#cfWarranty').value : '';
          var met = $('#cfMethod') ? $('#cfMethod').value : '';
          if (!war) { alertErr('Pilih garansi lebih dulu'); return; }
          if (!met) { alertErr('Pilih metode pembayaran lebih dulu'); return; }
          tutupSheet();
          api('POST', '/api/mascim/services/' + encodeURIComponent(M.current.id) + '/confirm-taken',
            { warranty: war, payment_method: met })
            .then(function (r) {
              var svc = r.service || {};
              M.current = svc;
              toast('Nota selesai — Done Diambil');
              loadDetail(M.current.id);
              reload();
              // Nota langsung dikirim ke WhatsApp pelanggan. Submit menjadi
              // satu-satunya jalan, jadi tidak ada lagi langkah "kirim nota"
              // yang bisa terlupa.
              if (svc.note) bagikanWhatsapp(svc.note);
              else alertErr('Nota ditutup, tapi nota garansi gagal terbit');
            })
            .catch(function (e) { alertErr(e.message); });
        });
        body.appendChild(b);
      });
  }

  /* =========================================================
     KEUANGAN — Cashflow modul Mas Cim

     Catatan: tab "Dana Bank" sudah DIHAPUS dari modul ini. Dana Bank
     adalah alat keuangan Project Nava, bukan alat servis HP, jadi
     sekarang berdiri di Beranda Nava — tepat di sebelah kartu
     "Tunai"/"Rekening Saya". Tombol Out/Bon dan Atur Saldo Awal
     juga pindah ke sana.
     ========================================================= */
  function renderMoney(s) {
    setBar('Keuangan');
    var d = M.cf;
    var html = '<div class="mc-pad">';
    if (!d) { html += skeleton(); s.innerHTML = html + '</div>'; return; }
    var sm = d.summary;
    html += '<div class="mc-hero sm">' +
      '<div class="mc-hero-lbl">Saldo</div>' +
      '<div class="mc-hero-val ' + (sm.balance >= 0 ? 'pos' : 'neg') + '">' + rupiah(sm.balance) + '</div>' +
    '</div>';
    html += '<div class="mc-money"><div><span>Uang Masuk</span><b class="pos">' + rupiah(sm.moneyIn) + '</b></div>' +
      '<div><span>Modal Sparepart</span><b class="neg">' + rupiah(sm.partModal) + '</b></div></div>';
    html += '<div class="mc-money"><div><span>Pengeluaran Lain</span><b class="neg">' + rupiah(sm.otherExpense) + '</b></div>' +
      '<div><span>Jasa Bersih</span><b class="pos">' + rupiah(sm.netServiceFee) + '</b></div></div>';

    html += '<div class="mc-filters">' +
      ['today:Hari Ini', 'month:Bulan Ini', 'year:Tahun Ini'].map(function (x) {
        var k = x.split(':');
        return '<button class="mc-chip' + (M.filter === k[0] ? ' on' : '') + '" data-cffilter="' + k[0] + '">' + k[1] + '</button>';
      }).join('') + '</div>';

    html += '<button class="mc-primary sm" id="cfAdd">+ Pengeluaran Lain</button>';

    // Pointer ke Dana Bank yang sekarang tinggal di Project Nava.
    html += '<p class="mc-hint sm">Dana Bank (Out/Bon, Atur Saldo Awal) ada di ' +
      'Beranda Project Nava, sebelah kartu Tunai.</p>';

    html += '<div class="mc-count">' + d.entries.length + ' transaksi</div>';
    html += d.entries.length ? d.entries.map(cfRow).join('') : '<p class="mc-empty">Belum ada transaksi.</p>';

    html += '</div>';
    s.innerHTML = html;
    bindMoney();
  }

  function cfRow(e) {
    return '<div class="mc-row">' +
      '<div class="mc-row-l"><b>' + esc(e.entryType) + '</b><span>' + tgl(e.entryDate) +
        (e.description ? ' · ' + esc(e.description) : '') + '</span></div>' +
      '<div class="mc-row-r">' +
        (e.moneyIn ? '<b class="pos">+' + ringkas(e.moneyIn) + '</b>' : '') +
        (e.moneyOut ? '<b class="neg">-' + ringkas(e.moneyOut) + '</b>' : '') +
        '<span class="mc-bal">' + ringkas(e.running) + '</span>' +
      '</div>' +
    '</div>';
  }

  function bindMoney() {
    var s = screen();
    s.querySelectorAll('[data-mtab]').forEach(function (b) {
      b.addEventListener('click', function () { M.tab = b.dataset.mtab; loadMoney(); });
    });
    s.querySelectorAll('[data-cffilter]').forEach(function (b) {
      b.addEventListener('click', function () { M.filter = b.dataset.cffilter; loadMoney(); });
    });

    var add = $('#cfAdd');
    if (add) add.addEventListener('click', function () {
      sheetOrWarn('Pengeluaran Lain',
        '<label class="mc-field"><span class="mc-lbl">Keterangan *</span>' +
        '<input class="mc-inp" id="exDesc" placeholder="Contoh: Bensin antar"></label>' +
        '<label class="mc-field"><span class="mc-lbl">Nominal (Rp) *</span>' +
        '<input class="mc-inp" id="exAmt" inputmode="numeric" placeholder="0"></label>' +
        '<label class="mc-field"><span class="mc-lbl">Tanggal</span>' +
        '<input class="mc-inp" id="exDate" type="date" value="' + hariIni() + '"></label>',
        function (body) {
          var b = document.createElement('button');
          b.className = 'mc-primary';
          b.style.marginTop = '12px';
          b.textContent = 'Simpan';
          b.addEventListener('click', function () {
            var desc = ($('#exDesc').value || '').trim();
            var amt = parseInt(String($('#exAmt').value).replace(/\D/g, ''), 10) || 0;
            if (!desc) { alertErr('Keterangan wajib diisi'); return; }
            if (amt <= 0) { alertErr('Nominal harus lebih dari 0'); return; }
            var date = $('#exDate').value || hariIni();
            tutupSheet();
            api('POST', '/api/mascim/cashflow', {
              entry_type: 'Pengeluaran Lain', description: desc,
              money_in: 0, money_out: amt, entry_date: date + 'T00:00:00.000Z',
            }).then(function () { toast('Tercatat'); loadMoney(); reload(); })
              .catch(function (e) { alertErr(e.message); });
          });
          body.appendChild(b);
        });
    });
  }

  /* =========================================================
     pemuatan data
     ========================================================= */
  function listFilter() {
    var f = {};
    if (M.filter === 'today') { f.from = hariIni(); f.to = hariIni(); }
    else if (M.filter === 'month') { f.from = bulanIni(); }
    else if (M.filter === 'range' && M.from) { f.from = M.from; f.to = M.to; }
    // Status yang dipilih lewat kartu status di Beranda.
    if (M.status) f.status = M.status;
    return f;
  }

  function cfFilter() {
    if (M.filter === 'today') return { from: hariIni(), to: hariIni() };
    if (M.filter === 'month') return { from: bulanIni() };
    if (M.filter === 'year') return { from: new Date().toISOString().slice(0, 4) + '-01-01' };
    return { from: '2000-01-01' };
  }

  function qs(o) {
    var p = [];
    Object.keys(o).forEach(function (k) { if (o[k]) p.push(encodeURIComponent(k) + '=' + encodeURIComponent(o[k])); });
    return p.length ? '?' + p.join('&') : '';
  }

  function reload() {
    // Tampilkan memuat lebih dulu supaya layar tidak pernah kosong
    // selagi server sedang answering.
    if (M.view === 'home' && !M.dash) showLoading();
    return api('GET', '/api/mascim/dashboard')
      .then(function (r) { M.dash = r.dashboard; render(); updateToolInfo(); })
      .catch(function (e) { if (M.view === 'home') renderOffline(e.message); });
  }

  /** Placeholder memuat. */
  function showLoading() {
    var s = screen();
    if (!s) return;
    s.innerHTML = '<div class="mc-pad"><div class="mc-hero"><div class="mc-hero-lbl">Memuat data…</div>' +
      '<div class="mc-hero-sub">Mohon tunggu sebentar</div></div>' +
      '<div class="mc-kpi">' + kpi('Servis masuk', '…', 'in') + kpi('Progress', '…', 'warn') +
      kpi('Done', '…', 'ok') + kpi('Cancel', '…', 'neg') + '</div>' +
      '<div class="mc-card"><div class="mc-skel"></div><div class="mc-skel"></div></div></div>';
  }

  /*
     Halaman ini hanya muncul kalau mesin data lokal sendiri gagal dibuka
     (mis. penyimpanan lokal diblokir). Kode lokal tidak pernah butuh
     jaringan, jadi pesan "server tidak terjangkau" tidak lagi relevan.
  */
  function renderOffline(msg) {
    screen().innerHTML = '<div class="mc-pad"><p class="mc-empty">' +
      esc(msg || 'Data lokal tidak bisa dibuka') + '<br><br>' +
      'Modul ini menyimpan data di perangkat. Coba muat ulang aplikasi, ' +
      'atau izinkan penyimpanan lokal pada browser ini.</p></div>';
  }

  function loadList() {
    return api('GET', '/api/mascim/services' + qs(Object.assign({ q: M.search }, listFilter())))
      .then(function (r) { M.list = r.services; render(); });
  }

  function loadDetail(id) {
    // Id nota disetel di sini, bukan di tiap pemanggil. Sebelumnya hanya
    // jalur "Simpan & buka detail" yang menyetelnya; membuka nota dari
    // daftar hanya memanggil loadDetail, sehingga M.id tetap kosong dan
    // setiap PATCH dari layar detail tertuju ke /services/undefined yang
    // dijawab "Nota tidak ditemukan".
    M.id = id;
    return api('GET', '/api/mascim/services/' + encodeURIComponent(id))
      .then(function (r) { M.id = r.service.id; M.current = r.service; render(); })
      .catch(function (e) { alertErr(e.message); M.view = 'home'; reload(); });
  }

  function loadMoney() {
    // Tab "Dana Bank" sudah pindah ke Project Nava, jadi Keuangan modul ini
    // hanya satu tampilan: Cashflow.
    return api('GET', '/api/mascim/cashflow' + qs(cfFilter()))
      .then(function (r) { M.cf = r; render(); })
      .catch(function (e) { alertErr(e.message); });
  }

  function updateToolInfo() {
    var el = document.getElementById('hMascimInfo');
    if (!el) return;
    if (!M.dash) { el.textContent = 'Input servis & kas'; return; }
    // Yang paling mendesak itu Nggandul
    // (status belum dikonfirmasi), lalu nota yang masih Progress.
    var ngg = M.dash.nggandul || 0;
    var prs = M.dash.proses || 0;
    if (ngg) el.textContent = ngg + ' nota Nggandul — perlu konfirmasi';
    else if (prs) el.textContent = prs + ' servis masih Progress';
    else el.textContent = 'Input servis & kas';
  }

  /* =========================================================
     buka / tutup modul
     ========================================================= */
  function open(initial) {
    var m = document.getElementById('mc');
    if (!m) return;
    m.classList.remove('hidden');
    m.setAttribute('aria-hidden', 'false');
    document.body.classList.add('mc-open');
    if (initial) M.view = initial;
    if (M.view === 'money') loadMoney();
    else if (M.view === 'list') loadList();
    else reload();
  }

  function close() {
    var m = document.getElementById('mc');
    if (!m) return;
    m.classList.add('hidden');
    m.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('mc-open');
    M.draft = null; M.editing = null;
  }

  function isOpen() {
    var m = document.getElementById('mc');
    return m && !m.classList.contains('hidden');
  }

  /* ---------------- event delegation global ---------------- */
  function bindGlobal() {
    var m = document.getElementById('mc');
    if (!m) return;

    m.addEventListener('click', function (e) {
      var t;

      // navigasi view
      if ((t = e.target.closest('[data-mv]'))) {
        var v = t.dataset.mv;
        M.view = v;
        // Kartu status juga menentukan tab atau filter tujuan.
        if (t.dataset.mtab) M.tab = t.dataset.mtab;
        if (t.dataset.status) M.status = t.dataset.status;
        if (v === 'form') { M.draft = blankDraft(); M.editing = null; render(); }
        else if (v === 'list') loadList();
        else if (v === 'money') loadMoney();
        else reload();
        return;
      }
      // buka detail
      if ((t = e.target.closest('[data-open]'))) {
        M.view = 'detail';
        loadDetail(t.dataset.open);
        return;
      }
      // filter daftar
      if ((t = e.target.closest('[data-filter]'))) {
        M.filter = t.dataset.filter;
        if (M.filter === 'range' && !M.from) M.from = bulanIni();
        if (M.filter === 'range' && !M.to) M.to = hariIni();
        loadList();
        return;
      }
      // tombol kembali
      if (e.target.closest('#mcBack')) { back(); return; }
      if (e.target.closest('#mcRefresh')) { reload(); loadListSafe(); toast('Muat ulang'); return; }
    });

    // pencarian: tunggu pengguna berhenti mengetik
    m.addEventListener('input', function (e) {
      if (e.target.id === 'mcSearch') {
        M.search = e.target.value;
        clearTimeout(m._st);
        m._st = setTimeout(function () {
          loadList().then(function () {
            var i = document.getElementById('mcSearch');
            if (i) { i.focus(); try { i.setSelectionRange(i.value.length, i.value.length); } catch (x) {} }
          });
        }, 350);
      }
      if (e.target.id === 'mcFrom') M.from = e.target.value;
      if (e.target.id === 'mcTo') M.to = e.target.value;
    });

    m.addEventListener('change', function (e) {
      if (e.target.id === 'mcFrom' || e.target.id === 'mcTo') loadList();
    });

    // tombol kembali Android
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen()) back();
    });
  }

  function loadListSafe() {
    if (M.view === 'list') loadList().catch(function () {});
  }

  function back() {
    if (M.view === 'home') { close(); return; }
    if (M.view === 'form') { exitForm(); return; }
    if (M.view === 'detail') { M.view = 'list'; loadList(); return; }
    if (M.view === 'list' || M.view === 'money') { M.view = 'home'; reload(); return; }
    close();
  }

  /* =========================================================
     API — SEPENUHNYA LOKAL.

     Modul Mas Cim memakai mesin data lokal (mascim-local.js) sebagai
     satu-satunya sumber kebenaran. Tidak ada permintaan jaringan sama
     sekali: semua tombol tetap berfungsi saat offline atau saat
     server bot mati.

     Panggilan ke server sengaja dihapus (sebelumnya ada dorongan
     latar "fire-and-forget"). Selain boros, itu membuat modul terasa
     bergantung pada jaringan padahal datanya sudah ada di perangkat.
     ========================================================= */
  function api(method, path, body) {
    if (!w.MascimLocal || !w.MascimLocal.handle) {
      return Promise.reject(new Error('Mesin data lokal Mas Cim belum termuat'));
    }
    return w.MascimLocal.handle(method, path, body);
  }

  /* ---------------- init ----------------
     Pola init sama seperti modul lain: app.js yang memanggil
     w.MascimUI.init(). Kalau document sudah siap (mis. modul
     dimuat belakangan), init langsung dijalankan. */
  function init() {
    if (w.MascimUI && w.MascimUI._inited) return;
    w.MascimUI = w.MascimUI || {};
    w.MascimUI._inited = true;

    bindGlobal();

    // tombol di tab Lainnya
    // Pakai data-mascim-open (bukan data-goto) supaya tidak ikut
    // ditangani router App.go() yang hanya untuk view utama.
    var tool = document.querySelector('[data-mascim-open]');
    if (tool) {
      tool.addEventListener('click', function (e) { e.preventDefault(); open('home'); });
    }

    w.MascimUI = Object.assign(w.MascimUI, {
      init: init,
      open: open,
      close: close,
      back: back,
      reload: reload,
      isOpen: isOpen,
      render: render,
      _state: M,
      _util: { rupiah: rupiah, tgl: tgl, tglJam: tglJam }
    });
  }

  // Dibuat lebih awal supaya w.MascimUI selalu ada, tapi init()
  // (pemasangan listener) diserahkan ke app.js agar tidak ada listener
  // ganda bila modul ini dimuat saat DOM sudah siap.
  w.MascimUI = w.MascimUI || {};
  w.MascimUI.init = init;
  w.MascimUI.open = open;
  w.MascimUI.close = close;
  // render diekspor supaya test bisa memaksa gambar ulang layar setelah
  // mengubah state langsung (mis. setelah ubah status lewat mesin data).
  w.MascimUI.render = render;
  // Dibantu test untuk memastikan navigasi benar-benar berpindah halaman/tab.
  w.MascimUI.viewName = function () { return M.view; };
  w.MascimUI.tabName = function () { return M.tab; };
  // flowOf diekspor supaya test bisa memverifikasi alur pembayaran/pelunasan
  // tanpa menebak-nebak langkah mana yang harus tampil untuk status apa.
  w.MascimUI.flowOf = function (order) { return order ? flowOf(order) : null; };
  w.MascimUI.applyStatus = applyStatus;
  // Helper nota garansi diekspor untuk pengujian: test harus bisa memastikan
  // pesan WhatsApp dan isi cetakan benar-benar bebas data internal, bukan
  // hanya terlihat benar di layar.
  // Area pola dan perekamnya diekspor supaya bisa diuji langsung dari
  // halaman Data tanpa harus membuat nota dulu. Keduanya adalah kode yang
  // sama persis dengan yang dipakai di form Tambah Service — kalau area
  // pola gagal di sini, berarti gagal juga di form.
  w.MascimUI._testPad = {
    patternPad: patternPad,
    bindPatternPad: bindPatternPad
  };
  w.MascimUI._testNote = {
    pesanWhatsapp: pesanWhatsapp,
    noteHtml: noteHtml,
    noteLink: noteLink,
    refNota: refNota,
    waSamar: waSamar
  };
})(window);
