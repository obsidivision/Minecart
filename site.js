/* floatcart — shared by the five pages: the theme button and two formatting helpers.
   The saved theme is applied by a one-line script in each page's <head>, before first paint;
   this file only runs the button. The choice is shared by every page (and open tab). */
var FC = (function () {
  'use strict';
  var root = document.documentElement, KEY = 'floatcart-rules-theme';

  function isDark() {
    var t = root.getAttribute('data-theme');
    if (t) return t === 'dark';
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
  function sync() {
    var btn = document.getElementById('theme');
    if (!btn) return;
    var dark = isDark();
    btn.setAttribute('aria-pressed', String(dark));
    btn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    btn.title = dark ? 'Light mode' : 'Dark mode';
  }
  function set(t) {
    root.setAttribute('data-theme', t);
    try { localStorage.setItem(KEY, t); } catch (e) { /* private window: the choice lasts this page only */ }
    sync();
  }
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('#theme');
    if (btn) set(isDark() ? 'light' : 'dark');
  });
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', sync);
  }
  window.addEventListener('storage', function (e) {
    if (e.key === KEY && (e.newValue === 'light' || e.newValue === 'dark')) { root.setAttribute('data-theme', e.newValue); sync(); }
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sync); else sync();

  return {
    isDark: isDark,
    esc: function (s) {
      return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
    },
    /* a very small number as an ordinary decimal with two digits that matter: 0.0000035, not 3.5e-6 */
    small: function (v) {
      var a = Math.abs(v);
      if (!(a > 0)) return '0';
      var s = a.toFixed(Math.max(0, Math.min(14, 1 - Math.floor(Math.log10(a)))));
      if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
      return (v < 0 ? '−' : '') + s;
    }
  };
})();
