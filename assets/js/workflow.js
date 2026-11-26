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

  // State aktif payroll
  var curMonth = ''; // YYYY-MM
  var payrollData = {
    empName: 'Ali (Teknisi)',
    bonusMapsCount: 0,
    bonusUnitRp: 0,
    disciplineTier: 'auto', // auto | full_clean | min_clean | full_late | min_late | none
    days: {} // 'YYYY-MM-DD': { status: 'masuk'|'terlambat'|'libur', time: '09:00', lateMin: 0 }
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

  function minutesToTimeStr(m) {
    m = Math.max(0, Math.floor(m));
    var hh = String(Math.floor(m / 60)).padStart(2, '0');
    var mm = String(m % 60).padStart(2, '0');
    return hh + ':' + mm;
  }

  function loadMonthData(ym) {
    curMonth = ym;
    var raw = localStorage.getItem(STORAGE_PREFIX + ym);
    if (raw) {
      try {
        var parsed = JSON.parse(raw);
        payrollData = Object.assign({
          empName: 'Ali (Teknisi)',
          bonusMapsCount: 0,
          bonusUnitRp: 0,
          disciplineTier: 'auto',
          days: {}
        }, parsed);
      } catch (e) {
        console.warn('Gagal membaca payrollData:', e);
      }
    } else {
      payrollData = {
        empName: 'Ali (Teknisi)',
        bonusMapsCount: 0,
        bonusUnitRp: 0,
        disciplineTier: 'auto',
        days: {}
      };
      // Inisialisasi hari default: Senin-Sabtu masuk, Minggu libur
      initDefaultDays(ym);
      saveMonthData();
    }
  }

  function initDefaultDays(ym) {
    var parts = ym.split('-');
    var yr = parseInt(parts[0], 10);
    var mo = parseInt(parts[1], 10);
    var totalDays = getDaysInMonth(yr, mo);

    for (var d = 1; d <= totalDays; d++) {
      var dateKey = ym + '-' + String(d).padStart(2, '0');
      var dt = new Date(yr, mo - 1, d);
      var dayOfWeek = dt.getDay(); // 0 = Minggu
      if (!payrollData.days[dateKey]) {
        if (dayOfWeek === 0) {
          payrollData.days[dateKey] = { status: 'libur', time: '09:00', lateMin: 0 };
        } else {
          payrollData.days[dateKey] = { status: 'masuk', time: '09:00', lateMin: 0 };
        }
      }
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
      var item = payrollData.days[dateKey] || { status: 'masuk', time: '09:00', lateMin: 0 };

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

    // 3. Bonus Unit / Done Diambil
    var bonusUnit = Math.max(0, parseInt(payrollData.bonusUnitRp, 10) || 0);

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

    // Total Gaji Bersih
    var totalGajiBersih = (gajiHarian + bonusMaps + bonusUnit + tunjanganDisiplin) - (dendaTerlambat + potonganJam);

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
      tunjanganSyarat: tunjanganSyarat,
      rateDisiplinPerHari: rateDisiplinPerHari,
      tunjanganDisiplin: tunjanganDisiplin,
      tierDesc: tierDesc,
      dendaTerlambat: dendaTerlambat,
      potonganJam: potonganJam,
      totalGajiBersih: totalGajiBersih
    };
  }

  /* ---------------- Render UI ---------------- */
  function renderAll() {
    var sum = calculateSummary();
    renderStats(sum);
    renderAttendanceTable(sum);
    renderPayrollSlip(sum);
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

    var html = '';
    for (var d = 1; d <= s.totalDays; d++) {
      var dateKey = curMonth + '-' + String(d).padStart(2, '0');
      var dt = new Date(yr, mo - 1, d);
      var dayName = dayNames[dt.getDay()];
      var isSunday = dt.getDay() === 0;

      var item = payrollData.days[dateKey] || { status: isSunday ? 'libur' : 'masuk', time: '09:00', lateMin: 0 };
      var st = item.status;
      var tm = item.time || '09:00';
      var lateM = item.lateMin || 0;

      // Status pill style & text
      var rowCls = 'wf-row-' + st;
      var statusBadge = '';
      if (st === 'masuk') {
        statusBadge = '<span class="wf-badge wf-badge-ontime">MASUK</span>';
      } else if (st === 'terlambat') {
        statusBadge = '<span class="wf-badge wf-badge-late">TERLAMBAT (' + tm + ')</span>';
      } else {
        statusBadge = '<span class="wf-badge wf-badge-off">LIBUR</span>';
      }

      var infoText = '';
      if (st === 'terlambat') {
        var h = Math.floor(lateM / 60);
        var m = lateM % 60;
        infoText = '<span class="wf-late-info">+' + (h > 0 ? h + 'j ' : '') + m + 'm</span>';
      }

      html += '<tr class="wf-att-row ' + rowCls + '" data-date="' + dateKey + '">' +
        '<td class="wf-col-date"><span class="wf-date-num">' + d + '</span> <span class="wf-date-day ' + (isSunday ? 'wf-sunday' : '') + '">' + dayName + '</span></td>' +
        '<td class="wf-col-status">' +
          '<div class="wf-status-select-wrap">' +
            '<button type="button" class="wf-st-btn wf-btn-masuk ' + (st === 'masuk' ? 'active' : '') + '" data-setst="masuk" data-dt="' + dateKey + '">Masuk</button>' +
            '<button type="button" class="wf-st-btn wf-btn-late ' + (st === 'terlambat' ? 'active' : '') + '" data-setst="terlambat" data-dt="' + dateKey + '">Lambat</button>' +
            '<button type="button" class="wf-st-btn wf-btn-off ' + (st === 'libur' ? 'active' : '') + '" data-setst="libur" data-dt="' + dateKey + '">Libur</button>' +
          '</div>' +
        '</td>' +
        '<td class="wf-col-time">' +
          '<input type="time" class="wf-time-input ' + (st === 'libur' ? 'disabled' : '') + '" value="' + tm + '" data-time-dt="' + dateKey + '" ' + (st === 'libur' ? 'disabled' : '') + '>' +
          infoText +
        '</td>' +
      '</tr>';
    }

    tbody.innerHTML = html;
  }

  function renderPayrollSlip(s) {
    var elGajiHarian = $('#wfSlipGajiHarian');
    var elHarianSub = $('#wfSlipHarianSub');
    var elBonusMaps = $('#wfSlipBonusMaps');
    var elBonusUnit = $('#wfSlipBonusUnit');
    var elDisiplinRow = $('#wfSlipDisiplinRow');
    var elDisiplinVal = $('#wfSlipDisiplinVal');
    var elDisiplinSub = $('#wfSlipDisiplinSub');
    var elDendaTerlambat = $('#wfSlipDendaTerlambat');
    var elDendaSub = $('#wfSlipDendaSub');
    var elPotonganJam = $('#wfSlipPotonganJam');
    var elPotonganJamSub = $('#wfSlipPotonganJamSub');
    var elTotalGaji = $('#wfSlipTotalGaji');

    if (elGajiHarian) elGajiHarian.textContent = rupiah(s.gajiHarian);
    if (elHarianSub) elHarianSub.textContent = s.countHadir + ' hari x Rp 135.000';

    if (elBonusMaps) elBonusMaps.textContent = rupiah(s.bonusMaps);
    if (elBonusUnit) elBonusUnit.textContent = rupiah(s.bonusUnit);

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
      var ymPrefix = curMonth; // 'YYYY-MM'

      var doneCount = 0;
      var doneProfit = 0;

      orders.forEach(function (o) {
        if (!o || o.deletedAt) return;
        // Ambil servis di bulan ini yang statusnya Done / Done Diambil
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
        // Asumsi insentif teknisi per unit (misal Rp 15.000/unit atau sesuai input)
        // Kita tawarkan ke pengguna
        var estimasi = doneCount * 15000;
        TG.confirm('Ditemukan ' + doneCount + ' servis selesai/done di Mas Cim pada ' + curMonth + '.\n\nIsi bonus unit sebesar ' + rupiah(estimasi) + ' (' + doneCount + ' unit x Rp 15.000)?', function (ok) {
          if (!ok) return;
          payrollData.bonusUnitRp = estimasi;
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

  /* ---------------- Salin Slip Gaji WhatsApp ---------------- */
  function copyPayrollSlipText() {
    var s = calculateSummary();
    var parts = curMonth.split('-');
    var yr = parts[0];
    var moNames = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
    var moName = moNames[parseInt(parts[1], 10) - 1] || curMonth;

    var jam = Math.floor(s.totalJamLambat);
    var mnt = s.totalMenitLambat % 60;
    var durText = (jam > 0 ? jam + ' jam ' : '') + mnt + ' menit';

    var text = '📄 *SLIP GAJI & REKAP ABSENSI TEKNISI*\n' +
      '*Nama:* ' + (payrollData.empName || 'Teknisi') + '\n' +
      '*Periode:* ' + moName + ' ' + yr + '\n' +
      '-----------------------------------------\n' +
      '📊 *REKAP KEHADIRAN:*\n' +
      '• Hari Masuk: ' + s.countHadir + ' Hari\n' +
      '• Terlambat: ' + s.countTerlambat + ' Hari (' + durText + ')\n' +
      '• Hari Libur: ' + s.countLibur + ' Hari\n' +
      '-----------------------------------------\n' +
      '💰 *RINCIAN PENGHASILAN:*\n' +
      '(+) Gaji Harian (' + s.countHadir + ' x 135rb) : ' + rupiah(s.gajiHarian) + '\n' +
      '(+) Bonus Maps (' + (payrollData.bonusMapsCount || 0) + ' maps) : ' + rupiah(s.bonusMaps) + '\n' +
      '(+) Bonus Unit Selesai : ' + rupiah(s.bonusUnit) + '\n' +
      '(+) Tunjangan Disiplin : ' + rupiah(s.tunjanganDisiplin) + ' (' + (s.tunjanganSyarat ? s.tierDesc : 'Syarat <27 hr belum terpenuhi') + ')\n' +
      '-----------------------------------------\n' +
      '⚠️ *PENGURANGAN / POTONGAN:*\n' +
      '(-) Denda Terlambat (' + s.countTerlambat + ' hr x 15rb) : ' + rupiah(s.dendaTerlambat) + '\n' +
      '(-) Potongan Jam (' + durText + ' x 14rb/jam) : ' + rupiah(s.potonganJam) + '\n' +
      '-----------------------------------------\n' +
      '💵 *TOTAL GAJI BERSIH (DITERIMA):*\n' +
      '*' + rupiah(s.totalGajiBersih) + '*\n' +
      '-----------------------------------------\n' +
      '_Dibuat otomatis via Project Nava Workflow_';

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        TG.haptic('success');
        w.App.toast('Rincian slip gaji disalin ke clipboard! Siap ditempel ke WhatsApp.');
      }).catch(function () {
        fallbackCopy(text);
      });
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
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
      w.App.toast('Rincian slip gaji disalin!');
    } catch (e) {
      TG.alert('Gagal menyalin otomatis. Silakan salin manual:\n\n' + text);
    }
    document.body.removeChild(ta);
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
          TG.haptic('select');
        }
      });
    }

    // Nama Karyawan
    var empInput = $('#wfEmpName');
    if (empInput) {
      empInput.value = payrollData.empName || 'Ali (Teknisi)';
      empInput.addEventListener('input', function () {
        payrollData.empName = this.value;
        saveMonthData();
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

    // Bonus Unit Input
    var inUnit = $('#wfInBonusUnit');
    if (inUnit) {
      inUnit.value = payrollData.bonusUnitRp || 0;
      inUnit.addEventListener('input', function () {
        payrollData.bonusUnitRp = Math.max(0, parseInt(this.value, 10) || 0);
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

    // Tombol Salin Slip WhatsApp
    var btnCopySlip = $('#wfBtnCopySlip');
    if (btnCopySlip) {
      btnCopySlip.addEventListener('click', function () {
        copyPayrollSlipText();
      });
    }

    // Tombol Tindakan Cepat Absensi
    var btnSetSenSab = $('#wfBtnSetWorkdays');
    if (btnSetSenSab) {
      btnSetSenSab.addEventListener('click', function () {
        TG.confirm('Tandai semua hari Senin-Sabtu di bulan ini sebagai MASUK (09:00)?', function (ok) {
          if (!ok) return;
          var parts = curMonth.split('-');
          var yr = parseInt(parts[0], 10);
          var mo = parseInt(parts[1], 10);
          var totalDays = getDaysInMonth(yr, mo);
          for (var d = 1; d <= totalDays; d++) {
            var dt = new Date(yr, mo - 1, d);
            var dateKey = curMonth + '-' + String(d).padStart(2, '0');
            if (dt.getDay() !== 0) { // bukan Minggu
              payrollData.days[dateKey] = { status: 'masuk', time: '09:00', lateMin: 0 };
            }
          }
          saveMonthData();
          renderAll();
          TG.haptic('success');
          w.App.toast('Senin-Sabtu diatur Masuk');
        });
      });
    }

    var btnSetSunOff = $('#wfBtnSetSundaysOff');
    if (btnSetSunOff) {
      btnSetSunOff.addEventListener('click', function () {
        var parts = curMonth.split('-');
        var yr = parseInt(parts[0], 10);
        var mo = parseInt(parts[1], 10);
        var totalDays = getDaysInMonth(yr, mo);
        for (var d = 1; d <= totalDays; d++) {
          var dt = new Date(yr, mo - 1, d);
          var dateKey = curMonth + '-' + String(d).padStart(2, '0');
          if (dt.getDay() === 0) { // Minggu
            payrollData.days[dateKey] = { status: 'libur', time: '09:00', lateMin: 0 };
          }
        }
        saveMonthData();
        renderAll();
        TG.haptic('select');
        w.App.toast('Semua hari Minggu diatur Libur');
      });
    }

    var btnResetMonth = $('#wfBtnResetMonth');
    if (btnResetMonth) {
      btnResetMonth.addEventListener('click', function () {
        TG.confirm('Reset data absensi & kompensasi bulan ' + curMonth + ' ke default?', function (ok) {
          if (!ok) return;
          payrollData.bonusMapsCount = 0;
          payrollData.bonusUnitRp = 0;
          payrollData.days = {};
          initDefaultDays(curMonth);
          saveMonthData();
          if (inMaps) inMaps.value = 0;
          if (inUnit) inUnit.value = 0;
          renderAll();
          TG.haptic('success');
          w.App.toast('Data bulan direset');
        });
      });
    }

    // Delegasi interaksi di tabel absensi (ganti status & ubah jam)
    var tableBody = $('#wfAttTableBody');
    if (tableBody) {
      tableBody.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-setst]');
        if (!btn) return;
        var st = btn.dataset.setst;
        var dt = btn.dataset.dt;
        if (!dt) return;

        if (!payrollData.days[dt]) {
          payrollData.days[dt] = { status: 'masuk', time: '09:00', lateMin: 0 };
        }

        var item = payrollData.days[dt];
        item.status = st;
        if (st === 'masuk') {
          item.time = '09:00';
          item.lateMin = 0;
        } else if (st === 'terlambat') {
          // Bila sebelumnya tepat waktu, set default jam terlambat 09:15
          if (parseTimeMinutes(item.time) <= 540) {
            item.time = '09:15';
          }
          item.lateMin = Math.max(1, parseTimeMinutes(item.time) - 540);
        } else if (st === 'libur') {
          item.lateMin = 0;
        }

        saveMonthData();
        renderAll();
        TG.haptic('select');
      });

      tableBody.addEventListener('change', function (e) {
        var inp = e.target.closest('[data-time-dt]');
        if (!inp) return;
        var dt = inp.dataset.timeDt;
        var tm = inp.value || '09:00';
        if (!dt) return;

        if (!payrollData.days[dt]) {
          payrollData.days[dt] = { status: 'masuk', time: '09:00', lateMin: 0 };
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
    copySlip: copyPayrollSlipText
  };

})(window);
