/* =========================================================
   transactions.js — Project Nava v4 (dropdown + scan struk)
   - Halaman input full-screen dengan keypad numerik
   - Kategori memakai dropdown (ringkas, tidak makan tempat)
   - Keterangan opsional + tombol scan struk (foto -> isi otomatis)
   - Multi akun (Tunai / Rekening / Kartu) + saldo per akun
   - Riwayat: cari + filter, hapus + undo
   - Rekap: donut komposisi + bar kategori
   ========================================================= */
(function (w) {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return [].slice.call(document.querySelectorAll(s)); };
  var S = w.Store, TG = w.TG, Tx = S.Tx, Groups = S.Groups, Accounts = S.Accounts;

  var el = {};
  var type = 'out';           // 'in' | 'out' (default Pengeluaran, seperti Money Lover)
  var group = null;
  var sub = null;
  var accountId = null;
  var amountStr = '';         // string digit dari keypad
  var editingId = null;
  var idemKey = null;
  var saving = false;
  var undoTimer = null, undoId = null;
  var recapYM = S.ymOf(S.todayStr());
  var filter = { type: 'all', group: '', from: recapYM + '-01', to: recapYM + '-31', q: '' };
  var openDays = {};

  var PALETTE = ['#2f6fed', '#12a150', '#f5a524', '#e5484d', '#8b5cf6',
                 '#0ea5a5', '#ec4899', '#64748b', '#84cc16', '#f97316'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function money(n) {
    n = Math.round(Number(n) || 0);
    return 'Rp' + n.toLocaleString('id-ID');
  }
  function signedMoney(t) { return (t.type === 'in' ? '+' : '−') + money(t.amount); }

  function toast(msg, ms) { if (w.App) w.App.toast(msg, ms); }

  function labelOf(t) {
    if (t.sub) return t.sub;
    if (t.note) return t.note;
    return t.group;
  }
  function iconOfTx(t) {
    var g = Groups.of(t.type, t.group);
    if (g) return Groups.iconOf(g, t.sub);
    return t.type === 'in' ? '💰' : '💸';
  }
  function accOf(t) { return Accounts.get(t.account_id); }

  /* =========================================================
     POOL — transaksi dari chat bot yang menunggu "Simpan"
     ========================================================= */
  function renderPool() {
    var card = $('#poolCard');
    if (!card) return;
    var items = S.Pool.all();
    if (!items.length) { card.hidden = true; return; }
    card.hidden = false;
    $('#poolBadge').textContent = String(items.length);
    $('#poolList').innerHTML = items.map(function (t) {
      var ini = t.type === 'in';
      var acc = accOf(t);
      return '<div class="item pool-item" data-pool="' + esc(t.id) + '">' +
        '<span class="tx-icon ' + (ini ? 'in' : 'out') + '">' + esc(iconOfTx(t)) + '</span>' +
        '<span class="item-body">' +
          '<span class="item-title">' + esc(labelOf(t)) + '</span>' +
          '<span class="item-sub">' +
            '<span class="tag">' + esc(t.group) + '</span>' +
            '<span>' + esc(S.dayLabel(t.transaction_date)) + '</span>' +
            (acc ? '<span>' + esc(acc.icon + ' ' + acc.name) + '</span>' : '') +
          '</span>' +
          (t.note && t.note !== labelOf(t) ? '<span class="item-note">' + esc(t.note) + '</span>' : '') +
        '</span>' +
        '<span class="item-amt ' + (ini ? 'amt-in' : 'amt-out') + '">' + signedMoney(t) + '</span>' +
        '<span class="pool-acts">' +
          '<button class="pool-save" data-psave="' + esc(t.id) + '">Simpan</button>' +
          '<button class="pool-del" data-pdel="' + esc(t.id) + '">Hapus</button>' +
        '</span>' +
      '</div>';
    }).join('');
  }

  /* Tekan "Simpan": item pool resmi masuk cashflow. */
  function acceptPoolItem(id, btn) {
    var item = S.Pool.get(id);
    if (!item) return;
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    var work = (w.Sync && w.Sync.accept)
      ? w.Sync.accept(id)
      // Tanpa Sync (mis. di luar Telegram): tetap masukkan lokal.
      : Promise.resolve(S.Tx.adopt(item)).then(function (r) { S.Pool.remove(id); return r; });
    Promise.resolve(work).then(function (r) {
      render();
      toast(r && r.warn ? 'Tersimpan di HP, menunggu sinkron' : 'Masuk cashflow ✓');
    }).catch(function () {
      if (btn) { btn.disabled = false; btn.textContent = 'Simpan'; }
      render();
      toast('Gagal menyimpan');
    });
  }

  /* Tekan "Hapus": buang item dari pool (tidak masuk cashflow). */
  function rejectPoolItem(id, btn) {
    if (btn) { btn.disabled = true; }
    var res = w.Sync ? w.Sync.reject(id) : Promise.resolve(null);
    Promise.resolve(res).then(function () {
      render();
      toast('Dihapus dari pool');
    }).catch(function () {
      if (btn) { btn.disabled = false; }
      render();
    });
  }

  /* =========================================================
     BERANDA
     ========================================================= */
  function renderHome() {
    var ym = S.ymOf(S.todayStr());
    var s = Tx.summary({ from: ym + '-01', to: ym + '-31' });
    renderPool();
    var bal = $('#hBalance');
    if (bal) {
      bal.textContent = money(s.net);
      bal.classList.toggle('pos', s.net > 0);
      bal.classList.toggle('neg', s.net < 0);
    }
    var hIn = $('#hIn'); if (hIn) hIn.textContent = money(s.in);
    var hOut = $('#hOut'); if (hOut) hOut.textContent = money(s.out);

    // Kartu akun + saldo (Tunai, Rekening, Kas, dll)
    var accs = Accounts.active();
    var cards = accs.map(function (a) {
      var b = Accounts.balance(a.id);
      return '<button class="acc-card" data-acc="' + esc(a.id) + '">' +
        '<span class="acc-card-top"><span class="acc-ico">' + esc(a.icon) + '</span>' +
        '<span class="acc-name">' + esc(a.name) + '</span></span>' +
        '<span class="acc-bal ' + (b > 0 ? 'pos' : b < 0 ? 'neg' : '') + '">' + money(b) + '</span>' +
        '</button>';
    }).join('');

    // Kartu Dana Bank (berisi Kas Darurat 5% & Kas SDH 5%)
    var bankCard = '';
    var nb = w.NavaBank;
    if (nb) {
      var gb = nb.get();
      var due = nb.wajibSetoranBulanan(Tx.active(), ym);
      var doneWajib = nb.sudahWajib(ym);
      var pct = nb.persenTerpenuhi(Tx.active(), ym);
      bankCard =
        '<button class="acc-card nb-card' + (gb.available > 0 ? ' nb-ok' : '') + '" data-nbank>' +
          '<span class="acc-card-top"><span class="acc-ico">🏦</span>' +
          '<span class="acc-name">Dana Bank</span></span>' +
          '<span class="acc-bal ' + (gb.available > 0 ? 'pos' : gb.available < 0 ? 'neg' : '') + '">' +
            money(gb.available) + '</span>' +
          '<span class="nb-sub" style="font-size:11px;">Darurat: ' + money(gb.daruratAvailable || 0) + ' · SDH: ' + money(gb.sdhAvailable || 0) + '</span>' +
        '</button>';
    }

    var hAccEl = $('#hAccounts');
    if (hAccEl) {
      hAccEl.innerHTML = bankCard + cards +
        '<button class="acc-card in-add" data-accadd>＋ Tambah akun</button>';
    }

    // Pencatatan cepat: subkategori yang paling sering dipakai (jika elemen tersedia)
    var hQuick = $('#hQuick');
    if (hQuick) {
      var recent = Tx.frequent('out', 6).concat(Tx.frequent('in', 3));
      hQuick.innerHTML = recent.length
        ? recent.map(function (r) {
            var g = Groups.of(r.type, r.group);
            var ic = g ? Groups.iconOf(g, r.sub) : '💰';
            return '<button class="chip" data-qt="' + esc(r.type) + '" data-qg="' + esc(r.group) +
              '" data-qs="' + esc(r.sub || '') + '">' + ic + ' ' +
              esc(r.sub || r.group) + '</button>';
          }).join('')
        : '<span class="muted xs">Kategori yang sering dipakai akan muncul di sini.</span>';
    }

    // Transaksi hari ini (hanya menampilkan transaksi hari ini)
    var today = S.todayStr();
    var todayTx = Tx.active().filter(function (t) {
      return (t.transaction_date || t.date || '').slice(0, 10) === today;
    });
    var hRecent = $('#hRecent');
    if (hRecent) {
      hRecent.innerHTML = todayTx.length
        ? todayTx.map(txRow).join('')
        : '<div class="empty"><b>Belum ada transaksi hari ini</b>Transaksi yang Anda catat hari ini akan tampil di sini.</div>';
    }
  }

  /* =========================================================
     DANA BANK — dipindah dari modul Mas Cim ke Project Nava
     =========================================================
     Dua aksi saja supaya sederhana:
       • Out / Bon   — pengeluaran biasa (Out) atau bon/utang (Bon),
                       keduanya memakai Dana Bank.
       • Setor       — menambah Dana Bank, termasuk Setoran Kas Wajib.
     Saldo awal diatur lewat tombol "Atur Saldo Awal" yang splendid
     membuka sheet kecil berisi satu isian angka.
     ========================================================= */
  /* Buka sheet dengan penanganan error.
     Fungsi ini berakar dari bug "Out/Bon crash / Atur Saldo Awal tidak
     bisa dibuka": kalau w.App atau w.App.sheet tidak tersedia, panggilan
     langsung melempar galat, jadi tombol mati tanpa jejak. Di sini galat
     ditangkap dan ditunjukkan ke pengguna sebagai toast. */
  function bankSheet(title, html, onOpen) {
    if (!w.App || typeof w.App.sheet !== 'function') {
      if (w.App && w.App.toast) w.App.toast('Form tidak bisa dibuka. Muat ulang aplikasi.');
      return false;
    }
    try {
      w.App.sheet(title, html, onOpen);
      return true;
    } catch (e) {
      if (w.App && w.App.toast) w.App.toast('Form gagal dibuka: ' + (e && e.message ? e.message : 'galat'));
      return false;
    }
  }

  function openBankSheet() {
    if (!w.NavaBank || !w.App || typeof w.App.sheet !== 'function') {
      if (w.App && w.App.toast) w.App.toast('Dana Bank belum siap. Muat ulang aplikasi.');
      return;
    }
    var B = w.NavaBank;
    var g = B.get();
    var ym = S.ymOf(S.todayStr());
    var due = B.wajibSetoranBulanan(Tx.active(), ym);
    var done = B.sudahWajib(ym);
    var pct = B.persenTerpenuhi(Tx.active(), ym);

    var head =
      '<p class="nb-hint">Sisa tersedia <b>' + money(g.available) + '</b> · saldo awal ' +
        money(g.initial) + ' · dipakai ' + money(g.totalOut) + '</p>' +
      (due > 0
        ? '<p class="nb-hint">' + (done
            ? 'Setoran kas wajib bulan ini <b>' + money(due) + '</b> sudah tersimpan.'
            : 'Belum disetor: <b>' + money(due) + '</b> (10% pemasukan bulan ini)') +
          ' <span class="nb-bar"><i style="width:' + pct + '%"></i></span></p>'
        : '<p class="nb-hint">Belum ada pemasukan bulan ini, jadi belum ada setoran wajib.</p>');

    var acts =
      '<div class="field-row" style="margin-top:12px">' +
        '<button class="btn ghost" data-bk="out">Out / Bon</button>' +
      '</div>' +
      '<button class="btn ghost block" data-bk="initial" style="margin-top:8px">Atur Saldo Awal</button>' +
      '<div style="margin-top:14px"><p class="nb-hint"><b>Riwayat</b></p><div id="nbHist"></div></div>';

    bankSheet('Dana Bank', head + acts, function (body) {
      // Riwayat
      var hist = body.querySelector('#nbHist');
      var list = B.entries().slice().reverse().slice(0, 12);
      hist.innerHTML = list.length
        ? list.map(function (e) {
            var masuk = e.moneyIn > 0, jumlah = masuk ? e.moneyIn : e.moneyOut;
            return '<div class="nb-hist"><span>' + esc(e.description || (masuk ? 'Dana masuk' : 'Dana keluar')) +
              '<br><span class="muted xs">' + esc(e.date) + '</span></span>' +
              '<b class="' + (masuk ? 'pos' : 'neg') + '">' + (masuk ? '+' : '-') + money(jumlah) + '</b></div>';
          }).join('')
        : '<p class="nb-hint">Belum ada transaksi Dana Bank.</p>';

      body.addEventListener('click', function (e) {
        var b = e.target.closest('[data-bk]');
        if (!b) return;
        var k = b.dataset.bk;
        if (k === 'out') { sheetOutBon(); }
        else if (k === 'initial') { sheetInitial(g.initial); }
      });
    });
  }

  function sheetInitial(cur) {
    bankSheet('Atur Saldo Awal Dana Bank',
      '<label class="field"><span class="lbl">Saldo awal (Rp)</span>' +
      '<input type="number" id="nbInit" inputmode="numeric" value="' + (cur || 0) + '"></label>' +
      '<p class="muted xs" style="margin-top:6px">Saldo awal otomatis terbagi 50% Kas Darurat & 50% Kas SDH. ' +
      'Isi 0 bila belum ada.</p>',
      function (body) {
        var b = document.createElement('button');
        b.className = 'btn primary block';
        b.style.marginTop = '12px';
        b.textContent = 'Simpan';
        b.addEventListener('click', function () {
          var v = parseInt(String(body.querySelector('#nbInit').value).replace(/\D/g, ''), 10) || 0;
          w.NavaBank.setInitial(v);
          w.App.closeSheet();
          if (w.App && w.App.toast) w.App.toast('Saldo awal tersimpan (50% Darurat + 50% SDH)');
          render();
        });
        body.appendChild(b);
      });
  }

  function getOwnerPin() {
    var pin = '1234';
    try {
      var raw = localStorage.getItem('nava_ronce_data_v2');
      if (raw) {
        var d = JSON.parse(raw);
        if (d && Array.isArray(d.users)) {
          var o = d.users.find(function (u) { return u.role === 'owner'; });
          if (o && o.pin) pin = String(o.pin).trim();
        }
      }
    } catch (e) {}
    return pin;
  }

  function sheetOutBon() {
    bankSheet('Out / Bon Kas Darurat',
      '<p class="nb-hint">Pengeluaran biasa atau bon operasional. ' +
      'Diambil dari <b>Kas Darurat</b>.</p>' +
      '<div class="row-2" id="nbKind">' +
        '<button class="chip on" data-kind="Out">Out</button>' +
        '<button class="chip" data-kind="Bon">Bon</button></div>' +
      '<label class="field"><span class="lbl">Keterangan *</span>' +
      '<input type="text" id="nbDesc" placeholder="Contoh: Bensin antar / Bon operasional"></label>' +
      '<label class="field"><span class="lbl">Nominal (Rp) *</span>' +
      '<input type="number" id="nbAmt" inputmode="numeric" placeholder="0"></label>' +
      '<label class="field"><span class="lbl">Tanggal</span>' +
      '<input id="nbDate" type="date" value="' + S.todayStr() + '"></label>',
      function (body) {
        var kind = 'Out';
        body.querySelectorAll('#nbKind [data-kind]').forEach(function (x) {
          x.addEventListener('click', function () {
            kind = x.dataset.kind;
            body.querySelectorAll('#nbKind [data-kind]').forEach(function (y) { y.classList.remove('on'); });
            x.classList.add('on');
          });
        });
        var btn = document.createElement('button');
        btn.className = 'btn primary block';
        btn.style.marginTop = '12px';
        btn.textContent = 'Simpan';
        btn.addEventListener('click', function () {
          var desc = (body.querySelector('#nbDesc').value || '').trim();
          var amt = parseInt(String(body.querySelector('#nbAmt').value).replace(/\D/g, ''), 10) || 0;
          if (!desc) { if (w.App.toast) w.App.toast('Keterangan wajib diisi'); return; }
          if (amt <= 0) { if (w.App.toast) w.App.toast('Nominal harus lebih dari 0'); return; }
          try {
            w.NavaBank.add({
              description: kind + ' (Darurat) — ' + desc,
              moneyIn: 0,
              moneyOut: amt,
              date: body.querySelector('#nbDate').value || S.todayStr(),
              fund: 'darurat'
            });
            w.App.closeSheet();
            if (w.App.toast) w.App.toast(kind + ' Kas Darurat tersimpan');
            render();
          } catch (err) {
            if (w.App.toast) w.App.toast(err.message);
          }
        });
        body.appendChild(btn);
      });
  }

  function sheetOutSDH() {
    bankSheet('Out Kas SDH 🔒',
      '<div style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:10px;padding:10px 12px;margin-bottom:12px;">' +
        '<span style="font-size:12px;font-weight:700;color:var(--danger);display:block;">⚠️ Akses Khusus Owner</span>' +
        '<span style="font-size:11.5px;color:var(--text);display:block;margin-top:2px;">Pengeluaran dari <b>Kas SDH</b> hanya boleh dilakukan oleh Owner dengan memasukkan PIN.</span>' +
      '</div>' +
      '<label class="field"><span class="lbl">Keterangan Penyaluran / Keperluan *</span>' +
      '<input type="text" id="nbSDHDesc" placeholder="Contoh: Sedekah Jumat / Santunan"></label>' +
      '<label class="field"><span class="lbl">Nominal (Rp) *</span>' +
      '<input type="number" id="nbSDHAmt" inputmode="numeric" placeholder="0"></label>' +
      '<label class="field"><span class="lbl">Tanggal</span>' +
      '<input id="nbSDHDate" type="date" value="' + S.todayStr() + '"></label>' +
      '<label class="field" style="margin-top:10px;"><span class="lbl">🔑 Kunci PIN Owner *</span>' +
      '<input type="password" id="nbSDHPin" inputmode="numeric" maxlength="8" placeholder="Masukkan PIN Owner"></label>',
      function (body) {
        var btn = document.createElement('button');
        btn.className = 'btn primary block';
        btn.style.marginTop = '14px';
        btn.textContent = 'Verifikasi PIN & Simpan';
        btn.addEventListener('click', function () {
          var desc = (body.querySelector('#nbSDHDesc').value || '').trim();
          var amt = parseInt(String(body.querySelector('#nbSDHAmt').value).replace(/\D/g, ''), 10) || 0;
          var pin = (body.querySelector('#nbSDHPin').value || '').trim();

          if (!desc) { if (w.App.toast) w.App.toast('Keterangan wajib diisi'); return; }
          if (amt <= 0) { if (w.App.toast) w.App.toast('Nominal harus lebih dari 0'); return; }
          if (!pin) { if (w.App.toast) w.App.toast('PIN Owner wajib diisi'); return; }

          if (pin !== getOwnerPin()) {
            if (w.App.toast) w.App.toast('PIN Owner salah! Akses ditolak.');
            return;
          }

          try {
            w.NavaBank.add({
              description: 'SDH — ' + desc,
              moneyIn: 0,
              moneyOut: amt,
              date: body.querySelector('#nbSDHDate').value || S.todayStr(),
              fund: 'sdh'
            });
            w.App.closeSheet();
            if (w.App.toast) w.App.toast('Pengeluaran Kas SDH berhasil dicatat');
            render();
          } catch (err) {
            if (w.App.toast) w.App.toast(err.message);
          }
        });
        body.appendChild(btn);
      });
  }

  function sheetSetor(due, done, ym) {
    var g = w.NavaBank.get();
    bankSheet('Setor Dana Bank',
      '<p class="nb-hint">Setoran menambah Dana Bank. ' +
      'Setiap setoran otomatis terbagi dua: <b>50% Kas Darurat</b> & <b>50% Kas SDH</b>.</p>' +
      (due > 0 && !done
        ? '<button class="btn primary block" data-bkw style="margin-bottom:12px">' +
          '⚡ Setor Kas Wajib 10% (' + money(due) + ')</button>'
        : '') +
      '<label class="field"><span class="lbl">Keterangan</span>' +
      '<input type="text" id="nbSDesc" value="Setoran"></label>' +
      '<label class="field"><span class="lbl">Nominal (Rp)</span>' +
      '<input type="number" id="nbSAmt" inputmode="numeric" placeholder="0"></label>',
      function (body) {
        body.addEventListener('click', function (e) {
          if (e.target.closest('[data-bkw]')) {
            w.NavaBank.tambahSetoranWajib(due, ym);
            w.App.closeSheet();
            if (w.App.toast) w.App.toast('Setoran kas wajib tersimpan (5% Darurat + 5% SDH)');
            render();
          }
        });
        var btn = document.createElement('button');
        btn.className = 'btn primary block';
        btn.style.marginTop = '12px';
        btn.textContent = 'Simpan';
        btn.addEventListener('click', function () {
          var amt = parseInt(String(body.querySelector('#nbSAmt').value).replace(/\D/g, ''), 10) || 0;
          if (amt <= 0) { if (w.App.toast) w.App.toast('Nominal harus lebih dari 0'); return; }
          var desc = (body.querySelector('#nbSDesc').value || 'Setoran').trim();
          try {
            w.NavaBank.add({
              description: desc,
              moneyIn: amt,
              moneyOut: 0,
              date: S.todayStr()
            });
            w.App.closeSheet();
            if (w.App.toast) w.App.toast('Setoran tersimpan (50% Darurat + 50% SDH)');
            render();
          } catch (err) { if (w.App.toast) w.App.toast(err.message); }
        });
        body.appendChild(btn);
      });
  }

  function txRow(t) {
    var ini = t.type === 'in';
    var acc = accOf(t);
    return '<button class="item tx-row" data-open="' + esc(t.id) + '">' +
      '<span class="tx-icon ' + (ini ? 'in' : 'out') + '">' + esc(iconOfTx(t)) + '</span>' +
      '<span class="item-body">' +
        '<span class="item-title">' + esc(labelOf(t)) + '</span>' +
        '<span class="item-sub">' +
          (t.sub ? '<span class="tag">' + esc(t.group) + '</span>' : '') +
          '<span>' + esc(S.dayLabel(t.transaction_date)) + '</span>' +
          (acc ? '<span>' + esc(acc.icon + ' ' + acc.name) + '</span>' : '') +
        '</span>' +
      '</span>' +
      '<span class="item-amt ' + (ini ? 'amt-in' : 'amt-out') + '">' + signedMoney(t) + '</span>' +
      '</button>';
  }

  /* =========================================================
     RIWAYAT
     ========================================================= */
  function renderGroupFilter() {
    if (!el.fGroup) return;
    var opts = ['<option value="">Semua kategori</option>'];
    Groups.for('in').concat(Groups.for('out')).forEach(function (g) {
      opts.push('<option value="' + esc(g.group) + '">' +
        (g.type === 'in' ? '+ ' : '− ') + esc(g.group) + '</option>');
    });
    el.fGroup.innerHTML = opts.join('');
    el.fGroup.value = filter.group;
  }

  function renderHistory() {
    var list = Tx.query(filter);
    if (!list.length) {
      el.hList.innerHTML = '<div class="empty"><b>Tidak ada transaksi</b>Belum ada transaksi pada periode ini.</div>';
      return;
    }
    var byDay = Tx.byDay(list);
    var dates = Object.keys(byDay).sort().reverse();
    el.hList.innerHTML = dates.map(function (d) {
      var items = byDay[d], rin = 0, rout = 0;
      items.forEach(function (t) { if (t.type === 'in') rin += t.amount; else rout += t.amount; });
      var isOpen = !!openDays[d];
      return '<div class="day-group' + (isOpen ? ' open' : '') + '" data-day="' + esc(d) + '">' +
        '<button type="button" class="day-head" data-day-toggle="' + esc(d) + '">' +
          '<div class="day-head-left">' +
            '<span class="day-chevron">▶</span>' +
            '<span class="day-title">' + esc(S.dayLabel(d)) + '</span>' +
            '<span class="day-badge">' + items.length + '</span>' +
          '</div>' +
          '<div class="day-head-right">' +
            (rin ? '<span class="amt-pos">+' + money(rin) + '</span> ' : '') +
            (rout ? '<span class="amt-neg">−' + money(rout) + '</span>' : '') +
          '</div>' +
        '</button>' +
        '<div class="day-items"' + (isOpen ? '' : ' style="display:none;"') + '>' +
          items.map(txRow).join('') +
        '</div>' +
      '</div>';
    }).join('');
  }

  /* =========================================================
     KOMPOSISI PENGELUARAN (Dipindah ke Tab Dashboard)
     ========================================================= */
  function renderKomposisi(s) {
    var dEl = $('#rDonut'), cEl = $('#rCats');
    if (!dEl || !cEl) return;

    var outs = s.categories.filter(function (c) { return c.type === 'out'; });
    var totalOut = outs.reduce(function (a, c) { return a + c.total; }, 0);
    if (!outs.length || !totalOut) {
      dEl.innerHTML = '<div class="donut-empty">Belum ada<br>pengeluaran</div>';
    } else {
      var R = 46, C = 2 * Math.PI * R;
      var acc2 = 0;
      var segs = outs.map(function (c, i) {
        var frac = c.total / totalOut;
        var dash = (frac * C).toFixed(2) + ' ' + C.toFixed(2);
        var off = (-acc2 * C).toFixed(2);
        acc2 += frac;
        var col = PALETTE[i % PALETTE.length];
        return '<circle r="' + R + '" cx="60" cy="60" fill="none" stroke="' + col +
          '" stroke-width="16" stroke-dasharray="' + dash + '" stroke-dashoffset="' + off +
          '" transform="rotate(-90 60 60)"></circle>';
      }).join('');
      dEl.innerHTML =
        '<svg class="donut" viewBox="0 0 120 120">' + segs +
        '<text x="60" y="58" class="donut-center-txt" text-anchor="middle">Total</text>' +
        '<text x="60" y="74" text-anchor="middle" style="font-size:12px;font-weight:700;fill:var(--text)">' +
        esc(money(totalOut).replace('Rp', '')) + '</text></svg>' +
        '<div class="donut-legend">' + outs.slice(0, 6).map(function (c, i) {
          var label = c.sub ? c.sub : c.group;
          return '<div class="dl-row"><span class="dl-dot" style="background:' +
            PALETTE[i % PALETTE.length] + '"></span>' +
            '<span class="dl-name">' + esc(label) + '</span>' +
            '<span class="dl-val">' + Math.round(c.total / totalOut * 100) + '%</span></div>';
        }).join('') + '</div>';
    }

    // Bar kategori (semua jenis)
    var max = s.categories.reduce(function (m, c) { return Math.max(m, c.total); }, 0) || 1;
    cEl.innerHTML = s.categories.length
      ? s.categories.map(function (c) {
          var label = c.sub ? c.group + ' · ' + c.sub : c.group;
          return '<div class="cat-row">' +
            '<div class="cr-top"><b>' + esc(label) + '</b>' +
            '<span class="cr-amt ' + c.type + '">' + (c.type === 'in' ? '+' : '−') + money(c.total) + '</span></div>' +
            '<div class="cr-track"><i class="' + c.type + '" style="width:' +
            (c.total / max * 100).toFixed(1) + '%"></i></div></div>';
        }).join('')
      : '<div class="empty">Belum ada transaksi pada bulan ini.</div>';
  }

  /* =========================================================
     REKAP
     ========================================================= */
  function renderRecap() {
    var s = Tx.summary({ from: recapYM + '-01', to: recapYM + '-31' });
    var rLabel = $('#rLabel'); if (rLabel) rLabel.textContent = S.monthLabel(recapYM);
    var rCount = $('#rCount'); if (rCount) rCount.textContent = s.count + ' transaksi';
    var rIn = $('#rIn'); if (rIn) rIn.textContent = money(s.in);
    var rOut = $('#rOut'); if (rOut) rOut.textContent = money(s.out);
    var net = $('#rNet');
    if (net) {
      net.textContent = money(s.net);
      net.style.color = s.net >= 0 ? 'var(--success)' : 'var(--danger)';
    }

    // Donut & rincian kategori pengeluaran bulan yang dipilih di tab Rekap
    renderKomposisi(s);
  }

  /* =========================================================
     TAB: KAS (Kas Darurat & Kas SDH)
     ========================================================= */
  function renderBankView() {
    if (!w.NavaBank) return;
    var B = w.NavaBank;
    var g = B.get();
    var ym = S.ymOf(S.todayStr());
    var due = B.wajibSetoranBulanan(Tx.active(), ym);
    var done = B.sudahWajib(ym);
    var pct = B.persenTerpenuhi(Tx.active(), ym);

    var availEl = $('#vbAvail');
    if (availEl) {
      availEl.textContent = money(g.available);
      availEl.style.color = g.available > 0 ? 'var(--success)' : (g.available < 0 ? 'var(--danger)' : 'var(--text)');
    }
    var availDaruratEl = $('#vbAvailDarurat');
    if (availDaruratEl) availDaruratEl.textContent = money(g.daruratAvailable || 0);

    var availSDHEl = $('#vbAvailSDH');
    if (availSDHEl) availSDHEl.textContent = money(g.sdhAvailable || 0);

    var initEl = $('#vbInitial');
    if (initEl) initEl.textContent = money(g.initial);
    var outEl = $('#vbOut');
    if (outEl) outEl.textContent = money(g.totalOut);

    var descEl = $('#vbWajibDesc');
    var barEl = $('#vbWajibBar');
    var badgeEl = $('#vbWajibBadge');
    var actWrap = $('#vbWajibActionWrap');

    if (descEl) {
      if (due > 0) {
        if (done) {
          descEl.innerHTML = 'Setoran wajib bulan ini <b>' + money(due) + '</b> sudah tersimpan (otomatis terbagi: 5% Kas Darurat & 5% Kas SDH).';
          if (badgeEl) { badgeEl.textContent = 'LUNAS'; badgeEl.className = 'tag done'; }
          if (barEl) barEl.style.width = '100%';
          if (actWrap) actWrap.innerHTML = '';
        } else {
          descEl.innerHTML = 'Wajib setor <b>' + money(due) + '</b> (10% dari total pemasukan bulan ini). Saat disetor otomatis terbagi dua: <b>5% Kas Darurat</b> & <b>5% Kas SDH</b>.';
          if (badgeEl) { badgeEl.textContent = pct + '%'; badgeEl.className = 'tag proses'; }
          if (barEl) barEl.style.width = pct + '%';
          if (actWrap) {
            actWrap.innerHTML = '<button class="btn ghost block" id="vbBtnSetorWajibAuto" style="font-size:13px;padding:8px 12px;margin-top:6px;">' +
              'Setorkan Wajib ' + money(due) + ' Sekarang (5% Darurat + 5% SDH)</button>';
          }
        }
      } else {
        descEl.textContent = 'Belum ada pemasukan bulan ini, jadi belum ada kewajiban setoran.';
        if (badgeEl) { badgeEl.textContent = 'NIHIL'; badgeEl.className = 'tag'; }
        if (barEl) barEl.style.width = '0%';
        if (actWrap) actWrap.innerHTML = '';
      }
    }

    var listEl = $('#vbHistoryList');
    if (listEl) {
      var entries = B.entries().slice().reverse();
      if (!entries.length) {
        listEl.innerHTML = '<div class="empty"><b>Belum ada transaksi Kas</b>Gunakan tombol aksi di atas untuk mencatat.</div>';
      } else {
        listEl.innerHTML = entries.map(function (e) {
          var masuk = e.moneyIn > 0, jumlah = masuk ? e.moneyIn : e.moneyOut;
          var tgl = e.date ? S.dayLabel(e.date) : '-';
          var isSDH = (e.fund === 'sdh');
          var fundBadge = isSDH
            ? '<span class="tag done" style="font-size:10px;padding:2px 6px;margin-right:6px;">Kas SDH</span>'
            : '<span class="tag" style="font-size:10px;padding:2px 6px;margin-right:6px;">Kas Darurat</span>';
          return '<div class="item" style="padding:10px 12px;">' +
            '<div class="item-body">' +
              '<div class="item-title" style="font-size:13.5px;font-weight:600;">' + fundBadge + esc(e.description || (masuk ? 'Dana masuk' : 'Dana keluar')) + '</div>' +
              '<div class="item-sub"><span style="font-size:11.5px;color:var(--text-2);">' + esc(tgl) + '</span></div>' +
            '</div>' +
            '<span class="stat-val ' + (masuk ? 'pos' : 'neg') + '" style="font-size:14.5px;font-weight:700;white-space:nowrap;">' +
              (masuk ? '+' : '−') + money(jumlah) +
            '</span>' +
          '</div>';
        }).join('');
      }
    }
  }

  function render() {
    renderHome();
    renderGroupFilter();
    renderHistory();
    renderRecap();
    renderBankView();
  }

  /* =========================================================
     HALAMAN INPUT — keypad & kategori
     ========================================================= */
  function showErr(msg) {
    if (!el.err) return;
    el.err.textContent = msg;
    el.err.classList.remove('hidden');
  }
  function clearErr() {
    if (!el.err) return;
    el.err.classList.add('hidden');
    el.err.textContent = '';
  }

  function amountValue() {
    var n = Number(amountStr || 0);
    return isFinite(n) ? n : 0;
  }

  function paintAmount() {
    var v = amountValue();
    el.disp.classList.remove('in', 'out');
    el.disp.classList.add(type);
    el.disp.textContent = v > 0 ? money(v) : 'Rp0';
    var hint = el.hint;
    if (v > 0) {
      hint.textContent = editingId ? 'Ubah nominal lalu tekan ✓' : 'Tekan ✓ untuk menyimpan';
      hint.classList.remove('warn');
    } else {
      hint.textContent = editingId ? 'Ubah nominal lalu tekan ✓' : 'Ketik nominal di bawah';
      hint.classList.remove('warn');
    }
  }

  function press(k) {
    if (k === 'del') {
      amountStr = amountStr.slice(0, -1);
    } else if (k === 'ok') {
      submit();
      return;
    } else {
      // Maksimal 15 digit, tanpa nol di depan
      if (amountStr.length >= 15) return;
      if (amountStr === '0') amountStr = k;
      else amountStr += k;
    }
    TG.haptic('select');
    clearErr();
    paintAmount();
  }

  function renderTxAccounts() {
    el.txAccounts.innerHTML = Accounts.active().map(function (a) {
      return '<button class="tx-acc' + (a.id === accountId ? ' on' : '') +
        '" data-account="' + esc(a.id) + '">' + esc(a.icon) + ' ' + esc(a.name) + '</button>';
    }).join('');
  }

  function isDirect() {
    var g = group ? Groups.of(type, group) : null;
    return !!(g && g.isDirect);
  }
  function needNote() {
    var g = group ? Groups.of(type, group) : null;
    if (!g) return false;
    if (g.isDirect) return true;
    return Groups.subsDetail(g).length === 0;
  }

  /* --- KATEGORI: dropdown kelompok + subkategori (ringkas) --- */
  function renderGroupSelect() {
    var list = Groups.for(type);
    if (!list.length) {
      el.selGroup.innerHTML = '<option value="">Belum ada kategori</option>';
      el.selGroup.value = '';
      return;
    }
    var opts = ['<option value="">— Pilih kategori —</option>'];
    list.forEach(function (g) {
      opts.push('<option value="' + esc(g.group) + '">' +
        esc((g.icon || '•') + ' ' + g.group) + '</option>');
    });
    el.selGroup.innerHTML = opts.join('');
    el.selGroup.value = group || '';
  }

  function renderSubSelect() {
    var g = group ? Groups.of(type, group) : null;
    if (!g || g.isDirect || !Groups.subsDetail(g).length) {
      el.subField.classList.add('hidden');
      el.selSub.innerHTML = '';
      return;
    }
    var subs = Groups.subsDetail(g);
    el.subField.classList.remove('hidden');
    var opts = ['<option value="">— Pilih sub —</option>'];
    subs.forEach(function (s) {
      opts.push('<option value="' + esc(s.n) + '">' + esc((s.i || '•') + ' ' + s.n) + '</option>');
    });
    el.selSub.innerHTML = opts.join('');
    el.selSub.value = sub || '';
  }

  function selectCat(g, s) {
    group = g || null; sub = s || null;
    clearErr();
    renderGroupSelect();
    renderSubSelect();
    TG.haptic('select');
  }

  function setType(t) {
    if (type === t) return;
    type = t; group = null; sub = null;
    $$('#txType .seg-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.t === t); });
    renderGroupSelect();
    renderSubSelect();
    paintAmount();
    clearErr();
    TG.haptic('select');
  }

  function resetForm() {
    type = 'out';
    group = null; sub = null;
    editingId = null; saving = false;
    idemKey = S.uid();
    amountStr = '';
    var f = Accounts.first();
    accountId = f ? f.id : null;
    el.txDate.value = S.todayStr();
    el.txDate.max = S.todayStr();
    el.dateLabel.textContent = 'Hari ini';
    el.note.value = '';
    el.pageTitle.textContent = 'Tambah Transaksi';
    el.okBtn.disabled = false;
    $$('#txType .seg-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.t === 'out'); });
    renderTxAccounts();
    renderGroupSelect();
    renderSubSelect();
    paintAmount();
    clearErr();
    resetScan();
  }

  function openAdd(seed) {
    resetForm();
    if (seed) {
      type = seed.type || 'out';
      group = seed.group || null;
      sub = seed.sub || null;
      $$('#txType .seg-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.t === type); });
      renderGroupSelect();
      renderSubSelect();
    }
    el.txPage.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    TG.haptic('select');
  }

  function openEdit(id) {
    var t = Tx.get(id);
    if (!t) return;
    resetForm();
    editingId = id;
    type = t.type;
    group = t.group;
    sub = t.sub;
    amountStr = String(t.amount);
    accountId = Accounts.get(t.account_id) ? t.account_id : accountId;
    el.txDate.value = t.transaction_date;
    el.dateLabel.textContent = S.dayLabel(t.transaction_date);
    el.note.value = t.note || '';
    el.pageTitle.textContent = 'Edit Transaksi';
    $$('#txType .seg-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.t === type); });
    renderTxAccounts();
    renderGroupSelect();
    renderSubSelect();
    paintAmount();
    el.txPage.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    TG.haptic('select');
  }

  function closeTxPage() {
    el.txPage.classList.add('hidden');
    document.body.style.overflow = '';
    resetForm();
  }

  function submit() {
    if (saving) return;
    clearErr();
    var form = {
      type: type, group: group, sub: sub,
      amount: amountStr, date: el.txDate.value,
      note: (el.note.value || '').trim(),
      account_id: accountId
    };
    var v = S.validateTx(form);
    if (!v.ok) { showErr(v.msg); TG.haptic('warning'); return; }

    saving = true;
    el.okBtn.disabled = true;

    setTimeout(function () {
      var res;
      if (editingId) {
        res = Tx.update(editingId, {
          type: form.type, group: form.group, sub: form.sub,
          amount: Number(form.amount), date: form.date, note: form.note,
          account_id: form.account_id
        });
        if (!res.ok) {
          saving = false; el.okBtn.disabled = false; showErr(res.msg); return;
        }
      } else {
        res = Tx.create({
          type: form.type, group: form.group, sub: form.sub,
          amount: Number(form.amount), date: form.date, note: form.note,
          account_id: form.account_id
        }, idemKey);
      }
      saving = false;
      el.okBtn.disabled = false;
      toast(res.duplicate ? 'Transaksi sudah tersimpan'
        : (type === 'in' ? 'Pemasukan ' : 'Pengeluaran ') + money(form.amount) + ' tersimpan');
      TG.haptic('success');
      closeTxPage();
      render();
      // Kirim ke server bot (kalau terkonfigurasi & online)
      if (w.Sync) w.Sync.push().then(function () {});
    }, 200);
  }

  /* =========================================================
     SCAN STRUK — foto struk -> isi otomatis
     ========================================================= */
  var scanData = null;   // hasil scan terakhir {amount,date,merchant,category,dataUrl,ocrOk}
  var scanning = false;

  function resetScan() {
    scanData = null;
    if (el.scanStatus) el.scanStatus.classList.add('hidden');
    if (el.scanResult) el.scanResult.classList.add('hidden');
    if (el.btnScan) el.btnScan.disabled = false;
    if (el.scanHint) el.scanHint.textContent = 'Foto struk -> nominal & kategori otomatis';
    if (el.scanFile) el.scanFile.value = '';
  }

  function scanMsg(stage, pct) {
    if (!el.scanStatus) return;
    el.scanStatus.classList.remove('hidden');
    var label = stage === 'mengenali teks'
      ? 'Mengenali teks struk… ' + Math.round((pct || 0) * 100) + '%'
      : 'Menyiapkan foto…';
    el.scanStatusText.textContent = label;
  }

  function doScan(file) {
    if (!file || scanning) return;
    if (!w.Scan) { toast('Modul scan belum siap'); return; }
    scanning = true;
    if (el.btnScan) el.btnScan.disabled = true;
    if (el.scanResult) el.scanResult.classList.add('hidden');
    scanMsg('membaca', 0.05);

    w.Scan.scanReceipt(file, scanMsg)
      .then(function (r) {
        scanning = false;
        if (el.btnScan) el.btnScan.disabled = false;
        scanData = r;

        var bits = [];
        // Nominal
        if (r.amount) {
          amountStr = String(r.amount);
          paintAmount();
          bits.push('nominal ' + money(r.amount));
        }
        // Tanggal (hanya bila valid & tidak masa depan)
        if (r.date && r.date <= S.todayStr() && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
          el.txDate.value = r.date;
          el.dateLabel.textContent = S.dayLabel(r.date);
          bits.push('tanggal ' + r.date);
        }
        // Kategori saran
        if (r.category && Groups.of(r.category.type, r.category.group)) {
          if (type !== r.category.type) {
            type = r.category.type;
            $$('#txType .seg-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.t === type); });
            paintAmount();
          }
          group = r.category.group; sub = r.category.sub || null;
          renderGroupSelect(); renderSubSelect();
          bits.push('kategori ' + group + (sub ? ' · ' + sub : ''));
        }
        // Keterangan
        var ket = r.merchant || '';
        if (ket) { el.note.value = ket.slice(0, 200); bits.push('keterangan "' + ket + '"'); }

        if (!r.ocrOk) {
          el.scanHint.textContent = 'Foto tersimpan, teks tidak terbaca. Isi nominal manual.';
          bits.push('teks tidak terbaca');
        } else {
          el.scanHint.textContent = r.amount ? 'Struk terbaca ✓ periksa nominalnya' : 'Struk terbaca, nominal tidak ditemukan';
        }

        // Ringkasan
        if (el.scanResult) {
          el.scanResult.classList.remove('hidden');
          el.scanSummary.textContent = bits.length
            ? 'Terisi otomatis: ' + bits.join(' · ') + '. Periksa lalu tekan ✓ untuk menyimpan.'
            : 'Struk terbaca tetapi nominal/kategori tidak dikenali. Isi manual.';
        }
        TG.haptic('success');
        toast(r.amount ? 'Struk terbaca: ' + money(r.amount) : 'Struk terbaca, lengkapi manual');
      })
      .catch(function (e) {
        scanning = false;
        if (el.btnScan) el.btnScan.disabled = false;
        el.scanHint.textContent = 'Gagal memproses foto';
        toast('Scan gagal: ' + (e && e.message ? e.message : 'tidak diketahui'));
      });
  }

  /* =========================================================
     DETAIL + HAPUS + UNDO
     ========================================================= */
  function openDetail(id) {
    var t = Tx.get(id);
    if (!t) return;
    var ini = t.type === 'in';
    var acc = accOf(t);
    var g = Groups.of(t.type, t.group);
    el.dBody.innerHTML =
      '<div style="text-align:center;padding:6px 0 14px">' +
        '<div style="font-size:40px">' + esc(iconOfTx(t)) + '</div>' +
        '<div class="' + (ini ? 'amt-in' : 'amt-out') + '" style="font-size:26px;font-weight:700;margin-top:6px">' +
        signedMoney(t) + '</div>' +
        '<div class="muted" style="font-size:13px;margin-top:2px">' +
        esc(labelOf(t)) + (t.sub ? ' · ' + esc(t.group) : '') + '</div>' +
      '</div>' +
      '<div class="result card" style="box-shadow:none;background:var(--bg)">' +
        '<div class="r-row"><span>Jenis</span><b>' + (ini ? '+ Pemasukan' : '− Pengeluaran') + '</b></div>' +
        '<div class="r-row"><span>Kategori</span><b>' + esc(t.group) + '</b></div>' +
        (t.sub ? '<div class="r-row"><span>Subkategori</span><b>' + esc(t.sub) + '</b></div>' : '') +
        '<div class="r-row"><span>Akun</span><b>' + (acc ? esc(acc.icon + ' ' + acc.name) : '—') + '</b></div>' +
        '<div class="r-row"><span>Tanggal</span><b>' + esc(S.dayLabel(t.transaction_date)) + '</b></div>' +
        (t.note ? '<div class="r-row"><span>Catatan</span><b>' + esc(t.note) + '</b></div>' : '') +
      '</div>' +
      '<div class="row-2">' +
        '<button class="btn" data-edit="' + esc(t.id) + '">Edit</button>' +
        '<button class="btn danger ghost" data-del="' + esc(t.id) + '">Hapus</button>' +
      '</div>';
    el.dSheet.classList.remove('hidden');
    TG.haptic('select');
  }
  function closeDetail() { el.dSheet.classList.add('hidden'); }

  function askDelete(id) {
    var t = Tx.get(id);
    if (!t) return;
    TG.confirm('Hapus transaksi ' + labelOf(t) + ' ' + money(t.amount) + '?', function (ok) {
      if (!ok) return;
      Tx.remove(id);
      closeDetail();
      render();
      TG.haptic('success');
      showUndo(id);
    });
  }

  function showUndo(id) {
    undoId = id;
    el.undoBar.classList.remove('hidden');
    clearTimeout(undoTimer);
    undoTimer = setTimeout(hideUndo, 8000);
  }
  function hideUndo() {
    clearTimeout(undoTimer);
    el.undoBar.classList.add('hidden');
    undoId = null;
  }
  function doUndo() {
    if (!undoId) return;
    Tx.restore(undoId);
    hideUndo();
    render();
    TG.haptic('success');
    toast('Transaksi dipulihkan');
  }

  /* =========================================================
     EKSPOR CSV
     ========================================================= */
  function exportCSV() {
    var csv = Tx.toCSV(filter);
    var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'cashflow-' + S.todayStr() + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    TG.haptic('success');
    toast('CSV diunduh');
  }

  /* Impor CSV dari format Ekspor CSV sebelumnya. */
  function importCSV() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'text/csv';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.onchange = function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) { if (input.parentNode) input.parentNode.removeChild(input); return; }
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var rows = String(reader.result || '').trim().split(/\r?\n/);
          var parsed = [];
          rows.forEach(function (line) {
            if (!line.trim()) return;
            var f = [], cur = '', inq = false;
            for (var i = 0; i < line.length; i++) {
              var ch = line.charAt(i);
              if (ch === '"') { inq = !inq; }
              else if (ch === ';' && !inq) { f.push(cur); cur = ''; }
              else { cur += ch; }
            }
            f.push(cur);
            for (var k = 0; k < f.length; k++) f[k] = f[k].trim();
            if (/tanggal/i.test(f[0] || '')) return; // header
            parsed.push(f);
          });
          var added = 0;
          parsed.forEach(function (r) {
            var tgl = (r[0] || '').trim();
            var jenis = (r[1] || '').trim().toLowerCase();
            var group = (r[2] || '').trim() || 'Lainnya';
            var sub = (r[3] || '').trim();
            var amount = Math.abs(parseInt(String(r[4] || '').replace(/[^0-9]/g, ''), 10) || 0);
            var akun = (r[5] || '').trim();
            var note = (r[6] || '').trim();
            if (!(amount > 0)) return;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(tgl)) tgl = S.todayStr();
            var accId = null;
            (S.Accounts.all() || []).forEach(function (a) {
              if (!accId && a && a.name === akun) accId = a.id;
            });
            if (!accId && S.Accounts.all && S.Accounts.all().length) accId = S.Accounts.all()[0].id;
            if (!accId) accId = 'acc-cash';
            S.Tx.create({
              account_id: accId,
              type: (/pemasuk|income|^in$/.test(jenis)) ? 'in' : 'out',
              group: group,
              sub: sub || null,
              amount: amount,
              date: tgl,
              note: note
            }, 'csv-import-' + Date.now() + '-' + added);
            added++;
          });
          render();
          TG.haptic('success');
          App.toast('Impor CSV: ' + added + ' transaksi masuk');
        } catch (err) {
          App.toast('Gagal impor CSV: ' + ((err && err.message) ? err.message : err));
        }
      };
      reader.readAsText(file, 'UTF-8');
    };
    input.onchange = input.onchange;
    input.click();
    setTimeout(function () { if (input.parentNode) input.parentNode.removeChild(input); }, 5000);
  }

  /* =========================================================
     INIT
     ========================================================= */
  var _inited = false;
  function init() {
    if (_inited) return;
    _inited = true;

    el.hBalance = $('#hBalance'); el.hIn = $('#hIn'); el.hOut = $('#hOut');
    el.hAccounts = $('#hAccounts'); el.hQuick = $('#hQuick'); el.hRecent = $('#hRecent');
    el.fQ = $('#fQ'); el.fType = $('#fType'); el.fGroup = $('#fGroup');
    el.fFrom = $('#fFrom'); el.fTo = $('#fTo'); el.hList = $('#hList');
    el.rLabel = $('#rLabel'); el.rCount = $('#rCount');
    el.rIn = $('#rIn'); el.rOut = $('#rOut'); el.rNet = $('#rNet');
    el.rCats = $('#rCats'); el.rDonut = $('#rDonut');

    el.txPage = $('#txPage');
    el.disp = $('#txAmountDisplay'); el.hint = $('#txAmountHint');
    el.txAccounts = $('#txAccounts');
    el.selGroup = $('#txGroup'); el.selSub = $('#txSub'); el.subField = $('#txSubField');
    el.txDate = $('#txDate'); el.dateLabel = $('#txDateLabel');
    el.note = $('#txNote');
    el.err = $('#txErr'); el.pageTitle = $('#txPageTitle'); el.okBtn = $('#txKeypad [data-k=ok]');
    el.btnScan = $('#btnScan'); el.scanFile = $('#scanFile');
    el.scanStatus = $('#scanStatus'); el.scanStatusText = $('#scanStatusText');
    el.scanResult = $('#scanResult'); el.scanSummary = $('#scanSummary');
    el.scanClose = $('#scanClose'); el.scanHint = $('#scanHint');

    el.dSheet = $('#txDetail'); el.dBody = $('#txDetailBody');
    el.undoBar = $('#undoBar'); el.undoBtn = $('#undoBtn');

    /* --- FAB --- */
    $$('[data-fab]').forEach(function (b) {
      b.addEventListener('click', function () { openAdd(); });
    });

    /* --- Pool dari bot (Beranda) --- */
    var poolList = $('#poolList');
    if (poolList) {
      poolList.addEventListener('click', function (e) {
        var save = e.target.closest('[data-psave]');
        if (save) { acceptPoolItem(save.dataset.psave, save); return; }
        var del = e.target.closest('[data-pdel]');
        if (del) { rejectPoolItem(del.dataset.pdel, del); return; }
      });
    }

    /* --- Akun di Beranda --- */
    if (el.hAccounts) {
      el.hAccounts.addEventListener('click', function (e) {
        if (e.target.closest('[data-accadd]')) { if (w.App && w.App.openAccountSheet) w.App.openAccountSheet(); return; }
        if (e.target.closest('[data-nbank]')) {
          if (w.App && w.App.go) w.App.go('bank');
          else openBankSheet();
          return;
        }
        var b = e.target.closest('[data-acc]');
        if (b) {
          var aId = b.dataset.acc;
          var acc = Accounts.get(aId);
          var isTunai = (aId === 'acc-cash') ||
            (acc && (acc.type === 'cash' || (acc.name && acc.name.toLowerCase().indexOf('tunai') !== -1)));
          if (isTunai) {
            if (w.App && w.App.go) w.App.go('recap');
            return;
          }
          openAdd({ }); accountId = aId; renderTxAccounts();
        }
      });
    }

    /* --- Quick pick (jika elemen tersedia di halaman) --- */
    if (el.hQuick) {
      el.hQuick.addEventListener('click', function (e) {
        var b = e.target.closest('[data-qt]');
        if (!b) return;
        openAdd({ type: b.dataset.qt, group: b.dataset.qg, sub: b.dataset.qs || null });
      });
    }

    /* --- Jenis --- */
    $('#txType').addEventListener('click', function (e) {
      var b = e.target.closest('.seg-btn');
      if (b) setType(b.dataset.t);
    });

    /* --- Kategori: dropdown kelompok + subkategori --- */
    el.selGroup.addEventListener('change', function () {
      selectCat(this.value || null, null);
    });
    el.selSub.addEventListener('change', function () {
      selectCat(group, this.value || null);
    });

    /* --- Scan struk --- */
    el.btnScan.addEventListener('click', function () { el.scanFile.click(); });
    el.scanFile.addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (f) doScan(f);
    });
    if (el.scanClose) {
      el.scanClose.addEventListener('click', function () {
        if (el.scanResult) el.scanResult.classList.add('hidden');
        el.scanHint.textContent = 'Foto struk -> nominal & kategori otomatis';
      });
    }

    /* --- Akun di halaman input --- */
    el.txAccounts.addEventListener('click', function (e) {
      var b = e.target.closest('[data-account]');
      if (!b) return;
      accountId = b.dataset.account;
      renderTxAccounts();
      TG.haptic('select');
    });

    /* --- Tanggal --- */
    var dateBtn = $('#txDateBtn');
    dateBtn.addEventListener('click', function () {
      if (typeof el.txDate.showPicker === 'function') {
        try { el.txDate.showPicker(); return; } catch (e) {}
      }
      el.txDate.click();
    });
    el.txDate.addEventListener('change', function () {
      if (this.value) el.dateLabel.textContent = S.dayLabel(this.value);
      clearErr();
    });

    /* --- Keypad --- */
    $('#txKeypad').addEventListener('click', function (e) {
      var b = e.target.closest('[data-k]');
      if (b) press(b.dataset.k);
    });

    /* --- Tutup --- */
    $('#txClose').addEventListener('click', closeTxPage);

    /* --- Detail --- */
    el.dSheet.addEventListener('click', function (e) {
      if (e.target.closest('[data-dclose]')) { closeDetail(); return; }
      var ed = e.target.closest('[data-edit]');
      if (ed) { closeDetail(); openEdit(ed.dataset.edit); return; }
      var dl = e.target.closest('[data-del]');
      if (dl) askDelete(dl.dataset.del);
    });
    el.undoBtn.addEventListener('click', doUndo);

    /* --- Buka detail dari daftar & Accordion toggle --- */
    function bindOpen(c) {
      if (!c) return;
      c.addEventListener('click', function (e) {
        var dayToggle = e.target.closest('[data-day-toggle]');
        if (dayToggle) {
          var d = dayToggle.dataset.dayToggle;
          var group = dayToggle.closest('.day-group');
          if (group) {
            var itemsEl = group.querySelector('.day-items');
            var nowOpen = !group.classList.contains('open');
            openDays[d] = nowOpen;
            group.classList.toggle('open', nowOpen);
            if (itemsEl) {
              itemsEl.style.display = nowOpen ? 'block' : 'none';
            }
            TG.haptic('selection');
          }
          return;
        }
        var b = e.target.closest('[data-open]');
        if (b) openDetail(b.dataset.open);
      });
    }
    if (el.hRecent) bindOpen(el.hRecent);
    if (el.hList) bindOpen(el.hList);

    /* --- Filter riwayat (jika elemen filter ada) --- */
    if (el.fQ) {
      var deb = null;
      el.fQ.addEventListener('input', function () {
        clearTimeout(deb);
        var v = this.value;
        deb = setTimeout(function () { filter.q = v.trim(); renderHistory(); }, 180);
      });
    }
    if (el.fType) el.fType.addEventListener('change', function () { filter.type = this.value; renderHistory(); });
    if (el.fGroup) el.fGroup.addEventListener('change', function () { filter.group = this.value; renderHistory(); });
    if (el.fFrom) el.fFrom.addEventListener('change', function () { filter.from = this.value; renderHistory(); });
    if (el.fTo) el.fTo.addEventListener('change', function () { filter.to = this.value; renderHistory(); });
    var clearBtn = $('#fClear');
    if (clearBtn) clearBtn.addEventListener('click', function () {
      if (el.fQ) el.fQ.value = '';
      if (el.fType) el.fType.value = 'all';
      if (el.fGroup) el.fGroup.value = '';
      if (el.fFrom) el.fFrom.value = '';
      if (el.fTo) el.fTo.value = '';
      filter.q = ''; filter.type = 'all'; filter.group = '';
      filter.from = recapYM + '-01'; filter.to = recapYM + '-31';
      renderHistory();
    });
    var expBtn = $('#btnExportCsv');
    if (expBtn) expBtn.addEventListener('click', exportCSV);

    /* --- Rekap Month Switcher & History Sync --- */
    var rPrevBtn = $('#rPrev');
    if (rPrevBtn) rPrevBtn.addEventListener('click', function () {
      recapYM = S.shiftMonth(recapYM, -1);
      filter.from = recapYM + '-01'; filter.to = recapYM + '-31';
      renderRecap(); renderHistory(); TG.haptic('select');
    });
    var rNextBtn = $('#rNext');
    if (rNextBtn) rNextBtn.addEventListener('click', function () {
      recapYM = S.shiftMonth(recapYM, 1);
      filter.from = recapYM + '-01'; filter.to = recapYM + '-31';
      renderRecap(); renderHistory(); TG.haptic('select');
    });

    /* --- Aksi di Tab Kas --- */
    var btnOut = $('#vbBtnOutBon');
    if (btnOut) btnOut.addEventListener('click', sheetOutBon);
    var btnOutSDH = $('#vbBtnOutSDH');
    if (btnOutSDH) btnOutSDH.addEventListener('click', sheetOutSDH);
    var btnInit = $('#vbBtnInitial');
    if (btnInit) btnInit.addEventListener('click', function () {
      if (!w.NavaBank) return;
      sheetInitial(w.NavaBank.get().initial);
    });
    document.addEventListener('click', function (e) {
      if (e.target.closest('#vbBtnSetorWajibAuto')) {
        if (!w.NavaBank) return;
        var ym = S.ymOf(S.todayStr());
        var due = w.NavaBank.wajibSetoranBulanan(Tx.active(), ym);
        w.NavaBank.tambahSetoranWajib(due, ym);
        if (w.App && w.App.toast) w.App.toast('Setoran kas wajib tersimpan');
        render();
      }
    });

    resetForm();
    render();
  }

  w.TxUI = {
    init: init, render: render, money: money,
    exportCSV: exportCSV, importCSV: importCSV,
    openAdd: openAdd, openEdit: openEdit, openDetail: openDetail,
    closeTxPage: closeTxPage, closeDetail: closeDetail,
    press: press, paintAmount: paintAmount,
    selectCat: selectCat, renderGroupSelect: renderGroupSelect, renderSubSelect: renderSubSelect,
    doScan: doScan, resetScan: resetScan
  };
})(window);
