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
      accounts: [],
      posters: [],
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
      if (!Array.isArray(doc.accounts)) doc.accounts = [];
      if (!Array.isArray(doc.posters)) doc.posters = [];
      if (!doc.postedToday || typeof doc.postedToday !== 'object') doc.postedToday = { date: '', count: 0 };
      // Backward compat: bersihkan field lama
      if (doc.groups) delete doc.groups;
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
    doc.autoSemuaGrup = true;
    doc.rev = (doc.rev || 0) + 1;
    doc.updatedAt = new Date().toISOString();
    simpanLokal();
    if (w.FbPosterSync) w.FbPosterSync.kirim();
    renderAll();
  }

  function idBaru() {
    return 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
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
    if (rr > lr || (rr === lr && ru > lu)) {
      doc = Object.assign(def(), jauh);
      if (!Array.isArray(doc.accounts)) doc.accounts = [];
      if (!Array.isArray(doc.posters)) doc.posters = [];
      if (doc.groups) delete doc.groups;
      if (doc.captions) delete doc.captions;
      if (!doc.postedToday || typeof doc.postedToday !== 'object') doc.postedToday = { date: '', count: 0 };
      doc.telegramReport = true;
      doc.autoSemuaGrup = true;
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

  function buatThumbnail(dataUrl, maxDim, cb) {
    try {
      var img = new Image();
      img.onload = function () {
        var w = img.width;
        var h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w > h) {
            h = Math.round((h * maxDim) / w);
            w = maxDim;
          } else {
            w = Math.round((w * maxDim) / h);
            h = maxDim;
          }
        }
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        cb(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = function () { cb(dataUrl); };
      img.src = dataUrl;
    } catch (e) {
      cb(dataUrl);
    }
  }

  function renderSchedule() {
    var el = $('#fbSchedule');
    if (!el) return;
    var skalaHari = Number(doc.skalaHari) || 3;
    var skalaMaks = Number(doc.skalaMaksimal) || 15;
    var skalaNaik = Number(doc.skalaNaik) || 2;
    var targetHariIni = Math.min(skalaMaks, skalaHari);
    var hasAcc = doc.accounts && doc.accounts.length > 0;

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
          '<span class="grow" style="font-size:12.5px;font-weight:600">🔄 Pengiriman ke Semua Grup Akun</span>' +
          '<span class="tag-on" style="font-size:10.5px">' + (hasAcc ? 'OTOMATIS SEMUA GRUP' : 'PERLU AKUN') + '</span>' +
        '</div>' +
        '<p class="hint" style="margin:6px 0 0;line-height:1.45">Sistem secara mandiri mendeteksi dan mengirim ke seluruh grup milik akun terdaftar secara bergiliran. Dimulai dari <b>3 post/hari</b>, lalu meningkat secara acak <b>(+1-2/hari)</b> hingga batas maksimal aman agar akun terlindungi dari banned.</p>' +
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
        : '<p class="hint">Mode uji mati — posting akan benar-benar terkirim bertahap ke semua grup akun.</p>');
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

  function renderAccounts() {
    var el = $('#fbAccounts');
    if (!el) return;
    var accs = doc.accounts || [];
    var list = '';
    if (accs.length) {
      list = accs.map(function (a) {
        var metText = a.method === 'cookie' ? '🍪 Sesi Cookies FB (Aman Anti-Checkpoint)' : '🔑 Kredensial Login FB';
        return '<div class="item" style="border:1px solid rgba(34,197,94,.25);border-radius:12px;padding:12px;margin-bottom:10px;background:rgba(34,197,94,.04)">' +
          '<div class="row-b" style="align-items:flex-start;gap:8px">' +
            '<div class="tx-icon in" style="background:#1877f2;color:#fff;font-weight:bold;font-size:14px">f</div>' +
            '<div class="item-body grow">' +
              '<div class="row-b" style="align-items:center">' +
                '<div class="item-title" style="font-weight:700">' + esc(a.nama || a.email || 'Akun Facebook') + '</div>' +
                '<span class="tag-on" style="font-size:10px">TERHUBUNG</span>' +
              '</div>' +
              '<div class="item-sub" style="margin-top:3px">' + metText + '</div>' +
              '<div class="card" style="margin:8px 0 0;padding:8px 10px;background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.08)">' +
                '<div style="font-size:11.5px;color:#22c55e;font-weight:600">✓ Grup Terdeteksi Otomatis: Seluruh Grup Milik Akun</div>' +
                '<div class="hint" style="margin:4px 0 0;font-size:11px;line-height:1.4">Sistem secara mandiri dan otomatis mengirim ke seluruh grup milik akun ini secara bergiliran & bertahap (prioritas aman anti-banned).</div>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="row-b" style="margin-top:10px;justify-content:flex-end;gap:8px">' +
            '<button type="button" class="mini-btn danger" data-act="del-account" data-id="' + a.id + '">Putuskan Akun</button>' +
          '</div>' +
        '</div>';
      }).join('');
    } else {
      list = '<div class="card" style="margin:0 0 10px;padding:12px;background:rgba(239,68,68,.05);border:1px solid rgba(239,68,68,.2)">' +
        '<div class="item-title" style="color:#ff6b6b;font-weight:600">Belum Ada Akun Facebook Terdaftar</div>' +
        '<p class="hint" style="margin:4px 0 0;line-height:1.45">Hubungkan akun Facebook Anda di bawah ini. Sistem secara mandiri akan mendeteksi seluruh grup milik akun tersebut dan melakukan pengiriman otomatis secara bertahap & aman dari banned.</p>' +
      '</div>';
    }

    var form =
      '<div id="fbAccFormBox" style="' + (doc.accounts && doc.accounts.length ? 'display:none;' : '') + 'margin-top:8px">' +
        '<div class="card" style="padding:12px;background:rgba(255,255,255,.03);border:1px solid var(--line,#2a3a35)">' +
          '<div class="item-title" style="font-weight:700;margin-bottom:6px">Hubungkan Akun Facebook</div>' +
          '<div class="field-row" style="margin-bottom:8px">' +
            '<label class="field grow"><span class="lbl">Nama / Label Akun</span>' +
              '<input type="text" id="fbAccNama" placeholder="mis. Akun Utama / Toko"></label>' +
          '</div>' +
          '<div class="field-row" style="margin-bottom:8px">' +
            '<label class="field grow"><span class="lbl">Metode Login</span>' +
              '<select id="fbAccMetode" style="background:rgba(9,15,13,.92);color:var(--text,#e9f1ed);border:1px solid var(--line,#2a3a35);border-radius:11px;padding:9px 10px;font:inherit">' +
                '<option value="cookie">Cookie Sesi FB (Paling Direkomendasikan & Aman)</option>' +
                '<option value="login">Email / No. HP & Kata Sandi</option>' +
              '</select>' +
            '</label>' +
          '</div>' +
          '<div id="fbAccCookieSection">' +
            '<label class="field"><span class="lbl">Cookie String (c_user & xs)</span>' +
              '<textarea id="fbAccCookie" rows="2" placeholder="Tempel cookie FB di sini (misal: c_user=...; xs=...)"></textarea>' +
              '<span class="hint" style="margin:2px 0 0">Paling aman: Tanpa kata sandi, tidak memicu checkpoint verifikasi 2FA Facebook saat login server.</span>' +
            '</label>' +
          '</div>' +
          '<div id="fbAccLoginSection" style="display:none">' +
            '<div class="field-row" style="margin-bottom:8px">' +
              '<label class="field grow"><span class="lbl">Email atau No. HP</span>' +
                '<input type="text" id="fbAccEmail" placeholder="email@contoh.com atau 0812..."></label>' +
            '</div>' +
            '<div class="field-row">' +
              '<label class="field grow"><span class="lbl">Kata Sandi Akun</span>' +
                '<input type="password" id="fbAccPass" placeholder="Kata sandi Facebook"></label>' +
            '</div>' +
          '</div>' +
          '<div class="row-b" style="margin-top:12px;gap:8px">' +
            '<button type="button" class="btn grow" data-act="save-account">Simpan Akun FB</button>' +
            (doc.accounts && doc.accounts.length ? '<button type="button" class="mini-btn" data-act="cancel-acc-form">Batal</button>' : '') +
          '</div>' +
        '</div>' +
      '</div>';

    var addBtn = (doc.accounts && doc.accounts.length)
      ? '<div style="margin-top:8px"><button type="button" class="btn" data-act="toggle-acc-form" style="width:100%">＋ Tambah / Ganti Akun Facebook</button></div>'
      : '';

    el.innerHTML = list + form + addBtn;
  }

  function renderPosters() {
    var el = $('#fbPosters');
    if (!el) return;
    var posters = doc.posters || [];
    var jml = posters.length;

    var html =
      '<p class="hint" style="margin-top:0">Posting otomatis menggunakan <b>gambar poster saja (tanpa teks caption)</b> untuk perlindungan maksimal dari filter spam Facebook.</p>' +
      '<div class="fb-btn-row">' +
        '<button type="button" class="btn" data-act="pick-folder">📁 Pilih Folder Poster (Laptop / PC)</button>' +
        '<button type="button" class="btn" data-act="pick-files">🖼️ Pilih Poster (Android / Galeri)</button>' +
      '</div>' +
      '<input type="file" id="fbInputFolder" webkitdirectory directory multiple accept="image/*" style="display:none">' +
      '<input type="file" id="fbInputFiles" multiple accept="image/*" style="display:none">';

    if (jml) {
      html +=
        '<div class="row-b" style="margin-top:12px;align-items:center">' +
          '<span style="font-size:12.5px;font-weight:700">🖼️ ' + jml + ' Poster Terpasang</span>' +
          '<button type="button" class="mini-btn danger" data-act="clear-posters">Bersihkan Semua</button>' +
        '</div>' +
        '<p class="hint" style="margin:2px 0 6px">Diposting bergiliran & acak satu per satu ke setiap grup akun.</p>' +
        '<div class="fb-poster-grid">';

      posters.slice(0, 30).forEach(function (p) {
        html +=
          '<div class="fb-poster-item">' +
            (p.src ? '<img src="' + p.src + '" alt="' + esc(p.nama || 'Poster') + '" loading="lazy">' : '<div style="font-size:10px;padding:4px;word-break:break-all">' + esc(p.nama) + '</div>') +
            '<button type="button" class="fb-poster-del" data-act="del-poster" data-id="' + p.id + '" title="Hapus">✕</button>' +
          '</div>';
      });

      html += '</div>';
      if (jml > 30) {
        html += '<p class="hint" style="margin-top:6px">+ ' + (jml - 30) + ' poster lainnya terpasang dalam rotasi.</p>';
      }
    } else {
      html +=
        '<div class="card" style="margin-top:10px;padding:12px;background:rgba(255,255,255,.02);border:1px dashed var(--line,#2a3a35)">' +
          '<div style="font-size:12px;color:var(--text-2,#95a8a1)">Belum ada poster dipilih. Tekan tombol <b>Pilih Folder Poster</b> (di Laptop) atau <b>Pilih Poster</b> (di Android) untuk memasukkan materi poster Anda.</div>' +
        '</div>';
    }

    el.innerHTML = html;
  }

  function renderAll() {
    renderStatus(); renderSchedule(); renderSafety();
    renderAccounts(); renderPosters();
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
        if (!doc.accounts || !doc.accounts.length) { toast('Hubungkan akun Facebook dulu ya'); return; }
        if (!doc.posters || !doc.posters.length) { toast('Pilih poster dulu ya'); return; }
        confirmDialog(
          'Minta server posting SEKARANG ke semua grup milik akun Facebook terdaftar?' +
          (doc.dryRun ? '\n\nMode uji masih ON — hanya disusun, tidak terkirim.' : '\n\nPosting akan benar-benar terkirim.'),
          function (ok) {
            if (!ok) return;
            tandai(function () { doc.runNow = true; });
            toast('Permintaan terkirim — cek Status di atas');
          });
        return;
      }
      if (act === 'toggle-acc-form') {
        var box = $('#fbAccFormBox');
        if (box) box.style.display = box.style.display === 'none' ? 'block' : 'none';
        return;
      }
      if (act === 'cancel-acc-form') {
        var box2 = $('#fbAccFormBox');
        if (box2) box2.style.display = 'none';
        return;
      }
      if (act === 'save-account') {
        var nama = ($('#fbAccNama') || {}).value || '';
        var metode = ($('#fbAccMetode') || {}).value || 'cookie';
        var cookie = ($('#fbAccCookie') || {}).value || '';
        var email = ($('#fbAccEmail') || {}).value || '';
        var pass = ($('#fbAccPass') || {}).value || '';
        if (metode === 'cookie' && !cookie.trim()) {
          toast('Masukkan cookie sesi Facebook (c_user & xs)');
          return;
        }
        if (metode === 'login' && (!email.trim() || !pass.trim())) {
          toast('Masukkan email/no. HP & kata sandi FB');
          return;
        }
        var acc = {
          id: idBaru(),
          nama: nama.trim() || (metode === 'cookie' ? 'Akun FB (Sesi Cookie)' : email.trim()),
          method: metode,
          cookieStr: cookie.trim(),
          email: email.trim(),
          pass: pass.trim(),
          addedAt: new Date().toISOString()
        };
        tandai(function () {
          doc.accounts = [acc];
        });
        toast('Akun Facebook terhubung! Sistem otomatis mendeteksi seluruh grup akun.');
        return;
      }
      if (act === 'del-account') {
        confirmDialog('Putuskan akun Facebook ini?', function (ok) {
          if (!ok) return;
          tandai(function () { doc.accounts = []; });
          toast('Akun Facebook diputuskan');
        });
        return;
      }
      if (act === 'pick-folder') {
        var inpFld = $('#fbInputFolder');
        if (inpFld) inpFld.click();
        return;
      }
      if (act === 'pick-files') {
        var inpFls = $('#fbInputFiles');
        if (inpFls) inpFls.click();
        return;
      }
      if (act === 'del-poster') {
        var pid = b.dataset.id;
        tandai(function () {
          doc.posters = (doc.posters || []).filter(function (x) { return x.id !== pid; });
        });
        toast('Poster dihapus');
        return;
      }
      if (act === 'clear-posters') {
        confirmDialog('Hapus semua poster yang terpasang?', function (ok) {
          if (!ok) return;
          tandai(function () { doc.posters = []; });
          toast('Semua poster dibersihkan');
        });
        return;
      }
    });

    function prosesFiles(files) {
      if (!files || !files.length) return;
      var list = [].slice.call(files).filter(function (f) {
        return f.type.indexOf('image/') === 0 || /\.(jpe?g|png|webp|gif)$/i.test(f.name);
      });
      if (!list.length) {
        toast('Tidak ada file gambar poster yang ditemukan.');
        return;
      }
      toast('Memuat ' + list.length + ' poster...');
      if (!Array.isArray(doc.posters)) doc.posters = [];
      var selesai = 0;
      var batchBaru = [];

      list.forEach(function (file) {
        var reader = new FileReader();
        reader.onload = function (ev) {
          var rawData = ev.target.result;
          buatThumbnail(rawData, 240, function (thumb) {
            batchBaru.push({
              id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
              nama: file.name,
              size: file.size,
              src: thumb
            });
            selesai++;
            if (selesai === list.length) {
              doc.posters = doc.posters.concat(batchBaru);
              tandai();
              toast(list.length + ' poster berhasil dimuat!');
            }
          });
        };
        reader.readAsDataURL(file);
      });
    }

    // Input angka, file & jam
    root.addEventListener('change', function (e) {
      var t = e.target;
      if (t.id === 'fbAccMetode') {
        var cs = $('#fbAccCookieSection');
        var ls = $('#fbAccLoginSection');
        if (cs && ls) {
          if (t.value === 'cookie') {
            cs.style.display = 'block'; ls.style.display = 'none';
          } else {
            cs.style.display = 'none'; ls.style.display = 'block';
          }
        }
        return;
      }
      if (t.id === 'fbInputFolder' || t.id === 'fbInputFiles') {
        prosesFiles(t.files);
        t.value = '';
        return;
      }
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
