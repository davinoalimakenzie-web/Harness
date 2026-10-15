/* =========================================================
   scan.js — Scan struk otomatis (foto -> isi transaksi)
   =========================================================
   Alur:
     1. User tekan tombol 📷 Scan Struk -> pilih/ambar foto struk.
     2. Foto dikompres & di-OCR dengan Tesseract.js (dimuat
        seketika dari CDN, hanya saat dipakai).
     3. Teks OCR diurai: cari TOTAL, tanggal, dan nama toko.
     4. Hasilnya mengisi nominal + keterangan + saran kategori,
        TAPI NILAI-NILAI ITU BUKAN FINAL. User tetap menekan ✓
        untuk menyimpan (prinsip deterministik, PRD 17).

   Kalau CDN tidak terjangkau / OCR gagal:
     - Aplikasi TIDAK crash. Foto tetap bisa dilampirkan ke
       transaksi sebagai bukti, dan user mengetik nominal manual.
   ========================================================= */
(function (w) {
  'use strict';

  var S = w.Store;

  // Muat Tesseract.js hanya saat benar-benar dipakai (hemat kuota)
  var TESS_SCRIPT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
  var tessPromise = null;
  var tessWorker = null;

  function loadTesseract() {
    if (tessPromise) return tessPromise;
    tessPromise = new Promise(function (resolve, reject) {
      if (w.Tesseract) return resolve(w.Tesseract);
      var s = document.createElement('script');
      s.src = TESS_SCRIPT;
      s.async = true;
      s.onload = function () {
        if (w.Tesseract) resolve(w.Tesseract);
        else reject(new Error('Tesseract gagal dimuat'));
      };
      s.onerror = function () { reject(new Error('Tidak bisa mengunduh mesin OCR')); };
      document.head.appendChild(s);
    });
    return tessPromise;
  }

  /* ------------------------------------------------------------
     Kompres gambar agar lebih ringan & cepat di-OCR
     ------------------------------------------------------------ */
  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error('Gagal membaca foto')); };
      fr.readAsDataURL(file);
    });
  }

  function loadImage(dataUrl) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('Format foto tidak didukung')); };
      img.src = dataUrl;
    });
  }

  function compress(file, maxW, quality) {
    maxW = maxW || 1400; quality = quality || 0.85;
    return readFile(file)
      .then(loadImage)
      .then(function (img) {
        var scale = Math.min(1, maxW / img.naturalWidth);
        var cw = Math.round(img.naturalWidth * scale);
        var ch = Math.round(img.naturalHeight * scale);
        var cv = document.createElement('canvas');
        cv.width = cw; cv.height = ch;
        var ctx = cv.getContext('2d');
        ctx.drawImage(img, 0, 0, cw, ch);
        return { dataUrl: cv.toDataURL('image/jpeg', quality), width: cw, height: ch };
      });
  }

  /* ------------------------------------------------------------
     Jalankan OCR
     ------------------------------------------------------------ */
  function ocr(dataUrl, onProgress) {
    return loadTesseract()
      .then(function (T) {
        if (!tessWorker) {
          tessWorker = T.createWorker('ind+eng', 1, {
            logger: function (m) {
              if (onProgress && m && typeof m.progress === 'number') onProgress(m);
            }
          });
        }
        return tessWorker.recognize(dataUrl);
      })
      .then(function (res) {
        return (res && res.data && res.data.text) || '';
      });
  }

  /* ------------------------------------------------------------
     Urai teks struk -> kandidat nominal, tanggal, nama toko
     ------------------------------------------------------------ */

  // Kata kunci total (prioritas tinggi)
  var TOTAL_WORDS = [
    'grand total', 'total bayar', 'total payment', 'total',
    'jumlah bayar', 'jumlah', 'total harga', 'total belanja',
    'total tagihan', 'amount due', 'tunai', 'cash'
  ];
  // Kata kunci yang HARUS diabaikan (harga satuan, pajak, kembalian)
  var IGNORE_WORDS = ['harga', 'satuan', 'qty', 'jumlah item', 'subtotal', 'kembalian', 'change', 'diskon', 'discount', 'ppn', 'pajak', 'service charge'];

  function toNumberID(s) {
    // "25.000" / "25,000" / "25000" -> 25000 ; "Rp25.000" -> 25000
    var t = String(s).replace(/[^\d.,]/g, '');
    if (!t) return null;
    // Buang pemisah ribuan: brace berpasangan 3 digit di belakang
    t = t.replace(/(\d)[.,](\d{3})(?!\d)/g, '$1$2');
    t = t.replace(/[.,]/g, '');
    var n = parseInt(t, 10);
    return isFinite(n) ? n : null;
  }

  /** Ekstrak nominal total terbaik dari teks struk. */
  function extractTotal(text) {
    var lines = String(text || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean);

    // 1) Cari baris bertanda "total" ( prioritas keyword paling spesifik )
    for (var pass = 0; pass < TOTAL_WORDS.length; pass++) {
      var kw = TOTAL_WORDS[pass];
      for (var i = lines.length - 1; i >= 0; i--) {
        var low = lines[i].toLowerCase();
        if (low.indexOf(kw) < 0) continue;
        if (IGNORE_WORDS.some(function (bad) { return low.indexOf(bad) >= 0; })) continue;
        // Ambil angka terbesar di baris itu
        var nums = low.match(/\d[\d.,]*/g) || [];
        var best = null;
        for (var j = 0; j < nums.length; j++) {
          var n = toNumberID(nums[j]);
          if (n && n >= 1000 && (best === null || n > best)) best = n;
        }
        if (best) return { amount: best, from: kw, line: lines[i] };
      }
    }

    // 2) Fallback: angka terbesar yang terlihat seperti rupiah
    var all = String(text || '').match(/\d[\d.,]*/g) || [];
    var max = null;
    for (var k = 0; k < all.length; k++) {
      var v = toNumberID(all[k]);
      if (v && v >= 1000 && (max === null || v > max)) max = v;
    }
    if (max) return { amount: max, from: 'heuristik', line: null };
    return null;
  }

  /** Tebak tanggal struk (YYYY-MM-DD dari ISO atau DD/MM/YYYY). */
  function extractDate(text) {
    var m = String(text).match(/\b(\d{4})[-/](\d{2})[-/](\d{2})\b/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = String(text).match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/);
    if (m) {
      var d = m[1].padStart(2, '0'), mo = m[2].padStart(2, '0');
      return m[3] + '-' + mo + '-' + d;
    }
    return null;
  }

  /** Ambil nama toko (baris awal yang dominan & bukan kata receipt generik). */
  var GENERIC = ['struk', 'receipt', 'invoice', 'nota', 'bukti', 'kuitansi',
                 'terima kasih', 'thank you', 'kasinir', 'kasir', 'no', 'no.', 'tanggal', 'date'];
  function extractMerchant(text) {
    var lines = String(text || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    for (var i = 0; i < Math.min(lines.length, 4); i++) {
      var l = lines[i];
      var low = l.toLowerCase();
      if (l.length < 3 || l.length > 40) continue;
      if (GENERIC.some(function (g) { return low.indexOf(g) >= 0; })) continue;
      if (/^[\d\s\-:/.]+$/.test(l)) continue; // hanya angka
      return l;
    }
    return null;
  }

  /** Saran kategori dari teks toko/barang. */
  function guessCategory(text) {
    var t = String(text || '').toLowerCase();
    var rules = [
      ['alfamart', 'out', 'Out Harian', 'Belanja Dapur'],
      ['alfa mart', 'out', 'Out Harian', 'Belanja Dapur'],
      ['indomaret', 'out', 'Out Harian', 'Belanja Dapur'],
      ['superindo', 'out', 'Out Harian', 'Belanja Dapur'],
      ['pizzain', 'out', 'Out Harian', 'Belanja Dapur'],
      ['supermarket', 'out', 'Out Harian', 'Belanja Dapur'],
      ['swalayan', 'out', 'Out Harian', 'Belanja Dapur'],
      ['warung', 'out', 'Out Harian', 'Belanja Dapur'],
      ['bensi', 'out', 'Support Bulanan', 'Bensin'],
      ['pertamax', 'out', 'Support Bulanan', 'Bensin'],
      ['shell', 'out', 'Support Bulanan', 'Bensin'],
      ['bpjs', 'out', 'Support Bulanan', 'Kesehatan'],
      ['apotek', 'out', 'Support Bulanan', 'Kesehatan'],
      ['klinik', 'out', 'Support Bulanan', 'Kesehatan'],
      ['hospital', 'out', 'Support Bulanan', 'Kesehatan'],
      ['telkom', 'out', 'Support Bulanan', 'Kuota'],
      ['indihome', 'out', 'Support Bulanan', 'Kuota'],
      ['simPATI', 'out', 'Support Bulanan', 'Kuota'],
      ['pln', 'out', 'Support Bulanan', 'Token Listrik'],
      ['listrik', 'out', 'Support Bulanan', 'Token Listrik'],
      ['roncelia', 'in', 'Income Hima', 'Roncelia'],
      ['rias', 'in', 'Income Hima', 'Riasan'],
      ['service hp', 'in', 'Income Ali', 'Service HP'],
      ['servis hp', 'in', 'Income Ali', 'Service HP'],
      ['gaji', 'in', 'Income Ali', 'Gaji Intika'],
    ];
    for (var i = 0; i < rules.length; i++) {
      if (t.indexOf(rules[i][0].toLowerCase()) >= 0) {
        return { group: rules[i][2], sub: rules[i][3], type: rules[i][1] };
      }
    }
    return null;
  }

  /* ------------------------------------------------------------
     Alur utama: foto -> hasil scan
     ------------------------------------------------------------ */
  /**
   * @param {File} file
   * @param {(stage:string, pct:number)=>void} onProgress
   * @returns {Promise<{amount, date, merchant, text, category, dataUrl, ocrOk}>}
   */
  function scanReceipt(file, onProgress) {
    var report = function (stage, pct) { if (onProgress) onProgress(stage, pct); };

    return compress(file)
      .then(function (c) {
        report('membaca', 0.1);
        return c;
      })
      .then(function (c) {
        report('mengenali teks', 0.2);
        return ocr(c.dataUrl, function (m) {
          if (m.status && m.status.indexOf('recogniz') >= 0) {
            report('mengenali teks', 0.2 + (m.progress || 0) * 0.7);
          }
        })
          .then(function (text) {
            report('menyusun hasil', 0.95);
            var total = extractTotal(text);
            var date = extractDate(text);
            var merchant = extractMerchant(text);
            var cat = guessCategory(merchant ? merchant + ' ' + text.slice(0, 400) : text.slice(0, 400));
            return {
              amount: total ? total.amount : null,
              amountFrom: total ? total.from : null,
              date: date,
              merchant: merchant,
              category: cat,
              text: text,
              dataUrl: c.dataUrl,
              ocrOk: true
            };
          })
          .catch(function (e) {
            // OCR gagal — tetap kembalikan foto agar bisa dilampirkan
            return {
              amount: null, amountFrom: null, date: null, merchant: null,
              category: null, text: '', dataUrl: c.dataUrl,
              ocrOk: false, ocrError: e.message
            };
          });
      });
  }

  w.Scan = {
    scanReceipt: scanReceipt,
    extractTotal: extractTotal,
    extractDate: extractDate,
    extractMerchant: extractMerchant,
    guessCategory: guessCategory,
    toNumberID: toNumberID,
    // untuk uji
    _internal: { compress: compress, ocr: ocr }
  };
})(window);
