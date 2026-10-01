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
  var filter = { type: 'all', group: '', from: '', to: '', q: '' };
  var recapYM = S.ymOf(S.todayStr());

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
    bal.textContent = money(s.net);
    bal.classList.toggle('pos', s.net > 0);
    bal.classList.toggle('neg', s.net < 0);
    $('#hIn').textContent = money(s.in);
    $('#hOut').textContent = money(s.out);

    // Kartu akun + saldo
    var accs = Accounts.active();
    var cards = accs.map(function (a) {
      var b = Accounts.balance(a.id);
      return '<button class="acc-card" data-acc="' + esc(a.id) + '">' +
        '<span class="acc-card-top"><span class="acc-ico">' + esc(a.icon) + '</span>' +
        '<span class="acc-name">' + esc(a.name) + '</span></span>' +
        '<span class="acc-bal ' + (b > 0 ? 'pos' : b < 0 ? 'neg' : '') + '">' + money(b) + '</span>' +
        '</button>';
    }).join('');

    // Kartu Dana Bank berdiri tepat di sebelah kartu "Tunai"/"Rekening Saya".
    // Dipindah dari modul Mas Cim ke sini karena Dana Bank adalah alat
    // keuangan Project Nava, bukan alat servis HP.
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
          '<span class="nb-sub">' + (due > 0
            ? (doneWajib ? 'Setoran wajib ' + money(due) + ' tersimpan' : 'Wajib setor ' + money(due) + ' · ' + pct + '%')
            : 'Belum ada setoran wajib') + '</span>' +
        '</button>';
    }

    $('#hAccounts').innerHTML = bankCard + cards +
      '<button class="acc-card in-add" data-accadd>＋ Tambah akun</button>';

    // Pencatatan cepat: subkategori yang paling sering dipakai
    var recent = Tx.frequent('out', 6).concat(Tx.frequent('in', 3));
    $('#hQuick').innerHTML = recent.length
      ? recent.map(function (r) {
          var g = Groups.of(r.type, r.group);
          var ic = g ? Groups.iconOf(g, r.sub) : '💰';
          return '<button class="chip" data-qt="' + esc(r.type) + '" data-qg="' + esc(r.group) +
            '" data-qs="' + esc(r.sub || '') + '">' + ic + ' ' +
            esc(r.sub || r.group) + '</button>';
        }).join('')
      : '<span class="muted xs">Kategori yang sering dipakai akan muncul di sini.</span>';

    var last = Tx.active().slice(0, 6);
    $('#hRecent').innerHTML = last.length
      ? last.map(txRow).join('')
      : '<div class="empty"><b>Belum ada transaksi</b>Tekan tombol Tambah untuk mencatat yang pertama.</div>';
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
        '<button class="btn ghost" data-bk="setor">Setor</button>' +
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
        else if (k === 'setor') { sheetSetor(due, done, ym); }
        else if (k === 'initial') { sheetInitial(g.initial); }
      });
    });
  }

  function sheetInitial(cur) {
    bankSheet('Atur Saldo Awal Dana Bank',
      '<label class="field"><span class="lbl">Saldo awal (Rp)</span>' +
      '<input type="number" id="nbInit" inputmode="numeric" value="' + (cur || 0) + '"></label>' +
      '<p class="muted xs" style="margin-top:6px">Salda awal ditambahkan ke Dana Bank. ' +
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
          if (w.App && w.App.toast) w.App.toast('Saldo awal tersimpan');
          render();
        });
        body.appendChild(b);
      });
  }

  function sheetOutBon() {
    bankSheet('Out / Bon Dana Bank',
      '<p class="nb-hint">Out untuk pengeluaran biasa, Bon untuk bon/utang. ' +
      'Keduanya memakai Dana Bank.</p>' +
      '<div class="row-2" id="nbKind">' +
        '<button class="chip on" data-kind="Out">Out</button>' +
        '<button class="chip" data-kind="Bon">Bon</button></div>' +
      '<label class="field"><span class="lbl">Keterangan *</span>' +
      '<input type="text" id="nbDesc" placeholder="Contoh: Bensin antar / Bon bensin"></label>' +
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
            w.NavaBank.add({ description: kind + ' — ' + desc, moneyIn: 0, moneyOut: amt,
              date: body.querySelector('#nbDate').value || S.todayStr() });
            w.App.closeSheet();
            if (w.App.toast) w.App.toast(kind + ' tersimpan');
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
      'Setiap bulan 10% pemasukan wajib disetor otomatis.</p>' +
      '<label class="field"><span class="lbl">Keterangan</span>' +
      '<input type="text" id="nbSDesc" value="Setoran"></label>' +
      '<label class="field"><span class="lbl">Nominal (Rp)</span>' +
      '<input type="number" id="nbSAmt" inputmode="numeric" value="' + (due > 0 ? due : '') + '" ' +
      'placeholder="0"></label>' +
      (due > 0 && !done
        ? '<button class="btn ghost block" data-bkw style="margin-top:4px">' +
          'Setorankan wajib ' + money(due) + ' (10%)</button>'
        : ''),
      function (body) {
        body.addEventListener('click', function (e) {
          if (e.target.closest('[data-bkw]')) {
            w.NavaBank.tambahSetoranWajib(due, ym);
            w.App.closeSheet();
            if (w.App.toast) w.App.toast('Setoran kas wajib tersimpan');
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
            w.NavaBank.add({ description: desc, moneyIn: amt, moneyOut: 0, date: S.todayStr() });
            w.App.closeSheet();
            if (w.App.toast) w.App.toast('Setoran tersimpan');
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
      el.hList.innerHTML = '<div class="empty"><b>Tidak ada transaksi</b>Coba ubah filter atau catat transaksi baru.</div>';
      return;
    }
    var byDay = Tx.byDay(list);
    var dates = Object.keys(byDay).sort().reverse();
    el.hList.innerHTML = dates.map(function (d) {
      var items = byDay[d], rin = 0, rout = 0;
      items.forEach(function (t) { if (t.type === 'in') rin += t.amount; else rout += t.amount; });
      return '<div class="day-group">' +
        '<div class="day-head"><span>' + esc(S.dayLabel(d)) + '</span>' +
        '<span>' + (rin ? '<b style="color:var(--success)">+' + money(rin) + '</b> ' : '') +
        (rout ? '<b style="color:var(--danger)">−' + money(rout) + '</b>' : '') + '</span></div>' +
        items.map(txRow).join('') + '</div>';
    }).join('');
  }

  /* =========================================================
     REKAP
     ========================================================= */
  function renderRecap() {
    var s = Tx.summary({ from: recapYM + '-01', to: recapYM + '-31' });
    $('#rLabel').textContent = S.monthLabel(recapYM);
    $('#rCount').textContent = s.count + ' transaksi';
    $('#rIn').textContent = money(s.in);
    $('#rOut').textContent = money(s.out);
    var net = $('#rNet');
    net.textContent = money(s.net);
    net.style.color = s.net >= 0 ? 'var(--success)' : 'var(--danger)';

    // Donut komposisi pengeluaran
    var outs = s.categories.filter(function (c) { return c.type === 'out'; });
    var totalOut = outs.reduce(function (a, c) { return a + c.total; }, 0);
    if (!outs.length || !totalOut) {
      $('#rDonut').innerHTML = '<div class="donut-empty">Belum ada<br>pengeluaran</div>';
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
      $('#rDonut').innerHTML =
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
    $('#rCats').innerHTML = s.categories.length
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

  function render() { renderHome(); renderGroupFilter(); renderHistory(); renderRecap(); }

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
    el.hAccounts.addEventListener('click', function (e) {
      if (e.target.closest('[data-accadd]')) { if (w.App && w.App.openAccountSheet) w.App.openAccountSheet(); return; }
      if (e.target.closest('[data-nbank]')) { openBankSheet(); return; }
      var b = e.target.closest('[data-acc]');
      if (b) { openAdd({ }); accountId = b.dataset.acc; renderTxAccounts(); }
    });

    /* --- Quick pick --- */
    el.hQuick.addEventListener('click', function (e) {
      var b = e.target.closest('[data-qt]');
      if (!b) return;
      openAdd({ type: b.dataset.qt, group: b.dataset.qg, sub: b.dataset.qs || null });
    });

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

    /* --- Buka detail dari daftar --- */
    function bindOpen(c) {
      c.addEventListener('click', function (e) {
        var b = e.target.closest('[data-open]');
        if (b) openDetail(b.dataset.open);
      });
    }
    bindOpen(el.hRecent);
    bindOpen(el.hList);

    /* --- Filter riwayat --- */
    var deb = null;
    el.fQ.addEventListener('input', function () {
      clearTimeout(deb);
      var v = this.value;
      deb = setTimeout(function () { filter.q = v.trim(); renderHistory(); }, 180);
    });
    el.fType.addEventListener('change', function () { filter.type = this.value; renderHistory(); });
    el.fGroup.addEventListener('change', function () { filter.group = this.value; renderHistory(); });
    el.fFrom.addEventListener('change', function () { filter.from = this.value; renderHistory(); });
    el.fTo.addEventListener('change', function () { filter.to = this.value; renderHistory(); });
    $('#fClear').addEventListener('click', function () {
      filter = { type: 'all', group: '', from: '', to: '', q: '' };
      el.fQ.value = ''; el.fType.value = 'all'; el.fGroup.value = '';
      el.fFrom.value = ''; el.fTo.value = '';
      renderHistory();
    });
    $('#btnExportCsv').addEventListener('click', exportCSV);

    /* --- Rekap --- */
    $('#rPrev').addEventListener('click', function () {
      recapYM = S.shiftMonth(recapYM, -1); renderRecap(); TG.haptic('select');
    });
    $('#rNext').addEventListener('click', function () {
      recapYM = S.shiftMonth(recapYM, 1); renderRecap(); TG.haptic('select');
    });

    resetForm();
    render();
  }

  w.TxUI = {
    init: init, render: render, money: money,
    openAdd: openAdd, openEdit: openEdit, openDetail: openDetail,
    closeTxPage: closeTxPage, closeDetail: closeDetail,
    press: press, paintAmount: paintAmount,
    selectCat: selectCat, renderGroupSelect: renderGroupSelect, renderSubSelect: renderSubSelect,
    doScan: doScan, resetScan: resetScan
  };
})(window);
