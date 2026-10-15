/* =========================================================
   sync.js — Sinkronisasi Mini App <-> server bot alima
   =========================================================
   TUJUAN (revisi): transaksi yang dicatat lewat chat bot alima
   harus MUNCUL di Mini App, dan sebaliknya.

   Mekanisme:
   - "Server" (bot) adalah sumber kebenaran tambahan. Mini App
     menarik daftar transaksi dari server lalu menggabungkannya
     ke penyimpanan lokal (id-based, tanpa duplikat).
   - Transaksi yang dibuat di Mini App saat online langsung
     dikirim ke server (idem_key mencegah duplikat).
   - Transaksi yang dibuat saat server tidak terjangkau disimpan
     di antrean `pendingPush` dan dikirim lagi saat online lagi.
   - Mode "lokal saja" tetap 100% berfungsi bila server mati
     atau bot belum dikonfigurasi — cashflow tidak boleh
     bergantung pada AI/gateway (PRD 17).
   ========================================================= */
(function (w) {
  'use strict';

  var S = w.Store;
  var SETTINGS_KEY = 'projectnava.sync';

  var cfg = {
    baseUrl: '',
    autoPush: true,
    lastSync: null
  };

  var status = {
    online: false,      // server diketahui bisa dihubungi
    configured: false,  // baseUrl + initData tersedia
    lastError: null,
    lastCount: 0,
    poolCount: 0,       // jumlah item yang menunggu "Simpan"
    _stale: false,      // URL hasil discovery dianggap basi (gagal ditarik)
    _lastTry: 0,        // waktu percobaan terakhir (unix ms)
    _fails: 0           // jumlah kegagalan berturut-turut
  };

  // Saat server sedang dirapikan oleh supervisor, gagal tarik itu
  // hal yang SANGAT normal (tunnel sedang berganti). Kita tidak mau
  // tiap 15 detik menembak ke URL yang pasti gagal — tapi juga tidak
  // mau menunggu lama setelah tunnel baru terbit. Jeda dibuat
  //Jhprogressif: 5s, 10s, 15s, lalu maximum 30s.
  var RETRY_STEPS = [5000, 10000, 15000, 30000];

  function retryDelay() {
    var i = Math.min(status._fails, RETRY_STEPS.length - 1);
    return RETRY_STEPS[i] + Math.floor(Math.random() * 2000);
  }

  // Riwayat URL server. Tunnel sering berganti (URL acak) dan GitHub
  // Pages bisa menyajikan sync.json basi selama ~10 menit. Daripada
  // hanya percaya satu URL, kita menyimpan beberapa URL terakhir dan
  // mencoba satu per satu sampai ada yang menjawab. Dengan begitu
  // pergantian tunnel tidak lagi felt oleh pengguna.
  var MAX_URLS = 5;

  function loadCfg() {
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) cfg = Object.assign(cfg, JSON.parse(raw));
    } catch (e) { /* pakai default */ }
    return cfg;
  }
  function saveCfg() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(cfg)); } catch (e) {}
  }

  /** Tambah URL ke riwayat (paling baru di depan, tanpa duplikat). */
  function rememberUrl(u) {
    if (!u) return;
    u = String(u).replace(/\/+$/, '');
    loadCfg();
    var list = Array.isArray(cfg.urls) ? cfg.urls.slice() : [];
    if (list[0] !== u) list = [u].concat(list.filter(function (x) { return x !== u; }));
    cfg.urls = list.slice(0, MAX_URLS);
    saveCfg();
  }

  /** Daftar URL kandidat: manual (kalau ada) + riwayat. */
  function candidates() {
    loadCfg();
    var list = Array.isArray(cfg.urls) ? cfg.urls.slice() : [];
    if (cfg.baseUrl && cfg.manual) list.unshift(cfg.baseUrl);
    else if (cfg.baseUrl && list.indexOf(cfg.baseUrl) === -1) list.unshift(cfg.baseUrl);
    return list;
  }

  /** initData asli dari Telegram (hanya ada di dalam Telegram). */
  function initData() {
    var wa = w.Telegram && w.Telegram.WebApp;
    if (wa && wa.initData && wa.initData.length > 10) return wa.initData;
    return '';
  }

  /** Server terkonfigurasi? */
  function isConfigured() {
    loadCfg();
    return !!(cfg.baseUrl && initData());
  }

  function headers() {
    var h = { 'Content-Type': 'application/json' };
    var id = initData();
    if (id) h['X-Init-Data'] = id;
    return h;
  }

  // URL yang baru saja gagal dicoba paling akhir supaya percobaan
  // berikutnya tidak mengulang URL yang jelas sudah mati.
  var badUntil = {}; // base -> timestamp (ms) sampai kapan dicoba lagi

  function api(path, opts) {
    opts = opts || {};
    loadCfg();
    var now = Date.now();
    var all = candidates().filter(function (b) { return !(badUntil[b] > now); });
    // Kalau semua URL sedang dicurigai mati, tetap coba yang paling
    // baru saja dipakai (lebih baik mencoba daripada langsung menyerah).
    if (!all.length) all = candidates();
    if (!all.length) return Promise.reject(new Error('Server bot belum diatur'));

    // Coba tiap URL kandidat sampai ada yang menjawab. Error auth
    // (401/403) berarti server hidup — jangan pindah ke URL lain.
    var idx = 0;
    var lastErr = null;
    function attempt() {
      if (idx >= all.length) throw lastErr || new Error('Server bot tidak terjangkau');
      var base = all[idx++];
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      // Batas waktu per URL diperpendek supaya satu_endpoint yang
      // menggantung tidak menahan seluruh rangkaian failover.
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, opts.timeout || 6000) : null;

      return fetch(base.replace(/\/+$/, '') + path, {
        method: opts.method || 'GET',
        headers: headers(),
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: ctrl ? ctrl.signal : undefined
      }).then(function (r) {
        if (timer) clearTimeout(timer);
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) {
            var e = new Error(j.error || ('HTTP ' + r.status));
            e.status = r.status;
            throw e;
          }
          // Berhasil di URL ini -> jadikan kandidat utama.
          if (base !== cfg.baseUrl) { cfg.baseUrl = base; cfg.manual = false; saveCfg(); }
          delete badUntil[base];
          rememberUrl(base);
          return j;
        });
      }).catch(function (e) {
        if (timer) clearTimeout(timer);
        lastErr = e;
        // 401/403 = server hidup, hanya masalah auth. Berhenti di sini.
        if (e && (e.status === 401 || e.status === 403)) throw e;
        // Tandai URL ini supaya percobaan berikutnya membuangnya
        // sampai batas waktu tertentu (30 detik).
        badUntil[base] = Date.now() + 30000;
        // Error jaringan/server: coba URL kandidat berikutnya.
        if (idx < all.length) return attempt();
        throw e;
      });
    }
    return attempt();
  }

  /* ------------------------------------------------------------
     Penemuan otomatis (discovery) alamat server bot

     Mini App berjalan di HTTPS (GitHub Pages) di HP. Server bot
     berjalan di HTTP di komputer, jadi Halaman HTTPS -> HTTP
     otomatis DIBLOKIR browser (mixed content). Tunnel Quick
     juga punya URL acak yang berubah tiap restart.

     Solusi: bot menulis URL publiknya yang SEKARANG ke `sync.json`
     di GitHub Pages (origin yang sama, HTTPS, CORS terbuka).
     Mini App membacanya tiap dibuka => selalu tahu ke mana menarik
     data, dan otomatis mengikuti URL tunnel yang terbaru.
     ------------------------------------------------------------ */
  function discoveryUrl() {
    // sync.json diletakkan di root domain yang sama dengan Mini App.
    // Ambil dari tag <meta name="nava-sync-config"> bila ada.
    var meta = document.querySelector('meta[name="nava-sync-config"]');
    var path = (meta && meta.getAttribute('content')) || 'sync.json';
    try { return new URL(path, document.baseURI).toString(); }
    catch (e) { return path; }
  }

  function discover() {
    loadCfg();
    // URL manual = pilihan pengguna, tidak pernah ditimpa otomatis.
    if (cfg.baseUrl && cfg.manual) return Promise.resolve(cfg.baseUrl);
    // Kalau URL hasil discovery sebelumnya gagal ditarik, jangan pakai
    // nilai basi itu lagi — baca ulang sync.json (mis. tunnel berubah).
    if (cfg.baseUrl && status._stale) cfg.baseUrl = '';
    if (cfg.baseUrl) return Promise.resolve(cfg.baseUrl);
    // fetch mungkin tidak ada (lingkungan lama / uji) — jangan sampai
    // melempar error hanya karena gagal menemukan server.
    if (typeof fetch !== 'function') return Promise.resolve(cfg.baseUrl || '');
    // Hindari cache Pages: tambah param waktu agar selalu segar.
    var base = discoveryUrl();
    var url = base + (base.indexOf('?') === -1 ? '?' : '&') + 't=' + Date.now();
    return fetch(url, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && (j.api || (Array.isArray(j.apis) && j.apis.length))) {
          // Bot bisa menerbitkan beberapa URL (cadangan). Simpan semuanya
          // supaya ada yang bisa dicoba saat tunnel yang utama berganti.
          var list = [];
          if (Array.isArray(j.apis)) list = j.apis.slice();
          if (j.api && list.indexOf(j.api) === -1) list.unshift(j.api);
          list = list.filter(Boolean).map(function (u) { return String(u).replace(/\/+$/, ''); });
          if (list.length) {
            cfg.baseUrl = list[0];
            cfg.urls = list.slice(0, MAX_URLS);
            cfg.manual = false;
            cfg.discoveredAt = new Date().toISOString();
            status._stale = false;
            saveCfg();
            rememberUrl(cfg.baseUrl);
          }
          return cfg.baseUrl;
        }
        return cfg.baseUrl || '';
      })
      .catch(function () { return cfg.baseUrl || ''; });
  }

  function pull() {
    return discover().then(function () {
      if (!isConfigured()) return { skipped: true };
      status._lastTry = Date.now();
      return api('/api/txs?limit=500')
        .then(function (j) {
          var res = S.Tx.mergeFromServer(j.txs || []);
          status.online = true;
          status.lastError = null;
          status._fails = 0;
          status.lastCount = res.added + res.updated;
          cfg.lastSync = new Date().toISOString();
          saveCfg();
          return res;
        })
        .catch(function (e) {
          status.online = false;
          status.lastError = e.message;
          status._fails++;
          // Gagal jaringan / server mati -> URL hasil discovery dicurigai
          // basi (tunnel mungkin sudah berganti). Paksa baca ulang
          // sync.json pada tarikan berikutnya. Kesalahan auth (401/403)
          // TIDAK dianggap basi, itu masalah konfigurasi.
          // Riwayat URL (cfg.urls) tetap utuh sehingga api() masih
          // punya kandidat lain untuk dicoba.
          if (!cfg.manual && (e.status === 0 || !e.status)) {
            status._stale = true;
            cfg.baseUrl = '';
            saveCfg();
          }
          return { error: e.message, retryIn: retryDelay() };
        });
    });
  }

  /* ------------------------------------------------------------
     Pool transaksi dari bot

     Transaksi yang dikirim lewat chat bot tidak langsung masuk
     cashflow. Ia ditahan di server sebagai "pool" dan ditarik
     Mini App untuk ditampilkan di dashboard. Baru setelah pengguna
     menekan "Simpan" item itu berpindah ke pembukuan.
     ------------------------------------------------------------ */
  function pullPool() {
    return discover().then(function () {
      if (!isConfigured()) return { skipped: true };
      status._lastTry = Date.now();
      return api('/api/pool', { timeout: 10000 })
        .then(function (j) {
          var items = j.pool || [];
          var before = S.Pool.count();
          S.Pool.set(items);
          status.online = true;
          status.lastError = null;
          status._fails = 0;
          status.poolCount = S.Pool.count();
          return { count: S.Pool.count(), added: Math.max(0, S.Pool.count() - before) };
        })
        .catch(function (e) {
          status.online = false;
          status.lastError = e.message;
          status._fails++;
          if (!cfg.manual && (e.status === 0 || !e.status)) {
            status._stale = true;
            cfg.baseUrl = '';
            saveCfg();
          }
          return { error: e.message, retryIn: retryDelay() };
        });
    });
  }

  /** Pengguna menekan "Simpan" -> masuk cashflow (lokal dulu, lalu server). */
  function accept(id) {
    var item = S.Pool.get(id);
    if (!item) return Promise.resolve({ ok: false, msg: 'Item pool tidak ditemukan' });
    // 1) Masukkan ke pembukuan lokal dengan id yang sama seperti server
    //    supaya tidak muncul dua kali saat sinkron berikutnya.
    var res = S.Tx.adopt(item);
    S.Pool.remove(id);
    // 2) Beri tahu server. Kalau gagal, transaksi tetap sudah tersimpan
    //    di perangkat dan akan terkirim lewat antrean normal.
    return discover().then(function () {
      if (!isConfigured()) return { ok: true, local: true, tx: res.tx };
      return api('/api/pool/' + encodeURIComponent(id) + '/accept', { method: 'POST' })
        .then(function () { return { ok: true, tx: res.tx }; })
        .catch(function (e) {
          // Server belum mengonfirmasi; tandai agar dikirim ulang nanti.
          S.Tx.queueForPush(res.tx, 'upsert');
          return { ok: true, local: true, warn: e.message, tx: res.tx };
        });
    });
  }

  /** Pengguna menekan "Hapus" -> buang item dari pool. */
  function reject(id) {
    S.Pool.remove(id);
    return discover().then(function () {
      if (!isConfigured()) return { ok: true, local: true };
      return api('/api/pool/' + encodeURIComponent(id) + '/reject', { method: 'POST' })
        .then(function () { return { ok: true }; })
        .catch(function (e) { return { ok: true, local: true, warn: e.message }; });
    });
  }

  /* ------------------------------------------------------------
     Kirim transaksi lokal yang belum tersinkron
     ------------------------------------------------------------ */
  function push() {
    return discover().then(function () {
      if (!isConfigured() || !cfg.autoPush) return { skipped: true };
      var pend = S.Tx.pendingPush();
      if (!pend.length) return { pushed: 0 };

      var jobs = pend.map(function (p) {
        var t = S.Tx.get(p.id);
        if (!t) return Promise.resolve(false);
        if (p.op === 'delete') {
          return api('/api/txs/' + encodeURIComponent(t.id), { method: 'DELETE' })
            .then(function () { return t.id; })
            .catch(function () { return null; });
        }
        return api('/api/txs', {
          method: 'POST',
          body: {
            id: t.id,
            account_id: t.account_id,
            category_id: t.category_id,
            type: t.type,
            group_name: t.group,
            sub: t.sub,
            amount: t.amount,
            transaction_date: t.transaction_date,
            note: t.note,
            idem_key: t.idem_key,
            source: 'miniapp'
          }
        }).then(function () { return t.id; }).catch(function () { return null; });
      });

      return Promise.all(jobs).then(function (ids) {
        var done = ids.filter(Boolean);
        S.Tx.clearPushed(done);
        status.online = true;
        status.lastError = null;
        return { pushed: done.length };
      });
    }).catch(function (e) {
      status.online = false;
      status.lastError = e.message;
      return { error: e.message };
    });
  }

  /* ------------------------------------------------------------
     Sinkron penuh: tarik dulu (agar data bot masuk), lalu kirim
     ------------------------------------------------------------ */
  function sync() {
    return discover().then(function () {
      if (!isConfigured()) return { skipped: true, reason: 'not configured' };
      return pullPool()
        .then(function () { return pull(); })
        .then(function () { return push(); });
    });
  }

  /* ------------------------------------------------------------
     Konfigurasi
     ------------------------------------------------------------ */
  function configure(baseUrl, autoPush) {
    cfg.baseUrl = String(baseUrl || '').trim().replace(/\/+$/, '');
    cfg.manual = !!baseUrl;   // URL yang diketik manual = sumber utama
    if (autoPush != null) cfg.autoPush = !!autoPush;
    saveCfg();
    return cfg.baseUrl;
  }

  /* ------------------------------------------------------------
     Modul Mas Cim Service HP

     Memakai jalur yang sama persis dengan cashflow: discovery
     otomatis, daftar URL cadangan, dan auth initData Telegram.
     Karena itu modul ini otomatis mengikuti pergantian tunnel
     tanpa perlu konfigurasi ulang.
     ------------------------------------------------------------ */
  function mascimApi(method, path, body) {
    return discover().then(function () {
      if (!isConfigured()) {
        return Promise.reject(new Error('Buka di dalam Telegram dan tunggu sinkronisasi'));
      }
      return api(path, { method: method, body: body })
        .catch(function (e) {
          if (!cfg.manual && (e.status === 0 || !e.status)) {
            status._stale = true;
            cfg.baseUrl = '';
            saveCfg();
          }
          throw e;
        });
    });
  }

  function getConfig() { loadCfg(); return Object.assign({}, cfg); }
  function getStatus() { return Object.assign({}, status); }
  function setOnline(v) { status.online = !!v; }

  w.Sync = {
    init: loadCfg,
    configure: configure,
    discover: discover,
    getConfig: getConfig,
    getStatus: getStatus,
    isConfigured: isConfigured,
    hasInitData: function () { return !!initData(); },
    pull: pull,
    pullPool: pullPool,
    accept: accept,
    reject: reject,
    mascimApi: mascimApi,
    push: push,
    sync: sync
  };
})(window);
