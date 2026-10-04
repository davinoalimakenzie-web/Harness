/* =========================================================
   app.js — Inisialisasi, router, pengaturan, backup
   Project Nava v3 — Cashflow Mini App (gaya Money Lover)
   ========================================================= */
(function (w) {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return [].slice.call(document.querySelectorAll(s)); };
  var S = w.Store, TG = w.TG;

  var TITLES = {
    home:    ['Project Nava', 'Cashflow keluarga'],
    history: ['Riwayat', 'Semua transaksi tersimpan'],
    recap:   ['Rekap', 'Ringkasan & komposisi kategori'],
    more:    ['Lainnya', 'Alat, kategori, akun & data'],
    notes:   ['Catatan', 'Pengingat voice'],
    calc:    ['Kalkulator Servis HP', 'Harga estimasi LCD & baterai dari harga part'],
    mascim:  ['Mas Cim Service HP', 'Servis, kas & Dana Bank']
  };

  var App = {
    view: 'home',

    // Dipakai juga oleh auto-export Mas Cim dan tombol Bagikan.
    exportJSON: exportJSON,
    bagikanKeTelegram: bagikanKeTelegram,

    toast: function (msg, ms) {
      var t = $('#toast');
      t.textContent = msg;
      t.classList.remove('hidden');
      clearTimeout(App._tt);
      App._tt = setTimeout(function () { t.classList.add('hidden'); }, ms || 2200);
    },

    // Bunyi peringatan sederhana (Web Audio, tanpa file)
    alertSound: function () {
      try {
        var AC = w.AudioContext || w.webkitAudioContext;
        if (!AC) return;
        var ctx = App._ac || (App._ac = new AC());
        if (ctx.state === 'suspended') ctx.resume();
        [0, 0.22, 0.44].forEach(function (t, i) {
          var o = ctx.createOscillator(), g = ctx.createGain();
          o.type = 'sine';
          o.frequency.value = i === 2 ? 880 : 660;
          g.gain.setValueTime(0, ctx.currentTime + t);
          g.gain.linearRampToValueAtTime(0.18, ctx.currentTime + t + 0.02);
          g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.2);
          o.connect(g); g.connect(ctx.destination);
          o.start(ctx.currentTime + t);
          o.stop(ctx.currentTime + t + 0.22);
        });
      } catch (e) {}
    },

    go: function (v) {
      App.view = v;
      $$('.tab').forEach(function (b) { b.classList.toggle('active', b.dataset.view === v); });
      $$('.view').forEach(function (s) { s.classList.toggle('active', s.id === 'view-' + v); });
      var t = TITLES[v] || ['', ''];
      $('#pageTitle').textContent = t[0];
      $('#pageSub').textContent = t[1];
      w.scrollTo(0, 0);
      TG.haptic('select');
    },

    home: function () { App.go('home'); }
  };
  w.App = App;

  /* ---------------- Sheet ---------------- */

  // Sheet modal used across modules. The third argument is an optional
  // onOpen(body) callback so a module can wire its own buttons and inputs
  // after the markup is in the DOM. Mas Cim relies on this for status,
  // sparepart, and payment sheets.
  // PENTING: onOpen harus menerima elemen yang BARU setiap kali sheet dibuka.
  // openSheet() hanya mengisi ulang #sheetBody lewat innerHTML, sehingga
  // listener yang menempel di #sheetBody itu sendiri tidak ikut hilang.
  // Akibatnya setiap pembukaan sheet menambah satu listener baru, dan satu klik
  // memicu semuanya sekaligus: handler paling lama menutup sheet lalu
  // menggeser order yang SUDAH tidak lagi ditampilkan. Itu sebabnya tombol
  // "Ubah Status" tampak tidak berfungsi.
  // Solusinya: buat wrapper baru setiap sheet dibuka, listener menempel ke
  // wrapper itu, dan ikut hilang bersama isinya saat sheet ditutup.
  App.sheet = function (title, html, onOpen) {
    openSheet(title, html);
    if (typeof onOpen === 'function') {
      try { onOpen(freshSheetBody()); }
      catch (e) { console.error('sheet onOpen gagal:', e); App.toast('Terjadi kesalahan di form'); }
    }
  };
  App.closeSheet = function () { closeSheet(); };
  App.isSheetOpen = function () { return !$('#sheet').classList.contains('hidden'); };

  function openSheet(title, html) {
    $('#sheetTitle').textContent = title;
    $('#sheetBody').innerHTML = html;
    $('#sheet').classList.remove('hidden');
  }
  // Membungkus isi sheet di dalam elemen baru supaya listener yang dipasang
  // pemanggil (onOpen) tidak menumpuk dari pembukaan ke pembukaan berikutnya.
  function freshSheetBody() {
    var host = $('#sheetBody');
    var wrap = w.document.createElement('div');
    wrap.className = 'sheet-scope';
    while (host.firstChild) wrap.appendChild(host.firstChild);
    host.appendChild(wrap);
    return wrap;
  }
  function closeSheet() { $('#sheet').classList.add('hidden'); }

  /* Sheet input sederhana untuk ubah nama kategori. */
  function promptSheet(title, label, value, onOk) {
    openSheet(title,
      '<div class="fld"><label for="promptIn">' + esc(label) + '</label>' +
      '<input type="text" id="promptIn" maxlength="40" value="' + esc(value || '') + '"></div>' +
      '<div class="row-2" style="margin-top:12px">' +
      '<button class="btn ghost" data-close>Batal</button>' +
      '<button class="btn" id="promptOk">Simpan</button></div>');
    var input = $('#promptIn');
    setTimeout(function () { input.focus(); input.select(); }, 120);
    function done() {
      var v = input.value.trim();
      closeSheet();
      if (v) onOk(v);
    }
    $('#promptOk').addEventListener('click', done);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') done();
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------------- Menu ringkasan ---------------- */
  function buildMenu() {
    var s = S.state;
    var today = S.todayStr();
    var dsum = S.Tx.summary({ from: today, to: today });
    openSheet('Menu', [
      '<div class="item"><div class="item-body">' +
      '<div class="item-title">' + esc(TG.userName()) + '</div>' +
      '<div class="item-sub"><span class="tag">' + (TG.isTelegram ? 'Telegram' : 'Browser') + '</span>' +
      (TG.isTelegram && TG.user && TG.user.username ? '<span>@' + esc(TG.user.username) + '</span>' : '') +
      '</div></div></div>',
      '<div class="list-head"><strong>Hari ini</strong></div>',
      '<div class="item"><div class="tx-icon in">↓</div><div class="item-body"><div class="item-title">Pemasukan</div></div>' +
      '<div class="item-amt amt-in">+' + w.TxUI.money(dsum.in) + '</div></div>',
      '<div class="item"><div class="tx-icon out">↑</div><div class="item-body"><div class="item-title">Pengeluaran</div></div>' +
      '<div class="item-amt amt-out">−' + w.TxUI.money(dsum.out) + '</div></div>',
      '<div class="item"><div class="tx-icon in">=</div><div class="item-body"><div class="item-title">Saldo hari ini</div></div>' +
      '<div class="item-amt">' + w.TxUI.money(dsum.net) + '</div></div>',
      '<div class="list-head"><strong>Data</strong></div>',
      '<div class="item"><div class="item-body"><div class="item-title">Transaksi</div>' +
      '<div class="item-sub"><span>' + S.Tx.active().length + ' transaksi</span></div></div></div>',
      '<div class="item"><div class="item-body"><div class="item-title">Catatan</div>' +
      '<div class="item-sub"><span>' + s.notes.length + ' catatan</span></div></div></div>',
      '<div class="item"><div class="item-body"><div class="item-title">Template kalkulator</div>' +
      '<div class="item-sub"><span>' + s.templates.length + ' template</span></div></div></div>'
    ].join(''));
  }

  /* ---------------- Kelola akun (tab Lainnya) ---------------- */
  function renderAccountEditor() {
    var wrap = $('#accEditor');
    if (!wrap) return;
    var accs = S.Accounts.all();
    wrap.innerHTML = accs.map(function (a) {
      var bal = S.Accounts.balance(a.id);
      var typeLbl = { cash: 'Tunai', bank: 'Rekening', card: 'Kartu', ewallet: 'E-Wallet' }[a.type] || 'Akun';
      return '<div class="item"><div class="tx-icon in">' + esc(a.icon) + '</div>' +
        '<div class="item-body"><div class="item-title">' + esc(a.name) + '</div>' +
        '<div class="item-sub"><span class="tag">' + typeLbl + '</span>' +
        '<span>Saldo ' + w.TxUI.money(bal) + '</span></div></div>' +
        '<button class="mini-btn danger" data-delacc="' + esc(a.id) + '">Hapus</button></div>';
    }).join('') +
      '<button class="tool" id="addAccBtn"><span class="tool-ico in">＋</span>' +
      '<span class="tool-body"><b>Tambah akun</b><span>Tunai, rekening, atau kartu</span></span></button>';
  }

  function openAccountSheet() {
    openSheet('Tambah Akun', [
      '<div class="field-row">',
      '<select id="accIcon" class="field"><option value="💵">💵</option><option value="🏦">🏦</option>' +
      '<option value="💳">💳</option><option value="📱">📱</option><option value="💰">💰</option><option value="🏷️">🏷️</option></select>',
      '<input type="text" id="accName" class="grow" placeholder="Nama akun (mis. Kas++, BCA)">',
      '</div>',
      '<label class="field mt"><span class="lbl">Jenis akun</span>',
      '<select id="accType"><option value="cash">Tunai</option><option value="bank">Rekening</option>' +
      '<option value="card">Kartu debit/kredit</option><option value="ewallet">E-Wallet</option></select></label>',
      '<label class="field"><span class="lbl">Saldo awal (Rp)</span>',
      '<input type="number" id="accOpening" inputmode="numeric" min="0" step="1000" value="0"></label>',
      '<button id="accSave" class="btn primary block">Simpan akun</button>'
    ].join(''));
    $('#accSave').addEventListener('click', function () {
      var res = S.Accounts.add($('#accName').value, $('#accType').value, $('#accIcon').value);
      if (!res.ok) { App.toast(res.msg); return; }
      var acc = res.account;
      var opening = Math.round(Number($('#accOpening').value) || 0);
      if (opening) S.Accounts.update(acc.id, { opening: opening });
      closeSheet();
      renderAccountEditor();
      w.TxUI.render();
      TG.haptic('success');
      App.toast('Akun "' + acc.name + '" ditambahkan');
    });
  }

  /* ---------------- Kelola kategori (tab Lainnya) ---------------- */
  function renderCatEditor() {
    var wrap = $('#catManager');
    if (!wrap) return;
    var all = S.Groups.all();
    var byType = { in: [], out: [] };
    all.forEach(function (g) { if (byType[g.type]) byType[g.type].push(g); });
    byType.in.sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); });
    byType.out.sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); });

    function block(type) {
      var groups = byType[type];
      if (!groups.length) return '';
      return groups.map(function (g) {
        var detail = S.Groups.subsDetail(g);
        var used = S.Groups.groupUsage(g.id);
        return '<div class="cat-edit-group' + (g.active === false ? ' off' : '') + '">' +
          '<div class="ce-head">' +
          '<span class="ce-type ' + type + '">' + (type === 'in' ? 'Masuk' : 'Keluar') + '</span>' +
          '<b>' + esc(g.icon || '•') + ' ' + esc(g.group) + '</b>' +
          '<span class="ce-acts">' +
            '<button class="mini-btn" data-ce-edit="' + esc(g.id) + '" title="Ubah nama">✎ Ubah</button>' +
            '<button class="mini-btn" data-toggle="' + esc(g.id) + '">' +
              (g.active === false ? 'Aktifkan' : 'Nonaktifkan') + '</button>' +
            '<button class="mini-btn danger" data-ce-del="' + esc(g.id) + '" title="Hapus kategori">🗑</button>' +
          '</span>' +
          '</div>' +
          (used ? '<div class="ce-usage">dipakai ' + used + ' transaksi</div>' : '') +
          (g.isDirect
            ? '<div class="ce-subs"><span class="ce-sub">Input langsung (wajib keterangan)</span></div>'
            : '<div class="ce-subs">' + (detail.length
                ? detail.map(function (s) {
                    var su = S.Groups.subUsage(g.id, s.n);
                    return '<span class="ce-sub">' + esc(s.i || '•') + ' ' + esc(s.n) +
                      '<button class="ce-sub-x" data-ce-subedit="' + esc(g.id) + '" data-ce-sub="' + esc(s.n) + '" title="Ubah">✎</button>' +
                      (su ? '' : '<button class="ce-sub-x" data-ce-subdel="' + esc(g.id) + '" data-ce-sub="' + esc(s.n) + '" title="Hapus">🗑</button>') +
                      '</span>';
                  }).join('')
                : '<span class="ce-sub muted">Belum ada subkategori</span>') + '</div>') +
          '</div>';
      }).join('');
    }
    wrap.innerHTML = block('in') + block('out');
  }

  function renderNewParent() {
    var type = $('#ncType').value;
    var sel = $('#ncParent');
    var groups = S.Groups.for(type);
    sel.innerHTML = groups.length
      ? groups.map(function (g) { return '<option value="' + esc(g.id) + '">' + esc(g.group) + '</option>'; }).join('')
      : '<option value="">— tidak ada kategori —</option>';
  }

  function refreshMore() {
    renderAccountEditor();
    renderCatEditor();
    renderNewParent();
  }

  /* ---------------- Backup ---------------- */
  /* Export semua: Project Nava + Mas Cim.
     Versi lama hanya menulis Project Nava, jadi seluruh data Mas Cim
     hilang dari file backup padahal justru data yang paling cepat bertambah.
     Tambahan "mascim" kunci baru, importJSON mengabaikannya sehingga
     file lama tetap bisa diimpor.
     senyap = dipanggil otomatis, tidak perlu toast manual. */
  /* Susun file backup. Dipakai oleh dua jalur: unduh ke HP, dan bagikan
     ke chat Telegram lewat share sheet. */
  function backupFile() {
    var obj = JSON.parse(S.Data.exportJSON());
    var adaMascim = false;
    try {
      if (w.MascimLocal && typeof w.MascimLocal._db === 'function') {
        obj.mascim = w.MascimLocal._db();
        adaMascim = true;
      }
    } catch (e) {}
    var t = new Date();
    var fname = 'backup-nava-' + S.todayStr() + '-' +
      [t.getHours(), t.getMinutes(), t.getSeconds()]
        .map(function (n) { return String(n).padStart(2, '0'); }).join('') + '.json';
    return {
      nama: fname,
      adaMascim: adaMascim,
      blob: new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })
    };
  }

  /* Unduh file ke penyimpanan HP. */
  function exportJSON(senyap) {
    var f = backupFile();
    var url = URL.createObjectURL(f.blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = f.nama;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    TG.haptic('success');
    App.toast(senyap
      ? 'Backup otomatis ke HP (nota ke-' + (S.Data.state.notes || []).length + ')'
      : 'Backup JSON diunduh' + (f.adaMascim ? ' + Mas Cim' : ''));
  }

  /* Bagikan file backup ke chat Telegram.

     Aplikasi ini berjalan sepenuhnya di dalam WebView dan tidak punya
     backend, jadi tidak ada jalur untuk mengirim file ke chat
     secara otomatis. Yang bisa dilakukan adalah share sheet Android: di sana
     Telegram muncul sebagai tujuan, dan file yang dikirim langsung masuk
     ke chat tersimpan di cloud — bukan sekadar file di perangkat yang
     hilang bersama uninstall.

     navigator.canShare + navigator.share hanya tersedia di konteks aman
     dan tidak ada di semua WebView; kalau tidak tersedia, jatuh ke
     unduh biasa. */
  function bagikanKeTelegram() {
    var f = backupFile();
    var file = null;
    try { file = new File([f.blob], f.nama, { type: 'application/json' }); }
    catch (e) { file = null; }

    var bisa = false;
    try {
      bisa = !!(navigator.canShare && navigator.share && file &&
        navigator.canShare({ files: [file] }));
    } catch (e) { bisa = false; }

    if (!bisa) {
      exportJSON(false);
      App.toast('Bagikan file belum tersedia di sini — backup diunduh ke HP');
      return;
    }
    navigator.share({
      files: [file],
      title: 'Backup ' + S.todayStr(),
      text: 'Backup data servis ' + S.todayStr()
    }).then(function () {
      TG.haptic('success');
      App.toast('Kirim ke Telegram — pilih Telegram lalu kirim');
    }).catch(function (e) {
      // pengguna menutup share sheet: bukan error
      if (e && e.name === 'AbortError') return;
      App.toast('Gagal membagikan: ' + ((e && e.message) || e));
    });
  }


  function importJSON(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        S.Data.importJSON(reader.result);
        refreshMore();
        w.NotesUI.render(); w.TxUI.render(); w.CalcUI.render();
        TG.haptic('success');
        App.toast('Data berhasil diimpor');
      } catch (e) {
        TG.alert('Gagal import: ' + e.message);
      }
    };
    reader.readAsText(file);
  }

  function seedDemo() {
    var today = S.todayStr();
    var yesterday = S.todayStr(new Date(Date.now() - 86400000));
    var cash = S.Accounts.all().filter(function (a) { return a.type === 'cash'; })[0];
    var bank = S.Accounts.all().filter(function (a) { return a.type === 'bank'; })[0];
    var cashId = cash ? cash.id : null, bankId = bank ? bank.id : null;

    S.Tx.create({ type: 'in',  group: 'Income Ali',      sub: 'Gaji Intika',   amount: 5000000, date: today, note: '', account_id: bankId }, S.uid());
    S.Tx.create({ type: 'out', group: 'Out Harian',      sub: 'Belanja Dapur', amount: 100000, date: today, note: '', account_id: cashId }, S.uid());
    S.Tx.create({ type: 'in',  group: 'Income Ali',      sub: 'Service HP',    amount: 350000, date: today, note: '', account_id: cashId }, S.uid());
    S.Tx.create({ type: 'out', group: 'Support Bulanan', sub: 'Bensin',        amount: 50000,  date: yesterday, note: '', account_id: cashId }, S.uid());
    S.Tx.create({ type: 'in',  group: 'Rejeki Tak Terduga', sub: null,          amount: 25000,  date: yesterday, note: 'Balik modal koin', account_id: cashId }, S.uid());
    S.Tx.create({ type: 'out', group: 'Kebutuhan Anak',  sub: 'Daffa',        amount: 75000,  date: yesterday, note: '', account_id: cashId }, S.uid());

    S.Notes.add({ text: 'Bayar pajak kendaraan' });
    S.Notes.add({ text: 'Cek kapan servis motor berikutnya' });
    S.Notes.add({
      text: 'Isi token listrik',
      remindAt: (function () {
        var d = new Date(Date.now() + 2 * 3600000);
        return S.todayStr(d) + 'T' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      })(),
      repeat: 'none', leadMin: 15
    });

    refreshMore();
    w.NotesUI.render(); w.TxUI.render();
    TG.haptic('success');
    App.toast('Data contoh dibuat');
  }

  function clearAll() {
    TG.confirm('Hapus SEMUA transaksi, catatan, template, dan kembali ke akun default? Tindakan ini tidak bisa dibatalkan.', function (ok) {
      if (!ok) return;
      S.Data.clearAll();
      refreshMore();
      w.NotesUI.render(); w.TxUI.render(); w.CalcUI.render();
      TG.haptic('success');
      App.toast('Semua data dihapus');
    });
  }

  /* ---------------- Init ---------------- */
  var _inited = false;
  function init() {
    if (_inited) return;   // jaga agar listener tidak terpasang dua kali
    _inited = true;

    // Jaring pengaman: di dalam WebView Telegram, error yang tidak
    // tertangani bisa membuat halaman ditutup paksa. Semua error
    // dicatat, bukan dilempar ke atas.
    w.addEventListener('error', function (ev) {
      try { console.error('nava: error', ev && ev.message, ev && ev.filename, ev && ev.lineno); } catch (e) {}
    });
    w.addEventListener('unhandledrejection', function (ev) {
      try {
        console.error('nava: promise ditolak', ev && ev.reason && (ev.reason.message || ev.reason));
        if (ev && ev.preventDefault) ev.preventDefault();
      } catch (e) {}
    });
    TG.init();

    // Tab utama + navigasi alat
    $$('.tab').forEach(function (b) {
      if (b.dataset.view) b.addEventListener('click', function () { App.go(b.dataset.view); });
    });
    document.addEventListener('click', function (e) {
      var g = e.target.closest('[data-goto]');
      if (g) App.go(g.dataset.goto);
    });
    $('#btnMore').addEventListener('click', function () { App.go('more'); });

    $('#sheet').addEventListener('click', function (e) {
      if (e.target.closest('[data-close]')) closeSheet();
    });

    // Back button Telegram
    TG.back.show(function () {
      // Urutan: layer paling atas dulu
      // Modul Mas Cim adalah overlay penuh, harus ditutup lebih dulu.
      if (w.MascimUI && w.MascimUI.isOpen && w.MascimUI.isOpen()) { w.MascimUI.back(); return; }
      // Nava Trader juga overlay penuh, ada setelah Mas Cim.
      if (w.NavaTraderUI && w.NavaTraderUI.isOpen && w.NavaTraderUI.isOpen()) {
        if (w.NavaTraderUI.viewName() !== 'home') w.NavaTraderUI.go('home');
        else w.NavaTraderUI.close();
        return;
      }
      var txPage = $('#txPage');
      if (txPage && !txPage.classList.contains('hidden')) { w.TxUI.closeTxPage(); return; }
      var txDetail = $('#txDetail');
      if (txDetail && !txDetail.classList.contains('hidden')) { w.TxUI.closeDetail(); return; }
      if (!$('#sheet').classList.contains('hidden')) { closeSheet(); return; }
      if (App.view !== 'home') App.go('home');
      else TG.wa.close();
    });

    // Sub-modul
    w.NotesUI.init();
    w.TxUI.init();
    w.CalcUI.init();
    if (w.MascimUI && w.MascimUI.init) w.MascimUI.init();
    if (w.NavaTraderUI && w.NavaTraderUI.init) w.NavaTraderUI.init();
    if (w.NavaTraderQuote && w.NavaTraderQuote.init) w.NavaTraderQuote.init();
    if (w.NavaTraderAlert && w.NavaTraderAlert.init) w.NavaTraderAlert.init();
    refreshMore();

    // Kategori
    $('#catReset').addEventListener('click', function () {
      S.Settings.resetCategories();
      refreshMore();
      w.TxUI.render();
      TG.haptic('success');
      App.toast('Kategori direset ke default');
    });
    $('#catManager').addEventListener('click', function (e) {
      // Ubah nama kelompok
      var ed = e.target.closest('[data-ce-edit]');
      if (ed) {
        var ge = S.Groups.all().filter(function (x) { return x.id === ed.dataset.ceEdit; })[0];
        if (!ge) return;
        promptSheet('Ubah Nama Kategori', 'Nama kategori', ge.group, function (v) {
          var r = S.Groups.renameGroup(ge.id, v);
          if (!r.ok) { App.toast(r.msg); return; }
          refreshMore(); w.TxUI.render();
          TG.haptic('success');
          App.toast('Nama kategori diubah');
        });
        return;
      }

      // Hapus kelompok
      var del = e.target.closest('[data-ce-del]');
      if (del) {
        var gd = S.Groups.all().filter(function (x) { return x.id === del.dataset.ceDel; })[0];
        if (!gd) return;
        var n = S.Groups.groupUsage(gd.id);
        var msg = n > 0
          ? '"' + gd.group + '" dipakai ' + n + ' transaksi.\n\nKategori akan DINONAKTIFKAN supaya riwayat lama tetap utuh. Lanjutkan?'
          : 'Hapus kategori "' + gd.group + '"?';
        TG.confirm(msg, function (ok) {
          if (!ok) return;
          var r = S.Groups.removeGroup(gd.id);
          if (!r.ok) { App.toast(r.msg); return; }
          refreshMore(); w.TxUI.render();
          TG.haptic('success');
          App.toast(r.mode === 'deactivated'
            ? 'Kategori dinonaktifkan (dipakai ' + r.used + ' transaksi)'
            : 'Kategori dihapus');
        });
        return;
      }

      // Ubah nama subkategori
      var sed = e.target.closest('[data-ce-subedit]');
      if (sed) {
        var gs = S.Groups.all().filter(function (x) { return x.id === sed.dataset.ceSubedit; })[0];
        if (!gs) return;
        promptSheet('Ubah Subkategori', 'Nama subkategori', sed.dataset.ceSub, function (v) {
          var r = S.Groups.renameSub(gs.id, sed.dataset.ceSub, v);
          if (!r.ok) { App.toast(r.msg); return; }
          refreshMore(); w.TxUI.render();
          TG.haptic('success');
          App.toast('Subkategori diubah');
        });
        return;
      }

      // Hapus subkategori
      var sdel = e.target.closest('[data-ce-subdel]');
      if (sdel) {
        var gs2 = S.Groups.all().filter(function (x) { return x.id === sdel.dataset.ceSubdel; })[0];
        if (!gs2) return;
        var sub = sdel.dataset.ceSub;
        var r0 = S.Groups.removeSub(gs2.id, sub);
        if (!r0.ok) { App.toast(r0.msg); return; }
        refreshMore(); w.TxUI.render();
        TG.haptic('success');
        App.toast(r0.mode === 'deleted' ? 'Subkategori dihapus' : r0.msg);
        return;
      }

      // Aktif / nonaktif
      var t = e.target.closest('[data-toggle]');
      if (!t) return;
      var g = S.Groups.all().filter(function (x) { return x.id === t.dataset.toggle; })[0];
      if (g) {
        S.Groups.setActive(g.id, g.active === false);
        renderCatEditor();
        w.TxUI.render();
        TG.haptic('select');
      }
    });
    $('#ncType').addEventListener('change', renderNewParent);
    $('#ncAdd').addEventListener('click', function () {
      var type = $('#ncType').value;
      var groupName = $('#ncGroup').value.trim();
      var subName = $('#ncSub').value.trim();
      var parentId = $('#ncParent').value;
      var ok = false;
      if (groupName) {
        if (S.Groups.addGroup(type, groupName)) {
          ok = true;
          $('#ncGroup').value = '';
          $('#ncSub').value = '';
        }
      } else if (parentId && subName) {
        if (S.Groups.addSub(parentId, subName)) {
          ok = true;
          $('#ncSub').value = '';
        }
      }
      if (ok) {
        refreshMore();
        w.TxUI.render();
        TG.haptic('success');
        App.toast('Kategori ditambahkan');
      } else {
        App.toast('Isi kategori atau pilih induk + subkategori');
      }
    });

    // Akun
    $('#accEditor').addEventListener('click', function (e) {
      if (e.target.closest('#addAccBtn')) { openAccountSheet(); return; }
      var d = e.target.closest('[data-delacc]');
      if (d) {
        var acc = S.Accounts.get(d.dataset.delacc);
        TG.confirm('Hapus akun "' + (acc ? acc.name : '') + '"?', function (ok) {
          if (!ok) return;
          var res = S.Accounts.remove(d.dataset.delacc);
          if (!res.ok) { App.toast(res.msg); return; }
          renderAccountEditor();
          w.TxUI.render();
          TG.haptic('success');
          App.toast('Akun dihapus');
        });
      }
    });
    App.openAccountSheet = openAccountSheet;

    // Data
    $('#dExport').addEventListener('click', exportJSON);
    var shareBtn = $('#dShareTelegram');
    if (shareBtn) shareBtn.addEventListener('click', bagikanKeTelegram);
    $('#dImport').addEventListener('click', function () { $('#dFile').click(); });
    $('#dFile').addEventListener('change', function (e) {
      if (e.target.files[0]) importJSON(e.target.files[0]);
      e.target.value = '';
    });
    $('#dDemo').addEventListener('click', seedDemo);
    $('#dClear').addEventListener('click', clearAll);

    // ---------------- Cadangan otomatis ----------------
    function renderAutoBackup() {
      if (!w.AutoBackup) return;
      var info = $('#abInfo'), list = $('#abList');
      if (!info || !list) return;
      var snaps = w.AutoBackup.list();
      if (!snaps.length) {
        info.textContent = 'Belum ada cadangan. App akan menyimpan sendiri setiap 30 menit.';
        list.innerHTML = '';
        return;
      }
      var latest = snaps[0];
      info.textContent = 'Cadangan terakhir: ' + w.AutoBackup.fmtWaktu(latest.savedAt) +
        ' — total ' + snaps.length + ' salinan.';
      list.innerHTML = snaps.map(function (s) {
        return '<div class="ab-row" data-ab="' + esc(s.id) + '">' +
          '<span>' + esc(w.AutoBackup.fmtWaktu(s.savedAt)) + '</span>' +
          '<em>' + Math.round(s.bytes / 1024) + ' KB</em>' +
          '<button data-ab-restore="' + esc(s.id) + '" class="btn sm">Pulihkan</button>' +
        '</div>';
      }).join('');
    }
    App.renderAutoBackup = renderAutoBackup;

    if (w.AutoBackup) {
      w.AutoBackup.onChange(renderAutoBackup);
      // Mulai penjadwalan snapshot berkala.
      w.AutoBackup.start();
      var abNow = $('#abNow'), abRestore = $('#abRestore'), abList = $('#abList');
      if (abNow) abNow.addEventListener('click', function () {
        var r = w.AutoBackup.run(true);
        renderAutoBackup();
        App.toast(r ? 'Cadangan disimpan' : 'Belum ada data untuk dicadangkan');
      });
      if (abRestore) abRestore.addEventListener('click', function () {
        var latest = w.AutoBackup.latest();
        if (!latest) { App.toast('Belum ada cadangan'); return; }
        doRestoreAutoBackup(latest.id);
      });
      if (abList) abList.addEventListener('click', function (e) {
        var b = e.target.closest('[data-ab-restore]');
        if (!b) return;
        doRestoreAutoBackup(b.dataset.abRestore);
      });
      renderAutoBackup();
    }

    function doRestoreAutoBackup(id) {
      if (!w.confirm('Pulihkan data dari cadangan ini?\nData sekarang akan diganti.')) return;
      var r = w.AutoBackup.restore(id);
      if (r.ok) {
        App.toast('Data dipulihkan');
        setTimeout(function () { w.location.reload(); }, 700);
      } else {
        App.toast('Gagal memulihkan: ' + (r.error || 'tidak diketahui'));
      }
    }

    // Menu
    App.buildMenu = buildMenu;

    // About
    var about = 'Project Nava v4.0 — Cashflow Mini App (gaya Money Lover).\n';
    about += TG.isTelegram ? 'Terhubung via Telegram.' : 'Mode browser (untuk preview).';
    $('#aboutText').textContent = about;

    // Tema Telegram berubah -> update
    try {
      TG.wa.onEvent && TG.wa.onEvent('themeChanged', function () {
        TG.applyTheme(TG.wa.colorScheme);
      });
    } catch (e) {}

    // Perbarui saat kembali ke app
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      w.TxUI.render(); w.NotesUI.render(); w.NotesUI.check();
      if (w.Sync) { w.Sync.pull().then(function (r) { if (r && (r.added || r.updated)) { w.TxUI.render(); renderSyncStatus(); } }); }
      // Pool dari bot: cepat-cepat ditarik saat kembali ke app supaya
      // transaksi baru dari chat langsung terlihat.
      if (w.Sync && w.Sync.pullPool) {
        w.Sync.pullPool().then(function (r) {
          if (r && r.added > 0) { w.TxUI.render(); renderSyncStatus(); }
        });
      }
    });

    // ---- Sinkronisasi dengan bot ----
    initSyncUI();
    if (w.Sync) {
      // Tarik pool lebih dulu supaya isi dari bot langsung tampil
      // sebagai "menunggu disimpan", terpisah dari cashflow.
      w.Sync.pullPool().then(function (r) {
        if (r && r.count > 0) { w.TxUI.render(); }
        renderSyncStatus();
      });
      w.Sync.sync().then(function (r) {
        if (r && (r.added || r.updated || r.pushed)) {
          w.TxUI.render();
          App.toast('Data bot tersinkron');
        }
        renderSyncStatus();
      });
      // Jadwal adaptif. Saat server sehat, pool ditarik tiap 15 detik
      // supaya transaksi dari chat bot tampil nyaris real-time. Saat
      // server sedang tidak terjangkau (tunnel lagi dibalik oleh
      // supervisor), jeda diperpanjang bertahap supaya tidak menembak
      // ke alamat mati, tapi tetap segera mencoba begitu tunnel baru
      // terbit. Progresif: 15s -> 30s -> 45s -> 60s (maks).
      var POOL_STEPS = [15000, 30000, 45000, 60000];
      var FULL_STEPS = [60000, 120000, 180000, 300000];
      var poolTimer = null, fullTimer = null, poolFails = 0, fullFails = 0;

      function pick(steps, fails) { return steps[Math.min(fails, steps.length - 1)]; }

      // Render dibungkus try/catch: bila ada error saat refresh, jadwal
      // tetap jalan dan errornya tidak disembunyikan. Tanpa ini satu
      // error render bisa menghentikan seluruh siklus sinkronisasi.
      function renderAman() {
        try {
          if (w.TxUI && w.TxUI.render) w.TxUI.render();
          renderSyncStatus();
        } catch (e) { console.error('nava: render sinkron gagal', e); }
      }

      function schedulePool() {
        if (poolTimer) clearTimeout(poolTimer);
        poolTimer = setTimeout(function () {
          if (document.hidden) { schedulePool(); return; }
          Promise.resolve()
            .then(function () { return w.Sync.pullPool(); })
            .then(function (r) {
              if (r && r.added > 0) renderAman();
              if (r && r.error) { poolFails++; } else { poolFails = 0; }
            })
            .catch(function (e) { poolFails++; })
            .then(function () { schedulePool(); });
        }, pick(POOL_STEPS, poolFails));
      }

      function scheduleFull() {
        if (fullTimer) clearTimeout(fullTimer);
        fullTimer = setTimeout(function () {
          if (document.hidden) { scheduleFull(); return; }
          Promise.resolve()
            .then(function () { return w.Sync.pull(); })
            .then(function (r) {
              if (r && (r.added || r.updated)) renderAman();
              if (r && r.error) { fullFails++; } else { fullFails = 0; }
            })
            .catch(function (e) { fullFails++; })
            .then(function () { scheduleFull(); });
        }, pick(FULL_STEPS, fullFails));
      }

      schedulePool();
      scheduleFull();
    }

    App.go('home');
    console.log('Project Nava siap. Telegram:', TG.isTelegram);
  }

  /* ---------------- UI Sinkronisasi ---------------- */
  function renderSyncStatus() {
    var t = $('#syncTitle'), sub = $('#syncSub'), dot = $('#syncDot');
    if (!t) return;
    if (!w.Sync) { t.textContent = 'Sinkronisasi tidak tersedia'; return; }
    var cfg = w.Sync.getConfig();
    var st = w.Sync.getStatus();
    var urlIn = $('#syncUrl');
    if (urlIn && urlIn.value !== cfg.baseUrl && document.activeElement !== urlIn) {
      urlIn.value = cfg.baseUrl || '';
    }
    if (!cfg.baseUrl) {
      t.textContent = 'Belum menemukan server bot';
      sub.textContent = 'Mencari server bot secara otomatis… Kalau tetap kosong, isi alamatnya di bawah lalu tekan Simpan & sinkron.';
      dot.className = 'sync-dot';
      return;
    }
    if (!w.Sync.hasInitData()) {
      t.textContent = 'Server ditemukan, tetapi di luar Telegram';
      sub.textContent = 'Sinkronisasi hanya jalan di dalam Telegram (butuh initData).';
      dot.className = 'sync-dot warn';
      return;
    }
    if (st.online) {
      t.textContent = 'Terhubung ke bot';
      sub.textContent = (cfg.lastSync ? 'Sinkron ' + new Date(cfg.lastSync).toLocaleTimeString('id-ID') + ' · ' : '') +
        'Transaksi dari chat bot masuk ke dashboard sebagai "menunggu disimpan".' +
        (w.Store.Pool.count() ? ' (' + w.Store.Pool.count() + ' menunggu disimpan)' : '') +
        (cfg.manual ? '' : ' (server ditemukan otomatis)');
      dot.className = 'sync-dot on';
    } else {
      // Bedakan "sedang diaring" dari "rusak". Tunnel sering berganti
      // beberapa detik saat supervisor mencari hostname yang terjangkau,
      // dan itu kondisi normal, bukan kerusakan. Kasih tahu kapan coba lagi.
      var retrySec = Math.max(1, Math.round(((st._fails || 0) * 15) + 15));
      t.textContent = 'Menyambung ke server…';
      sub.textContent = 'Server bot sedang dialihkan ke alamat baru. Coba lagi dalam ±' +
        retrySec + ' detik.' +
        (st.lastError ? ' (' + st.lastError + ')' : '') +
        ' Aplikasi tetap jalan lokal; transaksi tetap aman dan akan terkirim nanti.';
      dot.className = 'sync-dot warn';
    }
  }

  function initSyncUI() {
    var now = $('#syncNow'), save = $('#syncSave'), url = $('#syncUrl');
    if (!now || !save || !url) return;
    renderSyncStatus();

    save.addEventListener('click', function () {
      var v = url.value.trim();
      if (v && !/^https?:\/\//i.test(v)) {
        App.toast('Alamat harus diawali http:// atau https://');
        return;
      }
      w.Sync.configure(v, true);
      App.toast(v ? 'Alamat server disimpan' : 'Alamat server dikosongkan');
      if (!v) { renderSyncStatus(); return; }
      if (!w.Sync.hasInitData()) {
        renderSyncStatus();
        App.toast('Tersimpan. Sinkron berjalan saat dibuka di dalam Telegram.');
        return;
      }
      save.disabled = true;
      w.Sync.sync().then(function (r) {
        save.disabled = false;
        if (r && r.error) { App.toast('Gagal: ' + r.error); }
        else {
          w.TxUI.render();
          App.toast('Sinkron selesai');
        }
        renderSyncStatus();
      });
    });

    now.addEventListener('click', function () {
      if (!w.Sync.isConfigured()) { App.toast('Isi alamat server bot dulu'); return; }
      now.disabled = true;
      App.toast('Menyinkronkan…');
      w.Sync.sync().then(function (r) {
        now.disabled = false;
        if (r && r.error) App.toast('Gagal: ' + r.error);
        else { w.TxUI.render(); App.toast('Sinkron selesai'); }
        renderSyncStatus();
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
