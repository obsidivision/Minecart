/* Minecart alignment finder (floatcart-finder.html) — created by 07km.

   Plain JavaScript, no framework and no libraries. This file is the page script and its
   source: edit it directly (there is no build step any more). Nothing is minified, and
   nothing is fetched at run time. Its parts, in order:
     Engine        Physics and search: straight rail tracks, the launcher's flight, and the
                   depth-first search over layouts.
     Litematic     Writes .litematic files.
     Tester        The "Download with tester" build: command blocks that test a track in game.
     3D view       One track in 3D: scene3d.js (shared with the two 3D pages) in a box that
                   moves into whichever result is open.
     App           The page itself: reading the settings, running the search in workers, the
                   results table, the details, the downloads and the checks.

   The physics began as a port of the Python simulator, checked against it to the
   last digit; the Python is retired and this is now the reference. The search runs in Web
   Workers made from makeEngine's own source, so it works from a file:// URL as well as from a
   web server. Needs site.js and scene3d.js (loaded first by the page) for the theme and the 3D
   view. */

/* ============================================================================================
   Engine

   Physics and search for straight rail tracks, plus the depth-first search over layouts.
   The Web Workers are built from
   makeEngine's own source, so this part must stay self-contained.
   ============================================================================================ */

/*
  Floatcart finder engine: Minecraft Java 26.2 classic minecart physics for straight rail
  tracks, and a brute-force search over track layouts.

  The physics follows the game's classic minecart code (OldMinecartBehavior) line by line,
  keeping the same order of operations so every double rounds the same way. It began as a
  port of the retired Python simulator, which reproduced 13 carts in the real game to the
  last digit. Only what a straight, dry track needs is here: slopes, plain rails,
  powered rails (on and off), the standing start and its conductor block, rail lookups and
  track height, the straight fall when the parking rail is broken (dropY), and the flight of a
  cart launched into a stopper (launchRun), which gives the challenge's as-built run, ticks 7
  to 18, to the last digit.

  Checked against the Python to the last digit before it was retired: 7,980 full runs (random
  and parked layouts, 15 world placements, 4 directions), every parked outcome of the depth
  3-5 searches, the totals of the searches that found the 13 floatcart makers, and 2,100
  rail-break drops.

  makeEngine() returns the API. The same function runs in the page and inside the Web
  Workers (the page turns its source into a worker script), and in Node:
      var E = new Function(src + '\nreturn makeEngine;')()();   // src: this file up to the Litematic part
      E.run('Dr Dr Fr Fr Fp Up Fr Fr Ur E', [0, 65, 0], 'south')   // origin: entry level
*/
function makeEngine() {
  'use strict';

  var HEIGHT = 0.699999988079071;          // cart height, float 0.7 (M1)
  var HALF_W = Math.fround(Math.fround(0.98) / 2);   // half the cart's width, float (M1)
  var EPS = 1.0e-7;                        // collision tolerance (C3)
  var F_1E5 = Math.fround(1e-5);           // float 1e-5 (C5, X2)
  var WIN_LO = 0.30000001192092896, WIN_HI = 0.30001001192067633;   // floatcart window (X3)

  // rail shapes: 0 north_south, 1 east_west, 2 ascending_east, 3 ascending_west,
  // 4 ascending_north, 5 ascending_south; each has two track ends (R1)
  var SHAPE_NAMES = ['north_south', 'east_west', 'ascending_east', 'ascending_west', 'ascending_north', 'ascending_south'];
  var EXITS = [
    [[0, 0, -1], [0, 0, 1]],
    [[-1, 0, 0], [1, 0, 0]],
    [[-1, -1, 0], [1, 0, 0]],
    [[-1, 0, 0], [1, -1, 0]],
    [[0, 0, -1], [0, -1, 1]],
    [[0, -1, -1], [0, 0, 1]]
  ];
  // travel direction -> step along the track, step to the left side, flat / up / down shapes
  var FACINGS = {
    south: { du: 0, dv: 1, lu: 1, lv: 0, flat: 0, up: 5, down: 4 },
    north: { du: 0, dv: -1, lu: -1, lv: 0, flat: 0, up: 4, down: 5 },
    east: { du: 1, dv: 0, lu: 0, lv: -1, flat: 1, up: 2, down: 3 },
    west: { du: -1, dv: 0, lu: 0, lv: 1, flat: 1, up: 3, down: 2 }
  };
  Object.keys(FACINGS).forEach(function (k) { FACINGS[k].name = k; });
  var KIND_PLAIN = 0, KIND_ON = 1, KIND_OFF = 2;
  var KINDS = { r: KIND_PLAIN, p: KIND_ON, h: KIND_OFF };

  /* ---------- a track the physics can run on ---------- */
  // X, Y, Z: position of the "entry level" origin (rail 0 of a flat start sits here; a
  // slope start's rail is one block lower). level[k] is rail k's height offset. stop: the
  // collision box of the block behind the start, if any (the concrete behind a standing start).
  function newTrack(origin, facing, capacity) {
    var f = FACINGS[facing];
    return { X: origin[0], Y: origin[1], Z: origin[2], f: f, n: 0, conductorBehind: false,
             loaded: false, startAt: null, stop: null,
             shape: new Int8Array(capacity), kind: new Int8Array(capacity), level: new Int32Array(capacity) };
  }
  // A block's collision box (C8, C10, C11) at cell p, world coordinates: a full cube, a honey
  // block, or an amethyst bud pointing along dir ([dx, dz]: away from the block it grows on)
  function cellBox(p, block, dir) {
    var name = String(block).replace('minecraft:', ''), b = BUDS[name];
    if (name === 'honey_block') return [p[0] + 0.0625, p[1], p[2] + 0.0625, p[0] + 0.9375, p[1] + 0.9375, p[2] + 0.9375];
    if (!b) return [p[0], p[1], p[2], p[0] + 1.0, p[1] + 1.0, p[2] + 1.0];
    var h = b[0] / 16, lo = 0.5 - b[1] / 32, hi = 0.5 + b[1] / 32, r = [lo, lo, lo, hi, hi, hi];
    if (dir[0] > 0) { r[0] = 0; r[3] = h; } else if (dir[0] < 0) { r[0] = 1 - h; r[3] = 1; }
    if (dir[1] > 0) { r[2] = 0; r[5] = h; } else if (dir[1] < 0) { r[2] = 1 - h; r[5] = 1; }
    return [p[0] + r[0], p[1] + r[1], p[2] + r[2], p[0] + r[3], p[1] + r[4], p[2] + r[5]];
  }
  function railIndex(T, x, y, z) {
    var f = T.f, k;
    if (f.du !== 0) { if (z !== T.Z) return -1; k = (x - T.X) * f.du; }
    else { if (x !== T.X) return -1; k = (z - T.Z) * f.dv; }
    if (k >= 0 && k < T.n && y === T.Y + T.level[k]) return k;
    return -1;
  }
  function isConductor(T, x, y, z) {
    // only the concrete behind a standing start is a conductor next to the track (P4)
    if (!T.conductorBehind) return false;
    var f = T.f;
    return x === T.X - f.du && z === T.Z - f.dv && y === T.Y;
  }

  // Where a cart at (x, y, z) sits on its rail: its track height, or NaN off the rails (R2)
  function getPosY(T, x, y, z) {
    var xt = Math.floor(x), yt = Math.floor(y), zt = Math.floor(z);
    var k = railIndex(T, xt, yt - 1, zt);
    if (k >= 0) yt = yt - 1;
    else { k = railIndex(T, xt, yt, zt); if (k < 0) return NaN; }
    return railY(T, k, xt, yt, zt, x, z);
  }
  // the same, once rail k at block (xt, yt, zt) has been found for the cart
  function railY(T, k, xt, yt, zt, x, z) {
    var ex = EXITS[T.shape[k]], e0 = ex[0], e1 = ex[1];
    var x0 = xt + 0.5 + e0[0] * 0.5, y0 = yt + 0.0625 + e0[1] * 0.5, z0 = zt + 0.5 + e0[2] * 0.5;
    var x1 = xt + 0.5 + e1[0] * 0.5, y1 = yt + 0.0625 + e1[1] * 0.5, z1 = zt + 0.5 + e1[2] * 0.5;
    var xD = x1 - x0, yD = (y1 - y0) * 2.0, zD = z1 - z0, progress;
    if (xD === 0.0) progress = z - zt;
    else if (zD === 0.0) progress = x - xt;
    else progress = ((x - x0) * xD + (z - z0) * zD) * 2.0;
    var yy = y0 + yD * progress;
    if (yD < 0.0) yy += 1; else if (yD > 0.0) yy += 0.5;
    return yy;
  }

  // Collisions (C1-C5). On these tracks every other block is a rail, sits below the cart's
  // feet, or is beside the track outside its hitbox, so the only block a cart can run into
  // is the conductor behind a standing start (T.stop), when it rolls back to the start. A move
  // is cut short against its box exactly as the game's collide() and move() do.
  function findIndex(lo, hi, v) { return v < lo ? -1 : v < hi ? 0 : 1; }
  function voxelCollide(s, axis, box, distance) {
    if (Math.abs(distance) < EPS) return 0.0;
    var b = axis === 0 ? 1 : 0, cx = axis === 2 ? 1 : 2;
    var minA = box[axis], maxA = box[axis + 3];
    var aMin = findIndex(s[axis], s[axis + 3], minA + EPS);
    var aMax = findIndex(s[axis], s[axis + 3], maxA - EPS);
    var bMin = Math.max(0, findIndex(s[b], s[b + 3], box[b] + EPS));
    var bMax = Math.min(1, findIndex(s[b], s[b + 3], box[b + 3] - EPS) + 1);
    var cMin = Math.max(0, findIndex(s[cx], s[cx + 3], box[cx] + EPS));
    var cMax = Math.min(1, findIndex(s[cx], s[cx + 3], box[cx + 3] - EPS) + 1);
    if (!(bMin < bMax && cMin < cMax)) return distance;
    var nd;
    if (distance > 0.0) {
      if (aMax + 1 <= 0) { nd = s[axis] - maxA; if (nd >= -EPS) distance = Math.min(distance, nd); }
      return distance;
    }
    if (aMin - 1 >= 0) { nd = s[axis + 3] - minA; if (nd <= EPS) distance = Math.max(distance, nd); }
    return distance;
  }
  // The move collisions allow, or null when nothing is in the way.
  function collide(T, c, dx, dz) {
    if (dx * dx + dz * dz === 0.0) return null;
    var bb = [c.x - HALF_W, c.y, c.z - HALF_W, c.x + HALF_W, c.y + HEIGHT, c.z + HALF_W];
    var a0 = bb[0], a2 = bb[2], a3 = bb[3], a5 = bb[5];
    if (dx < 0.0) a0 += dx; else if (dx > 0.0) a3 += dx;
    if (dz < 0.0) a2 += dz; else if (dz > 0.0) a5 += dz;
    var s = T.stop;
    if (!(a0 < s[3] && a3 > s[0] && bb[1] < s[4] && bb[4] > s[1] && a2 < s[5] && a5 > s[2])) return null;
    var res = [0.0, 0.0, 0.0], want = [dx, 0.0, dz];
    var order = Math.abs(dx) < Math.abs(dz) ? [1, 2, 0] : [1, 0, 2];
    for (var i = 0; i < 3; i++) {
      var axis = order[i], m = want[axis];
      if (m !== 0.0) {
        var box = [bb[0] + res[0], bb[1] + res[1], bb[2] + res[2], bb[3] + res[0], bb[4] + res[1], bb[5] + res[2]];
        res[axis] = Math.abs(m) < EPS ? 0.0 : voxelCollide(s, axis, box, m);
      }
    }
    return res;
  }

  // One game tick for a cart on the rails (M4). c = {x, y, z, vx, vz}; false = off the rails.
  // (Vertical speed never affects a cart on rails, so it is left out; the track is dry.)
  function tick(T, c) {
    var px = Math.floor(c.x), py = Math.floor(c.y), pz = Math.floor(c.z);
    var k = railIndex(T, px, py - 1, pz);                  // rail lookup (M6)
    if (k >= 0) py = py - 1;
    else { k = railIndex(T, px, py, pz); if (k < 0) return false; }
    var shape = T.shape[k], kind = T.kind[k];
    var oldY = railY(T, k, px, py, pz, c.x, c.z);          // track height before (R10), from the lookup above
    var y = py, power = kind === KIND_ON, halt = kind === KIND_OFF;
    var slide = 0.0078125;                                  // slope pull (R3)
    if (shape === 2) { c.vx += -slide; y += 1; }
    else if (shape === 3) { c.vx += slide; y += 1; }
    else if (shape === 4) { c.vz += slide; y += 1; }
    else if (shape === 5) { c.vz += -slide; y += 1; }
    var ex = EXITS[shape], e0 = ex[0], e1 = ex[1];          // steering (R4)
    var xD = e1[0] - e0[0], zD = e1[2] - e0[2];
    var length = Math.sqrt(xD * xD + zD * zD);
    if (c.vx * xD + c.vz * zD < 0.0) { xD = 0 - xD; zD = 0 - zD; }
    var pw = Math.min(2.0, Math.sqrt(c.vx * c.vx + c.vz * c.vz));
    c.vx = pw * xD / length; c.vz = pw * zD / length;
    if (halt) {                                             // halt rail (P3)
      if (Math.sqrt(c.vx * c.vx + c.vz * c.vz) < 0.03) { c.vx = 0.0; c.vz = 0.0; }
      else { c.vx = c.vx * 0.5; c.vz = c.vz * 0.5; }
    }
    var x0 = px + 0.5 + e0[0] * 0.5, z0 = pz + 0.5 + e0[2] * 0.5;      // centring (R5)
    var x1 = px + 0.5 + e1[0] * 0.5, z1 = pz + 0.5 + e1[2] * 0.5;
    var cxD = x1 - x0, czD = z1 - z0, progress;
    if (cxD === 0.0) progress = c.z - pz;
    else if (czD === 0.0) progress = c.x - px;
    else progress = ((c.x - x0) * cxD + (c.z - z0) * czD) * 2.0;
    c.x = x0 + cxD * progress; c.y = y; c.z = z0 + czD * progress;
    var sc = T.loaded ? 0.75 : 1.0;                         // a rider shortens every move (B1)
    var dx = Math.min(Math.max(sc * c.vx, -0.4), 0.4);      // move cap (R6)
    var dz = Math.min(Math.max(sc * c.vz, -0.4), 0.4);
    var hit = T.stop ? collide(T, c, dx, dz) : null;
    if (hit === null) { c.x = c.x + dx; c.y = c.y + 0.0; c.z = c.z + dz; }
    else {
      var mx = hit[0], mz = hit[2], mlen = mx * mx + mz * mz, dlen = dx * dx + dz * dz;
      if (mlen > 1.0e-7 || dlen - mlen < 1.0e-7) { c.x = c.x + mx; c.y = c.y + 0.0; c.z = c.z + mz; }   // C4
      if (!(Math.abs(mx - dx) < F_1E5)) c.vx = -c.vx * 0.0;   // a blocked axis loses its speed (C5)
      if (!(Math.abs(mz - dz) < F_1E5)) c.vz = -c.vz * 0.0;
    }
    if (e0[1] !== 0 && Math.floor(c.x) - px === e0[0] && Math.floor(c.z) - pz === e0[2]) c.y = c.y + e0[1];   // R7
    else if (e1[1] !== 0 && Math.floor(c.x) - px === e1[0] && Math.floor(c.z) - pz === e1[2]) c.y = c.y + e1[1];
    var fr = T.loaded ? 0.997 : 0.96;                       // rail friction (R8), less with a rider (B2)
    c.vx = c.vx * fr; c.vz = c.vz * fr;
    var newY = getPosY(T, c.x, c.y, c.z);                   // height and speed (R10)
    if (newY === newY && oldY === oldY) {
      var sp = (oldY - newY) * 0.05;
      var op = Math.sqrt(c.vx * c.vx + c.vz * c.vz);
      if (op > 0.0) { var kk = (op + sp) / op; c.vx = c.vx * kk; c.vz = c.vz * kk; }
      c.y = newY;
    }
    var xn = Math.floor(c.x), zn = Math.floor(c.z);         // new block (R11)
    if (xn !== px || zn !== pz) {
      var op2 = Math.sqrt(c.vx * c.vx + c.vz * c.vz);
      c.vx = op2 * (xn - px); c.vz = op2 * (zn - pz);
    }
    if (power) {                                            // boost (P1), standing start (P2)
      var sl = Math.sqrt(c.vx * c.vx + c.vz * c.vz);
      if (sl > 0.01) { c.vx = c.vx + c.vx / sl * 0.06; c.vz = c.vz + c.vz / sl * 0.06; }
      else if (shape === 1) {
        if (isConductor(T, px - 1, py, pz)) c.vx = 0.02;
        else if (isConductor(T, px + 1, py, pz)) c.vx = -0.02;
      } else if (shape === 0) {
        if (isConductor(T, px, py, pz - 1)) c.vz = 0.02;
        else if (isConductor(T, px, py, pz + 1)) c.vz = -0.02;
      }
    }
    return true;
  }

  /* ---------- layouts ---------- */
  // tokens: start S / Dr / Dp, then <F|U|D><r|p|h> per rail, then E (the parking slope)
  function parse(code) {
    var t = String(code).trim().split(/\s+/);
    if (t.length < 2 || ['S', 'Dr', 'Dp'].indexOf(t[0]) < 0 || t[t.length - 1] !== 'E') throw new Error('bad layout code: ' + code);
    var blocks = [{ s: t[0] === 'S' ? 'F' : 'D', k: t[0] === 'S' ? 'p' : t[0][1] }];
    for (var i = 1; i < t.length - 1; i++) {
      if (!/^[FUD][rph]$/.test(t[i])) throw new Error('bad rail "' + t[i] + '" in ' + code);
      blocks.push({ s: t[i][0], k: t[i][1] });
    }
    blocks.push({ s: 'U', k: 'h' });
    return { start: t[0], blocks: blocks };
  }
  function pairOk(a, b) {
    if (a.s === 'U' && b.s === 'D') return false;           // a peak needs a flat rail on top
    if ((a.k === 'p' && b.k === 'h') || (a.k === 'h' && b.k === 'p')) return false;   // they'd share power (P6)
    return true;
  }
  function levels(blocks) {
    var out = [], e = 0;
    for (var i = 0; i < blocks.length; i++) {
      var s = blocks[i].s;
      if (s === 'D') { e -= 1; out.push(e); } else { out.push(e); if (s === 'U') e += 1; }
    }
    return out;
  }
  function shapeOf(f, s) { return s === 'F' ? f.flat : s === 'U' ? f.up : f.down; }
  // The loading run of a boat track. The cart is placed on its top
  // slope, picks the boat up on the second, is sped up by a third and stops dead against the
  // stopper; breaking the glass under its last rail drops it onto the start rail. It comes
  // from behind the start or from in front of it; in front it runs above the track, as high as
  // it has to be to clear it (loader_level). `put`, `at` and `g` come from build().
  var DIR = { '1,0': 'east', '-1,0': 'west', '0,1': 'south', '0,-1': 'north' };
  function addLoader(put, at, g, f, stopper, approach, ys, L, origin) {
    var GLASS = 'minecraft:white_stained_glass', CONCRETE = 'minecraft:white_concrete';
    var S = STOPPERS[stopper], sgn = approach === 'front' ? 1 : -1, base = ys[0];
    var last = S.mode === 'side' ? 0 : 1;
    var slope = SHAPE_NAMES[approach === 'front' ? f.up : f.down], flat = SHAPE_NAMES[f.flat];
    function ua(u, y, side) { return at(sgn * u, y, side); }
    function cells(level) {
      var out = [];
      LOADER.RUN.forEach(function (r) {
        if (r[0] < last) return;
        out.push({ p: ua(r[0], base + level + r[1]), name: 'minecraft:rail', props: { shape: r[2] === 'slope' ? slope : flat, waterlogged: 'false' } });
        out.push({ p: ua(r[0], base + level + r[1] - 1), name: GLASS, props: {} });
      });
      out.push({ p: ua(LOADER.CAP, base + level + 2), name: GLASS, props: {} });
      out.push({ p: ua(LOADER.CAP, base + level + 3), name: 'minecraft:rail', props: { shape: flat, waterlogged: 'false' } });
      if (S.mode === 'side') {
        if (S.bud) {                             // grown out of a block beside the track, across it
          out.push({ p: ua(-1, base + level, 1), name: CONCRETE, props: {}, role: 'support' });
          out.push({ p: ua(-1, base + level), name: S.block, props: { facing: DIR[(-f.lu) + ',' + (-f.lv)], waterlogged: 'false' }, role: 'stopper' });
        } else out.push({ p: ua(-1, base + level), name: S.block, props: {}, role: 'stopper' });
      } else {                                   // grown back out of the block past the drop block
        out.push({ p: ua(-1, base + level), name: CONCRETE, props: {}, role: 'support' });
        out.push({ p: ua(0, base + level), name: S.block, props: { facing: DIR[(sgn * f.du) + ',' + (sgn * f.dv)], waterlogged: 'false' }, role: 'stopper' });
      }
      return out;
    }
    // the top of the cart's hitbox over each rail, felt in its own column and both beside it
    var reach = {};
    L.blocks.forEach(function (b, k) {
      var top = (ys[k] - base) + (b.s === 'F' ? 0.7625 : 1.7625);
      for (var c = k - 1; c <= k + 1; c++) reach[c] = Math.max(reach[c] === undefined ? -1e9 : reach[c], top);
    });
    var ox = origin[0], oy = origin[1], oz = origin[2], level = LOADER.LEVEL, list;
    for (;;) {
      list = cells(level);
      var clear = list.every(function (c) {
        if (g[c.p.join(',')]) return false;
        var dx = c.p[0] - ox, dz = c.p[2] - oz, k = dx * f.du + dz * f.dv, side = dx * f.lu + dz * f.lv;
        return side !== 0 || c.p[1] - oy - base >= (reach[k] === undefined ? -1e9 : reach[k]);
      });
      if (clear) break;
      level++;
    }
    var stop = null, support = null;
    list.forEach(function (c) {
      put(c.p, c.name, c.props, true);
      if (c.role === 'stopper') stop = c.p;
      if (c.role === 'support') support = c.p;
    });
    // where the loaded cart stops, and the line it rolls along from the top slope to there
    var a0 = f.du ? ox : oz, s = f.du || f.dv, frac = boatFrac(stopper, f.name, approach);
    var y0 = oy + base + level;
    function pt(u, y) {                          // u may be fractional: the loader's centre line
      var a = a0 + 0.5 + s * sgn * u;
      return f.du ? [a, y, oz + 0.5] : [ox + 0.5, y, a];
    }
    var stopAt = f.du ? [a0 + frac, y0 + (S.mode === 'side' ? 0.0625 : 0.0), oz + 0.5]
                      : [ox + 0.5, y0 + (S.mode === 'side' ? 0.0625 : 0.0), a0 + frac];
    var path = [pt(LOADER.FIRST, y0 + 2.5625), pt(9.5, y0 + 2.0625), pt(8.5, y0 + 1.0625), pt(6.5, y0 + 1.0625), pt(5.5, y0 + 0.0625)];
    if (S.mode === 'tip') path.push(pt(0.5, y0 + 0.0625), pt(0.5, y0));
    path.push(stopAt);
    var boatRail = ua(LOADER.BOAT_U, base + level + 1);
    return {
      stopper: stopper, approach: approach, mode: S.mode, level: level,
      start: ua(LOADER.FIRST, base + level + 2),                   // place the minecart here
      boatRail: boatRail,
      boat: [boatRail[0] + 0.5, boatRail[1], boatRail[2] + 0.5],   // the boat's own spot
      stop: stop, support: support,
      breakGlass: ua(last, base + level - 1),                      // break this to drop the cart
      lastRail: ua(last, base + level),
      stopAt: stopAt, path: path, frac: frac
    };
  }

  // How the cart starts (opt.how): 'hand', placed on rail 0 (M3); 'loader', dropped onto rail 0
  // at rest when the glass under the loading run's last rail is broken; or 'fly', launched into a
  // stopper in mid-air, where it stops dead and falls onto rail 0 (launchRun). The last two leave
  // it at rest on rail 0 at the stopper's fraction (boatFrac). opt.boat: a boat rides in it (B1, B2).
  function startHow(opt) { return opt && opt.how ? opt.how : opt && opt.boat ? 'loader' : 'hand'; }
  function setStart(T, start, facing, opt) {
    var f = T.f;
    T.loaded = !!(opt && opt.boat);
    T.conductorBehind = start === 'S';
    T.startAt = startHow(opt) === 'hand' ? null : boatFrac((opt && opt.stopper) || 'block', facing, (opt && opt.approach) || 'behind');
    T.stop = T.conductorBehind ? cellBox([T.X - f.du, T.Y, T.Z - f.dv], 'minecraft:white_concrete') : null;
  }
  /* The launcher: FarCoolHat's way of stopping a cart, with no block to break. The cart runs off
     the foot of a powered slope, stops dead in mid-air against the stopper (C5) and falls
     straight down onto the start rail, which catches it (M6): at rest at the stopper's fraction,
     the state the loader's drop gives, so the search is the same (boatFrac). An empty cart goes
     straight on the launch slope; a boat cart first runs the loader's pickup section (two slopes,
     the boat on the flat after them), then two more flats. A side-on stopper stands level with the
     slope's foot right past the drop cell (the cell over the start rail); a tip-first bud stands
     in the drop cell with an empty cell before it, level with the foot, or one block lower for an
     empty cart's small or medium bud, as FarCoolHat's: where the falling cart meets its face.
     launchRun() runs it all in full. `put`, `at` and `g` come from build(). */
  var LAUNCH = {
    GEOM: {   // [empty cells before the drop cell, levels below the launch slope's foot], per cart
      empty: { block: [0, 0], honey: [0, 0], bud_side: [0, 0], small_side: [0, 0], small_tip: [1, 1], medium_tip: [1, 1], large_tip: [1, 0], cluster_tip: [1, 0] },
      boat: { block: [0, 0], honey: [0, 0], bud_side: [0, 0], small_side: [0, 0], small_tip: [1, 0], medium_tip: [1, 0], large_tip: [1, 0], cluster_tip: [1, 0] } },
    // rails from where the cart is placed down to the launch slope: [steps before the launch slope, level, slope?, powered?]
    EMPTY: [[0, 0, true, true]],
    BOAT: [[5, 2, true, false], [4, 1, true, false], [3, 1, false, false], [2, 1, false, false], [1, 1, false, false], [0, 0, true, true]],
    BOAT_RAIL: 2 };                               // the boat waits on this rail of BOAT
  var DIRV = { east: [1, 0], west: [-1, 0], south: [0, 1], north: [0, -1] };
  function addLauncher(put, at, g, f, stopper, approach, ys, L, origin, boat) {
    var GLASS = 'minecraft:white_stained_glass', CONCRETE = 'minecraft:white_concrete';
    var S = STOPPERS[stopper], sgn = approach === 'front' ? 1 : -1, base = ys[0];
    var geo = LAUNCH.GEOM[boat ? 'boat' : 'empty'][stopper], u0 = 1 + geo[0], drop = geo[1], R = boat ? LAUNCH.BOAT : LAUNCH.EMPTY;
    var slope = SHAPE_NAMES[approach === 'front' ? f.up : f.down], flat = SHAPE_NAMES[f.flat];
    var away = FACINGS[DIR[(-sgn * f.du) + ',' + (-sgn * f.dv)]];     // the way the cart goes: towards the stopper
    function ua(u, y, side) { return at(sgn * u, y, side); }
    function cells(level) {
      var out = [], lever = LEVER_FACING[(-f.lu) + ',' + (-f.lv)];
      R.forEach(function (r, i) {
        var p = ua(u0 + r[0], base + level + r[1]);
        out.push({ p: p, name: r[3] ? 'minecraft:powered_rail' : 'minecraft:rail',
                   props: r[3] ? { shape: r[2] ? slope : flat, waterlogged: 'false', powered: 'true' } : { shape: r[2] ? slope : flat, waterlogged: 'false' } });
        out.push({ p: ua(u0 + r[0], base + level + r[1] - 1), name: GLASS, props: {} });
      });
      var top = R[0];                                 // the top slope's high side: a block, and a rail to shape it
      out.push({ p: ua(u0 + top[0] + 1, base + level + top[1]), name: GLASS, props: {} });
      out.push({ p: ua(u0 + top[0] + 1, base + level + top[1] + 1), name: 'minecraft:rail', props: { shape: flat, waterlogged: 'false' } });
      out.push({ p: ua(u0, base + level, -1), name: CONCRETE, props: {} });      // powers the launch slope
      out.push({ p: ua(u0, base + level, -2), name: 'minecraft:lever', props: { face: 'wall', facing: lever, powered: 'true' } });
      var sy = base + level - drop;
      if (S.mode === 'side') {
        if (S.bud) {                                  // grown out of a block beside the track, across it
          out.push({ p: ua(-1, sy, 1), name: CONCRETE, props: {}, role: 'support' });
          out.push({ p: ua(-1, sy), name: S.block, props: { facing: DIR[(-f.lu) + ',' + (-f.lv)], waterlogged: 'false' }, role: 'stopper' });
        } else out.push({ p: ua(-1, sy), name: S.block, props: {}, role: 'stopper' });
      } else {                                        // in the drop cell, grown back out of the block past it
        out.push({ p: ua(-1, sy), name: CONCRETE, props: {}, role: 'support' });
        out.push({ p: ua(0, sy), name: S.block, props: { facing: DIR[(sgn * f.du) + ',' + (sgn * f.dv)], waterlogged: 'false' }, role: 'stopper' });
      }
      return out;
    }
    // high enough that the track's carts pass under it, as the loader (the top of a cart over each rail)
    var reach = {};
    L.blocks.forEach(function (b, k) {
      var top = (ys[k] - base) + (b.s === 'F' ? 0.7625 : 1.7625);
      for (var c = k - 1; c <= k + 1; c++) reach[c] = Math.max(reach[c] === undefined ? -1e9 : reach[c], top);
    });
    var ox = origin[0], oy = origin[1], oz = origin[2], level = LOADER.LEVEL, list;
    for (;;) {
      list = cells(level);
      var clear = list.every(function (c) {
        if (g[c.p.join(',')]) return false;
        var dx = c.p[0] - ox, dz = c.p[2] - oz, k = dx * f.du + dz * f.dv, side = dx * f.lu + dz * f.lv;
        return side !== 0 || c.p[1] - oy - base >= (reach[k] === undefined ? -1e9 : reach[k]);
      });
      if (clear) break;
      level++;
    }
    var roles = {};
    list.forEach(function (c) { put(c.p, c.name, c.props, true); if (c.role) roles[c.role] = c.p; });
    var pl = ua(u0 + R[0][0], base + level + R[0][1]), boatAt = boat ? ua(u0 + R[LAUNCH.BOAT_RAIL][0], base + level + R[LAUNCH.BOAT_RAIL][1]) : null;
    // the launcher as a straight track of its own, in the cart's direction (for launchRun)
    var first = R[0], entry = ua(u0 + first[0], base + level + first[1] + (first[2] ? 1 : 0)), rails = [];
    R.forEach(function (r) {
      rails.push({ shape: r[2] ? away.down : away.flat, kind: r[3] ? KIND_ON : KIND_PLAIN, level: (base + level + r[1]) - (entry[1] - oy) });
    });
    var a0 = f.du ? ox : oz, frac = boatFrac(stopper, f.name, approach);
    return {
      how: 'fly', stopper: stopper, approach: approach, mode: S.mode, level: level, gap: geo[0], drop: drop,
      start: pl,                                      // place the minecart on this rail
      place: [pl[0] + 0.5, pl[1] + 0.0625 + (first[2] ? 0.5 : 0.0), pl[2] + 0.5],   // where it spawns (M3)
      boatRail: boatAt, boat: boatAt ? [boatAt[0] + 0.5, boatAt[1], boatAt[2] + 0.5] : null,
      launchRail: ua(u0, base + level), power: ua(u0, base + level, -1), lever: ua(u0, base + level, -2),
      stop: roles.stopper, support: roles.support || null,
      stopAt: f.du ? [a0 + frac, base + oy + level - drop, oz + 0.5] : [ox + 0.5, base + oy + level - drop, a0 + frac], frac: frac,
      track: { origin: [entry[0], entry[1], entry[2]], facing: away.name, rails: rails }
    };
  }

  function trackFromCode(code, origin, facing, opt) {
    var L = parse(code), f = FACINGS[facing], ys = levels(L.blocks);
    var T = newTrack(origin, facing, L.blocks.length);
    for (var i = 0; i < L.blocks.length; i++) {
      T.shape[i] = shapeOf(f, L.blocks[i].s); T.kind[i] = KINDS[L.blocks[i].k]; T.level[i] = ys[i];
    }
    T.n = L.blocks.length;
    setStart(T, L.start, facing, opt);
    return { T: T, L: L, ys: ys };
  }
  function spawnCart(T) {
    var f = T.f, y0 = T.Y + T.level[0], slope = T.shape[0] >= 2;
    if (T.startAt === null) {
      // minecart item on rail 0: centre, 1/16 up, half a block higher on a slope (M3)
      return { x: T.X + 0.5, y: y0 + 0.0625 + (slope ? 0.5 : 0.0), z: T.Z + 0.5, vx: 0.0, vz: 0.0 };
    }
    // boat cart: the loader drops it onto rail 0 at rest, at the stopper's fraction (B3).
    // The landing tick only snaps it to the rail line, so the run starts from this state.
    var c = { x: T.X + (f.du ? T.startAt : 0.5), y: y0 + 0.0625, z: T.Z + (f.dv ? T.startAt : 0.5),
              vx: 0.0, vz: 0.0 };
    var yy = getPosY(T, c.x, c.y, c.z);
    if (yy === yy) c.y = yy;
    return c;
  }

  /* ---------- boat carts ----------
     A cart that carries a boat cannot be placed by hand: it has to pick the boat up while it
     rolls, and then stop dead against a stopper so that what comes next is exact. The loader
     or the launcher above, hands the track a cart
     at rest on the start rail, at the fraction below, with these two changes to its physics:
       B1 every move is 0.75 x the speed, B2 it keeps 99.7% of its speed a tick, not 96%
       (OldMinecartBehavior, both keyed on isVehicle()).
       B3 the stop is the face the cart meets, less half a cart width (C5). Side on, the
       stopper fills the block past the last rail and the face is `depth` into it: 0 for a
       full block, 1/16 for honey (C10), and for a bud growing across the track its
       (16 - width) / 2 sixteenths: 3/16 for medium, large and cluster (all 10/16 wide), 4/16
       for small (8/16). Tip first, a bud stands in the drop block pointing back at the cart,
       and the face is its length short of the far side: 3, 4, 5 or 7 sixteenths (C11).
       From in front of the start the cart rolls the other way, which mirrors the fraction.
     Simulated in full, the stop can come out a unit or two in the last place off this, which
     changes the parked position by at most its last digit (launchRun shows it for the launcher). */
  var BUDS = { small_amethyst_bud: [3, 8], medium_amethyst_bud: [4, 10], large_amethyst_bud: [5, 10], amethyst_cluster: [7, 10] };
  var STOPPERS = {
    block: { block: 'minecraft:white_concrete', mode: 'side' },
    honey: { block: 'minecraft:honey_block', mode: 'side' },
    bud_side: { block: 'minecraft:medium_amethyst_bud', mode: 'side' },    // large or cluster: the same face
    small_side: { block: 'minecraft:small_amethyst_bud', mode: 'side' },
    small_tip: { block: 'minecraft:small_amethyst_bud', mode: 'tip' },
    medium_tip: { block: 'minecraft:medium_amethyst_bud', mode: 'tip' },
    large_tip: { block: 'minecraft:large_amethyst_bud', mode: 'tip' },
    cluster_tip: { block: 'minecraft:amethyst_cluster', mode: 'tip' }
  };
  Object.keys(STOPPERS).forEach(function (k) {
    var st = STOPPERS[k], b = BUDS[st.block.replace('minecraft:', '')];
    st.bud = !!b;
    st.depth = b ? (st.mode === 'tip' ? b[0] / 16.0 : (16.0 - b[1]) / 2.0 / 16.0)
      : st.block === 'minecraft:honey_block' ? 0.0625 : 0.0;
  });
  var APPROACHES = ['behind', 'front'];
  // the loading run, in steps u from the start rail towards its far end, levels above L
  var LOADER = { LEVEL: 3, FIRST: 10, BOAT_U: 8, CAP: 11,
    RUN: [[10, 2, 'slope'], [9, 1, 'slope'], [8, 1, 'flat'], [7, 1, 'flat'], [6, 0, 'slope'],
          [5, 0, 'flat'], [4, 0, 'flat'], [3, 0, 'flat'], [2, 0, 'flat'], [1, 0, 'flat'], [0, 0, 'flat']] };
  function boatFrac(stopper, facing, approach) {
    var st = STOPPERS[stopper];
    if (!st) throw new Error('unknown stopper: ' + stopper);
    var f = FACINGS[facing], positive = (f.du + f.dv) > 0;
    if (approach === 'front') positive = !positive;
    var d = st.depth;
    var v = st.mode === 'side' ? (positive ? 1.0 + d - HALF_W : 0.0 - d + HALF_W)
                               : (positive ? (1.0 - d) - HALF_W : d + HALF_W);
    return v - Math.floor(v);
  }
  function along(T, c) {
    var f = T.f;
    return f.du !== 0 ? (Math.floor(c.x) - T.X) * f.du : (Math.floor(c.z) - T.Z) * f.dv;
  }

  // Reasons a layout can't be built as written (empty = buildable), as check_rules()
  function problems(blocks) {
    var bad = [];
    for (var i = 1; i < blocks.length; i++) {
      var a = blocks[i - 1], b = blocks[i];
      if (a.s === 'U' && b.s === 'D') bad.push('rail ' + i + ': a peak needs a flat rail on top');
      if ((a.k === 'p' && b.k === 'h') || (a.k === 'h' && b.k === 'p')) bad.push('rail ' + i + ': ON and OFF powered rails touch');
    }
    return bad;
  }

  // Full run of a layout, like floatcart_layouts.run(): until the cart sits still on the
  // parking slope. Returns {ok, x, y, z, ticks, yfrac, path}.
  function run(code, origin, facing, wantPath, maxTicks, opt) {
    if (startHow(opt) === 'fly') return launchRun(code, origin, facing, wantPath, maxTicks, opt);
    var tr = trackFromCode(code, origin, facing, opt), T = tr.T, last = T.n - 1;
    var bad = problems(tr.L.blocks);
    if (bad.length) return { ok: false, why: 'not buildable: ' + bad.join('; ') };
    maxTicks = maxTicks || 20000;
    var c = spawnCart(T), still = 0, px = NaN, py = NaN, pz = NaN, path = wantPath ? [[c.x, c.y, c.z, 0]] : null;
    for (var t = 1; t <= maxTicks; t++) {
      var k = railAt(T, c);
      if (!tick(T, c)) return { ok: false, why: 'left the rails at tick ' + t };
      if (path) path.push([c.x, c.y, c.z, k]);
      var same = c.x === px && c.y === py && c.z === pz;
      if (same && along(T, c) === last) {
        if (++still >= 3) {
          var yp = T.Y + T.level[last];
          if (path) path.length -= 3;
          return { ok: true, x: c.x, y: c.y, z: c.z, ticks: t - 3, yfrac: c.y - yp, path: path };
        }
      } else still = 0;
      px = c.x; py = c.y; pz = c.z;
    }
    return { ok: false, why: 'never parked' };
  }
  function railAt(T, c) {
    var px = Math.floor(c.x), py = Math.floor(c.y), pz = Math.floor(c.z);
    var k = railIndex(T, px, py - 1, pz);
    return k >= 0 ? k : railIndex(T, px, py, pz);
  }

  // Breaking the parking rail under a parked cart (M5, F1-F3, C3-C5). A parked cart has no
  // speed, so it falls straight down: x and z never change. It lands on the highest block
  // under its hitbox (the glass under a rail, or the stopper past the parking slope), unless
  // that block's top is less than about 0.0003 below it: a move cut that short is not made
  // at all (C4), so the cart stays where it is. Returns the y it ends at; ys, if given, gets the
  // y after each tick until the cart comes to rest (for the 3D view).
  var F_095 = Math.fround(0.95);
  function dropY(code, origin, facing, c, opt, ys) {
    var T = trackFromCode(code, origin, facing, opt).T, f = T.f, n = T.n;
    var a = f.du !== 0 ? c.x : c.z, o = f.du !== 0 ? T.X : T.Z, s = f.du !== 0 ? f.du : f.dv;
    var tops = [];
    for (var k = -1; k <= n; k++) {
      var j = s > 0 ? o + k : o - k;                  // track column k spans [j, j + 1] on the axis
      if (!(a - HALF_W + EPS < j + 1 && a + HALF_W - EPS >= j)) continue;
      if (k >= 0 && k < n) tops.push(T.Y + T.level[k]);    // glass under rail k
      if (k === n) tops.push(T.Y + T.level[n - 1] + 1);    // stopper glass
    }
    var y = c.y, vy = 0.0, onGround = false;
    for (var t = 0; t < 400; t++) {
      vy += -0.04;                                    // gravity (M5)
      if (onGround) vy = vy * 0.5;                    // ground friction (F2)
      var dy = vy, my = dy;
      if (dy * dy !== 0.0) {
        var dist = dy, hit = false;
        for (var i = 0; i < tops.length; i++) {
          var top = tops[i], bot = top - 1;
          var inArea = dy < 0.0 ? (y + dy < top && y + HEIGHT > bot) : (y < top && y + HEIGHT + dy > bot);
          if (!inArea) continue;
          hit = true;
          if (Math.abs(dist) < EPS) { dist = 0.0; break; }
          var aMin = findIndex(bot, top, y + EPS), aMax = findIndex(bot, top, y + HEIGHT - EPS), nd;
          if (dist > 0.0) { if (aMax + 1 <= 0) { nd = bot - (y + HEIGHT); if (nd >= -EPS) dist = Math.min(dist, nd); } }
          else if (aMin - 1 >= 0) { nd = top - y; if (nd <= EPS) dist = Math.max(dist, nd); }
        }
        if (hit) my = Math.abs(dist) < EPS ? 0.0 : dist;
      }
      var mlen = my * my, dlen = dy * dy;
      if (mlen > 1.0e-7 || dlen - mlen < 1.0e-7) y = y + my;    // C4
      var vcol = dy !== my;
      onGround = vcol && dy < 0.0;
      if (Math.abs(dy) > 0.0 && vcol) vy = (0.0 - vy) * 1.0 * 0.0;   // C5
      if (!onGround) vy = vy * F_095;                 // air drag (F3)
      if (ys) ys.push(y);
    }
    if (ys) { while (ys.length > 1 && ys[ys.length - 2] === y) ys.pop(); if (ys.length === 1 && ys[0] === c.y) ys.pop(); }
    return y;
  }

  /* ---------- off the rails: flying into a stopper ----------
     A cart that runs off the end of a rail flies (M5, F1-F3) until it meets a block. That is how
     FarCoolHat's build stops its cart: it flies into a bud, stops dead in mid-air (C5) and falls
     straight down, and a rail under it catches it (M6). These are the rules for that, among the
     boxes of a few blocks (W.boxes, world coordinates) and the rails of W.tracks (straight tracks
     as above); they give ticks 7 to 18 of the challenge's as-built run to the last digit. */
  var F_098 = Math.fround(0.98);
  function railTrack(W, c) {                      // the track whose rail the cart rides, if any (M6)
    var x = Math.floor(c.x), y = Math.floor(c.y), z = Math.floor(c.z), i;
    for (i = 0; i < W.tracks.length; i++) if (railIndex(W.tracks[i], x, y - 1, z) >= 0) return W.tracks[i];
    for (i = 0; i < W.tracks.length; i++) if (railIndex(W.tracks[i], x, y, z) >= 0) return W.tracks[i];
    return null;
  }
  // The move collisions allow among boxes (C1-C3), as Entity.collide(): each axis in turn, vertical
  // first, against every box the hitbox stretched along the move overlaps (C2, C12)
  function worldMove(boxes, c, dx, dy, dz) {
    var bb = [c.x - HALF_W, c.y, c.z - HALF_W, c.x + HALF_W, c.y + HEIGHT, c.z + HALF_W];
    var sw = bb.slice(), near = [];
    if (dx < 0.0) sw[0] += dx; else if (dx > 0.0) sw[3] += dx;
    if (dy < 0.0) sw[1] += dy; else if (dy > 0.0) sw[4] += dy;
    if (dz < 0.0) sw[2] += dz; else if (dz > 0.0) sw[5] += dz;
    boxes.forEach(function (s) { if (sw[0] < s[3] && sw[3] > s[0] && sw[1] < s[4] && sw[4] > s[1] && sw[2] < s[5] && sw[5] > s[2]) near.push(s); });
    if (!near.length) return [dx, dy, dz];
    var res = [0.0, 0.0, 0.0], want = [dx, dy, dz];
    var order = Math.abs(dx) < Math.abs(dz) ? [1, 2, 0] : [1, 0, 2];
    for (var i = 0; i < 3; i++) {
      var axis = order[i], d = want[axis];
      if (d === 0.0) continue;
      var box = [bb[0] + res[0], bb[1] + res[1], bb[2] + res[2], bb[3] + res[0], bb[4] + res[1], bb[5] + res[2]];
      for (var j = 0; j < near.length; j++) { if (Math.abs(d) < EPS) { d = 0.0; break; } d = voxelCollide(near[j], axis, box, d); }
      res[axis] = d;
    }
    return res;
  }
  // One tick anywhere (M4): gravity, then the rail move if a rail is under the cart (as tick()),
  // or else the flight. c = {x, y, z, vx, vy, vz, ground}. Returns the track ridden, or null.
  function worldTick(W, c) {
    c.vy += -0.04;                                          // gravity (M5)
    var T = railTrack(W, c);
    if (T) { tick(T, c); c.vy = 0.0; c.ground = false; return T; }   // no vertical speed on a rail (R8)
    c.vx = Math.min(Math.max(c.vx, -0.4), 0.4);             // speed cap (F1)
    c.vz = Math.min(Math.max(c.vz, -0.4), 0.4);
    if (c.ground) { c.vx = c.vx * 0.5; c.vy = c.vy * 0.5; c.vz = c.vz * 0.5; }   // ground friction (F2)
    var dx = c.vx, dy = c.vy, dz = c.vz, m = worldMove(W.boxes, c, dx, dy, dz);
    var mlen = m[0] * m[0] + m[1] * m[1] + m[2] * m[2], dlen = dx * dx + dy * dy + dz * dz;
    if (mlen > 1.0e-7 || dlen - mlen < 1.0e-7) { c.x = c.x + m[0]; c.y = c.y + m[1]; c.z = c.z + m[2]; }   // C4
    var ycol = dy !== m[1];
    c.ground = ycol && dy < 0.0;                            // on the ground (C6)
    if (!(Math.abs(m[0] - dx) < F_1E5)) c.vx = -c.vx * 0.0; // a blocked axis loses its speed (C5)
    if (!(Math.abs(m[2] - dz) < F_1E5)) c.vz = -c.vz * 0.0;
    if (Math.abs(dy) > 0.0 && ycol) c.vy = (0.0 - c.vy) * 1.0 * 0.0;
    (W.honey || []).forEach(function (h) { honeySlide(h, c); });   // block effects after the move (M7)
    if (!c.ground) { c.vx = c.vx * F_095; c.vy = c.vy * F_095; c.vz = c.vz * F_095; }   // air drag (F3)
    return null;
  }
  // A cart falling against a honey block's side slides down it (H2); h: the block's corner
  function honeySlide(h, c) {
    var e = 1.0e-5;                                         // the hitbox shrunk for block effects (X2)
    if (!(c.x - HALF_W + e < h[0] + 1 && c.x + HALF_W - e > h[0] && c.y + e < h[1] + 1 && c.y + HEIGHT - e > h[1] &&
          c.z - HALF_W + e < h[2] + 1 && c.z + HALF_W - e > h[2])) return;
    var old = c.vy / F_098 + 0.08, w = 0.4375 + HALF_W;
    if (c.ground || c.y > h[1] + 0.9375 - 1.0e-7 || !(old < -0.08)) return;
    if (!(Math.abs(h[0] + 0.5 - c.x) + 1.0e-7 > w || Math.abs(h[2] + 0.5 - c.z) + 1.0e-7 > w)) return;
    if (old < -0.13) { var s = -0.05 / old; c.vx = c.vx * s; c.vz = c.vz * s; }
    c.vy = (-0.05 - 0.08) * F_098;
  }

  // The launcher, the track and their blocks as one world: both tracks, and every block's box
  function launchWorld(code, origin, facing, opt) {
    var tr = trackFromCode(code, origin, facing, opt), b = build(code, origin, facing, opt), La = b.launcher;
    var TL = newTrack(La.track.origin, La.track.facing, La.track.rails.length), boxes = [], honey = [];
    La.track.rails.forEach(function (r, k) { TL.shape[k] = r.shape; TL.kind[k] = r.kind; TL.level[k] = r.level; });
    TL.n = La.track.rails.length;
    b.blocks.forEach(function (q) {
      var n = q.name.replace('minecraft:', '');
      if (/rail$/.test(n) || n === 'lever') return;              // no collision box (C9)
      boxes.push(cellBox([q.x, q.y, q.z], n, DIRV[q.props.facing] || [0, 0]));
      if (n === 'honey_block') honey.push([q.x, q.y, q.z]);
    });
    return { W: { tracks: [tr.T, TL], boxes: boxes, honey: honey }, T: tr.T, TL: TL, launcher: La, blocks: b };
  }
  // A launched cart in full, as run() for the others: placed on the launcher (M3), launched,
  // stopped against the stopper, caught by the start rail, parked. With a boat, the boat waits
  // somewhere on its rail (q: 0 to 1 along it). Until the cart takes it aboard it is solid for the
  // cart's moves, like a block (C14: the launcher track's stop box); the cart takes it at the end
  // of its first tick within 0.2 of it at over 0.1 blocks a tick, and from then on carries it (B1, B2).
  var F_02 = Math.fround(0.2);
  function launchOnce(code, origin, facing, opt, q, wantPath, maxTicks) {
    var w = launchWorld(code, origin, facing, opt), W = w.W, T = w.T, TL = w.TL, La = w.launcher, f = T.f;
    var c = { x: La.place[0], y: La.place[1], z: La.place[2], vx: 0.0, vy: 0.0, vz: 0.0, ground: false };
    var loaded = q === null, bw = 0, by = 0, dir = 0, va = f.du ? 'vx' : 'vz', last = T.n - 1;
    if (!loaded) {
      T.loaded = false; TL.loaded = false;
      bw = (f.du ? La.boatRail[0] : La.boatRail[2]) + q; by = La.boatRail[1]; dir = TL.f.du || TL.f.dv;
      var bx = f.du ? bw : La.boatRail[0] + 0.5, bz = f.du ? La.boatRail[2] + 0.5 : bw;
      TL.stop = [bx - 0.6875, by, bz - 0.6875, bx + 0.6875, by + 0.5625, bz + 0.6875];   // the boat's box (1.375 wide, 0.5625 high)
    }
    var path = wantPath ? [[c.x, c.y, c.z, -1]] : null, phase = 0, stopTick = 0, landTick = 0, pickTick = 0, still = 0, px = NaN, py = NaN, pz = NaN;
    for (var t = 1; t <= maxTicks; t++) {
      var v0 = c[va], on = worldTick(W, c);
      if (!loaded) {
        var a = f.du ? c.x : c.z, gap = dir * (bw - a) - HALF_W - 0.6875;
        if (c.y < by + 0.5625 && c.y + HEIGHT > by && gap < F_02 && c.vx * c.vx + c.vz * c.vz > 0.01) { loaded = true; T.loaded = true; TL.loaded = true; TL.stop = null; pickTick = t; }
      }
      if (phase === 0 && on !== TL) phase = 1;
      if (phase === 1) {
        if (on === TL) return { ok: false, why: 'it rolls back onto the launcher' };
        if (!stopTick && v0 !== 0.0 && c[va] === 0.0) stopTick = t;
        if (on === T) {
          if (!stopTick) return { ok: false, why: 'it misses the stopper' };
          if (!loaded) return { ok: false, why: 'it never takes the boat aboard' };
          if (along(T, c) !== 0) return { ok: false, why: 'it lands on rail ' + along(T, c) + ', not the start rail' };
          phase = 2; landTick = t;
        } else if (t > 1000) return { ok: false, why: 'it gets stuck before the start rail' };
      }
      if (path) path.push([c.x, c.y, c.z, phase === 2 ? railAt(T, c) : -1]);
      if (phase === 2) {
        var same = c.x === px && c.y === py && c.z === pz;
        if (same && along(T, c) === last) {
          if (++still >= 3) {
            if (path) path.length -= 3;
            return { ok: true, x: c.x, y: c.y, z: c.z, ticks: t - 3, yfrac: c.y - (T.Y + T.level[last]), path: path,
                     stopTick: stopTick, landTick: landTick, pickTick: pickTick, launcher: La };
          }
        } else still = 0;
        px = c.x; py = c.y; pz = c.z;
      }
    }
    return { ok: false, why: 'it never parks' };
  }
  function launchRun(code, origin, facing, wantPath, maxTicks, opt) {
    var bad = problems(parse(code).blocks);
    if (bad.length) return { ok: false, why: 'not buildable: ' + bad.join('; ') };
    var spots = opt && opt.boat ? [0.5, 0.0, 0.25, 0.75, 0.999] : [null], r0 = null;
    for (var i = 0; i < spots.length; i++) {           // wherever the boat was put on its rail, the same end
      var r = launchOnce(code, origin, facing, opt, spots[i], wantPath && i === 0, maxTicks || 20000);
      if (!r.ok) return r;
      if (!r0) r0 = r;
      else if (r.x !== r0.x || r.y !== r0.y || r.z !== r0.z) r0.spread = Math.max(r0.spread || 0, Math.abs(r.x - r0.x), Math.abs(r.y - r0.y), Math.abs(r.z - r0.z));
    }
    return r0;
  }

  function isFloatcart(y) {
    var top = y + HEIGHT, b = Math.floor(top);
    return top > b && top - F_1E5 < b;
  }
  function frac(v) { return v - Math.floor(v); }
  function circDist(a, b) { var d = Math.abs(frac(a) - frac(b)); return Math.min(d, 1 - d); }
  function inRange(f, lo, hi) { return lo <= hi ? f >= lo && f <= hi : f >= lo || f <= hi; }

  /* ---------- brute force ---------- */
  var ALPHABETS = {
    dry: ['Fr', 'Fp', 'Fh', 'Ur', 'Up', 'Uh', 'Dr', 'Dp', 'Dh'],
    plain: ['Fr', 'Fh', 'Ur', 'Uh', 'Dr', 'Dh']
  };
  var MAX_TICKS_BLOCK = 400;

  // One search task, like floatcart_layouts.Search: start + fixed first rails, then every
  // continuation up to `depth` rails after the start. The cart's state at its first tick
  // inside rail k depends only on rails 0..k, so each rail's state is saved and reused by
  // every continuation. What is aimed at: opt.axis 'y' (the parked cart's height), or 'x' /
  // 'z' (its position along the track, kept when the parking rail is broken, see dropY);
  // opt.target is the fraction aimed at, and a result counts as a match when its fraction is
  // in [opt.lo, opt.hi] (wrapping past 1 when lo > hi; default target +- opt.tol). Keeps the
  // `keep` best: closest to the target, or with opt.sort 'short' matches first, shortest first.
  function searchTask(opt) {
    var f = FACINGS[opt.facing], alpha = ALPHABETS[opt.alphabet].map(function (t) { return { s: t[0], k: t[1], t: t }; });
    var cap = opt.depth + 3;
    var T = newTrack(opt.origin, opt.facing, cap);
    setStart(T, opt.start, opt.facing, opt);
    var target = opt.target, keep = opt.keep, top = [], worst = Infinity;
    var stats = { nodes: 0, parked: 0, inside: 0, floats: 0 };
    var minMid = opt.minMid || 0;                          // minMid: shortest track (rails after the start) to end
    var axis = opt.axis || 'y', shortFirst = opt.sort === 'short';
    var tol = opt.tol || 0;
    var lo = opt.lo !== undefined ? opt.lo : frac(target - tol), hi = opt.hi !== undefined ? opt.hi : frac(target + tol);
    var tokens = [];

    function codeNow() { return opt.start + ' ' + tokens.join(' ') + (tokens.length ? ' ' : '') + 'E'; }
    function record(c, parkLevel) {
      stats.parked++;
      var v = axis === 'x' ? c.x : axis === 'z' ? c.z : c.y;
      var d = circDist(v, target), inside = inRange(frac(v), lo, hi);
      if (inside) stats.inside++;
      var fl = isFloatcart(c.y);
      if (fl) stats.floats++;
      if (opt.each) opt.each(codeNow(), c.y);
      var rails = tokens.length + 2;
      var score = shortFirst && inside ? -1000 + rails + d : d;
      if (top.length >= keep && score >= worst) return;
      var code = codeNow();
      for (var i = 0; i < top.length; i++) if (top[i].code === code) return;
      top.push({ code: code, x: c.x, y: c.y, z: c.z, yfrac: c.y - (T.Y + parkLevel), dist: d, inside: inside,
                 float: fl, rails: rails, score: score });
      top.sort(function (a, b) { return a.score - b.score; });
      if (top.length > keep) top.length = keep;
      worst = top.length >= keep ? top[top.length - 1].score : Infinity;
    }
    function copy(c) { return { x: c.x, y: c.y, z: c.z, vx: c.vx, vz: c.vz }; }
    function advance(snap, k) {
      var c = copy(snap), still = 0, py = NaN, pz = NaN, px = NaN;
      for (var t = 0; t < MAX_TICKS_BLOCK; t++) {
        if (!tick(T, c)) return null;
        var bz = along(T, c);
        if (bz > k) return c;
        if (bz < k - 1) return null;
        if (c.x === px && c.y === py && c.z === pz) { if (++still >= 3) return null; } else still = 0;
        px = c.x; py = c.y; pz = c.z;
      }
      return null;
    }
    // Parking on rail k + 1, from the tick t0 that takes the cart into it: the rest of a park() loop
    // whose ticks before t0 all ended in rail k (px, py, pz: where the cart was before t0, NaN at 0).
    function parkFrom(c, k, t0, px, py, pz) {
      var still = 0;
      for (var t = t0; t < MAX_TICKS_BLOCK; t++) {
        if (!tick(T, c)) return null;
        var bz = along(T, c);
        if (bz !== k + 1 && bz !== k) return null;
        if (c.x === px && c.y === py && c.z === pz && bz === k + 1) { if (++still >= 3) return c; }
        else still = 0;
        px = c.x; py = c.y; pz = c.z;
      }
      return null;
    }
    function place(k, b, lvl) { T.shape[k] = shapeOf(f, b.s); T.kind[k] = KINDS[b.k]; T.level[k] = lvl; T.n = k + 1; }
    var parkBlock = { s: 'U', k: 'h' };
    // One node: snap is the cart at its first tick inside rail k. Every tick it spends in rails k - 1
    // and k is the same whatever follows rail k, so those ticks are run once for the parking attempt
    // and all the next rails, and only the tick into rail k + 1 is run for each. Each outcome is the
    // one a park() or advance() from snap gives, tick for tick. A tick depends only on the track and
    // the cart, so a cart that a tick leaves exactly as it was (stopped dead on an OFF rail, mostly)
    // stays so for good: it never reaches rail k + 1, and both would give up; this stops there.
    function expand(k, snap, last, entry) {
      stats.nodes++;
      if (opt.progress && (stats.nodes & 16383) === 0) opt.progress(stats);
      var tryPark = last.k !== 'p' && k >= minMid && pairOk(last, parkBlock), kids = k + 1 <= opt.depth;
      if (!tryPark && !kids) return;
      T.n = k + 1;
      var c = copy(snap), still = 0, px = NaN, py = NaN, pz = NaN, t, bz, crossed = false;
      var sx = 0, sy = 0, sz = 0, svx = 0, svz = 0;           // the cart before the tick that crosses
      for (t = 0; t < MAX_TICKS_BLOCK; t++) {
        sx = c.x; sy = c.y; sz = c.z; svx = c.vx; svz = c.vz;
        if (!tick(T, c)) break;
        bz = along(T, c);
        if (bz > k) { crossed = true; break; }
        if (Object.is(c.x, sx) && Object.is(c.y, sy) && Object.is(c.z, sz) && Object.is(c.vx, svx) && Object.is(c.vz, svz)) break;
        if (bz !== k) tryPark = false;                        // park() fails outside rails k and k + 1
        if (bz < k - 1) kids = false;                         // advance() fails two rails back
        if (c.x === px && c.y === py && c.z === pz) { if (++still >= 3) kids = false; } else still = 0;
        if (!tryPark && !kids) break;
        px = c.x; py = c.y; pz = c.z;
      }
      if (!crossed) return;
      if (tryPark) {                                          // end the track here
        place(k + 1, parkBlock, entry);
        var cp = parkFrom({ x: sx, y: sy, z: sz, vx: svx, vz: svz }, k, t, t ? sx : NaN, t ? sy : NaN, t ? sz : NaN);
        if (cp) record(cp, entry);
        T.n = k + 1;
      }
      if (!kids) return;
      for (var i = 0; i < alpha.length; i++) {                // or add another rail
        var b = alpha[i];
        if (!pairOk(last, b)) continue;
        var lvl = b.s === 'D' ? entry - 1 : entry;
        var nxt = entry + (b.s === 'U' ? 1 : b.s === 'D' ? -1 : 0);
        place(k + 1, b, lvl);
        var c2 = { x: sx, y: sy, z: sz, vx: svx, vz: svz };
        if (tick(T, c2) && along(T, c2) > k) { tokens.push(b.t); expand(k + 1, c2, b, nxt); tokens.pop(); }
        T.n = k + 1;
      }
    }
    // start rail and any fixed first rails
    var b0 = opt.start === 'S' ? { s: 'F', k: 'p' } : { s: 'D', k: opt.start[1] };
    var y0 = b0.s === 'D' ? -1 : 0;
    place(0, b0, y0);
    var c0 = spawnCart(T), last = b0, entry = y0, k = 0;
    for (var j = 0; j < (opt.first || []).length; j++) {
      var tb = opt.first[j], b = { s: tb[0], k: tb[1], t: tb };
      if (!pairOk(last, b)) return { top: top, stats: stats };
      var lvl = b.s === 'D' ? entry - 1 : entry;
      var nxt = entry + (b.s === 'U' ? 1 : b.s === 'D' ? -1 : 0);
      place(k + 1, b, lvl);
      c0 = advance(c0, k);
      if (!c0) return { top: top, stats: stats };
      tokens.push(tb); last = b; entry = nxt; k++;
    }
    expand(k, c0, last, entry);
    return { top: top, stats: stats };
  }

  // Search tasks: every start, split by its first `split` rails, as the Python search does.
  // A task with fixed first rails only ends tracks after them, so one more task per start
  // covers the shorter tracks (unless pythonSplit is set, which copies the Python search).
  function makeTasks(alphabet, starts, depth, split, pythonSplit) {
    var a = ALPHABETS[alphabet], tasks = [], s = Math.min(split, depth);
    starts.forEach(function (st) {
      if (s === 0) { tasks.push({ start: st, first: [], alphabet: alphabet, depth: depth }); return; }
      if (!pythonSplit) tasks.push({ start: st, first: [], alphabet: alphabet, depth: s - 1 });
      (function grow(prefix) {
        if (prefix.length === s) { tasks.push({ start: st, first: prefix, alphabet: alphabet, depth: depth }); return; }
        a.forEach(function (t) { grow(prefix.concat([t])); });
      })([]);
    });
    return tasks;
  }

  /* ---------- blocks for a layout (floatcart_layouts.build, with levers and end caps) ---------- */
  var LEVER_FACING = { '1,0': 'east', '-1,0': 'west', '0,1': 'south', '0,-1': 'north' };
  function build(code, origin, facing, opt) {
    var L = parse(code), f = FACINGS[facing], ys = levels(L.blocks), g = {}, list = [];
    var ox = origin[0], oy = origin[1], oz = origin[2];
    function at(k, y, side) { side = side || 0; return [ox + f.du * k + f.lu * side, oy + y, oz + f.dv * k + f.lv * side]; }
    function put(p, name, props, overwrite) {
      var key = p.join(',');
      if (g[key] && !overwrite) return;
      g[key] = { x: p[0], y: p[1], z: p[2], name: name, props: props || {} };
    }
    function railProps(shape, kind) {
      var pr = { shape: SHAPE_NAMES[shape], waterlogged: 'false' };
      if (kind !== 'r') pr.powered = kind === 'p' ? 'true' : 'false';
      return pr;
    }
    var GLASS = 'minecraft:white_stained_glass';
    var rails = [], caps = [], sources = [], conductor = null, poweredBy = [];
    for (var k = 0; k < L.blocks.length; k++) {
      var b = L.blocks[k];
      put(at(k, ys[k]), b.k === 'r' ? 'minecraft:rail' : 'minecraft:powered_rail', railProps(shapeOf(f, b.s), b.k), true);
      put(at(k, ys[k] - 1), GLASS, {}, true);
      rails.push({ k: k, pos: at(k, ys[k]), s: b.s, kind: b.k });
    }
    var last = L.blocks.length - 1;
    put(at(last + 1, ys[last]), GLASS, {}, true);                            // stopper
    put(at(last + 1, ys[last] + 1), 'minecraft:rail', railProps(f.flat, 'r'), true);   // end cap
    caps.push({ glass: at(last + 1, ys[last]), rail: at(last + 1, ys[last] + 1) });
    var lever = LEVER_FACING[(-f.lu) + ',' + (-f.lv)];
    if (L.blocks[0].s === 'D') {
      put(at(-1, ys[0]), GLASS, {}, true);
      put(at(-1, ys[0] + 1), 'minecraft:rail', railProps(f.flat, 'r'), true);
      caps.unshift({ glass: at(-1, ys[0]), rail: at(-1, ys[0] + 1) });
    }
    if (L.start === 'S') {
      put(at(-1, 0), 'minecraft:white_concrete', {}, true);
      put(at(-1, 0, -1), 'minecraft:lever', { face: 'wall', facing: lever, powered: 'true' }, true);
      conductor = { concrete: at(-1, 0), lever: at(-1, 0, -1) };
    }
    var levers = 0;
    k = 0;
    while (k < L.blocks.length) {
      if (L.blocks[k].k === 'p') {
        var j = k;
        while (j + 1 < L.blocks.length && L.blocks[j + 1].k === 'p') j++;
        for (var s0 = k; s0 <= j; s0 += 9) {                               // a source reaches 8 rails (P6)
          for (var q = s0; q <= Math.min(j, s0 + 8); q++) poweredBy[q] = s0;
          if (L.start === 'S' && k === 0 && s0 === 0) continue;             // the start conductor powers rail 0
          var side = at(s0, ys[s0], -1), key = side.join(',');
          if (g[key] && g[key].name !== GLASS) continue;
          put(side, 'minecraft:white_concrete', {}, true);
          put(at(s0, ys[s0], -2), 'minecraft:lever', { face: 'wall', facing: lever, powered: 'true' }, true);
          sources.push({ k: s0, concrete: side, lever: at(s0, ys[s0], -2) });
        }
        k = j + 1;
      } else k++;
    }
    var loader = null, launcher = null, how = startHow(opt);
    if (how === 'loader') loader = addLoader(put, at, g, f, opt.stopper || 'block', opt.approach || 'behind', ys, L, origin);
    else if (how === 'fly') launcher = addLauncher(put, at, g, f, opt.stopper || 'block', opt.approach || 'behind', ys, L, origin, !!opt.boat);
    Object.keys(g).forEach(function (key) { list.push(g[key]); if (g[key].name === 'minecraft:lever') levers++; });
    return { blocks: list, ys: ys, L: L, levers: levers, rails: rails, caps: caps, sources: sources,
             conductor: conductor, poweredBy: poweredBy, side: lever, loader: loader, launcher: launcher };
  }

  // Positions a layout is checked at (as floatcart_layouts.PLACEMENTS)
  var PLACEMENTS = [[0, 64, 0], [2, 1, 9], [-7, 64, -7], [5, 64, -3], [0, -60, 0], [0, 300, 0],
    [140, 70, 150], [-150, 70, -140], [1000, 64, -1000], [-4096, 12, 4096],
    [123456, 70, -654321], [-654321, 70, 123456], [2999000, 64, -2999000],
    [-29999000, 64, 29999000], [29999000, 64, -29999000]];

  // A layout rerun at every placement: in all 4 directions for a y target, or in the given
  // direction for an x or z target (the position along the track depends on the direction).
  // o: {axis, target, lo, hi, facing}. min/max: the aimed-at fraction's spread. The
  // placement is the start rail's block, as in the page.
  function verify(code, o) {
    var axis = o.axis || 'y', facings = axis === 'y' ? ['south', 'north', 'east', 'west'] : [o.facing];
    var res = { runs: 0, parked: 0, within: 0, floatcarts: 0, min: Infinity, max: -Infinity, worstDist: 0, facings: facings };
    var start = parse(code).start;
    facings.forEach(function (fc) {
      PLACEMENTS.forEach(function (p) {
        res.runs++;
        var r = run(code, start === 'S' ? p : [p[0], p[1] + 1, p[2]], fc, false, 0, o.boat || o.how ? o : null);
        if (!r.ok) return;
        res.parked++;
        var v = axis === 'x' ? r.x : axis === 'z' ? r.z : r.y, f = frac(v), d = circDist(v, o.target);
        if (inRange(f, o.lo, o.hi)) res.within++;
        if (isFloatcart(r.y)) res.floatcarts++;
        res.min = Math.min(res.min, f); res.max = Math.max(res.max, f);
        res.worstDist = Math.max(res.worstDist, d);
      });
    });
    return res;
  }

  return {
    HEIGHT: HEIGHT, F_1E5: F_1E5, WIN_LO: WIN_LO, WIN_HI: WIN_HI, FACINGS: FACINGS, SHAPE_NAMES: SHAPE_NAMES,
    ALPHABETS: ALPHABETS, PLACEMENTS: PLACEMENTS,
    parse: parse, levels: levels, pairOk: pairOk, problems: problems, trackFromCode: trackFromCode, spawnCart: spawnCart,
    tick: tick, run: run, dropY: dropY, isFloatcart: isFloatcart, frac: frac, circDist: circDist, inRange: inRange,
    searchTask: searchTask, makeTasks: makeTasks, build: build, verify: verify,
    newTrack: newTrack, shapeOf: shapeOf, worldTick: worldTick, launchRun: launchRun, launchWorld: launchWorld, startHow: startHow, LAUNCH: LAUNCH,
    STOPPERS: STOPPERS, APPROACHES: APPROACHES, boatFrac: boatFrac, LOADER: LOADER
  };
}

/* ============================================================================================
   Litematic

   Writes .litematic files.
   ============================================================================================ */

/*
  Litematica (.litematic) writer for the floatcart finder (format Version 7, SubVersion 1, MinecraftDataVersion 4903 = Java 26.2).
  gzip -> big-endian NBT -> one region whose corner is the blocks' minimum corner, block
  states tightly bit-packed into 64-bit words (air = palette entry 0, index y*w*l + z*w + x).
*/
function makeLitematicWriter() {
  'use strict';
  var END = 0, BYTE = 1, INT = 3, LONG = 4, STRING = 8, LIST = 9, COMPOUND = 10, LONG_ARRAY = 12;

  function Writer() { this.buf = new Uint8Array(4096); this.n = 0; this.dv = new DataView(this.buf.buffer); }
  Writer.prototype.room = function (k) {
    if (this.n + k <= this.buf.length) return;
    var b = new Uint8Array(Math.max(this.buf.length * 2, this.n + k));
    b.set(this.buf.subarray(0, this.n)); this.buf = b; this.dv = new DataView(b.buffer);
  };
  Writer.prototype.u8 = function (v) { this.room(1); this.buf[this.n++] = v & 255; };
  Writer.prototype.u16 = function (v) { this.room(2); this.dv.setUint16(this.n, v); this.n += 2; };
  Writer.prototype.i32 = function (v) { this.room(4); this.dv.setInt32(this.n, v); this.n += 4; };
  // 64-bit values as [high 32 bits, low 32 bits], so no BigInt is needed
  Writer.prototype.i64 = function (v) { this.room(8); this.dv.setUint32(this.n, v[0] >>> 0); this.dv.setUint32(this.n + 4, v[1] >>> 0); this.n += 8; };
  Writer.prototype.str = function (s) {
    for (var i = 0; i < s.length; i++) if (s.charCodeAt(i) > 126 || s.charCodeAt(i) < 32) throw new Error('ASCII only: ' + s);
    this.u16(s.length);
    for (var j = 0; j < s.length; j++) this.u8(s.charCodeAt(j));
  };

  // values: ['int', n] ['long', [hi, lo]] ['string', s] ['longArray', [[hi, lo]...]] ['list', type, [values]]
  // ['compound', [[name, value], ...]]
  var TYPE = { byte: BYTE, int: INT, long: LONG, string: STRING, list: LIST, compound: COMPOUND, longArray: LONG_ARRAY };
  function payload(w, v) {
    switch (v[0]) {
      case 'byte': w.u8(v[1]); break;
      case 'int': w.i32(v[1]); break;
      case 'long': w.i64(v[1]); break;
      case 'string': w.str(v[1]); break;
      case 'longArray': w.i32(v[1].length); v[1].forEach(function (x) { w.i64(x); }); break;
      case 'list':
        if (v[2].length && v[1] === END) throw new Error('a non-empty list needs an item type');
        w.u8(v[1]); w.i32(v[2].length); v[2].forEach(function (x) { payload(w, x); }); break;
      case 'compound':
        v[1].forEach(function (e) { w.u8(TYPE[e[1][0]]); w.str(e[0]); payload(w, e[1]); });
        w.u8(END); break;
      default: throw new Error('no NBT type ' + v[0]);
    }
  }
  function xyz(x, y, z) { return ['compound', [['x', ['int', x]], ['y', ['int', y]], ['z', ['int', z]]]]; }
  function bitsFor(n) { var b = 0, m = n - 1; while (m > 0) { b++; m = Math.floor(m / 2); } return Math.max(2, b); }
  // Tight packing: entry i fills bits i*nbits .. of one long bit stream, least significant
  // bit first, cut into 64-bit words (built here as pairs of 32-bit halves).
  function pack(cells, nbits) {
    var longs = Math.ceil(cells.length * nbits / 64), w = new Uint32Array(longs * 2);
    for (var i = 0; i < cells.length; i++) {
      var v = cells[i];
      if (!v) continue;
      var start = i * nbits, k = start >>> 5, off = start & 31;
      w[k] = (w[k] | (v << off)) >>> 0;
      if (off + nbits > 32) w[k + 1] = (w[k + 1] | (v >>> (32 - off))) >>> 0;
    }
    var out = [];
    for (var j = 0; j < longs; j++) out.push([w[2 * j + 1], w[2 * j]]);
    return out;
  }

  // blocks: [{x, y, z, name, props}]; tileEntities (optional): [{x, y, z, data}], data being
  // [[tag, value], ...] in the format above, written with region-relative x, y, z first. -> {bytes (uncompressed NBT), offset, size}
  function encode(blocks, name, author, description, nowMs, tileEntities) {
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    blocks.forEach(function (b) {
      lo = [Math.min(lo[0], b.x), Math.min(lo[1], b.y), Math.min(lo[2], b.z)];
      hi = [Math.max(hi[0], b.x), Math.max(hi[1], b.y), Math.max(hi[2], b.z)];
    });
    var sx = hi[0] - lo[0] + 1, sy = hi[1] - lo[1] + 1, sz = hi[2] - lo[2] + 1;
    var palette = [{ name: 'minecraft:air', props: {} }], index = { 'minecraft:air': 0 };
    var cells = new Array(sx * sy * sz).fill(0), total = 0;
    blocks.forEach(function (b) {
      if (b.name === 'minecraft:air') return;
      var keys = Object.keys(b.props || {}).sort();
      var key = b.name + '[' + keys.map(function (k) { return k + '=' + b.props[k]; }).join(',') + ']';
      if (!(key in index)) { index[key] = palette.length; palette.push({ name: b.name, props: b.props || {}, keys: keys }); }
      cells[(b.y - lo[1]) * (sx * sz) + (b.z - lo[2]) * sx + (b.x - lo[0])] = index[key];
    });
    cells.forEach(function (c) { if (c) total++; });
    var nbits = bitsFor(palette.length);
    var pal = palette.map(function (p) {
      var e = [['Name', ['string', p.name]]];
      if (p.keys && p.keys.length) e.push(['Properties', ['compound', p.keys.map(function (k) { return [k, ['string', String(p.props[k])]]; })]]);
      return ['compound', e];
    });
    var ms = nowMs === undefined ? Date.now() : nowMs, now = [Math.floor(ms / 4294967296), ms % 4294967296];
    var root = ['compound', [
      ['MinecraftDataVersion', ['int', 4903]],
      ['Version', ['int', 7]],
      ['SubVersion', ['int', 1]],
      ['Metadata', ['compound', [
        ['Name', ['string', name]], ['Author', ['string', author]], ['Description', ['string', description]],
        ['RegionCount', ['int', 1]], ['TotalVolume', ['int', sx * sy * sz]], ['TotalBlocks', ['int', total]],
        ['TimeCreated', ['long', now]], ['TimeModified', ['long', now]],
        ['EnclosingSize', xyz(sx, sy, sz)]]]],
      ['Regions', ['compound', [[name, ['compound', [
        ['BlockStatePalette', ['list', COMPOUND, pal]],
        ['BlockStates', ['longArray', pack(cells, nbits)]],
        ['TileEntities', tileEntities && tileEntities.length
          ? ['list', COMPOUND, tileEntities.map(function (t) {
              return ['compound', [['x', ['int', t.x - lo[0]]], ['y', ['int', t.y - lo[1]]], ['z', ['int', t.z - lo[2]]]].concat(t.data)];
            })]
          : ['list', END, []]],
        ['PendingBlockTicks', ['list', END, []]],
        ['PendingFluidTicks', ['list', END, []]],
        ['Entities', ['list', END, []]],
        ['Position', xyz(0, 0, 0)],
        ['Size', xyz(sx, sy, sz)]]]]]]]]];
    var w = new Writer();
    w.u8(COMPOUND); w.str(''); payload(w, root);
    return { bytes: w.buf.slice(0, w.n), offset: lo, size: [sx, sy, sz], total: total };
  }

  // gzip with stored (uncompressed) deflate blocks: valid for every gzip reader, Minecraft's
  // included, and the files are only a few kilobytes.
  var CRC = null;
  function crc32(u8) {
    if (!CRC) { CRC = new Int32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c; } }
    var crc = -1;
    for (var i = 0; i < u8.length; i++) crc = CRC[(crc ^ u8[i]) & 255] ^ (crc >>> 8);
    return (crc ^ -1) >>> 0;
  }
  function gzipStored(u8) {
    var blocks = Math.max(1, Math.ceil(u8.length / 65535));
    var out = new Uint8Array(10 + u8.length + blocks * 5 + 8), dv = new DataView(out.buffer), p = 0;
    out.set([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255]); p = 10;
    for (var b = 0; b < blocks; b++) {
      var s = b * 65535, len = Math.min(65535, u8.length - s);
      out[p++] = b === blocks - 1 ? 1 : 0;
      dv.setUint16(p, len, true); dv.setUint16(p + 2, len ^ 0xffff, true); p += 4;
      out.set(u8.subarray(s, s + len), p); p += len;
    }
    dv.setUint32(p, crc32(u8), true); dv.setUint32(p + 4, u8.length, true);
    return out;
  }
  return { encode: encode, gzipStored: gzipStored, crc32: crc32, bitsFor: bitsFor, pack: pack };
}

/* ============================================================================================
   Tester

   The "Download with tester" build: command blocks that test a track in game.
   ============================================================================================ */

/*
  Single-track tester for the floatcart finder: a track plus command blocks that test it by
  themselves once the schematic is pasted. Its design began in the retired Python tester,
  whose parts worked in game; this is now the reference.
  makeTester(E, LW): E = makeEngine(), LW = makeLitematicWriter().
*/
function makeTester(E, LW) {
  'use strict';
  var SUMMON_T = 60;
  var TOP = '0.699999988079071', F1E5 = '0.000009999999747378752';
  var HEIGHT = 0.699999988079071, HALF_W = Math.fround(Math.fround(0.98) / 2);
  var FACING_NAME = { '1,0': 'east', '-1,0': 'west', '0,1': 'south', '0,-1': 'north' };
  var GLASS = 'minecraft:white_stained_glass', SIGN = 'minecraft:cherry_wall_sign';

  function zeros(n) { var s = ''; while (n-- > 0) s += '0'; return s; }
  // A double as a plain decimal (commands take no exponents): the shortest digits that give
  // the same double back, no trailing zeros, integers without a point (as tester.plain)
  function plain(v) {
    if (v === 0) return '0';
    var m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(v.toExponential());
    var digits = m[2] + (m[3] || ''), point = parseInt(m[4], 10) + 1, out;
    if (point <= 0) out = '0.' + zeros(-point) + digits;
    else if (point >= digits.length) out = digits + zeros(point - digits.length);
    else out = digits.slice(0, point) + '.' + digits.slice(point);
    return m[1] + out;
  }
  function frac10(v) { return v.toFixed(10); }
  function rangeText(lo, hi) {
    return lo <= hi ? frac10(lo) + ' to ' + frac10(hi) : frac10(lo) + ' to 1 or 0 to ' + frac10(hi);
  }
  function cmdState(kind, facing) {
    var name = { impulse: 'minecraft:command_block', chain: 'minecraft:chain_command_block', repeat: 'minecraft:repeating_command_block' }[kind];
    return { name: name, props: { conditional: 'false', facing: facing } };
  }
  function cmdData(command, auto) {
    return [['id', ['string', 'minecraft:command_block']], ['Command', ['string', command]], ['auto', ['byte', auto ? 1 : 0]],
      ['powered', ['byte', 0]], ['conditionMet', ['byte', 0]], ['TrackOutput', ['byte', 0]],
      ['SuccessCount', ['int', 0]], ['UpdateLastExecution', ['byte', 1]]];
  }
  function signData(lines) {
    function side(msgs) {
      return ['compound', [['color', ['string', 'black']], ['messages', ['list', 8, msgs.map(function (t) { return ['string', t]; })]],
        ['has_glowing_text', ['byte', 0]]]];
    }
    return [['id', ['string', 'minecraft:sign']], ['is_waxed', ['byte', 0]], ['front_text', side(lines)],
      ['back_text', side(['', '', '', ''])], ['components', ['compound', []]]];
  }

  // Blocks, block entities and info for one tester. startRail: the block of the start rail;
  // ticks: how long the cart takes to park (from E.run). opt: the start, as E.run takes it. A
  // cart placed by hand is summoned on the start rail; a launched one (opt.how 'fly') on the
  // launcher where it would be placed (M3), and with opt.boat a boat is summoned on its rail
  // first, for the cart to take aboard on its way down. A loading run needs glass broken
  // mid-run, which the commands can't time, so it has no tester.
  function build(code, startRail, facing, axis, lo, hi, uid, ticks, opt) {
    var L = E.parse(code), start = L.start, how = E.startHow(opt);
    if (how === 'loader') throw new Error('a cart that starts on a loading run has no tester: launch it instead');
    var origin = start === 'S' ? [startRail[0], startRail[1], startRail[2]] : [startRail[0], startRail[1] + 1, startRail[2]];
    var b = E.build(code, origin, facing, opt), f = E.FACINGS[facing], La = b.launcher;
    var ys = b.ys, last = ys.length - 1;
    if (axis !== 'y' && (axis === 'x') !== (f.du !== 0)) throw new Error('x needs a track running east or west, z north or south');
    function at(k, y, side) { side = side || 0; return [origin[0] + f.du * k + f.lu * side, origin[1] + y, origin[2] + f.dv * k + f.lv * side]; }
    var list = b.blocks.slice(), taken = {}, tes = [];
    list.forEach(function (q) { taken[q.x + ',' + q.y + ',' + q.z] = q; });
    function put(p, st, data) {
      var key = p.join(',');
      if (taken[key]) throw new Error('overlap at ' + key);
      var q = { x: p[0], y: p[1], z: p[2], name: st.name, props: st.props };
      taken[key] = q; list.push(q);
      if (data) tes.push({ x: p[0], y: p[1], z: p[2], data: data });
    }
    var obj = 'fct' + uid, tag = obj, ptag = 'fctp' + uid, ftag = 'fctf' + uid, btag = 'fctb' + uid;
    var minY = Infinity;
    b.blocks.forEach(function (q) { minY = Math.min(minY, q.y); });
    var yb = minY - origin[1] - 2, t = '#t ' + obj + ' matches', tb = null, check;
    if (axis === 'y') check = SUMMON_T + ticks + 40;
    else { tb = SUMMON_T + ticks + 20; check = tb + 40; }
    var limit = Math.max(1000, check + 10);

    var lift = start === 'S' ? 0.0625 : 0.5625, dy = (ys[0] + lift) - (yb + 0.5);
    function summonCart(dyy) {
      return 'execute if score ' + t + ' ' + SUMMON_T + '.. unless entity @e[type=minecart,tag=' + tag + '] run summon minecart ' +
        '~ ~' + plain(dyy) + ' ~ {Tags:["' + tag + '"],CustomName:"Test cart",CustomNameVisible:1b}';
    }
    if (!La) put(at(0, yb), cmdState('repeat', 'up'), cmdData(summonCart(dy), true));
    var park = at(last, ys[last]), info = { code: code, axis: axis, lo: lo, hi: hi, check: check, tb: tb, summon: La ? null : at(0, yb), dy: dy, park: park,
                                            how: how, boat: !!(La && La.boat) };
    if (axis !== 'y') {
      put(at(last, yb), cmdState('repeat', 'up'), cmdData('execute if score ' + t + ' ' + tb + ' run setblock ~ ~' + (ys[last] - yb) + ' ~ air', true));
      put(at(last, yb - 1), cmdState('repeat', 'up'), cmdData(
        'execute if score ' + t + ' 10 run clone ~ ~-2 ~ ~ ~-2 ~ ~ ~' + (ys[last] - (yb - 1)) + ' ~', true));
      var pr = taken[park.join(',')];
      put(at(last, yb - 3), { name: pr.name, props: pr.props });
      put(at(last, yb - 4), { name: GLASS, props: {} });
      put(at(last + 1, yb - 3), { name: GLASS, props: {} });
    }
    var sideFacing = FACING_NAME[f.lu + ',' + f.lv], back = FACING_NAME[(0 - f.du) + ',' + (0 - f.dv)];
    var reset = ['gamerule commandBlockOutput false', 'gamerule command_block_output false',
      'scoreboard objectives add ' + obj + ' dummy', 'scoreboard players set #t ' + obj + ' 0'];
    var y0 = ys[0], s;
    for (s = 0; s < reset.length; s++) put(at(-3, y0, s), cmdState(s === 0 ? 'impulse' : 'chain', sideFacing), cmdData(reset[s], true));
    for (s = 0; s < reset.length; s++) put(at(-5, y0, s), cmdState(s === 0 ? 'impulse' : 'chain', sideFacing), cmdData(reset[s], s > 0));
    put(at(-6, y0, 0), { name: 'minecraft:stone_button', props: { face: 'wall', facing: back, powered: 'false' } });
    put(at(-6, y0, 1), { name: SIGN, props: { facing: back, waterlogged: 'false' } },
      signData(['', 'Retest', '', '']));

    var rt = rangeText(lo, hi);
    var what = { y: 'y', x: 'x after the drop', z: 'z after the drop' }[axis];
    var secs = Math.floor((check + 14) / 20);
    var lines = [
      'execute unless score ' + t + ' ' + limit + '.. run scoreboard players add #t ' + obj + ' 1',
      'execute if score ' + t + ' 1 run tellraw @a {"text":"Testing... results in ' + secs + 's","color":"gray"}',
      'execute if score ' + t + ' 8 as @e[type=minecart,tag=' + tag + '] at @s run fill ~ ~2 ~ ~ ~2 ~ air replace #minecraft:wool',
      'execute if score ' + t + ' 10 run tp @e[type=minecart,tag=' + tag + '] ~ -400 ~'
    ];
    var sel = 'execute if score ' + t + ' ' + check + ' as @e[type=minecart,tag=' + tag + '] at @s', a, c, ta, tc;
    if (axis === 'y') {
      a = lo + HEIGHT; c = hi - 1.0;
      ta = 'align y positioned ~ ~' + plain(a) + ' ~ if entity @s[dx=0,dy=0,dz=0]';
      tc = 'align y positioned ~ ~' + plain(c) + ' ~ if entity @s[dx=0,dy=0,dz=0]';
    } else {
      a = lo + HALF_W; c = hi - HALF_W - 1.0;
      if (axis === 'x') {
        ta = 'align x positioned ~' + plain(a) + ' ~ ~ if entity @s[dx=0,dy=0,dz=0]';
        tc = 'align x positioned ~' + plain(c) + ' ~ ~ if entity @s[dx=0,dy=0,dz=0]';
      } else {
        ta = 'align z positioned ~ ~ ~' + plain(a) + ' if entity @s[dx=0,dy=0,dz=0]';
        tc = 'align z positioned ~ ~ ~' + plain(c) + ' if entity @s[dx=0,dy=0,dz=0]';
      }
    }
    if (lo <= hi) lines.push(sel + ' ' + ta + ' at @s ' + tc + ' run tag @s add ' + ptag);
    else { lines.push(sel + ' ' + ta + ' run tag @s add ' + ptag); lines.push(sel + ' ' + tc + ' run tag @s add ' + ptag); }
    if (axis === 'y') lines.push(sel + ' positioned ~ ~' + TOP + ' ~ align y if entity @s[dx=0,dy=0,dz=0] positioned ~ ~' + F1E5 + ' ~ ' +
      'unless entity @s[dx=0,dy=0,dz=0] run tag @s add ' + ftag);
    info.a = a; info.c = c;
    lines.push('execute if score ' + t + ' ' + (check + 1) + ' as @e[type=minecart,tag=' + tag + '] at @s run fill ~ ~2 ~ ~ ~2 ~ air replace #minecraft:wool');
    lines.push('execute if score ' + t + ' ' + (check + 2) + ' if entity @e[type=minecart,tag=' + ptag + '] run tellraw @a ["",{"text":"PASS","bold":true,"color":"green"},{"text":" ' + what + ' within ' + rt + '"}]');
    lines.push('execute if score ' + t + ' ' + (check + 2) + ' unless entity @e[type=minecart,tag=' + ptag + '] run tellraw @a ["",{"text":"FAIL","bold":true,"color":"red"},{"text":" ' + what + ' outside ' + rt + '"}]');
    lines.push('execute if score ' + t + ' ' + (check + 2) + ' as @e[type=minecart,tag=' + ptag + '] at @s run setblock ~ ~2 ~ lime_wool keep');
    lines.push('execute if score ' + t + ' ' + (check + 2) + ' as @e[type=minecart,tag=' + tag + ',tag=!' + ptag + '] at @s run setblock ~ ~2 ~ red_wool keep');
    if (axis === 'y') {
      lines.push('execute if score ' + t + ' ' + (check + 3) + ' if entity @e[type=minecart,tag=' + ftag + '] run tellraw @a {"text":"Floatcart!","color":"green"}');
      lines.push('execute if score ' + t + ' ' + (check + 3) + ' unless entity @e[type=minecart,tag=' + ftag + '] run tellraw @a {"text":"Not a floatcart","color":"gray"}');
    }
    lines.push('execute if score ' + t + ' ' + (check + 4) + ' run tellraw @a ["",{"text":"Pos: ","color":"gray"},' +
      '{"entity":"@e[type=minecart,tag=' + tag + ',limit=1]","nbt":"Pos"}]');
    if (La && La.boat) lines.splice(3, 0, 'execute if score ' + t + ' 9 run tp @e[type=oak_boat,tag=' + btag + '] ~ -400 ~');
    for (var k = 0; k < lines.length; k++) put(at(k, yb, 2), cmdState('repeat', 'up'), cmdData(lines[k], true));
    // A launched cart: summoned where it would be placed on the launcher, by a command block in the
    // first free cell under that spot; its boat 20 ticks earlier, the same way, in the middle of its rail
    function under(p, command) {
      for (var y = origin[1] + yb; ; y--) {
        if (taken[p[0] + ',' + y + ',' + p[2]]) continue;
        put([p[0], y, p[2]], cmdState('repeat', 'up'), cmdData(command(y), true));
        return [p[0], y, p[2]];
      }
    }
    if (La) {
      info.summon = under(La.start, function (y) { info.dy = La.place[1] - (y + 0.5); return summonCart(info.dy); });
      if (La.boat) info.boatSummon = under(La.boatRail, function (y) {
        return 'execute if score ' + t + ' ' + (SUMMON_T - 20) + '.. unless entity @e[type=oak_boat,tag=' + btag + '] run summon oak_boat ~ ~' +
          plain(La.boat[1] - (y + 0.5)) + ' ~ {Tags:["' + btag + '"]}';
      });
    }
    info.lines = lines; info.secs = secs;
    return { blocks: list, tes: tes, info: info, startRail: at(0, ys[0]) };
  }

  // The tests as the commands make them, on a cart at (x, y, z) (as tester.verdict)
  function boxHit(cmin, cmax, bmin) { return cmin < bmin + 1.0 && cmax > bmin; }
  function verdict(info, x, y, z) {
    var ha, hc, b, v;
    if (info.axis === 'y') { b = Math.floor(y); ha = boxHit(y, y + HEIGHT, b + info.a); hc = boxHit(y, y + HEIGHT, b + info.c); }
    else {
      v = info.axis === 'x' ? x : z; b = Math.floor(v);
      ha = boxHit(v - HALF_W, v + HALF_W, b + info.a); hc = boxHit(v - HALF_W, v + HALF_W, b + info.c);
    }
    var top = Math.floor(y + Number(TOP));
    return { passed: info.lo <= info.hi ? ha && hc : ha || hc,
             floatcart: boxHit(y, y + HEIGHT, top) && !boxHit(y, y + HEIGHT, top + Number(F1E5)) };
  }
  function description(code, axis, lo, hi, check, info) {
    var what = { y: 'y', x: 'x (after the drop)', z: 'z (after the drop)' }[axis];
    return 'Minecart track by 07km, with a built-in test' + (info && info.boat ? ' (boat cart)' : '') + '. Paste with commands on; ' +
      'results in chat after ~' + Math.floor((check + 14) / 20) + 's. Target ' + what + ': ' + rangeText(lo, hi) +
      '. Button retests. Layout: ' + code + '. Java 26.2';
  }
  // The whole file: uncompressed NBT bytes, plus what the test should report when the start
  // rail is where it was built (the run, the drop for x / z, and the verdict).
  function file(code, startRail, facing, axis, lo, hi, uid, nowMs, opt) {
    var start = E.parse(code).start;
    var origin = start === 'S' ? startRail : [startRail[0], startRail[1] + 1, startRail[2]];
    var r = E.run(code, origin, facing, false, 20000, opt);
    if (!r.ok) throw new Error('the cart does not park on this track');
    var tt = build(code, startRail, facing, axis, lo, hi, uid, r.ticks, opt);
    var enc = LW.encode(tt.blocks, 'Cart track test ' + code, '07km', description(code, axis, lo, hi, tt.info.check, tt.info), nowMs, tt.tes);
    var y = axis === 'y' ? r.y : E.dropY(code, origin, facing, r, opt);
    return { bytes: enc.bytes, offset: enc.offset, size: enc.size, info: tt.info, startRail: tt.startRail,
             end: [r.x, y, r.z], expect: verdict(tt.info, r.x, y, r.z) };
  }
  return { build: build, verdict: verdict, file: file, plain: plain, description: description, SUMMON_T: SUMMON_T };
}

/* ============================================================================================
   3D view

   The 3D view of one track: scene3d.js (shared with the two 3D pages) in a box that
   moves into whichever result is open.
   ============================================================================================ */

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
    el.innerHTML = '<div class="gl-none">This browser could not start WebGL, so the 3D view is unavailable.</div>';
    return { el: el, ok: false, load: function () {}, snapshot: function () { return null; } };
  }
  el.insertBefore(S.canvas, el.firstChild);
  S.canvas.tabIndex = 0;
  S.canvas.setAttribute('aria-label', '3D view of the track. Drag to turn, scroll to zoom.');
  el.querySelector('.gl-reset').addEventListener('click', function (e) { e.stopPropagation(); S.reset(); });

  /* ---------- playback: run holds the cart's position at every tick, in scene coordinates ---------- */
  var ui = { bar: el.querySelector('.gl-play'), play: el.querySelector('.gl-play .play'), tick: el.querySelector('.gl-play input'),
             num: el.querySelector('.gl-play .tickread b'), max: el.querySelector('.gl-play .tickread span') };
  var run = [], mover = null, boat = null, st = { t: 0, playing: false, played: false }, raf = 0, last = 0;
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
    if (st.t >= tmax()) { st.playing = false; st.played = true; label(); }
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

/* ============================================================================================
   App

   The page itself: reading the settings, running the search in workers, the results
   table, the details, the downloads and the checks. Runs last, on load.
   ============================================================================================ */

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
      ? 'Every track of up to ' + (s.dry + 2) + ' rails, and redstone-free tracks of up to ' + (s.plain + 2) + '.'
      : 'Every redstone-free track of up to ' + (s.plain + 2) + ' rails.';
    $('sizeHint').textContent = len + ' About ' + fmtCount(n) + ' tracks' + (vs.length > 1 ? ' over ' + vs.length + ' starts' : '') + ': ' + fmtTime(secs) + ' on ' + cores + ' core' + (cores === 1 ? '' : 's') + '.' +
      (blocked ? ' This browser doesn\'t allow background workers here, so the search runs on the page itself, on one core.' +
        ' Some browsers only allow them on a website, so on GitHub Pages it may use all ' + CORES + '.' : '');
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
  var STOP_NAME = { block: 'plain block', honey: 'honey block', bud_side: 'medium amethyst bud, side on (a large bud or a cluster works the same)',
                    small_side: 'small amethyst bud, side on', small_tip: 'small amethyst bud, tip first', medium_tip: 'medium amethyst bud, tip first',
                    large_tip: 'large amethyst bud, tip first', cluster_tip: 'amethyst cluster, tip first' };
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
    return v.how === 'fly' ? ', the cart launched into the ' + STOP_WORD[v.stopper] + side
      : ', the cart stopped against the ' + STOP_WORD[v.stopper] + ' on a loading run' + side;
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
    var how = ss.how === 'hand' ? 'Placed by hand on the start rail, as in the maker schematics.'
      : ss.how === 'both' ? 'Placed by hand on the start rail, or launched: the cart runs off a powered slope, stops dead in mid-air against the stopper and falls onto the start rail. Nothing to break either way.'
      : ss.how === 'fly' ? (ss.boat ? 'It can\'t be placed by hand with a boat in it, so the download brings a launcher: the cart picks the boat up, ' : 'The download brings a launcher: the cart ') +
        'runs off a powered slope, stops dead in mid-air against the stopper and falls onto the start rail. Nothing to break.'
      : 'The download brings a loading run: the cart picks the boat up and stops dead against the stopper; break the glass under it and it drops onto the start rail.';
    $('cartHint').textContent = how + (one ? ' It comes to rest there at fraction ' + E.boatFrac(one.stopper, $('facing').value, one.approach).toFixed(10) + '.'
      : vs.length > 1 ? ' That makes ' + vs.length + ' starts, each searched in full.' : '');
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
      ? 'Height on the parking slope. A floatcart needs 0.3000000120 to 0.3000100119.'
      : 'Break the parking rail when it has parked: the cart drops and keeps its ' + axis + '. Track running ' + sel.value +
        ' (' + (axis === 'x' ? 'east or west' : 'north or south') + ' only).';
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
      if (!isFinite(v)) return bad('target', 'Type a number, such as 0.3 or 64.3000050119.');
      if (!(isFinite(tol) && tol >= 0 && tol < 0.5)) return bad('tol', 'The ± part must be a number from 0 to 0.5.');
      var c = frac(v);
      hint.textContent = (v !== c ? 'Using the fraction ' + c.toFixed(10) + '. ' : '') +
        'The digits after the point. Within ±' + tol + ' counts as a match.';
      return { mode: 'value', target: c, lo: frac(c - tol), hi: frac(c + tol), w: tol };
    }
    var a = num($('lo').value), b = num($('hi').value);
    if (!isFinite(a)) return bad('lo', 'Type a number, such as 0.3.');
    if (!isFinite(b)) return bad('hi', 'Type a number, such as 0.31.');
    if (Math.abs(b - a) >= 1) return bad('hi', 'The range must be less than one block wide.');
    var lo = frac(a), hi = frac(b), w = lo <= hi ? (hi - lo) / 2 : (hi + 1 - lo) / 2;
    hint.textContent = (lo <= hi
      ? 'Tracks whose ' + axis + ' fraction lands anywhere from ' + lo.toFixed(10) + ' to ' + hi.toFixed(10) + ' count as matches. '
      : 'The range wraps past 1: fractions from ' + lo.toFixed(10) + ' up to 1, and from 0 to ' + hi.toFixed(10) + '. ') +
      '"Closest first" lists the ones nearest its middle first.';
    return { mode: 'range', target: frac(lo + w), lo: lo, hi: hi, w: w };
  }
  function readPos() {
    var x = intIn($('px'), -29999984, 29999984), y = intIn($('py'), -64, 318), z = intIn($('pz'), -29999984, 29999984);
    var facing = $('facing').value, ok = x !== null && y !== null && z !== null;
    $('posHint').classList.toggle('err', !ok);
    $('posHint').textContent = ok
      ? 'The block of the rail you place the cart on. The last digits of the cart\'s position depend on where the track is, so results are exact for this spot.'
      : 'X and Z must be whole numbers inside the world border, Y a whole number from -64 to 318.';
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
    if (!st) { $('status').textContent = 'Fix the highlighted setting first.'; return; }
    if (workerMode === null) {                     // still finding out whether workers run here
      $('status').textContent = 'Starting…';
      probeWaiters = [start];
      return;
    }
    stop(true);
    var tasks = [], total = 0;                     // every part once per start (t.v: its index in st.starts)
    jobsFor(st.rails, st.size).forEach(function (j) {
      total += TOTALS[st.boat ? 'boat' : 'empty'][j.alphabet][j.depth] * st.starts.length;
      E.makeTasks(j.alphabet, j.starts, j.depth, j.split).forEach(function (t) {
        st.starts.forEach(function (v, i) {
          tasks.push({ start: t.start, first: t.first, alphabet: t.alphabet, depth: t.depth, minMid: j.minMid, v: i });
        });
      });
    });
    S = { st: st, tasks: tasks, next: 0, done: 0, total: total, nodes: 0, parked: 0, inside: 0, floats: 0,
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
  function dispatch(s, slot) {
    if (s.next >= s.tasks.length) {
      if (s.done === s.tasks.length) finish(s);
      return;
    }
    slot.id = s.next++;
    slot.w.postMessage(taskMsg(s, slot.id));
  }
  function absorb(s, id, top, stats) {
    var v = s.st.starts[s.tasks[id].v];
    s.done++;
    s.nodes += stats.nodes; s.parked += stats.parked; s.inside += stats.inside; s.floats += stats.floats;
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
      var id = s.retry.length ? s.retry.shift() : s.next++, m = taskMsg(s, id);
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
  function finish(s, stopped) {
    if (s.finished) return;
    s.finished = true; s.running = false;
    killWorkers(s);
    clearInterval(s.timer);
    s.secs = (performance.now() - s.t0) / 1000;
    $('go').disabled = false; $('stop').disabled = true;
    $('prog').hidden = true;
    $('status').textContent = s.error ? 'The search failed: ' + s.error : stopped ? 'Stopped.' :
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
      (s.mainThread === 'blocked' ? ' · on one core: this browser blocked background workers here'
        : s.mainThread === 'stopped' ? ' · on one core: a background worker stopped'
        : ' · ' + s.slots.length + ' worker' + (s.slots.length === 1 ? '' : 's'));
    if (s.dirty) renderRows(false);
  }
  $('go').addEventListener('click', start);
  document.querySelector('.rail').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && !$('go').disabled) { e.preventDefault(); start(); }
  });
  $('stop').addEventListener('click', function () { stop(false); });

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
    if (!s.top.length) rows.push('<tr><td colspan="7" class="empty">' + (s.running ? 'Searching…' : 'No track parked.') + '</td></tr>');
    s.top.forEach(function (r, i) { rows.push(rowHTML(r, i, st, !!s.opened[r.id], st.starts.length > 1 ? 'both' : 'code')); });
    snapCurrent();
    $('rows').innerHTML = rows.join('');
    syncViewer();
    var sum;
    if (s.running) sum = 'Searching: ' + fmtInt(s.done) + ' of ' + fmtInt(s.tasks.length) + ' parts done. The list fills in as parts finish.';
    else {
      sum = (s.stopped ? 'Stopped after ' : 'Tried ') + fmtInt(s.nodes) + ' tracks in ' + s.secs.toFixed(1) + ' s; ' + fmtInt(s.parked) + ' parked the cart. ' +
        fmtInt(s.inside) + ' landed ' + targetText(st) + (st.axis === 'y' ? ', and ' + fmtInt(s.floats) + ' made a floatcart. ' : '. ') +
        (s.top.length ? 'The ' + (st.sort === 'short' ? 'shortest matches, then the closest tracks,' : 'closest ' + s.top.length) + (s.stopped ? ' found so far' : '') +
          ' are below, for a start rail at ' + st.pos.join(' ') + ' with the track running ' + st.facing +
          (st.starts.length === 1 && st.starts[0].how !== 'hand' ? startPhrase(st.starts[0]) : '') + '.' : '');
    }
    $('summary').textContent = sum;
  }
  // one result as a row of the table (and its details under it when open)
  // show: 'code' the layout, 'both' the layout and its start, 'start' the start alone
  function rowHTML(r, i, st, open, show) {
    var badge = r.float && st.axis === 'y' ? '<span class="badge fc" title="Inside the floatcart window at this build position">floatcart</span>'
      : r.inside ? '<span class="badge in">' + (st.mode === 'range' ? 'in range' : 'match') + '</span>' : '';
    var parked = r.ok !== false;
    return '<tr class="r' + (open ? ' open' : '') + '" data-id="' + esc(r.id) + '">' +
      '<td class="n">' + (i + 1) + '</td>' +
      '<td class="lay">' + (show === 'start' ? '' : tokensHTML(r.code)) + (show === 'code' ? '' : '<span class="startv">' + esc(startWords(r.v)) + '</span>') + '</td>' +
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
      h += '<p class="check-sum">The cart does not park on this track' + (sv.how === 'hand' ? '' : ' with this start') + ': ' + esc(r.why) + '.</p>';
    } else {
      var v = axisValue(r, st.axis), d = E.circDist(v, st.target), inside = E.inRange(frac(v), st.lo, st.hi);
      drop = E.dropY(code, origin, st.facing, r, o, dropPath);
      var rr = { dist: d, inside: inside };
      h += '<p class="facts"><span>Stops at x <b class="mono">' + r.x + '</b>, y <b class="mono">' + r.y + '</b>, z <b class="mono">' + r.z + '</b></span>' +
        '<span>' + st.axis + ' fraction <b class="mono">' + fmtFrac(v) + '</b>' +
          (st.axis === 'y' && E.isFloatcart(r.y) ? '<span class="badge fc">floatcart</span>' : inside ? '<span class="badge in">' + (st.mode === 'range' ? 'in range' : 'match') + '</span>' : '') + '</span>' +
        '<span>' + (st.mode === 'range' ? 'inside by' : 'off by') + ' <b class="mono">' + offText(rr, st) + '</b></span>' +
        (sv.how === 'fly' ? '<span>lands on the start rail at tick <b>' + r.landTick + '</b>, parks at tick <b>' + r.ticks + '</b> (' + (r.ticks / 20).toFixed(1) + ' s)</span>'
          : '<span>parks after <b>' + r.ticks + ' ticks</b> (' + (r.ticks / 20).toFixed(1) + ' s)</span>') +
        '<span><b>' + b.rails.length + '</b> rails, <b>' + b.levers + '</b> lever' + (b.levers === 1 ? '' : 's') + ', <b>' + b.blocks.length + '</b> blocks</span></p>';
      if (sv.how === 'fly' && res.y !== undefined && (res.x !== r.x || res.y !== r.y || res.z !== r.z)) {
        h += '<p class="facts drop">The flight, simulated in full, stops the cart a hair off where the search put it, so it parks ' +
          fmtDist(Math.max(Math.abs(res.x - r.x), Math.abs(res.y - r.y), Math.abs(res.z - r.z))) + ' away from the listed spot. The numbers here are the full flight\'s.</p>';
      }
      if (r.spread) {
        h += '<p class="facts drop">Where the boat sits on its rail moves where the cart parks by up to ' + fmtDist(r.spread) +
          '. The numbers here are for the boat in the middle of the rail.</p>';
      }
      h += '<p class="facts drop">' + (drop === Math.floor(drop)
        ? 'Break the parking rail once it has parked, and the cart drops straight down to <b class="mono">y ' + drop + '</b>; x and z stay exactly the same.'
        : 'Break the parking rail once it has parked, and the cart stays at <b class="mono">y ' + drop + '</b>: it is less than 0.0003 above the block below, and a move that small is never made (C4). x and z stay the same.') + '</p>';
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
      '<button type="button" class="btn sm" data-act="copy" data-id="' + id + '">Copy layout code</button>' +
      '<button type="button" class="btn sm" data-act="lite" data-id="' + id + '">Download .litematic</button>' +
      (r.ok && sv.how !== 'loader' ? '<button type="button" class="btn sm" data-act="tester" data-id="' + id + '">Download with tester</button>' : '') +
      '<button type="button" class="btn sm" data-act="verify" data-id="' + id + '">Check at ' + (st.axis === 'y' ? 60 : 15) + ' positions</button>' +
      (sv.how === 'loader' ? '<span class="note">No automatic test for a loading run: the glass has to be broken by hand. Launched, the same start has one.</span>' : '') +
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
      if (rl.k === 0) notes.push(b.loader ? 'the boat cart drops onto this rail' : b.launcher ? 'the launched cart falls onto this rail' : 'place the cart here');
      if (rl.k === 0 && b.conductor) notes.push('concrete behind it at ' + xyz(b.conductor.concrete) + ', lever on the concrete\'s ' + b.side + ' side');
      if (src[rl.k]) notes.push('concrete at ' + xyz(src[rl.k].concrete) + ', lever on its ' + b.side + ' side');
      else if (rl.kind === 'p' && b.poweredBy[rl.k] !== undefined && b.poweredBy[rl.k] !== rl.k) notes.push('powered through #' + b.poweredBy[rl.k]);
      if (rl.k === last) notes.push('parking slope: the cart stops here' + (st.axis !== 'y' ? '; break this rail once it has' : ''));
      return '<tr><td class="k">' + rl.k + '</td><td class="mono">' + xyz(rl.pos) + '</td><td>' + RAIL_WORD[rl.kind] + '</td><td>' +
        SHAPE_WORD[rl.s] + '</td><td>' + esc(notes.join('; ')) + '</td></tr>';
    }).join('');
    var caps = b.caps.map(function (c) { return 'at ' + xyz(c.glass); });
    var note = 'Glass under every rail. Glass ' + caps.join(' and ') + ', with a plain rail on top of ' + (caps.length > 1 ? 'each' : 'it') +
      ': the cart never reaches ' + (caps.length > 1 ? 'those rails' : 'that rail') + '; ' + (caps.length > 1 ? 'they make the end slopes' : 'it makes the parking slope') +
      ' take their shape when placed. The track runs ' + st.facing + ', one block per row.';
    var extra = '';
    if (b.loader) {
      var L = b.loader;
      extra = '<p class="bnote">Loading run, plain rails on glass, ' + L.level + ' blocks above the start rail, ' +
        (L.approach === 'front' ? 'over the track in front of it (the cart rolls back toward the start)' : 'behind the start') +
        '. 1: place the minecart on the slope at ' + xyz(L.start) + '. 2: it picks up the boat waiting on the rail at ' + xyz(L.boatRail) +
        '. 3: it stops dead against the ' + STOP_NAME[L.stopper] + ' at ' + xyz(L.stop) +
        (L.support ? ', which grows out of the block at ' + xyz(L.support) : '') +
        (L.mode === 'tip' ? ', after running off the end of the rail at ' + xyz(L.lastRail) + ' onto the glass under it' : ', on the rail at ' + xyz(L.lastRail)) +
        '. 4: break the glass at ' + xyz(L.breakGlass) + ': the rail on it pops off and the cart drops straight down onto the start rail, at fraction ' +
        L.frac.toFixed(10) + '. 5: it runs down the track and parks.</p>';
    }
    if (b.launcher) {
      var La = b.launcher, n = 1;
      extra = '<p class="bnote">Launcher, plain rails on glass ending on a powered slope, ' + La.level + ' blocks above the start rail, ' +
        (La.approach === 'front' ? 'over the track in front of it (the cart flies back toward the start)' : 'behind the start') +
        '. The lever at ' + xyz(La.lever) + ' powers the launch slope at ' + xyz(La.launchRail) + ' through the concrete beside it; it is on in the schematic. ' +
        (La.boatRail ? n++ + ': put a boat on the rail at ' + xyz(La.boatRail) + '. ' : '') +
        n++ + ': place the minecart on the ' + (La.boatRail ? 'top slope' : 'launch slope') + ' at ' + xyz(La.start) + '. ' +
        n++ + ': it ' + (La.boatRail ? 'takes the boat aboard, ' : '') + 'runs off the foot of the launch slope and stops dead in mid-air against the ' +
        STOP_NAME[La.stopper] + ' at ' + xyz(La.stop) + (La.support ? ', which grows out of the block at ' + xyz(La.support) : '') +
        '. ' + n++ + ': it falls straight down onto the start rail, at rest at fraction ' + La.frac.toFixed(10) + ', runs down the track and parks. Nothing to break.</p>';
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
    return '<img alt="3D view of this track" src="' + snaps[k] + '"><div class="glsnap"><span>click to turn it</span></div>';
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
      boxes.forEach(function (b) { b.innerHTML = '<div class="gl-none">This browser could not start WebGL, so the 3D view is unavailable. The build list below still works.</div>'; });
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
    var res = RES[btn.getAttribute('data-id')], act = btn.getAttribute('data-act');
    var st = btn.closest('#checkOut') && CHECK ? CHECK.st : S ? S.st : readAll();
    if (!st || !res) return;
    if (act === 'copy') copy(res);
    else if (act === 'lite') download(res, st);
    else if (act === 'tester') downloadTester(res, st);
    else if (act === 'verify') verify(res, st, btn);
  }
  function copy(res) {
    var code = res.code;
    function done() { note(res.id, 'Copied.'); }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = code; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (err) { note(res.id, 'Copy failed: select the code and copy it.'); }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done, fallback);
    else fallback();
  }
  function download(res, st) {
    var code = res.code, v = res.v, o = optsFor(v), origin = originFor(startOf(code), st.pos);
    var b = E.build(code, origin, st.facing, o), r = E.run(code, origin, st.facing, false, 20000, o);
    var start = b.rails[0].pos, where = ' (exact for a start rail at ' + xyz(start) + ', track running ' + st.facing + ')';
    var what = !r.ok ? 'it does not park'
      : st.axis === 'y' ? 'it parks at y fraction ' + fmtFrac(r.y) + where
      : 'it parks, and once the parking rail is broken its ' + st.axis + ' fraction is ' + fmtFrac(axisValue(r, st.axis)) + where;
    var by = 'Found by the minecart alignment finder (created by 07km). ', levers = b.levers ? ' with the levers on' : '';
    var desc = v.how === 'fly'
      ? by + (v.boat ? 'Put a boat on the first flat rail of the launcher, below its top slopes, then place a plain minecart on the top slope' : 'Place a plain, empty minecart on the launch slope') +
        levers + ': it ' + (v.boat ? 'takes the boat aboard, ' : '') + 'flies off the launch slope, stops dead in mid-air against the ' + STOP_WORD[v.stopper] +
        ' and falls onto the start rail; ' + what + '. Nothing to break. Layout code: ' + code + '. Minecraft Java 26.2.'
      : v.how === 'loader'
      ? by + 'Put a boat on the first flat rail of the loading run, below its top slopes, then place a plain minecart on the top slope' + levers +
        ': it takes the boat aboard and stops against the ' + STOP_WORD[v.stopper] + '. Break the glass under it: the cart drops onto the start rail and ' + what +
        '. Layout code: ' + code + '. Minecraft Java 26.2.'
      : by + 'Place a plain, empty minecart on the start rail' + levers + '; ' + what + '. Layout code: ' + code + '. Minecraft Java 26.2.';
    var enc = LW.encode(b.blocks, 'Cart track ' + code, '07km', desc);
    var rel = [start[0] - enc.offset[0], start[1] - enc.offset[1], start[2] - enc.offset[2]];
    var url = URL.createObjectURL(new Blob([LW.gzipStored(enc.bytes)], { type: 'application/octet-stream' }));
    var a = document.createElement('a');
    a.href = url; a.download = 'track-' + code.replace(/\s+/g, '-') + (v.how === 'hand' ? '' : '-' + v.how + '-' + v.stopper + '-' + v.approach) + '.litematic';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    note(res.id, 'Saved. In the schematic, the start rail is ' + xyz(rel) + ' from its corner (' + enc.size.join(' × ') + ' blocks).');
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
    note(res.id, 'Saved with an automatic test. Paste it in an open area of a creative world with commands allowed (on a server: op, and ' +
      'enable-command-block=true). ' + (f.info.boat ? 'Command blocks summon the boat on its rail, then the cart on the launcher. '
        : f.info.how === 'fly' ? 'Command blocks summon the cart on the launcher. ' : '') + 'About ' + f.info.secs + ' seconds later the chat shows the result' +
      (st.axis === 'y' ? '' : ', after the test removes the parking rail') + '. Here it should say ' + (f.expect.passed ? 'PASS' : 'FAIL') +
      (st.axis === 'y' ? ' and ' + (f.expect.floatcart ? '"Floatcart!"' : '"Not a floatcart"') : '') +
      ' (' + st.axis + ' fraction ' + fmtFrac(v) + '). For exactly these numbers, place it with the start rail at ' + xyz(f.startRail) +
      ': that rail is ' + xyz(rel) + ' from the schematic\'s corner (' + f.size.join(' × ') + ' blocks).');
  }
  function verify(res, st, btn) {
    btn.disabled = true;
    note(res.id, 'Checking…');
    setTimeout(function () {
      var sv = res.v;
      var v = E.verify(res.code, { axis: st.axis, target: st.target, lo: st.lo, hi: st.hi, facing: st.facing,
                                   how: sv.how, boat: sv.boat, stopper: sv.stopper, approach: sv.approach });
      var good = v.parked === v.runs && (st.w === 0 || v.within === v.runs);
      var txt = v.parked === 0 ? '<b>The cart parked in none of the ' + v.runs + ' runs.</b>' :
        '<b>' + v.parked + ' of ' + v.runs + '</b> runs parked (15 world positions, out to ±29,999,000, ' +
        (st.axis === 'y' ? '× 4 directions' : 'track running ' + st.facing) + (sv.how === 'fly' ? ', flight included' : '') + '). ' +
        st.axis + ' fraction <span class="mono">' + v.min.toFixed(10) + '</span> to <span class="mono">' + v.max.toFixed(10) + '</span> (spread ' + fmtDist(v.max - v.min) + '). ' +
        (st.w > 0 ? '<b>' + v.within + ' of ' + v.runs + '</b> ' + (st.mode === 'range' ? 'in the range' : 'within ±' + st.w + ' of the target') + '. ' : '') +
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
    if (!st) { out.innerHTML = '<p class="hint err">Fix the highlighted setting above first.</p>'; return; }
    var L;
    try { L = E.parse(code); } catch (e) { out.innerHTML = '<p class="hint err">' + esc(e.message) + '. Codes start with S, Dr or Dp and end with E.</p>'; return; }
    var bad = E.problems(L.blocks);
    if (bad.length) { out.innerHTML = '<p class="hint err">Not buildable: ' + esc(bad.join('; ')) + '.</p>'; return; }
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
      h += '<p class="bnote">The ' + c.list.length + ' starts, the closest first. Click one for its build and 3D view.</p>' +
        '<table class="res"><thead><tr><th>#</th><th>Start</th><th>' + st.axis + ' fraction</th><th class="num">' + (st.mode === 'range' ? 'Inside by' : 'Off by') +
        '</th><th class="num">Rails</th><th class="num">Levers</th><th><span class="visually-hidden">Details</span></th></tr></thead><tbody>' +
        c.list.map(function (r, i) { return rowHTML(r, i, st, !!c.opened[r.id], 'start'); }).join('') + '</tbody></table>';
    }
    $('checkOut').innerHTML = h;
    syncViewer();
  }
  $('checkBtn').addEventListener('click', check);
  $('code').addEventListener('keydown', function (e) { if (e.key === 'Enter') check(); });

  syncAxis(); syncCart(); syncMode(); sizeHint();
  probeWorkers(['blob', 'data']);
})();
