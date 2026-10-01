/* =====================================================================
   NAVATraderAlert — Pengaturan Notifikasi Telegram (server-side alert)

   Modul ini HANYA mengatur UI. Pemeriksaan harga dan pengiriman
   notifikasi dilakukan server (bot/src/watcher.js), sehingga alert
   tetap terkirim walau Mini App ditutup.

   Semua aturan kerentanan:
   - Tidak pernah menampilkan klaim order bursa.
   - Label data (EOD / Delayed / Real-time) selalu ditampilkan.
   - Data kosong ditulis "Data tidak tersedia", tidak dikarang.
   ===================================================================== */
(function (w) {
  'use strict';

  var w = w || this;
  var Core = function () { return w.NavaTraderCore; };
  var Sync = function () { return w.Sync; };

  var M = {
    view: 'alert',        // alert | alert-saham | alert-log
    settings: null,
    watch: [],
    corporate: [],
    log: [],
    pesan: '',
    galat: '',
    sibuk: false,
    memuat: false,
  };

  /* ---------------------------------------------------------
     UTIL
     --------------------------------------------------------- */

  var $ = function (sel) { return w.document.querySelector(sel); };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmt(n) {
    if (typeof n !== 'number' || !isFinite(n)) return 'Data tidak tersedia';
    return 'Rp' + Math.round(n).toLocaleString('id-ID');
  }

  /** Ambil api() milik Sync (punya auth + failover multi-URL). */
  function api(method, path, body) {
    var S = Sync();
    if (!S || !S.mascimApi) return Promise.reject(new Error('Sinkronisasi belum siap'));
    return S.mascimApi(method, path, body);
  }

  function toast(p) {
    if (w.App && w.App.toast) w.App.toast(p);
    else M.pesan = p;
  }

  /* ---------------------------------------------------------
     MUAT DATA
     --------------------------------------------------------- */

  function muat() {
    M.memuat = true; M.galat = '';
    render();
    return api('GET', '/api/alerts')
      .then(function (r) {
        M.settings = (r && r.settings) || null;
        M.watch = (r && r.watch) || [];
        M.corporate = (r && r.corporate) || [];
        return M.settings ? api('GET', '/api/alerts/log?limit=30') : Promise.resolve({ log: [] });
      })
      .then(function (r2) { M.log = (r2 && r2.log) || []; })
      .catch(function (e) { M.galat = e.message || 'Gagal memuat pengaturan'; })
      .then(function () { M.memuat = false; render(); });
  }

  function simpanSettings(patch) {
    M.sibuk = true; M.galat = ''; render();
    return api('PUT', '/api/alerts/settings', patch)
      .then(function (r) {
        M.settings = (r && r.settings) || M.settings;
        toast('Pengaturan alert disimpan');
      })
      .catch(function (e) { M.galat = e.message || 'Gagal menyimpan pengaturan'; })
      .then(function () { M.sibuk = false; render(); });
  }

  function simpanAturan(body) {
    M.sibuk = true; M.galat = ''; render();
    return api('POST', '/api/alerts', body)
      .then(function () { toast('Aturan alert untuk ' + body.kode + ' disimpan'); return muat(); })
      .catch(function (e) { M.galat = e.message || 'Gagal menyimpan aturan'; })
      .then(function () { M.sibuk = false; render(); });
  }

  function hapusAturan(kode) {
    M.sibuk = true; render();
    return api('DELETE', '/api/alerts/' + encodeURIComponent(kode))
      .then(function () { toast('Alert ' + kode + ' dihapus'); return muat(); })
      .catch(function (e) { M.galat = e.message || 'Gagal menghapus'; })
      .then(function () { M.sibuk = false; render(); });
  }

  /* ---------------------------------------------------------
     RENDER — pengaturan global
     --------------------------------------------------------- */

  function deriveCounter(e) {
    return String(e.target.value).replace(/[^0-9]/g, '');
  }

  function layarPengaturan() {
    var s = M.settings;
    if (!s) {
      return '<div class="nt-card"><div class="nt-muted">' +
        (M.memuat ? 'Memuat pengaturan…' : (M.galat || 'Data tidak tersedia')) + '</div></div>';
    }
    var aktif = s.aktif ? 1 : 0;

    var L = [];
    L.push('<div class="nt-card">');
    L.push('<div class="nt-card-t">🔔 Notifikasi Harga</div>');
    L.push('<p class="nt-muted">Server memantau watchlist dan mengirim alert ke chat bot kamu, ' +
      'bahkan saat Mini App ditutup.</p>');

    L.push('<label class="nt-sw"><input type="checkbox" id="alAktif"' + (aktif ? ' checked' : '') +
      '><span>Notifikasi aktif</span></label>');

    L.push('<div class="nt-row2">');
    L.push('<label class="nt-fld"><span>Jam mulai</span>' +
      '<input type="time" id="alMulai" value="' + esc(s.jam_aktif_start || '09:00') + '"></label>');
    L.push('<label class="nt-fld"><span>Jam selesai</span>' +
      '<input type="time" id="alSelesai" value="' + esc(s.jam_aktif_end || '15:30') + '"></label>');
    L.push('</div>');

    L.push('<div class="nt-row2">');
    L.push('<label class="nt-fld"><span>Jeda menit</span>' +
      '<input type="number" inputmode="numeric" id="alJedaM" min="0" max="10080" value="' +
      esc(s.jeda_menit) + '"></label>');
    L.push('<label class="nt-fld"><span>Jeda persen</span>' +
      '<input type="number" inputmode="numeric" id="alJedaP" min="0" max="100" value="' +
      esc(s.jeda_persen) + '"></label>');
    L.push('</div>');

    L.push('<label class="nt-fld"><span>Label data</span><select id="alLabel">' +
      ['EOD', 'Delayed', 'Real-time'].map(function (o) {
        return '<option' + (s.label_data === o ? ' selected' : '') + '>' + o + '</option>';
      }).join('') + '</select></label>');

    if (s.label_data !== 'Real-time') {
      L.push('<p class="nt-warn">Label <b>Real-time</b> hanya dipakai bila sumber intraday ' +
        'benar-benar tersedia. Tanpa itu sistem otomatis turun ke <b>Delayed/EOD</b> — ' +
        'harga tidak pernah diklaim real-time palsu.</p>');
    }

    L.push('<button class="nt-btn primary block" id="alSimpan">Simpan Pengaturan</button>');
    L.push('<p class="nt-muted">Jeda mencegah alert berulang untuk kondisi yang sama.</p>');
    L.push('</div>');

    // Corporate action
    L.push('<div class="nt-card">');
    L.push('<div class="nt-card-t">📄 Corporate Action</div>');
    if (!M.corporate || !M.corporate.length) {
      L.push('<div class="nt-muted">Data corporate action tidak tersedia.</div>');
    } else {
      M.corporate.slice(0, 8).forEach(function (c) {
        L.push('<div class="nt-kv"><b>' + esc(c.kode) + '</b> · ' + esc(c.judul || '—') + '</div>');
      });
    }
    L.push('</div>');

    // Riwayat alert
    L.push('<div class="nt-card">');
    L.push('<div class="nt-card-t">🕘 Riwayat Alert</div>');
    if (!M.log || !M.log.length) {
      L.push('<div class="nt-muted">Belum ada alert yang terkirim.</div>');
    } else {
      M.log.slice(0, 15).forEach(function (a) {
        L.push('<div class="nt-kv"><b>' + esc(a.kode) + '</b> · ' + fmt(a.harga) +
          ' · <span class="nt-muted">' + esc(a.alasan || '') + '</span></div>');
        L.push('<div class="nt-muted sm">' + esc(a.dikirim_pada || '') +
          ' · ' + esc(a.label_data || '') + '</div>');
      });
    }
    L.push('</div>');

    return L.join('');
  }

  /* ---------------------------------------------------------
     RENDER — aturan per saham
     --------------------------------------------------------- */

  function layarAturan() {
    var C = Core();
    var daftar = [];
    if (C && C.analisaSemua && M.pasar) {
      try { daftar = (C.analisaSemua(M.pasar).hasil) || []; } catch (e) { daftar = []; }
    }

    var L = [];
    L.push('<div class="nt-card">');
    L.push('<div class="nt-card-t">🎯 Alert per Saham</div>');
    L.push('<p class="nt-muted">Isi minimal satu ambang. Target dan batas rugi mengikuti ' +
      'hasil analisa — bisa kamu timpa.</p>');
    L.push('<button class="nt-btn primary block" id="alTambah">Tambah Alert Saham</button>');
    L.push('</div>');

    if (!M.watch || !M.watch.length) {
      L.push('<div class="nt-card"><div class="nt-muted">Belum ada aturan alert.</div></div>');
      return L.join('');
    }

    L.push('<div class="nt-card">');
    M.watch.forEach(function (a) {
      var ambang = [];
      if (a.harga_atas != null) ambang.push('di atas ' + fmt(a.harga_atas));
      if (a.harga_bawah != null) ambang.push('di bawah ' + fmt(a.harga_bawah));
      if (a.persen_naik != null) ambang.push('naik ' + a.persen_naik + '%');
      if (a.persen_turun != null) ambang.push('turun ' + a.persen_turun + '%');
      L.push('<div class="nt-alrow' + (a.aktif ? '' : ' off') + '">');
      L.push('<div class="nt-alrow-h"><b>' + esc(a.kode) + '</b>' +
        (a.aktif ? '<span class="nt-on">aktif</span>' : '<span class="nt-muted">nonaktif</span>') + '</div>');
      L.push('<div class="nt-muted sm">' + esc(ambang.join(' · ') || '—') + '</div>');
      L.push('<div class="nt-alrow-a">' +
        '<button class="nt-btn tiny" data-al-toggle="' + esc(a.kode) + '">' +
        (a.aktif ? 'Matikan' : 'Aktifkan') + '</button>' +
        '<button class="nt-btn tiny danger" data-al-del="' + esc(a.kode) + '">Hapus</button></div>');
      L.push('</div>');
    });
    L.push('</div>');

    return L.join('');
  }

  /* ---------------------------------------------------------
     RENDER — form tambah aturan
     --------------------------------------------------------- */

  function layarForm() {
    var C = Core();
    var daftar = [];
    if (C && C.analisaSemua && M.pasar) {
      try { daftar = (C.analisaSemua(M.pasar).hasil) || []; } catch (e) { daftar = []; }
    }

    var L = [];
    L.push('<div class="nt-card">');
    L.push('<div class="nt-card-t">Tambah Alert Saham</div>');
    if (!daftar.length) {
      L.push('<div class="nt-muted">Data pasar tidak tersedia.</div>');
      L.push('<button class="nt-btn block" id="alBatal">Kembali</button>');
      return L.join('');
    }

    L.push('<label class="nt-fld"><span>Saham</span><select id="afKode">' +
      daftar.map(function (a) {
        return '<option value="' + esc(a.kode) + '">' + esc(a.kode) + ' — ' + esc(a.nama || '') + '</option>';
      }).join('') + '</select></label>');

    L.push('<div class="nt-row2">');
    L.push('<label class="nt-fld"><span>Di atas Rp</span><input type="number" inputmode="numeric" id="afAtas" placeholder="Kosong = nonaktif"></label>');
    L.push('<label class="nt-fld"><span>Di bawah Rp</span><input type="number" inputmode="numeric" id="afBawah" placeholder="Kosong = nonaktif"></label>');
    L.push('</div>');

    L.push('<div class="nt-row2">');
    L.push('<label class="nt-fld"><span>Naik %</span><input type="number" inputmode="numeric" id="afNaik" placeholder="Kosong = nonaktif"></label>');
    L.push('<label class="nt-fld"><span>Turun %</span><input type="number" inputmode="numeric" id="afTurun" placeholder="Kosong = nonaktif"></label>');
    L.push('</div>');

    L.push('<div class="nt-row2">');
    L.push('<label class="nt-fld"><span>Target Rp</span><input type="number" inputmode="numeric" id="afTarget" placeholder="Otomatis dari analisa"></label>');
    L.push('<label class="nt-fld"><span>Batas rugi Rp</span><input type="number" inputmode="numeric" id="afSL" placeholder="Otomatis dari analisa"></label>');
    L.push('</div>');

    L.push('<p class="nt-warn">Minimal satu ambang wajib diisi. Kalau kosong semua, aturan ' +
      'tidak akan pernah dipicu.</p>');

    L.push('<button class="nt-btn primary block" id="afSimpan">Simpan Aturan</button>');
    L.push('<button class="nt-btn ghost block" id="afBatal">Batal</button>');
    L.push('</div>');
    return L.join('');
  }

  /* ---------------------------------------------------------
     RENDER
     --------------------------------------------------------- */

  function render() {
    var host = $('#ntScreen');
    if (!host) return;
    if (!M.pasar && !M.hasil) { /* biarkan render milik modul trader */ }
    var body;
    if (M.memuat && !M.settings) body = '<div class="nt-card"><div class="nt-muted">Memuat…</div></div>';
    else if (M.view === 'alert') body = layarPengaturan();
    else if (M.view === 'alert-saham') body = layarAturan();
    else body = layarForm();
    host.innerHTML = body;
    var sub = $('#ntBarSub');
    if (sub) {
      sub.textContent = M.view === 'alert' ? 'Notifikasi Telegram'
        : M.view === 'alert-saham' ? 'Alert per Saham' : 'Tambah Alert';
    }
    host.scrollTop = 0;
    bind();
  }

  /* ---------------------------------------------------------
     BIND
     --------------------------------------------------------- */

  function bind() {
    var S = $('#alSimpan');
    if (S) S.addEventListener('click', function () {
      var aktif = $('#alAktif') ? $('#alAktif').checked : false;
      simpanSettings({
        aktif: aktif,
        jam_aktif_start: ($('#alMulai') || {}).value || '09:00',
        jam_aktif_end: ($('#alSelesai') || {}).value || '15:30',
        jeda_menit: Number(($('#alJedaM') || {}).value || 0),
        jeda_persen: Number(($('#alJedaP') || {}).value || 0),
        label_data: ($('#alLabel') || {}).value || 'EOD',
      });
    });

    var T = $('#alTambah');
    if (T) T.addEventListener('click', function () { M.view = 'alert-saham2'; M.galat = ''; render(); });

    var x = w.document.querySelectorAll('[data-al-del]');
    for (var i = 0; i < x.length; i++) {
      x[i].addEventListener('click', function (e) {
        hapusAturan(e.currentTarget.getAttribute('data-al-del'));
      });
    }

    var t = w.document.querySelectorAll('[data-al-toggle]');
    for (var j = 0; j < t.length; j++) {
      t[j].addEventListener('click', function (e) {
        var kode = e.currentTarget.getAttribute('data-al-toggle');
        var cur = null;
        M.watch.forEach(function (a) { if (a.kode === kode) cur = a; });
        if (!cur) return;
        simpanAturan({
          kode: kode,
          aktif: !cur.aktif,
          harga_atas: cur.harga_atas, harga_bawah: cur.harga_bawah,
          persen_naik: cur.persen_naik, persen_turun: cur.persen_turun,
          harga_target: cur.harga_target, harga_batas_rugi: cur.harga_batas_rugi,
        });
      });
    }

    var FS = $('#afSimpan');
    if (FS) FS.addEventListener('click', function () {
      var body = {
        kode: ($('#afKode') || {}).value,
        harga_atas: numOrNull(($('#afAtas') || {}).value),
        harga_bawah: numOrNull(($('#afBawah') || {}).value),
        persen_naik: numOrNull(($('#afNaik') || {}).value),
        persen_turun: numOrNull(($('#afTurun') || {}).value),
        harga_target: numOrNull(($('#afTarget') || {}).value),
        harga_batas_rugi: numOrNull(($('#afSL') || {}).value),
        aktif: true,
      };
      if (!body.kode) { M.galat = 'Pilih saham dulu'; render(); return; }
      simpanAturan(body);
    });

    var B = $('#afBatal');
    if (B) B.addEventListener('click', function () { M.view = 'alert'; M.galat = ''; render(); });
  }

  function numOrNull(v) {
    if (v === null || v === undefined || String(v).trim() === '') return null;
    var n = Number(String(v).replace(/[^0-9.\-]/g, ''));
    return isFinite(n) ? n : null;
  }

  /* ---------------------------------------------------------
     API publik
     --------------------------------------------------------- */

  function open() {
    M.view = 'alert'; M.galat = ''; M.pesan = '';
    muat();
  }

  function setPasar(pasar) { M.pasar = pasar; }

  w.NavaTraderAlert = {
    open: open,
    setPasar: setPasar,
    render: render,
    muat: muat,
    _state: M,
  };

})(typeof window !== 'undefined' ? window : this);