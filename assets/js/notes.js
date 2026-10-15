/* =========================================================
   notes.js — Catatan pengingat (teks + voice note)
   ========================================================= */
(function (w) {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var S = w.Store, TG = w.TG, Voice = w.Voice, AudioDB = S.AudioDB, Notes = S.Notes;

  var el = {};
  var filter = 'all';
  var pendingAudio = null;   // {blob, dur, url}
  var fired = {};            // id => sudah dikasih notif
  var inSheet = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtDate(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    if (isNaN(d)) return '';
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    var time = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    if (sameDay) return 'Hari ini ' + time;
    var opt = { weekday: 'short', day: 'numeric', month: 'short' };
    return d.toLocaleDateString('id-ID', opt) + ' ' + time;
  }

  function relDue(n) {
    if (!n.remindAt) return null;
    var due = new Date(n.remindAt);
    if (isNaN(due)) return null;
    var lead = (n.leadMin || 0) * 60000;
    var fireAt = new Date(due.getTime() - lead);
    return { due: due, fireAt: fireAt };
  }

  /* ---------------- Audio helpers ---------------- */
  function setPending(blob, dur) {
    if (pendingAudio && pendingAudio.url) URL.revokeObjectURL(pendingAudio.url);
    pendingAudio = { blob: blob, dur: dur, url: URL.createObjectURL(blob) };
    el.preview.classList.remove('hidden');
    el.prevLabel.textContent = 'Rekaman ' + fmt(dur);
  }
  function clearPending() {
    if (pendingAudio && pendingAudio.url) URL.revokeObjectURL(pendingAudio.url);
    pendingAudio = null;
    el.preview.classList.add('hidden');
    el.icoPlay.classList.remove('hidden');
    el.icoPause.classList.add('hidden');
  }

  /* ---------------- Render ---------------- */
  function matches(n) {
    if (filter === 'done') return n.done;
    if (filter === 'pending') return !n.done;
    if (filter === 'today') {
      if (n.done) return false;
      if (n.remindAt) {
        var d = new Date(n.remindAt);
        if (!isNaN(d) && d.toDateString() === new Date().toDateString()) return true;
      }
      var c = (n.createdAt || '').slice(0, 10);
      return c === S.todayStr();
    }
    return true;
  }

  function audioBlock(n) {
    if (!n.audioId) return '';
    var m = n.audioMeta || {};
    var dur = m.dur || 0;
    return '<div class="item-audio" data-audio="' + esc(n.id) + '">' +
      '<button class="mini-btn" data-play="' + esc(n.id) + '">▶ Putar</button>' +
      '<span>Voice note' + (dur ? ' · ' + fmt(dur) : '') + '</span>' +
      '</div>';
  }

  function render() {
    var list = S.Notes.all().filter(matches);
    list.sort(function (a, b) {
      if (!!a.done !== !!b.done) return a.done ? 1 : -1;
      if (a.remindAt && b.remindAt) return new Date(a.remindAt) - new Date(b.remindAt);
      if (a.remindAt) return -1;
      if (b.remindAt) return 1;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    var dueNow = countDue();
    updateBadge(dueNow);

    if (!list.length) {
      el.list.innerHTML = '<div class="empty"><b>Belum ada catatan</b>' +
        'Catat cepat di atas, atau tekan <b>Rekam</b> untuk making voice note pengingat.</div>';
      return;
    }

    el.list.innerHTML = list.map(function (n) {
      var d = relDue(n);
      var overdue = d && !n.done && d.fireAt <= new Date();
      var soon = d && !n.done && d.fireAt > new Date() && d.fireAt - new Date() < 3600000;
      var cls = 'item' + (n.done ? ' done' : '') + (overdue ? ' due' : '');
      var sub = [];
      if (d) {
        var rep = { none: '', daily: ' · harian', weekly: ' · mingguan', biweekly: ' · 2 mingguan',
          monthly: ' · bulanan', yearly: ' · tahunan' }[n.repeat] || '';
        sub.push('<span class="tag' + (overdue ? ' danger' : soon ? ' warn' : '') + '">⏰ ' +
          esc(fmtDate(n.remindAt)) + esc(rep) + '</span>');
      } else {
        sub.push('<span class="tag">📝 ' + esc(fmtDate(n.createdAt) || 'catatan') + '</span>');
      }
      return '<div class="' + cls + '" data-id="' + esc(n.id) + '">' +
        '<button class="chk' + (n.done ? ' on' : '') + '" data-toggle="' + esc(n.id) + '" aria-label="Selesai">' +
        '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>' +
        '</button>' +
        '<div class="item-body">' +
        (n.text ? '<div class="item-title">' + esc(n.text) + '</div>' : '') +
        audioBlock(n) +
        '<div class="item-sub">' + sub.join('') + '</div>' +
        '</div>' +
        '<div class="item-actions">' +
        '<button class="icon-btn sm" data-edit="' + esc(n.id) + '" aria-label="Ubah">✎</button>' +
        '<button class="icon-btn sm" data-del="' + esc(n.id) + '" aria-label="Hapus">🗑</button>' +
        '</div></div>';
    }).join('');
  }

  function countDue() {
    var now = new Date(), c = 0;
    S.Notes.all().forEach(function (n) {
      if (n.done) return;
      var d = relDue(n);
      if (d && d.fireAt <= now) c++;
    });
    return c;
  }

  function updateBadge(n) {
    if (!el.badge) return;
    el.badge.textContent = n;
    el.badge.classList.toggle('hidden', n <= 0);
  }

  /* ---------------- Save / edit ---------------- */
  function collectReminder() {
    if (el.remindBox.classList.contains('hidden') || !el.rmDate.value) return null;
    return el.rmDate.value + 'T' + (el.rmTime.value || '09:00');
  }

  function save() {
    var text = el.text.value.trim();
    if (!text && !pendingAudio) {
      TG.haptic('warning');
      App.toast('Tulis catatan atau rekam dulu ya');
      return;
    }
    var payload = {
      text: text,
      remindAt: collectReminder(),
      repeat: el.rmRepeat.value,
      leadMin: Number(el.rmLead.value) || 0
    };

    // Buat id rekaman sekali, lalu pakai di kedua jalur (tambah / ubah)
    if (pendingAudio && !pendingAudio.id) pendingAudio.id = S.uid();

    var noteId = editing;
    if (noteId) {
      S.Notes.update(noteId, payload);
    } else {
      noteId = S.Notes.add(payload).id;
    }

    if (pendingAudio) {
      var aid = pendingAudio.id;
      AudioDB.put(aid, pendingAudio.blob).catch(function (e) {
        console.warn('gagal simpan audio', e);
      });
      S.Notes.update(noteId, {
        audioId: aid,
        audioMeta: { dur: pendingAudio.dur, size: pendingAudio.blob.size }
      });
      // Kirim penanda ke bot supaya bisa follow-up (fallback jika user tidak buka app)
      if (TG.isTelegram) TG.sendData('catatan:' + noteId);
      clearPending();
    }

    resetForm();
    render();
    TG.haptic('success');
    App.toast('Catatan tersimpan');
  }

  function resetForm() {
    editing = null;
    el.text.value = '';
    el.remindBox.classList.add('hidden');
    el.remindLabel.textContent = 'Ingatkan';
    el.btnSave.textContent = 'Simpan';
    clearPending();
  }

  var editing = null;

  function startEdit(id) {
    var n = S.Notes.all().filter(function (x) { return x.id === id; })[0];
    if (!n) return;
    editing = id;
    el.text.value = n.text || '';
    if (n.remindAt) {
      el.remindBox.classList.remove('hidden');
      el.remindLabel.textContent = 'Ingatkan ✓';
      var d = new Date(n.remindAt);
      el.rmDate.value = S.todayStr(d);
      el.rmTime.value = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      el.rmRepeat.value = n.repeat || 'none';
      el.rmLead.value = String(n.leadMin == null ? 5 : n.leadMin);
    }
    el.btnSave.textContent = 'Ubah';
    w.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function cancelEdit() {
    resetForm();
  }

  /* ---------------- Pengingat jatuh tempo ---------------- */
  function checkReminders() {
    var now = new Date();
    var hits = [];
    S.Notes.all().forEach(function (n) {
      if (n.done || !n.remindAt) return;
      var d = relDue(n);
      if (!d) return;
      if (d.fireAt <= now && d.due > new Date(now.getTime() - 24 * 3600000) && !fired[n.id]) {
        fired[n.id] = true;
        hits.push(n);
      }
    });
    if (hits.length) {
      TG.haptic('error');
      if (hits.length === 1) {
        var n = hits[0];
        var body = n.text || (n.audioId ? 'Voice note tersimpan' : 'Catatan pengingat');
        App.alertSound();
        TG.alert('⏰ Pengingat\n\n' + body + '\n\nWaktu: ' + fmtDate(n.remindAt));
      } else {
        App.alertSound();
        TG.alert('⏰ ' + hits.length + ' pengingat jatuh tempo. Buka Catatan untuk melihat.');
      }
      render();
    }
  }

  /* ---------------- Playback list ---------------- */
  function playById(id, btn) {
    var n = S.Notes.all().filter(function (x) { return x.id === id; })[0];
    if (!n || !n.audioId) return;
    if (Voice.playURL === 'note:' + id) { Voice.stopPlay(); btn.textContent = '▶ Putar'; return; }
    AudioDB.get(n.audioId).then(function (blob) {
      if (!blob) { App.toast('Rekaman tidak ditemukan'); return; }
      var url = URL.createObjectURL(blob);
      Voice.play(url, function () {
        btn.textContent = '▶ Putar';
        URL.revokeObjectURL(url);
      });
      Voice.playURL = 'note:' + id;
      btn.textContent = '⏸ Berhenti';
    }).catch(function () { App.toast('Gagal memuat rekaman'); });
  }

  /* ---------------- Init ---------------- */
  var _inited = false;
  function init() {
    if (_inited) return;
    _inited = true;
    el.text = $('#noteText');
    el.btnSave = $('#btnSave');
    el.btnMic = $('#btnMic');
    el.micLabel = $('#micLabel');
    el.recBar = $('#recBar');
    el.recTime = $('#recTime');
    el.recWave = $('#recWave');
    el.btnRecStop = $('#btnRecStop');
    el.btnRecCancel = $('#btnRecCancel');
    el.preview = $('#notePreview');
    el.prevLabel = $('#prevLabel');
    el.btnPlayPreview = $('#btnPlayPreview');
    el.icoPlay = $('#icoPlay');
    el.icoPause = $('#icoPause');
    el.btnDropAudio = $('#btnDropAudio');
    el.btnRemind = $('#btnRemind');
    el.remindLabel = $('#remindLabel');
    el.remindBox = $('#remindBox');
    el.rmDate = $('#rmDate');
    el.rmTime = $('#rmTime');
    el.rmRepeat = $('#rmRepeat');
    el.rmLead = $('#rmLead');
    el.list = $('#noteList');
    el.filter = $('#noteFilter');
    el.badge = $('#badgeNotes');

    el.btnSave.addEventListener('click', function () { save(); });

    // Mikrofon
    if (!Voice.supported) {
      el.btnMic.classList.add('hidden');
    } else {
      el.btnMic.addEventListener('click', function () {
        if (Voice.recording) { Voice.stop(); return; }
        el.recBar.classList.remove('hidden');
        el.micLabel.textContent = 'Berhenti';
        el.btnMic.classList.add('rec');
        TG.haptic('medium');
        Voice.onDone(function (blob, dur) {
          el.recBar.classList.add('hidden');
          el.micLabel.textContent = 'Rekam';
          el.btnMic.classList.remove('rec');
          setPending(blob, dur);
          TG.haptic('success');
        });
        Voice.start(el.recWave, el.recTime).catch(function (err) {
          el.recBar.classList.add('hidden');
          el.micLabel.textContent = 'Rekam';
          el.btnMic.classList.remove('rec');
          TG.haptic('error');
          TG.alert('Tidak bisa akses mikrofon.\n\n' + (err.message || '') +
            '\n\nPastikan izin mikrofon diizinkan dan aplikasi dibuka di HTTPS.');
        });
      });
      el.btnRecStop.addEventListener('click', function () { Voice.stop(); });
      el.btnRecCancel.addEventListener('click', function () {
        Voice.cancel();
        el.recBar.classList.add('hidden');
        el.micLabel.textContent = 'Rekam';
        el.btnMic.classList.remove('rec');
      });
    }

    // Preview rekaman
    el.btnPlayPreview.addEventListener('click', function () {
      if (!pendingAudio) return;
      if (Voice.playURL === pendingAudio.url) {
        Voice.stopPlay();
        el.icoPlay.classList.remove('hidden');
        el.icoPause.classList.add('hidden');
        return;
      }
      Voice.play(pendingAudio.url, function () {
        el.icoPlay.classList.remove('hidden');
        el.icoPause.classList.add('hidden');
      });
      el.icoPlay.classList.add('hidden');
      el.icoPause.classList.remove('hidden');
    });
    el.btnDropAudio.addEventListener('click', function () {
      clearPending();
      TG.haptic('select');
    });

    // Pengingat
    el.btnRemind.addEventListener('click', function () {
      var on = el.remindBox.classList.contains('hidden');
      el.remindBox.classList.toggle('hidden', !on);
      el.remindLabel.textContent = on ? 'Ingatkan ✓' : 'Ingatkan';
      if (on && !el.rmDate.value) {
        var d = new Date(Date.now() + 3600000);
        el.rmDate.value = S.todayStr(d);
        el.rmTime.value = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      }
      TG.haptic('select');
    });

    // Filter
    el.filter.addEventListener('click', function (e) {
      var b = e.target.closest('.seg-btn');
      if (!b) return;
      filter = b.dataset.f;
      [].forEach.call(this.querySelectorAll('.seg-btn'), function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      render();
    });

    // Aksi item (delegasi)
    el.list.addEventListener('click', function (e) {
      var t = e.target.closest('[data-toggle],[data-del],[data-edit],[data-play]');
      if (!t) return;
      if (t.dataset.toggle) {
        var n = S.Notes.toggle(t.dataset.toggle);
        TG.haptic(n && n.done ? 'success' : 'select');
        render();
      } else if (t.dataset.del) {
        var id = t.dataset.del;
        TG.confirm('Hapus catatan ini?', function (ok) {
          if (!ok) return;
          S.Notes.remove(id);
          if (editing === id) cancelEdit();
          render();
          TG.haptic('success');
          App.toast('Catatan dihapus');
        });
      } else if (t.dataset.edit) {
        startEdit(t.dataset.edit);
      } else if (t.dataset.play) {
        playById(t.dataset.play, t);
      }
    });

    // Enter ctrl+enter untuk simpan
    el.text.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') save();
    });

    el.rmDate.min = S.todayStr();
    render();
    // Jaga agar error di dalam timer tidak mematikan WebView Telegram.
    function cekAman() { try { checkReminders(); } catch (e) { console.error('notes: pengingat gagal', e); } }
    setInterval(cekAman, 30000);
    setTimeout(cekAman, 1500);
  }

  w.NotesUI = { init: init, render: render, reset: cancelEdit, check: checkReminders };
})(window);
