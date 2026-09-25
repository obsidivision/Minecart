/* player.js — playback and the inspector shared by the challenge and makers pages.

   makePlayer({ D, run, scene, cart, rulesPage, onTick })
     D        the page data: phases, phaseRules, ruleNames, window
     run()    the run on show: { y, z, vz, ph, yfrac, ... } one entry per tick
     scene    the makeScene3D() object, or null without WebGL
     cart     the scene's cart that follows the run
     onTick   called with (tick, run) whenever the shown tick changes

   The transport (#play #back #fwd #speed #tick), the readouts (#tickNum #tickMax #phase
   #phaseRules #vY #vZ #vV) and the result (#fin #verdict #meter) are found by id. */
function makePlayer(cfg) {
  'use strict';
  var D = cfg.D, S = cfg.scene;
  function $(id) { return document.getElementById(id); }
  var ui = {
    play: $('play'), back: $('back'), fwd: $('fwd'), speed: $('speed'), tick: $('tick'), marks: $('marks'),
    tickNum: $('tickNum'), tickMax: $('tickMax'), phase: $('phase'), phaseRules: $('phaseRules'),
    vY: $('vY'), vZ: $('vZ'), vV: $('vV'), fin: $('fin'), verdict: $('verdict'), meter: $('meter')
  };
  var st = { t: 0, playing: false, speed: +ui.speed.value || 0.5, follow: false };
  function R() { return cfg.run(); }
  function tmax() { return R().y.length - 1; }
  function curTick() { return Math.max(0, Math.ceil(st.t - 1e-9)); }

  // where the cart is between ticks; the honey rail-snap is a jump, not a slide
  function cartAt(t) {
    var r = R(), n = r.y.length - 1;
    if (t <= 0) return [2.5, r.y[0], r.z[0]];
    if (t >= n) return [2.5, r.y[n], r.z[n]];
    var k = Math.ceil(t - 1e-9), f = t - (k - 1), a = k - 1;
    if (Math.abs(r.y[k] - r.y[a]) > 0.6 && Math.abs(r.z[k] - r.z[a]) < 0.1) f = f < 0.5 ? 0 : 1;
    return [2.5, r.y[a] + (r.y[k] - r.y[a]) * f, r.z[a] + (r.z[k] - r.z[a]) * f];
  }

  /* the final fraction against the floatcart window: 0.299995 to 0.300015 across the meter */
  var GLO = 0.299995, GHI = 0.300015;
  function gpos(v) { return (v - GLO) / (GHI - GLO) * 100; }
  function result() {
    var r = R(), lo = D.window[0], hi = D.window[1], m = ui.meter;
    ui.fin.textContent = r.yfrac.toFixed(10);
    var band = m.querySelector('.meter-win'), mk = m.querySelector('.meter-mk'), off = m.querySelector('.meter-off');
    band.style.left = gpos(lo) + '%'; band.style.width = (gpos(hi) - gpos(lo)) + '%';
    var sc = m.querySelectorAll('.meter-scale span');
    sc[0].style.left = gpos(lo) + '%'; sc[0].textContent = lo.toFixed(8);
    sc[1].style.left = gpos(hi) + '%'; sc[1].textContent = hi.toFixed(8);
    var inside = r.yfrac > lo && r.yfrac < hi, onScale = r.yfrac >= GLO && r.yfrac <= GHI;
    m.classList.toggle('offscale', !onScale);
    mk.hidden = !onScale; off.hidden = onScale;
    if (onScale) mk.style.left = gpos(r.yfrac) + '%';
    else off.textContent = (r.yfrac < GLO ? '◂ ' : '') + r.yfrac.toFixed(5) + (r.yfrac > GHI ? ' ▸' : '');
    if (inside) {
      ui.verdict.className = 'verdict good';
      ui.verdict.textContent = 'Floatcart, inside the window by ' + FC.small(Math.min(r.yfrac - lo, hi - r.yfrac));
    } else {
      ui.verdict.className = 'verdict bad';
      ui.verdict.textContent = r.yfrac < lo ? 'Misses: ' + (lo - r.yfrac).toFixed(5) + ' below the window'
        : 'Misses: ' + (r.yfrac - hi).toFixed(5) + ' above the window';
    }
  }

  var shown = -1;
  function refresh(force) {
    var k = curTick(), r = R();
    if (force || k !== shown) {
      shown = k;
      ui.tick.value = k;
      ui.tick.style.setProperty('--p', (tmax() ? 100 * k / tmax() : 0) + '%');
      ui.tickNum.textContent = k;
      ui.phase.textContent = D.phases[r.ph[k]];
      ui.phaseRules.innerHTML = '<span>Rules</span>' + (D.phaseRules[r.ph[k]] || []).map(function (id) {
        return '<a class="rchip" href="' + cfg.rulesPage + '#' + id + '"><b>' + id + '</b>' + FC.esc(D.ruleNames[id] || '') + '</a>';
      }).join('');
      ui.vY.textContent = String(r.y[k]);
      ui.vZ.textContent = String(r.z[k]);
      ui.vV.textContent = (r.vz[k] >= 0 ? '+' : '') + r.vz[k].toFixed(5) + ' blocks/tick';
      if (cfg.onTick) cfg.onTick(k, r);
    }
    if (S) {
      var p = cartAt(st.t);
      cfg.cart.place(p);
      if (st.follow) S.follow([p[0], p[1] + 0.35, p[2]]);
    }
  }
  function label() {
    var end = st.t >= tmax();
    ui.play.classList.toggle('playing', st.playing);
    ui.play.setAttribute('aria-label', st.playing ? 'Pause' : end ? 'Replay' : 'Play');
    ui.play.title = st.playing ? 'Pause (space)' : end ? 'Replay (space)' : 'Play (space)';
  }
  // the run played to its end: dust where the cart stops; inside the window, a gold burst and the meter flashes
  function landed() {
    var r = R(), inside = r.yfrac > D.window[0] && r.yfrac < D.window[1], p = cartAt(tmax());
    if (S && S.burst) {
      S.burst([p[0], p[1] + 0.1, p[2]], { n: 8, col: '#9a9383', speed: 0.8, up: 1, life: 0.5, size: 0.05 });
      if (inside) S.burst([p[0], p[1] + 0.5, p[2]], { n: 26, col: '#e8c030', speed: 2, up: 3.2, life: 1.2, size: 0.07, grav: 5 });
    }
    ui.meter.classList.remove('hit'); void ui.meter.offsetWidth; if (inside) ui.meter.classList.add('hit');
  }
  var raf = 0, last = 0;
  function frame(now) {
    raf = 0;
    var dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (!st.playing) return;
    st.t += dt * 20 * st.speed;
    if (st.t >= tmax()) { st.t = tmax(); st.playing = false; label(); landed(); }
    refresh(false);
    if (st.playing) raf = requestAnimationFrame(frame);
  }
  function setPlaying(p) {
    if (p && st.t >= tmax()) st.t = 0;
    st.playing = p; label();
    if (p && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }
  function step(d) { st.t = Math.max(0, Math.min(tmax(), curTick() + d)); setPlaying(false); refresh(true); }

  ui.play.addEventListener('click', function () { setPlaying(!st.playing); });
  ui.back.addEventListener('click', function () { step(-1); });
  ui.fwd.addEventListener('click', function () { step(1); });
  ui.speed.addEventListener('change', function () { st.speed = parseFloat(ui.speed.value); });
  ui.tick.addEventListener('input', function () { st.t = parseInt(ui.tick.value, 10); setPlaying(false); refresh(true); });
  [['tPaths', 'paths'], ['tDots', 'dots'], ['tLabels', 'labels']].forEach(function (p) {
    var el = $(p[0]);
    el.addEventListener('change', function () { var o = {}; o[p[1]] = el.checked; if (S) S.show(o); });
  });
  $('tFollow').addEventListener('change', function () {
    st.follow = this.checked;
    if (!S) return;
    if (st.follow) refresh(true); else S.follow(null);
  });
  document.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName) || '';
    if (/INPUT|SELECT|TEXTAREA/.test(tag) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === ' ' && tag !== 'BUTTON') { e.preventDefault(); setPlaying(!st.playing); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  });

  return {
    // a new run is on show: from tick 0, or from the same tick (keep) to compare runs
    load: function (marks, keep) {
      st.t = keep ? Math.min(curTick(), tmax()) : 0; setPlaying(false);
      ui.tick.max = tmax(); ui.tickMax.textContent = tmax();
      ui.marks.innerHTML = (marks || []).map(function (t) { return '<i style="left:' + (t / tmax() * 100) + '%" title="lever off"></i>'; }).join('');
      result();
      shown = -1; refresh(true); label();
    },
    refresh: refresh,
    state: st
  };
}
