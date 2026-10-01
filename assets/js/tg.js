/* =========================================================
   tg.js — Bridge ke Telegram WebApp (Mini App SDK)
   Aman dijalankan di browser biasa (mock) untuk testing lokal.
   ========================================================= */
(function (w) {
  'use strict';

  var isTelegram = !!(w.Telegram && w.Telegram.WebApp && w.Telegram.WebApp.initData);
  var WA = isTelegram ? w.Telegram.WebApp : createMock();

  function createMock() {
    var noop = function () {};
    return {
      initData: '', initDataUnsafe: {}, version: '7.0', platform: 'web',
      colorScheme: 'light', themeParams: {},
      isExpanded: false, viewportHeight: w.innerHeight,
      ready: noop, expand: noop, close: noop,
      disableVerticalSwipes: noop, enableClosingConfirmation: noop,
      setHeaderColor: noop, setBackgroundColor: noop,
      onEvent: noop, offEvent: noop,
      HapticFeedback: { impactOccurred: noop, notificationOccurred: noop, selectionChanged: noop },
      BackButton: { show: noop, hide: noop, onClick: noop, offClick: noop },
      MainButton: {
        text: '', isVisible: false,
        show: noop, hide: noop, setText: noop, onClick: noop, offClick: noop
      },
      showPopup: function (p, cb) { cb && cb('ok'); },
      showAlert: function (m) { w.alert(m); },
      showConfirm: function (m, cb) { cb && cb(w.confirm(m)); },
      openTelegramLink: function (u) { w.open(u, '_blank'); },
      openLink: function (u) { w.open(u, '_blank'); },
      sendData: noop
    };
  }

  var TG = {
    wa: WA,
    isTelegram: isTelegram,
    user: (WA.initDataUnsafe && WA.initDataUnsafe.user) || null,
    chat: (WA.initDataUnsafe && WA.initDataUnsafe.chat) || null,

    init: function () {
      if (isTelegram) {
        try { WA.ready(); WA.expand(); } catch (e) {}
        // Ikuti tema Telegram
        applyTheme(WA.colorScheme);
        // Cegah swipe-tutup yang mengganggu saat menulis
        try { if (WA.platform !== 'ios') WA.disableVerticalSwipes(); } catch (e) {}
        try { WA.setHeaderColor && WA.setHeaderColor(); } catch (e) {}
      }
    },

    // Terapkan variabel tema dari Telegram
    applyTheme: applyTheme,

    userName: function () {
      var u = TG.user;
      if (!u) return 'Tukang';
      var n = (u.first_name || '') + ' ' + (u.last_name || '');
      return (n || u.username || 'Tukang').trim();
    },

    // Haptic — mental vibration physical di HP
    haptic: function (type) {
      try {
        if (type === 'success' || type === 'error' || type === 'warning')
          WA.HapticFeedback.notificationOccurred(type);
        else if (type === 'select')
          WA.HapticFeedback.selectionChanged();
        else
          WA.HapticFeedback.impactOccurred(type || 'light');
      } catch (e) {}
    },

    alert: function (msg) {
      if (isTelegram && WA.showAlert) { try { WA.showAlert(msg); return; } catch (e) {} }
      w.alert(msg);
    },

    confirm: function (msg, cb) {
      if (isTelegram && WA.showConfirm) {
        try { WA.showConfirm(msg, function (ok) { cb(!!ok); }); return; } catch (e) {}
      }
      cb(w.confirm(msg));
    },

    // Kirim data ke bot (butuh bot yang meng-handle message dari web_app_data)
    sendData: function (payload, cb) {
      if (!isTelegram) { cb && cb(false); return; }
      try { WA.sendData(payload, cb || function () {}); } catch (e) { cb && cb(false); }
    },

    openTelegramLink: function (url) {
      if (isTelegram && WA.openTelegramLink) { try { WA.openTelegramLink(url); return; } catch (e) {} }
      w.open(url, '_blank');
    },

    // MainButton
    main: {
      show: function (text, onClick) {
        var b = WA.MainButton;
        if (!b) return;
        try {
          b.setParams && b.setParams({ color: '#2f6fed', text_color: '#ffffff', is_active: true });
          b.setText(text); b.onClick(onClick); b.show();
        } catch (e) {}
      },
      hide: function () { try { WA.MainButton && WA.MainButton.hide(); } catch (e) {} }
    },

    // BackButton
    back: {
      show: function (onClick) { try { WA.BackButton.show(); WA.BackButton.onClick(onClick); } catch (e) {} },
      hide: function () { try { WA.BackButton.hide(); } catch (e) {} }
    }
  };

  function applyTheme(scheme) {
    var root = document.documentElement;
    root.classList.toggle('dark', scheme === 'dark');
    root.classList.toggle('light', scheme === 'light');
    var tp = WA.themeParams || {};
    var set = function (k, v) { if (v) root.style.setProperty(k, v); };
    set('--accent', tp.button_color);
    set('--accent-text', tp.button_text_color);
    set('--bg', tp.bg_color);
    set('--bg-elev', tp.secondary_bg_color);
    set('--text', tp.text_color);
    set('--text-2', tp.hint_color);
    set('--line', tp.section_separator_color);
    if (tp.bg_color) document.querySelector('meta[name=theme-color]')
      && document.querySelector('meta[name=theme-color]').setAttribute('content', tp.bg_color);
  }

  w.TG = TG;
})(window);
