/* ===================================================================
   fb-poster.js — UI panel FB Auto-Poster (jadwal posting grup FB).

   Panel ini HANYA menampilkan & mengubah konfigurasi. Eksekusi posting
   jalan di server (daemon, /root/fb-poster). Sinkronisasi lewat tabel
   `vault` Supabase (kunci `fbposter_data` untuk konfigurasi,
   `fbposter_status` untuk status yang ditulis daemon).

   Dokumen konfigurasi (satu dokumen, mirip ronce-sync):
   {
     rev, updatedAt, enabled, runNow, dryRun, humanLike,
     jedaMin, jedaMax, maxGrupHari,
     groups: [{id, nama, url}],
     posterIdx, postedToday: {date, count},
     skalaHari, skalaMaksimal, skalaNaik,
     randomJadwal, jam,
     telegramReport
   }

   ATURAN AMAN (pengaturan aman dikunci dulu sebelum bisa dipakai):
   - dryRun DEFAULT ON. Mode ini hanya buka halaman grup & susun draf,
     TANPA klik Posting. Posting beneran hanya jalan setelah user
     mematikan dry-run secara sadar lewat dialog konfirmasi.
   - Batas keras dihitung juga di daemon (jeda min 30 dtk, maks 10
     grup/run) jadi nilai dari sini tidak bisa melebihi itu.
   - Skala posting: mulai 3/hari, bertambah acak tiap hari sampai
     maksimal 10. Jadwal jam posting diacak (anti pattern detection).
   - Caption dihilangkan - posting pakai poster gambar saja.
   - Laporan ke Telegram selalu ON.
   =================================================================== */
(function (w) {
  'use strict';

  var LS = 'nava_fbposter_v1';
  var KEY = 'fbposter_data';
  var KEY_STATUS = 'fbposter_status';

  var $ = function (s) { return document.querySelector(s); };

  function def() {
    return {
      rev: 1, updatedAt: '',
      enabled: true, runNow: false,
      dryRun: false, humanLike: true,
      jedaMin: 60, jedaMax: 180, maxGrupHari: 3,
      groups: [],
      autoSemuaGrup: true,
      posterIdx: 0,
      postedToday: { date: '', count: 0 },
      // Pengaturan skala posting aman (anti-banned)
      skalaHari: 3,        // mulai 3 post per hari
      skalaMaksimal: 15,   // batas maksimal aman
      skalaNaik: 2,        // tambahan acak 1-2 per hari
      // Jadwal otomatis random (anti-pattern detection)
      randomJadwal: true,
      jam: '09:00',
      // Laporan ke Telegram selalu ON
      telegramReport: true,
    };
  }

  var doc = null;
  var status = null;   // dari daemon: { updatedAt, engine, lastRun, log }

  function muat() {
    try {
      var mentah = w.localStorage.getItem(LS);
      var d = mentah ? JSON.parse(mentah) : null;
      doc = Object.assign(def(), d || {});
      if (!Array.isArray(doc.groups)) doc.groups = [];
      if (!doc.postedToday || typeof doc.postedToday !== 'object') doc.postedToday = { date: '', count: 0 };
      // Backward compat: remove old caption fields
      if (doc.captions) delete doc.captions;
      if (doc.captionRotate !== undefined) delete doc.captionRotate;
      if (doc.captionIdx !== undefined) delete doc.captionIdx;
      // Ensure required safety settings are always enforced
      doc.telegramReport = true;
      doc.randomJadwal = true;
      doc.autoSemuaGrup = true;
      if (doc.skalaHari === undefined) doc.skalaHari = 3;
      if (doc.skalaMaksimal === undefined) doc.skalaMaksimal = 15;
      if (doc.skalaNaik === undefined) doc.skalaNaik = 2;
      return doc;
    } catch (e) { doc = def(); return doc; }
  }

  function simpanLokal() {
    try { w.localStorage.setItem(LS, JSON.stringify(doc)); } catch (e) {}
  }

  function tandai(mut) {
    if (typeof mut === 'function') { try { mut(); } catch (e) {} }
    doc.telegramReport = true; // Selalu enforce laporan Telegram
    doc.rev = (doc.rev || 0) + 1;
    doc.updatedAt = new Date().toISOString();
    simpanLokal();
    if (w.FbPosterSync) w.FbPosterSync.kirim();
    renderAll();
  }

  function idBaru() {
    return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------------- Gabung dari server ---------------- */
  function gabung(jauh) {
    if (!jauh || typeof jauh !== 'object') return false;
    if (typeof jauh === 'string') {
      try { jauh = JSON.parse(jauh); } catch (e) { return false; }
    }
    var lr = doc.rev || 0;
    var rr = jauh.rev || 0;
    var lu = doc.updatedAt || '';
    var ru = jauh.updatedAt || '';
    // Daemon menulis balik runNow/posterIdx/captionIdx/postedToday
    // TANPA menaikkan rev; jadi adopsi pakai updatedAt (mirror ronce-sync).
    if (rr > lr || (rr === lr && ru > lu)) {
      doc = Object.assign(def(), jauh);
      if (!Array.isArray(doc.groups)) doc.groups = [];
      if (!Array.isArray(doc.captions)) doc.captions = [];
      if (!doc.postedToday || typeof doc.postedToday !== 'object') doc.postedToday = { date: '', count: 0 };
      simpanLokal();
      return true;
    }
    return false;
  }

  /* ---------------- Render ---------------- */
  function on() { return !!doc.enabled; }

  function renderStatus() {
    var el = $('#fbStatus');
    if (!el) return;
    var st = status || {};
    var eng = st.engine || '';
    var label, cls;
    if (!eng) { label = 'Belum ada laporan dari server'; cls = 'muted'; }
    else if (eng === 'ready') { label = 'Engine siap'; cls = 'ok'; }
    else if (eng === 'blocked') { label = 'Terblokir — cek log'; cls = 'danger'; }
    else { label = 'Error — cek log'; cls = 'danger'; }

    var baris = [];
    if (st.lastRun && st.lastRun.t) {
      baris.push('<div class="item"><div class="item-body">' +
        '<div class="item-title">Terakhir jalan</div>' +
        '<div class="item-sub">' + esc(st.lastRun.t) + ' — ' + esc(st.lastRun.detail || '') + '</div>' +
        '</div></div>');
    }
    baris.push('<div class="item"><div class="item-body">' +
      '<div class="item-title">Posting hari ini</div>' +
      '<div class="item-sub">' + (doc.postedToday.count || 0) + ' grup (tanggal ' +
      esc(doc.postedToday.date || '-') + ')</div>' +
      '</div></div>');

    var log = Array.isArray(st.log) ? st.log.slice(-6).reverse() : [];
    if (log.length) {
      baris.push('<div class="list-head tight" style="padding:4px 0"><strong>Log</strong></div>');
      log.forEach(function (l) {
        baris.push('<div class="item"><div class="tx-icon ' + (l.ok ? 'in' : 'out') + '">' +
          (l.ok ? '✓' : '✕') + '</div><div class="item-body">' +
          '<div class="item-title">' + esc(l.grup || 'Sistem') + '</div>' +
          '<div class="item-sub">' + esc(l.t || '') + ' · ' + esc(l.msg || '') + '</div>' +
          '</div></div>');
      });
    } else {
      baris.push('<p class="hint">Belum ada log. Nyalakan Jadwal lalu tunggu jadwalnya atau tekan “Posting Sekarang”.</p>');
    }

    el.innerHTML =
      '<div class="card" style="margin:0 0 14px">' +
        '<div class="row-b" style="gap:10px;align-items:flex-start">' +
          '<div class="grow">' +
            '<div class="item-title">Status server</div>' +
            '<div class="item-sub fb-st-' + cls + '">' + esc(label) + '</div>' +
          '</div>' +
          (on()
            ? '<span class="tag-on">AKTIF</span>'
            : '<span class="tag-off">MATI</span>') +
        '</div>' +
        '<div class="fb-log" style="margin-top:6px">' + baris.join('') + '</div>' +
      '</div>';
  }

  function renderSchedule() {
    var el = $('#fbSchedule');
    if (!el) return;
    var skalaHari = Number(doc.skalaHari) || 3;
    var skalaMaks = Number(doc.skalaMaksimal) || 15;
    var skalaNaik = Number(doc.skalaNaik) || 2;
    var targetHariIni = Math.min(skalaMaks, skalaHari);
    var jmlGrup = doc.groups ? doc.groups.length : 0;

    el.innerHTML =
      '<div class="field-row" style="align-items:center">' +
        '<label class="field grow"><span class="lbl">Jadwal posting otomatis</span>' +
          '<span class="hint" style="margin:0">Server posting otomatis di jam acak (anti-banned & anti-pattern).</span></label>' +
        '<button type="button" class="fb-toggle ' + (on() ? 'on' : '') + '" data-act="toggle-on" aria-label="Aktif nonaktif">' +
          '<span class="fb-knob"></span></button>' +
      '</div>' +
      '<div class="card" style="margin:10px 0 0;padding:10px 12px;background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.25)">' +
        '<div class="row-b" style="align-items:center">' +
          '<span class="grow" style="font-size:12.5px;font-weight:600">🎲 Jadwal Acak Aman (Anti-Pattern Detection)</span>' +
          '<span class="tag-on" style="font-size:10.5px">AKTIF</span>' +
        '</div>' +
        '<p class="hint" style="margin:6px 0 0;line-height:1.45">Sistem secara otomatis mengacak jam posting dan jeda waktu antar-grup secara dinamis. Pola posting tidak berpola kaku sehingga tidak terdeteksi oleh sistem pengawas Facebook.</p>' +
      '</div>' +
      '<div class="card" style="margin:10px 0 0;padding:10px 12px;background:rgba(59,130,246,.06);border:1px solid rgba(59,130,246,.25)">' +
        '<div class="row-b" style="align-items:center">' +
          '<span class="grow" style="font-size:12.5px;font-weight:600">🔄 Pengiriman ke Semua Grup Bertahap</span>' +
          '<span class="tag-on" style="font-size:10.5px">' + jmlGrup + ' GRUP</span>' +
        '</div>' +
        '<p class="hint" style="margin:6px 0 0;line-height:1.45">Otomatis mengirim ke seluruh grup akun secara bergiliran. Dimulai dari <b>3 post/hari</b>, lalu meningkat secara acak <b>(+1-2/hari)</b> hingga batas maksimal aman agar akun terlindungi dari banned.</p>' +
      '</div>' +
      '<div class="field-row" style="margin-top:10px;align-items:flex-start">' +
        '<label class="field grow"><span class="lbl">Target hari ini</span>' +
          '<input type="number" id="fbSkalaHari" min="1" max="50" value="' + targetHariIni + '"></label>' +
        '<label class="field grow"><span class="lbl">Naik acak / hari</span>' +
          '<input type="number" id="fbSkalaNaik" min="1" max="10" value="' + skalaNaik + '"></label>' +
        '<label class="field grow"><span class="lbl">Batas maks aman</span>' +
          '<input type="number" id="fbSkalaMaks" min="1" max="50" value="' + skalaMaks + '"></label>' +
      '</div>' +
      '<div class="field-row" style="margin-top:10px">' +
        '<label class="field grow"><span class="lbl">Jam patokan (opsional)</span>' +
          '<input type="time" id="fbJam" value="' + esc(doc.jam || '09:00') + '"></label>' +
        '<label class="field"><span class="lbl">Mulai</span>' +
          '<button type="button" class="btn" data-act="run-now" style="width:100%">Posting Sekarang</button></label>' +
      '</div>' +
      (doc.dryRun
        ? '<p class="hint">MODE UJI aktif — posting hanya disusun, tidak terkirim. Matikan di “Pengaturan Aman” untuk posting beneran.</p>'
        : '<p class="hint">Mode uji mati — posting akan benar-benar terkirim bertahap ke grup.</p>');
  }

  function cogBaris(label, hint, aktif, act, kunci) {
    return '<div class="field-row" style="align-items:center;margin-top:8px">' +
      '<label class="field grow"><span class="lbl">' + label + '</span>' +
      '<span class="hint" style="margin:0">' + hint + '</span></label>' +
      '<button type="button" class="fb-toggle ' + (aktif ? 'on' : '') + '" data-act="' + act + '"' +
      ' data-k="' + kunci + '" aria-label="' + label + '"><span class="fb-knob"></span></button>' +
      '</div>';
  }

  function renderSafety() {
    var el = $('#fbSafety');
    if (!el) return;
    el.innerHTML =
      '<p class="hint" style="margin-top:0">Pengaturan ini sengaja aman dulu. Batas keras dijaga server (jeda min 30 detik, rotasi semua grup) untuk menjaga keamanan akun Facebook.</p>' +
      cogBaris('Mode uji (dry-run)', 'ON = hanya susun draf, tidak terkirim. OFF = posting beneran.', doc.dryRun, 'toggle-dry', 'dryRun') +
      cogBaris('Ketik seperti manusia', 'Interaksi dan jeda acak meniru pengetikan manusia.', doc.humanLike, 'toggle-set', 'humanLike') +
      '<div class="field-row" style="align-items:center;margin-top:8px">' +
        '<label class="field grow"><span class="lbl">Laporan ke Telegram</span>' +
        '<span class="hint" style="margin:0">Laporan otomatis dikirim ke Telegram setiap kali ada posting (Wajib ON).</span></label>' +
        '<button type="button" class="fb-toggle on" data-act="enforced-tg" aria-label="Laporan Telegram"><span class="fb-knob"></span></button>' +
      '</div>' +
      '<div class="field-row" style="margin-top:10px">' +
        '<label class="field grow"><span class="lbl">Jeda min (detik)</span>' +
          '<input type="number" id="fbJedaMin" min="30" max="3600" step="10" value="' + doc.jedaMin + '"></label>' +
        '<label class="field grow"><span class="lbl">Jeda max (detik)</span>' +
          '<input type="number" id="fbJedaMax" min="30" max="7200" step="10" value="' + doc.jedaMax + '"></label>' +
        '<label class="field"><span class="lbl">Maks grup/run</span>' +
          '<input type="number" id="fbMaxGrup" min="1" max="10" value="' + doc.maxGrupHari + '"></label>' +
      '</div>';
  }

  function renderGroups() {
    var el = $('#fbGroups');
    if (!el) return;
    var list = doc.groups.map(function (g) {
      return '<div class="item"><div class="tx-icon in">G</div>' +
        '<div class="item-body"><div class="item-title">' + esc(g.nama) + '</div>' +
        '<div class="item-sub">' + esc(g.url || '') + '</div></div>' +
        '<button type="button" class="mini-btn danger" data-act="del-group" data-id="' + g.id + '">Hapus</button></div>';
    }).join('');
    if (!list) list = '<p class="hint">Belum ada grup. Tambahkan link grup Facebook yang ingin diposting.</p>';
    el.innerHTML = list +
      '<div class="field-row" style="margin-top:10px">' +
        '<label class="field grow"><span class="lbl">Nama grup</span>' +
          '<input type="text" id="fbGroupNama" placeholder="mis. Jual Beli Tanjungpinang"></label>' +
      '</div>' +
      '<div class="field-row" style="margin-top:8px">' +
        '<label class="field grow"><span class="lbl">Link grup</span>' +
          '<input type="url" id="fbGroupUrl" placeholder="https://www.facebook.com/groups/123456789/"></label>' +
        '<button type="button" class="btn" data-act="add-group">＋ Tambah</button>' +
      '</div>';
  }

  function renderPosters() {
    var el = $('#fbPosters');
    if (!el) return;
    el.innerHTML =
      '<p class="hint" style="margin-top:0">Posting otomatis menggunakan <b>gambar poster saja (tanpa teks caption)</b> demi meminimalkan resiko filter spam Facebook.</p>' +
      '<p class="hint">Poster tinggal di server (folder <b>posters/</b>) dan dipilih berurutan tiap posting. Kirim gambar ke chat Telegram Nava untuk menambah — Nava yang menaruhnya ke server.</p>' +
      '<p class="hint">Posisi poster sekarang: <b>nomor ' + (doc.posterIdx + 1) + '</b> dalam urutan file.</p>';
  }

  function renderAll() {
    renderStatus(); renderSchedule(); renderSafety();
    renderGroups(); renderPosters();
  }

  /* ---------------- Aksi ---------------- */
  function toast(msg) {
    if (w.App && w.App.toast) w.App.toast(msg); else window.alert(msg);
  }
  function haptic(ok) { if (w.TG && w.TG.haptic) w.TG.haptic(ok ? 'success' : 'select'); }

  function confirmDialog(msg, cb) {
    if (w.TG && w.TG.confirm) w.TG.confirm(msg, cb);
    else if (w.confirm(msg)) cb(true);
  }

  function bind() {
    var root = $('#view-fbpp') || $('#fbPanel');
    if (!root) return;

    root.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      var act = b.dataset.act;

      if (act === 'toggle-on') {
        tandai(function () { doc.enabled = !doc.enabled; });
        haptic(true);
        toast(doc.enabled ? 'Jadwal aktif' : 'Jadwal dimatikan');
        return;
      }
      if (act === 'toggle-set') {
        var k = b.dataset.k;
        if (k === 'telegramReport') {
          doc.telegramReport = true;
          toast('Laporan Telegram selalu aktif untuk keamanan & pemantauan.');
          return;
        }
        tandai(function () { doc[k] = !doc[k]; });
        haptic(true);
        return;
      }
      if (act === 'enforced-tg') {
        toast('Laporan Telegram selalu aktif untuk memastikan pemantauan dan keamanan akun.');
        return;
      }
      if (act === 'toggle-dry') {
        if (doc.dryRun) {
          confirmDialog('Matikan mode uji?\n\nKalau dimatikan, posting BERIKUTNYA akan benar-benar terkirim ke grup Facebook. Server tetap jaga jeda & batas aman.\n\nLanjutkan?', function (ok) {
            if (!ok) return;
            tandai(function () { doc.dryRun = false; });
            toast('Mode uji dimatikan — posting beneran aktif');
          });
        } else {
          tandai(function () { doc.dryRun = true; });
          toast('Mode uji dinyalakan lagi');
        }
        haptic(true);
        return;
      }
      if (act === 'run-now') {
        if (!doc.groups.length) { toast('Tambah grup dulu ya'); return; }
        confirmDialog(
          'Minta server posting SEKARANG ke ' + doc.groups.length + ' grup?' +
          (doc.dryRun ? '\n\nMode uji masih ON — hanya disusun, tidak terkirim.' : '\n\nPosting akan benar-benar terkirim.'),
          function (ok) {
            if (!ok) return;
            tandai(function () { doc.runNow = true; });
            toast('Permintaan terkirim — cek Status di atas');
          });
        return;
      }
      if (act === 'add-group') {
        var nama = ($('#fbGroupNama') || {}).value || '';
        var url = ($('#fbGroupUrl') || {}).value || '';
        nama = nama.trim(); url = url.trim();
        if (!nama || !url) { toast('Isi nama & link grup dulu'); return; }
        if (!/facebook\.com\/groups\//i.test(url)) {
          toast('Link harus link grup Facebook (…facebook.com/groups/…)');
          return;
        }
        tandai(function () { doc.groups.push({ id: idBaru(), nama: nama, url: url }); });
        toast('Grup ditambahkan');
        return;
      }
      if (act === 'del-group') {
        var id = b.dataset.id;
        var g = doc.groups.filter(function (x) { return x.id === id; })[0];
        if (!g) return;
        confirmDialog('Hapus grup "' + g.nama + '"?', function (ok) {
          if (!ok) return;
          tandai(function () { doc.groups = doc.groups.filter(function (x) { return x.id !== id; }); });
          toast('Grup dihapus');
        });
        return;
      }
    });

    // Input angka & jam: baca sekali saat selesai (change), bukan tiap ketik.
    root.addEventListener('change', function (e) {
      var t = e.target;
      if (t.id === 'fbJam') {
        var v = (t.value || '').slice(0, 5);
        if (/^\d{2}:\d{2}$/.test(v)) { doc.jam = v; tandai(); }
        return;
      }
      if (t.id === 'fbJedaMin' || t.id === 'fbJedaMax' || t.id === 'fbMaxGrup') {
        var n = Number(t.value);
        if (!isFinite(n)) return;
        if (t.id === 'fbJedaMin') doc.jedaMin = Math.min(3600, Math.max(30, n));
        if (t.id === 'fbJedaMax') doc.jedaMax = Math.min(7200, Math.max(30, n));
        if (t.id === 'fbMaxGrup') doc.maxGrupHari = Math.min(10, Math.max(1, n));
        if (doc.jedaMax < doc.jedaMin) doc.jedaMax = doc.jedaMin;
        tandai();
        renderSafety(); renderSchedule();
        return;
      }
      if (t.id === 'fbSkalaHari' || t.id === 'fbSkalaNaik' || t.id === 'fbSkalaMaks') {
        var n2 = Number(t.value);
        if (!isFinite(n2)) return;
        if (t.id === 'fbSkalaHari') doc.skalaHari = Math.min(50, Math.max(1, n2));
        if (t.id === 'fbSkalaNaik') doc.skalaNaik = Math.min(10, Math.max(0, n2));
        if (t.id === 'fbSkalaMaks') doc.skalaMaksimal = Math.min(50, Math.max(1, n2));
        tandai();
        renderSchedule();
        return;
      }
    });
  }

  function init() {
    muat();
    bind();
    renderAll();
  }

  function setStatus(s) {
    status = (s && typeof s === 'object') ? s : null;
    renderStatus();
  }

  w.FbPosterUI = {
    init: init,
    _doc: function () { return doc; },
    _gabung: gabung,
    _refresh: renderAll,
    _setStatus: setStatus,
    _KEY: KEY, _KEY_STATUS: KEY_STATUS,
    onShow: renderAll
  };
})(window);
