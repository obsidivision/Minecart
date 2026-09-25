/* viewer3d.js — the finder's 3D view of one track (makeViewer3D), on scene3d.js. */

/* The 3D view of one track, on scene3d.js (the renderer the two 3D pages use).
   makeViewer3D() builds one view that is moved into whichever result is open; load() shows
   the blocks E.build() gives, the run as a line, the cart where it parks, and an outline where
   it lands once its parking rail is broken. Its play button runs the cart through the run tick
   by tick, at the game's 20 ticks a second (and the drop, for an x or z target). A launched cart
   plays from where it is placed on the launcher, through its flight; a boat it picks up on the
   way rides along from then on. For a cart that is launched or loaded it also numbers the steps:
   where to place the cart, the boat, the cart stopped against the stopper, and for the loading
   run the glass to break and the drop onto the start rail. */
function makeViewer3D() {
  var HW = 0.49000000953674316, HH = 0.699999988079071;        // the minecart's hitbox
  var ICONS = '<svg class="i-play" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.6v10.8L13.2 8z" fill="currentColor"/></svg>' +
    '<svg class="i-pause" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.8h3v10.4H4zM9 2.8h3v10.4H9z" fill="currentColor"/></svg>';
  var el = document.createElement('div');
  el.className = 'gl3d';
  el.innerHTML = '<div class="gl-labels" aria-hidden="true"></div><div class="gl-bar">' +
    '<div class="gl-play"><button type="button" class="btn primary sm icon play" aria-label="Play the run" title="Play the run">' + ICONS + '</button>' +
    '<div class="scrub"><input type="range" min="0" max="0" step="1" value="0" aria-label="Game tick"></div>' +
    '<span class="tickread" aria-label="Tick"><b>0</b> / <span>0</span></span></div>' +
    '<span class="gl-hint">Drag to turn · scroll to zoom</span>' +
    '<button type="button" class="btn sm glass-btn gl-reset">Reset view</button></div>';
  var S = null;
  try { S = makeScene3D(el, { keep: true, labels: el.querySelector('.gl-labels'), view: { az: 1.12, el: 0.34 }, pad: { bottom: 44 } }); } catch (e) { S = null; }
  if (!S) {
    el.innerHTML = '<div class="gl-none">3D view unavailable: WebGL didn\'t start in this browser.</div>';
    return { el: el, ok: false, load: function () {}, snapshot: function () { return null; } };
  }
  el.insertBefore(S.canvas, el.firstChild);
  S.canvas.tabIndex = 0;
  S.canvas.setAttribute('aria-label', '3D view of the track. Drag to turn, scroll to zoom.');
  el.querySelector('.gl-reset').addEventListener('click', function (e) { e.stopPropagation(); S.reset(); });

  /* ---------- playback: run holds the cart's position at every tick, in scene coordinates ---------- */
  var ui = { bar: el.querySelector('.gl-play'), play: el.querySelector('.gl-play .play'), tick: el.querySelector('.gl-play input'),
             num: el.querySelector('.gl-play .tickread b'), max: el.querySelector('.gl-play .tickread span') };
  var run = [], mover = null, boat = null, st = { t: 0, playing: false, played: false }, raf = 0, last = 0, floats = false;
  // the run played to its end: a little dust where the cart stops, and a gold burst for a floatcart
  function landed() {
    var p = run[tmax()];
    if (!p || !S.burst) return;
    S.burst([p[0], p[1] + 0.1, p[2]], { n: 8, col: '#9a9383', speed: 0.8, up: 1, life: 0.5, size: 0.05 });
    if (floats) S.burst([p[0], p[1] + 0.5, p[2]], { n: 26, col: '#e8c030', speed: 2, up: 3.2, life: 1.2, size: 0.07, grav: 5 });
  }
  function tmax() { return Math.max(0, run.length - 1); }
  function posAt(t) {                                          // between ticks, a straight line
    var n = tmax();
    if (t <= 0 || !n) return run[0];
    if (t >= n) return run[n];
    var k = Math.ceil(t - 1e-9), f = t - (k - 1), a = run[k - 1], b = run[k];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }
  function show() {
    var k = Math.max(0, Math.ceil(st.t - 1e-9));
    ui.tick.value = k;
    ui.tick.style.setProperty('--p', (tmax() ? 100 * k / tmax() : 0) + '%');
    ui.num.textContent = k;
    if (!mover || !run.length) return;
    var p = posAt(st.t);
    mover.place(p);
    if (boat) boat.b.place(boat.pick && st.t >= boat.pick ? [p[0], p[1] + 0.1875, p[2]] : boat.spot);   // carried once picked up
  }
  function label() {
    var text = st.playing ? 'Pause' : st.played && st.t >= tmax() ? 'Play the run again' : 'Play the run';
    ui.play.classList.toggle('playing', st.playing);
    ui.play.setAttribute('aria-label', text);
    ui.play.title = text;
  }
  function frame(now) {
    raf = 0;
    var dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (!st.playing) return;
    st.t = Math.min(tmax(), st.t + dt * 20);
    if (st.t >= tmax()) { st.playing = false; st.played = true; label(); landed(); }
    show();
    if (st.playing) raf = requestAnimationFrame(frame);
  }
  function setPlaying(p) {
    if (p && st.t >= tmax()) st.t = 0;
    st.playing = !!p && tmax() > 0;
    label();
    if (st.playing && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }
  ui.play.addEventListener('click', function (e) { e.stopPropagation(); setPlaying(!st.playing); show(); });
  ui.tick.addEventListener('input', function () { st.t = +ui.tick.value; setPlaying(false); show(); });
  ui.bar.addEventListener('click', function (e) { e.stopPropagation(); });

  return {
    el: el,
    ok: true,
    // d: blocks and positions in world coordinates, drawn relative to the blocks' lowest corner
    // (32-bit floats): cart (where it parks), path (the run, one position per tick: [x, y, z, rail],
    // rail -1 before the cart is on the track), drop and dropPath (x / z targets: where it lands
    // once the parking rail is broken, and its y on the way down); for a loading run loader and
    // landing, for a launcher launcher; boat, where a boat waits, and boatPick, the tick the cart
    // takes it aboard (0: it stays there)
    load: function (d) {
      setPlaying(false);
      floats = !!(d.cart && (function (top) { var b = Math.floor(top); return top > b && top - 0.000009999999747378752 < b; })(d.cart[1] + HH));
      var off = [Infinity, Infinity, Infinity];
      d.blocks.forEach(function (b) { off[0] = Math.min(off[0], b.x); off[1] = Math.min(off[1], b.y); off[2] = Math.min(off[2], b.z); });
      function rel(p, dy) { return [p[0] - off[0], p[1] - off[1] + (dy || 0), p[2] - off[2]]; }
      function mid(b, dy) { return rel([b[0] + 0.5, b[1] + (dy || 0), b[2] + 0.5]); }
      S.clear();
      S.blocks(d.blocks, { offset: off });
      boat = null;
      if (d.boat) {
        var bp = rel(d.boat);
        boat = { b: S.boat(bp), spot: bp, pick: d.boatPick || 0 };
        if (boat.pick) S.outline([bp[0] - 0.6875, bp[1], bp[2] - 0.6875], [1.375, 0.5625, 1.375], 'run', 0.6);   // where it waits
      }
      var labels = [], n = 1;
      if (d.loader) {
        var L = d.loader;
        S.path('load', L.path.map(function (p) { return rel(p, 0.35); }), { key: 'run', xray: true });
        S.path('drop', [rel(L.stopAt, 0.35), rel(d.landing, 0.35)], { key: 'run', xray: true });
        S.cart('run', { alpha: 0.25, line: 0.8 }).place(rel(L.stopAt));
        var g = rel(L.breakGlass);
        S.outline([g[0] - 0.03, g[1] - 0.03, g[2] - 0.03], [1.06, 1.06, 1.06], 'focus', 0.95);
        labels.push({ p: mid(L.start, 1.2), t: '1 Place the cart' }, { p: rel(L.boat, 0.9), t: '2 Boat' },
                    { p: rel(L.stopAt, 1.05), t: '3 Stops here' }, { p: mid(L.breakGlass, 0.5), t: '4 Break: it drops', cls: 'below' });
        n = 5;
      }
      if (d.launcher) {
        var La = d.launcher;
        S.cart('run', { alpha: 0.25, line: 0.8 }).place(rel(La.stopAt));
        labels.push({ p: mid(La.start, 1.2), t: n++ + ' Place the cart' });
        if (d.boat) labels.push({ p: rel(d.boat, 0.9), t: n++ + ' Boat' });
        labels.push({ p: rel(La.stopAt, -0.05), t: n++ + ' Stops here', cls: 'below' });   // below: the placing spot is right above
      }
      if (d.path) {
        var fly = [], on = [];                                   // launched: the flight in the loading colour
        d.path.forEach(function (p) { (d.launcher && p[3] < 0 ? fly : on).push(rel(p, 0.35)); });
        if (fly.length) S.path('load', on.length ? fly.concat([on[0]]) : fly, { key: 'run', xray: true });
        S.path('run', on, { key: 'sol', xray: true });
      }
      run = (d.path || []).map(function (p) { return rel(p); });
      if (d.cart && d.dropPath) d.dropPath.forEach(function (y) { run.push(rel([d.cart[0], y, d.cart[2]])); });
      if (!run.length && d.cart) run = [rel(d.cart)];
      mover = null;
      if (d.cart) {
        var p = rel(d.cart);
        mover = S.cart('sol').place(p).fit();
        if (n > 1) labels.push({ p: [p[0], p[1] + 1.0, p[2]], t: n + ' Parks here' });
        if (d.drop !== null && d.drop !== undefined && d.drop !== d.cart[1]) {
          S.outline([p[0] - HW, d.drop - off[1], p[2] - HW], [2 * HW, HH, 2 * HW], 'sol', 0.75);
        }
      }
      S.labels(labels);
      S.grid(null, 1, true);
      S.resize();
      S.frame(true);
      ui.bar.hidden = tmax() === 0;
      ui.tick.max = tmax(); ui.max.textContent = tmax();
      st.t = tmax(); st.played = false; show(); label();      // it opens where the cart ends up
    },
    snapshot: S.snapshot,
    // draw again, after the page has moved the view into another box
    redraw: S.request,
    // for the page checks: the camera the fit chose and what it was fitted to
    debug: S.debug
  };
}
