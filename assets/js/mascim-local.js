/*
 * Mas Cim — mesin data LOKAL (local-first).
 *
 * Kenapa file ini ada:
 *   Modul Mas Cim menyimpan datanya di server bot. Server itu hanya bisa
 *   dijangkau lewat tunnel HTTPS, dan tunnel gratis (Cloudflare Quick) di
 *   lingkungan ini mati dalam hitungan detik. Akibatnya modul tidak bisa
 *   dibuka dan tidak ada tombol yang bisa dipakai.
 *
 * Apa yang dilakukan file ini:
 *   Meniru seluruh aturan bisnis Mas Cim (nomor nota, hitungan jasa, sisa
 *   pelunasan, sparepart, cashflow, Dana Bank) DI DALAM Mini App, memakai
 *   localStorage sebagai sumber kebenaran. Jadi semua tombol tetap berfungsi
 *   walau server tidak terjangkau sama sekali. Server hanya jadi bonus
 *   (sinkron) ketika kebetulan hidup.
 *
 * Aturan bisnis di sini SALINAN dari bot/src/mascim-db.js supaya hasilnya
 * sama: semua angka turunan dihitung dari detail, tidak pernah disimpan
 * terpisah, jadi mustahil tidak sinkron.
 */
(function (w) {
  'use strict';

  var KEY = 'nava.mascim.local.v1';

  /*
     Status servis — HANYA 6, sesuai permintaan:
       1. Done            — selesai, barang belum diambil
       2. Done Diambil    — selesai, barang sudah diambil
       3. Progress        — sedang dikerjakan (status awal setiap nota masuk)
       4. Cancel          — dibatalkan, barang belum diambil
       5. Cancel Diambil  — dibatalkan, barang sudah diambil pelanggan
       6. Nggandul        — gabungan Cancel/Progress/Done: data nota berubah
                             sehingga status sebenarnya belum pasti dan WAJIB
                             dikonfirmasi ulang oleh pemilik.
  */
  var SERVICE_STATUSES = ['Progress', 'Done', 'Done Diambil', 'Cancel', 'Cancel Diambil', 'Nggandul'];

  // Status saat nota pertama kali masuk — selalu Progress, tidak ada pilihan lain.
  var INITIAL_STATUS = 'Progress';

  // Status yang berarti "masih dikerjakan".
  var ACTIVE_STATUS = 'Progress';
  // Status final (sudah keluar dari meja kerja).
  var DONE_STATUSES = ['Done', 'Done Diambil'];
  var CANCEL_STATUSES = ['Cancel', 'Cancel Diambil'];
  var CLOSED_STATUSES = DONE_STATUSES.concat(CANCEL_STATUSES);
  var NGGANDUL = 'Nggandul';

  /*
     Transisi status yang valid. Ini satu-satunya sumber kebenaran: UI dropdown
     membacanya, dan mesin data memvalidasinya (lihat setServiceStatus).
       - Progress  -> Done atau Cancel
       - Done      -> Done Diambil
       - Cancel    -> Cancel Diambil
       - Nggandul  -> semua status, karena nota dalam Nggandul perlu ditinjau
                     teknisi dan bisa diselesaikan ke arah mana pun
  */
  var STATUS_TRANS = {
    'Progress': ['Done', 'Cancel'],
    'Done': ['Done Diambil'],
    'Cancel': ['Cancel Diambil'],
    'Done Diambil': [],
    'Cancel Diambil': [],
    'Nggandul': ['Progress', 'Done', 'Cancel', 'Done Diambil', 'Cancel Diambil']
  };

  var PAYMENT_STATUSES = ['Belum Bayar', 'DP', 'Lunas'];

  /*
     Garansi: masa garansi yang salesman bisa pilih saat mencatat pembayaran.
     "Non Garansi" dipakai kalau tidak ada garansi sama sekali.
  */
  var WARRANTY_OPTIONS = ['30 Hari', '60 Hari', 'Non Garansi'];

  /*
     Metode pembayaran. "Campuran" dipakai kalau sebagian Tunai sebagian
     Qriss; total nominal tetap satu baris (yang sudah diinput teknisi).
  */
  var PAYMENT_METHODS = ['Tunai', 'Qriss', 'Campuran (Tunai dan Qriss)'];

  /*
     Terima nilai opsional dari payload dan pastikan ia salah satu dari daftar
     yang sah. Nilai kosong/undefined jadi null (tidak diisi), nilai yang tidak
     dikenal ditolak supaya data tidak pernah diam-diam menyimpan salah ketik.
  */
  function normOpt(v, allowed, label) {
    if (v == null) return null;
    var s = String(v).trim();
    if (!s) return null;
    if (allowed.indexOf(s) < 0) {
      throw bad(label + ' tidak dikenal: "' + s + '". Pilihan yang tersedia: ' + allowed.join(', '));
    }
    return s;
  }

  /*
     Masa garansi pada nota pelanggan. Sesuai ketentuan, nota garansi berlaku
     60 hari dihitung dari tanggal nota diterbitkan (bukan dari tanggal nota
     dibuat, dan bukan dari tanggal pembayaran).
  */
  var WARRANTY_NOTE_DAYS = 60;

  /*
     Kunci layar. "Pola" TIDAK memakai teks "1-2-3": pola disimpan sebagai
     koordinat titik yang benar-benar digambar pengguna lalu dihitung jaraknya
     dari titik acuan, sehingga tebakan teks tidak akan pernah cocok.
  */
  var LOCK_TYPES = ['Tanpa Kunci', 'Pola', 'PIN', 'Password'];

  /*
     Pendanaan sparepart: sesuai permintaan SETIAP sparepart otomatis memakai
     Dana Bank, jadi pilihan "Uang Sendiri" dihapus.
  */
  var FUNDING_PART = 'Dana Bank';

  /* ------------------------------------------------------------------
     Pola layar (pattern lock).

     Pola disimpan sebagai RANGKO KOORDINAT TITIK yang benar-benar digambar
     pengguna, bukan teks seperti "1-2-3". Setiap titik disimpan sebagai
     koordinat ternormalisasi 0..1 (bukan 0..8), lalu dibandingkan memakai
     jarak dari titik acuan. Konsekuensinya:

       - pola yang benar hanya bisa dibuka oleh coretan yang sama_, sehingga
         tebakan teks tidak akan pernah berhasil;
       - pola tetap jalan walau ukuran layar atau kepadatan piksel berbeda,
         karena yang dibandingkan jarak relatif, bukan nomor indeks.

     Format: "x,y;x,y;x,y..." (titik acuan yang sedang disentuh, urut waktu).
  ------------------------------------------------------------------ */
  var PATTERN_MIN_POINTS = 4;   // minimal titik agar bukan coretan acak
  var PATTERN_TOLERANCE = 0.22; // toleransi jarak antar titik (skala 0..1)

  function isPatternSecret(s) {
    return parsePattern(s).length >= PATTERN_MIN_POINTS;
  }

  /** Ubah teks pola -> array koordinat ternormalisasi. Aman untuk input rusak. */
  function parsePattern(s) {
    if (typeof s !== 'string' || !s) return [];
    return s.split(';').map(function (pair) {
      var xy = pair.split(',');
      if (xy.length !== 2) return null;
      var x = Number(xy[0]), y = Number(xy[1]);
      if (!isFinite(x) || !isFinite(y)) return null;
      // Terima baik koordinat 0..1 (asli) maupun indeks 0..8 (mode lama)
      // supaya pola yang tersimpan sebelumnya tetap bisa dipakai.
      if (x > 1 || y > 1) { x = x / 8; y = y / 8; }
      if (x < 0 || x > 1 || y < 0 || y > 1) return null;
      return { x: x, y: y };
    }).filter(Boolean);
  }

  /**
     Cocokkan coretan baru dengan pola tersimpan.
     Semua titik pada pola harus muncul pada coretan (dalam urutan), dan
     panjang coretan tidak boleh jauh lebih panjang supaya coretan acak
     tambahan tidak dipakai menembak pola.
  */
  function matchPattern(secret, attempt) {
    var pat = parsePattern(secret);
    var att = parsePattern(attempt);
    if (pat.length < PATTERN_MIN_POINTS || att.length < PATTERN_MIN_POINTS) return false;
    if (att.length > pat.length + 2) return false;

    // Cocokkan tiap titik pola ke titik coretan terdekat yang belum terpakai.
    var used = new Array(att.length).fill(false);
    for (var i = 0; i < pat.length; i++) {
      var best = -1, bestD = Infinity;
      for (var j = 0; j < att.length; j++) {
        if (used[j]) continue;
        var dx = att[j].x - pat[i].x, dy = att[j].y - pat[i].y;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d < bestD) { bestD = d; best = j; }
      }
      if (best < 0 || bestD > PATTERN_TOLERANCE) return false;
      used[best] = true;
    }
    return true;
  }

  /* Peta status lama -> status baru, untuk data yang sudah tersimpan. */
  var STATUS_MIGRATION = {
    'Masuk': 'Progress',
    'Proses': 'Progress',
    'Menunggu Part': 'Progress',
    'Selesai': 'Done',
    'Sudah Diambil': 'Done Diambil',
    'Batal': 'Cancel'
  };

  function isDoneStatus(s) { return DONE_STATUSES.indexOf(s) >= 0; }
  function isCancelStatus(s) { return CANCEL_STATUSES.indexOf(s) >= 0; }
  function isClosedStatus(s) { return CLOSED_STATUSES.indexOf(s) >= 0; }

  /*
     Status yang mengunci pembayaran.

     Pembayaran hanya sah saat nota berstatus "Done" (garapan sudah selesai,
     pelanggan tinggal bayar). Jadi status Progress, Cancel, Cancel Diambil
     dan Done Diambil semuanya terkunci. Alurnya: ubah status ke Done ->
     catat pembayaran -> pelunasan penuh otomatis jadi "Done Diambil".

     Aturan ditegakkan di mesin data, bukan hanya di layar, jadi tidak bisa
     dilewati lewat permintaan langsung.
  */
  function isPayLocked(s) { return s !== 'Done'; }

  /* ------------------------------------------------------------
     Penyimpanan
     ------------------------------------------------------------ */
  function blank() {
    return {
      version: 1,
      settings: { bankFundInitial: 0, noteCounter: 0 },
      orders: [],        // nota servis (soft delete lewat deletedAt)
      parts: [],         // { id, orderId, partName, capitalCost, fundingSource, createdAt }
      payments: [],      // { id, orderId, amount, paymentType, paidAt, note, warranty, paymentMethod, createdAt, idemKey }
      cashflow: [],      // { id, orderId, entryType, description, moneyIn, moneyOut, entryDate, createdAt, reversedAt }
      bank: []           // { id, orderId, description, moneyIn, moneyOut, entryDate, createdAt, reversedAt }
    };
  }

  var cache = null;

  function load() {
    if (cache) return cache;
    try {
      var raw = w.localStorage.getItem(KEY);
      cache = raw ? JSON.parse(raw) : blank();
    } catch (e) {
      cache = blank();
    }
    if (!cache || typeof cache !== 'object') cache = blank();
    if (!Array.isArray(cache.orders)) cache.orders = [];
    if (!Array.isArray(cache.parts)) cache.parts = [];
    if (!Array.isArray(cache.payments)) cache.payments = [];
    if (!Array.isArray(cache.cashflow)) cache.cashflow = [];
    if (!Array.isArray(cache.bank)) cache.bank = [];
    if (!cache.settings) cache.settings = { bankFundInitial: 0, noteCounter: 0 };
    if (migrate()) save();
    return cache;
  }

  /*
     Migrasi data lama -> baru.

     Yang diubah:
       - status lama (Masuk/Proses/Menunggu Part/Selesai/Sudah Diambil/Batal)
         dipetakan ke 6 status baru. "Menunggu Part" tidak ada lagi, jadi
         ikut menjadi Progress (bisa diubah manual setelahnya).
       - jenis kunci layar "Pola" dihapus: tidak ada lagi di LOCK_TYPES, jadi
         nilainya tidak lagi bisa dipakai. Catatan yang tidak bisa dipetakan
         (mis. "Batal Diambil") menjadi Cancel — makna paling dekat.
       - status di luar daftar 6 (mis. hasil eksperimen sebelumnya) menjadi
         Nggandul supaya jelas perlu diperiksa, bukan hilang diam-diam.

     Mengembalikan true kalau ada yang berubah.
  */
  function migrate() {
    var changed = false;
    var orders = cache.orders || [];

    for (var i = 0; i < orders.length; i++) {
      var o = orders[i];

      // Status
      var s = o.serviceStatus;
      if (s && SERVICE_STATUSES.indexOf(s) < 0) {
        if (STATUS_MIGRATION[s]) o.serviceStatus = STATUS_MIGRATION[s];
        else if (s === 'Batal Diambil') o.serviceStatus = 'Cancel Diambil';
        else o.serviceStatus = NGGANDUL;
        changed = true;
      } else if (!s) {
        o.serviceStatus = INITIAL_STATUS;
        changed = true;
      }

      // Kunci pola: tidak berlaku lagi, dibuang supaya tidak menggantung.
      if (o.screenLockType && LOCK_TYPES.indexOf(o.screenLockType) < 0) {
        o.screenLockType = 'Tanpa Kunci';
        o.screenLockSecret = '';
        changed = true;
      }

      // Kolom baru (ditambahkan bertahap). Field lama TIDAK diubah — khusus
      // noteNumberRaw sengaja tidak disentuh supaya nomor nota yang sudah
      // terbit pada nota lama tetap sama seperti sebelumnya.
      if (o.intakeCondition == null) { o.intakeCondition = ''; changed = true; }
      if (o.warrantyNote == null) { o.warrantyNote = null; changed = true; }
      // ID internal untuk dipakai pada catatan/journal supaya nota yang belum
      // punya nomor tetap punya pengenal. Hanya diisi kalau kosong; nota lama
      // yang sudah punya nomor tidak diberi ID tambahan agar tidak berubah.
      if (!o.internalRef && !o.noteNumberRaw) {
        o.internalRef = makeInternalRef();
        changed = true;
      }
    }
    return changed;
  }

  function save() {
    try { w.localStorage.setItem(KEY, JSON.stringify(cache)); } catch (e) { /* penuh / diblokir */ }
  }

  function uid(p) {
    return p + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }
  function nowIso() { return new Date().toISOString(); }
  function pad4(n) { return String(n).padStart(4, '0'); }

  /* ------------------------------------------------------------
     Error (pola sama dengan server: punya .status supaya UI bisa
     membedakan pesan yang tampil vs. error server)
     ------------------------------------------------------------ */
  function LocalError(msg, status) {
    var e = new Error(msg);
    e.status = status || 400;
    e.local = true;
    return e;
  }
  function bad(msg) { return LocalError(msg, 400); }
  function notFound(msg) { return LocalError(msg || 'Data tidak ditemukan', 404); }

  /* ------------------------------------------------------------
     Hitungan turunan nota — salinan computeOrder() di server.
     ------------------------------------------------------------ */
  function computeOrder(o) {
    var parts = load().parts.filter(function (p) { return p.orderId === o.id; });
    var pays = load().payments.filter(function (p) { return p.orderId === o.id; });
    return computeWith(o, parts, pays);
  }

  function computeWith(o, parts, pays) {
    var totalPart = parts.reduce(function (s, p) { return s + (p.capitalCost || 0); }, 0);
    var paid = pays.reduce(function (s, p) { return s + (p.amount || 0); }, 0);
    var totalCost = o.totalCost || 0;

    // Rumus jasa: BIAYA dikurangi PART. Nilainya dipakai apa adanya (bisa
    // negatif bila modal part melebihi biaya) dan hanya diberi peringatan,
    // tanpa dijepit ke nol supaya angka di layar selalu sama dengan
    // pengurangan yang diminta.
    var serviceFee = totalCost - totalPart;
    var serviceFeeWarning = serviceFee < 0
      ? 'Total modal sparepart lebih besar dari total biaya — mohon periksa data' : null;

    var remaining = totalCost - paid;
    var overpaid = remaining < 0;

    // Status bayar diturunkan dari angka, tidak diisi bebas.
    var paymentStatus = 'Belum Bayar';
    if (paid > 0 && !overpaid) paymentStatus = (totalCost > 0 && paid < totalCost) ? 'DP' : 'Lunas';
    if (overpaid) paymentStatus = 'Lunas';

    var bankUsed = parts.filter(function (p) { return p.fundingSource === 'Dana Bank'; })
      .reduce(function (s, p) { return s + (p.capitalCost || 0); }, 0);
    var bankReturned = sumBankReturned(o.id);

    var wn = o.warrantyNote || null;
    // Nota LAMA (dari sebelum ada fitur nota garansi) sudah punya nomor di
    // kolom noteNumberRaw. Nomor itu dianggap sudah terbit supaya tidak
    // pernah berubah dan tidak pernah diterbitkan ulang.
    var nomor = wn && wn.number ? wn.number : (o.noteNumberRaw || null);
    var noteIssued = !!nomor;
    var issueBlock = null;
    if (!noteIssued) issueBlock = noteIssueBlockReasonRaw(o, remaining);

    var out = {
      id: o.id,
      // Nomor nota hanya ada setelah nota garansi diterbitkan. Sebelum itu
      // null — bukan "0000" — supaya tidak pernah terlihat seperti nomor
      // yang sudah terbit.
      noteNumber: noteIssued ? pad4(nomor) : null,
      noteNumberRaw: nomor,
      noteIssued: noteIssued,
      // ID internal selalu ada supaya nota bisa dirujuk sebelum ada nomor.
      internalRef: o.internalRef || null,
      // Alasan kenapa tombol "Terbitkan Nota Garansi" belum bisa dipakai.
      noteIssueBlock: issueBlock,
      canIssueNote: !noteIssued && !issueBlock,
      customerName: o.customerName,
      whatsapp: o.whatsapp,
      device: o.device,
      complaint: o.complaint,
      intakeCondition: o.intakeCondition || '',
      screenLockType: o.screenLockType,
      hasScreenLock: !!o.screenLockSecret,
      handling: o.handling,
      totalCost: totalCost,
      serviceStatus: o.serviceStatus,
      nggandulReason: o.nggandulReason || null,
      // Konfirmasi pelunasan (lihat confirmTaken). Berisi hanya setelah nota
      // ditutup jadi "Done Diambil"; dipakai untuk mengisi ulang form konfirmasi
      // supaya tidak perlu mengetik ulang.
      warranty: o.warranty || null,
      paymentMethod: o.paymentMethod || null,
      paymentStatus: paymentStatus,
      receivedAt: o.receivedAt,
      completedAt: o.completedAt,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
      parts: parts.map(function (p) {
        return {
          id: p.id, partName: p.partName, capitalCost: p.capitalCost,
          fundingSource: p.fundingSource, createdAt: p.createdAt
        };
      }),
      payments: pays.map(function (p) {
        return {
          id: p.id, amount: p.amount, paymentType: p.paymentType,
          paidAt: p.paidAt, note: p.note,
          warranty: p.warranty || null,
          paymentMethod: p.paymentMethod || null,
          createdAt: p.createdAt
        };
      }),
      totalPart: totalPart,
      paid: paid,
      remaining: overpaid ? 0 : remaining,
      overpaidAmount: overpaid ? -remaining : 0,
      serviceFee: serviceFee,
      serviceFeeWarning: serviceFeeWarning,
      bankUsed: bankUsed,
      bankReturned: bankReturned
    };

    // Isi nota pelanggan disusun SETELAH objek selesai, dari objek itu
    // sendiri. Kalau publicNoteFrom() dipanggil dari dalam literal, ia akan
    // memanggil computeOrder() lagi dan keluarannya berputar tanpa henti.
    out.warrantyNote = noteIssued ? publicNoteFrom(out, wn) : null;
    return out;
  }

  /* ------------------------------------------------------------
     Nota servis
     ------------------------------------------------------------ */
  function nextNoteNumber() {
    var st = load().settings;
    st.noteCounter = (st.noteCounter || 0) + 1;
    return st.noteCounter;
  }

  /* ------------------------------------------------------------
     Nota garansi pelanggan
     ------------------------------------------------------------

     Alur nota dipisah menjadi dua tahap, supaya nota pelanggan tidak
     bocor ke publik sebelum pekerjaannya benar-benar selesai:

       1. Saat servis MASIH di meja (masuk / Progress) nota hanya punya
          ID INTERNAL. Belum ada nomor nota, belum ada link. Pelanggan
          tidak diberi apa-apa yang bisa disebarkan.
       2. Setelah pekerjaan Selesai dan pembayaran LUNAS, pemilik menekan
          "Terbitkan Nota Garansi". Barulah dibuat nomor nota urut,
          tanggal terbit, masa garansi, dan satu link nota.

     Catatan penting soal penomoran:
       - Nomor nota hanya dibuat saat nota diterbitkan. Nota lama yang
         sudah punya nomor TIDAK PERNAH diubah, jadi data sebelumnya tetap utuh.
       - Menerbitkan dua kali tidak menghasilkan dua nomor: nomor yang
         sudah terbit dipakai ulang. Ini yang membuat aman saat tombol
         ditekan berkali-kali atau saat koneksi terputus lalu diulang.

  */

  // ID internal untuk nota yang belum punya nomor nota. Sengaja memakai
  // awalan "TRK-" supaya jelas bedanya dari nomor nota pelanggan, dan
  // pakai huruf acak agar tidak meniru pola nomor nota.
  function makeInternalRef() {
    var ALPHABET = 'abcdefghjkmnpqrstvwxyz23456789';
    return 'TRK-' + randomChars(ALPHABET, 6).toUpperCase();
  }

  // Pengambil angka acak yang kuat (crypto bila ada, Math.random sebagai
  // cadangan). Dipakai untuk ID internal dan token link — keduanya yang
  // menentukan apakah nota bisa ditebak dari luar, jadi tidak boleh
  // bergantung pada satu sumber acak saja.
  function randomChars(alphabet, n) {
    var s = '';
    var i;
    try {
      if (w.crypto && w.crypto.getRandomValues) {
        var buf = new Uint32Array(n);
        w.crypto.getRandomValues(buf);
        for (i = 0; i < n; i++) s += alphabet[buf[i] % alphabet.length];
        return s;
      }
    } catch (e) { /* jatuh ke Math.random di bawah */ }
    for (i = 0; i < n; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    return s;
  }

  // Token link nota pelanggan. Harus sulit ditebak supaya link tidak
  // bisa dicoba-coba, dan tidak boleh memakai id nota (yang terlihat di
  // data internal) maupun nomor nota.
  function makeNoteToken() {
    // Alfabet tanpa huruf yang mudah tertukar (i/l/o, 0/1/u) supaya token
    // masih bisa diketik manual dari layar tanpa salah baca.
    return randomChars('abcdefghjkmnpqrstvwxyz23456789', 20);
  }

  function addDaysIso(iso, days) {
    var d = new Date(iso);
    d.setDate(d.getDate() + days);
    return d.toISOString();
  }

  /*
     Urut stably untuk daftar nota.

     NoteNumberRaw bisa null (nota yang belum punya nomor garansi), jadi
     tidak bisa dihitung aritmetika. Urutan ditentukan dari tanggal masuk
     dulu, lalu nomor nota (yang sudah terbit lebih dulu di atas), lalu
     ID internal sebagai pemutus terakhir supaya urutannya tetap konsisten
     dan tidak berganti-ubah antar render.
  */
  function sortOrdersDesc(rows) {
    return rows.sort(function (a, b) {
      if (a.receivedAt < b.receivedAt) return 1;
      if (a.receivedAt > b.receivedAt) return -1;
      var an = a.noteNumberRaw == null ? Number.MAX_SAFE_INTEGER : a.noteNumberRaw;
      var bn = b.noteNumberRaw == null ? Number.MAX_SAFE_INTEGER : b.noteNumberRaw;
      if (an !== bn) return bn - an;
      return String(a.id) < String(b.id) ? 1 : String(a.id) > String(b.id) ? -1 : 0;
    });
  }

  // Referensi yang tampil di catatan internal (cashflow, Dana Bank, daftar).
  // Nomor nota kalau sudah terbit, kalau belum pakai ID internal supaya
  // baris jurnal tetap bisa dibaca. Menerima baris nota mentah maupun nota
  // yang sudah dihitung.
  function refOf(o) {
    if (!o) return '';
    if (o.noteNumberRaw) return pad4(o.noteNumberRaw);
    if (o.noteNumber) return o.noteNumber;
    return o.internalRef || o.id || '';
  }

  /*
     Syarat nota boleh diterbitkan: pekerjaan sudah Selesai (status Done /
     Done Diambil) DAN pembayaran sudah Lunas (sisa tagihan 0).

     Bentuk dua argumen supaya bisa dipakai baik dari baris nota mentah
     (untuk computeWith, sebelum `remaining` tersedia) maupun dari nota yang
     sudah dihitung.

     Dicek di mesin data, bukan hanya di layar, jadi tidak bisa dilewati
     dengan permintaan langsung ke API.
  */
  function noteIssueBlockReason(status, remaining) {
    if (!isDoneStatus(status)) {
      return 'Nota baru bisa diterbitkan setelah pekerjaan selesai (status Done). ' +
        'Status sekarang: ' + status + '.';
    }
    if (remaining > 0) {
      return 'Pembayaran belum lunas. Sisa tagihan: ' +
        remaining.toLocaleString('id-ID') + '.';
    }
    return null;
  }
  function noteIssueBlockReasonRaw(o, remaining) {
    return noteIssueBlockReason(o.serviceStatus, remaining);
  }

  /*
     Terbitkan nota garansi.

     Idempoten: kalau nota ini sudah punya nomor, nomor itu dikembalikan
     apa adanya. Tidak ada nomor kedua yang dibuat, tidak ada tanggal
     garansi yang digeser. Ini yang membuat aman terhadap penekanan
     tombol berkali-kali maupun pengulangan setelah koneksi terputus.

     Nomor nota diambil dari penghitung urut. Penghitung disimpan di
     localStorage bersama objek nota, jadi kalau aplikasi mati di tengah
     jalan nomor yang terlewat tidak akan dipakai ulang dan tidak akan ada
     dua nota dengan nomor sama.
  */
  function issueWarrantyNote(orderId) {
    var db = load();
    var row = db.orders.filter(function (x) { return x.id === orderId; })[0];
    if (!row) throw notFound('Nota tidak ditemukan');
    if (row.deletedAt) throw notFound('Nota sudah dihapus');

    // Sudah terbit? Pakai ulang, jangan buat baru. Nota lama yang sudah
    // punya nomor juga termasuk "sudah terbit" — nomornya tidak boleh
    // diganti dan tidak boleh dibuat nomor kedua.
    if (row.warrantyNote && row.warrantyNote.number) {
      return { note: publicNote(row), reused: true };
    }
    if (row.noteNumberRaw) {
      // Nota lama: nomornya sudah ada sejak dulu, tapi nota garansi
      // (teranggal terbit + link) belum pernah dibuat untuknya. Ini bukan
      // kondisi "terbit ulang" — jawab apa adanya supaya tidak menyesatkan.
      throw bad('Nota ini sudah punya nomor (' + pad4(row.noteNumberRaw) +
        ') dari data sebelumnya, jadi tidak bisa diterbitkan ulang. ' +
        'Nomor nota lama tidak diubah.');
    }

    var order = computeOrder(row);
    var blocked = noteIssueBlockReason(order.serviceStatus, order.remaining);
    if (blocked) throw bad(blocked);

    var now = nowIso();
    var number = nextNoteNumber();

    row.warrantyNote = {
      number: number,
      issuedAt: now,
      warrantyDays: WARRANTY_NOTE_DAYS,
      warrantyUntil: addDaysIso(now, WARRANTY_NOTE_DAYS),
      token: makeNoteToken(),
      revokedAt: null
    };
    // Nomor nota baru ikut tersimpan di kolom utama supaya pencarian dan
    // daftar tetap bisa memakai kolom yang sama seperti data lama.
    row.noteNumberRaw = number;
    row.updatedAt = now;
    save();

    return { note: publicNote(row), reused: false };
  }

  /*
     Cabut link nota garansi. Nota yang sudah terbit tidak dihapus dan
     nomornya tidak berubah — hanya link-nya yang tidak berlaku lagi,
     supaya pelanggan lama yang sudah menyimpan tautan tidak bisa membuka
     data yang tidak boleh dibuka.
  */
  function revokeWarrantyNote(orderId) {
    var row = load().orders.filter(function (x) { return x.id === orderId; })[0];
    if (!row) throw notFound('Nota tidak ditemukan');
    if (!row.warrantyNote || !row.warrantyNote.number) {
      throw bad('Nota garansi ini belum diterbitkan, jadi tidak ada link untuk dicabut.');
    }
    if (row.warrantyNote.revokedAt) {
      return { note: publicNote(row), alreadyRevoked: true };
    }
    row.warrantyNote.revokedAt = nowIso();
    row.updatedAt = row.warrantyNote.revokedAt;
    save();
    return { note: publicNote(row), alreadyRevoked: false };
  }

  /*
     Batalkan pencabutan. Nomor, tanggal terbit, dan masa garansi tidak
     disentuh — hanya tanda pencabutannya yang dihapus, jadi link yang
     sebelumnya tidak berlaku kembali bisa dibuka. Aman dipanggil berkali-
     kali: kalau nota tidak sedang dicabut, tidak terjadi apa-apa.
  */
  function unrevokeWarrantyNote(orderId) {
    var row = load().orders.filter(function (x) { return x.id === orderId; })[0];
    if (!row) throw notFound('Nota tidak ditemukan');
    if (!row.warrantyNote || !row.warrantyNote.number) {
      throw bad('Nota garansi ini belum diterbitkan.');
    }
    if (!row.warrantyNote.revokedAt) {
      return { note: publicNote(row), wasActive: true };
    }
    row.warrantyNote.revokedAt = null;
    row.updatedAt = nowIso();
    save();
    return { note: publicNote(row), wasActive: false };
  }

  /*
     Data nota yang dikirim ke publik.

     Ini satu-satunya tempat yang menyusun isi nota pelanggan, jadi
     alasan data mana yang boleh keluar bisa dijaga di satu titik.

     Yang SENGAJA tidak ikut: PIN/pola layar, nilai kunci, modal
     sparepart, sumber pendanaan, Dana Bank, catatan internal
     (nggandulReason), serta id internal. Pelanggan hanya perlu
     identitas, keluhan, penanganan, sparepart yang terpasang (namanya
     saja), total biaya, dan masa garansi.
  */
  /*
     Susun isi nota pelanggan.

     `order` adalah hasil computeOrder() dan `wn` adalah baris nota garansi
     mentahnya. Keduanya diberikan terpisah supaya fungsi ini tidak perlu
     memanggil computeOrder() lagi — computeWith() sudah memuat publicNote(),
     jadi memanggilnya dari dalam akan berputar tanpa henti.
  */
  function publicNoteFrom(order, wn) {
    if (!wn || !wn.number) return null;

    // Tanggal lunas = pembayaran terakhir yang membuat sisa tagihan 0.
    var pays = order.payments || [];
    var lastPay = null;
    for (var i = 0; i < pays.length; i++) {
      if (!lastPay || pays[i].paidAt > lastPay.paidAt) lastPay = pays[i];
    }
    var paidAt = order.remaining <= 0
      ? (lastPay ? lastPay.paidAt : order.updatedAt)
      : null;

    return {
      number: wn.number,
      numberLabel: pad4(wn.number),
      issuedAt: wn.issuedAt,
      warrantyDays: wn.warrantyDays,
      warrantyUntil: wn.warrantyUntil,
      takenAt: order.takenAt || null,
      token: wn.token,
      revoked: !!wn.revokedAt,
      revokedAt: wn.revokedAt || null,
      // Identitas pelanggan & unit
      customerName: order.customerName,
      whatsapp: order.whatsapp,
      device: order.device,
      // Isi pekerjaan
      complaint: order.complaint,
      intakeCondition: order.intakeCondition || '',
      handling: order.handling || '',
      // Sparepart: NAMA SAJA. Modal dan sumber dananya tidak ikut.
      parts: (order.parts || []).map(function (p) { return p.partName; }),
      // Angka
      totalCost: order.totalCost,
      paidAt: paidAt,
      serviceStatus: order.serviceStatus,
      receivedAt: order.receivedAt
    };
  }

  // Bentuk yang menerima baris nota mentah (dipakai di luar computeWith).
  function publicNote(row) {
    return publicNoteFrom(computeOrder(row), row.warrantyNote);
  }

  /*
     Link nota mandiri (self-contained).

     Link-token hanya berlaku di perangkat tempat nota dibuat, karena
     isinya dibaca dari localStorage. Padahal nota garansi sering perlu
     dibuka dari HP lain, misalnya oleh pelanggan.

     Solusinya: data nota yang SUDAH disaring (lihat publicNoteFrom)
     dimasukkan ke dalam tautan itu sendiri, jadi halaman publik tidak
     perlu data dari perangkat mana pun. Yang masuk ke tautan persis
     field yang sudah diizinkan keluar - tidak ada PIN/pola layar,
     modal sparepart, Dana Bank, atau catatan internal, karena fungsi
     ini dibangun dari publicNote(), bukan dari baris nota mentah.

     Batasnya yang perlu diketahui: tautan mandiri tidak bisa dicabut,
     karena isinya ada di dalam tautan itu sendiri. Untuk kebutuhan
     pencabutan, link lokal (berbasis token) tetap disediakan.
  */
  var SN_V = 1;

  /*
     Base64 tanpa bergantung pada btoa/atob.

     Halaman nota publik dipakai di browser (yang punya btoa), tapi mesin
     data ini juga dipakai di lingkungan uji yang tidak menyediakan fungsi
     global itu. Jadi implementasinya dibuat sendiri supaya hasil encode
     di satu tempat selalu bisa dibaca di tempat lain.
  */
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function utf8Bytes(str) {
    var bytes = [];
    var s = String(str);
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) {
        bytes.push(c);
      } else if (c < 0x800) {
        bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        // Pasangan surrogate untuk karakter di luar BMP.
        var c2 = s.charCodeAt(i + 1);
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        i++;
        bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
                   0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else {
        bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return bytes;
  }

  function bytesUtf8(bytes) {
    var out = '';
    var i = 0;
    while (i < bytes.length) {
      var b0 = bytes[i++];
      var cp;
      if (b0 < 0x80) cp = b0;
      else if (b0 < 0xe0) cp = ((b0 & 0x1f) << 6) | (bytes[i++] & 0x3f);
      else if (b0 < 0xf0) cp = ((b0 & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      else cp = ((b0 & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) |
               ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      if (cp > 0xffff) {
        cp -= 0x10000;
        out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      } else {
        out += String.fromCharCode(cp);
      }
    }
    return out;
  }

  function b64urlEncode(str) {
    var bytes = utf8Bytes(str);
    var out = '';
    for (var i = 0; i < bytes.length; i += 3) {
      var b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
      out += B64[b0 >> 2];
      out += B64[((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4)];
      out += b1 === undefined ? '=' : B64[((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6)];
      out += b2 === undefined ? '=' : B64[b2 & 63];
    }
    return out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64urlDecode(payload) {
    var s = String(payload || '').replace(/-/g, '+').replace(/_/g, '/');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw bad('Tautan nota tidak terbaca');
    var bits = '';
    for (var i = 0; i < s.length; i++) {
      if (s.charAt(i) === '=') break;
      var v = B64.indexOf(s.charAt(i));
      if (v < 0) throw bad('Tautan nota tidak terbaca');
      bits += ('000000' + v.toString(2)).slice(-6);
    }
    var bytes = [];
    for (var j = 0; j + 8 <= bits.length; j += 8) {
      bytes.push(parseInt(bits.slice(j, j + 8), 2));
    }
    return bytesUtf8(bytes);
  }

  // Bentuk ringkas: kunci pendek supaya tautan tidak terlalu panjang saat
  // dikirim lewat WhatsApp. Daftar field di sini adalah satu-satunya data
  // yang boleh masuk tautan.
  function encodePublicNote(note) {
    if (!note || !note.number) return '';
    var ringkas = {
      v: SN_V,
      n: note.number,
      i: note.issuedAt,
      w: note.warrantyDays,
      u: note.warrantyUntil,
      c: note.customerName || '',
      p: note.whatsapp || '',
      d: note.device || '',
      k: note.complaint || '',
      t: note.intakeCondition || '',
      h: note.handling || '',
      s: (note.parts || []).slice(0, 40),
      b: note.totalCost || 0,
      a: note.paidAt || '',
      r: note.receivedAt || '',
      // g = tanggal pengambilan. Kunci baru; link lama yang tidak punya g
      // tetap terbaca dan hanya menampilkan "Belum diambil".
      g: note.takenAt || ''
    };
    return b64urlEncode(JSON.stringify(ringkas));
  }

  function padEmpat(n) {
    var s = String(n);
    while (s.length < 4) s = '0' + s;
    return s;
  }

  // Baca kembali tautan mandiri. Field yang tidak dikenal diabaikan, dan
  // nilai yang bukan-teks dibuang supaya halaman publik tidak pernah
  // menampilkan objek mentah dari tautan.
  function decodePublicNote(payload) {
    var teks = b64urlDecode(payload);
    var o;
    try { o = JSON.parse(teks); } catch (e) { throw bad('Tautan nota tidak terbaca'); }
    if (!o || typeof o !== 'object' || !o.n) throw bad('Tautan nota tidak lengkap');

    function teks_(v) { return typeof v === 'string' ? v : (v == null ? '' : String(v)); }
    var parts = Array.isArray(o.s)
      ? o.s.filter(function (x) { return typeof x === 'string'; }).slice(0, 40)
      : [];

    return {
      number: Number(o.n) || 0,
      numberLabel: padEmpat(Number(o.n) || 0),
      issuedAt: teks_(o.i),
      warrantyDays: Number(o.w) || 0,
      warrantyUntil: teks_(o.u),
      takenAt: teks_(o.g),
      // Tautan mandiri tidak punya token dan tidak bisa dicabut.
      token: '',
      revoked: false,
      revokedAt: null,
      customerName: teks_(o.c),
      whatsapp: teks_(o.p),
      device: teks_(o.d),
      complaint: teks_(o.k),
      intakeCondition: teks_(o.t),
      handling: teks_(o.h),
      parts: parts,
      totalCost: Number(o.b) || 0,
      paidAt: teks_(o.a),
      serviceStatus: 'Done Diambil',
      receivedAt: teks_(o.r)
    };
  }

  // Cari nota lewat token link-nya. Ini yang dipakai halaman nota publik.
  function getPublicNoteByToken(token) {
    var t = String(token || '').trim().toLowerCase();
    if (!t) throw notFound('Token nota tidak valid');
    var row = load().orders.filter(function (x) {
      return x.warrantyNote && x.warrantyNote.token === t;
    })[0];
    if (!row) throw notFound('Nota tidak ditemukan. Link mungkin salah atau nota ini dibuat di perangkat lain.');
    return publicNote(row);
  }

  function validateOrderInput(inp) {
    var name = String(inp.customer_name == null ? '' : inp.customer_name).trim();
    if (!name) throw bad('Nama pelanggan wajib diisi');
    if (name.length > 80) throw bad('Nama pelanggan terlalu panjang (maks 80)');

    var wa = String(inp.whatsapp == null ? '' : inp.whatsapp).trim().replace(/[\s-]/g, '');
    if (wa && !/^(\+?62|0)\d{8,14}$/.test(wa)) throw bad('Nomor WhatsApp tidak valid (contoh: 081234567890)');

    var device = String(inp.device == null ? '' : inp.device).trim();
    if (!device) throw bad('Device wajib diisi');
    if (device.length > 60) throw bad('Device terlalu panjang (maks 60)');

    var complaint = String(inp.complaint == null ? '' : inp.complaint).trim();
    if (!complaint) throw bad('Kendala wajib diisi');
    if (complaint.length > 500) throw bad('Kendala terlalu panjang (maks 500)');

    // Kondisi & kelengkapan unit saat diterima. Boleh kosong (tidak wajib),
    // tapi kalau diisi tampil di nota pelanggan sebagai bukti serah terima.
    var intake = String(
      inp.intake_condition != null ? inp.intake_condition : inp.intakeCondition
    ).trim();
    if (intake.length > 500) throw bad('Kondisi unit terlalu panjang (maks 500)');

    var lockType = LOCK_TYPES.indexOf(inp.screen_lock_type) >= 0 ? inp.screen_lock_type : 'Tanpa Kunci';
    var secret = '';
    if (lockType !== 'Tanpa Kunci') {
      secret = String(inp.screen_lock_secret == null ? '' : inp.screen_lock_secret).trim();
      if (!secret) throw bad('Kunci layar wajib diisi untuk jenis ' + lockType);
      if (lockType === 'Pola') {
        // Pola harus benar-benar hasil coretan, bukan teks bebas.
        if (!isPatternSecret(secret)) throw bad('Pola belum digambar. Ketuk area pola lalu tarik jarinya membentuk coretan.');
      } else if (lockType === 'PIN' && !/^\d{4,8}$/.test(secret)) {
        throw bad('PIN harus 4-8 angka');
      }
      if (secret.length > 400) throw bad('Kunci layar terlalu panjang');
    }

    var total = (inp.total_cost == null || inp.total_cost === '') ? 0 : Number(inp.total_cost);
    if (!Number.isInteger(total) || total < 0) throw bad('Total biaya harus angka bulat >= 0');

    // Status saat nota dibuat SELALU Progress, apa pun yang dikirim klien.
    // Status lain hanya boleh dipilih lewat perpindahan status setelah nota
    // tersimpan (setServiceStatus), jadi tidak bisa "dibuat jadi Done".
    var ss = INITIAL_STATUS;
    var ps = inp.payment_status || 'Belum Bayar';
    if (PAYMENT_STATUSES.indexOf(ps) < 0) throw bad('Status pembayaran tidak dikenal');

    var received = inp.received_at || nowIso();
    if (isNaN(Date.parse(received))) throw bad('Tanggal masuk tidak valid');

    return {
      customer_name: name,
      whatsapp: wa,
      device: device,
      complaint: complaint,
      intake_condition: intake,
      screen_lock_type: lockType,
      screen_lock_secret: secret,
      handling: String(inp.handling == null ? '' : inp.handling).trim().slice(0, 1000),
      total_cost: total,
      service_status: ss,
      payment_status: ps,
      received_at: new Date(received).toISOString()
    };
  }

  function createOrder(inp) {
    var db = load();
    var v = validateOrderInput(inp);

    if (inp.idem_key) {
      var dup = db.orders.filter(function (o) { return o.idemKey === inp.idem_key; })[0];
      if (dup) return computeOrder(dup);
    }

    var now = nowIso();
    var id = inp.id || uid('so');
    var o = {
      id: id,
      // Nomor nota sengaja KOSONG di sini. Nota pelanggan baru terbit
      // setelah pekerjaan selesai + lunas (lihat issueWarrantyNote).
      // Sampai saat itu nota hanya punya ID internal.
      noteNumberRaw: null,
      internalRef: makeInternalRef(),
      warrantyNote: null,
      intakeCondition: v.intake_condition,
      customerName: v.customer_name,
      whatsapp: v.whatsapp,
      device: v.device,
      complaint: v.complaint,
      screenLockType: v.screen_lock_type,
      // Kunci disimpan lokal (bukan dikirim apa adanya ke server) supaya
      // tetap ada nilainya di perangkat, tapi tidak pernah tampil lagi.
      screenLockSecret: v.screen_lock_secret,
      handling: v.handling,
      totalCost: v.total_cost,
      serviceStatus: v.service_status,
      receivedAt: v.received_at,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      idemKey: inp.idem_key || null
    };
    db.orders.push(o);

    if (Array.isArray(inp.parts)) {
      for (var i = 0; i < inp.parts.length; i++) addPart(id, inp.parts[i]);
    }
    save();
    return computeOrder(o);
  }

  function getOrder(id) {
    var o = load().orders.filter(function (x) { return x.id === id; })[0];
    if (!o) throw notFound('Nota tidak ditemukan');
    if (o.deletedAt) throw notFound('Nota sudah dihapus');
    return computeOrder(o);
  }

  function updateOrder(id, patch) {
    var db = load();
    var cur = db.orders.filter(function (x) { return x.id === id; })[0];
    if (!cur) throw notFound('Nota tidak ditemukan');
    if (cur.deletedAt) throw bad('Nota sudah dihapus');

    // Status tujuan: kalau klien mengirimkannya, pakai itu (harus sah);
    // kalau tidak, pertahankan status yang ada sekarang.
    var nextStatus = patch.service_status != null ? patch.service_status : cur.serviceStatus;
    if (SERVICE_STATUSES.indexOf(nextStatus) < 0) throw bad('Status servis tidak dikenal');

    // Gabungkan patch dengan data lama lalu validasi ulang supaya aturan
    // saat edit sama dengan saat membuat. Status TIDAK ikut divalidasi lewat
    // validateOrderInput (yang selalu memaksa Progress) karena di sini status
    // memang boleh diubah lewat form edit.
    var merged = validateOrderInput({
      customer_name: patch.customer_name != null ? patch.customer_name : cur.customerName,
      whatsapp: patch.whatsapp != null ? patch.whatsapp : cur.whatsapp,
      device: patch.device != null ? patch.device : cur.device,
      complaint: patch.complaint != null ? patch.complaint : cur.complaint,
      intake_condition: patch.intake_condition != null ? patch.intake_condition
        : (patch.intakeCondition != null ? patch.intakeCondition : cur.intakeCondition),
      screen_lock_type: patch.screen_lock_type != null ? patch.screen_lock_type : cur.screenLockType,
      screen_lock_secret: patch.screen_lock_secret != null ? patch.screen_lock_secret
        : (patch.screen_lock_type && patch.screen_lock_type !== 'Tanpa Kunci' ? cur.screenLockSecret : ''),
      handling: patch.handling != null ? patch.handling : cur.handling,
      total_cost: patch.total_cost != null ? patch.total_cost : cur.totalCost,
      payment_status: patch.payment_status != null ? patch.payment_status : 'Belum Bayar',
      received_at: patch.received_at != null ? patch.received_at : cur.receivedAt
    });

    // Kunci lama dibuang kalau jenisnya diubah ke "Tanpa Kunci".
    if (patch.screen_lock_type === 'Tanpa Kunci') cur.screenLockSecret = '';
    else cur.screenLockSecret = merged.screen_lock_secret;

    // Total biaya berubah = angka tagihan, sisa, dan jasa berubah, jadi status
    // lama tidak otomatis benar lagi -> tandai Nggandul supaya dikonfirmasi.
    var costChanged = merged.total_cost !== cur.totalCost;

    cur.customerName = merged.customer_name;
    cur.whatsapp = merged.whatsapp;
    cur.device = merged.device;
    cur.complaint = merged.complaint;
    cur.intakeCondition = merged.intake_condition;
    cur.screenLockType = merged.screen_lock_type;
    cur.handling = merged.handling;
    cur.totalCost = merged.total_cost;
    cur.receivedAt = merged.received_at;
    cur.updatedAt = nowIso();

    if (costChanged && patch.service_status == null) {
      markNggandul(cur, 'Total biaya diubah menjadi Rp' + merged.total_cost.toLocaleString('id-ID') +
        ' — konfirmasi status');
    } else {
      cur.serviceStatus = nextStatus;
      cur.completedAt = isClosedStatus(nextStatus) ? (cur.completedAt || nowIso()) : null;
      if (nextStatus !== NGGANDUL) cur.nggandulReason = null;
    }
    save();
    // Bila nota tetap berstatus Done setelah edit, jasanya bisa berubah —
    // catatannya di Project Nava ikut diperbarui (atau dibuang bila status
    // sudah tidak Done).
    syncJasaToNava(cur.id);
    return computeOrder(cur);
  }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  /*
     Catat jasa ke cashflow Project Nava secara otomatis.

     Jasa = Biaya - Part. Begitu garapan berstatus "Done" atau "Done Diambil"
     (pekerjaan selesai dan diserahkan), jasanya otomatis masuk ke pencatatan
     arus kas Project Nava sebagai pemasukan kategori Income Ali > Service HP,
     dan langsung tampil di dashboard karena disimpan saat itu juga.

     Aman diulang: transaksi dicari lewat idem_key yang diturunkan dari id nota,
     jadi mengubah status Done <-> Done Diambil tidak pernah menghasilkan
     catatan ganda. Kalau jasanya berubah, nominalnya diperbarui, bukan
     ditambah. Kalau jasa jadi nol atau negatif, catatan sebelumnya dihapus
     supaya cashflow tidak menampilkan angka yang sudah tidak benar.
  */
  function syncJasaToNava(orderId) {
    var S = w.Store;
    if (!S || !S.Tx) return null; // Project Nava belum termuat

    // getOrder() sudah mengembalikan nota yang sudah dihitung.
    var order = getOrder(orderId);
    var idem = 'mascim-jasa:' + orderId;
    // Cari catatan jasa nota ini, termasuk yang pernah ditarik (soft delete).
    // Soft delete tidak hilang dari daftar, jadi harus dipulihkan kembali saat
    // jasanya tercatat lagi — kalau tidak, "create" akan mengira sudah ada
    // dan transactasinya tetap tersembunyi.
    var list = S.Tx.all();
    var lama = null, tercabut = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].idem_key === idem) {
        if (list[i].deleted_at) tercabut = list[i]; else lama = list[i];
        break;
      }
    }

    var jasa = order.serviceFee || 0;

    // Belum selesai: jangan catat apa-apa, dan bersihkan catatan lama bila ada.
    if (!isDoneStatus(order.serviceStatus) || jasa <= 0) {
      if (lama) { S.Tx.remove(lama.id); return { removed: true, amount: 0 }; }
      if (tercabut) { S.Tx.remove(tercabut.id); return { removed: true, amount: 0 }; }
      return null;
    }

    var note = 'Jasa Service HP — Nota ' + refOf(order) +
      (order.customerName ? ' — ' + order.customerName : '');
    var payload = {
      type: 'in', group: 'Income Ali', sub: 'Service HP',
      amount: jasa, date: todayStr(), note: note
    };

    if (lama) {
      if (lama.amount === jasa && lama.group === payload.group && lama.sub === payload.sub &&
          lama.note === note) {
        return { unchanged: true, amount: jasa, id: lama.id };
      }
      S.Tx.update(lama.id, payload);
      return { updated: true, amount: jasa, id: lama.id };
    }
    if (tercabut) {
      S.Tx.restore(tercabut.id);
      S.Tx.update(tercabut.id, payload);
      return { restored: true, amount: jasa, id: tercabut.id };
    }
    var r = S.Tx.create(payload, idem);
    return { created: !r.duplicate, duplicate: !!r.duplicate, amount: jasa, id: r.tx && r.tx.id };
  }

  /*
     Daftar status yang boleh dipilih dari status sekarang. Mengembalikan
     array baru supaya pemanggil tidak bisa mengubah daftar aslinya.
  */
  function nextStatuses(current) {
    return (STATUS_TRANS[current] || []).slice();
  }

  function setServiceStatus(id, status) {
    if (SERVICE_STATUSES.indexOf(status) < 0) throw bad('Status servis tidak dikenal');
    var o = load().orders.filter(function (x) { return x.id === id; })[0];
    if (!o) throw notFound('Nota tidak ditemukan');
    if (o.deletedAt) throw notFound('Nota sudah dihapus');
    // Hanya izinkan perpindahan status yang ada di tabel transisi, supaya
    // nota tidak bisa melompat (misal Progress langsung jadi "Done Diambil").
    // Memilih status yang sama bukan lompatan: itu diulang (idempoten),
    // jadi diperbolehkan tanpa efek samping.
    if (status !== o.serviceStatus) {
      var allowed = nextStatuses(o.serviceStatus);
      if (allowed.indexOf(status) < 0) {
        throw bad(allowed.length
          ? 'Dari status "' + o.serviceStatus + '" hanya bisa ke: ' + allowed.join(' atau ') + '.'
          : 'Status "' + o.serviceStatus + '" sudah final dan tidak bisa diubah lagi.');
      }
    }
    // Status final (Done/Done Diambil/Cancel/Cancel Diambil) mengesahkan
    // waktu selesai; kembali ke Progress/Nggandul melepaskannya lagi.
    o.completedAt = isClosedStatus(status) ? (o.completedAt || nowIso()) : null;
    // Tanggal pengambilan dicatat saat status pertama kali jadi "Diambil".
    // Di-stamp hanya sekali (pakai || ) supaya Mundur dan maju lagi tidak
    // mengubah tanggal aslinya, dan dilepas kalau kembali ke status belum
    // diambil supaya tidak pernah ada tanggal ambil tanpa barang diambil.
    var diambil = status === 'Done Diambil' || status === 'Cancel Diambil';
    o.takenAt = diambil ? (o.takenAt || nowIso()) : null;
    o.serviceStatus = status;
    o.updatedAt = nowIso();
    // Barang yang sudah diambil = modal sparepart tidak lagi tertahan,
    // jadi sisa Dana Bank nota ini dilunasi otomatis.
    var settled = 0;
    if (status === 'Done Diambil') settled = settleBankOnTaken(id);
    save();
    // Jasa masuk ke cashflow Project Nava begitu garapan selesai (Done /
    // Done Diambil), langsung tersimpan saat itu juga.
    var jasa = syncJasaToNava(id);
    var out = computeOrder(o);
    out.bankAutoSettled = settled;
    out.jasaToNava = jasa;
    return out;
  }

  /*
     Tandai nota sebagai Nggandul.

     Nggandul = gabungan Cancel, Progress, dan Done. Dipakai ketika data nota
     berubah sehingga status sebenarnya tidak lagi bisa dipastikan: misalnya
     modal part dihapus, pembayaran dibatalkan, atau total biaya diedit. Dana
     dan jasanya sudah berubah, jadi status lama bisa jadi tidak benar lagi;
     pemilik wajib memilih ulang statusnya.
  */
  function markNggandul(order, reason) {
    if (!order || order.deletedAt) return order;
    // Status final (Done/Cancel) tidak diubah diam-diam: kalau nota sudah
    // keluar dari meja, biarkan ownership-nya tetap jelas.
    if (isClosedStatus(order.serviceStatus)) return order;
    order.serviceStatus = NGGANDUL;
    order.completedAt = null;
    order.nggandulReason = reason || 'Data nota berubah, status perlu dikonfirmasi ulang';
    order.updatedAt = nowIso();
    return order;
  }

  function canDelete(id) {
    var db = load();
    getOrder(id); // pastikan ada & milik (lokal: hanya satu pengguna)
    var pays = db.payments.filter(function (p) { return p.orderId === id; }).length;
    var bank = db.bank.filter(function (b) { return b.orderId === id && !b.reversedAt; }).length;
    return {
      allowed: pays === 0 && bank === 0,
      reason: (pays || bank)
        ? 'Nota sudah punya pembayaran atau riwayat Dana Bank. Koreksi lewat pembatalan, jangan dihapus agar uang tidak hilang.'
        : null,
      payments: pays,
      bankEntries: bank
    };
  }

  function deleteOrder(id) {
    var chk = canDelete(id);
    if (!chk.allowed) throw bad(chk.reason);
    var o = load().orders.filter(function (x) { return x.id === id; })[0];
    o.deletedAt = nowIso();
    o.updatedAt = o.deletedAt;
    save();
    return { ok: true };
  }

  /* ------------------------------------------------------------
     Sparepart
     ------------------------------------------------------------ */
  function addPart(orderId, p) {
    var db = load();
    var order = db.orders.filter(function (x) { return x.id === orderId; })[0];
    if (!order || order.deletedAt) throw notFound('Nota tidak ditemukan');

    var name = String(p.part_name == null ? '' : p.part_name).trim();
    if (!name) throw bad('Nama part wajib diisi');
    var cost = Number(p.capital_cost);
    if (!Number.isInteger(cost) || cost < 0) throw bad('Modal part harus angka bulat >= 0');
    // Sparepart SELALU memakai Dana Bank; kolom funding tidak lagi dipakai.
    var fund = FUNDING_PART;
    if (cost === 0) throw bad('Modal part harus lebih dari 0 karena sparepart memakai Dana Bank');

    var now = nowIso();
    var id = p.id || uid('sp');
    db.parts.push({
      id: id, orderId: orderId, partName: name, capitalCost: cost,
      fundingSource: fund, createdAt: now
    });
    // Modal part otomatis jadi pengeluaran cashflow.
    addCashflowEntry({
      orderId: orderId, entryType: 'Modal Sparepart',
      description: name + ' — nota ' + refOf(order),
      moneyIn: 0, moneyOut: cost, entryDate: now
    });
    if (fund === 'Dana Bank' && cost > 0) {
      addBankEntry({
        orderId: orderId, description: 'Beli ' + name + ' — nota ' + refOf(order),
        moneyIn: 0, moneyOut: cost, entryDate: now
      });
    }
    order.updatedAt = now;
    save();
    // Kalau nota sudah Done, jasa ikut turun karena modal part bertambah —
    // perbarui catatan jasanya di Project Nava.
    if (isDoneStatus(order.serviceStatus)) syncJasaToNava(orderId);
    return computeOrder(order);
  }

  function removePart(partId) {
    var db = load();
    var p = db.parts.filter(function (x) { return x.id === partId; })[0];
    if (!p) throw notFound('Part tidak ditemukan');
    var order = db.orders.filter(function (x) { return x.id === p.orderId; })[0];
    if (!order) throw notFound('Nota tidak ditemukan');
    // Part modal menghasilkan outflow; hapus hanya bila nota belum punya
    // pembayaran, supaya riwayat uang tetap utuh.
    var pays = db.payments.filter(function (x) { return x.orderId === order.id; }).length;
    if (pays > 0) throw bad('Nota sudah punya pembayaran. Koreksi lewat reversal agar riwayat uang tetap benar.');

    var now = nowIso();
    db.parts = db.parts.filter(function (x) { return x.id !== partId; });
    if (p.capitalCost > 0) {
      addCashflowEntry({
        orderId: order.id, entryType: 'Koreksi',
        description: 'Batal modal ' + p.partName + ' — nota ' + refOf(order),
        moneyIn: p.capitalCost, moneyOut: 0, entryDate: now
      });
    }
    if (p.fundingSource === 'Dana Bank' && p.capitalCost > 0) {
      addBankEntry({
        orderId: order.id, description: 'Batal ' + p.partName,
        moneyIn: p.capitalCost, moneyOut: 0, entryDate: now
      });
    }
    // Modal part dihapus -> hitungan jasa berubah -> status jadi tidak pasti.
    markNggandul(order, 'Modal part "' + p.partName + '" dihapus, jasa berubah — konfirmasi status');
    save();
    // Kalau nota sudah Done, jasanya ikut naik karena modal part berkurang.
    // Dicatat ulang (bukan dicabut): nota sudah final, jadi jasanya tetap sah
    // dan hanya nominalnya yang menyesuaikan.
    syncJasaToNava(order.id);
    return computeOrder(order);
  }

  /* ------------------------------------------------------------
     Pembayaran
     ------------------------------------------------------------ */
  function addPayment(orderId, p) {
    var db = load();
    var order = getOrder(orderId); // sudah dihitung (paid/remaining valid)

    // Pembayaran hanya sah saat status "Done" (garapan selesai, pelanggan
    // tinggal bayar). Semua status lain terkunci.
    if (isPayLocked(order.serviceStatus)) {
      throw bad(order.serviceStatus === 'Done'
        ? 'Tidak bisa menambah pembayaran lagi.'
        : 'Pembayaran hanya bisa dicatat saat status Done. ' +
          'Status nota sekarang: ' + order.serviceStatus + '.');
    }

    if (p.idem_key) {
      var dup = db.payments.filter(function (x) { return x.idemKey === p.idem_key; })[0];
      if (dup) return order; // klik ganda = diam-diam
    }

    var amount = Number(p.amount);
    if (!Number.isInteger(amount) || amount <= 0) throw bad('Nominal pembayaran harus angka bulat > 0');
    var totalCost = order.totalCost;
    if (totalCost > 0) {
      var after = order.paid + amount;
      if (after > totalCost && !p.allow_overpay) {
        throw bad('Pembayaran melebihi sisa tagihan. Sisa saat ini ' + order.remaining +
          '. Sisa setelah ini ' + (totalCost - after) + '. Set allow_overpay hanya bila memang refund/koreksi.');
      }
    }
    var type = p.payment_type === 'DP' ? 'DP' : (order.paid > 0 ? 'Pelunasan' : 'Pembayaran Servis');
    var now = nowIso();
    var paidAt = p.paid_at ? new Date(p.paid_at).toISOString() : now;
    if (isNaN(Date.parse(paidAt))) throw bad('Tanggal bayar tidak valid');

    // Garansi & metode pembayaran. Terima kedua konvensi nama field
    // (warranty/payment_method dan paymentMethod) supaya tidak rapuh, tapi
    // nilainya tetap divalidasi terhadap daftar yang sah.
    var warranty = normOpt(p.warranty, WARRANTY_OPTIONS, 'Garansi');
    var payMethod = normOpt(p.payment_method != null ? p.payment_method : p.paymentMethod,
      PAYMENT_METHODS, 'Metode pembayaran');

    db.payments.push({
      id: p.id || uid('pay'), orderId: orderId, amount: amount, paymentType: type,
      paidAt: paidAt, note: String(p.note == null ? '' : p.note).slice(0, 200),
      warranty: warranty,
      paymentMethod: payMethod,
      idemKey: p.idem_key || null, createdAt: now
    });
    addCashflowEntry({
      orderId: orderId, entryType: type === 'DP' ? 'DP' : 'Pembayaran Servis',
      description: 'Nota ' + refOf(order) + ' — ' + order.customerName,
      moneyIn: amount, moneyOut: 0, entryDate: paidAt
    });
    var row = db.orders.filter(function (x) { return x.id === orderId; })[0];
    row.updatedAt = now;
    save();

    // Pelunasan penuh: modal sparepart (Dana Bank) tidak lagi tertahan, jadi
    // sisa Dana Bank nota ini dilunasi otomatis. Idempoten — kalau sisa 0
    // tidak terjadi apa-apa. Dipicu pembayaran penuh, bukan hanya "diambil".
    var afterPaid = order.paid + amount;
    var fullyPaid = order.totalCost > 0 && afterPaid >= order.totalCost;
    if (fullyPaid) settleBankOnTaken(orderId);

    // Catatan: pelunasan penuh TIDAK lagi otomatis menutup nota jadi
    // "Done Diambil". Sesuai permintaan, konfirmasi garansi & metode
    // pembayaran harus dilakukan lebih dulu — jadi pelunasan hanya membuat
    // nota siap dikonfirmasi (lihat confirmTaken).
    var out = computeOrder(row);
    if (fullyPaid) out.bankAutoSettled = true;
    return out;
  }

  /*
     Konfirmasi pelunasan: step terakhir sebelum nota jadi "Done Diambil".

     Urutannya disengaja — pelunasan dulu, baru konfirmasi garansi & metode
     pembayaran, baru baru status ditutup jadi "Done Diambil". Jadi garansi
     dan metode pembayaran tidak pernah dilewati begitu saja.

     Aturan ditegakkan di mesin data:
       - hanya dari status "Done"
       - hanya kalau sisa tagihan sudah 0 (lunas)
       - garansi & metode wajib diisi dan harus dari daftar yang sah
  */
  function confirmTaken(orderId, p) {
    var db = load();
    var order = getOrder(orderId);
    p = p || {};

    if (order.serviceStatus !== 'Done') {
      throw bad('Konfirmasi hanya bisa saat status Done. Status nota sekarang: ' +
        order.serviceStatus + '.');
    }
    if (order.remaining > 0) {
      throw bad('Pembayaran belum lunas. Sisa tagihan: ' + order.remaining + '.');
    }

    var warranty = normOpt(p.warranty, WARRANTY_OPTIONS, 'Garansi');
    if (!warranty) throw bad('Pilih garansi lebih dulu (30 Hari, 60 Hari, atau Non Garansi).');
    var payMethod = normOpt(
      p.payment_method != null ? p.payment_method : p.paymentMethod,
      PAYMENT_METHODS, 'Metode pembayaran');
    if (!payMethod) throw bad('Pilih metode pembayaran lebih dulu (Tunai, Qriss, atau Campuran).');

    var row = db.orders.filter(function (x) { return x.id === orderId; })[0];
    var now = nowIso();
    row.serviceStatus = 'Done Diambil';
    row.completedAt = now;
    row.warranty = warranty;
    row.paymentMethod = payMethod;
    row.updatedAt = now;
    save();

    // Status sudah final: modal sparepart (Dana Bank) dilunasi dan jasa
    // tercatat ke Project Nava. Idempoten.
    settleBankOnTaken(orderId);
    syncJasaToNava(orderId);
    return computeOrder(row);
  }

  function removePayment(paymentId) {
    var db = load();
    var row = db.payments.filter(function (x) { return x.id === paymentId; })[0];
    if (!row) throw notFound('Pembayaran tidak ditemukan');
    var order = getOrder(row.orderId);
    db.payments = db.payments.filter(function (x) { return x.id !== paymentId; });
    // Kembalikan uangnya sebagai Koreksi supaya saldo cashflow tetap benar
    // tanpa menghapus riwayat.
    addCashflowEntry({
      orderId: order.id, entryType: 'Koreksi',
      description: 'Batal pembayaran nota ' + refOf(order),
      moneyIn: 0, moneyOut: row.amount, entryDate: nowIso()
    });
    var o = db.orders.filter(function (x) { return x.id === row.orderId; })[0];
    // Pembayaran dibatalkan -> sisa tagihan berubah -> status jadi tidak pasti.
    markNggandul(o, 'Pembayaran Rp' + row.amount.toLocaleString('id-ID') +
      ' dibatalkan, sisa tagihan berubah — konfirmasi status');
    save();
    return computeOrder(o);
  }

  /* ------------------------------------------------------------
     Cashflow
     ------------------------------------------------------------ */
  function addCashflowEntry(e) {
    var db = load();
    var mi = Number(e.money_in || (e.moneyIn || 0)) || 0;
    var mo = Number(e.money_out || (e.moneyOut || 0)) || 0;
    if (!Number.isInteger(mi) || !Number.isInteger(mo) || mi < 0 || mo < 0) throw bad('Nominal cashflow harus angka bulat >= 0');
    if (mi === 0 && mo === 0) throw bad('Minimal satu sisi nominal harus berisi');
    var date = e.entry_date || e.entryDate || nowIso();
    date = new Date(date).toISOString();
    if (isNaN(Date.parse(date))) throw bad('Tanggal tidak valid');
    var id = e.id || uid('cf');
    db.cashflow.push({
      id: id, orderId: e.service_order_id || e.orderId || null,
      entryType: e.entry_type || e.entryType || 'Pengeluaran Lain',
      description: String(e.description == null ? '' : e.description).slice(0, 200),
      moneyIn: mi, moneyOut: mo, entryDate: date, createdAt: nowIso(), reversedAt: null
    });
    return { id: id, moneyIn: mi, moneyOut: mo, entryDate: date };
  }

  function listCashflow(f) {
    f = f || {};
    var rows = load().cashflow.filter(function (r) { return inRange(r.entryDate, f.from, f.to); });
    rows.sort(function (a, b) {
      return a.entryDate < b.entryDate ? 1 : a.entryDate > b.entryDate ? -1
        : (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);
    });
    // Saldo berjalan dihitung dari paling lama ke paling baru.
    var bal = 0, map = {};
    for (var i = rows.length - 1; i >= 0; i--) {
      bal += rows[i].moneyIn - rows[i].moneyOut;
      map[rows[i].id] = bal;
    }
    return rows.map(function (r) {
      return {
        id: r.id, serviceOrderId: r.orderId, entryType: r.entryType,
        description: r.description, moneyIn: r.moneyIn, moneyOut: r.moneyOut,
        entryDate: r.entryDate, running: map[r.id], reversedAt: r.reversedAt
      };
    });
  }

  function cashflowSummary(f) {
    var list = listCashflow(f);
    var inSum = list.reduce(function (s, r) { return s + r.moneyIn; }, 0);
    var outSum = list.reduce(function (s, r) { return s + r.moneyOut; }, 0);
    var byType = {};
    list.forEach(function (r) {
      byType[r.entryType] = byType[r.entryType] || { in: 0, out: 0 };
      byType[r.entryType].in += r.moneyIn;
      byType[r.entryType].out += r.moneyOut;
    });
    function bt(t, side) { return (byType[t] && byType[t][side]) || 0; }
    return {
      moneyIn: inSum, moneyOut: outSum, balance: inSum - outSum,
      partModal: bt('Modal Sparepart', 'out') - bt('Koreksi', 'in'),
      otherExpense: bt('Pengeluaran Lain', 'out'),
      netServiceFee: bt('Pembayaran Servis', 'in') + bt('DP', 'in') + bt('Koreksi', 'out')
        - bt('Modal Sparepart', 'out') - bt('Pengeluaran Lain', 'out'),
      byType: byType, count: list.length
    };
  }

  function reverseCashflow(id) {
    var db = load();
    var r = db.cashflow.filter(function (x) { return x.id === id; })[0];
    if (!r) throw notFound('Entri tidak ditemukan');
    if (r.reversedAt) throw bad('Entri ini sudah pernah dibatalkan');
    r.reversedAt = nowIso();
    // Baris tersimpan memakai moneyIn/moneyOut (camelCase), jadi harus
    // dibaca sesuai nama field-nya — kalau tidak, nominal jadi undefined
    // dan pembatalan gagal.
    addCashflowEntry({
      orderId: r.orderId, entryType: 'Koreksi',
      description: 'Pembatalan: ' + r.description,
      money_in: r.moneyOut, money_out: r.moneyIn, entryDate: nowIso()
    });
    save();
    return { ok: true, reversedId: id };
  }

  /* ------------------------------------------------------------
     Dana Bank
     ------------------------------------------------------------ */
  function addBankEntry(e) {
    var db = load();
    var mi = Number(e.money_in || (e.moneyIn || 0)) || 0;
    var mo = Number(e.money_out || (e.moneyOut || 0)) || 0;
    if (!Number.isInteger(mi) || !Number.isInteger(mo) || mi < 0 || mo < 0) throw bad('Nominal Dana Bank harus angka bulat >= 0');
    if (mi === 0 && mo === 0) throw bad('Minimal satu sisi nominal harus berisi');
    var desc = String(e.description == null ? '' : e.description).trim();
    var orderId = e.service_order_id || e.orderId || null;
    if (mo > 0 && !orderId && desc.length < 3) throw bad('Pakai Dana Bank wajib dicantumkan nomor nota atau keterangan');
    var date = e.entry_date || e.entryDate || nowIso();
    date = new Date(date).toISOString();
    if (isNaN(Date.parse(date))) throw bad('Tanggal tidak valid');
    var id = e.id || uid('bf');
    db.bank.push({
      id: id, orderId: orderId, description: desc.slice(0, 200),
      moneyIn: mi, moneyOut: mo, entryDate: date, createdAt: nowIso(), reversedAt: null
    });
    return { id: id, moneyIn: mi, moneyOut: mo, entryDate: date };
  }

  function sumBankReturned(orderId) {
    return load().bank.filter(function (b) { return b.orderId === orderId && !b.reversedAt; })
      .reduce(function (s, b) { return s + (b.moneyIn || 0); }, 0);
  }

  function bankSummary() {
    var st = load().settings;
    var rows = load().bank.filter(function (b) { return !b.reversedAt; });
    var used = rows.reduce(function (s, b) { return s + (b.moneyOut || 0); }, 0);
    var returned = rows.reduce(function (s, b) { return s + (b.moneyIn || 0); }, 0);
    return {
      initial: st.bankFundInitial || 0, used: used, returned: returned,
      available: (st.bankFundInitial || 0) + returned - used
    };
  }

  function listBankEntries(f) {
    f = f || {};
    var db = load();
    var rows = db.bank.filter(function (r) { return !r.reversedAt && inRange(r.entryDate, f.from, f.to); });
    rows.sort(function (a, b) {
      return a.entryDate < b.entryDate ? 1 : a.entryDate > b.entryDate ? -1
        : (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);
    });
    var perNote = {};
    rows.forEach(function (r) {
      if (!r.orderId) return;
      perNote[r.orderId] = perNote[r.orderId] || { out: 0, in: 0 };
      if (r.moneyOut) perNote[r.orderId].out += r.moneyOut;
      if (r.moneyIn) perNote[r.orderId].in += r.moneyIn;
    });
    return rows.map(function (r) {
      if (r.orderId) {
        var so = db.orders.filter(function (o) { return o.id === r.orderId; })[0];
        var used = db.parts.filter(function (p) { return p.orderId === r.orderId && p.fundingSource === 'Dana Bank'; })
          .reduce(function (s, p) { return s + (p.capitalCost || 0); }, 0);
        var back = perNote[r.orderId].in;
        var remain = Math.max(0, used - back);
        var status = used === 0 ? 'Dibatalkan' : back <= 0 ? 'Aktif' : (remain === 0 ? 'Lunas' : 'Sebagian Kembali');
        return {
          id: r.id, date: r.entryDate,
          noteNumber: so ? refOf(so) : null,
          description: r.description, moneyOut: r.moneyOut, moneyIn: r.moneyIn,
          remain: remain, status: status
        };
      }
      return {
        id: r.id, date: r.entryDate, noteNumber: null, description: r.description,
        moneyOut: r.moneyOut, moneyIn: r.moneyIn, remain: null, status: null
      };
    });
  }

  function reverseBankEntry(id) {
    var db = load();
    var r = db.bank.filter(function (x) { return x.id === id; })[0];
    if (!r) throw notFound('Entri tidak ditemukan');
    if (r.reversedAt) throw bad('Entri ini sudah pernah dibatalkan');
    r.reversedAt = nowIso();
    addBankEntry({
      orderId: r.orderId, description: 'Pembatalan: ' + r.description,
      money_in: r.moneyOut, money_out: r.moneyIn, entryDate: nowIso()
    });
    save();
    return { ok: true, reversedId: id };
  }

  function returnBankFund(orderId, amount) {
    var order = getOrder(orderId);
    var used = order.bankUsed;
    if (used <= 0) throw bad('Nota ini tidak memakai Dana Bank');
    var already = sumBankReturned(orderId);
    var remain = used - already;
    if (remain <= 0) throw bad('Dana Bank untuk nota ini sudah lunas dikembalikan');
    var amt = (amount == null || amount === '') ? remain : Number(amount);
    if (!Number.isInteger(amt) || amt <= 0) throw bad('Nominal pengembalian harus angka bulat > 0');
    if (amt > remain) throw bad('Pengembalian melebihi sisa Dana Bank pada nota ini (sisa ' + remain + ')');
    var now = nowIso();
    addBankEntry({
      orderId: orderId, description: 'Kembalikan Dana Bank — nota ' + refOf(order),
      moneyIn: amt, moneyOut: 0, entryDate: now
    });
    var o = load().orders.filter(function (x) { return x.id === orderId; })[0];
    o.updatedAt = now;
    save();
    return { ok: true, returned: amt, remain: remain - amt };
  }

  /*
     Melunasi sisa Dana Bank sebuah nota.

     Dipanggil otomatis saat nota berubah menjadi "Done Diambil": semua Dana
     Bank yang dipakai untuk sparepart nota tersebut dikembalikan penuh, karena
     barang sudah diambil dan tidak ada lagi modal yang tertahan.

     Aman dipanggil berkali-kali: kalau sisa sudah 0, tidak terjadi apa-apa.
     Tidak melempar error supaya tidak pernah menggagalkan penggantian status.
  */
  function settleBankOnTaken(orderId) {
    var db = load();
    var order = db.orders.filter(function (o) { return o.id === orderId; })[0];
    if (!order || order.deletedAt) return 0;
    var used = db.parts.filter(function (p) { return p.orderId === orderId && p.fundingSource === FUNDING_PART; })
      .reduce(function (s, p) { return s + (p.capitalCost || 0); }, 0);
    if (used <= 0) return 0;
    var remain = used - sumBankReturned(orderId);
    if (remain <= 0) return 0;
    var now = nowIso();
    addBankEntry({
      orderId: orderId,
      description: 'Lunasi Dana Bank otomatis — nota ' + refOf(order),
      moneyIn: remain, moneyOut: 0, entryDate: now
    });
    order.updatedAt = now;
    save();
    return remain;
  }

  /* ------------------------------------------------------------
     Daftar + dashboard
     ------------------------------------------------------------ */
  function listOrders(f) {
    f = f || {};
    var db = load();
    var rows = db.orders.filter(function (o) { return !o.deletedAt; });
    if (f.from || f.to) {
      rows = rows.filter(function (o) { return inRange(o.receivedAt, f.from, f.to); });
    }
    if (f.status) rows = rows.filter(function (o) { return o.serviceStatus === f.status; });
    if (f.payment_status) {
      rows = rows.filter(function (o) { return computeOrder(o).paymentStatus === f.payment_status; });
    }
    if (f.q) {
      var q = String(f.q).trim().toLowerCase();
      var num = String(f.q).replace(/^0+/, '') || '0';
      rows = rows.filter(function (o) {
        return o.customerName.toLowerCase().indexOf(q) >= 0
          || o.device.toLowerCase().indexOf(q) >= 0
          || String(o.whatsapp).indexOf(q) >= 0
          || String(o.noteNumberRaw) === num
          || String(o.internalRef || '').toLowerCase().indexOf(q) >= 0;
      });
    }
    sortOrdersDesc(rows);
    return rows.map(function (o) { return computeOrder(o); });
  }

  function dashboard() {
    var db = load();
    var today = new Date().toISOString().slice(0, 10);
    var monthStart = today.slice(0, 8) + '01';

    var orders = db.orders.filter(function (o) { return !o.deletedAt; });
    var masukHariIni = orders.filter(function (o) { return o.receivedAt.slice(0, 10) === today; }).length;
    var proses = orders.filter(function (o) { return o.serviceStatus === ACTIVE_STATUS; }).length;
    var selesai = orders.filter(function (o) { return isDoneStatus(o.serviceStatus); }).length;
    var cancel = orders.filter(function (o) { return isCancelStatus(o.serviceStatus); }).length;
    var nggandul = orders.filter(function (o) { return o.serviceStatus === NGGANDUL; }).length;

    var cf = cashflowSummary({ from: monthStart });
    var bank = bankSummary();

    // "5 Servis Terbaru" hanya untuk garapan yang masih di meja. Nota yang
    // sudah DIAMBIL (Done Diambil & Cancel Diambil) dianggap selesai
    // dan tidak muncul lagi di beranda — masih bisa dicari lewat menu Servis.
    var recent = orders.filter(function (o) {
      return o.serviceStatus !== 'Done Diambil' && o.serviceStatus !== 'Cancel Diambil';
    });
    sortOrdersDesc(recent);
    if (recent.length > 5) recent.length = 5;

    // "Nggantung" = akumulasi nota yang statusnya masih menggantung di meja:
    // Progress (belum selesai) + Done (sudah jadi belum diambil) +
    // Cancel (dibatalkan belum diambil). Yang benar-benar sudah keluar
    // (Done Diambil & Cancel Diambil) tidak dihitung.
    var nggantungNilai = orders.filter(function (o) {
      return o.serviceStatus === ACTIVE_STATUS
        || o.serviceStatus === 'Done'
        || o.serviceStatus === 'Cancel';
    }).length;

    return {
      masukHariIni: masukHariIni, proses: proses, selesai: selesai,
      cancel: cancel, nggandul: nggandul,
      doneDiambil: orders.filter(function (o) { return o.serviceStatus === 'Done Diambil'; }).length,
      cancelDiambil: orders.filter(function (o) { return o.serviceStatus === 'Cancel Diambil'; }).length,
      nggantung: nggantungNilai,
      uangMasukBulanIni: cf.moneyIn, pengeluaranBulanIni: cf.moneyOut,
      saldoCashflow: cf.balance, saldoBank: bank.available, bank: bank,
      recent: recent.map(function (o) { return computeOrder(o); })
    };
  }

  function getSettings() {
    var st = load().settings;
    return { bankFundInitial: st.bankFundInitial || 0, noteCounter: st.noteCounter || 0, updatedAt: st.updatedAt || null };
  }

  function updateSettings(patch) {
    var st = load().settings;
    var initial = patch.bankFundInitial != null ? Number(patch.bankFundInitial) : st.bankFundInitial;
    if (!Number.isInteger(initial) || initial < 0) throw bad('Saldo awal Dana Bank tidak valid');
    st.bankFundInitial = initial;
    st.updatedAt = nowIso();
    save();
    return getSettings();
  }

  function inRange(dateIso, from, to) {
    if (from && dateIso < from) return false;
    if (to && dateIso > to + 'T23:59:59.999Z') return false;
    return true;
  }

  /* ------------------------------------------------------------
     API publik — bentuknya sama dengan server agar mascim.js tidak
     perlu tahu dari mana datanya.
     ------------------------------------------------------------ */
  function handler(method, path, body) {
    body = body || {};
    var seg = path.split('?')[0].split('/').filter(Boolean); // ['api','mascim',...]
    if (seg[0] !== 'api' || seg[1] !== 'mascim') throw notFound('Endpoint tidak dikenal');
    var r = seg.slice(2);
    var len = r.length;
    var id = r[1] != null ? decodeURIComponent(r[1]) : null;
    var sub = r[2] != null ? r[2] : null;
    var out = function (o) { return Object.assign({ ok: true }, o); };

    // PENTING: setiap rute harus memeriksa JUMLAH segmen (len). Tanpa itu
    // rute umum menelan rute yang lebih panjang, misalnya POST /services
    // akan capturing POST /services/{id}/status, dan POST /cashflow akan
    // capturing POST /cashflow/{id}/reverse.
    if (len === 1 && r[0] === 'dashboard' && method === 'GET') {
      // Seed contoh sekali saja supaya layar pertama tidak kosong dan
      // semua tombol kelihatan bisa diklik. Data pelanggan fiktif.
      seed();
      return out({ dashboard: dashboard() });
    }
    if (len === 1 && r[0] === 'settings') {
      if (method === 'GET') return out({ settings: getSettings() });
      if (method === 'PATCH' || method === 'POST') return out({ settings: updateSettings(body) });
    }
    if (len === 3 && r[0] === 'services' && sub === 'status' && method === 'POST') {
      return out({ service: setServiceStatus(id, body.service_status) });
    }
    if (len === 3 && r[0] === 'services' && sub === 'parts' && method === 'POST') {
      return out({ service: addPart(id, body) });
    }
    if (len === 3 && r[0] === 'services' && sub === 'payments' && method === 'POST') {
      return out({ service: addPayment(id, body) });
    }
    if (len === 3 && r[0] === 'services' && sub === 'confirm-taken' && method === 'POST') {
      return out({ service: confirmTaken(id, body) });
    }
    if (len === 3 && r[0] === 'services' && sub === 'return-bank' && method === 'POST') {
      return out({ result: returnBankFund(id, body.amount) });
    }
    if (len === 3 && r[0] === 'services' && sub === 'can-delete' && method === 'GET') {
      return out({ check: canDelete(id) });
    }
    if (len === 1 && r[0] === 'services') {
      if (method === 'GET') return out({ services: listOrders(parseQuery(path)) });
      if (method === 'POST') {
        var created = createOrder(body);
        // Nomor nota berikutnya tidak lagi dialingokasikan di sini:
        // nomor hanya terbit saat nota garansi diterbitkan.
        return out({ service: created });
      }
    }
    if (len === 2 && r[0] === 'services') {
      if (method === 'GET') return out({ service: getOrder(id) });
      if (method === 'PATCH' || method === 'PUT') return out({ service: updateOrder(id, body) });
      if (method === 'DELETE') return out({ deleted: deleteOrder(id) });
    }
    if (len === 3 && r[0] === 'services' && sub === 'issue-note' && method === 'POST') {
      var iss = issueWarrantyNote(id);
      return out({ note: iss.note, reused: !!iss.reused });
    }
    if (len === 3 && r[0] === 'services' && sub === 'revoke-note' && method === 'POST') {
      var rev = revokeWarrantyNote(id);
      return out({ note: rev.note, alreadyRevoked: !!rev.alreadyRevoked });
    }
    if (len === 3 && r[0] === 'services' && sub === 'unrevoke-note' && method === 'POST') {
      var un = unrevokeWarrantyNote(id);
      return out({ note: un.note, wasActive: !!un.wasActive });
    }
    // Nota publik dibaca lewat TOKEN link, bukan lewat id nota. Ini yang
    // membuat link tidak bisa ditebak dari data internal.
    if (len === 2 && r[0] === 'notes' && method === 'GET') {
      return out({ note: getPublicNoteByToken(id) });
    }
    if (len === 2 && r[0] === 'parts' && method === 'DELETE') {
      return out({ service: removePart(id) });
    }
    if (len === 2 && r[0] === 'payments' && method === 'DELETE') {
      return out({ service: removePayment(id) });
    }
    if (len === 1 && r[0] === 'cashflow') {
      if (method === 'GET') {
        var cf = parseQuery(path);
        return out({ entries: listCashflow(cf), summary: cashflowSummary(cf) });
      }
      if (method === 'POST') return out({ entry: addCashflowEntry(body) });
    }
    if (len === 3 && r[0] === 'cashflow' && sub === 'reverse' && method === 'POST') {
      return out({ reversed: reverseCashflow(id) });
    }
    if (len === 1 && r[0] === 'bank-fund') {
      if (method === 'GET') {
        return out({ entries: listBankEntries(parseQuery(path)), summary: bankSummary() });
      }
      if (method === 'POST') return out({ entry: addBankEntry(body) });
    }
    if (len === 3 && r[0] === 'bank-fund' && sub === 'reverse' && method === 'POST') {
      return out({ reversed: reverseBankEntry(id) });
    }
    if (len === 3 && r[0] === 'bank-fund' && sub === 'return' && method === 'POST') {
      return out({ result: returnBankFund(id, body.amount) });
    }

    throw notFound('Endpoint tidak dikenal');
  }

  function parseQuery(path) {
    var out = {};
    var i = path.indexOf('?');
    if (i < 0) return out;
    path.slice(i + 1).split('&').forEach(function (kv) {
      if (!kv) return;
      var a = kv.split('=');
      out[decodeURIComponent(a[0])] = decodeURIComponent(a[1] == null ? '' : a[1]);
    });
    return out;
  }

  w.MascimLocal = {
    SERVICE_STATUSES: SERVICE_STATUSES,
    LOCK_TYPES: LOCK_TYPES,
    WARRANTY_OPTIONS: WARRANTY_OPTIONS,
    PAYMENT_METHODS: PAYMENT_METHODS,
    STATUS_TRANS: STATUS_TRANS,
    nextStatuses: nextStatuses,
    FUNDING_PART: FUNDING_PART,
    matchPattern: matchPattern,
    isPatternSecret: isPatternSecret,
    parsePattern: parsePattern,
    PATTERN_MIN_POINTS: PATTERN_MIN_POINTS,
    INITIAL_STATUS: INITIAL_STATUS,
    NGGANDUL: NGGANDUL,
    isDoneStatus: isDoneStatus,
    getOrder: getOrder,
    confirmTaken: confirmTaken,
    isCancelStatus: isCancelStatus,
    isClosedStatus: isClosedStatus,
    isPayLocked: isPayLocked,
    syncJasaToNava: syncJasaToNava,
    // Nota garansi pelanggan
    WARRANTY_NOTE_DAYS: WARRANTY_NOTE_DAYS,
    issueWarrantyNote: issueWarrantyNote,
    revokeWarrantyNote: revokeWarrantyNote,
    unrevokeWarrantyNote: unrevokeWarrantyNote,
    getPublicNoteByToken: getPublicNoteByToken,
    encodePublicNote: encodePublicNote,
    decodePublicNote: decodePublicNote,
    publicNote: publicNote,
    noteIssueBlockReason: noteIssueBlockReason,
    refOf: refOf,
    handle: function (method, path, body) {
      return new Promise(function (resolve, reject) {
        // Jalankan sinkron lalu bungkus, supaya pemanggil tetap memakai
        // Promise seperti versi server.
        try { resolve(handler(method, path, body)); }
        catch (e) { reject(e); }
      });
    },
    isEmpty: function () {
      var db = load();
      return db.orders.length === 0 && db.cashflow.length === 0 && db.bank.length === 0;
    },
    seed: seed,
    reset: function () { cache = null; try { w.localStorage.removeItem(KEY); } catch (e) {} cache = blank(); },
    _db: load
  };

  /* ------------------------------------------------------------
     Data contoh (dipakai sekali saat modul pertama dibuka supaya
     Beranda tidak kosong dan semua tombol kelihatan bisa diklik).
     ------------------------------------------------------------ */
  function seed() {
    var db = load();
    if (db.orders.length) return;
    var o1 = createOrder({
      customer_name: 'Budi Santoso', whatsapp: '081234567890', device: 'Samsung A15',
      complaint: 'Layar pecak, touch tidak merespons', handling: 'Ganti LCD',
      intake_condition: 'Body penyok di sudut kiri bawah, tombol volume rusak dan tidak berfungsi, speaker normal, kamera depan berdebu.',
      total_cost: 450000, received_at: nowIso()
    });
    addPart(o1.id, { part_name: 'LCD Samsung A15', capital_cost: 250000, funding_source: 'Dana Bank' });
    // Pembayaran hanya sah saat status Done, jadi garapan contoh ini
    // dipastikan "Done" dulu sebelum dicatat pembayarannya.
    setServiceStatus(o1.id, 'Done');
    addPayment(o1.id, { amount: 450000, payment_type: 'Pelunasan' });

    createOrder({
      customer_name: 'Siti Aminah', whatsapp: '081298765432', device: 'iPhone 13',
      complaint: 'Baterai cepat habis, tidak tahan lama', handling: 'Ganti baterai',
      total_cost: 850000, received_at: nowIso()
    });

    createOrder({
      customer_name: 'Andi Wijaya', whatsapp: '085611223344', device: 'Xiaomi Redmi 12',
      complaint: 'Tidak bisa dicharger', handling: 'Ganti port charge',
      total_cost: 90000, received_at: nowIso()
    });
    updateSettings({ bankFundInitial: 3000000 });
  }
})(window);
