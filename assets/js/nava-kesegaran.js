/* =====================================================================
   nava-kesegaran.js - Menghitung seberapa SEGAR data pasar BEI

   MASALAH YANG DISELESAIKAN:
     Angka utama Nava Trader berasal dari data/market.json (EOD). Bila
     berkas itu basi (mis. belum di-refresh beberapa sesi), aplikasi
     diam-diam menampilkan harga lama seolah-olah terkini. Modul ini
     mengubah "basi senyap" menjadi "basi yang terlihat".

   CARA KERJA:
     Diberi tanggal data terakhir (YYYY-MM-DD) dan waktu sekarang,
     dihitung:
       - hariBursa ecological berapa sesi bursa yang sudah terlewat,
       - status: 'segar' | 'kemarin' | 'terlambat' | 'tidak diketahui',
       - teks penjelasan yang jujur untuk ditampilkan ke pengguna.

     Modul ini TIDAK memakai API khusus browser atau Node, jadi bisa
     dipakai di Mini App (browser) maupun di trader/fetch.js (Node).

   CATATAN LIBUR:
     Hitungan "sesi yang terlewat" memakai kalender hari kerja
     (Senin-Jumat). Hari libur nasional BEI tidak dihitung satu per
     satu; konsekuensinya status bisa terlihat satu sesi lebih lama
     pada minggu libur panjang. Ini disengaja: lebih baik terlihat
     "kemungkinan terlambat" daripada diam-diam salah. Labelnya
     tetap jujur karena tanggal data selalu ditampilkan apa adanya.
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NavaKesegaran = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ZONA_WIB = 7 * 3600 * 1000;

  // Ubah 'YYYY-MM-DD' (sebagai tanggal kalender) ke epoch UTC tengah
  // malam WIB, supaya perbandingan hari tidak terdorong zona waktu.
  function tglKeEpoch(tgl) {
    var p = String(tgl || '').split('-');
    if (p.length !== 3) return null;
    var y = +p[0], m = +p[1], d = +p[2];
    if (!y || !m || !d) return null;
    return Date.UTC(y, m - 1, d) - ZONA_WIB;
  }

  // Epoch -> 'YYYY-MM-DD' versi WIB.
  function epochKeTgl(ms) {
    var d = new Date(ms + ZONA_WIB);
    return d.getUTCFullYear() + '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(d.getUTCDate()).padStart(2, '0');
  }

  // 0=Minggu .. 6=Sabtu, di zona WIB.
  function hariDalamMinggu(ms) {
    return new Date(ms + ZONA_WIB).getUTCDay();
  }

  // Sesi bursa yang jatuh di antara dua tanggal (acak), dihitung dalam
  // "hari kerja" (Senin-Jumat). Hari yang sama = 0.
  // Kita menghitung dari tanggal data sampai HARI INI (exclusive).
  function sesiTerlewat(tglData, msSekarang) {
    var mulai = tglKeEpoch(tglData);
    if (mulai == null) return null;
    var akhir = epochKeTgl(msSekarang);          // hari ini (WIB)
    var akhirE = tglKeEpoch(akhir);
    if (akhirE == null) return null;
    if (akhirE <= mulai) return 0;

    var n = 0;
    var cur = mulai;
    // Lewati satu per satu dari tanggal data+1 s.d. hari ini (exclusive).
    while (cur < akhirE) {
      cur += 86400000;
      var h = hariDalamMinggu(cur);
      if (h !== 0 && h !== 6) n++;              // hitung hanya hari kerja
    }
    return n;
  }

  /**
   * Nilai kesegaran untuk data EOD.
   * @param {string} tglData - tanggal bar terakhir ('YYYY-MM-DD'), boleh null.
   * @param {number} [msSekarang] - epoch ms (default Date.now()).
   * @returns {{status, tglData, sesiTerlewat, label, detail, warna}}
   */
  function nilai(tglData, msSekarang) {
    var now = typeof msSekarang === 'number' ? msSekarang : Date.now();
    var hariIni = epochKeTgl(now);

    if (!tglData) {
      return {
        status: 'tidak diketahui',
        tglData: null,
        sesiTerlewat: null,
        label: 'Tanggal data tidak diketahui',
        detail: 'Data pasar tidak mencantumkan tanggal terakhir, jadi kesegarannya tidak bisa dipastikan.',
        warna: 'warn'
      };
    }

    if (tglData === hariIni) {
      return {
        status: 'segar',
        tglData: tglData,
        sesiTerlewat: 0,
        label: 'Data per ' + tglData,
        detail: 'Bar terakhir bertanggal hari ini.',
        warna: 'ok'
      };
    }

    var sesi = sesiTerlewat(tglData, now);
    if (sesi == null) {
      return {
        status: 'tidak diketahui',
        tglData: tglData,
        sesiTerlewat: null,
        label: 'Tanggal data ' + tglData,
        detail: 'Format tanggal data tidak dikenali.',
        warna: 'warn'
      };
    }

    if (sesi === 1) {
      return {
        status: 'kemarin',
        tglData: tglData,
        sesiTerlewat: 1,
        label: 'Data per ' + tglData,
        detail: 'Bar terakhir dari 1 sesi bursa lalu. Wajar bila data diambil setelah bursa tutup.',
        warna: 'warn'
      };
    }

    return {
      status: 'terlambat',
      tglData: tglData,
      sesiTerlewat: sesi,
      label: 'Data per ' + tglData + ' (' + sesi + ' sesi lalu)',
      detail: 'Bar terakhir sudah ' + sesi + ' sesi bursa lalu. Data ini kemungkinan tertinggal ' +
              'dan sebaiknya di-refresh. Jangan dipakai untuk keputusan tanpa verifikasi ke IDX.',
      warna: 'bahaya'
    };
  }

  return {
    nilai: nilai,
    sesiTerlewat: sesiTerlewat,
    tglKeEpoch: tglKeEpoch,
    epochKeTgl: epochKeTgl,
    hariDalamMinggu: hariDalamMinggu
  };
});