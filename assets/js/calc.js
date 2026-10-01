/* =========================================================
   calc.js — Kalkulator Harga Servis HP

   Satu rumus untuk semua jenis pekerjaan:
        harga estimasi = (harga part x 2) + persen

   Contoh: LCD biasa, part Rp150.000
        (150.000 x 2) + 20% = 300.000 + 60.000 = Rp360.000

   Tabel perhitungan estimasi biaya (sesuai acuan):
      LCD biasa      = part x 2 + 20%
      LCD bagus      = part x 2 + 20%
      LCD OLED       = part x 2 + 10%
      Baterai        = part x 2 + 10%
      LCD iPhone     = part x 2 + 20%
      Baterai iPhone = part x 2 + 20%

   Brand dan seri HP diisi lewat dropdown. Daftar seri memakai
   model yang umum beredar di Indonesia; seri juga bisa diisi
   sendiri lewat opsi "Lainnya / ketik manual" supaya model
   yang belum terdaftar tetap bisa dipakai.
   ========================================================= */
(function (w) {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var S = w.Store, TG = w.TG;

  var el = {};
  var ruleId = 'lcd-biasa';
  var brandId = 'samsung';
  var seriesId = '';

  /* Aturan harga. `pct` adalah persen yang ditambahkan ke (part x 2). */
  var RULES = [
    { id: 'lcd-biasa', name: 'LCD Biasa', pct: 20, icon: '📱', note: 'LCD biasa' },
    { id: 'lcd-bagus', name: 'LCD Bagus', pct: 20, icon: '📱', note: 'LCD bagus' },
    { id: 'lcd-oled', name: 'LCD OLED', pct: 10, icon: '✨', note: 'LCD OLED' },
    { id: 'baterai', name: 'Baterai', pct: 10, icon: '🔋', note: 'Baterai' },
    { id: 'lcd-iphone', name: 'LCD iPhone', pct: 20, icon: '🍎', note: 'LCD iPhone' },
    { id: 'baterai-iphone', name: 'Baterai iPhone', pct: 20, icon: '🍎', note: 'Baterai iPhone' }
  ];

  /* Brand HP yang dipakai. */
  var BRANDS = [
    { id: 'samsung', name: 'Samsung' },
    { id: 'oppo', name: 'OPPO' },
    { id: 'realme', name: 'Realme' },
    { id: 'vivo', name: 'Vivo' },
    { id: 'xiaomi', name: 'Xiaomi' },
    { id: 'infinix', name: 'Infinix' }
  ];

  /* Seri HP per brand. Daftar ini model yang lazim dijumpai di
     layanan servis HP harian; kolom ini bisa ditambah bebas. */
  var SERIES = {
    samsung: [
      'Galaxy A05', 'Galaxy A05s', 'Galaxy A15', 'Galaxy A16', 'Galaxy A25', 'Galaxy A35',
      'Galaxy A55', 'Galaxy A56', 'Galaxy S21', 'Galaxy S22', 'Galaxy S23', 'Galaxy S24',
      'Galaxy S25', 'Galaxy M12', 'Galaxy M14', 'Galaxy M34', 'Galaxy M36',
      'Galaxy Z Flip', 'Galaxy Z Fold', 'Galaxy J5', 'Galaxy J7'
    ],
    oppo: [
      'A3', 'A5s', 'A31', 'A52', 'A53', 'A54', 'A57', 'A58', 'A59', 'A72', 'A74', 'A76',
      'A77', 'A78', 'A79', 'A94', 'A95', 'A96', 'A98',
      'Reno 5', 'Reno 6', 'Reno 7', 'Reno 8', 'Reno 10', 'Reno 11', 'Reno 12', 'Reno 13',
      'Reno 14', 'Find X3', 'Find X5', 'Find X7', 'Find X8'
    ],
    realme: [
      '5i', '6i', '7i', '8i', '9i', '10i', '11i', '12i', '13i', '14i',
      'C55', 'C65', 'C67', 'Narzo 20', 'Narzo 30', 'Narzo 50', 'Narzo 60',
      'Note 50', 'Note 60'
    ],
    vivo: [
      'V15', 'V19', 'V20', 'V21', 'V22', 'V23', 'V25', 'V27', 'V29', 'V30',
      'Y15', 'Y17', 'Y19', 'Y20', 'Y21', 'Y22', 'Y25', 'Y27', 'Y28', 'Y29',
      'Y33', 'Y36', 'X80', 'X100', 'X200'
    ],
    xiaomi: [
      'Redmi 9', 'Redmi 9A', 'Redmi 10', 'Redmi 10C', 'Redmi 11', 'Redmi 12',
      'Redmi 12C', 'Redmi 13', 'Redmi 13C', 'Redmi 14', 'Redmi 14C',
      'Redmi Note 10', 'Redmi Note 11', 'Redmi Note 12', 'Redmi Note 13',
      'Redmi Note 14', 'Xiaomi 12', 'Xiaomi 13', 'Xiaomi 14', 'Xiaomi 15',
      'Poco C55', 'Poco M5', 'Poco X5', 'Poco X6', 'Poco X7'
    ],
    infinix: [
      'Hot 20', 'Hot 20i', 'Hot 30', 'Hot 30i', 'Hot 40', 'Hot 40i', 'Hot 50', 'Hot 50i',
      'Hot 60', 'Hot 60i', 'Note 12', 'Note 20', 'Note 30', 'Note 40', 'Note 50',
      'Smart 6', 'Smart 7', 'Smart 8', 'Zero 20', 'Zero 30', 'Zero 40',
      'GT 20', 'GT 30'
    ]
  };

  var CUSTOM_SERIES = '__custom__';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) {
    n = Math.round(Number(n) || 0);
    return 'Rp' + n.toLocaleString('id-ID');
  }
  function ruleById(id) {
    for (var i = 0; i < RULES.length; i++) if (RULES[i].id === id) return RULES[i];
    return RULES[0];
  }
  function brandById(id) {
    for (var i = 0; i < BRANDS.length; i++) if (BRANDS[i].id === id) return BRANDS[i];
    return BRANDS[0];
  }

  /* ---------------- Input ---------------- */
  /* Terima "150000", "150.000", "150,000" jadi angka 150000. */
  function parsePart(raw) {
    var s = String(raw == null ? '' : raw).replace(/[^\d]/g, '');
    if (!s) return 0;
    return parseInt(s, 10) || 0;
  }

  /* ---------------- Perhitungan ----------------
     Rumus inti: harga estimasi = (part x 2) + persen dari (part x 2) */
  function hitung(part, rule) {
    part = Math.max(0, Math.round(Number(part) || 0));
    var pct = rule ? Number(rule.pct) || 0 : 0;
    var dasar = part * 2;              // part x 2
    var tambahan = Math.round(dasar * pct / 100);
    var est = dasar + tambahan;
    return {
      part: part,
      dasar: dasar,
      pct: pct,
      tambahan: tambahan,
      jual: est,                       // kept: nilai estimasi
      est: est,
      laba: est - part
    };
  }

  /* ---------------- Brand & Seri ---------------- */
  function renderBrands() {
    el.kBrand.innerHTML = BRANDS.map(function (b) {
      return '<option value="' + esc(b.id) + '"' + (b.id === brandId ? ' selected' : '') +
        '>' + esc(b.name) + '</option>';
    }).join('');
  }

  function renderSeries() {
    var list = SERIES[brandId] || [];
    var opts = list.map(function (s) {
      return '<option value="' + esc(s) + '"' + (s === seriesId ? ' selected' : '') +
        '>' + esc(s) + '</option>';
    }).join('');
    opts += '<option value="' + CUSTOM_SERIES + '"' +
      (seriesId === CUSTOM_SERIES ? ' selected' : '') + '>Lainnya…</option>';
    el.kSeries.innerHTML = opts;

    /* Kolom input muncul hanya kalau seri dipilih "Lainnya…". */
    var isCustom = seriesId === CUSTOM_SERIES;
    el.kName.classList.toggle('hidden', !isCustom);
    el.kName.classList.toggle('k-custom-series', isCustom);
    el.kName.setAttribute('aria-hidden', isCustom ? 'false' : 'true');
  }

  function readSeries() {
    if (seriesId === CUSTOM_SERIES) {
      return el.kName.value.trim();
    }
    return seriesId;
  }

  /* ---------------- Render ---------------- */
  function renderRules() {
    el.kRules.innerHTML = RULES.map(function (r) {
      return '<button type="button" class="k-rule' + (r.id === ruleId ? ' on' : '') +
        '" data-rule="' + esc(r.id) + '">' +
        '<span class="k-rule-ic">' + r.icon + '</span>' +
        '<span class="k-rule-nm">' + esc(r.name) + '</span>' +
        '<span class="k-rule-ct">part &times; 2 + ' + r.pct + '%</span>' +
        '</button>';
    }).join('');
  }

  function renderOut() {
    var part = parsePart(el.kPart.value);
    var rule = ruleById(ruleId);
    var h = hitung(part, rule);

    el.kEst.textContent = money(h.est);
    el.kFormulaOut.textContent = h.part > 0
      ? '(' + money(h.part) + ' × 2) + ' + h.pct + '% = ' + money(h.est)
      : 'Isi harga part, lalu pilih perhitungan estimasi biaya.';
  }

  /* ---------------- Ringkasan ---------------- */
  function summary() {
    var rule = ruleById(ruleId);
    var h = hitung(parsePart(el.kPart.value), rule);
    var brand = brandById(brandId).name;
    var seri = readSeries();
    var lines = [];
    if (seri) { lines.push('*' + brand + ' ' + seri + '*'); lines.push(''); }
    lines.push('Perhitungan: ' + rule.name);
    lines.push('Harga part: ' + money(h.part));
    lines.push('Harga estimasi: ' + money(h.est));
    lines.push('Rumus: (part × 2) + ' + h.pct + '%');
    lines.push('');
    lines.push('_Kalkulator Service HP — Project Nava_');
    return lines.join('\n');
  }

  function copySummary() {
    var txt = summary();
    var done = function () { TG.haptic('success'); w.App.toast('Ringkasan disalin'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(done).catch(function () { fallback(txt, done); });
    } else fallback(txt, done);

    function fallback(t, cb) {
      var ta = document.createElement('textarea');
      ta.value = t; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); cb(); } catch (e) { w.App.toast('Gagal menyalin'); }
      ta.remove();
    }
  }

  /* ---------------- Harga tersimpan ----------------
     Disimpan dari kombinasi brand HP, seri HP, dan estimasi biaya. */
  function labelTpl(p) {
    var rule = ruleById(p.ruleId);
    var brand = p.brandName || brandById(p.brandId).name;
    var seri = p.series || '-';
    return brand + ' ' + seri + ' · ' + rule.name + ' · ' + money(p.est);
  }

  function renderTpl() {
    var t = S.state.templates || [];
    if (!t.length) { el.tpl.innerHTML = '<p class="hint xs">Belum ada harga tersimpan.</p>'; return; }
    el.tpl.innerHTML = t.map(function (x) {
      var p = x.payload || {};
      return '<div class="item" data-tpl="' + esc(x.id) + '">' +
        '<div class="item-body"><div class="item-title">' + esc(labelTpl(p)) + '</div>' +
        '<div class="item-sub"><span class="tag">part ' + money(p.part) + '</span>' +
        '<span>estimasi ' + money(p.est) + '</span></div></div>' +
        '<div class="item-actions"><button class="icon-btn sm" data-tpluse="' + esc(x.id) + '">↺</button>' +
        '<button class="icon-btn sm" data-tpldel="' + esc(x.id) + '">🗑</button></div></div>';
    }).join('');
  }

  function saveTpl() {
    var part = parsePart(el.kPart.value);
    if (part <= 0) { w.App.toast('Isi harga part dulu'); return; }
    var rule = ruleById(ruleId);
    var seri = readSeries();
    if (!seri) { w.App.toast('Pilih seri HP dulu'); return; }

    S.state.templates = S.state.templates || [];

    /* Hindari duplikat kombinasi brand+seri+perhitungan yang sama. */
    var dup = S.state.templates.filter(function (t) {
      var p = t.payload || {};
      return p.brandId === brandId && p.series === seri && p.ruleId === rule.id;
    })[0];
    if (dup) {
      dup.payload = {
        brandId: brandId, brandName: brandById(brandId).name,
        series: seri, ruleId: rule.id, part: part,
        est: hitung(part, rule).est
      };
      dup.updatedAt = new Date().toISOString();
    } else {
      S.state.templates.unshift({
        id: S.uid(),
        createdAt: new Date().toISOString(),
        payload: {
          brandId: brandId, brandName: brandById(brandId).name,
          series: seri, ruleId: rule.id, part: part,
          est: hitung(part, rule).est
        }
      });
    }
    if (S.state.templates.length > 30) S.state.templates.length = 30;
    S.save();
    renderTpl();
    TG.haptic('success');
    w.App.toast('Harga tersimpan');
  }

  function applyTpl(p) {
    el.kPart.value = p.part || '';
    brandId = p.brandId || 'samsung';
    seriesId = p.series || '';
    ruleId = p.ruleId || 'lcd-biasa';
    if (seriesId && (SERIES[brandId] || []).indexOf(seriesId) === -1) {
      /* Seri manual tidak ada di daftar brand tsb → pakai mode "Lainnya". */
      el.kName.value = p.series || '';
      seriesId = CUSTOM_SERIES;
    }
    renderBrands();
    renderSeries();
    renderRules();
    renderOut();
  }

  /* ---------------- Init ---------------- */
  var _inited = false;
  function init() {
    if (_inited) return;
    _inited = true;

    el.kPart = $('#kPart');
    el.kName = $('#kName');
    el.kBrand = $('#kBrand');
    el.kSeries = $('#kSeries');
    el.kRules = $('#kRules');
    el.kEst = $('#kEst');
    el.kFormulaOut = $('#kFormulaOut');
    el.tpl = $('#tplList');

    renderBrands();
    renderSeries();
    renderRules();
    renderOut();
    renderTpl();

    el.kPart.addEventListener('input', renderOut);
    el.kName.addEventListener('input', function () { if (seriesId === CUSTOM_SERIES) renderOut(); });

    el.kBrand.addEventListener('change', function () {
      brandId = el.kBrand.value;
      seriesId = '';
      el.kName.value = '';
      renderSeries();
      renderOut();
      TG.haptic('select');
    });

    el.kSeries.addEventListener('change', function () {
      seriesId = el.kSeries.value;
      if (seriesId === CUSTOM_SERIES) el.kName.value = '';
      renderSeries();
      renderOut();
      TG.haptic('select');
    });

    el.kRules.addEventListener('click', function (e) {
      var b = e.target.closest('[data-rule]');
      if (!b) return;
      ruleId = b.dataset.rule;
      renderRules();
      renderOut();
      TG.haptic('select');
    });

    $('#kCopy').addEventListener('click', copySummary);
    $('#kSaveTpl').addEventListener('click', saveTpl);
    $('#kReset').addEventListener('click', function () {
      el.kPart.value = '';
      el.kName.value = '';
      brandId = 'samsung';
      seriesId = '';
      ruleId = 'lcd-biasa';
      renderBrands();
      renderSeries();
      renderRules();
      renderOut();
      TG.haptic('select');
    });

    el.tpl.addEventListener('click', function (e) {
      var use = e.target.closest('[data-tpluse]');
      var del = e.target.closest('[data-tpldel]');
      if (use) {
        var x = (S.state.templates || []).filter(function (t) { return t.id === use.dataset.tpluse; })[0];
        if (x) {
          applyTpl(x.payload || {});
          w.scrollTo({ top: 0, behavior: 'smooth' });
          TG.haptic('success');
          w.App.toast('Harga dipakai');
        }
      } else if (del) {
        S.state.templates = (S.state.templates || []).filter(function (t) { return t.id !== del.dataset.tpldel; });
        S.save(); renderTpl(); TG.haptic('success');
      }
    });
  }

  w.CalcUI = {
    init: init,
    render: renderOut,
    RULES: RULES,
    BRANDS: BRANDS,
    SERIES: SERIES,
    hitung: hitung,
    parsePart: parsePart,
    applyTpl: applyTpl
  };
})(window);
