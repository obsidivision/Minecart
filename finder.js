/* finder.js — the alignment finder page (floatcart-finder.html), created by 07km: the settings,
   the search in Web Workers, the results, the details, the downloads and the checks. Loads after
   site.js, scene3d.js, engine.js, litematic.js, tester.js and viewer3d.js. Plain JavaScript,
   no build step, nothing fetched at run time. */

(function () {
  'use strict';
  var E = makeEngine(), LW = makeLitematicWriter(), TS = makeTester(E, LW);
  function $(id) { return document.getElementById(id); }
  function each(sel, fn) { Array.prototype.forEach.call(document.querySelectorAll(sel), fn); }

  /* the theme button is site.js's; the 3D view follows the theme by itself (scene3d.js) */

  /* ---------- search sizes (tracks tried at 0 64 0 facing south, counted in advance) ---------- */
  var SIZES = [
    { name: 'Quick', dry: 6, plain: 12 },
    { name: 'Normal', dry: 7, plain: 14 },
    { name: 'Deep', dry: 8, plain: 16 },
    { name: 'Deeper', dry: 9, plain: 18 },
    { name: 'Max', dry: 10, plain: 20 }
  ];
  // Per start: empty, a cart placed by hand (launched, it tries about as many: 0.95 to 0.99 of
  // these on average); boat, the average over a boat cart's 16 starts, which keeps its speed and
  // so runs far down more of the plain tracks (counted to 9 and 18 rails after the start; the
  // largest size is scaled on from how that ratio grows: 1.10 and 12.2 times the empty cart's).
  var TOTALS = {
    empty: {"dry":{"6":102025,"7":533263,"8":2791725,"9":14651124,"10":76907893},"plain":{"12":37651,"14":177261,"16":841403,"18":4017049,"20":19267385}},
    boat: {"dry":{"6":105399,"7":556863,"8":2952390,"9":15805817,"10":84600000},"plain":{"12":144662,"14":905239,"16":5726362,"18":36550953,"20":235000000}} };
  var RATE = { empty: { dry: 900000, plain: 400000 }, boat: { dry: 950000, plain: 700000 } };   // rough tracks per second per core, for the estimate
  var CORES = Math.max(1, Math.min(16, navigator.hardwareConcurrency || 4));
  var WINDOW = ['0.3000000120', '0.3000100119'];   // floatcart window as y fractions, rounded inwards

  function jobsFor(rails, size) {
    var s = SIZES[size], jobs = [];
    if (rails === 'any') jobs.push({ alphabet: 'dry', starts: ['S', 'Dr', 'Dp'], depth: s.dry, split: s.dry >= 9 ? 3 : 2, minMid: 0 });
    // with any rails, the long plain tracks only add what the first search can't reach
    jobs.push({ alphabet: 'plain', starts: ['Dr'], depth: s.plain, split: s.plain >= 18 ? 4 : 3, minMid: rails === 'any' ? s.dry + 1 : 0 });
    return jobs;
  }
  function fmtCount(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(1) + ' billion';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + ' million';
    if (n >= 1e4) return Math.round(n / 1e3) + ' thousand';
    return String(n);
  }
  function fmtTime(s) {
    if (s < 1.5) return 'about a second';
    if (s < 60) return 'about ' + Math.round(s) + ' seconds';
    if (s < 3600) return 'about ' + Math.round(s / 60) + ' minute' + (Math.round(s / 60) === 1 ? '' : 's');
    return 'about ' + (s / 3600).toFixed(1) + ' hours';
  }
  function choice(name) { return document.querySelector('input[name="' + name + '"]:checked').value; }
  function sizeHint() {
    var rails = choice('rails'), size = +choice('size'), s = SIZES[size], n = 0, secs = 0, vs = startVariants(startSettings());
    var kind = vs[0].boat ? 'boat' : 'empty';
    jobsFor(rails, size).forEach(function (j) { var t = TOTALS[kind][j.alphabet][j.depth]; n += t; secs += t / RATE[kind][j.alphabet]; });
    n *= vs.length; secs *= vs.length;
    var blocked = workerMode === 'none', cores = blocked ? 1 : CORES;
    secs /= cores;
    var len = rails === 'any'
      ? 'Tracks up to ' + (s.dry + 2) + ' rails, or ' + (s.plain + 2) + ' without redstone.'
      : 'Tracks up to ' + (s.plain + 2) + ' rails, no redstone.';
    $('sizeHint').textContent = len + ' About ' + fmtCount(n) + ' tracks' + (vs.length > 1 ? ' (' + vs.length + ' starts)' : '') + ', ' + fmtTime(secs) + ' on ' + cores + ' core' + (cores === 1 ? '' : 's') + '.' +
      (blocked ? ' Your browser blocks background workers here, so it runs on one core. Opened from a website it may use all ' + CORES + '.' : '');
  }
  each('input[name="rails"], input[name="size"]', function (el) { el.addEventListener('change', sizeHint); });

  /* ---------- how the cart starts ----------
     Placed by hand on the start rail, or stopped dead against a stopper first, so that it comes
     to rest on the start rail at a fraction the stopper sets (E.boatFrac): launched off a
     powered slope into a stopper in mid-air, which leaves nothing to break (FarCoolHat's
     stopper), or, with a boat, run down a loading run and dropped by breaking the glass under
     it. A cart with a boat can't be placed by hand: it has to pick the boat up while it rolls.
     Every stopper, met from either side, is a start of its own, and each start is searched in
     full: "every one" tries them all in one search. */
  var STOP_WORD = { block: 'block', honey: 'honey block', bud_side: 'side of the bud', small_side: 'side of the small bud',
                    small_tip: 'tip of the small bud', medium_tip: 'tip of the medium bud', large_tip: 'tip of the large bud',
                    cluster_tip: 'tip of the cluster' };
  var STOP_NAME = { block: 'block', honey: 'honey block', bud_side: 'side of the medium bud (large or cluster works too)',
                    small_side: 'side of the small bud', small_tip: 'tip of the small bud', medium_tip: 'tip of the medium bud',
                    large_tip: 'tip of the large bud', cluster_tip: 'tip of the cluster' };
  var STOP_SHORT = { block: 'block', honey: 'honey block', bud_side: 'bud, side on', small_side: 'small bud, side on',
                     small_tip: 'small bud tip', medium_tip: 'medium bud tip', large_tip: 'large bud tip', cluster_tip: 'cluster tip' };
  function startSettings() {
    var all = choice('stopAll') === 'all';
    return { boat: choice('cart') === 'boat', how: $('how').value, stopper: all ? 'all' : $('stopper').value, approach: all ? 'all' : $('approach').value };
  }
  // The starts a search tries, {how, boat, stopper, approach, rank}: rank orders them in the list
  function startVariants(ss) {
    var out = [], hows = ss.how === 'both' ? ['hand', 'fly'] : [ss.how];
    var stoppers = ss.stopper === 'all' ? Object.keys(E.STOPPERS) : [ss.stopper];
    var sides = ss.approach === 'all' ? E.APPROACHES : [ss.approach];
    hows.forEach(function (how) {
      if (how === 'hand') { out.push({ how: 'hand', boat: false, stopper: null, approach: null }); return; }
      stoppers.forEach(function (sp) {
        sides.forEach(function (ap) { out.push({ how: how, boat: ss.boat, stopper: sp, approach: ap }); });
      });
    });
    out.forEach(function (v, i) { v.rank = i; });
    return out;
  }
  function vKey(v) { return v.how === 'hand' ? 'hand' : [v.how, v.boat ? 'boat' : 'empty', v.stopper, v.approach].join('-'); }
  // what the engine needs to know about a start (null: an empty cart placed by hand)
  function optsFor(v) { return v.how === 'hand' ? null : { how: v.how, boat: v.boat, stopper: v.stopper, approach: v.approach }; }
  function startWords(v) {
    if (v.how === 'hand') return 'Placed by hand';
    return (v.how === 'fly' ? 'Launched' : 'Loading run') + ': ' + STOP_SHORT[v.stopper] + ', from ' + (v.approach === 'front' ? 'in front' : 'behind');
  }
  // each kind of cart keeps its own start choice: placed by hand for an empty cart, launched with a boat
  var howFor = { empty: 'hand', boat: 'fly' }, howKind = 'empty';
  function startPhrase(v) {
    var side = ' from ' + (v.approach === 'front' ? 'in front' : 'behind');
    return v.how === 'fly' ? ', launched into the ' + STOP_WORD[v.stopper] + side
      : ', loading run into the ' + STOP_WORD[v.stopper] + side;
  }
  function syncCart() {
    var ss = startSettings(), sel = $('how'), kind = ss.boat ? 'boat' : 'empty';
    Array.prototype.forEach.call(sel.options, function (o) {
      o.disabled = ss.boat ? o.value === 'hand' || o.value === 'both' : o.value === 'loader';
      o.hidden = o.disabled;
    });
    if (kind !== howKind) { howFor[howKind] = ss.how; howKind = kind; sel.value = howFor[kind]; }
    if (sel.options[sel.selectedIndex].disabled) sel.value = ss.boat ? 'fly' : 'hand';
    ss = startSettings();
    $('stopBox').hidden = ss.how === 'hand';
    $('stopPick').hidden = ss.stopper === 'all';
    var vs = startVariants(ss), one = vs.length === 1 && vs[0].how !== 'hand' ? vs[0] : null;
    var how = ss.how === 'hand' ? 'Place the cart on the start rail.'
      : ss.how === 'both' ? 'Placed by hand, or launched into a stopper.'
      : ss.how === 'fly' ? (ss.boat ? 'You can\'t place a cart with a boat in it, so it comes with a launcher. Nothing to break.' : 'Comes with a launcher. Nothing to break.')
      : 'Comes with a loading run. Break one glass block to drop the cart.';
    $('cartHint').textContent = how + (one ? ' Starts at ' + E.boatFrac(one.stopper, $('facing').value, one.approach).toFixed(10) + '.'
      : vs.length > 1 ? ' ' + vs.length + ' starts.' : '');
    sizeHint();
  }
  each('input[name="cart"], input[name="stopAll"]', function (el) { el.addEventListener('change', syncCart); });
  ['how', 'stopper', 'approach'].forEach(function (id) { $(id).addEventListener('change', syncCart); });

  /* ---------- reading the settings ---------- */
  function num(s) {
    s = String(s).trim().replace(',', '.');
    if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return NaN;
    return Number(s);
  }
  function frac(v) { return v - Math.floor(v); }
  function intIn(el, lo, hi) {
    var v = num(el.value);
    var ok = isFinite(v) && Math.floor(v) === v && v >= lo && v <= hi;
    el.classList.toggle('bad', !ok);
    return ok ? v : null;
  }
  // What to aim for: y on the rail, or x / z after breaking the parking rail. x needs a
  // track running east or west, z one running north or south.
  function syncAxis() {
    var axis = choice('axis'), sel = $('facing');
    Array.prototype.forEach.call(sel.options, function (o) {
      var along = o.value === 'east' || o.value === 'west' ? 'x' : 'z';
      o.disabled = axis !== 'y' && along !== axis;
    });
    if (sel.options[sel.selectedIndex].disabled) sel.value = axis === 'x' ? 'east' : 'south';
    $('axisHint').textContent = axis === 'y'
      ? 'Height on the parking slope. Floatcart: 0.3000000120 to 0.3000100119.'
      : 'Break the parking rail after it stops. Track must run ' + (axis === 'x' ? 'east or west' : 'north or south') + '.';
    readPos();
    readTarget();
    syncCart();
  }
  function syncMode() {
    var range = choice('mode') === 'range';
    $('valueBox').hidden = range;
    $('rangeBox').hidden = !range;
    readTarget();
  }
  // The target as a range [lo, hi] of fractions (wrapping past 1 when lo > hi), its middle
  // and half-width w. "One value" is the range value +- tolerance.
  function readTarget() {
    var hint = $('targetHint'), axis = choice('axis');
    ['target', 'tol', 'lo', 'hi'].forEach(function (id) { $(id).classList.remove('bad'); });
    hint.classList.remove('err');
    function bad(id, msg) { $(id).classList.add('bad'); hint.classList.add('err'); hint.textContent = msg; return null; }
    if (choice('mode') === 'value') {
      var v = num($('target').value), tol = num($('tol').value);
      if (!isFinite(v)) return bad('target', 'Enter a number, like 0.3 or 64.3000050119.');
      if (!(isFinite(tol) && tol >= 0 && tol < 0.5)) return bad('tol', 'The ± value must be between 0 and 0.5.');
      var c = frac(v);
      hint.textContent = (v !== c ? 'Using ' + c.toFixed(10) + '. ' : '') + 'Within ±' + tol + ' counts.';
      return { mode: 'value', target: c, lo: frac(c - tol), hi: frac(c + tol), w: tol };
    }
    var a = num($('lo').value), b = num($('hi').value);
    if (!isFinite(a)) return bad('lo', 'Enter a number, like 0.3.');
    if (!isFinite(b)) return bad('hi', 'Enter a number, like 0.31.');
    if (Math.abs(b - a) >= 1) return bad('hi', 'The range has to be under one block.');
    var lo = frac(a), hi = frac(b), w = lo <= hi ? (hi - lo) / 2 : (hi + 1 - lo) / 2;
    hint.textContent = (lo <= hi
      ? 'Matches from ' + lo.toFixed(10) + ' to ' + hi.toFixed(10) + '.'
      : 'Matches from ' + lo.toFixed(10) + ' to 1, and 0 to ' + hi.toFixed(10) + '.');
    return { mode: 'range', target: frac(lo + w), lo: lo, hi: hi, w: w };
  }
  function readPos() {
    var x = intIn($('px'), -29999984, 29999984), y = intIn($('py'), -64, 318), z = intIn($('pz'), -29999984, 29999984);
    var facing = $('facing').value, ok = x !== null && y !== null && z !== null;
    $('posHint').classList.toggle('err', !ok);
    $('posHint').textContent = ok
      ? 'The start rail. Moving it changes the last few digits.'
      : 'X and Z must be whole numbers inside the world border, and Y a whole number from -64 to 318.';
    if (!ok) { $('posBox').open = true; return null; }
    $('posSum').textContent = x + ' ' + y + ' ' + z + ', track running ' + facing;
    return { p: [x, y, z], facing: facing };
  }
  function readAll() {
    var tg = readTarget(), pos = readPos();
    if (!tg || !pos) return null;
    var ss = startSettings();
    return { axis: choice('axis'), mode: tg.mode, target: tg.target, lo: tg.lo, hi: tg.hi, w: tg.w,
             pos: pos.p, facing: pos.facing, rails: choice('rails'), size: +choice('size'), keep: +$('keep').value,
             sort: $('sort').value, boat: ss.boat, how: ss.how, stopper: ss.stopper, approach: ss.approach, starts: startVariants(ss) };
  }
  each('input[name="axis"]', function (el) { el.addEventListener('change', syncAxis); });
  each('input[name="mode"]', function (el) { el.addEventListener('change', syncMode); });
  ['px', 'py', 'pz', 'facing'].forEach(function (id) { $(id).addEventListener('change', function () { readPos(); syncAxis(); }); });
  ['target', 'tol', 'lo', 'hi'].forEach(function (id) { $(id).addEventListener('change', readTarget); });
  $('presetFloat').addEventListener('click', function () {
    document.querySelector('input[name="axis"][value="y"]').checked = true;
    document.querySelector('input[name="mode"][value="range"]').checked = true;
    $('lo').value = WINDOW[0]; $('hi').value = WINDOW[1];
    syncAxis(); syncMode();
  });

  // The engine's origin is the level a track is entered at: a flat start rail sits on it,
  // a slope start one block below. Users give the block of the start rail.
  function originFor(start, p) { return start === 'S' ? [p[0], p[1], p[2]] : [p[0], p[1] + 1, p[2]]; }
  function startOf(code) { return String(code).trim().split(/\s+/)[0]; }
  function axisValue(r, axis) { return axis === 'x' ? r.x : axis === 'z' ? r.z : r.y; }

  /* ---------- formatting ---------- */
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmtFrac(v) { return frac(v).toFixed(10); }
  /* A distance as an ordinary decimal, never 3.5e-6: small ones keep two digits that matter. */
  function fmtDist(d) {
    if (d === 0) return '0';
    var a = Math.abs(d), s = d < 0 ? '−' : '';
    if (a < 1e-3) {
      var t = a.toFixed(Math.min(14, 1 - Math.floor(Math.log10(a))));
      return s + t.replace(/0+$/, '').replace(/\.$/, '');
    }
    return s + a.toFixed(4);
  }
  function fmtInt(n) { return n.toLocaleString('en-US'); }
  function tokensHTML(code) {
    var t = code.split(' ');
    return '<span class="code" aria-label="' + esc(code) + '">' + t.map(function (x, i) {
      var cls = x === 'E' ? 'e' : x === 'S' || x[1] === 'p' ? 'p' : x[1] === 'h' ? 'h' : '';
      if (i === 0) cls += ' st';
      return '<span class="tok ' + cls + '" aria-hidden="true">' + esc(x) + '</span>';
    }).join('') + '</span>';
  }
  function railCount(code) { return code.split(' ').length; }
  // "Off by" (one value) or "inside by" (a range; negative when outside)
  function offText(r, st) { return st.mode === 'range' ? fmtDist(st.w - r.dist) : fmtDist(r.dist); }
  function targetText(st) {
    return st.mode === 'range' ? 'from ' + st.lo.toFixed(10) + ' to ' + st.hi.toFixed(10) : 'within ±' + st.w + ' of ' + st.target.toFixed(10);
  }

  /* ---------- search ---------- */
  // Background workers are tried when the page loads, from a blob: URL and then a data: URL.
  // A browser may refuse them (a security policy, or a page opened straight from a file), and
  // it reports that a moment later rather than at once. With no workers, or if one stops
  // during a search, the search carries on here on the page, one part at a time.
  var S = null;                                  // the search in progress or last finished
  var workerMode = null, workerURLs = {}, probeWaiters = [];   // null while checking, then 'blob', 'data' or 'none'
  function workerMain() {
    var E = makeEngine();
    self.onmessage = function (e) {
      var m = e.data;
      try {
        var r = E.searchTask({ how: m.how, boat: m.boat, stopper: m.stopper, approach: m.approach, facing: m.facing, alphabet: m.task.alphabet, depth: m.task.depth, origin: m.origin,
          start: m.task.start, first: m.task.first, minMid: m.task.minMid, axis: m.axis, target: m.target, lo: m.lo, hi: m.hi,
          sort: m.sort, keep: m.keep,
          progress: function (st) { self.postMessage({ id: m.id, type: 'progress', nodes: st.nodes }); } });
        self.postMessage({ id: m.id, type: 'done', top: r.top, stats: r.stats });
      } catch (err) {
        self.postMessage({ id: m.id, type: 'error', message: String((err && err.message) || err) });
      }
    };
    self.postMessage({ type: 'ready' });
  }
  function workerURL(kind) {
    if (!workerURLs[kind]) {
      var src = makeEngine.toString() + '\n(' + workerMain.toString() + ')();';
      workerURLs[kind] = kind === 'blob' ? URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))
        : 'data:text/javascript;charset=utf-8,' + encodeURIComponent(src);
    }
    return workerURLs[kind];
  }
  function probeWorkers(kinds) {
    if (!kinds.length) { probed('none'); return; }
    var w = null, timer = null, over = false;
    function end(ok) {
      if (over) return;
      over = true;
      clearTimeout(timer);
      try { if (w) w.terminate(); } catch (e) { /* ignore */ }
      if (ok) probed(kinds[0]); else probeWorkers(kinds.slice(1));
    }
    try { w = new Worker(workerURL(kinds[0])); } catch (e) { end(false); return; }
    w.onmessage = function (e) { if (e.data && e.data.type === 'ready') end(true); };
    w.onerror = function (e) { if (e && e.preventDefault) e.preventDefault(); end(false); };
    timer = setTimeout(function () { end(false); }, 6000);
  }
  function probed(mode) {
    workerMode = mode;
    sizeHint();
    var waiting = probeWaiters;
    probeWaiters = [];
    waiting.forEach(function (f) { f(); });
  }

  // Results are tracks with a start (r.v): r.id is the layout code and the start
  function cmp(a, b) {
    return a.score - b.score || railCount(a.code) - railCount(b.code) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) || a.v.rank - b.v.rank;
  }
  function merge(top, list, keep) {
    var by = {};
    top.concat(list).forEach(function (r) { if (!by[r.id] || cmp(r, by[r.id]) < 0) by[r.id] = r; });
    return Object.keys(by).map(function (k) { return by[k]; }).sort(cmp).slice(0, keep);
  }

  function start() {
    var st = readAll();
    if (!st) { $('status').textContent = 'Fix the highlighted setting.'; return; }
    if (workerMode === null) {                     // still finding out whether workers run here
      $('status').textContent = 'Starting…';
      probeWaiters = [start];
      return;
    }
    stop(true);
    // Every part once per start (t.v: its index in st.starts). With several starts and more than
    // the Quick size, a quick pass over every start goes first: good results show up within
    // seconds, and the full search then takes the starts that did best first (reorder()).
    var tasks = [], total = 0, pre = st.starts.length > 1 && st.size > 0, preEnd = 0;
    function add(size, isPre) {
      jobsFor(st.rails, size).forEach(function (j) {
        total += TOTALS[st.boat ? 'boat' : 'empty'][j.alphabet][j.depth] * st.starts.length;
        E.makeTasks(j.alphabet, j.starts, j.depth, j.split).forEach(function (t) {
          st.starts.forEach(function (v, i) {
            tasks.push({ start: t.start, first: t.first, alphabet: t.alphabet, depth: t.depth, minMid: j.minMid, v: i, pre: isPre });
          });
        });
      });
    }
    if (pre) { add(0, true); preEnd = tasks.length; }
    add(st.size, false);
    S = { st: st, tasks: tasks, next: 0, done: 0, total: total, nodes: 0, preEnd: preEnd, reordered: !pre,
          main: { nodes: 0, parked: 0, inside: 0, floats: 0, parts: 0 }, quick: { nodes: 0, parked: 0, inside: 0, floats: 0, parts: 0 },
          live: {}, top: [], t0: performance.now(), slots: [], retry: [], mainThread: null,
          running: true, stopped: false, error: null, opened: {} };
    $('go').disabled = true; $('stop').disabled = false;
    $('prog').hidden = false; $('results').hidden = false; $('intro').hidden = true;
    $('status').textContent = 'Searching…';
    renderRows(true);
    if (workerMode !== 'none') {
      for (var i = 0, n = Math.min(CORES, tasks.length); i < n; i++) {
        var slot = spawn(S);
        if (slot) S.slots.push(slot);
      }
    }
    if (!S.slots.length) runHere(S, 'blocked');
    S.timer = setInterval(function () { progress(S); }, 250);
  }
  function spawn(s) {
    var slot = { w: null, id: -1, ready: false };
    try { slot.w = new Worker(workerURL(workerMode)); } catch (e) { return null; }
    slot.w.onmessage = function (e) {
      if (s !== S || !s.running) return;
      var m = e.data;
      if (m.type === 'ready') { slot.ready = true; dispatch(s, slot); return; }
      if (m.type === 'progress') { s.live[m.id] = m.nodes; return; }
      if (m.type === 'error') { s.error = m.message; finish(s); return; }
      delete s.live[m.id];
      slot.id = -1;
      absorb(s, m.id, m.top, m.stats);
      dispatch(s, slot);
    };
    slot.w.onerror = function (e) {
      if (e && e.preventDefault) e.preventDefault();
      if (s === S && s.running) fallBack(s, slot.ready ? 'stopped' : 'blocked');
    };
    return slot;
  }
  function taskMsg(s, id) {
    var t = s.tasks[id], st = s.st, v = st.starts[t.v];
    return { id: id, task: t, facing: st.facing, origin: originFor(t.start, st.pos), axis: st.axis, target: st.target,
             lo: st.lo, hi: st.hi, sort: st.sort, keep: st.keep, how: v.how, boat: v.boat, stopper: v.stopper, approach: v.approach };
  }
  // The next part to hand out. When the quick pass has all been handed out, the full search's parts
  // are put in order of how close each start's best quick result came.
  function nextId(s) {
    if (!s.reordered && s.next >= s.preEnd) {
      s.reordered = true;
      var best = {};
      s.top.forEach(function (r) { var i = r.v.rank; if (!(i in best) || r.score < best[i]) best[i] = r.score; });
      var rest = s.tasks.slice(s.preEnd).map(function (t, i) { return { t: t, i: i }; });
      rest.sort(function (a, b) {
        var x = a.t.v in best ? best[a.t.v] : Infinity, y = b.t.v in best ? best[b.t.v] : Infinity;
        return x - y || a.i - b.i;
      });
      for (var k = 0; k < rest.length; k++) s.tasks[s.preEnd + k] = rest[k].t;
    }
    return s.next++;
  }
  function dispatch(s, slot) {
    if (s.next >= s.tasks.length) {
      if (s.done === s.tasks.length) finish(s);
      return;
    }
    slot.id = nextId(s);
    slot.w.postMessage(taskMsg(s, slot.id));
  }
  // the counts the summary gives: the full search's, or the quick pass's if it was stopped before any full part
  function counts(s) { return s.main.parts ? s.main : s.quick; }
  function absorb(s, id, top, stats) {
    var v = s.st.starts[s.tasks[id].v], c = s.tasks[id].pre ? s.quick : s.main;
    s.done++;
    s.nodes += stats.nodes;
    c.nodes += stats.nodes; c.parked += stats.parked; c.inside += stats.inside; c.floats += stats.floats; c.parts++;
    top.forEach(function (r) { r.v = v; r.id = r.code + '|' + vKey(v); });
    if (top.length) { s.top = merge(s.top, top, s.st.keep); s.dirty = true; }
  }
  // Workers refused or stopped: the parts they held go back in the queue and the search
  // carries on here. Nothing they sent for those parts has been counted yet.
  function fallBack(s, why) {
    if (s.mainThread) return;
    if (why === 'blocked') { workerMode = 'none'; sizeHint(); }
    s.slots.forEach(function (sl) { if (sl.id >= 0) s.retry.push(sl.id); });
    killWorkers(s);
    s.live = {};
    runHere(s, why);
  }
  function runHere(s, why) {
    s.mainThread = why;
    setTimeout(function () { mainThreadStep(s); }, 0);
  }
  function mainThreadStep(s) {
    if (s !== S || !s.running) return;
    var t0 = performance.now();
    while ((s.retry.length || s.next < s.tasks.length) && performance.now() - t0 < 40) {
      var id = s.retry.length ? s.retry.shift() : nextId(s), m = taskMsg(s, id);
      var r = E.searchTask({ how: m.how, boat: m.boat, stopper: m.stopper, approach: m.approach, facing: m.facing, alphabet: m.task.alphabet, depth: m.task.depth, origin: m.origin,
        start: m.task.start, first: m.task.first, minMid: m.task.minMid, axis: m.axis, target: m.target, lo: m.lo, hi: m.hi,
        sort: m.sort, keep: m.keep });
      absorb(s, id, r.top, r.stats);
    }
    if (s.done === s.tasks.length) finish(s); else setTimeout(function () { mainThreadStep(s); }, 0);
  }
  function killWorkers(s) {
    s.slots.forEach(function (sl) { try { sl.w.terminate(); } catch (e) { /* ignore */ } });
    s.slots = [];
  }
  function stop(silent) {
    if (!S || !S.running) return;
    S.running = false; S.stopped = !silent;
    killWorkers(S);
    clearInterval(S.timer);
    if (!silent) finish(S, true);
  }
  // A launched result's numbers come from the search's model of the launch (at rest on the start
  // rail); the full flight can end a trillionth off. Once the search is over, the listed launched
  // results get the full flight's numbers, and the list is sorted again.
  function exactFlights(s) {
    var st = s.st, changed = false;
    s.top.forEach(function (r) {
      if (r.v.how !== 'fly' || r.exact) return;
      var f = E.run(r.code, originFor(startOf(r.code), st.pos), st.facing, false, 20000, optsFor(r.v));
      r.exact = true;
      if (!f.ok || (f.x === r.x && f.y === r.y && f.z === r.z)) return;
      var v = axisValue(f, st.axis), d = E.circDist(v, st.target), inside = E.inRange(frac(v), st.lo, st.hi);
      r.x = f.x; r.y = f.y; r.z = f.z; r.dist = d; r.inside = inside; r.float = E.isFloatcart(f.y);
      r.score = st.sort === 'short' && inside ? -1000 + railCount(r.code) + d : d;
      changed = true;
    });
    if (changed) s.top.sort(cmp);
  }
  function finish(s, stopped) {
    if (s.finished) return;
    s.finished = true; s.running = false;
    killWorkers(s);
    clearInterval(s.timer);
    s.secs = (performance.now() - s.t0) / 1000;
    exactFlights(s);
    $('go').disabled = false; $('stop').disabled = true;
    $('prog').hidden = true;
    $('rows').classList.remove('arrive'); void $('rows').offsetWidth; $('rows').classList.add('arrive');   // the final list slides in
    setTimeout(function () { $('rows').classList.remove('arrive'); }, 1400);
    $('status').textContent = s.error ? 'Search failed: ' + s.error : stopped ? 'Stopped.' :
      'Done in ' + s.secs.toFixed(1) + ' s' + (s.mainThread ? ' on one core' : '') + '.';
    renderRows(true);
  }
  function progress(s) {
    if (s !== S || !s.running) return;
    var live = 0;
    for (var k in s.live) live += s.live[k];
    var done = s.nodes + live, secs = (performance.now() - s.t0) / 1000;
    var pct = Math.min(99.5, 100 * done / Math.max(1, s.total));
    $('bar').style.width = pct.toFixed(1) + '%';
    $('barBox').setAttribute('aria-valuenow', String(Math.round(pct)));
    var rate = done / Math.max(0.05, secs), left = (s.total - done) / Math.max(1, rate);
    $('progText').textContent = Math.floor(pct) + '% · ' + fmtCount(done) + ' of about ' + fmtCount(s.total) + ' tracks · ' +
      secs.toFixed(1) + ' s' + (secs > 1.5 && left > 0.5 ? ' · ' + fmtTime(left) + ' left' : '') +
      (s.mainThread === 'blocked' ? ' · 1 core (workers blocked)'
        : s.mainThread === 'stopped' ? ' · 1 core (a worker stopped)'
        : ' · ' + s.slots.length + ' worker' + (s.slots.length === 1 ? '' : 's'));
    if (s.dirty) renderRows(false);
  }
  $('go').addEventListener('click', start);
  document.querySelector('.rail').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && !$('go').disabled) { e.preventDefault(); start(); }
  });
  $('stop').addEventListener('click', function () { stop(false); });
  $('resFilter').addEventListener('change', function () { renderRows(true); });
  $('resGroup').addEventListener('change', function () { renderRows(true); });

  /* ---------- results table ---------- */
  var lastRender = 0;
  function renderRows(force) {
    var s = S;
    if (!s) return;
    var now = performance.now();
    if (!force && now - lastRender < 400) return;
    lastRender = now; s.dirty = false;
    var st = s.st, rows = [];
    $('thVal').textContent = st.axis + ' fraction';
    $('thOff').textContent = st.mode === 'range' ? 'Inside by' : 'Off by';
    // with several starts: show one kind of start, and / or one row per layout (its best start)
    var many = st.starts.length > 1, kinds = {};
    st.starts.forEach(function (v) { kinds[v.how] = true; });
    $('resTools').hidden = !many;
    Array.prototype.forEach.call($('resFilter').options, function (o) { o.hidden = o.disabled = o.value !== 'all' && !kinds[o.value]; });
    if ($('resFilter').selectedOptions[0].disabled) $('resFilter').value = 'all';
    var want = many ? $('resFilter').value : 'all', group = many && $('resGroup').checked, list = [], more = {};
    s.top.forEach(function (r) {
      if (want !== 'all' && r.v.how !== want) return;
      if (group && r.code in more) { more[r.code]++; return; }
      more[r.code] = 0; list.push(r);
    });
    if (!list.length) rows.push('<tr><td colspan="7" class="empty">' + (s.running ? 'Searching…' : s.top.length ? 'None with this start.' : 'No track parked the cart.') + '</td></tr>');
    list.forEach(function (r, i) { rows.push(rowHTML(r, i, st, !!s.opened[r.id], many ? 'both' : 'code', group ? more[r.code] : 0)); });
    snapCurrent();
    $('rows').innerHTML = rows.join('');
    syncViewer();
    var sum;
    if (s.running) sum = 'Searching… ' + fmtInt(s.done) + ' of ' + fmtInt(s.tasks.length) + ' parts done.';
    else {
      var c = counts(s);
      sum = (s.stopped ? 'Stopped after ' : 'Tried ') + fmtInt(c.nodes) + ' tracks' + (c === s.quick && s.preEnd ? ' (quick pass)' : '') + ' in ' + s.secs.toFixed(1) + ' s. ' +
        fmtInt(c.parked) + ' parked, ' + fmtInt(c.inside) + ' landed ' + targetText(st) + (st.axis === 'y' ? ', ' + fmtInt(c.floats) + ' made a floatcart.' : '.') +
        (s.top.length ? ' Results are for a start rail at ' + st.pos.join(' ') + ', track running ' + st.facing +
          (st.starts.length === 1 && st.starts[0].how !== 'hand' ? startPhrase(st.starts[0]) : '') + '.' : '');
    }
    $('summary').textContent = sum;
  }
  // one result as a row of the table (and its details under it when open)
  // show: 'code' the layout, 'both' the layout and its start, 'start' the start alone
  function rowHTML(r, i, st, open, show, more) {
    var badge = r.float && st.axis === 'y' ? '<span class="badge fc" title="Inside the floatcart window at this build position">floatcart</span>'
      : r.inside ? '<span class="badge in">' + (st.mode === 'range' ? 'in range' : 'match') + '</span>' : '';
    var parked = r.ok !== false;
    return '<tr class="r' + (open ? ' open' : '') + '" data-id="' + esc(r.id) + '" style="--i:' + i + '">' +
      '<td class="n">' + (i + 1) + '</td>' +
      '<td class="lay">' + (show === 'start' ? '' : tokensHTML(r.code)) + (show === 'code' ? '' : '<span class="startv">' + esc(startWords(r.v)) + (more ? ' · +' + more + ' more start' + (more === 1 ? '' : 's') : '') + '</span>') + '</td>' +
      (parked ? '<td class="yf"><span class="mono">' + fmtFrac(axisValue(r, st.axis)) + '</span>' + badge + '</td>' +
        '<td class="num off mono' + (st.mode === 'range' && !r.inside ? ' miss' : '') + '" data-lab="' + (st.mode === 'range' ? 'inside by ' : 'off by ') + '">' + offText(r, st) + '</td>'
        : '<td class="yf"><span class="miss">does not park</span></td><td class="num off mono"></td>') +
      '<td class="num rails">' + railCount(r.code) + '</td>' +
      '<td class="num levers">' + leversOf(r, st) + '</td>' +
      '<td class="more"><button type="button" class="btn sm" aria-expanded="' + open + '">' + (open ? 'Hide' : 'Details') + '</button></td></tr>' +
      (open ? '<tr class="detail"><td colspan="7">' + detailHTML(r, st) + '</td></tr>' : '');
  }
  var leverCache = {};
  function leversOf(r, st) {
    var k = r.id + '|' + st.facing;
    if (!(k in leverCache)) leverCache[k] = E.build(r.code, originFor(startOf(r.code), st.pos), st.facing, optsFor(r.v)).levers;
    return leverCache[k];
  }
  // a click on a row opens or closes it: in the results, or in the checked layout's starts
  function rowClick(e) {
    var tr = e.target.closest ? e.target.closest('tr.r') : null;
    if (!tr) return;
    var id = tr.getAttribute('data-id'), inCheck = !!tr.closest('#checkOut');
    var list = inCheck ? CHECK : S;
    if (!list || !list.opened) return;
    list.opened[id] = !list.opened[id];
    if (inCheck) renderCheck(); else renderRows(true);
  }
  $('rows').addEventListener('click', rowClick);
  $('checkOut').addEventListener('click', rowClick);
  $('rows').addEventListener('click', actionClick);
  $('checkOut').addEventListener('click', actionClick);

  /* ---------- one track in detail ---------- */
  // Results by id (layout code and start), for the buttons in their details
  var detailCache = {}, verifyCache = {}, RES = {};
  function stKey(st) { return [st.pos.join(','), st.facing, st.axis, st.mode, st.target, st.lo, st.hi].join('|'); }
  function detailHTML(res, st) {
    var key = res.id + '|' + stKey(st);
    RES[res.id] = res;
    if (!detailCache[key]) detailCache[key] = buildDetail(res, st, key);
    var v = verifyCache[key];
    return detailCache[key].replace('@@VERIFY@@', '<p class="verify' + (v ? ' ' + v.cls : '') + '" data-verify="' + esc(res.id) + '"' + (v ? '>' + v.html : ' hidden>') + '</p>');
  }
  function buildDetail(res, st, key) {
    var code = res.code, sv = res.v, o = optsFor(sv), id = esc(res.id);
    var origin = originFor(startOf(code), st.pos);
    var r = E.run(code, origin, st.facing, true, 20000, o);
    var b = E.build(code, origin, st.facing, o);
    var h = '<div class="dv">', drop = null, dropPath = [];
    if (!r.ok) {
      h += '<p class="check-sum">The cart doesn\'t park on this track' + (sv.how === 'hand' ? '' : ' with this start') + ': ' + esc(r.why) + '.</p>';
    } else {
      var v = axisValue(r, st.axis), d = E.circDist(v, st.target), inside = E.inRange(frac(v), st.lo, st.hi);
      drop = E.dropY(code, origin, st.facing, r, o, dropPath);
      var rr = { dist: d, inside: inside };
      h += '<p class="facts"><span>Stops at x <b class="mono">' + r.x + '</b>, y <b class="mono">' + r.y + '</b>, z <b class="mono">' + r.z + '</b></span>' +
        '<span>' + st.axis + ' fraction <b class="mono">' + fmtFrac(v) + '</b>' +
          (st.axis === 'y' && E.isFloatcart(r.y) ? '<span class="badge fc">floatcart</span>' : inside ? '<span class="badge in">' + (st.mode === 'range' ? 'in range' : 'match') + '</span>' : '') + '</span>' +
        '<span>' + (st.mode === 'range' ? 'inside by' : 'off by') + ' <b class="mono">' + offText(rr, st) + '</b></span>' +
        (sv.how === 'fly' ? '<span>lands at tick <b>' + r.landTick + '</b>, parks at tick <b>' + r.ticks + '</b> (' + (r.ticks / 20).toFixed(1) + ' s)</span>'
          : '<span>parks after <b>' + r.ticks + ' ticks</b> (' + (r.ticks / 20).toFixed(1) + ' s)</span>') +
        '<span><b>' + b.rails.length + '</b> rails, <b>' + b.levers + '</b> lever' + (b.levers === 1 ? '' : 's') + ', <b>' + b.blocks.length + '</b> blocks</span></p>';
      if (sv.how === 'fly' && res.y !== undefined && (res.x !== r.x || res.y !== r.y || res.z !== r.z)) {
        h += '<p class="facts drop">The full flight parks it ' + fmtDist(Math.max(Math.abs(res.x - r.x), Math.abs(res.y - r.y), Math.abs(res.z - r.z))) +
          ' away from the listed value. These numbers are from the full flight.</p>';
      }
      if (r.spread) {
        h += '<p class="facts drop">Where you put the boat on its rail shifts the result by up to ' + fmtDist(r.spread) +
          '. These numbers are for the middle of the rail.</p>';
      }
      h += '<p class="facts drop">' + (drop === Math.floor(drop)
        ? 'Break the parking rail after it stops and the cart drops to <b class="mono">y ' + drop + '</b>. x and z don\'t change.'
        : 'Break the parking rail after it stops and the cart stays at <b class="mono">y ' + drop + '</b>, since it\'s under 0.0003 above the block below (C4). x and z don\'t change.') + '</p>';
      var boatAt = b.loader ? b.loader.boat : b.launcher ? b.launcher.boat : null;
      var gd = { blocks: b.blocks, cart: [r.x, r.y, r.z], path: r.path, drop: st.axis === 'y' ? null : drop,
                 dropPath: st.axis === 'y' ? null : dropPath, boat: boatAt, boatPick: r.pickTick || 0 };
      if (b.loader) {                              // the loading step, drawn in the 3D view
        var tr = E.trackFromCode(code, origin, st.facing, o), c0 = E.spawnCart(tr.T);
        gd.loader = b.loader; gd.landing = [c0.x, c0.y, c0.z];
      }
      if (b.launcher) gd.launcher = b.launcher;
      glCache[key] = gd;
      h += '<div class="glbox" data-gl="' + esc(key) + '"></div>';
    }
    h += '<div class="dv-actions">' +
      '<button type="button" class="btn primary sm" data-act="lite" data-id="' + id + '">Download .litematic</button>' +
      '<details class="more-menu"><summary class="btn sm">More</summary><div class="menu">' +
      '<button type="button" class="btn sm" data-act="copy" data-id="' + id + '">Copy layout code</button>' +
      '<button type="button" class="btn sm" data-act="link" data-id="' + id + '">Copy link</button>' +
      (r.ok ? '<button type="button" class="btn sm" data-act="tester" data-id="' + id + '">Download with tester</button>' : '') +
      '<button type="button" class="btn sm" data-act="verify" data-id="' + id + '">Check at ' + (st.axis === 'y' ? 60 : 15) + ' positions</button>' +
      '</div></details>' +
      '<span class="note" data-for="' + id + '"></span></div>';
    h += '@@VERIFY@@';
    h += buildTableHTML(b, st);
    h += '</div>';
    return h;
  }

  function xyz(p) { return p.join(' '); }
  var SHAPE_WORD = { F: 'flat', U: 'slope up', D: 'slope down' };
  var RAIL_WORD = { r: 'rail', p: 'powered rail, ON', h: 'powered rail, OFF' };
  function buildTableHTML(b, st) {
    var last = b.rails.length - 1, src = {};
    b.sources.forEach(function (s) { src[s.k] = s; });
    var rows = b.rails.map(function (rl) {
      var notes = [];
      if (rl.k === 0) notes.push(b.loader ? 'the cart drops onto this rail' : b.launcher ? 'the cart lands here' : 'place the cart here');
      if (rl.k === 0 && b.conductor) notes.push('concrete behind at ' + xyz(b.conductor.concrete) + ', lever on its ' + b.side + ' side');
      if (src[rl.k]) notes.push('concrete at ' + xyz(src[rl.k].concrete) + ', lever on its ' + b.side + ' side');
      else if (rl.kind === 'p' && b.poweredBy[rl.k] !== undefined && b.poweredBy[rl.k] !== rl.k) notes.push('powered through #' + b.poweredBy[rl.k]);
      if (rl.k === last) notes.push('parking slope, the cart stops here' + (st.axis !== 'y' ? ' (break it after)' : ''));
      return '<tr><td class="k">' + rl.k + '</td><td class="mono">' + xyz(rl.pos) + '</td><td>' + RAIL_WORD[rl.kind] + '</td><td>' +
        SHAPE_WORD[rl.s] + '</td><td>' + esc(notes.join('; ')) + '</td></tr>';
    }).join('');
    var caps = b.caps.map(function (c) { return 'at ' + xyz(c.glass); });
    var note = 'Glass under every rail. Also glass ' + caps.join(' and ') + ' with a plain rail on top, just to shape the ' +
      (caps.length > 1 ? 'end slopes' : 'parking slope') + '. The track runs ' + st.facing + '.';
    var extra = '';
    if (b.loader) {
      var L = b.loader;
      extra = '<p class="bnote">Loading run, ' + L.level + ' blocks up, ' + (L.approach === 'front' ? 'above the track in front' : 'behind the start') +
        '. 1. Put a boat on the rail at ' + xyz(L.boatRail) + '. 2. Place the minecart on the slope at ' + xyz(L.start) +
        '. 3. It picks up the boat and stops against the ' + STOP_NAME[L.stopper] + ' at ' + xyz(L.stop) +
        (L.support ? ' (attached to ' + xyz(L.support) + ')' : '') + '. 4. Break the glass at ' + xyz(L.breakGlass) +
        '. The cart drops onto the start rail at ' + L.frac.toFixed(10) + ' and runs the track.</p>';
    }
    if (b.launcher) {
      var La = b.launcher, n = 1;
      extra = '<p class="bnote">Launcher, ' + La.level + ' blocks up, ' + (La.approach === 'front' ? 'above the track in front' : 'behind the start') +
        '. The lever at ' + xyz(La.lever) + ' powers the launch slope at ' + xyz(La.launchRail) + ' (already on in the schematic). ' +
        (La.boatRail ? n++ + '. Put a boat on the rail at ' + xyz(La.boatRail) + '. ' : '') +
        n++ + '. Place the minecart on the ' + (La.boatRail ? 'top slope' : 'launch slope') + ' at ' + xyz(La.start) + '. ' +
        n++ + '. It ' + (La.boatRail ? 'picks up the boat, ' : '') + 'flies off the slope and hits the ' + STOP_NAME[La.stopper] + ' at ' + xyz(La.stop) +
        (La.support ? ' (attached to ' + xyz(La.support) + ')' : '') + ', then drops onto the start rail at ' + La.frac.toFixed(10) + ' and runs the track. Nothing to break.</p>';
    }
    return '<div class="build"><table><thead><tr><th>#</th><th>x y z</th><th>Rail</th><th>Shape</th><th>Note</th></tr></thead><tbody>' + rows +
      '</tbody></table></div><p class="bnote">' + esc(note) + '</p>' + extra;
  }

  /* ---------- 3D view: one canvas (makeViewer3D), moved into the result that is open ----------
     A result that had it keeps a still picture; click that picture to turn the track again. */
  var glCache = {}, snaps = {}, seen = {}, V3 = null, v3Made = false, v3Key = null, v3Box = null;
  function viewer3() {
    if (!v3Made) { v3Made = true; try { V3 = makeViewer3D(); } catch (e) { V3 = null; } }
    return V3;
  }
  function snapHTML(k) {
    return '<img alt="3D view of this track" src="' + snaps[k] + '"><div class="glsnap"><span>Click to rotate</span></div>';
  }
  function snapCurrent() {
    if (!V3 || !V3.ok || !v3Key || !v3Box || !v3Box.parentNode) return;
    var img = V3.snapshot();
    if (img) snaps[v3Key] = img;
  }
  function attachViewer(box) {
    var v = viewer3(), k = box.getAttribute('data-gl'), d = glCache[k];
    if (!v || !v.ok || !d) return;
    var old = v3Box, oldKey = v3Key;
    if (old && old !== box) snapCurrent();
    box.innerHTML = '';
    box.appendChild(v.el);
    v3Box = box; v3Key = k; seen[k] = true;
    if (old && old !== box && old.parentNode && snaps[oldKey]) old.innerHTML = snapHTML(oldKey);
    v.load(d);
  }
  function syncViewer() {
    var boxes = [];
    each('.glbox', function (el) { boxes.push(el); });
    if (!boxes.length) { v3Box = null; return; }
    var v = viewer3();
    if (!v || !v.ok) {
      boxes.forEach(function (b) { b.innerHTML = '<div class="gl-none">3D view unavailable: WebGL didn\'t start in this browser. The build list below still works.</div>'; });
      return;
    }
    var fresh = null, current = null;
    boxes.forEach(function (b) {
      var k = b.getAttribute('data-gl');
      if (k === v3Key) current = b;
      else if (!seen[k] && !fresh) fresh = b;                       // a result just opened takes the canvas
    });
    if (boxes.indexOf(v.el.parentNode) >= 0) current = v.el.parentNode;   // shown twice: the box that has the canvas
    v3Box = current;
    boxes.forEach(function (b) {
      var k = b.getAttribute('data-gl');
      if (b !== current && !b.firstChild && snaps[k]) b.innerHTML = snapHTML(k);
    });
    if (fresh) attachViewer(fresh);
    else if (!current) attachViewer(boxes[boxes.length - 1]);
    else if (v.el.parentNode !== current) {                         // redrawn: the live view goes back in, camera kept
      current.innerHTML = '';
      current.appendChild(v.el);
      v.redraw();
    }
  }
  function glClick(e) {
    var box = e.target.closest ? e.target.closest('.glbox') : null;
    if (!box) return;
    e.stopPropagation();
    if (box !== v3Box) attachViewer(box);
  }
  $('rows').addEventListener('click', glClick);
  $('checkOut').addEventListener('click', glClick);

  /* ---------- copy, download, verify ---------- */
  function note(id, text) {
    each('.note[data-for]', function (el) { if (el.getAttribute('data-for') === id) el.textContent = text; });
  }
  function actionClick(e) {
    var btn = e.target.closest ? e.target.closest('button[data-act]') : null;
    if (!btn) return;
    e.stopPropagation();
    var res = RES[btn.getAttribute('data-id')], act = btn.getAttribute('data-act'), menu = btn.closest('details');
    if (menu) menu.removeAttribute('open');
    var st = btn.closest('#checkOut') && CHECK ? CHECK.st : S ? S.st : readAll();
    if (!st || !res) return;
    if (act === 'copy') copyText(res.code, res.id, 'Copied.');
    else if (act === 'link') copyText(linkFor(res, st), res.id, 'Link copied. It opens this track with these settings.');
    else if (act === 'lite') download(res, st);
    else if (act === 'tester') downloadTester(res, st);
    else if (act === 'verify') verify(res, st, btn);
  }
  function copyText(text, id, msg) {
    function done() { note(id, msg); }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (err) { note(id, 'Copy failed. Copy this: ' + text); }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }
  // a link that opens this result: the search's settings, its start pinned, and the layout checked
  function linkFor(res, st) {
    var v = res.v, o = { axis: st.axis, mode: st.mode, px: st.pos[0], py: st.pos[1], pz: st.pos[2], facing: st.facing,
      rails: st.rails, size: st.size, keep: st.keep, sort: st.sort };
    if (st.mode === 'value') { o.target = st.target.toFixed(10); o.tol = String(st.w); } else { o.lo = st.lo.toFixed(10); o.hi = st.hi.toFixed(10); }
    if (v.how === 'hand') { o.cart = 'empty'; o.how = 'hand'; }
    else { o.cart = v.boat ? 'boat' : 'empty'; o.how = v.how; o.stopAll = 'one'; o.stopper = v.stopper; o.approach = v.approach; }
    o.check = res.code;
    return location.href.split('#')[0] + '#' + encodeState(o);
  }
  function download(res, st) {
    var code = res.code, v = res.v, o = optsFor(v), origin = originFor(startOf(code), st.pos);
    var b = E.build(code, origin, st.facing, o), r = E.run(code, origin, st.facing, false, 20000, o);
    var start = b.rails[0].pos, where = ' (for a start rail at ' + xyz(start) + ', facing ' + st.facing + ')';
    var what = !r.ok ? 'It doesn\'t park'
      : st.axis === 'y' ? 'Parks at y ' + fmtFrac(r.y) + where
      : 'After breaking the parking rail, ' + st.axis + ' is ' + fmtFrac(axisValue(r, st.axis)) + where;
    var by = 'Minecart track by 07km. ', levers = b.levers ? ' (levers on)' : '';
    var desc = v.how === 'fly'
      ? by + (v.boat ? 'Put a boat on the first flat rail of the launcher, then a minecart on the top slope' : 'Place a minecart on the launch slope') +
        levers + '. It flies off the launch slope into the ' + STOP_WORD[v.stopper] + ' and drops onto the start rail. ' + what + '. Layout: ' + code + '. Java 26.2'
      : v.how === 'loader'
      ? by + 'Put a boat on the first flat rail of the loading run, then a minecart on the top slope' + levers +
        '. Once it stops against the ' + STOP_WORD[v.stopper] + ', break the glass under it. ' + what + '. Layout: ' + code + '. Java 26.2'
      : by + 'Place a minecart on the start rail' + levers + '. ' + what + '. Layout: ' + code + '. Java 26.2';
    var enc = LW.encode(b.blocks, 'Cart track ' + code, '07km', desc);
    var rel = [start[0] - enc.offset[0], start[1] - enc.offset[1], start[2] - enc.offset[2]];
    var url = URL.createObjectURL(new Blob([LW.gzipStored(enc.bytes)], { type: 'application/octet-stream' }));
    var a = document.createElement('a');
    a.href = url; a.download = 'track-' + code.replace(/\s+/g, '-') + (v.how === 'hand' ? '' : '-' + v.how + '-' + v.stopper + '-' + v.approach) + '.litematic';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    note(res.id, 'Saved. The start rail is at ' + xyz(rel) + ' from the schematic\'s corner (' + enc.size.join(' × ') + ' blocks).');
  }
  // The track plus command blocks that test it by themselves after a paste (makeTester)
  function uid() {
    var s = '';
    for (var i = 0; i < 6; i++) s += '0123456789abcdef'.charAt(Math.floor(Math.random() * 16));
    return s;
  }
  function downloadTester(res, st) {
    var code = res.code, f;
    try { f = TS.file(code, st.pos, st.facing, st.axis, st.lo, st.hi, uid(), undefined, optsFor(res.v)); }
    catch (err) { note(res.id, 'No tester: ' + err.message + '.'); return; }
    var rel = [f.startRail[0] - f.offset[0], f.startRail[1] - f.offset[1], f.startRail[2] - f.offset[2]];
    var url = URL.createObjectURL(new Blob([LW.gzipStored(f.bytes)], { type: 'application/octet-stream' }));
    var a = document.createElement('a');
    a.href = url; a.download = 'track-test-' + code.replace(/\s+/g, '-') + (res.v.how === 'hand' ? '' : '-' + res.v.how + '-' + res.v.stopper + '-' + res.v.approach) + '.litematic';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    var v = f.end[st.axis === 'x' ? 0 : st.axis === 'z' ? 2 : 1];
    note(res.id, 'Saved with a tester. Paste it in open space in a creative world with command blocks enabled. ' +
      (f.info.how === 'loader' ? 'It spawns the boat and the cart on the loading run, then breaks the glass for you. '
        : f.info.boat ? 'It spawns the boat, then the cart on the launcher. ' : f.info.how === 'fly' ? 'It spawns the cart on the launcher. ' : '') +
      'After about ' + f.info.secs + ' s the chat should say ' + (f.expect.passed ? 'PASS' : 'FAIL') +
      (st.axis === 'y' ? ' and ' + (f.expect.floatcart ? '"Floatcart!"' : '"Not a floatcart"') : '') +
      ' (' + st.axis + ' ' + fmtFrac(v) + '). For these exact numbers, put the start rail at ' + xyz(f.startRail) +
      ', which is ' + xyz(rel) + ' from the schematic\'s corner (' + f.size.join(' × ') + ' blocks).');
  }
  function verify(res, st, btn) {
    btn.disabled = true;
    note(res.id, 'Checking…');
    setTimeout(function () {
      var sv = res.v;
      var v = E.verify(res.code, { axis: st.axis, target: st.target, lo: st.lo, hi: st.hi, facing: st.facing,
                                   how: sv.how, boat: sv.boat, stopper: sv.stopper, approach: sv.approach });
      var good = v.parked === v.runs && (st.w === 0 || v.within === v.runs);
      var txt = v.parked === 0 ? '<b>Didn\'t park in any of the ' + v.runs + ' runs.</b>' :
        '<b>' + v.parked + ' of ' + v.runs + '</b> parked (15 spots up to ±29,999,000' +
        (st.axis === 'y' ? ', 4 directions' : '') + (sv.how === 'fly' ? ', launched' : '') + '). ' +
        st.axis + ' ranged <span class="mono">' + v.min.toFixed(10) + '</span> to <span class="mono">' + v.max.toFixed(10) + '</span>. ' +
        (st.w > 0 ? '<b>' + v.within + ' of ' + v.runs + '</b> ' + (st.mode === 'range' ? 'in range' : 'on target') + '. ' : '') +
        (st.axis === 'y' ? '<b>' + v.floatcarts + ' of ' + v.runs + '</b> floatcarts.' : '');
      verifyCache[res.id + '|' + stKey(st)] = { html: txt, cls: good ? 'good' : 'bad' };
      each('[data-verify]', function (el) {
        if (el.getAttribute('data-verify') !== res.id) return;
        el.innerHTML = txt; el.hidden = false; el.className = 'verify ' + (good ? 'good' : 'bad');
      });
      note(res.id, '');
      btn.disabled = false;
    }, 20);
  }

  /* ---------- check a layout ----------
     With one start, its details; with several, each start as a row, the closest first and open */
  var CHECK = null;
  function check() {
    var code = $('code').value.trim().replace(/\s+/g, ' ');
    var out = $('checkOut');
    if (!code) { out.innerHTML = ''; CHECK = null; return; }
    var st = readAll();
    if (!st) { out.innerHTML = '<p class="hint err">Fix the highlighted setting first.</p>'; return; }
    var L;
    try { L = E.parse(code); } catch (e) { out.innerHTML = '<p class="hint err">' + esc(e.message) + '. A code starts with S, Dr or Dp and ends with E.</p>'; return; }
    var bad = E.problems(L.blocks);
    if (bad.length) { out.innerHTML = '<p class="hint err">Can\'t be built: ' + esc(bad.join('; ')) + '.</p>'; return; }
    var origin = originFor(startOf(code), st.pos), many = st.starts.length > 1;
    var list = st.starts.map(function (v) {
      var r = { code: code, v: v, id: code + '|' + vKey(v), score: 0 };
      if (!many) return r;
      var rr = E.run(code, origin, st.facing, false, 20000, optsFor(v));
      r.ok = rr.ok; r.score = Infinity;
      if (rr.ok) {
        var val = axisValue(rr, st.axis);
        r.x = rr.x; r.y = rr.y; r.z = rr.z; r.float = E.isFloatcart(rr.y);
        r.dist = r.score = E.circDist(val, st.target); r.inside = E.inRange(frac(val), st.lo, st.hi);
      }
      return r;
    });
    list.sort(function (a, b) { return a.score - b.score || a.v.rank - b.v.rank; });
    CHECK = { st: st, code: code, list: list, opened: {} };
    CHECK.opened[list[0].id] = true;
    $('intro').hidden = true;
    renderCheck();
  }
  function renderCheck() {
    var c = CHECK, st = c.st, h = '<p class="check-sum">' + tokensHTML(c.code) + '</p>';
    snapCurrent();
    if (c.list.length === 1) h += detailHTML(c.list[0], st);
    else {
      h += '<p class="bnote">All ' + c.list.length + ' starts, closest first. Click one for details.</p>' +
        '<table class="res"><thead><tr><th>#</th><th>Start</th><th>' + st.axis + ' fraction</th><th class="num">' + (st.mode === 'range' ? 'Inside by' : 'Off by') +
        '</th><th class="num">Rails</th><th class="num">Levers</th><th><span class="visually-hidden">Details</span></th></tr></thead><tbody>' +
        c.list.map(function (r, i) { return rowHTML(r, i, st, !!c.opened[r.id], 'start'); }).join('') + '</tbody></table>';
    }
    $('checkOut').innerHTML = h;
    syncViewer();
  }
  $('checkBtn').addEventListener('click', check);
  $('code').addEventListener('keydown', function (e) { if (e.key === 'Enter') check(); });

  /* ---------- the settings in the address (a link to share), and remembered for the next visit ---------- */
  var RADIOS = ['axis', 'mode', 'cart', 'stopAll', 'rails', 'size'],
      VALUES = ['target', 'tol', 'lo', 'hi', 'how', 'stopper', 'approach', 'px', 'py', 'pz', 'facing', 'keep', 'sort'], SAVE_KEY = 'floatcart-finder';
  function formState() {
    var o = {};
    RADIOS.forEach(function (n) { o[n] = choice(n); });
    VALUES.forEach(function (id) { o[id] = $(id).value; });
    return o;
  }
  function encodeState(o) { return Object.keys(o).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(o[k]); }).join('&'); }
  function decodeState(h) {
    var o = {};
    String(h).replace(/^#/, '').split('&').forEach(function (p) {
      var i = p.indexOf('=');
      if (i > 0) try { o[decodeURIComponent(p.slice(0, i))] = decodeURIComponent(p.slice(i + 1)); } catch (e) { /* a broken part is skipped */ }
    });
    return o;
  }
  function applyState(o) {
    RADIOS.forEach(function (n) {
      if (o[n] == null) return;
      each('input[name="' + n + '"]', function (el) { if (el.value === String(o[n])) el.checked = true; });
    });
    VALUES.forEach(function (id) {
      var el = $(id);
      if (o[id] == null || (el.tagName === 'SELECT' && !Array.prototype.some.call(el.options, function (x) { return x.value === String(o[id]); }))) return;
      el.value = o[id];
    });
    howKind = choice('cart') === 'boat' ? 'boat' : 'empty'; howFor[howKind] = $('how').value;   // keep the start the state asks for
    syncAxis(); syncMode(); syncCart();
  }
  function saveState() {
    var q = encodeState(formState());
    try { localStorage.setItem(SAVE_KEY, q); } catch (e) { /* private window: nothing to remember with */ }
    try { history.replaceState(null, '', location.href.split('#')[0] + '#' + q); } catch (e) { /* a file:// page may refuse */ }
  }
  document.querySelector('.rail').addEventListener('change', function () { setTimeout(saveState, 0); });
  $('presetFloat').addEventListener('click', function () { setTimeout(saveState, 0); });

  syncAxis(); syncCart(); syncMode(); sizeHint();
  var linked = location.hash.length > 1 ? decodeState(location.hash) : null, saved = null;
  if (!linked) try { saved = localStorage.getItem(SAVE_KEY); } catch (e) { saved = null; }
  if (linked || saved) applyState(linked || decodeState(saved));
  if (linked && linked.check) { $('code').value = linked.check; check(); }
  probeWorkers(['blob', 'data']);
})();
