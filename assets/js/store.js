/* =========================================================
   store.js — Penyimpanan lokal (Project Nava)
   - Data ringan (transaksi, catatan, template, pengaturan) => localStorage
   - Rekaman suara (Blob)                                     => IndexedDB

   Model transaksi mengikuti PRD Cashflow Mini App MVP 1.0:
   - Kategori tetap (Pemasukan / Pengeluaran -> Kelompok -> Subkategori)
   - Soft delete (deleted_at) + pemulihan (Undo)
   - Idempotency key mencegah simpan ganda
   - Tanggal disimpan sebagai tanggal lokal Asia/Jakarta
   - Tidak menyimpan Chat ID, Thread ID, atau metadata percakapan
   ========================================================= */
(function (w) {
  'use strict';

  var KEY = 'projectnava.v3';
  var OLD_KEYS = ['projectnava.v2', 'tukangku.v1'];
  var uidSeed = Date.now().toString(36);

  function uid() {
    return (uidSeed += Math.random().toString(36).slice(2, 7)).replace('.', '');
  }

  /* ---------------- Tanggal (Asia/Jakarta, UTC+7 tanpa DST) ---------------- */
  var TZ_OFFSET_MIN = 7 * 60; // WIB tidak pernah memakai DST

  function nowJakarta() {
    return new Date(Date.now() + TZ_OFFSET_MIN * 60000);
  }

  function todayStr(d) {
    d = d || nowJakarta();
    var m = String(d.getUTCMonth() + 1).padStart(2, '0');
    var day = String(d.getUTCDate()).padStart(2, '0');
    return d.getUTCFullYear() + '-' + m + '-' + day;
  }

  function nowLocalInput() {
    var d = nowJakarta();
    return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
  }

  function ymOf(dateStr) { return String(dateStr).slice(0, 7); }

  function monthLabel(ym) {
    var d = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1));
    if (isNaN(d)) return ym;
    return d.toLocaleDateString('id-ID', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }

  function dayLabel(dateStr) {
    var today = todayStr();
    if (dateStr === today) return 'Hari ini';
    var y = new Date(nowJakarta().getTime() - 86400000);
    if (dateStr === todayStr(y)) return 'Kemarin';
    var d = new Date(dateStr + 'T00:00:00Z');
    if (isNaN(d)) return dateStr;
    return d.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });
  }

  function shiftMonth(ym, delta) {
    var d = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + delta, 1));
    if (isNaN(d)) return ym;
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
  }

  /* ---------------- Kategori (PRD 3) ---------------- */
  // type: 'in' (Pemasukan) | 'out' (Pengeluaran)
  // isDirect: kelompok tanpa subkategori tetap -> wajib isi keterangan
  var BASE_CATEGORIES = [
    { id: 'in-income-ali',  type: 'in',  group: 'Income Ali',         sort: 1, icon: '💼',
      subs: [{ n: 'Gaji Intika', i: '🏦' }, { n: 'Jastip', i: '🛵' }, { n: 'Service HP', i: '🔧' }] },
    { id: 'in-income-hima', type: 'in',  group: 'Income Hima',        sort: 2, icon: '💇',
      subs: [{ n: 'Riasan', i: '💄' }, { n: 'Roncelia', i: '✨' }] },
    { id: 'in-rejeki',      type: 'in',  group: 'Rejeki Tak Terduga', sort: 3, isDirect: true, icon: '🎁', subs: [] },

    { id: 'out-anak',       type: 'out', group: 'Kebutuhan Anak',    sort: 1, icon: '👶',
      subs: [{ n: 'Daffa', i: '🧒' }, { n: 'Vino', i: '👦' }, { n: 'Theo', i: '🧑' }] },
    { id: 'out-harian',     type: 'out', group: 'Out Harian',        sort: 2, icon: '🛒',
      subs: [{ n: 'Belanja Dapur', i: '🥬' }, { n: 'Out Ali', i: '🍚' }, { n: 'Out Hima', i: '🧴' }] },
    { id: 'out-bulanan',    type: 'out', group: 'Support Bulanan',   sort: 3, icon: '📆',
      subs: [{ n: 'Pajak', i: '🏛️' }, { n: 'Bensin', i: '⛽' }, { n: 'Kesehatan', i: '💊' },
             { n: 'Kuota', i: '📶' }, { n: 'Servis Motor', i: '🏍️' }, { n: 'Token Listrik', i: '⚡' }] },
    { id: 'out-tak-terduga', type: 'out', group: 'Out Tak Terduga',  sort: 4, isDirect: true, icon: '❓', subs: [] }
  ];

  function defaultCategories() {
    return BASE_CATEGORIES.map(function (c) {
      return { id: c.id, type: c.type, group: c.group, sort: c.sort,
               isDirect: !!c.isDirect, icon: c.icon, active: true };
    });
  }

  /* ---------------- Defaults ---------------- */
  function defaults() {
    return {
      version: 3,
      settings: {
        name: 'Ali', rate: 50000, modal: 0,
        noteMax: 200,
        categories: defaultCategories()
      },
      accounts: defaultAccounts(),
      notes: [],      // {id, text, remindAt, repeat, leadMin, done, doneAt, createdAt, audioId, audioMeta}
      txs: [],        // {id, account_id, category_id, type, group, sub, amount, transaction_date, note, created_at, deleted_at, idem_key}
      pool: [],       // transaksi dari chat bot yang menunggu menekan "Simpan" di dashboard
      pendingPush: [],// transaksi lokal yang belum terkirim ke server bot (sinkron)
      templates: []
    };
  }

  /* ---------------- Akun (ikon + saldo) ---------------- */
  // type: 'cash' (tunai) | 'bank' (rekening) | 'card' (kartu) | 'ewallet'
  var BASE_ACCOUNTS = [
    { id: 'acc-cash',  name: 'Tunai',      type: 'cash',   icon: '💵', sort: 1, opening: 0 },
    { id: 'acc-bca',   name: 'Rekening',   type: 'bank',   icon: '🏦', sort: 2, opening: 0 },
    { id: 'acc-card',  name: 'Kartu',      type: 'card',   icon: '💳', sort: 3, opening: 0 }
  ];

  function defaultAccounts() {
    return BASE_ACCOUNTS.map(function (a) { return Object.assign({}, a); });
  }

  /* ---------------- Migrasi dari versi lama (TukangKu v1) ---------------- */
  function migrate(p) {
    if (!p || typeof p !== 'object') return null;
    if (p.version >= 2 && Array.isArray(p.txs)) return p;

    // Versi lama: {settings:{categories:[string]}, txs:[{date,time,type,cat,amount,note}]}
    if (p.txs && p.txs[0] && p.txs[0].cat !== undefined && !p.txs[0].category_id) {
      var d = defaults();
      d.notes = Array.isArray(p.notes) ? p.notes : [];
      d.templates = Array.isArray(p.templates) ? p.templates : [];
      if (p.settings) {
        d.settings.name = p.settings.name || d.settings.name;
        d.settings.rate = p.settings.rate || d.settings.rate;
        d.settings.modal = p.settings.modal || d.settings.modal;
      }
      // Cari kategori paling cocok berdasarkan teks kategori lama
      d.txs = p.txs.map(function (t) {
        return legacyToTx(t);
      });
      return d;
    }
    return p;
  }

  function legacyToTx(t) {
    var type = t.type === 'out' ? 'out' : 'in';
    var catText = String(t.cat || '');
    var found = null;
    var replaced = false;
    BASE_CATEGORIES.forEach(function (g) {
      if (g.type !== type) return;
      g.subs.forEach(function (s) {
        var name = typeof s === 'string' ? s : s.n;
        if (name.toLowerCase() === catText.toLowerCase()) found = { g: g, sub: name };
      });
    });
    var group, sub;
    if (found) { group = found.g.group; sub = found.sub; }
    else {
      // Letakkan sebagai Input langsung pada kelompok pertama yang cocok
      var g0 = BASE_CATEGORIES.filter(function (g) { return g.type === type && g.isDirect; })[0]
        || BASE_CATEGORIES.filter(function (g) { return g.type === type; })[0];
      group = g0 ? g0.group : 'Lainnya';
      sub = null;
    }
    return {
      id: uid(),
      account_id: 'acc-cash',
      category_id: null,
      type: type, group: group, sub: sub,
      amount: Math.round(Number(t.amount) || 0),
      transaction_date: t.date || todayStr(),
      note: catText || (t.note || ''),
      created_at: new Date().toISOString(),
      deleted_at: null,
      idem_key: uid()
    };
  }

  /* ---------------- Load / Save ---------------- */

  /* Salinan pengaman SEKALI TULIS.

     Ini bukan snapshot yang digantikan tiap 30 menit seperti punya backup.js.
     Yang ini disimpan sekali saja, lalu TIDAK PERNAH ditulis ulang. Isinya
     persis data yang tersimpan sebelum kode versi ini menyentuh apa pun,
     apa adanya dan tanpa migrate/normalize.

     Gunanya: kalau suatu saat versi berikutnya merusak data, data aslinya
     masih utuh di sini dan bisa dikembalikan. Karena written-once, salinan
     ini justru tidak bisa ikut rusak oleh perubahan yang akan dilindungi.

     karena hanya ditulis sekali, storage juga tidak bertambah terus.
     Boleh dihapus manual dari panel Cadangkan Sekarang bila sudah tidak
     diperlukan. */
  var SAFETY_KEY = KEY + '.safety';

  function safetySnapshot(raw) {
    try {
      // Sudah ada -> jangan sentuh. Ini yang membuatnya "tidak berubah".
      if (localStorage.getItem(SAFETY_KEY)) return false;
      if (!raw || raw.length < 32) return false;   // belum ada data berarti
      localStorage.setItem(SAFETY_KEY, raw);
      return true;
    } catch (e) {
      return false;   // storage penuh: jangan ganggu proses load
    }
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        safetySnapshot(raw);
        var p = migrate(JSON.parse(raw));
        if (p) return normalize(p);
      }
      // Coba pindahkan data versi lama
      for (var i = 0; i < OLD_KEYS.length; i++) {
        var oldRaw = localStorage.getItem(OLD_KEYS[i]);
        if (oldRaw) {
          safetySnapshot(oldRaw);
          var op = migrate(JSON.parse(oldRaw));
          if (op) return normalize(op);
        }
      }
    } catch (e) {
      console.warn('store: gagal baca, pakai default', e);
    }
    return defaults();
  }

  function normalize(p) {
    var d = defaults();
    var out = {
      version: 3,
      settings: Object.assign({}, d.settings, p.settings || {}),
      accounts: Array.isArray(p.accounts) && p.accounts.length ? p.accounts : defaultAccounts(),
      notes: Array.isArray(p.notes) ? p.notes : [],
      txs: Array.isArray(p.txs) ? p.txs : [],
      pool: Array.isArray(p.pool) ? p.pool : [],
      pendingPush: Array.isArray(p.pendingPush) ? p.pendingPush : [],
      templates: Array.isArray(p.templates) ? p.templates : []
    };
    if (!Array.isArray(out.settings.categories) || !out.settings.categories.length) {
      out.settings.categories = defaultCategories();
    }
    out.settings.noteMax = out.settings.noteMax || 200;

    // Normalisasi akun
    var accIds = {};
    out.accounts = out.accounts.map(function (a, i) {
      var id = a.id || ('acc-' + uid());
      accIds[id] = true;
      return {
        id: id,
        name: a.name || 'Akun ' + (i + 1),
        type: ['cash', 'bank', 'card', 'ewallet'].indexOf(a.type) >= 0 ? a.type : 'cash',
        icon: a.icon || '💰',
        sort: typeof a.sort === 'number' ? a.sort : i + 1,
        opening: Math.round(Number(a.opening) || 0),
        active: a.active !== false
      };
    });

    // Pastikan setiap transaksi punya bentuk lengkap
    out.txs = out.txs.map(function (t) {
      var acc = t.account_id && accIds[t.account_id] ? t.account_id : out.accounts[0].id;
      return {
        id: t.id || uid(),
        account_id: acc,
        category_id: t.category_id || null,
        type: t.type === 'out' ? 'out' : 'in',
        group: t.group || 'Lainnya',
        sub: t.sub || null,
        amount: Math.round(Number(t.amount) || 0),
        transaction_date: t.transaction_date || todayStr(),
        note: t.note || '',
        created_at: t.created_at || new Date().toISOString(),
        deleted_at: t.deleted_at || null,
        idem_key: t.idem_key || uid(),
        source: t.source || 'local'
      };
    });
    return out;
  }

  var state = load();

  var saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try { localStorage.setItem(KEY, JSON.stringify(state)); }
      catch (e) { console.error('store: gagal simpan', e); }
    }, 120);
  }
  function saveNow() {
    clearTimeout(saveTimer);
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }

  /* ---------------- Audio (IndexedDB) ---------------- */
  var DB_NAME = 'projectnava-audio', STORE = 'clips', dbP = null;

  function openDB() {
    if (dbP) return dbP;
    dbP = new Promise(function (res, rej) {
      if (!w.indexedDB) return rej(new Error('IndexedDB tidak tersedia'));
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = function () { res(req.result); };
      req.onerror = function () { rej(req.error); };
    });
    return dbP;
  }

  var AudioDB = {
    put: function (id, blob) {
      return openDB().then(function (db) {
        return new Promise(function (res, rej) {
          var tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put({ id: id, blob: blob });
          tx.oncomplete = function () { res(true); };
          tx.onerror = function () { rej(tx.error); };
        });
      });
    },
    get: function (id) {
      return openDB().then(function (db) {
        return new Promise(function (res, rej) {
          var tx = db.transaction(STORE, 'readonly');
          var r = tx.objectStore(STORE).get(id);
          r.onsuccess = function () { res(r.result ? r.result.blob : null); };
          r.onerror = function () { rej(r.error); };
        });
      });
    },
    del: function (id) {
      return openDB().then(function (db) {
        return new Promise(function (res) {
          var tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).delete(id);
          tx.oncomplete = function () { res(true); };
          tx.onerror = function () { res(false); };
        });
      }).catch(function () { return false; });
    },
    clear: function () {
      return openDB().then(function (db) {
        return new Promise(function (res) {
          var tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).clear();
          tx.oncomplete = function () { res(true); };
          tx.onerror = function () { res(false); };
        });
      }).catch(function () { return false; });
    }
  };

  /* ---------------- Notes (fitur pengingat voice, tetap dipertahankan) ---------------- */
  var Notes = {
    all: function () { return state.notes; },
    add: function (o) {
      var n = Object.assign({
        id: uid(), text: '', remindAt: null, repeat: 'none', leadMin: 5,
        done: false, doneAt: null, createdAt: new Date().toISOString(),
        audioId: null, audioMeta: null
      }, o);
      state.notes.unshift(n); save();
      return n;
    },
    update: function (id, patch) {
      var n = state.notes.filter(function (x) { return x.id === id; })[0];
      if (n) { Object.assign(n, patch); save(); }
      return n;
    },
    remove: function (id) {
      var n = state.notes.filter(function (x) { return x.id === id; })[0];
      state.notes = state.notes.filter(function (x) { return x.id !== id; });
      save();
      if (n && n.audioId) AudioDB.del(n.audioId);
    },
    toggle: function (id) {
      var n = state.notes.filter(function (x) { return x.id === id; })[0];
      if (n) {
        n.done = !n.done;
        n.doneAt = n.done ? new Date().toISOString() : null;
        if (n.done) n.remindAt = null;
        save();
      }
      return n;
    },
    nextOccurrence: function (n, from) {
      if (!n.remindAt || n.repeat === 'none') return null;
      var base = from ? new Date(from) : new Date();
      var d = new Date(n.remindAt);
      if (isNaN(d)) return null;
      if (d > base) return d;
      var step = function (date) {
        switch (n.repeat) {
          case 'daily':    date.setDate(date.getDate() + 1); break;
          case 'weekly':   date.setDate(date.getDate() + 7); break;
          case 'biweekly': date.setDate(date.getDate() + 14); break;
          case 'monthly':  date.setMonth(date.getMonth() + 1); break;
          case 'yearly':   date.setFullYear(date.getFullYear() + 1); break;
          default: return null;
        }
        return date;
      };
      var next = step(new Date(d));
      var guard = 0;
      while (next && next <= base && guard++ < 500) { next = step(next); }
      return next;
    }
  };

  /* ---------------- Transaksi (PRD 8 Model Data + 7 Aturan Bisnis) ---------------- */
  var NOTE_MAX_DEFAULT = 200;

  // Validasi nominal: bilangan bulat rupiah, min 1, tanpa desimal/negatif/huruf
  // Pemisah ribuan Indonesia ("25.000", "1,000,000") diterima, tetapi desimal
  // ("1.5", "12,75") DITOLAK sesuai FR-04.
  function parseAmount(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return { ok: false, msg: 'Nominal belum diisi' };
    if (!/^\d[\d.,]*$/.test(s)) {
      return { ok: false, msg: 'Nominal harus angka bulat rupiah (tanpa huruf, minus, atau desimal)' };
    }
    // Bolehkan hanya sebagai pemisah ribuan: 1-3 digit lalu grup tepat 3 digit
    if (/[.,]/.test(s)) {
      if (!/^\d{1,3}([.,]\d{3})+$/.test(s)) {
        return { ok: false, msg: 'Nominal harus angka bulat rupiah (tanpa huruf, minus, atau desimal)' };
      }
      s = s.replace(/[.,]/g, '');
    }
    if (!/^\d+$/.test(s)) {
      return { ok: false, msg: 'Nominal harus angka bulat rupiah (tanpa huruf, minus, atau desimal)' };
    }
    var n = Number(s);
    if (!isFinite(n) || n <= 0) return { ok: false, msg: 'Nominal minimal Rp1' };
    if (n > 1e15) return { ok: false, msg: 'Nominal terlalu besar' };
    return { ok: true, value: n };
  }

  function validateTx(input) {
    var res = parseAmount(input.amount);
    if (!res.ok) return { ok: false, field: 'amount', msg: res.msg };
    if (!input.type) return { ok: false, field: 'type', msg: 'Pilih jenis transaksi' };
    if (!input.group) return { ok: false, field: 'group', msg: 'Pilih kelompok kategori' };
    var group = Groups.of(input.type, input.group);
    if (!group) return { ok: false, field: 'group', msg: 'Kelompok kategori tidak valid' };
    // Kelompok "Input langsung" mewajibkan keterangan (min 3 karakter)
    if (group.isDirect) {
      var ket = String(input.note || '').trim();
      if (ket.length < 3) {
        return { ok: false, field: 'note', msg: 'Kelompok "' + group.group + '" wajib diisi keterangan (min 3 karakter)' };
      }
    }
    // Subkategori wajib dipilih dan harus milik kelompok ini
    if (!group.isDirect) {
      var subs = Groups.subsOf(group);
      if (!subs.length) {
        // Kelompok tanpa subkategori -> keterangan dipakai sebagai label
        var ket2 = String(input.note || '').trim();
        if (ket2.length < 3) {
          return { ok: false, field: 'note', msg: 'Kelompok "' + group.group + '" belum punya subkategori, isi keterangan (min 3 karakter)' };
        }
      } else if (!input.sub) {
        return { ok: false, field: 'sub', msg: 'Pilih subkategori' };
      } else if (!subs.some(function (s) { return s === input.sub; })) {
        return { ok: false, field: 'sub', msg: 'Subkategori tidak valid untuk kelompok ini' };
      }
    }
    // Tanggal: default hari ini, tanggal masa depan ditolak pada MVP
    var date = String(input.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { ok: false, field: 'date', msg: 'Tanggal tidak valid' };
    }
    if (date > todayStr()) {
      return { ok: false, field: 'date', msg: 'Tanggal masa depan belum didukung' };
    }
    var maxNote = state.settings.noteMax || NOTE_MAX_DEFAULT;
    if (String(input.note || '').length > maxNote) {
      return { ok: false, field: 'note', msg: 'Catatan maksimal ' + maxNote + ' karakter' };
    }
    return { ok: true };
  }

  var Tx = {
    // Hanya transaksi aktif (soft delete tersaring)
    active: function () {
      return state.txs.filter(function (t) { return !t.deleted_at; });
    },
    all: function () { return state.txs; },
    get: function (id) {
      return state.txs.filter(function (x) { return x.id === id; })[0] || null;
    },

    // Simpan idempoten: idem_key yang sama -> tidak membuat duplikat
    create: function (input, idemKey) {
      idemKey = idemKey || uid();
      var dupe = state.txs.filter(function (t) { return t.idem_key === idemKey; })[0];
      if (dupe) return { ok: true, duplicate: true, tx: dupe };
      var group = Groups.of(input.type, input.group);
      var accId = input.account_id && Accounts.get(input.account_id)
        ? input.account_id
        : (Accounts.first() || { id: 'acc-cash' }).id;
      var t = {
        id: uid(),
        account_id: accId,
        category_id: group ? group.id : null,
        type: input.type,
        group: input.group,
        sub: group && !group.isDirect ? input.sub : null,
        amount: Math.round(Number(input.amount)),
        transaction_date: input.date,
        note: String(input.note || '').trim(),
        created_at: new Date().toISOString(),
        deleted_at: null,
        idem_key: idemKey
      };
      state.txs.push(t);
      Tx.queueForPush(t, 'upsert');
      save();
      return { ok: true, duplicate: false, tx: t };
    },

    // Ambil transaksi dari "pool" (dari chat bot) INTO pembukuan
    // memakai id server apa adanya, TANPA antre kirim ulang — karena
    // server sudah memegangnya. Id yang sama mencegah duplikat saat
    // penarikan sinkron berikutnya.
    adopt: function (remote) {
      if (!remote || !remote.id) return { ok: false, msg: 'Data pool tidak valid' };
      var existing = Tx.get(remote.id);
      if (existing) return { ok: true, duplicate: true, tx: existing };
      var accId = remote.account_id && Accounts.get(remote.account_id)
        ? remote.account_id
        : (Accounts.first() || { id: 'acc-cash' }).id;
      var t = {
        id: remote.id,
        account_id: accId,
        category_id: remote.category_id || null,
        type: remote.type === 'in' ? 'in' : 'out',
        group: remote.group || 'Lainnya',
        sub: remote.sub || null,
        amount: Math.round(Number(remote.amount) || 0),
        transaction_date: remote.transaction_date || todayStr(),
        note: remote.note || '',
        created_at: remote.created_at || new Date().toISOString(),
        deleted_at: null,
        idem_key: remote.idem_key || remote.id,
        source: remote.source || 'bot'
      };
      state.txs.push(t);
      // Jangan antre ke push: server sudah punya record ini.
      state.pendingPush = state.pendingPush.filter(function (p) { return p.id !== t.id; });
      save();
      return { ok: true, duplicate: false, tx: t };
    },

    // Edit = pembaruan pada record yang sama (PRD 4)
    update: function (id, input) {
      var t = Tx.get(id);
      if (!t) return { ok: false, msg: 'Transaksi tidak ditemukan' };
      var group = Groups.of(input.type, input.group);
      if (input.account_id && Accounts.get(input.account_id)) t.account_id = input.account_id;
      t.type = input.type;
      t.group = input.group;
      t.sub = group && !group.isDirect ? input.sub : null;
      t.category_id = group ? group.id : null;
      t.amount = Math.round(Number(input.amount));
      t.transaction_date = input.date;
      t.note = String(input.note || '').trim();
      Tx.queueForPush(t, 'upsert');
      save();
      return { ok: true, tx: t };
    },

    // Soft delete (PRD 7)
    remove: function (id) {
      var t = Tx.get(id);
      if (!t) return { ok: false, msg: 'Transaksi tidak ditemukan' };
      t.deleted_at = new Date().toISOString();
      Tx.queueForPush(t, 'delete');
      save();
      return { ok: true, tx: t };
    },

    // Pulihkan (Undo)
    restore: function (id) {
      var t = Tx.get(id);
      if (!t) return { ok: false, msg: 'Transaksi tidak ditemukan' };
      t.deleted_at = null;
      Tx.queueForPush(t, 'upsert');
      save();
      return { ok: true, tx: t };
    },

    // Riwayat dengan filter & pencarian (FR-07)
    query: function (f) {
      f = f || {};
      var list = Tx.active();
      if (f.type && f.type !== 'all') {
        list = list.filter(function (t) { return t.type === f.type; });
      }
      if (f.group) {
        list = list.filter(function (t) { return t.group === f.group; });
      }
      if (f.from) list = list.filter(function (t) { return t.transaction_date >= f.from; });
      if (f.to) list = list.filter(function (t) { return t.transaction_date <= f.to; });
      if (f.q) {
        var q = String(f.q).toLowerCase();
        list = list.filter(function (t) {
          return ((t.group || '') + ' ' + (t.sub || '') + ' ' + (t.note || '')).toLowerCase().indexOf(q) >= 0;
        });
      }
      // Urut dari yang terbaru
      return list.slice().sort(function (a, b) {
        var k = (b.transaction_date + (b.created_at || '')).localeCompare(a.transaction_date + (a.created_at || ''));
        if (k !== 0) return k;
        return String(b.created_at || '').localeCompare(String(a.created_at || ''));
      });
    },

    // Agregasi rekap (FR-06) - hanya transaksi aktif
    summary: function (f) {
      f = f || {};
      var list = Tx.query(f);
      var rin = 0, rout = 0;
      var byCat = {};
      list.forEach(function (t) {
        if (t.type === 'in') rin += t.amount; else rout += t.amount;
        var key = (t.group || 'Lainnya') + '|' + (t.sub || '');
        if (!byCat[key]) byCat[key] = { group: t.group, sub: t.sub, type: t.type, total: 0, count: 0 };
        byCat[key].total += t.amount;
        byCat[key].count += 1;
      });
      var cats = Object.keys(byCat).map(function (k) { return byCat[k]; });
      cats.sort(function (a, b) { return b.total - a.total; });
      return { in: rin, out: rout, net: rin - rout, count: list.length, categories: cats, list: list };
    },

    // Rekap harian untuk rentang tanggal
    byDay: function (list) {
      var m = {};
      (list || Tx.active()).forEach(function (t) {
        (m[t.transaction_date] = m[t.transaction_date] || []).push(t);
      });
      return m;
    },

    // Rekap per akun (untuk kartu-kartu di Beranda)
    byAccount: function (f) {
      f = f || {};
      var list = Tx.query(f);
      var res = {};
      Accounts.active().forEach(function (a) {
        res[a.id] = { in: 0, out: 0, count: 0 };
      });
      list.forEach(function (t) {
        if (!res[t.account_id]) res[t.account_id] = { in: 0, out: 0, count: 0 };
        if (t.type === 'in') res[t.account_id].in += t.amount;
        else res[t.account_id].out += t.amount;
        res[t.account_id].count += 1;
      });
      return res;
    },

    // Subkategori paling sering dipakai (untuk grid cepat)
    frequent: function (type, limit) {
      var freq = {};
      Tx.active().forEach(function (t) {
        if (t.type !== type) return;
        var key = t.group + '|' + (t.sub || '');
        if (!freq[key]) freq[key] = { type: t.type, group: t.group, sub: t.sub, n: 0 };
        freq[key].n += 1;
      });
      return Object.keys(freq)
        .map(function (k) { return freq[k]; })
        .sort(function (a, b) { return b.n - a.n; })
        .slice(0, limit || 6);
    },

    // Ekspor CSV (FR-11) - mengikuti filter
    toCSV: function (f) {
      var list = Tx.query(f);
      var rows = [['Tanggal', 'Jenis', 'Kelompok', 'Subkategori', 'Nominal', 'Akun', 'Catatan']];
      list.slice().reverse().forEach(function (t) {
        var acc = Accounts.get(t.account_id);
        rows.push([
          t.transaction_date,
          t.type === 'in' ? 'Pemasukan' : 'Pengeluaran',
          t.group,
          t.sub || '',
          t.amount,
          acc ? acc.name : '',
          t.note || ''
        ]);
      });
      return rows.map(function (r) {
        return r.map(function (c) {
          var s = String(c == null ? '' : c);
          return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        }).join(';');
      }).join('\n');
    },

    /* ---- Sinkronisasi dengan server bot (revisi) ---- */

    // Gabungkan transaksi dari server (bot) ke store lokal.
    // Transaksi bertanda id "bot_" dibuat oleh bot; kalau sudah ada
    // di lokal, TIDAK diduplikasi (PRD FR-10).
    mergeFromServer: function (remoteTxs) {
      var added = 0, updated = 0;
      (remoteTxs || []).forEach(function (r) {
        if (!r || !r.id) return;
        // Item yang masih di pool belum resmi jadi transaksi. Jangan
        // pernah masuk pembukuan hanya karena penarikan sinkron.
        if (r.pool_state === 'pool') return;
        var existing = state.txs.filter(function (t) { return t.id === r.id; })[0];
        var accId = r.account_id && Accounts.get(r.account_id) ? r.account_id : (Accounts.first() || { id: 'acc-cash' }).id;
        var norm = {
          id: r.id,
          account_id: accId,
          category_id: r.category_id || null,
          type: r.type === 'in' ? 'in' : 'out',
          group: r.group || 'Lainnya',
          sub: r.sub || null,
          amount: Math.round(Number(r.amount) || 0),
          transaction_date: r.transaction_date || todayStr(),
          note: r.note || '',
          created_at: r.created_at || new Date().toISOString(),
          deleted_at: r.deleted_at || null,
          idem_key: r.idem_key || r.id,
          source: r.source || 'bot'
        };
        if (existing) {
          // Jangan timpa perubahan lokal yang belum tersinkron
          var isLocalOnly = !existing.idem_key;
          if (!isLocalOnly) {
            if (JSON.stringify(existing) !== JSON.stringify(norm)) {
              Object.assign(existing, norm);
              updated++;
            }
          }
        } else {
          state.txs.push(norm);
          added++;
        }
      });
      if (added || updated) save();
      return { added: added, updated: updated };
    },

    // Tandai transaksi lokal supaya ikut dikirim ke server.
    // idemKey memastikan tidak ada duplikasi saat dikirim ulang.
    queueForPush: function (tx, op) {
      op = op || 'upsert';
      var found = state.pendingPush.filter(function (p) { return p.id === tx.id; })[0];
      if (found) { found.op = op; found.at = new Date().toISOString(); }
      else state.pendingPush.push({ id: tx.id, op: op, at: new Date().toISOString() });
      save();
    },
    pendingPush: function () { return state.pendingPush.slice(); },
    clearPushed: function (ids) {
      var set = {};
      (ids || []).forEach(function (i) { set[i] = true; });
      state.pendingPush = state.pendingPush.filter(function (p) { return !set[p.id]; });
      save();
    }
  };

  /* ---------------- Pool transaksi dari bot ----------------
     Transaksi yang dicatat lewat chat bot DITAHAN di sini, terpisah
     dari pembukuan cashflow, sampai pengguna menekan tombol "Simpan"
     di dashboard. Dengan begitu, rekap/saldo tidak berubah hanya karena
     ada pesan di chat — baru setelah benar-benar disimpan. */
  var Pool = {
    all: function () { return state.pool.slice(); },
    count: function () { return state.pool.length; },
    get: function (id) {
      return state.pool.filter(function (x) { return x.id === id; })[0] || null;
    },
    has: function (id) { return !!Pool.get(id); },

    // Ganti isi pool dengan daftar terbaru dari server.
    set: function (items) {
      var seen = {};
      state.pool = (items || []).filter(function (r) {
        if (!r || !r.id || seen[r.id]) return false;
        seen[r.id] = true;
        return true;
      }).map(function (r) {
        return {
          id: r.id,
          account_id: r.account_id || 'acc-cash',
          category_id: r.category_id || null,
          type: r.type === 'in' ? 'in' : 'out',
          group: r.group || 'Lainnya',
          sub: r.sub || null,
          amount: Math.round(Number(r.amount) || 0),
          transaction_date: r.transaction_date || todayStr(),
          note: r.note || '',
          created_at: r.created_at || new Date().toISOString(),
          idem_key: r.idem_key || r.id,
          source: r.source || 'bot'
        };
      });
      save();
      return state.pool.length;
    },

    // Terima satu item dari server (tambahan, tanpa menimpa yang ada).
    add: function (r) {
      if (!r || !r.id) return 0;
      if (Pool.has(r.id)) return 0;
      var n = Pool.set(state.pool.concat([r]));
      return n;
    },

    // Buang dari pool setelah disimpan atau ditolak.
    remove: function (id) {
      var before = state.pool.length;
      state.pool = state.pool.filter(function (x) { return x.id !== id; });
      if (state.pool.length !== before) save();
      return before - state.pool.length;
    },

    clear: function () { state.pool = []; save(); }
  };

  /* ---------------- Kelompok / kategori aktif ---------------- */
  // Terima id maupun objek kelompok agar pemanggil tidak mudah salah.
  function resolveGroup(ref) {
    if (!ref) return null;
    if (typeof ref === 'object') return ref;
    return state.settings.categories.filter(function (x) { return x.id === ref; })[0] || null;
  }

  var Groups = {
    all: function () { return state.settings.categories; },
    for: function (type) {
      return state.settings.categories
        .filter(function (g) { return g.type === type && g.active !== false; })
        .sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); });
    },
    of: function (type, groupName) {
      return state.settings.categories.filter(function (g) {
        return g.type === type && g.group === groupName;
      })[0] || null;
    },
    // Subkategori dari daftar default + yang disimpan (agar bisa ditambah).
    // Data internal bisa berupa string (lama) atau {n, i} (baru).
    // Jika sebuah subkategori bawaan di-rename, entri override
    // {n: namaBaru, override: namaLama} menggantikan yang bawaan.
    subsDetail: function (group) {
      if (!group) return [];
      if (group.isDirect) return [];
      var base = BASE_CATEGORIES.filter(function (b) { return b.id === group.id; })[0];
      var custom = (group.subs || []).map(function (s) {
        return typeof s === 'string' ? { n: s, i: '•' } : s;
      });
      // Nama bawaan yang sudah di-rename disembunyikan (digantikan override)
      var overridden = {};
      custom.forEach(function (c) { if (c.override) overridden[c.override] = true; });

      var subs = [];
      if (base) {
        base.subs.forEach(function (s) {
          var name = typeof s === 'string' ? s : s.n;
          if (overridden[name]) return;
          subs.push(typeof s === 'string' ? { n: s, i: '•' } : { n: name, i: s.i, builtin: true });
        });
      }
      custom.forEach(function (c) {
        if (!subs.some(function (x) { return x.n === c.n; })) subs.push(c);
      });
      return subs;
    },
    // Hanya nama subkategori (kompatibilitas)
    subsOf: function (group) {
      return Groups.subsDetail(group).map(function (s) { return s.n; });
    },
    // Ikon subkategori
    iconOf: function (group, subName) {
      var g = group;
      if (!g && subName) return '•';
      var d = Groups.subsDetail(g);
      var hit = d.filter(function (s) { return s.n === subName; })[0];
      if (hit) return hit.i;
      return g && g.icon ? g.icon : '•';
    },
    addGroup: function (type, groupName) {
      groupName = (groupName || '').trim();
      if (!groupName) return false;
      var exists = state.settings.categories.some(function (g) {
        return g.type === type && g.group.toLowerCase() === groupName.toLowerCase();
      });
      if (exists) return false;
      state.settings.categories.push({
        id: uid(), type: type, group: groupName,
        sort: 99, isDirect: false, active: true, subs: []
      });
      save();
      return true;
    },
    addSub: function (groupId, subName) {
      subName = (subName || '').trim();
      if (!subName) return false;
      var g = state.settings.categories.filter(function (x) { return x.id === groupId; })[0];
      if (!g) return false;
      g.subs = g.subs || [];
      if (Groups.subsOf(g).some(function (s) { return s.toLowerCase() === subName.toLowerCase(); })) return false;
      g.subs.push(subName);
      save();
      return true;
    },
    setActive: function (groupId, active) {
      var g = state.settings.categories.filter(function (x) { return x.id === groupId; })[0];
      if (g) { g.active = !!active; save(); }
    },

    /* ---- Edit & hapus (revisi: kelola kategori) ---- */

    // Berapa transaksi AKTIF yang memakai kelompok ini
    groupUsage: function (groupRef) {
      var g = resolveGroup(groupRef);
      if (!g) return 0;
      return state.txs.filter(function (t) {
        return !t.deleted_at && t.type === g.type && t.group === g.group;
      }).length;
    },
    // Berapa transaksi AKTIF yang memakai subkategori ini
    subUsage: function (groupRef, subName) {
      var g = resolveGroup(groupRef);
      if (!g) return 0;
      return state.txs.filter(function (t) {
        return !t.deleted_at && t.type === g.type && t.group === g.group && t.sub === subName;
      }).length;
    },

    // Ubah nama kelompok. Transaksi lama tetap memakai nama LAMA
    // (PRD 3: nama kategori tidak boleh berubah otomatis / riwayat lama utuh).
    renameGroup: function (groupRef, newName) {
      newName = (newName || '').trim();
      var g = resolveGroup(groupRef);
      if (!g) return { ok: false, msg: 'Kelompok tidak ditemukan' };
      var groupId = g.id;
      if (!newName) return { ok: false, msg: 'Nama kategori tidak boleh kosong' };
      if (newName.length > 40) return { ok: false, msg: 'Nama kategori maksimal 40 karakter' };
      var clash = state.settings.categories.some(function (x) {
        return x.id !== groupId && x.type === g.type && x.group.toLowerCase() === newName.toLowerCase();
      });
      if (clash) return { ok: false, msg: 'Kategori "' + newName + '" sudah ada' };
      g.group = newName;
      save();
      return { ok: true, group: g };
    },

    // Ubah nama subkategori (hanya yang tersimpan, bukan bawaan PRD)
    renameSub: function (groupRef, oldName, newName) {
      newName = (newName || '').trim();
      var g = resolveGroup(groupRef);
      if (!g) return { ok: false, msg: 'Kelompok tidak ditemukan' };
      if (!newName) return { ok: false, msg: 'Nama subkategori tidak boleh kosong' };
      if (newName.length > 40) return { ok: false, msg: 'Nama subkategori maksimal 40 karakter' };
      if (Groups.subsOf(g).some(function (s) { return s.toLowerCase() === newName.toLowerCase() && s !== oldName; })) {
        return { ok: false, msg: 'Subkategori "' + newName + '" sudah ada' };
      }
      if (Groups.subIsCustom(g, oldName)) {
        Groups.setSubName(g, oldName, newName);
      } else {
        // Subkategori bawaan PRD -> simpan override nama baru
        g.subs = g.subs || [];
        g.subs.push({ n: newName, i: Groups.iconOf(g, oldName), override: oldName });
      }
      save();
      return { ok: true };
    },

    // Subkategori ini milik pengguna (bukan bawaan PRD)?
    subIsCustom: function (groupRef, subName) {
      var group = resolveGroup(groupRef);
      return ((group && group.subs) || []).some(function (s) {
        return (typeof s === 'string' ? s : s.n) === subName;
      });
    },
    // Terapkan nama baru pada entri subkategori milik pengguna
    setSubName: function (group, oldName, newName) {
      var hit = (group.subs || []).filter(function (s) {
        return (typeof s === 'string' ? s : s.n) === oldName;
      })[0];
      if (hit && typeof hit === 'object') hit.n = newName;
      else if (typeof hit === 'string') group.subs[group.subs.indexOf(hit)] = { n: newName, i: '•' };
    },
    // Hapus subkategori milik pengguna dari daftar
    dropSub: function (group, subName) {
      group.subs = (group.subs || []).filter(function (s) {
        return (typeof s === 'string' ? s : s.n) !== subName;
      });
    },

    // Hapus kategori.
    // Kalau masih dipakai transaksi -> dijadi NONAKTIF saja supaya
    // riwayat lama tetap utuh (PRD 3). Kalau tidak dipakai -> dihapus sungguhan.
    removeGroup: function (groupRef) {
      var g = resolveGroup(groupRef);
      if (!g) return { ok: false, msg: 'Kelompok tidak ditemukan' };
      var groupId = g.id;
      var used = Groups.groupUsage(groupId);
      if (used > 0) {
        g.active = false;
        save();
        return { ok: true, mode: 'deactivated', used: used, group: g };
      }
      state.settings.categories = state.settings.categories.filter(function (x) { return x.id !== groupId; });
      save();
      return { ok: true, mode: 'deleted', used: 0, group: g };
    },

    // Hapus subkategori (dengan aturan yang sama soal transaksi lama)
    removeSub: function (groupRef, subName) {
      var g = resolveGroup(groupRef);
      if (!g) return { ok: false, msg: 'Kelompok tidak ditemukan' };
      if (!Groups.subIsCustom(g, subName)) {
        // Subkategori bawaan PRD -> nonaktifkan kelompoknya, bukan dihapus
        return { ok: false, builtin: true, msg: 'Subkategori bawaan. Nonaktifkan kategorinya kalau tidak dipakai lagi.' };
      }
      var used = Groups.subUsage(g.id, subName);
      if (used > 0) {
        return { ok: true, mode: 'kept', used: used, msg: 'Dipakai ' + used + ' transaksi, subkategori dipertahankan agar riwayat tetap utuh.' };
      }
      Groups.dropSub(g, subName);
      save();
      return { ok: true, mode: 'deleted', used: 0 };
    }
  };

  /* ---------------- Akun ---------------- */
  var Accounts = {
    all: function () {
      return state.accounts.slice().sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); });
    },
    active: function () {
      return Accounts.all().filter(function (a) { return a.active !== false; });
    },
    get: function (id) {
      return state.accounts.filter(function (a) { return a.id === id; })[0] || null;
    },
    first: function () { return Accounts.active()[0] || null; },
    add: function (name, type, icon) {
      name = (name || '').trim();
      if (!name) return { ok: false, msg: 'Nama akun wajib diisi' };
      if (state.accounts.some(function (a) { return a.name.toLowerCase() === name.toLowerCase(); })) {
        return { ok: false, msg: 'Akun "' + name + '" sudah ada' };
      }
      var a = {
        id: 'acc-' + uid(), name: name,
        type: ['cash', 'bank', 'card', 'ewallet'].indexOf(type) >= 0 ? type : 'cash',
        icon: icon || '💰', sort: state.accounts.length + 1, opening: 0, active: true
      };
      state.accounts.push(a);
      save();
      return { ok: true, account: a };
    },
    update: function (id, patch) {
      var a = Accounts.get(id);
      if (!a) return false;
      Object.assign(a, patch);
      save();
      return true;
    },
    remove: function (id) {
      var used = state.txs.filter(function (t) { return t.account_id === id && !t.deleted_at; }).length;
      if (used) return { ok: false, msg: 'Akun masih dipakai ' + used + ' transaksi' };
      state.accounts = state.accounts.filter(function (a) { return a.id !== id; });
      if (!state.accounts.length) state.accounts = defaultAccounts();
      save();
      return { ok: true };
    },
    // Saldo = saldo awal + pemasukan - pengeluaran (semua transaksi aktif)
    balance: function (id) {
      var a = Accounts.get(id);
      if (!a) return 0;
      var bal = Number(a.opening) || 0;
      state.txs.forEach(function (t) {
        if (t.deleted_at || t.account_id !== id) return;
        bal += t.type === 'in' ? t.amount : -t.amount;
      });
      return bal;
    },
    totalBalance: function () {
      return Accounts.active().reduce(function (s, a) { return s + Accounts.balance(a.id); }, 0);
    }
  };

  /* ---------------- Settings ---------------- */
  var Settings = {
    get: function () { return state.settings; },
    save: function (patch) { Object.assign(state.settings, patch); save(); },
    resetCategories: function () {
      state.settings.categories = defaultCategories();
      save();
    }
  };

  /* ---------------- Import / Export ---------------- */
  var Data = {
    exportJSON: function () {
      return JSON.stringify({
        app: 'project-nava', version: 3, exportedAt: new Date().toISOString(),
        settings: state.settings, accounts: state.accounts,
        notes: state.notes, txs: state.txs, pool: state.pool, pendingPush: state.pendingPush,
        templates: state.templates
      }, null, 2);
    },
    importJSON: function (text) {
      var p = JSON.parse(text);
      if (!p) throw new Error('Format tidak dikenali');
      var d = defaults();
      state.notes = Array.isArray(p.notes) ? p.notes : [];
      state.txs = Array.isArray(p.txs) ? p.txs : (Array.isArray(p.transactions) ? p.transactions : []);
      state.pool = Array.isArray(p.pool) ? p.pool : [];
      state.templates = Array.isArray(p.templates) ? p.templates : [];
      state.accounts = Array.isArray(p.accounts) && p.accounts.length ? p.accounts : defaultAccounts();
      if (p.settings) state.settings = Object.assign(d.settings, p.settings);
      var n = normalize({
        settings: state.settings, accounts: state.accounts,
        notes: state.notes, txs: state.txs, pool: state.pool, pendingPush: state.pendingPush,
        templates: state.templates
      });
      state.settings = n.settings; state.accounts = n.accounts; state.txs = n.txs;
      state.pool = n.pool;
      state.pendingPush = n.pendingPush;
      saveNow();
    },
    clearAll: function () {
      state.notes = []; state.txs = []; state.templates = [];
      state.pool = [];
      state.pendingPush = [];
      state.accounts = defaultAccounts();
      AudioDB.clear();
      saveNow();
    },
    isEmpty: function () {
      return state.notes.length === 0 && state.txs.length === 0;
    }
  };

  /* ==========================================================
     HARGA PART KALKULATOR — satu-satunya tempat menuliskannya

     Dipakai bersama oleh Kalkulator Service (calc.js) dan form
     Tambah Sparepart (mascim.js). dipeusatkan supaya keduanya tidak
     bisa berbeda aturan, dan supaya tidak ada duplikat.

     Aturan dedup: satu entri per kombinasi
         brand + seri unit + jenis perhitungan
     Menyimpan kombinasi yang sama lagi akan MENGGANTI harga lamanya,
     bukan menambah baris baru. Ini penting karena data bertambah terus
     seiring masuknya servis: tanpa dedup, katalog menumpuk salinan dari
     kombinasi yang sama.

     ID entri diturunkan dari kuncinya sendiri, jadi deterministik:
     kombinasi yang sama selalu menghasilkan ID yang sama. Kalau ID
     dibuat acak setiap kali (uid), kombinasi kembar bisa lolos dedup
     karena dua baris punya ID berbeda.

     Setiap penyimpanan diverifikasi dengan menulis lalu membaca
     kembali. Kalau localStorage penuh atau ditolak browser, hasilnya
     dikembalikan ke pemanggil sebagai kegagalan — bukan diam-diam
     sukses palsu.
     ========================================================== */
  /* Batas ini bukan batas dedup — dedup bekerja lewat kunci, sehingga
     kombinasi kembar tidak pernah menambah baris. Batas ini hanya jaring
     pengaman kalau localStorage benar-benar mau penuh. Nilainya dibuat jauh
     lebih besar dari jumlah kombinasi yang realistis (6 brand x ~25 seri x
     6 perhitungan = 900), supaya tidak pernah memotong datanya sendiri. Kalau sampai kena batas, pemanggil diberi tahu lewat
     trimmed — pemotongan diam-diam berarti data hilang tanpa jejak. */
  var TPL_LIMIT = 3000;

  function templateKey(p) {
    return [p.brandId || '', p.series || '', p.ruleId || ''].join('|');
  }

  function upsertTemplate(payload) {
    if (!payload || !payload.brandId || !payload.series || !payload.ruleId) {
      return { ok: false, reason: 'Data harga tidak lengkap' };
    }
    if (!(parseInt(payload.part, 10) > 0)) {
      return { ok: false, reason: 'Harga part harus lebih dari 0' };
    }
    var list = state.templates || (state.templates = []);
    var key = templateKey(payload);
    var id = 'tpl_' + key;
    var stamp = new Date().toISOString();

    var found = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id || templateKey(list[i].payload || {}) === key) {
        found = list[i];
        break;
      }
    }
    if (found) {
      // Ganti, bukan tambah. createdAt asli dipertahankan, dan payload
      // lamanya disimpan dulu supaya bisa dikembalikan kalau penulisan
      // ke localStorage ternyata gagal.
      found._prev = found.payload;
      found.payload = payload;
      found.updatedAt = stamp;
      replaced = true;
    } else {
      list.unshift({ id: id, createdAt: stamp, payload: payload });
    }
    var trimmed = 0;
    if (list.length > TPL_LIMIT) {
      trimmed = list.length - TPL_LIMIT;
      list.length = TPL_LIMIT;
    }

    // Verifikasi betulan tersimpan, bukan hanya "tidak melempar error".
    saveNow();
    var written = false;
    try {
      var raw = localStorage.getItem(KEY);
      var back = raw ? JSON.parse(raw) : null;
      written = !!(back && back.templates && back.templates.some(function (t) {
        return templateKey(t.payload || {}) === key;
      }));
    } catch (e) {
      written = false;
    }
    if (!written) {
      // Kembalikan ke kondisi sebelum percobaan, supaya tidak ada data
      // separuh jadi tertinggal di memori lalu hilang setelah refresh.
      if (found) {
        if (found._prev) found.payload = found._prev;
        delete found._prev;
        delete found.updatedAt;
      } else {
        state.templates = list.filter(function (t) { return t.id !== id; });
      }
      saveNow();
      return { ok: false, reason: 'Penyimpanan penuh atau ditolak browser' };
    }
    if (found) delete found._prev;
    return {
      ok: true, id: id, total: list.length,
      replaced: replaced, trimmed: trimmed
    };
  }

  w.Store = {
    state: state, save: save, saveNow: saveNow, uid: uid,
    upsertTemplate: upsertTemplate, templateKey: templateKey,
    todayStr: todayStr, nowLocalInput: nowLocalInput, ymOf: ymOf,
    monthLabel: monthLabel, dayLabel: dayLabel, shiftMonth: shiftMonth,
    parseAmount: parseAmount, validateTx: validateTx,
    Notes: Notes, Tx: Tx, Pool: Pool, Groups: Groups, Accounts: Accounts,
    Settings: Settings, Data: Data, AudioDB: AudioDB
  };
})(window);
