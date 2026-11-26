/* =========================================================
   workflow.js — Modul Workflow: Absensi & Payroll Gaji + Catatan
   Berdasarkan Skema Kompensasi & Format Absensi Bulanan Teknisi
   ========================================================= */
(function (w) {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return [].slice.call(document.querySelectorAll(s)); };
  var TG = w.TG;

  var STORAGE_PREFIX = 'calm_workflow_payroll_';
  var STANDARD_START = '09:00'; // Jam masuk standar 09.00
  var APP_URL = 'https://app8842237612.tgcloud.ai/?view=workflow';

  // State aktif payroll
  var curMonth = ''; // YYYY-MM
  var selectedDate = ''; // YYYY-MM-DD
  var payrollData = {
    bonusMapsCount: 0,
    bonusUnitRp: 0,
    bonusBon: 0,
    bonusAngsuran: 0,
    disciplineTier: 'auto', // auto | full_clean | min_clean | full_late | min_late | none
    days: {} // 'YYYY-MM-DD': { status: 'masuk'|'terlambat'|'libur'|'none', time: '09:00', lateMin: 0 }
  };

  function rupiah(n) {
    n = Math.round(Number(n) || 0);
    return 'Rp ' + n.toLocaleString('id-ID');
  }

  function getDaysInMonth(year, month) {
    return new Date(year, month, 0).getDate();
  }

  function parseTimeMinutes(tStr) {
    if (!tStr || !/^\d{1,2}:\d{2}$/.test(tStr)) return 9 * 60;
    var p = tStr.split(':');
    return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
  }

  function todayStr() {
    var now = new Date();
    return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  }

  function loadMonthData(ym) {
    curMonth = ym;
    var tStr = todayStr();
    if (tStr.slice(0, 7) === ym) {
      selectedDate = tStr;
    } else {
      selectedDate = ym + '-01';
    }

    var raw = localStorage.getItem(STORAGE_PREFIX + ym);
    if (raw) {
      try {
        var parsed = JSON.parse(raw);
        payrollData = Object.assign({
          bonusMapsCount: 0,
          bonusUnitCount: 0,
          bonusUnitRp: 0,
          bonusBon: 0,
          bonusAngsuran: 0,
          disciplineTier: 'auto',
          days: {}
        }, parsed);
      } catch (e) {
        console.warn('Gagal membaca payrollData:', e);
      }
    } else {
      payrollData = {
        bonusMapsCount: 0,
        bonusUnitCount: 0,
        bonusUnitRp: 0,
        bonusBon: 0,
        bonusAngsuran: 0,
        disciplineTier: 'auto',
        days: {}
      };
      saveMonthData();
    }
  }

  function saveMonthData() {
    if (!curMonth) return;
    try {
      localStorage.setItem(STORAGE_PREFIX + curMonth, JSON.stringify(payrollData));
    } catch (e) {
      console.warn('Gagal menyimpan payrollData:', e);
    }
  }

  /* ---------------- Kalkulasi Payroll & Absensi ---------------- */
  function calculateSummary() {
    var parts = curMonth.split('-');
    var yr = parseInt(parts[0], 10);
    var mo = parseInt(parts[1], 10);
    var totalDays = getDaysInMonth(yr, mo);

    var stdMin = parseTimeMinutes(STANDARD_START); // 540 (09:00)

    var countHadir = 0;
    var countTerlambat = 0;
    var countLibur = 0;
    var totalMenitLambat = 0;

    for (var d = 1; d <= totalDays; d++) {
      var dateKey = curMonth + '-' + String(d).padStart(2, '0');
      var item = payrollData.days[dateKey];
      if (!item || !item.status || item.status === 'none') {
        continue; // Hari belum diabsen, tidak dihitung
      }

      if (item.status === 'libur') {
        countLibur++;
        item.lateMin = 0;
      } else {
        countHadir++;
        var tMin = parseTimeMinutes(item.time || '09:00');
        if (tMin > stdMin) {
          item.status = 'terlambat';
          item.lateMin = tMin - stdMin;
          countTerlambat++;
          totalMenitLambat += item.lateMin;
        } else {
          item.status = 'masuk';
          item.lateMin = 0;
        }
      }
    }

    var totalJamLambat = totalMenitLambat / 60;

    // 1. Gaji Pokok Harian: Rp 135.000 / hari hadir
    var gajiHarian = countHadir * 135000;

    // 2. Bonus Maps: Rp 1.000 / maps
    var bonusMaps = Math.max(0, parseInt(payrollData.bonusMapsCount, 10) || 0) * 1000;

    // 3. Bonus Unit / Done Diambil (Jika >= 350 unit -> x Rp 2.000 / unit)
    var bonusUnitCount = Math.max(0, parseInt(payrollData.bonusUnitCount, 10) || 0);
    var bonusUnitManualRp = Math.max(0, parseInt(payrollData.bonusUnitRp, 10) || 0);
    var isUnitTierReached = bonusUnitCount >= 350;
    var bonusUnit = isUnitTierReached ? (bonusUnitCount * 2000) : bonusUnitManualRp;

    // 4. Tunjangan Kedisiplinan (Syarat: Minimal 27 hari kerja)
    var tunjanganSyarat = countHadir >= 27;
    var rateDisiplinPerHari = 0;
    var tierDesc = 'Tidak memenuhi syarat (harus >= 27 hari kerja)';

    if (tunjanganSyarat) {
      var tier = payrollData.disciplineTier || 'auto';
      if (tier === 'auto') {
        if (countTerlambat === 0) {
          rateDisiplinPerHari = 15000;
          tierDesc = 'Full tanpa terlambat (Rp 15.000/hari)';
        } else {
          rateDisiplinPerHari = 10000;
          tierDesc = 'Full dengan keterlambatan (Rp 10.000/hari)';
        }
      } else if (tier === 'full_clean') {
        rateDisiplinPerHari = 15000;
        tierDesc = 'Full tanpa terlambat (Rp 15.000/hari)';
      } else if (tier === 'min_clean') {
        rateDisiplinPerHari = 10000;
        tierDesc = 'Minimal tanpa terlambat (Rp 10.000/hari)';
      } else if (tier === 'full_late') {
        rateDisiplinPerHari = 10000;
        tierDesc = 'Full dengan keterlambatan (Rp 10.000/hari)';
      } else if (tier === 'min_late') {
        rateDisiplinPerHari = 5000;
        tierDesc = 'Minimal dengan keterlambatan (Rp 5.000/hari)';
      } else {
        rateDisiplinPerHari = 0;
        tierDesc = 'Tidak mengambil tunjangan';
      }
    }

    var tunjanganDisiplin = rateDisiplinPerHari * countHadir;

    // 5. Pengurangan:
    // Denda Keterlambatan: Rp 15.000 / hari terlambat
    var dendaTerlambat = countTerlambat * 15000;

    // Potongan Jam Kehadiran: Rp 14.000 / jam keterlambatan
    var potonganJam = Math.round(totalJamLambat * 14000);

    // 6. Potongan Manual: Bon & Angsuran
    var potonganBon = Math.max(0, parseInt(payrollData.bonusBon, 10) || 0);
    var potonganAngsuran = Math.max(0, parseInt(payrollData.bonusAngsuran, 10) || 0);

    // Total Gaji Bersih
    var totalGajiBersih = (gajiHarian + bonusMaps + bonusUnit + tunjanganDisiplin) - (dendaTerlambat + potonganJam + potonganBon + potonganAngsuran);

    return {
      totalDays: totalDays,
      countHadir: countHadir,
      countTerlambat: countTerlambat,
      countLibur: countLibur,
      totalMenitLambat: totalMenitLambat,
      totalJamLambat: totalJamLambat,
      gajiHarian: gajiHarian,
      bonusMaps: bonusMaps,
      bonusUnit: bonusUnit,
      bonusUnitCount: bonusUnitCount,
      isUnitTierReached: isUnitTierReached,
      tunjanganSyarat: tunjanganSyarat,
      rateDisiplinPerHari: rateDisiplinPerHari,
      tunjanganDisiplin: tunjanganDisiplin,
      tierDesc: tierDesc,
      dendaTerlambat: dendaTerlambat,
      potonganJam: potonganJam,
      potonganBon: potonganBon,
      potonganAngsuran: potonganAngsuran,
      totalGajiBersih: totalGajiBersih
    };
  }

  /* ---------------- Render UI ---------------- */
  function renderAll() {
    var sum = calculateSummary();
    renderHeaderInfo();
    renderStats(sum);
    renderAttendanceTable(sum);
    renderPayrollSlip(sum);
  }

  function renderHeaderInfo() {
    var elDateTxt = $('#wfActiveDateTxt');
    if (elDateTxt) {
      if (selectedDate) {
        var p = selectedDate.split('-');
        var d = parseInt(p[2], 10);
        var moNames = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
        var mStr = moNames[parseInt(p[1], 10) - 1] || '';
        elDateTxt.textContent = d + ' ' + mStr;
      } else {
        elDateTxt.textContent = 'Hari ini';
      }
    }
  }

  function renderStats(s) {
    var jam = Math.floor(s.totalJamLambat);
    var mnt = s.totalMenitLambat % 60;
    var durText = (jam > 0 ? jam + 'j ' : '') + mnt + 'm';

    var elHadir = $('#wfStatHadir');
    var elLambat = $('#wfStatTerlambat');
    var elJam = $('#wfStatJamLambat');
    var elLibur = $('#wfStatLibur');

    if (elHadir) elHadir.textContent = s.countHadir + ' Hari';
    if (elLambat) elLambat.textContent = s.countTerlambat + ' Hari';
    if (elJam) elJam.textContent = durText;
    if (elLibur) elLibur.textContent = s.countLibur + ' Hari';
  }

  function renderAttendanceTable(s) {
    var tbody = $('#wfAttTableBody');
    if (!tbody) return;

    var parts = curMonth.split('-');
    var yr = parseInt(parts[0], 10);
    var mo = parseInt(parts[1], 10);
    var dayNames = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];

    var todayKey = todayStr();

    var html = '';
    for (var d = 1; d <= s.totalDays; d++) {
      var dateKey = curMonth + '-' + String(d).padStart(2, '0');
      // Hari yang belum terjadi tidak ditampilkan
      if (dateKey > todayKey) continue;

      var dt = new Date(yr, mo - 1, d);
      var dayName = dayNames[dt.getDay()];
      var isSunday = dt.getDay() === 0;
      var isFriday = dt.getDay() === 5;

      var item = payrollData.days[dateKey];
      var st = item ? item.status : 'none';
      var tm = (item && item.time) ? item.time : '09:00';
      var lateM = (item && item.lateMin) ? item.lateMin : 0;
      var isSelected = (selectedDate === dateKey);

      var rowCls = 'wf-att-row ' + (st !== 'none' ? 'wf-row-' + st : '') + (isSelected ? ' wf-row-selected' : '');

      var timeCell = '';
      if (st === 'libur') {
        timeCell = '<span class="wf-time-dash">-</span>';
      } else if (st === 'terlambat') {
        var h = Math.floor(lateM / 60);
        var m = lateM % 60;
        var infoText = '<span class="wf-late-info">+' + (h > 0 ? h + 'j ' : '') + m + 'm</span>';
        timeCell = '<div class="wf-time-edit-wrap"><input type="time" class="wf-time-input" value="' + tm + '" data-time-dt="' + dateKey + '">' + infoText + '</div>';
      } else if (st === 'masuk') {
        timeCell = '<span class="wf-time-txt">09:00</span>';
      } else {
        timeCell = '<span class="wf-time-dash muted">-</span>';
      }

      var chip = '';
      if (st === 'masuk') {
        chip = '<span class="wf-status-chip wf-chip-masuk">✓ Masuk</span>';
      } else if (st === 'terlambat') {
        chip = '<span class="wf-status-chip wf-chip-late">⏱ Telat</span>';
      } else if (st === 'libur') {
        chip = '<span class="wf-status-chip wf-chip-off">✕ Libur</span>';
      } else {
        chip = '<span class="wf-status-chip wf-chip-none">—</span>';
      }

      html += '<tr class="' + rowCls + '" data-row-date="' + dateKey + '" title="Ketuk untuk memilih tanggal ini">' +
        '<td class="wf-col-date"><span class="wf-date-num">' + d + '</span> <span class="wf-date-day ' + (isSunday ? 'wf-sunday ' : '') + (isFriday ? 'wf-friday' : '') + '">' + dayName + '</span></td>' +
        '<td class="wf-col-status">' + chip + '</td>' +
        '<td class="wf-col-time">' + timeCell + '</td>' +
      '</tr>';
    }

    tbody.innerHTML = html;
  }

  function renderPayrollSlip(s) {
    var elGajiHarian = $('#wfSlipGajiHarian');
    var elHarianSub = $('#wfSlipHarianSub');
    var elBonusMaps = $('#wfSlipBonusMaps');
    var elBonusUnit = $('#wfSlipBonusUnit');
    var elBonusUnitSub = $('#wfSlipBonusUnitSub');
    var elDisiplinVal = $('#wfSlipDisiplinVal');
    var elDisiplinSub = $('#wfSlipDisiplinSub');
    var elDendaTerlambat = $('#wfSlipDendaTerlambat');
    var elDendaSub = $('#wfSlipDendaSub');
    var elPotonganJam = $('#wfSlipPotonganJam');
    var elPotonganJamSub = $('#wfSlipPotonganJamSub');
    var elBon = $('#wfSlipBon');
    var elAngsuran = $('#wfSlipAngsuran');
    var elTotalGaji = $('#wfSlipTotalGaji');

    if (elGajiHarian) elGajiHarian.textContent = rupiah(s.gajiHarian);
    if (elHarianSub) elHarianSub.textContent = s.countHadir + ' hari x Rp 135.000';

    if (elBonusMaps) elBonusMaps.textContent = rupiah(s.bonusMaps);
    if (elBonusUnit) elBonusUnit.textContent = rupiah(s.bonusUnit);
    if (elBonusUnitSub) {
      if (s.isUnitTierReached) {
        elBonusUnitSub.innerHTML = '<span class="text-success font-bold">✓ ' + s.bonusUnitCount + ' unit (&ge; 350) x Rp 2.000/unit</span>';
      } else if (s.bonusUnitCount > 0) {
        elBonusUnitSub.textContent = s.bonusUnitCount + ' unit (< 350 target Rp 2.000/unit)';
      } else {
        elBonusUnitSub.textContent = 'Target \u2265 350 unit \u2192 otomatis x Rp 2.000';
      }
    }

    if (elDisiplinVal) elDisiplinVal.textContent = rupiah(s.tunjanganDisiplin);
    if (elDisiplinSub) {
      if (s.tunjanganSyarat) {
        elDisiplinSub.innerHTML = '<span class="text-success">✓ Syarat terpenuhi (' + s.countHadir + ' hr)</span>: ' + s.tierDesc;
      } else {
        elDisiplinSub.innerHTML = '<span class="text-danger">✕ Belum mencapai syarat min. 27 hari kerja (' + s.countHadir + '/27 hr)</span>';
      }
    }

    if (elDendaTerlambat) elDendaTerlambat.textContent = '- ' + rupiah(s.dendaTerlambat);
    if (elDendaSub) elDendaSub.textContent = s.countTerlambat + ' hari terlambat x Rp 15.000';

    var jam = Math.floor(s.totalJamLambat);
    var mnt = s.totalMenitLambat % 60;
    var durText = (jam > 0 ? jam + ' jam ' : '') + mnt + ' menit';

    if (elPotonganJam) elPotonganJam.textContent = '- ' + rupiah(s.potonganJam);
    if (elPotonganJamSub) elPotonganJamSub.textContent = durText + ' (Rp 14.000/jam)';

    if (elBon) elBon.textContent = '- ' + rupiah(s.potonganBon);
    if (elAngsuran) elAngsuran.textContent = '- ' + rupiah(s.potonganAngsuran);

    if (elTotalGaji) elTotalGaji.textContent = rupiah(s.totalGajiBersih);
  }

  /* ---------------- Sinkronisasi Unit Mas Cim ---------------- */
  function syncMasCimDoneUnits() {
    var raw = localStorage.getItem('nava.mascim.local.v1');
    if (!raw) {
      TG.alert('Belum ada data servis Mas Cim ditemukan di perangkat ini.');
      return;
    }
    try {
      var data = JSON.parse(raw);
      var orders = Array.isArray(data.orders) ? data.orders : [];
      var ymPrefix = curMonth;

      var doneCount = 0;
      var doneProfit = 0;

      orders.forEach(function (o) {
        if (!o || o.deletedAt) return;
        var st = (o.serviceStatus || o.service_status || o.status || '').toLowerCase();
        var isDone = (st === 'done' || st === 'done diambil' || st === 'selesai' || st === 'lunas');
        var tgl = o.completedAt || o.completed_at || o.updatedAt || o.receivedAt || o.received_at || o.createdAt || o.created_at || o.tgl || '';
        var dStr = String(tgl).slice(0, 7);
        if (isDone && dStr === ymPrefix) {
          doneCount++;
          var fee = Number(o.totalCost) || Number(o.total_cost) || Number(o.biaya) || Number(o.total) || 0;
          doneProfit += fee;
        }
      });

      if (doneCount > 0) {
        var estimasi = (doneCount >= 350) ? (doneCount * 2000) : (doneCount * 15000);
        var rateMsg = (doneCount >= 350) ? (doneCount + ' unit x Rp 2.000 (Target >= 350)') : (doneCount + ' unit x Rp 15.000');
        TG.confirm('Ditemukan ' + doneCount + ' servis selesai/done di Mas Cim pada ' + curMonth + '.\n\nIsi bonus unit sebesar ' + rupiah(estimasi) + ' (' + rateMsg + ')?', function (ok) {
          if (!ok) return;
          payrollData.bonusUnitCount = doneCount;
          payrollData.bonusUnitRp = estimasi;
          var inCount = $('#wfInBonusUnitCount');
          if (inCount) inCount.value = doneCount;
          var inUnit = $('#wfInBonusUnit');
          if (inUnit) inUnit.value = estimasi;
          saveMonthData();
          renderAll();
          TG.haptic('success');
          w.App.toast(doneCount + ' unit servis berhasil disinkronkan');
        });
      } else {
        TG.alert('Tidak ada servis berstatus Selesai/Done di Mas Cim pada periode ' + curMonth + '.');
      }
    } catch (e) {
      console.warn('Gagal sync Mas Cim:', e);
      TG.alert('Gagal membaca data Mas Cim: ' + e.message);
    }
  }

  /* ---------------- Kirim Link Absensi ---------------- */
  function sendAttendanceLink() {
    var s = calculateSummary();
    var parts = curMonth.split('-');
    var yr = parts[0];
    var moNames = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
    var moName = moNames[parseInt(parts[1], 10) - 1] || curMonth;

    var jam = Math.floor(s.totalJamLambat);
    var mnt = s.totalMenitLambat % 60;
    var durText = (jam > 0 ? jam + ' jam ' : '') + mnt + ' menit';

    var text = '📋 *REKAP & LINK ABSENSI BULANAN*\n' +
      '*Periode:* ' + moName + ' ' + yr + '\n' +
      '-----------------------------------------\n' +
      '📊 *REKAP KEHADIRAN:*\n' +
      '• Masuk Kerja : ' + s.countHadir + ' Hari\n' +
      '• Terlambat   : ' + s.countTerlambat + ' Hari (' + durText + ')\n' +
      '• Hari Libur  : ' + s.countLibur + ' Hari\n' +
      '-----------------------------------------\n' +
      '💰 *RINCIAN PENGHASILAN:*\n' +
      '(+) Gaji Harian (' + s.countHadir + ' x 135rb) : ' + rupiah(s.gajiHarian) + '\n' +
      '(+) Bonus Maps (' + (payrollData.bonusMapsCount || 0) + ' maps) : ' + rupiah(s.bonusMaps) + '\n' +
      '(+) Bonus Unit Selesai (' + (s.bonusUnitCount || 0) + ' unit' + (s.isUnitTierReached ? ' x 2rb' : '') + ') : ' + rupiah(s.bonusUnit) + '\n' +
      '(+) Tunjangan Disiplin : ' + rupiah(s.tunjanganDisiplin) + ' (' + (s.tunjanganSyarat ? s.tierDesc : 'Syarat <27 hr belum terpenuhi') + ')\n' +
      '-----------------------------------------\n' +
      '⚠️ *PENGURANGAN / POTONGAN:*\n' +
      '(-) Denda Terlambat (' + s.countTerlambat + ' hr x 15rb) : ' + rupiah(s.dendaTerlambat) + '\n' +
      '(-) Potongan Jam (' + durText + ' x 14rb/jam) : ' + rupiah(s.potonganJam) + '\n' +
      '(-) Bon : ' + rupiah(s.potonganBon) + '\n' +
      '(-) Angsuran : ' + rupiah(s.potonganAngsuran) + '\n' +
      '-----------------------------------------\n' +
      '💵 *THP:*\n' +
      '*' + rupiah(s.totalGajiBersih) + '*\n' +
      '-----------------------------------------\n' +
      '🔗 *Buka Link Absensi:*\n' +
      APP_URL;

    // Jika di Telegram, bagikan langsung via Telegram Share URL
    if (TG && TG.isTelegram && typeof TG.openLink === 'function') {
      try {
        var tgShareUrl = 'https://t.me/share/url?url=' + encodeURIComponent(APP_URL) + '&text=' + encodeURIComponent(text);
        TG.openLink(tgShareUrl);
        TG.haptic('success');
        w.App.toast('Membuka share link Telegram…');
        return;
      } catch (eTg) {}
    }

    // Jika Web Share API tersedia
    if (navigator.share) {
      navigator.share({
        title: 'Rekap Absensi & Gaji ' + moName + ' ' + yr,
        text: text,
        url: APP_URL
      }).then(function () {
        TG.haptic('success');
        w.App.toast('Link absensi berhasil dibagikan');
      }).catch(function () {
        copyTextFallback(text);
      });
      return;
    }

    copyTextFallback(text);
  }

  function copyTextFallback(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        TG.haptic('success');
        w.App.toast('Link & rekap absensi disalin ke clipboard! Siap dikirim ke WhatsApp.');
      }).catch(function () {
        execCopy(text);
      });
    } else {
      execCopy(text);
    }
  }

  function execCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand('copy');
      TG.haptic('success');
      w.App.toast('Link absensi disalin!');
    } catch (e) {
      TG.alert('Silakan salin teks link absensi berikut:\n\n' + text);
    }
    document.body.removeChild(ta);
  }

  /* ---------------- Tindakan Tombol Input Absen (Masuk, Telat, Libur) ---------------- */
  function applyAttendance(status, targetDate, customTime) {
    var dt = targetDate || selectedDate || todayStr();
    if (!payrollData.days[dt]) {
      payrollData.days[dt] = { status: 'none', time: '09:00', lateMin: 0 };
    }

    var item = payrollData.days[dt];
    item.status = status;

    if (status === 'masuk') {
      item.time = '09:00';
      item.lateMin = 0;
    } else if (status === 'terlambat') {
      var tm = customTime || item.time || '09:15';
      if (parseTimeMinutes(tm) <= 540) {
        tm = '09:15';
      }
      item.time = tm;
      item.lateMin = Math.max(1, parseTimeMinutes(tm) - 540);
    } else if (status === 'libur') {
      item.time = '';
      item.lateMin = 0;
    }

    selectedDate = dt;
    saveMonthData();
    renderAll();
    TG.haptic('select');
  }

  /* ---------------- Bottom Sheet Pilih Jam Keterlambatan ---------------- */
  var _lateSheet = null;
  function closeLateSheet() {
    if (_lateSheet && _lateSheet.parentNode) _lateSheet.parentNode.removeChild(_lateSheet);
    _lateSheet = null;
    document.removeEventListener('keydown', onSheetEsc);
  }
  function onSheetEsc(e) {
    if (e.key === 'Escape') closeLateSheet();
  }

  function openLateSheet(dt, defTime) {
    closeLateSheet();

    var now = new Date();
    var nowTime = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');

    var quick = [];
    [15, 30, 45, 60].forEach(function (m) {
      var t = 9 * 60 + m;
      quick.push(String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'));
    });
    if (parseTimeMinutes(nowTime) > 540 && quick.indexOf(nowTime) < 0) quick.push(nowTime);

    var chips = quick.map(function (t) {
      return '<button type="button" class="wf-sheet-chip" data-jam="' + t + '">' + t + '</button>';
    }).join('');

    var ov = document.createElement('div');
    ov.className = 'wf-sheet-overlay';
    ov.innerHTML =
      '<div class="wf-sheet" role="dialog" aria-modal="true">' +
        '<div class="wf-sheet-grip"></div>' +
        '<div class="wf-sheet-title">⏱ Catat Keterlambatan</div>' +
        '<div class="wf-sheet-sub">Tanggal ' + dt + ' · standar masuk 09:00</div>' +
        '<div class="wf-sheet-chips">' + chips + '</div>' +
        '<label class="wf-sheet-label">Jam masuk aktual</label>' +
        '<input type="time" class="wf-sheet-time" id="wfSheetTime" value="' + defTime + '">' +
        '<div class="wf-sheet-late" id="wfSheetLateInfo"></div>' +
        '<div class="wf-sheet-actions">' +
          '<button type="button" class="btn ghost wf-sheet-cancel" id="wfSheetCancel">Batal</button>' +
          '<button type="button" class="btn primary wf-sheet-ok" id="wfSheetOk">Simpan Telat</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(ov);
    _lateSheet = ov;

    var inp = ov.querySelector('#wfSheetTime');
    var info = ov.querySelector('#wfSheetLateInfo');

    function refreshInfo() {
      var v = inp.value || defTime;
      var tMin = parseTimeMinutes(v);
      var late = Math.max(0, tMin - 540);
      if (late > 0) {
        var h = Math.floor(late / 60);
        var m = late % 60;
        info.innerHTML = 'Keterlambatan <b>+' + (h > 0 ? h + 'j ' : '') + m + 'm</b> · denda ' + rupiah(15000) + ' + potongan ' + rupiah(Math.round(late / 60 * 14000));
      } else {
        info.innerHTML = '<span class="text-success">Tidak terlambat (tepat waktu 09:00)</span>';
      }
    }
    refreshInfo();

    ov.addEventListener('click', function (e) {
      if (e.target === ov) { closeLateSheet(); return; }
      var chip = e.target.closest('[data-jam]');
      if (chip) {
        inp.value = chip.dataset.jam;
        refreshInfo();
        TG.haptic('select');
        return;
      }
      if (e.target.closest('#wfSheetCancel')) { closeLateSheet(); return; }
      if (e.target.closest('#wfSheetOk')) {
        var tm = inp.value || defTime;
        if (parseTimeMinutes(tm) <= 540) {
          TG.alert('Jam masuk harus lebih dari 09:00 untuk status Telat.');
          return;
        }
        applyAttendance('terlambat', dt, tm);
        closeLateSheet();
        w.App.toast('Absen Telat (' + tm + ') tanggal ' + dt.slice(8) + ' tercatat');
      }
    });

    inp.addEventListener('input', refreshInfo);
    document.addEventListener('keydown', onSheetEsc);
    setTimeout(function () { try { inp.focus(); } catch (e) {} }, 60);
  }

  /* ---------------- Event Listeners & Binding ---------------- */
  var _inited = false;
  function init() {
    if (_inited) return;
    _inited = true;

    // Bulan default: bulan ini
    var now = new Date();
    var defaultYm = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    loadMonthData(defaultYm);

    // Bulan input
    var monthInput = $('#wfMonthPicker');
    if (monthInput) {
      monthInput.value = curMonth;
      monthInput.addEventListener('change', function () {
        if (this.value) {
          loadMonthData(this.value);
          renderAll();
          // Update nilai input form sesuai data bulan terpilih
          var inMaps = $('#wfInBonusMaps');
          if (inMaps) inMaps.value = payrollData.bonusMapsCount || 0;
          var inCount = $('#wfInBonusUnitCount');
          if (inCount) inCount.value = payrollData.bonusUnitCount || 0;
          var inUnit = $('#wfInBonusUnit');
          if (inUnit) inUnit.value = (payrollData.bonusUnitCount >= 350) ? (payrollData.bonusUnitCount * 2000) : (payrollData.bonusUnitRp || 0);
          var inBon = $('#wfInBon');
          if (inBon) inBon.value = payrollData.bonusBon || 0;
          var inAngsuran = $('#wfInAngsuran');
          if (inAngsuran) inAngsuran.value = payrollData.bonusAngsuran || 0;
          var selTier = $('#wfSelDisciplineTier');
          if (selTier) selTier.value = payrollData.disciplineTier || 'auto';
          TG.haptic('select');
        }
      });
    }

    // Tombol Kirim Link Absensi (sejajar dengan bulan)
    var btnCopySlip = $('#wfBtnCopySlip');
    if (btnCopySlip) {
      btnCopySlip.addEventListener('click', function () {
        sendAttendanceLink();
      });
    }

    // Bonus Maps Input
    var inMaps = $('#wfInBonusMaps');
    if (inMaps) {
      inMaps.value = payrollData.bonusMapsCount || 0;
      inMaps.addEventListener('input', function () {
        payrollData.bonusMapsCount = Math.max(0, parseInt(this.value, 10) || 0);
        saveMonthData();
        renderPayrollSlip(calculateSummary());
      });
    }

    // Bonus Unit Inputs (Jumlah Unit & Rupiah)
    var inUnitCount = $('#wfInBonusUnitCount');
    var inUnit = $('#wfInBonusUnit');

    if (inUnitCount) {
      inUnitCount.value = payrollData.bonusUnitCount || 0;
      inUnitCount.addEventListener('input', function () {
        payrollData.bonusUnitCount = Math.max(0, parseInt(this.value, 10) || 0);
        if (payrollData.bonusUnitCount >= 350) {
          payrollData.bonusUnitRp = payrollData.bonusUnitCount * 2000;
          if (inUnit) inUnit.value = payrollData.bonusUnitRp;
        }
        saveMonthData();
        renderPayrollSlip(calculateSummary());
      });
    }

    if (inUnit) {
      inUnit.value = (payrollData.bonusUnitCount >= 350) ? (payrollData.bonusUnitCount * 2000) : (payrollData.bonusUnitRp || 0);
      inUnit.addEventListener('input', function () {
        payrollData.bonusUnitRp = Math.max(0, parseInt(this.value, 10) || 0);
        saveMonthData();
        renderPayrollSlip(calculateSummary());
      });
    }

    // Potongan Manual: Bon
    var inBon = $('#wfInBon');
    if (inBon) {
      inBon.value = payrollData.bonusBon || 0;
      inBon.addEventListener('input', function () {
        payrollData.bonusBon = Math.max(0, parseInt(this.value, 10) || 0);
        saveMonthData();
        renderPayrollSlip(calculateSummary());
      });
    }

    // Potongan Manual: Angsuran
    var inAngsuran = $('#wfInAngsuran');
    if (inAngsuran) {
      inAngsuran.value = payrollData.bonusAngsuran || 0;
      inAngsuran.addEventListener('input', function () {
        payrollData.bonusAngsuran = Math.max(0, parseInt(this.value, 10) || 0);
        saveMonthData();
        renderPayrollSlip(calculateSummary());
      });
    }

    // Tier Disiplin Select
    var selTier = $('#wfSelDisciplineTier');
    if (selTier) {
      selTier.value = payrollData.disciplineTier || 'auto';
      selTier.addEventListener('change', function () {
        payrollData.disciplineTier = this.value;
        saveMonthData();
        renderPayrollSlip(calculateSummary());
      });
    }

    // Tombol Sinkronkan Servis Mas Cim
    var btnSyncMascim = $('#wfBtnSyncMascim');
    if (btnSyncMascim) {
      btnSyncMascim.addEventListener('click', function () {
        syncMasCimDoneUnits();
      });
    }

    // Tiga Tombol Utama Input Absen di Header Tabel
    // 1. Tombol Masuk
    var btnQuickMasuk = $('#wfBtnQuickMasuk');
    if (btnQuickMasuk) {
      btnQuickMasuk.addEventListener('click', function () {
        var dt = selectedDate || todayStr();
        applyAttendance('masuk', dt, '09:00');
        w.App.toast('Absen Masuk (09:00) tanggal ' + dt.slice(8) + ' tercatat');
      });
    }

    // 2. Tombol Telat
    var btnQuickLate = $('#wfBtnQuickLate');
    if (btnQuickLate) {
      btnQuickLate.addEventListener('click', function () {
        var dt = selectedDate || todayStr();
        var now = new Date();
        var nowTime = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
        var defTime = parseTimeMinutes(nowTime) > 540 ? nowTime : '09:15';
        openLateSheet(dt, defTime);
      });
    }

    // 3. Tombol Libur
    var btnQuickOff = $('#wfBtnQuickOff');
    if (btnQuickOff) {
      btnQuickOff.addEventListener('click', function () {
        var dt = selectedDate || todayStr();
        applyAttendance('libur', dt);
        w.App.toast('Absen Libur tanggal ' + dt.slice(8) + ' tercatat');
      });
    }

    // Delegasi interaksi di tabel absensi:
    // 1. Klik baris tabel untuk memilih tanggal aktif (target tombol Masuk/Telat/Libur)
    // 2. Ubah isian jam keterlambatan langsung di baris (status terlambat)
    var tableBody = $('#wfAttTableBody');
    if (tableBody) {
      tableBody.addEventListener('click', function (e) {
        if (e.target.closest('[data-time-dt]')) return;
        var row = e.target.closest('[data-row-date]');
        if (!row) return;
        selectedDate = row.dataset.rowDate;
        renderHeaderInfo();
        $$('.wf-att-row').forEach(function (r) {
          r.classList.toggle('wf-row-selected', r.dataset.rowDate === selectedDate);
        });
        TG.haptic('select');
      });

      tableBody.addEventListener('change', function (e) {
        var inp = e.target.closest('[data-time-dt]');
        if (!inp) return;
        var dt = inp.dataset.timeDt;
        var tm = inp.value || '09:00';
        if (!dt) return;

        if (!payrollData.days[dt]) {
          payrollData.days[dt] = { status: 'terlambat', time: tm, lateMin: 0 };
        }

        var item = payrollData.days[dt];
        item.time = tm;
        var tMin = parseTimeMinutes(tm);
        if (item.status !== 'libur') {
          if (tMin > 540) {
            item.status = 'terlambat';
            item.lateMin = tMin - 540;
          } else {
            item.status = 'masuk';
            item.lateMin = 0;
          }
        }

        selectedDate = dt;
        saveMonthData();
        renderAll();
      });
    }

    // Tab Switcher Workflow (Absensi & Gaji vs Catatan & Pengingat)
    var tabs = $$('.wf-tab-btn');
    tabs.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var tabId = this.dataset.wftab;
        setWorkflowTab(tabId);
        TG.haptic('select');
      });
    });

    renderAll();
    initAttendanceReminder();
  }

  /* ---------------- Pengingat Notifikasi Absensi Tiap Jam 9 (Ulang Tiap 5 Menit) ---------------- */
  var _remindModal = null;
  function showAttendanceActionPopup(dateStr) {
    if (_remindModal && _remindModal.parentNode) return; // sudah terbuka
    var dt = dateStr || todayStr();

    var overlay = document.createElement('div');
    overlay.className = 'wf-remind-modal-overlay';
    overlay.innerHTML =
      '<div class="wf-remind-modal-box" role="dialog" aria-modal="true">' +
        '<div class="wf-remind-icon">⏰</div>' +
        '<h3 class="wf-remind-title">Waktunya Absensi!</h3>' +
        '<div class="wf-remind-desc">Sudah jam 09:00 WIB. Silakan pilih status absensi hari ini (' + dt + ') agar kompensasi tercatat akurat.</div>' +
        '<div class="wf-remind-btn-group">' +
          '<button type="button" class="wf-remind-btn wf-remind-masuk" id="wfModalBtnMasuk">✓ Masuk Tepat Waktu (09:00)</button>' +
          '<button type="button" class="wf-remind-btn wf-remind-telat" id="wfModalBtnTelat">⏱ Terlambat / Jam Tertentu</button>' +
          '<button type="button" class="wf-remind-btn wf-remind-libur" id="wfModalBtnLibur">✕ Hari Libur</button>' +
        '</div>' +
        '<button type="button" class="wf-remind-close" id="wfModalBtnTutup">Nanti Saja</button>' +
      '</div>';

    document.body.appendChild(overlay);
    _remindModal = overlay;

    overlay.querySelector('#wfModalBtnMasuk').addEventListener('click', function () {
      applyAttendance('masuk', dt, '09:00');
      closeAttendanceModal();
      w.App.toast('✓ Absen Masuk berhasil dicatat!', 2500, 'ok');
    });

    overlay.querySelector('#wfModalBtnTelat').addEventListener('click', function () {
      closeAttendanceModal();
      var now = new Date();
      var nowTime = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
      var defTime = parseTimeMinutes(nowTime) > 540 ? nowTime : '09:15';
      openLateSheet(dt, defTime);
    });

    overlay.querySelector('#wfModalBtnLibur').addEventListener('click', function () {
      applyAttendance('libur', dt);
      closeAttendanceModal();
      w.App.toast('✕ Absen Libur berhasil dicatat!', 2500, 'ok');
    });

    overlay.querySelector('#wfModalBtnTutup').addEventListener('click', function () {
      closeAttendanceModal();
    });
  }

  function closeAttendanceModal() {
    if (_remindModal && _remindModal.parentNode) {
      _remindModal.parentNode.removeChild(_remindModal);
    }
    _remindModal = null;
  }

  function initAttendanceReminder() {
    // Minta izin Web Notification jika didukung
    try {
      if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
      }
    } catch (e) {}

    // Periksa status absensi & jadwal pengingat jam 9 tiap 5 menit
    function checkReminderSchedule() {
      var now = new Date();
      var h = now.getHours();
      var tToday = todayStr();

      // Cek apakah tanggal hari ini sudah diisi absen
      var currentItem = payrollData.days ? payrollData.days[tToday] : null;
      var hasAttended = (currentItem && currentItem.status && currentItem.status !== 'none');
      if (hasAttended) return; // Sudah absen, tidak perlu diingatkan lagi

      // Jika waktu lokal jam >= 9:00 pagi
      if (h >= 9) {
        var lastNotifKey = 'calm_wf_last_remind_time';
        var lastTime = parseInt(localStorage.getItem(lastNotifKey) || '0', 10);
        var nowMs = Date.now();
        var INTERVAL_5_MIN = 5 * 60 * 1000;

        // Ulangi tiap 5 menit
        if (nowMs - lastTime >= INTERVAL_5_MIN) {
          localStorage.setItem(lastNotifKey, String(nowMs));

          // 1. Kirim System/Phone Web Notification jika didukung
          try {
            if ('Notification' in window && Notification.permission === 'granted') {
              var notif = new Notification('⏰ Pengingat Absensi (09:00 WIB)', {
                body: 'Ketuk di sini untuk memilih Masuk, Telat, atau Libur hari ini.',
                icon: 'assets/icons/icon-192.png',
                tag: 'absensi-reminder-' + tToday
              });
              notif.onclick = function () {
                window.focus();
                if (w.App && w.App.go) w.App.go('workflow');
                showAttendanceActionPopup(tToday);
                notif.close();
              };
            }
          } catch (eNotif) {}

          // 2. Tampilkan dialog interaktif 3 tombol (Masuk - Telat - Libur) langsung di layar
          showAttendanceActionPopup(tToday);
          TG.haptic('warn');
        }
      }
    }

    // Jalankan pengecekan awal & polling interval tiap 30 detik (menjamin batas 5 menit tepat terdeteksi)
    setTimeout(checkReminderSchedule, 1500);
    setInterval(checkReminderSchedule, 30000);
  }

  function setWorkflowTab(tabId) {
    $$('.wf-tab-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.wftab === tabId);
    });
    var panePayroll = $('#wfPane-payroll');
    var paneNotes = $('#wfPane-notes');
    if (panePayroll) panePayroll.classList.toggle('active', tabId === 'payroll');
    if (paneNotes) paneNotes.classList.toggle('active', tabId === 'notes');
    if (tabId === 'notes' && w.NotesUI && w.NotesUI.render) {
      w.NotesUI.render();
    }
  }

  w.WorkflowUI = {
    init: init,
    render: renderAll,
    setTab: setWorkflowTab,
    calculateSummary: calculateSummary,
    sendLink: sendAttendanceLink,
    applyAttendance: applyAttendance
  };

})(window);
