/* floatcart — shared by the five pages: the theme button, the phone menu, Minecraft textures and two formatting helpers.
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
  // on a phone the page links fold into a menu button next to the theme button
  function menu() {
    var nav = document.querySelector('.topbar nav'), theme = document.getElementById('theme');
    if (!nav || !theme || document.querySelector('.nav-btn')) return;
    var btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn ghost sm nav-btn'; btn.textContent = 'Menu';
    btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-controls', nav.id || (nav.id = 'pages'));
    theme.parentNode.insertBefore(btn, theme);
    btn.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      btn.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', function (e) {
      if (nav.classList.contains('open') && !nav.contains(e.target) && e.target !== btn) { nav.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); }
    });
  }
  /* ---------- Minecraft's own textures, from the visitor's copy of the game ----------
     The game's textures are Mojang's and can't be shipped with this site, so the visitor picks
     their own client jar (versions/<version>/<version>.jar) or a resource pack .zip. Only the few
     block textures the 3D views use are read out of it, in the browser; they are kept in
     localStorage for the next visit and never leave the machine. The 3D views listen for the
     'mc-textures' event and fall back to their own drawn textures without them. */
  var MC_KEY = 'floatcart-mc-textures';
  var MC_NAMES = ['white_stained_glass', 'white_concrete', 'honey_block_side', 'honey_block_top', 'note_block', 'observer_side', 'observer_front',
    'piston_side', 'piston_top', 'polished_deepslate', 'scaffolding_side', 'scaffolding_top', 'amethyst_block', 'oxidized_copper_grate',
    'cobblestone', 'cherry_planks', 'oak_planks', 'water_still', 'rail', 'powered_rail', 'powered_rail_on', 'detector_rail', 'iron_block'];
  function mcTextures() {
    try { var t = JSON.parse(localStorage.getItem(MC_KEY) || 'null'); return t && t.tex ? t : null; } catch (e) { return null; }
  }
  // A zip's files, the ones want(name) gives a key for: {key: Uint8Array}. Reads zip64 too (large jars).
  function unzip(buf, want) {
    var dv = new DataView(buf), u8 = new Uint8Array(buf), e = buf.byteLength - 22;
    while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) return Promise.reject(new Error('not a zip or jar file'));
    var count = dv.getUint16(e + 10, true), p = dv.getUint32(e + 16, true);
    if ((count === 0xffff || p === 0xffffffff) && e >= 20 && dv.getUint32(e - 20, true) === 0x07064b50) {
      var z = Number(dv.getBigUint64(e - 12, true));
      count = Number(dv.getBigUint64(z + 32, true)); p = Number(dv.getBigUint64(z + 48, true));
    }
    var jobs = [], dec = new TextDecoder();
    for (var i = 0; i < count && dv.getUint32(p, true) === 0x02014b50; i++) {
      var method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true),
          xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), at = dv.getUint32(p + 42, true);
      var key = want(dec.decode(u8.subarray(p + 46, p + 46 + nl)));
      if (key) (function (key, method, size, at) {
        var start = at + 30 + dv.getUint16(at + 26, true) + dv.getUint16(at + 28, true), data = u8.slice(start, start + size);
        jobs.push((method === 0 ? Promise.resolve(data)
          : new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer().then(function (b) { return new Uint8Array(b); }))
          .then(function (bytes) { return [key, bytes]; }));
      })(key, method, size, at);
      p += 46 + nl + xl + cl;
    }
    return Promise.all(jobs).then(function (list) { var o = {}; list.forEach(function (kv) { o[kv[0]] = kv[1]; }); return o; });
  }
  function toDataURL(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return 'data:image/png;base64,' + btoa(s);
  }
  function loadMcFile(file) {
    return file.arrayBuffer().then(function (buf) {
      return unzip(buf, function (name) {
        var m = /^assets\/minecraft\/textures\/block\/([a-z_]+)\.png$/.exec(name);
        return m && MC_NAMES.indexOf(m[1]) >= 0 ? m[1] : null;
      });
    }).then(function (files) {
      var tex = {}, n = 0;
      Object.keys(files).forEach(function (k) { tex[k] = toDataURL(files[k]); n++; });
      if (!n) throw new Error('no block textures in this file: pick the game\'s .jar or a resource pack .zip');
      var data = { tex: tex, from: file.name };
      try { localStorage.setItem(MC_KEY, JSON.stringify(data)); } catch (e) { /* too big to keep: this page still uses them */ }
      window.__mcTextures = data;
      window.dispatchEvent(new Event('mc-textures'));
      return n;
    });
  }
  function clearMc() {
    try { localStorage.removeItem(MC_KEY); } catch (e) { /* nothing kept */ }
    window.__mcTextures = null;
    window.dispatchEvent(new Event('mc-textures'));
  }
  // the Textures button and its panel, beside the theme button on pages with a 3D view
  function texturesUI() {
    var theme = document.getElementById('theme');
    if (!theme || typeof makeScene3D !== 'function' || document.querySelector('.tex-btn')) return;
    var wrap = document.createElement('div'), btn = document.createElement('button'), panel = document.createElement('div');
    wrap.className = 'tex-wrap';
    btn.type = 'button'; btn.className = 'btn ghost sm tex-btn'; btn.textContent = 'Textures'; btn.setAttribute('aria-expanded', 'false');
    panel.className = 'tex-panel'; panel.hidden = true;
    panel.innerHTML = '<p><b>Minecraft textures</b></p><p>Pick your game\'s <span class="mono">.jar</span> (in <span class="mono">.minecraft/versions/</span>) ' +
      'or a resource pack <span class="mono">.zip</span>. The block textures are read on your computer and stay in this browser.</p>' +
      '<label class="btn sm primary">Choose file<input type="file" accept=".jar,.zip" hidden></label> <button type="button" class="btn sm tex-off">Use the drawn ones</button>' +
      '<p class="tex-status" aria-live="polite"></p>';
    wrap.appendChild(btn); wrap.appendChild(panel);
    theme.parentNode.insertBefore(wrap, document.querySelector('.nav-btn') || theme);
    var status = panel.querySelector('.tex-status'), input = panel.querySelector('input');
    function show() { var t = window.__mcTextures; status.textContent = t ? 'In use: ' + Object.keys(t.tex).length + ' textures from ' + t.from + '.' : 'In use: the site\'s own drawn textures.'; btn.classList.toggle('on', !!t); }
    btn.addEventListener('click', function () { panel.hidden = !panel.hidden; btn.setAttribute('aria-expanded', String(!panel.hidden)); show(); });
    document.addEventListener('click', function (e) { if (!panel.hidden && !wrap.contains(e.target)) { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); } });
    input.addEventListener('change', function () {
      var f = input.files && input.files[0];
      if (!f) return;
      status.textContent = 'Reading ' + f.name + '…';
      loadMcFile(f).then(show, function (err) { status.textContent = 'Couldn\'t read it: ' + err.message + '.'; });
      input.value = '';
    });
    panel.querySelector('.tex-off').addEventListener('click', function () { clearMc(); show(); });
    show();
  }
  window.__mcTextures = mcTextures();

  function ready() { sync(); menu(); texturesUI(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();

  return {
    isDark: isDark,
    loadMcFile: loadMcFile, clearMc: clearMc, unzip: unzip,
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
