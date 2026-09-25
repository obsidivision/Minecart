/* home.js — the homepage's live view: random straight tracks, built and run one after another
   with the finder's engine (makeEngine, from engine.js), while the camera turns.
   Each track is picked at random (start, rails, direction, and sometimes a launcher, with or
   without a boat); a track the cart doesn't park on is thrown away before it is shown. When the
   cart parks, the view holds a moment and the next track takes its place. */
(function () {
  'use strict';
  var host = document.getElementById('stage'), now = document.getElementById('now');
  var ro = document.getElementById('readout'), ry = document.getElementById('ry'), graph = document.getElementById('rgraph'), tally = document.getElementById('tally');
  if (!host || typeof makeEngine !== 'function' || typeof makeScene3D !== 'function') return;
  var E = makeEngine(), S = null;
  try { S = makeScene3D(host, { view: { az: 0.9, el: 0.42 } }); } catch (e) { S = null; }
  if (!S) { host.classList.add('none'); return; }
  host.insertBefore(S.canvas, host.firstChild);

  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var SPEED = 1.5, SPIN = still ? 0 : 0.14, HOLD = 1.8;           // ticks x game speed, radians a second, seconds parked
  var FACINGS = ['south', 'north', 'east', 'west'], STARTS = ['S', 'Dr', 'Dp'];
  var TOKENS = E.ALPHABETS.dry.concat(['Fr', 'Fr', 'Ur', 'Dr']);   // plain rails a little more often
  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

  // a random track the cart parks on: {code, facing, origin, opt, r (the run), b (the build)}
  function randomTrack() {
    for (var tries = 0; tries < 400; tries++) {
      var start = pick(STARTS), n = 2 + Math.floor(Math.random() * 8), toks = [start];
      for (var i = 0; i < n; i++) toks.push(pick(TOKENS));
      toks.push('E');
      var code = toks.join(' '), blocks;
      try { blocks = E.parse(code).blocks; } catch (e) { continue; }
      if (E.problems(blocks).length) continue;
      var facing = pick(FACINGS), origin = start === 'S' ? [0, 64, 0] : [0, 65, 0], opt = null;
      if (Math.random() < 0.4) {
        var stoppers = Object.keys(E.STOPPERS);
        opt = { how: 'fly', boat: Math.random() < 0.4, stopper: pick(stoppers), approach: pick(E.APPROACHES) };
      }
      var r = E.run(code, origin, facing, true, 3000, opt);
      if (!r.ok || r.path.length < 8) continue;
      return { code: code, facing: facing, origin: origin, opt: opt, r: r, b: E.build(code, origin, facing, opt) };
    }
    var c = 'Dr Dr Fr Fr Fp Up Fr Fr Ur E', o = [0, 65, 0];
    return { code: c, facing: 'south', origin: o, opt: null, r: E.run(c, o, 'south', true, 3000), b: E.build(c, o, 'south') };
  }

  // the readout: the cart's y as it goes, its height over the run, and a count of tracks seen
  var runs = 0, floats = 0, gy = null;
  function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
  function drawGraph() {
    if (!graph || !gy || !graph.offsetWidth) return;
    var d = window.devicePixelRatio || 1, w = graph.offsetWidth, h = graph.offsetHeight;
    if (graph.width !== Math.round(w * d) || graph.height !== Math.round(h * d)) { graph.width = Math.round(w * d); graph.height = Math.round(h * d); }
    var g = graph.getContext('2d'), n = gy.length - 1, lo = Infinity, hi = -Infinity;
    gy.forEach(function (y) { lo = Math.min(lo, y); hi = Math.max(hi, y); });
    if (hi - lo < 1) { hi = (hi + lo) / 2 + 0.5; lo = hi - 1; }
    function X(i) { return (4 + (w - 8) * i / Math.max(1, n)) * d; }
    function Y(y) { return (6 + (h - 12) * (hi - y) / (hi - lo)) * d; }
    g.clearRect(0, 0, graph.width, graph.height);
    g.lineWidth = 1.5 * d; g.lineJoin = 'round';
    g.strokeStyle = css('--line'); g.beginPath();
    gy.forEach(function (y, i) { g[i ? 'lineTo' : 'moveTo'](X(i), Y(y)); }); g.stroke();
    var upto = Math.min(n, t), k = Math.floor(upto);
    g.strokeStyle = css('--brand-text'); g.beginPath();
    for (var i = 0; i <= k; i++) g[i ? 'lineTo' : 'moveTo'](X(i), Y(gy[i]));
    var yt = k < n ? gy[k] + (gy[k + 1] - gy[k]) * (upto - k) : gy[n];
    g.lineTo(X(upto), Y(yt)); g.stroke();
    g.fillStyle = css('--brand-text'); g.beginPath(); g.arc(X(upto), Y(yt), 3 * d, 0, 7); g.fill();
    return yt;
  }
  function readout(parked) {
    if (!ro || !gy) return;
    var y = drawGraph();
    if (y == null) y = gy[Math.min(gy.length - 1, Math.floor(t))];
    ry.textContent = parked ? cur.r.y.toFixed(10) : y.toFixed(4);
    ro.classList.toggle('fc', !!parked && E.isFloatcart(cur.r.y));
    tally.textContent = runs + (runs === 1 ? ' track' : ' tracks') + ' \u00b7 ' + floats + (floats === 1 ? ' floatcart' : ' floatcarts');
  }
  // keep the readout clear of the plate, whatever the plate's height; drop the line when it would be a sliver
  var plate = document.querySelector('.plate');
  function fitReadout() {
    if (!ro || !plate) return;
    ro.style.bottom = (plate.offsetHeight + 32 + 24) + 'px';
    ro.classList.toggle('flat', graph.offsetHeight < 40);
    readout(cur && t >= run.length - 1);
  }
  if (ro) { ro.hidden = false; window.addEventListener('resize', fitReadout); }

  var built = false, cur = null, run = [], split = 0, mover = null, boat = null, t = 0, hold = 0, shown = -1;
  var glide = null, GLIDE = 1.6, fading = false, FADE = 450;   // ms the view takes to fade out, and back in
  S.canvas.style.transition = 'opacity ' + FADE + 'ms ease';                          // the camera easing from one framing to the next (seconds)
  function ease(x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }
  function show(tr, first) {
    cur = tr; tr.first = !!first;
    var off = [Infinity, Infinity, Infinity];
    tr.b.blocks.forEach(function (q) { off[0] = Math.min(off[0], q.x); off[1] = Math.min(off[1], q.y); off[2] = Math.min(off[2], q.z); });
    function rel(p, dy) { return [p[0] - off[0], p[1] - off[1] + (dy || 0), p[2] - off[2]]; }
    S.clear();
    S.blocks(tr.b.blocks, { offset: off });
    run = tr.r.path.map(function (p) { return rel(p); });
    gy = tr.r.path.map(function (p) { return p[1]; });
    split = 0;                                             // ticks before the cart is on the track (a launch)
    while (split < tr.r.path.length && tr.r.path[split][3] < 0) split++;
    var La = tr.b.launcher;
    boat = La && La.boat ? { b: S.boat(rel(La.boat)), spot: rel(La.boat), pick: tr.r.pickTick || 0 } : null;
    mover = S.cart('sol');
    // frame a circle round the build, so every angle of the turning camera fits it
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    tr.b.blocks.forEach(function (q) {
      var p = rel([q.x, q.y, q.z]);
      for (var k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k] + 1); }
    });
    var cx = (lo[0] + hi[0]) / 2, cz = (lo[2] + hi[2]) / 2, rad = Math.hypot(hi[0] - lo[0], hi[2] - lo[2]) / 2 + 0.5;
    var gr = rad * 2.6;                                     // wide: the fog fades it out toward a horizon
    S.grid([cx - gr, lo[1], cz - gr, cx + gr, hi[1], cz + gr], 0, false);
    for (var a = 0; a < 16; a++) {
      var x = cx + rad * Math.cos(a * Math.PI / 8), z = cz + rad * Math.sin(a * Math.PI / 8);
      S.fitPoint([x, lo[1], z]); S.fitPoint([x, hi[1], z]);
    }
    S.resize();
    var to = S.fitted();
    if (!cur.first && to) glide = { from: S.camera(), to: to, t: 0 };   // glide there, still turning
    else { S.frame(true); glide = null; }
    t = 0; hold = 0; shown = -1; built = false;
    place();
    caption(false);
    readout(false);
    mover.place(null);                                     // the cart appears once its rails are down
    S.rise(function () { built = true; place(); });        // the blocks drop into place, then the cart goes
  }
  function posAt(t) {
    var n = run.length - 1;
    if (t >= n) return run[n];
    var k = Math.ceil(t - 1e-9), f = t - (k - 1), a = run[Math.max(0, k - 1)], b = run[k];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }
  function place() {
    var p = posAt(t), k = Math.min(run.length - 1, Math.floor(t));
    mover.place(p);
    if (boat) boat.b.place(boat.pick && t >= boat.pick ? [p[0], p[1] + 0.1875, p[2]] : boat.spot);
    if (k !== shown) {                                     // the trail so far: the flight, then the track
      shown = k;
      var trail = run.slice(0, k + 1).map(function (q) { return [q[0], q[1] + 0.35, q[2]]; });
      S.path('fly', split ? trail.slice(0, Math.min(trail.length, split + 1)) : null, { key: 'run', xray: true });
      S.path('run', trail.length > split ? trail.slice(split) : null, { key: 'sol', xray: true });
    }
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  // the finder, opened on this track: its layout checked, with its start and direction
  function finderLink() {
    var o = cur.opt, r = cur.r, q = { axis: 'y', mode: 'value', target: (r.y - Math.floor(r.y)).toFixed(10), tol: '0.000005',
      px: 0, py: 64, pz: 0, facing: cur.facing, cart: o && o.boat ? 'boat' : 'empty', how: o ? o.how : 'hand', check: cur.code };
    if (o) { q.stopAll = 'one'; q.stopper = o.stopper; q.approach = o.approach; }
    return 'floatcart-finder.html#' + Object.keys(q).map(function (k) { return k + '=' + encodeURIComponent(q[k]); }).join('&');
  }
  host.style.cursor = 'pointer';
  host.title = 'Open this track in the finder';
  host.addEventListener('click', function () { if (cur) location.href = finderLink(); });
  function caption(parked) {
    if (!now) return;
    var o = cur.opt, r = cur.r, y = r.y - Math.floor(r.y);
    var how = !o ? 'placed by hand' : 'launched' + (o.boat ? ' with a boat' : '');
    now.innerHTML = '<span class="mono">' + esc(cur.code) + '</span><span class="how">' + how + ', running ' + cur.facing + '</span>' +
      (parked ? '<span class="res">parked at y <b class="mono">' + y.toFixed(10) + '</b>' + (E.isFloatcart(r.y) ? ' <span class="badge fc">floatcart</span>' : '') + '</span>'
              : '<span class="res">running…</span>') + '<a class="open" href="' + esc(finderLink()) + '">Open in finder &rarr;</a>';
  }

  var last = 0;
  function frame(ts) {
    var dt = last ? Math.min(0.1, (ts - last) / 1000) : 0;
    last = ts;
    if (SPIN) S.turn(dt * SPIN);
    if (glide) {
      glide.t = Math.min(1, glide.t + dt / GLIDE);
      var k = ease(glide.t), a = glide.from, b = glide.to;
      S.camera({ target: [0, 1, 2].map(function (i) { return a.target[i] + (b.target[i] - a.target[i]) * k; }),
                 r: a.r + (b.r - a.r) * k, el: a.el + (b.el - a.el) * k });
      if (glide.t >= 1) glide = null;
    }
    var n = run.length - 1;
    if (t < n && built) {
      var t0 = t;
      t = Math.min(n, t + dt * 20 * SPEED);
      place();
      readout(false);
      var land = cur.r.landTick;
      if (land && t0 < land && t >= land) S.burst(posAt(land), { n: 10, col: '#9a9383', speed: 1.2, up: 1.2, life: 0.6, size: 0.06 });   // dust as it lands
      if (t >= n) {
        runs++; if (E.isFloatcart(cur.r.y)) floats++;
        caption(true); readout(true);
        var p = posAt(n);
        S.burst([p[0], p[1] + 0.1, p[2]], { n: 8, col: '#9a9383', speed: 0.8, up: 1, life: 0.5, size: 0.05 });
        if (E.isFloatcart(cur.r.y)) S.burst([p[0], p[1] + 0.5, p[2]], { n: 26, col: '#e8c030', speed: 2, up: 3.2, life: 1.2, size: 0.07, grav: 5 });   // a floatcart: gold
      }
    } else if ((hold += dt) >= HOLD && !fading) {            // fade out, swap in the next track, fade back in
      fading = true;
      S.canvas.style.opacity = '0';
      setTimeout(function () {
        show(randomTrack());
        S.canvas.style.opacity = '1';
        fading = false;
      }, FADE);
    }
    requestAnimationFrame(frame);
  }
  show(randomTrack(), true);
  fitReadout();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitReadout);
  requestAnimationFrame(frame);
})();
