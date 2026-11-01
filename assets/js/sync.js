/* =========================================================
   sync.js — Sinkronisasi Terpadu Mini App & Browser Link
   =========================================================
   TUJUAN:
   Input lewat mana pun (link browser maupun Telegram Mini App)
   saat disinkronisasi WAJIB tersimpan menjadi satu tanpa ada
   data yang hilang atau terduplikasi.

   TRANSPORT:
   Tabel `vault` di Supabase, kunci: `cashflow_data`.
   Berfungsi 100% baik di Telegram Mini App maupun di browser
   biasa (Chrome, Safari, dsb.) via REST API Supabase.

   MEKANISME PENGGABUNGAN (2-Way Merge):
   - Transaksi (txs): digabung berdasarkan id & idem_key.
     Jika salah satu dihapus (deleted_at), tombstone dipertahankan.
     Transaksi baru dari perangkat manapun digabung ke dalam daftar.
   - Catatan (notes): digabung per id, timestamp terbaru menang.
   - Akun (accounts): digabung per id.
   - Kategori (categories): digabung per id.
   - Dana Bank (bank): entri digabung per id, wajibBulanan & pelunasanBulanan digabung.
   - Mas Cim (mascim): orders, parts, payments, cashflow, bank digabung per id.
   ========================================================= */
(function (w) {
  'use strict';

  var VAULT_KEY = 'cashflow_data';
  var PUSH_DEBOUNCE_MS = 1200;
  var AUTO_PULL_MS = 15000;

  var status = {
    online: true,
    configured: true,
    lastSync: null,
    lastCount: 0,
    lastError: null,
    isSyncing: false
  };

  var pushTimer = null;
  var autoTimer = null;
  var isPulling = false;
  var isPushing = false;

  function S() { return w.Store; }

  /* ------------------------------------------------------------
     Helper Gabung Transaksi (Dua Arah & Aman)
     ------------------------------------------------------------ */
  function mergeTxs(localList, remoteList) {
    var byKey = {};
    var result = [];

    function getKey(t) {
      if (!t) return null;
      return t.id || t.idem_key || null;
    }

    // Masukkan remote terlebih dahulu
    (remoteList || []).forEach(function (r) {
      var k = getKey(r);
      if (!k) return;
      var copy = Object.assign({}, r);
      byKey[r.id] = copy;
      if (r.idem_key) byKey[r.idem_key] = copy;
      result.push(copy);
    });

    var added = 0;
    var updated = 0;

    // Gabungkan lokal
    (localList || []).forEach(function (l) {
      var k = getKey(l);
      if (!k) return;
      var match = byKey[l.id] || (l.idem_key && byKey[l.idem_key]);
      if (!match) {
        // Transaksi lokal yang belum ada di remote -> tambahkan
        var copyL = Object.assign({}, l);
        result.push(copyL);
        byKey[l.id] = copyL;
        if (l.idem_key) byKey[l.idem_key] = copyL;
        added++;
      } else {
        var changed = false;
        // 1. Tombstone soft delete (penghapusan harus sinkron)
        if (l.deleted_at && !match.deleted_at) {
          match.deleted_at = l.deleted_at;
          changed = true;
        } else if (match.deleted_at && !l.deleted_at) {
          l.deleted_at = match.deleted_at;
          changed = true;
        }

        // 2. Data terbaru menang (perbandingan waktu)
        var lTime = l.updated_at || l.created_at || '';
        var mTime = match.updated_at || match.created_at || '';
        if (lTime > mTime) {
          Object.assign(match, l);
          changed = true;
        } else if (mTime > lTime) {
          Object.assign(l, match);
          changed = true;
        }
        if (changed) updated++;
      }
    });

    return { list: result, added: added, updated: updated };
  }

  /* ------------------------------------------------------------
     Helper Gabung Catatan (Notes)
     ------------------------------------------------------------ */
  function mergeNotes(localNotes, remoteNotes) {
    var byId = {};
    var result = [];
    (remoteNotes || []).forEach(function (r) {
      if (!r || !r.id) return;
      var copy = Object.assign({}, r);
      byId[r.id] = copy;
      result.push(copy);
    });
    (localNotes || []).forEach(function (l) {
      if (!l || !l.id) return;
      var match = byId[l.id];
      if (!match) {
        var copyL = Object.assign({}, l);
        result.push(copyL);
        byId[l.id] = copyL;
      } else {
        var lTime = l.updatedAt || l.createdAt || '';
        var mTime = match.updatedAt || match.createdAt || '';
        if (lTime >= mTime) Object.assign(match, l);
        else Object.assign(l, match);
      }
    });
    return result;
  }

  /* ------------------------------------------------------------
     Helper Gabung Akun (Accounts)
     ------------------------------------------------------------ */
  function mergeAccounts(localAccs, remoteAccs) {
    var byId = {};
    var result = [];
    (remoteAccs || []).forEach(function (r) {
      if (!r || !r.id) return;
      byId[r.id] = r;
      result.push(Object.assign({}, r));
    });
    (localAccs || []).forEach(function (l) {
      if (!l || !l.id) return;
      if (!byId[l.id]) {
        result.push(l);
        byId[l.id] = l;
      }
    });
    return result.length ? result : localAccs;
  }

  /* ------------------------------------------------------------
     Helper Gabung Kategori (Categories)
     ------------------------------------------------------------ */
  function mergeCategories(localCats, remoteCats) {
    var byId = {};
    var result = [];
    (remoteCats || []).forEach(function (r) {
      if (!r || !r.id) return;
      byId[r.id] = r;
      result.push(Object.assign({}, r));
    });
    (localCats || []).forEach(function (l) {
      if (!l || !l.id) return;
      if (!byId[l.id]) {
        result.push(l);
        byId[l.id] = l;
      }
    });
    return result.length ? result : localCats;
  }

  /* ------------------------------------------------------------
     Helper Gabung Mas Cim (Orders, Parts, Payments, Cashflow, Bank)
     ------------------------------------------------------------ */
  function mergeMascim(localM, remoteM) {
    if (!remoteM) return localM;
    if (!localM) return remoteM;

    function mergeById(localArr, remoteArr, timeProp) {
      var map = {};
      var res = [];
      (remoteArr || []).forEach(function (r) {
        if (!r || !r.id) return;
        var copy = Object.assign({}, r);
        map[r.id] = copy;
        res.push(copy);
      });
      (localArr || []).forEach(function (l) {
        if (!l || !l.id) return;
        var match = map[l.id];
        if (!match) {
          var copyL = Object.assign({}, l);
          res.push(copyL);
          map[l.id] = copyL;
        } else {
          var lTime = (timeProp ? l[timeProp] : '') || l.updatedAt || l.createdAt || '';
          var mTime = (timeProp ? match[timeProp] : '') || match.updatedAt || match.createdAt || '';
          if (lTime >= mTime) Object.assign(match, l);
          else Object.assign(l, match);
        }
      });
      return res;
    }

    var mergedOrders = mergeById(localM.orders, remoteM.orders, 'updatedAt');
    var mergedParts = mergeById(localM.parts, remoteM.parts, 'createdAt');
    var mergedPayments = mergeById(localM.payments, remoteM.payments, 'createdAt');
    var mergedCashflow = mergeById(localM.cashflow, remoteM.cashflow, 'createdAt');
    var mergedBank = mergeById(localM.bank, remoteM.bank, 'createdAt');

    var noteCounter = Math.max(
      (localM.settings && localM.settings.noteCounter) || 0,
      (remoteM.settings && remoteM.settings.noteCounter) || 0
    );

    return {
      version: 1,
      settings: Object.assign({}, remoteM.settings, localM.settings, { noteCounter: noteCounter }),
      orders: mergedOrders,
      parts: mergedParts,
      payments: mergedPayments,
      cashflow: mergedCashflow,
      bank: mergedBank
    };
  }

  /* ------------------------------------------------------------
     Helper Gabung Dana Bank (nava.bank.v1)
     ------------------------------------------------------------ */
  function mergeBank(localB, remoteB) {
    if (!remoteB) return localB;
    if (!localB) return remoteB;

    var map = {};
    var resEntries = [];
    (remoteB.entries || []).forEach(function (r) {
      if (!r || !r.id) return;
      map[r.id] = r;
      resEntries.push(Object.assign({}, r));
    });
    (localB.entries || []).forEach(function (l) {
      if (!l || !l.id) return;
      if (!map[l.id]) {
        resEntries.push(l);
        map[l.id] = l;
      }
    });

    return {
      initial: Math.max(Number(localB.initial || 0), Number(remoteB.initial || 0)),
      entries: resEntries,
      wajibBulanan: Object.assign({}, remoteB.wajibBulanan, localB.wajibBulanan),
      pelunasanBulanan: Object.assign({}, remoteB.pelunasanBulanan, localB.pelunasanBulanan)
    };
  }

  /* ------------------------------------------------------------
     PULL: Tarik data dari Supabase vault dan gabungkan ke lokal
     ------------------------------------------------------------ */
  function pull(silent) {
    if (isPulling) return Promise.resolve({ skipped: true });
    if (!w.Supa || typeof w.Supa.vaultGet !== 'function') return Promise.resolve({ skipped: true });

    isPulling = true;
    status.isSyncing = true;

    return w.Supa.vaultGet(VAULT_KEY)
      .then(function (baris) {
        var remote = (baris && baris.isi) || null;
        if (!remote || !remote.txs || !remote.txs.length) {
          // Fallback: periksa cadangan harian terbaru bila cashflow_data masih kosong
          return w.Supa.vaultGet('app:' + new Date().toISOString().slice(0, 10))
            .then(function (snapBaris) {
              if (snapBaris && snapBaris.isi && snapBaris.isi['projectnava.v3']) {
                try {
                  var parsedP = JSON.parse(snapBaris.isi['projectnava.v3']);
                  var parsedM = snapBaris.isi['nava.mascim.local.v1'] ? JSON.parse(snapBaris.isi['nava.mascim.local.v1']) : null;
                  var parsedB = snapBaris.isi['nava.bank.v1'] ? JSON.parse(snapBaris.isi['nava.bank.v1']) : null;
                  return {
                    txs: parsedP.txs || [],
                    notes: parsedP.notes || [],
                    accounts: parsedP.accounts || [],
                    categories: (parsedP.settings && parsedP.settings.categories) || [],
                    mascim: parsedM,
                    bank: parsedB
                  };
                } catch (eP) { return null; }
              }
              return remote;
            });
        }
        return remote;
      })
      .then(function (remote) {
        isPulling = false;
        status.isSyncing = false;
        if (!remote) return { added: 0, updated: 0 };

        var store = S();
        if (!store || !store.state) return { added: 0, updated: 0 };

        var localTxs = store.state.txs || [];
        var merged = mergeTxs(localTxs, remote.txs || []);

        var localLen = localTxs.length;
        var remoteLen = (remote.txs || []).length;
        var hasLocalChanges = (merged.list.length !== localLen) || (merged.added > 0) || (merged.updated > 0);
        var hasRemoteChanges = (merged.list.length !== remoteLen) || (merged.added > 0);

        if (hasLocalChanges) {
          store.state.txs = merged.list;
          if (remote.notes && remote.notes.length) {
            store.state.notes = mergeNotes(store.state.notes || [], remote.notes);
          }
          if (remote.accounts && remote.accounts.length) {
            store.state.accounts = mergeAccounts(store.state.accounts || [], remote.accounts);
          }
          if (remote.categories && remote.categories.length) {
            if (!store.state.settings) store.state.settings = {};
            store.state.settings.categories = mergeCategories(store.state.settings.categories || [], remote.categories);
          }
          try { store.saveNow(); } catch (e) {}

          // Refresh UI
          try { if (w.TxUI && typeof w.TxUI.render === 'function') w.TxUI.render(); } catch (e) {}
          try { if (w.NotesUI && typeof w.NotesUI.render === 'function') w.NotesUI.render(); } catch (e) {}
        }

        // Gabung Mas Cim jika tersedia
        if (remote.mascim && w.MascimLocal && typeof w.MascimLocal._db === 'function') {
          try {
            var localM = w.MascimLocal._db();
            var mergedM = mergeMascim(localM, remote.mascim);
            if (JSON.stringify(localM) !== JSON.stringify(mergedM)) {
              w.localStorage.setItem('nava.mascim.local.v1', JSON.stringify(mergedM));
              if (w.MascimUI && typeof w.MascimUI.render === 'function') w.MascimUI.render();
            }
          } catch (eM) {}
        }

        // Gabung Dana Bank jika tersedia
        if (remote.bank && w.NavaBank && typeof w.NavaBank.exportJSON === 'function') {
          try {
            var localB = w.NavaBank.exportJSON();
            var mergedB = mergeBank(localB, remote.bank);
            if (JSON.stringify(localB) !== JSON.stringify(mergedB)) {
              w.NavaBank.importJSON(mergedB);
            }
          } catch (eB) {}
        }

        status.online = true;
        status.lastSync = new Date().toISOString();
        status.lastCount = merged.list.filter(function (t) { return !t.deleted_at; }).length;
        status.lastError = null;

        // Jika lokal memiliki data yang belum ada di remote, dorong kembali ke remote
        if (hasRemoteChanges) {
          schedulePush();
        }

        return { added: merged.added, updated: merged.updated, total: status.lastCount };
      })
      .catch(function (err) {
        isPulling = false;
        status.isSyncing = false;
        status.lastError = err && err.message ? err.message : String(err);
        return { error: status.lastError };
      });
  }

  /* ------------------------------------------------------------
     PUSH: Kirim data lokal saat ini ke Supabase vault
     ------------------------------------------------------------ */
  function push() {
    if (isPushing) return Promise.resolve({ skipped: true });
    if (!w.Supa || typeof w.Supa.vaultPut !== 'function') return Promise.resolve({ skipped: true });

    var store = S();
    if (!store || !store.state) return Promise.resolve({ skipped: true });

    isPushing = true;
    var txs = store.state.txs || [];
    var notes = store.state.notes || [];
    var accounts = store.state.accounts || [];
    var categories = (store.state.settings && store.state.settings.categories) || [];

    var mascimData = null;
    try {
      if (w.MascimLocal && typeof w.MascimLocal._db === 'function') {
        mascimData = w.MascimLocal._db();
      }
    } catch (eM) {}

    var bankData = null;
    try {
      if (w.NavaBank && typeof w.NavaBank.exportJSON === 'function') {
        bankData = w.NavaBank.exportJSON();
      }
    } catch (eB) {}

    var payload = {
      updatedAt: new Date().toISOString(),
      txs: txs,
      notes: notes,
      accounts: accounts,
      categories: categories,
      mascim: mascimData,
      bank: bankData
    };

    var ok = w.Supa.vaultPut(VAULT_KEY, payload);
    isPushing = false;
    if (ok) {
      status.lastSync = payload.updatedAt;
      status.online = true;
      status.lastError = null;
    }
    return Promise.resolve({ pushed: ok, txCount: txs.length });
  }

  /* ------------------------------------------------------------
     Jadwalkan PUSH (Debounced)
     ------------------------------------------------------------ */
  function schedulePush() {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(function () {
      push();
    }, PUSH_DEBOUNCE_MS);
  }

  /* ------------------------------------------------------------
     SYNC: Tarik dulu (merge) lalu dorong hasilnya
     ------------------------------------------------------------ */
  function sync() {
    return pull().then(function (r) {
      return push().then(function () { return r; });
    });
  }

  /* ------------------------------------------------------------
     Mulai & Event Listeners
     ------------------------------------------------------------ */
  function init() {
    // Sinkronisasi otomatis saat pertama kali dibuka
    setTimeout(function () {
      sync();
    }, 800);

    // Sinkronisasi saat kembali aktif ke aplikasi/tab
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) pull(true);
    });
    w.addEventListener('focus', function () {
      pull(true);
    });

    // Sinkronisasi berkala tiap 15 detik
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = setInterval(function () {
      if (!document.hidden) pull(true);
    }, AUTO_PULL_MS);

    // Deteksi perubahan dari tab/jendela lain
    w.addEventListener('storage', function (e) {
      if (e && e.key && (e.key === 'projectnava.v3' || e.key === 'nava.mascim.local.v1')) {
        try { if (w.Store && w.Store.load) w.Store.load(); } catch (err) {}
        try { if (w.TxUI && w.TxUI.render) w.TxUI.render(); } catch (err) {}
      }
    });

    return Promise.resolve(true);
  }

  /* Inisialisasi otomatis */
  if (w.document) {
    if (w.document.readyState === 'loading') {
      w.document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  /* ------------------------------------------------------------
     API Kompatibilitas Publik
     ------------------------------------------------------------ */
  w.Sync = {
    init: init,
    pull: pull,
    push: push,
    sync: sync,
    schedulePush: schedulePush,
    pullPool: function () { return Promise.resolve({ added: 0 }); },
    isConfigured: function () { return true; },
    hasInitData: function () { return true; },
    getStatus: function () { return Object.assign({}, status); },
    getConfig: function () { return { baseUrl: 'https://tpolunkalvyrrwodvdov.supabase.co', autoPush: true }; },
    configure: function () { return true; },
    discover: function () { return Promise.resolve('https://tpolunkalvyrrwodvdov.supabase.co'); },
    mascimApi: function () { return Promise.reject(new Error('Bot server tidak aktif')); }
  };

})(window);
