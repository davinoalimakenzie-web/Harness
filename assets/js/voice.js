/* =========================================================
   voice.js — Rekam & pemain rekaman suara
   Pakai MediaRecorder + Web Audio untuk visualizer.
   Speech-to-text (Web Speech API) otomatis aktif bila tersedia.
   ========================================================= */
(function (w) {
  'use strict';

  var md = navigator.mediaDevices;
  var hasMic = !!(md && md.getUserMedia && w.MediaRecorder);
  var SR = w.SpeechRecognition || w.webkitSpeechRecognition;
  var hasSTT = !!SR;

  var rec = null;       // MediaRecorder
  var chunks = [];
  var stream = null;
  var audioCtx = null, analyser = null, rafId = 0, visEl = null;
  var startAt = 0, tickId = 0;
  var stt = null;       // SpeechRecognition
  var onTick = null;
  var onTranscript = null;

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec));
    var m = String(Math.floor(sec / 60)).padStart(2, '0');
    var s = String(sec % 60).padStart(2, '0');
    return m + ':' + s;
  }

  function buildWave(el, n) {
    el.innerHTML = '';
    for (var i = 0; i < n; i++) el.appendChild(document.createElement('i'));
  }

  function loopViz() {
    if (!analyser) return;
    var data = new Uint8Array(analyser.frequencyBinCount);
    var bars = visEl ? visEl.children : [];
    (function step() {
      if (!rec || rec.state !== 'recording') return;
      analyser.getByteFrequencyData(data);
      for (var i = 0; i < bars.length; i++) {
        var v = data[Math.floor(i * (data.length / bars.length))] / 255;
        bars[i].style.height = Math.max(5, v * 20) + 'px';
      }
      rafId = requestAnimationFrame(step);
    })();
  }

  function stopStream() {
    cancelAnimationFrame(rafId);
    if (stream) {
      try {
        stream.getTracks().forEach(function (t) { t.stop(); });
      } catch (e) {}
      stream = null;
    }
    if (audioCtx) {
      try {
        audioCtx.close().catch(function(){});
      } catch (e) {}
      audioCtx = null;
    }
    analyser = null;
    stopSTT();
  }

  function stopSTT() {
    if (stt) {
      try {
        stt.onresult = null;
        stt.onerror = null;
        stt.onend = null;
        stt.stop();
      } catch (e) {}
      stt = null;
    }
  }

  var Voice = {
    supported: hasMic,
    sttSupported: hasSTT,
    get recording() { return !!(rec && rec.state === 'recording'); },

    /* Rekam; cb(blob, durationSec) saat selesai, cbErr(err) saat gagal */
    start: function (waveEl, timeEl, onTickCb, onTranscriptCb) {
      if (this.recording) return Promise.reject(new Error('Sudah merekam'));
      if (!hasMic) return Promise.reject(new Error('Browser tidak mendukung rekam (butuh HTTPS / browser modern)'));

      onTick = onTickCb;
      onTranscript = onTranscriptCb;

      return md.getUserMedia({ audio: true }).then(function (s) {
        stream = s;
        chunks = [];
        var mime = '';
        var testMimes = [
          'audio/webm;codecs=opus',
          'audio/webm',
          'audio/mp4',
          'audio/aac',
          'audio/ogg'
        ];
        testMimes.some(function (m) {
          if (w.MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) {
            mime = m;
            return true;
          }
          return false;
        });

        try {
          rec = mime ? new MediaRecorder(s, { mimeType: mime }) : new MediaRecorder(s);
        } catch (eRec) {
          rec = new MediaRecorder(s);
        }

        rec.ondataavailable = function (e) {
          if (e.data && e.data.size) chunks.push(e.data);
        };

        rec.onstop = function () {
          var dur = (Date.now() - startAt) / 1000;
          var type = (rec && rec.mimeType) || (chunks[0] && chunks[0].type) || 'audio/webm';
          var blob = new Blob(chunks, { type: type });
          chunks = [];
          stopStream();
          if (Voice._onDone) Voice._onDone(blob, dur);
        };

        rec.start(250);
        startAt = Date.now();

        if (timeEl) {
          clearInterval(tickId);
          tickId = setInterval(function () {
            var el = fmt((Date.now() - startAt) / 1000);
            if (timeEl) timeEl.textContent = el;
            if (onTick) onTick(el);
          }, 250);
        }

        // Jalankan Speech-to-text otomatis jika didukung
        if (hasSTT && onTranscript) {
          try {
            stt = new SR();
            stt.lang = 'id-ID';
            stt.continuous = true;
            stt.interimResults = true;
            stt.maxAlternatives = 1;
            stt.onresult = function (e) {
              var fullText = '';
              for (var i = 0; i < e.results.length; i++) {
                fullText += e.results[i][0].transcript;
              }
              if (onTranscript) onTranscript(fullText.trim());
            };
            stt.onerror = function () {};
            stt.onend = function () {};
            stt.start();
          } catch (eStt) {
            console.warn('STT tidak dapat dimulai:', eStt);
          }
        }

        // Visualizer Web Audio
        try {
          var AC = w.AudioContext || w.webkitAudioContext;
          if (AC && waveEl) {
            audioCtx = new AC();
            if (audioCtx.state === 'suspended') {
              audioCtx.resume().catch(function(){});
            }
            var src = audioCtx.createMediaStreamSource(s);
            analyser = audioCtx.createAnalyser();
            analyser.fftSize = 64;
            src.connect(analyser);
            buildWave(waveEl, 18);
            visEl = waveEl;
            loopViz();
          }
        } catch (e) { /* visualizer opsional */ }

        return true;
      });
    },

    stop: function () {
      clearInterval(tickId);
      stopSTT();
      if (rec && rec.state === 'recording') {
        try { rec.stop(); } catch (e) {}
      }
    },

    cancel: function () {
      clearInterval(tickId);
      stopSTT();
      if (rec && rec.state === 'recording') {
        rec.onstop = null;      // buang hasil
        try { rec.stop(); } catch (e) {}
      }
      stopStream();
    },

    onDone: function (cb) { Voice._onDone = cb; },
    _onDone: null,

    /* -------- Speech-to-text standalone -------- */
    listenOnce: function () {
      if (!hasSTT) return Promise.reject(new Error('Speech-to-text tidak didukung di browser ini'));
      return new Promise(function (res, rej) {
        try {
          var singleStt = new SR();
          singleStt.lang = 'id-ID';
          singleStt.interimResults = false;
          singleStt.maxAlternatives = 1;
          var got = '';
          singleStt.onresult = function (e) { got = e.results[0][0].transcript; };
          singleStt.onerror = function (e) { rej(new Error(e.error || 'Gagal mengenali suara')); };
          singleStt.onend = function () { res(got.trim()); };
          singleStt.start();
        } catch (e) { rej(e); }
      });
    },

    stopListening: function () { stopSTT(); },

    /* -------- Playback -------- */
    playURL: null,
    play: function (url, onEnd) {
      if (!w.Audio) return false;
      Voice.stopPlay();
      var a = new Audio(url);
      Voice.playURL = url;
      Voice._audio = a;
      a.onended = function () { Voice.playURL = null; onEnd && onEnd(); };
      a.onerror = function () { Voice.playURL = null; onEnd && onEnd(); };
      a.play().catch(function () {});
      return true;
    },
    stopPlay: function () { if (Voice._audio) { Voice._audio.pause(); Voice._audio = null; Voice.playURL = null; } }
  };

  w.Voice = Voice;
})(window);
