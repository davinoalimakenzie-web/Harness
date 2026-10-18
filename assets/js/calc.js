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
  var filterBrand = 'samsung'; // brand filter untuk daftar harga tersimpan
  var editingKey = null;       // entri lama yang sedang diedit (lewat tombol ↺)
  var justSavedKey = null;     // entri yang barusan tersimpan (kilatan hijau)
  var _justSavedT = null;

  /* Aturan harga. `pct` adalah persen yang ditambahkan ke (part x 2). */
  var RULES = [
    { id: 'lcd-biasa', name: 'LCD Biasa', pct: 20, icon: '📱', note: 'LCD biasa' },
    { id: 'lcd-bagus', name: 'LCD Bagus', pct: 20, icon: '📱', note: 'LCD bagus' },
    { id: 'lcd-oled', name: 'LCD OLED', pct: 10, icon: '✨', note: 'LCD OLED' },
    { id: 'baterai', name: 'Baterai', pct: 10, icon: '🔋', note: 'Baterai' }
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

  var CUSTOM_BRAND = '__custom_brand__';

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

  /* --- Seed data: 1 seri per brand dengan harga part awal --- */
  var SEED_DATA = [
    { brandId: 'samsung', brandName: 'Samsung', series: 'Galaxy A05', ruleId: 'lcd-biasa', part: 105000 },
    { brandId: 'oppo',    brandName: 'OPPO',    series: 'A5s',       ruleId: 'lcd-biasa', part: 105000 },
    { brandId: 'vivo',    brandName: 'Vivo',    series: 'Y91',       ruleId: 'lcd-biasa', part: 105000 },
    { brandId: 'realme',  brandName: 'Realme',  series: 'C3',        ruleId: 'lcd-biasa', part: 105000 },
    { brandId: 'xiaomi',  brandName: 'Xiaomi',  series: 'Redmi 10',   ruleId: 'lcd-biasa', part: 105000 },
    { brandId: 'infinix', brandName: 'Infinix', series: 'Smart 5',   ruleId: 'lcd-biasa', part: 105000 }
  ];

  function seedIfNeeded() {
    var t = S.state.templates || [];
    SEED_DATA.forEach(function (s) {
      // Paksa seed: tambah kalau brand ini belum punya data
      var exists = t.some(function (x) { return (x.payload || {}).brandId === s.brandId; });
      if (!exists) {
        var rule = ruleById(s.ruleId);
        t.push({
          id: 'seed-' + s.brandId,
          payload: {
            brandId: s.brandId, brandName: s.brandName, series: s.series,
            ruleId: s.ruleId, part: s.part, est: s.part * 2 + Math.round(s.part * 2 * rule.pct / 100)
          }
        });
      }
    });
    S.save();
  }

  /* Cek apakah sebuah seri adalah seri yang terkunci (tidak bisa dihapus) */
  function isLockedSeries(brandId, series) {
    var list = SERIES[brandId];
    return list && list.indexOf(series) !== -1;
  }

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
    if (id === CUSTOM_BRAND) return { id: CUSTOM_BRAND, name: el.kBrandName.value.trim() || 'Lainnya' };
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
    var opts = BRANDS.map(function (b) {
      return '<option value="' + esc(b.id) + '"' + (b.id === brandId ? ' selected' : '') +
        '>' + esc(b.name) + '</option>';
    }).join('');
    opts += '<option value="' + CUSTOM_BRAND + '"' +
      (brandId === CUSTOM_BRAND ? ' selected' : '') + '>Lainnya…</option>';
    el.kBrand.innerHTML = opts;

    /* Tempelkan id brand ke select dan ke kotak pembungkusnya supaya CSS
       bisa mewarnai sesuai brand (Samsung biru, Xiaomi orange, dst).
       Kotak Seri HP ikut warna brand yang sedang dipilih. */
    el.kBrand.setAttribute('data-brand', brandId);
    var tileBrand = el.kBrand.closest ? el.kBrand.closest('.q-brand') : null;
    if (tileBrand) tileBrand.setAttribute('data-brand', brandId);
    var tileSeries = el.kSeries && el.kSeries.closest ? el.kSeries.closest('.q-series') : null;
    if (tileSeries) tileSeries.setAttribute('data-brand', brandId);
    /* Tombol simpan juga diberi data-brand supaya latar kolom tengahnya
       ikut warna brand (menyatu dengan kotak Brand HP & Seri HP). */
    if (el.kSaveTpl) el.kSaveTpl.setAttribute('data-brand', brandId);
  }

  function renderSeries() {
    var saved = {};
    (w.Store.state.templates || []).forEach(function (t) {
      var p = (t && (t.payload || t));
      if (p && p.brandId === brandId && p.series) saved[p.series] = true;
    });
    var list = Object.keys(saved);
    if (seriesId && seriesId !== CUSTOM_SERIES && list.indexOf(seriesId) === -1) {
      list.push(seriesId);
    }
    var opts = list.map(function (s) {
      return '<option value="' + esc(s) + '"' + (s === seriesId ? ' selected' : '') +
        '>' + esc(s) + '</option>';
    }).join('');
    opts += '<option value="' + CUSTOM_SERIES + '"' +
      (seriesId === CUSTOM_SERIES ? ' selected' : '') + '>Lainnya…</option>';

    /* Jangan replace innerHTML kalau seriesId sudah CUSTOM_SERIES —
       browser mobile bisa "reset" select yang cuma punya 1 opsi. */
    if (seriesId !== CUSTOM_SERIES) {
      el.kSeries.innerHTML = opts;
    }

    /* Selaraskan state dengan yang BENAR-BENAR tampil di dropdown.
       Kalau seriesId kosong, browser otomatis memilih opsi pertama sehingga
       dropdown terlihat sudah terisi padahal state masih kosong — akibatnya
       tombol simpan menolak dengan "Pilih seri HP dulu" walaupun seri sudah
       kelihatan terpilih. Kalau dropdown cuma berisi "Lainnya…", anggap
       seri manual supaya kolom isiannya langsung muncul. */
    if (!seriesId && el.kSeries && el.kSeries.value) {
      seriesId = el.kSeries.value;
    }

    /* Saat brand custom: tampilkan 2 input sejajar (kiri brand, kanan seri).
       Saat seri "Lainnya…": tampilkan kolom input seri manual. */
    var isCustomBrand = brandId === CUSTOM_BRAND;
    var isCustomSeries = seriesId === CUSTOM_SERIES;

    // Brand custom: show dual input (brand + seri)
    el.kBrandName.classList.toggle('hidden', !isCustomBrand);
    el.kBrandName.classList.toggle('k-custom-brand', isCustomBrand);
    el.kBrandName.setAttribute('aria-hidden', isCustomBrand ? 'false' : 'true');
    el.kBrandName.style.display = isCustomBrand ? '' : 'none';

    // Seri "Lainnya…": show manual input (only if brand is NOT custom)
    var showSeriesInput = isCustomSeries && !isCustomBrand;
    el.kName.classList.toggle('hidden', !showSeriesInput);
    el.kName.classList.toggle('k-custom-series', showSeriesInput);
    el.kName.setAttribute('aria-hidden', showSeriesInput ? 'false' : 'true');
    el.kName.style.display = showSeriesInput ? '' : 'none';

    /* Mode edit selalu menang: kotak Seri HP tetap jadi kolom isian. */
    syncEditMode();
  }

  function readSeries() {
    /* Mode edit: nama seri dibaca langsung dari kolom isian di kotak Seri HP. */
    if (editingKey && el.kSeriesEdit && el.kSeriesEdit.value.trim()) {
      return el.kSeriesEdit.value.trim();
    }
    if (brandId === CUSTOM_BRAND) {
      return el.kSeriesNameInput.value.trim();
    }
    if (seriesId === CUSTOM_SERIES) {
      return el.kName.value.trim();
    }
    if (seriesId) return seriesId;
    /* Jaring pengaman: kalau state kosong, pakai nilai yang benar-benar
       tampil di dropdown supaya simpan tidak gagal padahal seri sudah
       terlihat terpilih di layar. */
    var shown = el.kSeries ? el.kSeries.value : '';
    if (shown && shown !== CUSTOM_SERIES) return shown;
    return el.kName.value.trim();
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

  /* ---------------- Harga tersimpan ----------------
     Disimpan dari kombinasi brand HP, seri HP, dan estimasi biaya. */
  function labelTpl(p) {
    var rule = ruleById(p.ruleId);
    var brand = p.brandName || brandById(p.brandId).name;
    var seri = p.series || '-';
    return brand + ' ' + seri + ' · ' + rule.name + ' · ' + money(p.est);
  }

  /* ---------------- Konfirmasi & mode edit ----------------
     renderEditNote: penanda "sedang mengedit" yang muncul setelah tombol ↺
     dipakai, supaya jelas entri lama akan DIGANTI (bukan ditambah) saat
     disimpan — inilah cara memperbarui nama seri lama / menambah persamaan
     namanya kalau ada temuan baru.
     flashSaved: tombol simpan berubah hijau + centang sekejap. */
  /* Mode edit: kotak Seri HP berubah jadi kolom isian yang bisa langsung
     diketik (tanpa lewat "Lainnya…"), jadi nama seri lama gampang diperbarui
     atau ditambah persamaan namanya. */
  function syncEditMode() {
    var on = !!editingKey;
    if (el.kSeriesEdit) {
      el.kSeriesEdit.classList.toggle('hidden', !on);
      el.kSeriesEdit.style.display = on ? '' : 'none';
      el.kSeriesEdit.setAttribute('aria-hidden', on ? 'false' : 'true');
    }
    var selWrap = el.kSeries && el.kSeries.closest ? el.kSeries.closest('.sel-wrap') : null;
    if (selWrap) {
      selWrap.classList.toggle('hidden', on);
      selWrap.style.display = on ? 'none' : '';
    }
    /* Kolom seri manual di bawah kotak tidak dipakai saat mode edit. */
    if (on && el.kName) { el.kName.classList.add('hidden'); el.kName.style.display = 'none'; }
  }

  function renderEditNote() {
    if (!el.kEditNote) { syncEditMode(); return; }
    var on = !!editingKey;
    if (on) {
      var t = (S.state.templates || []).filter(function (x) {
        return S.templateKey(x.payload || {}) === editingKey;
      })[0];
      if (el.kEditName) el.kEditName.textContent = t ? labelTpl(t.payload || {}) : editingKey;
    }
    el.kEditNote.classList.toggle('hidden', !on);
    el.kEditNote.style.display = on ? '' : 'none';
    el.kEditNote.setAttribute('aria-hidden', on ? 'false' : 'true');
    syncEditMode();
  }

  function flashSaved() {
    if (!el.kSaveTpl) return;
    el.kSaveTpl.classList.add('ok');
    clearTimeout(flashSaved._t);
    flashSaved._t = setTimeout(function () { el.kSaveTpl.classList.remove('ok'); }, 1700);
  }

  function renderTpl() {
    var t = S.state.templates || [];
    // Brand filter — grid 2 kolom: Samsung-Xiaomi / Oppo-Vivo / Realme-Infinix
    var brandPairs = [
      ['samsung', 'xiaomi'],
      ['oppo', 'vivo'],
      ['realme', 'infinix']
    ];
    var brandBtns = brandPairs.map(function (pair) {
      var btns = pair.map(function (bid) {
        var b = brandById(bid);
        var count = t.filter(function (x) { return (x.payload || {}).brandId === bid; }).length;
        return '<button class="tpl-brand-btn' + (bid === filterBrand ? ' on' : '') + '" data-tplbrand="' + esc(bid) + '">' +
          esc(b.name) + (count ? ' <span class="tpl-count">' + count + '</span>' : '') + '</button>';
      }).join('');
      return '<div class="tpl-brand-pair">' + btns + '</div>';
    }).join('');

    var html = '<div class="tpl-brand-row">' + brandBtns + '</div>';

    if (filterBrand) {
      var list = t.filter(function (x) { return (x.payload || {}).brandId === filterBrand; });
      if (!list.length) {
        html += '<p class="hint xs">Belum ada harga tersimpan untuk brand ini.</p>';
      } else {
        html += list.map(function (x) {
          var p = x.payload || {};
          var locked = isLockedSeries(p.brandId, p.series);
          var delBtn = locked
            ? '<button class="icon-btn sm" disabled title="Seri terkunci">🔒</button>'
            : '<button class="icon-btn sm" data-tpldel="' + esc(x.id) + '">🗑</button>';
          var isFresh = justSavedKey && S.templateKey && S.templateKey(p) === justSavedKey;
          return '<div class="item' + (isFresh ? ' just-saved' : '') + '" data-tpl="' + esc(x.id) + '">' +
            '<div class="item-body"><div class="item-title">' + esc(labelTpl(p)) + '</div>' +
            '<div class="item-sub"><span class="tag">part ' + money(p.part) + '</span>' +
            '<span>estimasi ' + money(p.est) + '</span></div></div>' +
            '<div class="item-actions"><button class="icon-btn sm" data-tpluse="' + esc(x.id) + '">↺</button>' +
            delBtn + '</div></div>';
        }).join('');
      }
    }

    el.tpl.innerHTML = html;
  }

  function saveTpl() {
    var part = parsePart(el.kPart.value);
    if (part <= 0) { w.App.toast('Isi harga part dulu'); return; }
    var rule = ruleById(ruleId);
    var seri = readSeries();
    if (!seri) { w.App.toast('Pilih seri HP dulu'); return; }
    var brandName = brandById(brandId).name;
    if (brandId === CUSTOM_BRAND && !brandName) { w.App.toast('Isi brand manual dulu'); return; }

    var payload = {
      brandId: brandId, brandName: brandName,
      series: seri, ruleId: rule.id, part: part,
      est: hitung(part, rule).est
    };
    var newKey = S.templateKey ? S.templateKey(payload) : '';
    var hasil = S.upsertTemplate(payload);
    if (!hasil.ok) {
      w.App.toast('Gagal menyimpan: ' + hasil.reason);
      return;
    }
    /* Sedang mengedit entri lama lalu identitasnya berubah (mis. nama seri
       diperbarui / ditambah persamaan nama): entri lamanya dihapus supaya
       tidak jadi dua entri kembar. */
    if (editingKey && newKey && editingKey !== newKey) {
      S.state.templates = (S.state.templates || []).filter(function (x) {
        return S.templateKey(x.payload || {}) !== editingKey;
      });
      S.save();
      hasil.replaced = true;
    }
    editingKey = null;
    renderEditNote();
    justSavedKey = newKey;
    clearTimeout(_justSavedT);
    _justSavedT = setTimeout(function () { justSavedKey = null; }, 2600);
    renderTpl();
    renderSeries();
    TG.haptic('success');
    flashSaved();
    w.App.toast(hasil.replaced
      ? '\u2713 Tersimpan — entri lama diperbarui'
      : '\u2713 Tersimpan (' + hasil.total + ' entri)', 2800, 'ok');
  }

  function applyTpl(p) {
    el.kPart.value = p.part || '';
    brandId = p.brandId || 'samsung';
    seriesId = p.series || '';
    ruleId = p.ruleId || 'lcd-biasa';
    if (brandId === CUSTOM_BRAND) {
      el.kBrandNameInput.value = p.brandName || '';
      el.kSeriesNameInput.value = p.series || '';
    } else if (seriesId && (SERIES[brandId] || []).indexOf(seriesId) === -1) {
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
    el.kBrandName = $('#kBrandName');
    el.kBrandNameInput = $('#kBrandNameInput');
    el.kSeriesNameInput = $('#kSeriesNameInput');
    el.kRules = $('#kRules');
    el.kEst = $('#kEst');
    el.kFormulaOut = $('#kFormulaOut');
    el.tpl = $('#tplList');
    el.kSaveTpl = $('#kSaveTpl');
    el.kEditNote = $('#kEditNote');
    el.kEditName = $('#kEditName');
    el.kSeriesEdit = $('#kSeriesEdit');

    seedIfNeeded();
    renderBrands();
    renderSeries();
    renderRules();
    renderOut();
    renderTpl();
    renderEditNote();

    if ($('#kEditCancel')) {
      $('#kEditCancel').addEventListener('click', function () {
        editingKey = null;
        renderEditNote();
        w.App.toast('Mode edit dibatalkan — simpan akan jadi entri baru');
      });
    }

    el.kPart.addEventListener('input', renderOut);
    el.kName.addEventListener('input', function () { if (seriesId === CUSTOM_SERIES) renderOut(); });

    el.kBrand.addEventListener('change', function () {
      brandId = el.kBrand.value;
      seriesId = '';
      el.kName.value = '';
      /* Ganti brand = bukan lagi mengedit entri lama (entri akan dibuat
         untuk brand baru), jadi mode edit dimatikan supaya entri lama
         tidak terhapus tanpa disadari. */
      editingKey = null;
      renderEditNote();
      if (brandId === CUSTOM_BRAND) {
        el.kBrandNameInput.value = '';
        el.kSeriesNameInput.value = '';
      }
      renderBrands();          // perbarui warna brand di kotak Brand HP
      renderSeries();
      renderOut();
      TG.haptic('select');
    });

    function onSeriesChange() {
      var next = el.kSeries.value;
      var wasCustom = seriesId === CUSTOM_SERIES;
      seriesId = next;

      // Saat "Lainnya…" dipilih — langsung tampilkan input di bawah
      if (seriesId === CUSTOM_SERIES && brandId !== CUSTOM_BRAND) {
        /* Hanya kosongkan kolom manual kalau barusan BERPINDAH ke
           "Lainnya…". Kalau memang sudah di "Lainnya…", ketikan yang
           sudah ada jangan dihapus — dulu ini bikin seri hilang dan
           tombol simpan menolak ("Pilih seri HP dulu"). */
        if (!wasCustom) el.kName.value = '';
        el.kName.classList.remove('hidden');
        el.kName.style.display = '';
        renderOut();
        TG.haptic('select');
        return;
      }

      // Seri lain dipilih — sembunyikan input
      el.kName.classList.add('hidden');
      el.kName.style.display = 'none';
      renderSeries();
      renderOut();
      TG.haptic('select');
    }
    el.kSeries.addEventListener('change', onSeriesChange);
    el.kSeries.addEventListener('input', onSeriesChange);

    el.kBrandNameInput.addEventListener('input', function () {
      if (brandId === CUSTOM_BRAND) renderOut();
    });
    el.kSeriesNameInput.addEventListener('input', function () {
      if (brandId === CUSTOM_BRAND) renderOut();
    });

    el.kRules.addEventListener('click', function (e) {
      var b = e.target.closest('[data-rule]');
      if (!b) return;
      ruleId = b.dataset.rule;
      renderRules();
      renderOut();
      TG.haptic('select');
    });

    $('#kSaveTpl').addEventListener('click', saveTpl);

    el.tpl.addEventListener('click', function (e) {
      var brandBtn = e.target.closest('[data-tplbrand]');
      var use = e.target.closest('[data-tpluse]');
      var del = e.target.closest('[data-tpldel]');
      if (brandBtn) {
        var bid = brandBtn.dataset.tplbrand;
        // Toggle: klik brand yang sama → sembunyikan daftar; klik brand lain → tampilkan
        if (filterBrand === bid) {
          filterBrand = '';
        } else {
          filterBrand = bid;
        }
        renderTpl();
        TG.haptic('select');
        return;
      }
      if (use) {
        var x = (S.state.templates || []).filter(function (t) { return t.id === use.dataset.tpluse; })[0];
        if (x) {
          applyTpl(x.payload || {});
          /* Masuk MODE EDIT: entri ini akan diganti (bukan ditambah) saat
             disimpan, jadi nama seri lama bisa diperbarui / ditambah
             persamaan namanya tanpa membuat entri kembar. Nama seri langsung
             bisa diketik di kotak Seri HP. */
          editingKey = S.templateKey ? S.templateKey(x.payload || {}) : null;
          if (el.kSeriesEdit) el.kSeriesEdit.value = (x.payload || {}).series || '';
          renderEditNote();
          w.scrollTo({ top: 0, behavior: 'smooth' });
          TG.haptic('success');
          w.App.toast('Mode edit: nama seri bisa langsung diketik di kotak Seri HP', 3000);
        }
      } else if (del) {
        var delKey = '';
        var d = (S.state.templates || []).filter(function (t) { return t.id === del.dataset.tpldel; })[0];
        if (d && S.templateKey) delKey = S.templateKey(d.payload || {});
        S.state.templates = (S.state.templates || []).filter(function (t) { return t.id !== del.dataset.tpldel; });
        if (delKey && delKey === editingKey) { editingKey = null; renderEditNote(); }
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
