/* engine.js — minecart physics and the layout search (makeEngine), shared by the finder, its
   Web Workers (built from makeEngine's own source, so this file must stay self-contained), the
   homepage and the tests. Plain JavaScript, no dependencies; in Node:
     var E = new Function(fs.readFileSync('engine.js', 'utf8') + '\nreturn makeEngine;')()();
   The physics began as a port of the retired Python simulator, checked against it to the last
   digit; this is now the reference. */

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
      place: (function (p) { return [p[0] + 0.5, p[1] + 0.5625, p[2] + 0.5]; })(ua(LOADER.FIRST, base + level + 2)),   // its spawn on that slope (M3)
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
