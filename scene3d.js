/* scene3d.js — the one WebGL renderer behind every 3D view on the site (the challenge build,
   the floatcart makers and the finder's track view). Plain WebGL 1, no libraries.

   const S = makeScene3D(host, { labels, tip, keep, view: { az, el } })
     host    a positioned element; the canvas fills it (pass opt.canvas to use an existing one)
     labels  element for text labels placed over the scene (optional)
     tip     element for the hover tooltip; hovering picks blocks and entities (optional)
     keep    keep the drawing buffer, so snapshot() can copy the picture
     view    the home camera angles
   Returns null when WebGL is not available.

   Blocks are [x, y, z, name, props] or {x, y, z, name, props}. Colours for carts, paths and
   dots are named ('run', 'sol', 'muted', 'ghost') and read from CSS custom properties on
   <html> (--run, --sol, --scene, --grid, --glass-edge, --focus), so a theme change repaints
   without rebuilding anything. The page drives time: it moves carts and calls request(). */
function makeScene3D(host, opt) {
  'use strict';
  opt = opt || {};
  var canvas = opt.canvas || host.appendChild(document.createElement('canvas'));
  var gl = null;
  try { gl = canvas.getContext('webgl', { antialias: true, alpha: false, preserveDrawingBuffer: !!opt.keep }); } catch (e) { gl = null; }
  if (!gl) return null;
  var labelsEl = opt.labels || null, tip = opt.tip || null;

  /* ---------- small math (column-major 4x4) ---------- */
  function hex(h, a) {
    h = String(h).trim().replace('#', '');
    if (h.length === 3) h = h.replace(/./g, '$&$&');
    var n = parseInt(h, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a == null ? 1 : a];
  }
  function shade(c, k, a) { return [c[0] * k, c[1] * k, c[2] * k, a == null ? c[3] : a]; }
  function withA(c, a) { return [c[0], c[1], c[2], a]; }
  function vsub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function vdot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function vcross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function vnorm(a) { var l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function ident() { var m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; }
  function mmul(a, b) {
    var m = new Float32Array(16);
    for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++) {
      m[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return m;
  }
  function chain() { var m = arguments[0]; for (var i = 1; i < arguments.length; i++) m = mmul(m, arguments[i]); return m; }
  function T(x, y, z) { var m = ident(); m[12] = x; m[13] = y; m[14] = z; return m; }
  function SC(x, y, z) { var m = ident(); m[0] = x; m[5] = y; m[10] = z; return m; }
  function RX(a) { var m = ident(), c = Math.cos(a), s = Math.sin(a); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; return m; }
  function RY(a) { var m = ident(), c = Math.cos(a), s = Math.sin(a); m[0] = c; m[2] = -s; m[8] = s; m[10] = c; return m; }
  function RZ(a) { var m = ident(), c = Math.cos(a), s = Math.sin(a); m[0] = c; m[1] = s; m[4] = -s; m[5] = c; return m; }
  function boxM(mn, sz) { return chain(T(mn[0], mn[1], mn[2]), SC(sz[0], sz[1], sz[2])); }
  function persp(fovy, asp, n, f) {
    var t = 1 / Math.tan(fovy / 2), m = new Float32Array(16);
    m[0] = t / asp; m[5] = t; m[10] = (f + n) / (n - f); m[11] = -1; m[14] = 2 * f * n / (n - f);
    return m;
  }
  function lookAt(e, c, up) {
    var z = vnorm(vsub(e, c)), x = vnorm(vcross(up, z)), y = vcross(z, x), m = ident();
    m[0] = x[0]; m[4] = x[1]; m[8] = x[2]; m[1] = y[0]; m[5] = y[1]; m[9] = y[2]; m[2] = z[0]; m[6] = z[1]; m[10] = z[2];
    m[12] = -vdot(x, e); m[13] = -vdot(y, e); m[14] = -vdot(z, e);
    return { m: m, x: x, y: y, z: z };
  }
  // every mesh is a scaled, rotated box, and a box's face normals stay axis-aligned in its own
  // frame, so the upper 3x3 gives the right directions once the shader normalises them
  function normalMat(m) { return new Float32Array([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]); }
  function xf(m, p) {
    return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
            m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
  }
  function aabbOf(m) {
    var b = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9];
    for (var i = 0; i < 8; i++) {
      var p = xf(m, [i & 1, (i >> 1) & 1, (i >> 2) & 1]);
      for (var k = 0; k < 3; k++) { b[k] = Math.min(b[k], p[k]); b[k + 3] = Math.max(b[k + 3], p[k]); }
    }
    return b;
  }
  function unionBox(list) {
    var b = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9];
    list.forEach(function (o) { for (var k = 0; k < 3; k++) { b[k] = Math.min(b[k], o.aabb[k]); b[k + 3] = Math.max(b[k + 3], o.aabb[k + 3]); } });
    return b;
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* ---------- programs and buffers ---------- */
  // Meshes: the colour, shaded by the face's direction; lines and meshes both fade into the
  // background with distance (uFog: start, end, strength; uFogC).
  var FOG = 'uniform vec3 uFog;uniform vec3 uFogC;vec3 fog(vec3 c,float d){return mix(c,uFogC,clamp((d-uFog.x)/(uFog.y-uFog.x),0.0,1.0)*uFog.z);}';
  var VS = 'attribute vec3 aPos;attribute vec3 aNrm;uniform mat4 uPV;uniform mat4 uM;uniform mat3 uN;varying vec3 vN;varying float vD;' +
           'void main(){vN=uN*aNrm;gl_Position=uPV*uM*vec4(aPos,1.0);vD=gl_Position.w;}';
  var FS = 'precision mediump float;uniform vec4 uColor;varying vec3 vN;varying float vD;' + FOG +
           'void main(){vec3 n=normalize(vN);float l=0.62*n.x*n.x+0.8*n.z*n.z+(n.y>0.0?1.0:0.5)*n.y*n.y;' +
           'gl_FragColor=vec4(fog(uColor.rgb*l,vD),uColor.a);}';
  var LVS = 'attribute vec3 aPos;uniform mat4 uPV;uniform mat4 uM;varying float vD;void main(){gl_Position=uPV*uM*vec4(aPos,1.0);vD=gl_Position.w;}';
  var LFS = 'precision mediump float;uniform vec4 uColor;varying float vD;' + FOG + 'void main(){gl_FragColor=vec4(fog(uColor.rgb,vD),uColor.a*(1.0-clamp((vD-uFog.x)/(uFog.y-uFog.x),0.0,1.0)*uFog.z*0.6));}';
  function shader(type, src) {
    var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function program(vs, fs) {
    var p = gl.createProgram();
    gl.attachShader(p, shader(gl.VERTEX_SHADER, vs)); gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }
  var PM = program(VS, FS), PL = program(LVS, LFS);
  var AM = { aPos: gl.getAttribLocation(PM, 'aPos'), aNrm: gl.getAttribLocation(PM, 'aNrm'), uPV: gl.getUniformLocation(PM, 'uPV'),
             uM: gl.getUniformLocation(PM, 'uM'), uN: gl.getUniformLocation(PM, 'uN'), uColor: gl.getUniformLocation(PM, 'uColor'),
             uFog: gl.getUniformLocation(PM, 'uFog'), uFogC: gl.getUniformLocation(PM, 'uFogC') };
  var AL = { aPos: gl.getAttribLocation(PL, 'aPos'), uPV: gl.getUniformLocation(PL, 'uPV'), uM: gl.getUniformLocation(PL, 'uM'),
             uColor: gl.getUniformLocation(PL, 'uColor'), uFog: gl.getUniformLocation(PL, 'uFog'), uFogC: gl.getUniformLocation(PL, 'uFogC') };

  function vbo(arr) { var b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW); return b; }
  function lineBuf(arr) { return { b: vbo(new Float32Array(arr)), n: arr.length / 3 }; }

  // unit cube: 6 faces x 4 vertices (position, normal), counter-clockwise from outside
  var FACES = [
    [[1, 0, 0], [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]]], [[-1, 0, 0], [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]]],
    [[0, 1, 0], [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]]], [[0, -1, 0], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]],
    [[0, 0, 1], [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]], [[0, 0, -1], [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]]]];
  var cv = [], ci = [];
  FACES.forEach(function (f, i) {
    f[1].forEach(function (v) { cv.push(v[0], v[1], v[2], f[0][0], f[0][1], f[0][2]); });
    ci.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
  });
  var cubeVB = vbo(new Float32Array(cv)), cubeIB = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, cubeIB);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(ci), gl.STATIC_DRAW);
  var ev = [];
  [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]].forEach(function (e) {
    e.forEach(function (i) { ev.push(i & 1, (i >> 1) & 1, (i >> 2) & 1); });
  });
  var LINES = { edges: lineBuf(ev), grid: null };
  var gv = [];                                              // the copper grate's bars, on all six faces
  [0.25, 0.5, 0.75].forEach(function (u) {
    [0, 1].forEach(function (w) {
      gv.push(w, u, 0, w, u, 1, w, 0, u, w, 1, u, 0, w, u, 1, w, u, u, w, 0, u, w, 1, 0, u, w, 1, u, w, u, 0, w, u, 1, w);
    });
  });
  LINES.grate = lineBuf(gv);

  /* ---------- theme ---------- */
  var TH = {};
  function readTheme() {
    var cs = getComputedStyle(document.documentElement);
    function g(n, d) { return (cs.getPropertyValue(n) || '').trim() || d; }
    TH.scene = hex(g('--scene', '#f2f2f4'));
    TH.grid = hex(g('--grid', '#d6d7dc'), 0.95);
    TH.glassEdge = hex(g('--glass-edge', '#8aa1b4'), 0.85);
    TH.shade = hex(g('--scene-shade', '#2a241c'));
    TH.run = hex(g('--run', '#eb6834'));
    TH.sol = hex(g('--sol', '#1baf7a'));
    TH.focus = hex(g('--focus', '#2a78d6'));
    TH.dark = (TH.scene[0] + TH.scene[1] + TH.scene[2]) < 1.2;
    TH.muted = TH.dark ? [0.8, 0.82, 0.86, 1] : [0.24, 0.26, 0.3, 1];
    TH.ghost = TH.dark ? [0.72, 0.74, 0.78, 1] : [0.42, 0.44, 0.48, 1];
    request();
  }

  /* ---------- scene objects ---------- */
  // Minecraft's own colours, the same in both themes
  var C = {
    glass: '#ffffff', concrete: '#dde2e4', honey: '#f2a126', honeyCore: '#df8a10', grate: '#4e9d85', water: '#3569de',
    bud: '#9b5fd6', note: '#6e4a33', observer: '#747474', observerFace: '#3b3b3b', red: '#c0342b', piston: '#8e8e8e',
    pistonFace: '#b98f58', wall: '#4b4b54', scaff: '#c7a45a', scaffTop: '#d6b56a', tie: '#6b5236', gold: '#e6bd3a',
    goldOff: '#8a7434', iron: '#a7abb0', lit: '#ec3b2a', unlit: '#4f2320', detector: '#7d4f4a', sign: '#dd9b98',
    lever: '#6c6c6c', stick: '#7a5431', axle: '#3b3f44', stand: '#a27b4c', standBase: '#9b9b9b', boat: '#a9743e', boatTrim: '#7d5124'
  };
  var objs = [], picks = [], byPos = {}, notes = {}, signs = {}, fitPts = [], rails = {}, railRec = {}, shadows = [];
  var calm = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);   // no particles or drop-ins
  // col: [r,g,b,a], or a theme key ('run', 'sol', ...) with an alpha; edge: a colour, 'dark', 'glass' or null
  function add(m, col, o) {
    o = o || {};
    var ob = { m: m, nm: normalMat(m), col: typeof col === 'string' ? null : col, key: typeof col === 'string' ? col : null,
               a: o.a == null ? 1 : o.a, edge: o.edge === undefined ? 'dark' : o.edge, lines: o.lines || null, bias: o.bias || 0,
               aabb: aabbOf(m), tag: o.tag || null };
    ob.trans = (ob.col ? ob.col[3] : ob.a) < 1;
    objs.push(ob); return ob;
  }
  function setM(ob, m) { ob.m = m; ob.nm = normalMat(m); ob.aabb = aabbOf(m); }
  function colOf(ob) { return ob.key ? withA(TH[ob.key], ob.a) : ob.col; }
  function edgeOf(ob) {
    if (!ob.edge) return null;
    if (ob.edge === 'glass') return TH.glassEdge;
    if (ob.edge === 'dark') return shade(colOf(ob), 0.55, ob.trans ? 0.5 : 0.75);
    return ob.edge;
  }

  var BUDS = { small_amethyst_bud: [3, 8], medium_amethyst_bud: [4, 10], large_amethyst_bud: [5, 10], amethyst_cluster: [7, 10] };
  // a bud fills height/16 out of the face it grows on and is width/16 across, centred (C11)
  function budBox(name, facing) {
    var d = BUDS[name], h = d[0] / 16, w = d[1] / 16, lo = 0.5 - w / 2, hi = 0.5 + w / 2;
    switch (facing) {
      case 'north': return [lo, lo, 1 - h, hi, hi, 1];
      case 'south': return [lo, lo, 0, hi, hi, h];
      case 'west': return [1 - h, lo, lo, 1, hi, hi];
      case 'east': return [0, lo, lo, h, hi, hi];
      case 'down': return [lo, 1 - h, lo, hi, 1, hi];
      default: return [lo, 0, lo, hi, h, hi];
    }
  }
  // a wall lever points away from the block it hangs on, so its plate is on the far side
  function leverDir(f) { return f === 'north' ? [0, -1] : f === 'south' ? [0, 1] : f === 'west' ? [-1, 0] : [1, 0]; }
  var YAW = { '1,0': 0, '-1,0': Math.PI, '0,1': -Math.PI / 2, '0,-1': Math.PI / 2 };
  function leverM(x, y, z, facing, on) {
    var d = leverDir(facing);
    return chain(T(x + 0.5 - d[0] * 0.3125, y + 0.5, z + 0.5 - d[1] * 0.3125), RY(YAW[d[0] + ',' + d[1]]),
                 RZ(on ? -0.75 : 0.75), T(0, -0.04, -0.04), SC(0.56, 0.08, 0.08));
  }

  function addBlock(b, off) {
    var arr = Array.isArray(b);
    var x = (arr ? b[0] : b.x) - off[0], y = (arr ? b[1] : b.y) - off[1], z = (arr ? b[2] : b.z) - off[2];
    var name = String(arr ? b[3] : b.name).replace('minecraft:', ''), pr = (arr ? b[4] : b.props) || {}, parts = [];
    function P(mn, sz, col, o) { var ob = add(boxM([x + mn[0], y + mn[1], z + mn[2]], sz), col, o); parts.push(ob); return ob; }
    var rec = { pos: [x, y, z], key: (x + off[0]) + ',' + (y + off[1]) + ',' + (z + off[2]), name: name, pr: pr, parts: parts };
    if (/stained_glass$|^glass$/.test(name)) P([0, 0, 0], [1, 1, 1], hex(C.glass, 0.13), { edge: 'glass' });
    else if (/concrete$/.test(name)) P([0, 0, 0], [1, 1, 1], hex(C.concrete));
    else if (BUDS[name]) {
      var bd = budBox(name, pr.facing || 'up');
      P([bd[0], bd[1], bd[2]], [bd[3] - bd[0], bd[4] - bd[1], bd[5] - bd[2]], hex(C.bud));
    } else switch (name) {
      case 'honey_block':
        P([0, 0, 0], [1, 1, 1], hex(C.honey, 0.55), { edge: hex('#b36d0c', 0.9) });
        P([0.0625, 0.0625, 0.0625], [0.875, 0.875, 0.875], hex(C.honeyCore, 0.45), { edge: null, bias: 0.05 });
        break;
      case 'waxed_oxidized_copper_grate':
        P([0, 0, 0], [1, 1, 1], hex(C.grate, 0.38), { edge: hex('#2f6e5c', 0.95), lines: 'grate' });
        if (pr.waterlogged !== 'false') P([0.03, 0.03, 0.03], [0.94, 0.86, 0.94], hex(C.water, 0.33), { edge: null, bias: 0.05 });
        break;
      case 'note_block': P([0, 0, 0], [1, 1, 1], hex(C.note)); break;
      case 'observer':                                     // as built in the challenge: face north
        P([0, 0, 0], [1, 1, 1], hex(C.observer));
        P([0.12, 0.12, -0.012], [0.76, 0.76, 0.02], hex(C.observerFace), { edge: null });
        P([0.4, 0.4, 0.992], [0.2, 0.2, 0.02], hex(C.red), { edge: null });
        break;
      case 'piston':                                       // facing west
        P([0.25, 0, 0], [0.75, 1, 1], hex(C.piston));
        P([0, 0, 0], [0.25, 1, 1], hex(C.pistonFace));
        break;
      case 'polished_deepslate_wall':
        P([0.25, 0, 0.25], [0.5, 1, 0.5], hex(C.wall));
        if (pr.south === 'low') P([0.3125, 0, 0.5], [0.375, 0.875, 0.5], hex(C.wall));
        break;
      case 'scaffolding':
        P([0, 0.875, 0], [1, 0.125, 1], hex(C.scaffTop));
        [[0, 0], [0.875, 0], [0, 0.875], [0.875, 0.875]].forEach(function (c) { P([c[0], 0, c[1]], [0.125, 0.875, 0.125], hex(C.scaff)); });
        if (pr.bottom === 'true') {
          P([0.125, 0, 0], [0.75, 0.125, 0.125], hex(C.scaff)); P([0.125, 0, 0.875], [0.75, 0.125, 0.125], hex(C.scaff));
          P([0, 0, 0.125], [0.125, 0.125, 0.75], hex(C.scaff)); P([0.875, 0, 0.125], [0.125, 0.125, 0.75], hex(C.scaff));
        }
        break;
      case 'cherry_wall_sign': P([0.875, 0.28125, 0], [0.125, 0.5, 1], hex(C.sign)); break;   // facing west
      case 'lever':
        var d = leverDir(pr.facing);
        P([d[0] > 0 ? 0 : d[0] < 0 ? 0.8125 : 0.3125, 0.25, d[1] > 0 ? 0 : d[1] < 0 ? 0.8125 : 0.3125],
          [d[0] ? 0.1875 : 0.375, 0.5, d[1] ? 0.1875 : 0.375], hex(C.lever));
        rec.handle = add(leverM(x, y, z, pr.facing, pr.powered === 'true'), hex(C.stick), { edge: null });
        parts.push(rec.handle);
        break;
      case 'rail': case 'powered_rail': case 'detector_rail': case 'activator_rail':
        rail(rec, x, y, z, pr.shape || 'north_south', name, pr.powered === 'true');
        rails[x + ',' + y + ',' + z] = pr.shape || 'north_south';
        railRec[x + ',' + y + ',' + z] = rec;
        if (pr.waterlogged === 'true') P([0, 0, 0], [1, 0.889, 1], hex(C.water, 0.2), { edge: hex(C.water, 0.35) });
        break;
      default: P([0, 0, 0], [1, 1, 1], hex('#ff00ff'));
    }
    byPos[rec.key] = rec;
    picks.push({ aabb: unionBox(parts), rec: rec, info: function () { return blockInfo(rec); } });
    fitPts.push([x, y, z], [x + 1, y + 1, z + 1]);
  }
  // the track runs along local z, turned a quarter for east-west rails and tilted for slopes
  function rail(rec, x, y, z, shape, kind, powered) {
    var asc = shape.indexOf('ascending') === 0, L = asc ? Math.SQRT2 : 1;
    var base = T(x + 0.5, y + (asc ? 0.5 : 0), z + 0.5);
    if (/east|west/.test(shape)) base = chain(base, RY(Math.PI / 2));
    if (asc) base = chain(base, RX(/south|east/.test(shape) ? -Math.PI / 4 : Math.PI / 4));
    function B(mn, sz, col) { var ob = add(chain(base, boxM(mn, sz)), col, { edge: null }); rec.parts.push(ob); return ob; }
    var n = asc ? 6 : 4;
    for (var i = 0; i < n; i++) B([-0.42, 0, -L / 2 + (i + 0.5) * L / n - 0.065], [0.84, 0.03, 0.13], hex(C.tie));
    var metal = kind === 'powered_rail' ? (powered ? C.gold : C.goldOff) : C.iron;
    rec.rails = [B([-0.34, 0.03, -L / 2], [0.08, 0.04, L], hex(metal)), B([0.26, 0.03, -L / 2], [0.08, 0.04, L], hex(metal))];
    if (kind === 'powered_rail') rec.strip = B([-0.04, 0.02, -L / 2 + 0.04], [0.08, 0.025, L - 0.08], hex(powered ? C.lit : C.unlit));
    if (kind === 'detector_rail') B([-0.14, 0.02, -0.14], [0.28, 0.035, 0.28], hex(C.detector));
  }
  function pretty(n) { return n.replace(/_/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); }); }
  function blockInfo(rec) {
    var pr = rec.pr, k = rec.key, bits = [];
    var live = rec.live === undefined ? pr.powered === 'true' : rec.live;
    if (pr.shape) bits.push(pr.shape.replace('_', ' '));
    if (rec.name === 'powered_rail') bits.push(live ? 'powered' : 'unpowered');
    if (rec.name === 'lever') bits.push(live ? 'on' : 'off');
    if (pr.facing && rec.name !== 'lever' && !/sign$/.test(rec.name)) bits.push('facing ' + pr.facing);
    if (pr.waterlogged === 'true' || rec.name === 'waxed_oxidized_copper_grate') bits.push('waterlogged');
    var h = '<b>' + esc(pretty(rec.name)) + '</b><span class="k">(' + k.replace(/,/g, ', ') + ')' + (bits.length ? ' · ' + esc(bits.join(' · ')) : '') + '</span>';
    if (signs[k]) h += '<div class="note">“' + esc(signs[k].join(' / ')) + '”</div>';
    if (notes[k]) h += '<div class="note">' + esc(notes[k]) + '</div>';
    return h;
  }

  /* ---------- entities ---------- */
  var HW = 0.49000000953674316, HH = 0.699999988079071;   // the minecart's hitbox: 0.98 wide, 0.7 tall
  var CART = [
    [[-0.4, 0.12, -0.49], [0.8, 0.06, 0.98], 1], [[-0.4, 0.12, -0.49], [0.06, 0.5, 0.98], 1],
    [[0.34, 0.12, -0.49], [0.06, 0.5, 0.98], 1], [[-0.34, 0.12, -0.49], [0.68, 0.5, 0.06], 1],
    [[-0.34, 0.12, 0.43], [0.68, 0.5, 0.06], 1], [[-0.44, 0.03, -0.33], [0.88, 0.09, 0.1], 0],
    [[-0.44, 0.03, 0.23], [0.88, 0.09, 0.1], 0],
    [[-0.47, -0.02, -0.36], [0.07, 0.19, 0.19], 0], [[0.4, -0.02, -0.36], [0.07, 0.19, 0.19], 0],     // wheels
    [[-0.47, -0.02, 0.17], [0.07, 0.19, 0.19], 0], [[0.4, -0.02, 0.17], [0.07, 0.19, 0.19], 0]];
  var carts = [], boxes = [];
  // Where a cart rides, as the game works it out (R1, R2): the rail under its feet or at them, and
  // the point on that rail's track line for its x and z. Straight rails only.
  var RAIL_EXITS = { north_south: [[0, 0, -1], [0, 0, 1]], east_west: [[-1, 0, 0], [1, 0, 0]],
    ascending_east: [[-1, -1, 0], [1, 0, 0]], ascending_west: [[-1, 0, 0], [1, -1, 0]],
    ascending_north: [[0, 0, -1], [0, -1, 1]], ascending_south: [[0, -1, -1], [0, 0, 1]] };
  function railUnder(x, y, z) {
    var xt = Math.floor(x), yt = Math.floor(y), zt = Math.floor(z), s = rails[xt + ',' + (yt - 1) + ',' + zt];
    if (s === undefined) s = rails[xt + ',' + yt + ',' + zt]; else yt--;
    return RAIL_EXITS[s] ? { ex: RAIL_EXITS[s], x: xt, y: yt, z: zt, slope: s.indexOf('ascending') === 0 } : null;
  }
  function trackPos(x, y, z) {
    var r = railUnder(x, y, z);
    if (!r) return null;
    var e0 = r.ex[0], e1 = r.ex[1], x0 = r.x + 0.5 + e0[0] * 0.5, y0 = r.y + 0.0625 + e0[1] * 0.5, z0 = r.z + 0.5 + e0[2] * 0.5;
    var xD = e1[0] - e0[0], yD = e1[1] - e0[1], zD = e1[2] - e0[2];
    var p = xD === 0 ? z - r.z : x - r.x, yy = y0 + yD * p;
    return [x0 + xD * 0.5 * p, yD < 0 ? yy + 1 : yD > 0 ? yy + 0.5 : yy, z0 + zD * 0.5 * p];
  }
  // the track point `off` along the rail from (x, z), stepping onto the next rail where it must
  function trackPosOffs(x, y, z, off) {
    var r = railUnder(x, y, z);
    if (!r) return null;
    var e0 = r.ex[0], e1 = r.ex[1], yy = r.y + (r.slope ? 1 : 0);
    x += (e1[0] - e0[0]) / 2 * off; z += (e1[2] - e0[2]) / 2 * off;
    if (e0[1] !== 0 && Math.floor(x) - r.x === e0[0] && Math.floor(z) - r.z === e0[2]) yy += e0[1];
    else if (e1[1] !== 0 && Math.floor(x) - r.x === e1[0] && Math.floor(z) - r.z === e1[2]) yy += e1[1];
    return trackPos(x, yy, z);
  }
  // How a cart at p lies, as the game draws it: along its rail, tipped by the track's rise from the
  // point 0.3 behind it to the point 0.3 ahead, so it tips over gradually where a slope meets a flat
  // rail. Level off the rails (flying, or resting on the honey above one).
  function cartTurn(p) {
    var on = trackPos(p[0], p[1], p[2]);
    if (!on || Math.abs(on[1] - p[1]) > 0.3) return ident();
    var a = trackPosOffs(p[0], p[1], p[2], 0.3) || on, b = trackPosOffs(p[0], p[1], p[2], -0.3) || on;
    var dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2], h = Math.hypot(dx, dz);
    if (h < 1e-9) { var r = railUnder(p[0], p[1], p[2]); dx = r.ex[1][0] - r.ex[0][0]; dz = r.ex[1][2] - r.ex[0][2]; dy = 0; h = Math.hypot(dx, dz); }
    return chain(RY(Math.atan2(dx, dz)), RX(-Math.atan2(dy, h)));
  }
  // a cart: body in a theme colour (key), its hitbox outlined. o.xray draws it through blocks.
  // The body follows the rail (cartTurn); the outline is the hitbox, which never turns.
  function makeCart(key, o) {
    o = o || {};
    var a = o.alpha == null ? 1 : o.alpha, c = { key: key, a: a, parts: [], hit: null, xray: !!o.xray, visible: false, line: o.line == null ? 0.95 : o.line };
    CART.forEach(function (p) {
      var ob = add(ident(), p[2] ? key : hex(C.axle, a), { a: a, edge: a < 1 ? null : 'dark', tag: 'cart' });
      ob.local = p; ob.hidden = true; c.parts.push(ob);
    });
    c.place = function (p) {
      if (!p) { c.visible = false; c.parts.forEach(function (ob) { ob.hidden = true; }); request(); return c; }
      c.visible = true; c.pos = p;
      var at = chain(T(p[0], p[1], p[2]), cartTurn(p));
      c.parts.forEach(function (ob) { ob.hidden = false; setM(ob, chain(at, boxM(ob.local[0], ob.local[1]))); });
      c.hit = boxM([p[0] - HW, p[1], p[2] - HW], [2 * HW, HH, 2 * HW]);
      c.aabb = [p[0] - HW, p[1], p[2] - HW, p[0] + HW, p[1] + HH, p[2] + HW];
      if (a === 1 && c.last && Math.abs(c.last[0] - p[0]) + Math.abs(c.last[2] - p[2]) > 0.02) {   // redstone sparks off a lit powered rail
        var ru = railUnder(p[0], p[1], p[2]), rr = ru && railRec[ru.x + ',' + ru.y + ',' + ru.z];
        if (rr && rr.name === 'powered_rail' && (rr.live === undefined ? rr.pr.powered === 'true' : rr.live) && Math.random() < 0.7)
          burst([p[0] + (Math.random() - 0.5) * 0.5, p[1] + 0.08, p[2] + (Math.random() - 0.5) * 0.5], { n: 2, col: C.lit, speed: 0.9, up: 1.4, life: 0.55, size: 0.05 });
      }
      c.last = p;
      request(); return c;
    };
    c.fit = function () { if (c.aabb) fitPts.push(c.aabb.slice(0, 3), c.aabb.slice(3)); return c; };
    c.pick = function (fn) { picks.push({ aabb: null, cart: c, info: fn }); return c; };
    c.recolor = function (k) { c.key = k; c.parts.forEach(function (ob) { if (ob.local[2]) ob.key = k; }); request(); return c; };
    carts.push(c);
    return c;
  }
  function addStand(sp, info) {
    [[[-0.375, 0, -0.375], [0.75, 0.0625, 0.75], C.standBase], [[-0.0625, 0.0625, -0.0625], [0.125, 1.3, 0.125], C.stand],
     [[-0.25, 0.72, -0.0625], [0.5, 0.125, 0.125], C.stand], [[-0.375, 1.3, -0.09], [0.75, 0.18, 0.18], C.stand],
     [[-0.0625, 1.48, -0.0625], [0.125, 0.42, 0.125], C.stand]].forEach(function (p) {
      add(boxM([sp[0] + p[0][0], sp[1] + p[0][1], sp[2] + p[0][2]], p[1]), hex(p[2]));
    });
    var bb = [sp[0] - 0.25, sp[1], sp[2] - 0.25, sp[0] + 0.25, sp[1] + 1.975, sp[2] + 0.25];
    if (info) picks.push({ aabb: bb, info: info });
    fitPts.push(bb.slice(0, 3), bb.slice(3));
  }
  var BOAT_W = 1.375, BOAT_H = 0.5625;                       // every boat and raft (EntityType)
  // a boat at p (the middle of its bottom); place() moves it, as a cart carries it
  function addBoat(p) {
    var col = hex(C.boat), trim = hex(C.boatTrim), w = BOAT_W, h = BOAT_H - 0.1, b = { parts: [] };
    [[[0, 0, 0], [w, 0.1, w], col], [[0, 0.1, 0], [w, h, 0.12], trim], [[0, 0.1, w - 0.12], [w, h, 0.12], trim],
     [[0, 0.1, 0], [0.12, h, w], trim], [[w - 0.12, 0.1, 0], [0.12, h, w], trim]].forEach(function (q) {
      var ob = add(ident(), q[2]); ob.local = q; b.parts.push(ob);
    });
    b.place = function (p) {
      var x0 = p[0] - w / 2, z0 = p[2] - w / 2;
      b.parts.forEach(function (ob) { setM(ob, boxM([x0 + ob.local[0][0], p[1] + ob.local[0][1], z0 + ob.local[0][2]], ob.local[1])); });
      request(); return b;
    };
    b.place(p);
    fitPts.push([p[0] - w / 2, p[1], p[2] - w / 2], [p[0] + w / 2, p[1] + BOAT_H, p[2] + w / 2]);
    return b;
  }

  /* ---------- particles: little cubes thrown out, falling and fading (redstone sparks, dust, a floatcart's burst) ---------- */
  var parts = [];
  // o: n, col (hex), speed (sideways, blocks a second), up, life (seconds), size, grav
  function burst(p, o) {
    if (calm || !p) return;
    o = o || {};
    for (var i = 0; i < (o.n || 12); i++) {
      var a = Math.random() * Math.PI * 2, sp = (o.speed == null ? 1.5 : o.speed) * (0.4 + Math.random() * 0.6), sz = (o.size || 0.07) * (0.7 + Math.random() * 0.6);
      var col = hex(o.col || '#8c8577', 1);
      var ob = add(boxM([p[0], p[1], p[2]], [sz, sz, sz]), col, { edge: null, tag: 'fx' });
      ob.trans = true;
      parts.push({ ob: ob, p: p.slice(), v: [Math.cos(a) * sp, (o.up == null ? 2 : o.up) * (0.5 + Math.random() * 0.7), Math.sin(a) * sp],
                   age: 0, life: (o.life || 0.8) * (0.7 + Math.random() * 0.6), sz: sz, g: o.grav == null ? 6 : o.grav });
    }
    request();
  }
  function stepParticles(dt) {
    for (var i = parts.length - 1; i >= 0; i--) {
      var q = parts[i];
      q.age += dt;
      if (q.age >= q.life) { var j = objs.indexOf(q.ob); if (j >= 0) objs.splice(j, 1); parts.splice(i, 1); continue; }
      q.v[1] -= q.g * dt;
      for (var k = 0; k < 3; k++) q.p[k] += q.v[k] * dt;
      var f = 1 - q.age / q.life, s = q.sz * (0.4 + 0.6 * f);
      q.ob.col[3] = Math.min(1, f * 1.6);
      setM(q.ob, boxM([q.p[0] - s / 2, q.p[1] - s / 2, q.p[2] - s / 2], [s, s, s]));
    }
  }
  /* ---------- blocks dropping into place, one after another (a new track being built) ---------- */
  var rising = null;
  function rise(done) {
    var recs = Object.keys(byPos).map(function (k) { return byPos[k]; });
    if (calm || !recs.length) { if (done) done(); return; }
    recs.sort(function (a, b) { return a.pos[1] - b.pos[1] || (a.pos[0] + a.pos[2]) - (b.pos[0] + b.pos[2]); });
    var gap = Math.min(45, 1100 / recs.length);
    rising = { t0: performance.now(), done: done, dur: 320, end: 0,
               items: recs.map(function (r, i) { return { delay: i * gap, parts: r.parts.map(function (ob) { ob.hidden = true; return { ob: ob, m: ob.m }; }) }; }) };
    rising.end = (recs.length - 1) * gap + rising.dur;
    shadows.forEach(function (o) { o.hidden = true; });
    request();
  }
  function stepRise(now) {
    var R = rising, el = now - R.t0;
    R.items.forEach(function (it) {
      var k = Math.max(0, Math.min(1, (el - it.delay) / R.dur));
      var e = 1 - Math.pow(1 - k, 3), dy = (1 - e) * 1.4;                 // eases down from 1.4 blocks up
      it.parts.forEach(function (q) { q.ob.hidden = k <= 0; setM(q.ob, chain(T(0, dy, 0), q.m)); });
    });
    if (el < R.end) return true;
    shadows.forEach(function (o) { o.hidden = false; });
    rising = null;
    if (R.done) R.done();
    return false;
  }

  /* ---------- paths, tick dots, labels ---------- */
  var paths = {}, dots = [], LABELS = [];
  var show = { paths: true, dots: true, labels: true };
  function setPath(name, pts, o) {
    if (paths[name]) gl.deleteBuffer(paths[name].buf.b);
    if (!pts) { delete paths[name]; request(); return; }
    var a = [];
    pts.forEach(function (p) { a.push(p[0], p[1], p[2]); });
    paths[name] = { buf: lineBuf(a), key: o.key, a: o.alpha == null ? 1 : o.alpha, xray: !!o.xray };
    request();
  }
  function setDots(pts, key) {
    dots.forEach(function (o) { var i = objs.indexOf(o); if (i >= 0) objs.splice(i, 1); });
    dots = (pts || []).map(function (p) {
      var ob = add(boxM([p[0] - 0.035, p[1] - 0.035, p[2] - 0.035], [0.07, 0.07, 0.07]), key, { edge: null, tag: 'dot' });
      return ob;
    });
    request();
  }
  function setLabels(list) {
    LABELS.forEach(function (L) { if (L.el.parentNode) L.el.parentNode.removeChild(L.el); });
    LABELS = [];
    if (!labelsEl) return;
    LABELS = (list || []).map(function (L) {
      var el = document.createElement('div');
      el.className = 'lbl' + (L.cls ? ' ' + L.cls : '');
      el.textContent = L.t;
      labelsEl.appendChild(el);
      if (L.cls !== 'compass') fitPts.push([L.p[0], L.p[1] + 0.45, L.p[2]]);
      return { p: L.p, cls: L.cls || '', el: el, w: 0 };
    });
    request();
  }

  /* ---------- camera ---------- */
  var view0 = opt.view || { az: 1.12, el: 0.34 };
  var cam = { target: [0, 0, 0], az: view0.az, el: view0.el, r: 20, fov: 36 * Math.PI / 180 };
  var HOME = null, cssW = 1, cssH = 1, measured = false, touched = false, view = null, eyeP = [0, 0, 0], PV = ident();
  // far enough out that no point of the build is behind the camera
  function safeR(target) {
    var far = 0;
    fitPts.forEach(function (p) { far = Math.max(far, Math.hypot(p[0] - target[0], p[1] - target[1], p[2] - target[2])); });
    return far * 1.15 + 1;
  }
  // frame every block, entity and label: centre them in the part of the canvas that nothing
  // covers (opt.pad: px taken by overlays at the top and bottom), then scale the distance to fit
  var pad = opt.pad || {};
  function fitHome() {
    if (!fitPts.length) return;
    var asp = cssW / cssH, th = Math.tan(cam.fov / 2), bb = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9];
    fitPts.forEach(function (p) { for (var q = 0; q < 3; q++) { bb[q] = Math.min(bb[q], p[q]); bb[q + 3] = Math.max(bb[q + 3], p[q]); } });
    var centre = [(bb[0] + bb[3]) / 2, (bb[1] + bb[4]) / 2, (bb[2] + bb[5]) / 2], rad = safeR(centre);
    var h = { target: centre, az: view0.az, el: view0.el, r: Math.max(rad, (rad - 1) / 1.15 / Math.min(th, th * asp)) };
    var top = Math.min(pad.top || 0, cssH * 0.3), bot = Math.min(pad.bottom || 0, cssH * 0.3);
    var free = 1 - (top + bot) / cssH, cy0 = (bot - top) / cssH;
    var mx = asp < 0.8 ? 0.84 : 0.86, my = (asp < 0.8 ? 0.8 : 0.84) * free;
    for (var it = 0; it < 8; it++) {
      var ce = Math.cos(h.el);
      var eye = [h.target[0] + h.r * ce * Math.sin(h.az), h.target[1] + h.r * Math.sin(h.el), h.target[2] + h.r * ce * Math.cos(h.az)];
      var L = lookAt(eye, h.target, [0, 1, 0]), M = mmul(persp(cam.fov, asp, 0.1, 400), L.m);
      var x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (var i = 0; i < fitPts.length; i++) {
        var p = fitPts[i];
        var cx = M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12], cy = M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13],
            cw = M[3] * p[0] + M[7] * p[1] + M[11] * p[2] + M[15];
        x0 = Math.min(x0, cx / cw); x1 = Math.max(x1, cx / cw); y0 = Math.min(y0, cy / cw); y1 = Math.max(y1, cy / cw);
      }
      var ox = (x0 + x1) / 2, oy = (y0 + y1) / 2 - cy0, k = Math.max((x1 - x0) / 2 / mx, (y1 - y0) / 2 / my);
      for (var j = 0; j < 3; j++) h.target[j] += L.x[j] * ox * h.r * th * asp + L.y[j] * oy * h.r * th;
      h.r = Math.max(safeR(h.target), Math.min(200, h.r * k));
    }
    HOME = h;
  }
  function resetView() {
    if (!HOME) return;
    cam.target = HOME.target.slice(); cam.az = HOME.az; cam.el = HOME.el; cam.r = HOME.r; touched = false;
    request();
  }
  function computeCam() {
    var ce = Math.cos(cam.el);
    eyeP = [cam.target[0] + cam.r * ce * Math.sin(cam.az), cam.target[1] + cam.r * Math.sin(cam.el), cam.target[2] + cam.r * ce * Math.cos(cam.az)];
    view = lookAt(eyeP, cam.target, [0, 1, 0]);
    PV = mmul(persp(cam.fov, cssW / cssH, 0.1, 400), view.m);
  }
  function orbit(dx, dy) { cam.az -= dx * 0.0085; cam.el = Math.max(-0.3, Math.min(1.5, cam.el + dy * 0.0085)); }
  function pan(dx, dy) {
    var k = 2 * cam.r * Math.tan(cam.fov / 2) / cssH;
    for (var i = 0; i < 3; i++) cam.target[i] += (-dx * view.x[i] + dy * view.y[i]) * k;
  }
  function zoom(f) { cam.r = Math.max(2, Math.min(150, cam.r * f)); }
  function resize() {
    var r = host.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (!r.width || !r.height) return;
    cssW = r.width; cssH = r.height;
    canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
    var first = !measured; measured = true;
    fitHome();
    if (first || !touched) resetView();
    request();
  }
  if (window.ResizeObserver) new ResizeObserver(resize).observe(host); else window.addEventListener('resize', resize);

  /* ---------- input ---------- */
  var ptrs = new Map(), pinch = null, moved = 0, hoverPick = null;
  function pinchInfo() {
    var a = Array.from(ptrs.values());
    return { d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1, cx: (a[0].x + a[1].x) / 2, cy: (a[0].y + a[1].y) / 2 };
  }
  canvas.addEventListener('pointerdown', function (e) {
    canvas.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, btn: e.button, mod: e.shiftKey || e.ctrlKey || e.metaKey });
    moved = 0; if (ptrs.size === 2) pinch = pinchInfo();
    canvas.classList.add('dragging');
    if (api.onUse) api.onUse();
  });
  canvas.addEventListener('pointermove', function (e) {
    var p = ptrs.get(e.pointerId);
    if (!p) { if (e.pointerType === 'mouse') hover(e); return; }
    var dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY; moved += Math.abs(dx) + Math.abs(dy);
    if (ptrs.size === 1) { if (p.btn === 1 || p.btn === 2 || p.mod) pan(dx, dy); else orbit(dx, dy); }
    else if (ptrs.size === 2) { var q = pinchInfo(); if (pinch) { zoom(pinch.d / q.d); pan(q.cx - pinch.cx, q.cy - pinch.cy); } pinch = q; }
    if (moved > 3) { setTip(null); touched = true; follow = null; }
    request();
  });
  function up(e) {
    if (ptrs.has(e.pointerId) && moved < 6 && e.pointerType !== 'mouse') hover(e);
    ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null;
    if (!ptrs.size) canvas.classList.remove('dragging');
  }
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse' && !ptrs.size) setTip(null); });
  canvas.addEventListener('wheel', function (e) {
    e.preventDefault(); zoom(Math.exp(e.deltaY * (e.deltaMode ? 0.05 : 0.0012))); touched = true; setTip(null); request();
    if (api.onUse) api.onUse();
  }, { passive: false });
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  canvas.addEventListener('dblclick', resetView);

  function rayBox(o, d, b) {
    var t0 = -Infinity, t1 = Infinity;
    for (var i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-12) { if (o[i] < b[i] || o[i] > b[i + 3]) return null; continue; }
      var a = (b[i] - o[i]) / d[i], c = (b[i + 3] - o[i]) / d[i];
      if (a > c) { var s = a; a = c; c = s; }
      t0 = Math.max(t0, a); t1 = Math.min(t1, c);
    }
    return t1 >= Math.max(t0, 0) ? Math.max(t0, 0) : null;
  }
  function pickBox(p) { return p.cart ? (p.cart.visible ? p.cart.aabb : null) : p.aabb; }
  function hover(e) {
    if (!tip || !view) return;
    var r = canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    var nx = mx / r.width * 2 - 1, ny = 1 - my / r.height * 2, th = Math.tan(cam.fov / 2), asp = r.width / r.height;
    var dir = vnorm([-view.z[0] + view.x[0] * nx * th * asp + view.y[0] * ny * th,
                     -view.z[1] + view.x[1] * nx * th * asp + view.y[1] * ny * th,
                     -view.z[2] + view.x[2] * nx * th * asp + view.y[2] * ny * th]);
    var best = null, bt = Infinity;
    picks.forEach(function (p) { var b = pickBox(p), t = b && rayBox(eyeP, dir, b); if (t !== null && t !== undefined && b && t < bt) { bt = t; best = p; } });
    if (!best) { setTip(null); return; }
    if (best !== hoverPick || !tip.classList.contains('on')) { hoverPick = best; tip.innerHTML = best.info(); }
    var tw = tip.offsetWidth, thh = tip.offsetHeight, x = mx + 14, y = my + 14;
    if (x + tw > r.width - 6) x = mx - tw - 12;
    if (y + thh > r.height - 6) y = my - thh - 12;
    tip.style.transform = 'translate(' + Math.max(6, x) + 'px,' + Math.max(6, y) + 'px)';
    tip.classList.add('on');
    request();
  }
  function setTip(v) {
    if (v || !tip) return;
    tip.classList.remove('on');
    if (hoverPick) { hoverPick = null; request(); }
  }

  /* ---------- drawing ---------- */
  var raf = 0, dirty = true, follow = null, lastT = 0;
  function request() { dirty = true; if (!raf) raf = requestAnimationFrame(loop); }
  function loop(now) {
    raf = 0;
    var dt = Math.min(0.1, lastT ? (now - lastT) / 1000 : 0.016); lastT = now;
    var moving = false;
    if (follow) {                                          // ease the camera after the followed point
      var k = Math.min(1, dt * 5);
      for (var i = 0; i < 3; i++) {
        var d = follow[i] - cam.target[i];
        if (Math.abs(d) > 1e-4) { cam.target[i] += d * k; moving = true; }
      }
    }
    if (parts.length) { stepParticles(dt); moving = true; }
    if (rising && stepRise(now)) moving = true;
    if (dirty || moving) { draw(); dirty = false; }
    if (moving) raf = requestAnimationFrame(loop); else lastT = 0;
  }
  function useMesh() {
    gl.useProgram(PM);
    gl.bindBuffer(gl.ARRAY_BUFFER, cubeVB);
    gl.enableVertexAttribArray(AM.aPos); gl.vertexAttribPointer(AM.aPos, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(AM.aNrm); gl.vertexAttribPointer(AM.aNrm, 3, gl.FLOAT, false, 24, 12);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, cubeIB);
    gl.uniformMatrix4fv(AM.uPV, false, PV);
    gl.uniform3fv(AM.uFog, FOGV); gl.uniform3fv(AM.uFogC, TH.scene.slice(0, 3));
  }
  function mesh(o) {
    gl.uniformMatrix4fv(AM.uM, false, o.m); gl.uniformMatrix3fv(AM.uN, false, o.nm); gl.uniform4fv(AM.uColor, colOf(o));
    gl.drawElements(gl.TRIANGLES, 36, gl.UNSIGNED_SHORT, 0);
  }
  var curLB = null;
  function useLines() {
    gl.useProgram(PL); gl.disableVertexAttribArray(AM.aNrm); gl.uniformMatrix4fv(AL.uPV, false, PV); curLB = null;
    gl.uniform3fv(AL.uFog, FOGV); gl.uniform3fv(AL.uFogC, TH.scene.slice(0, 3));
  }
  // fog from a little past the target to well behind it, so far grid lines and blocks fade out
  var FOGV = new Float32Array([10, 40, 0]);
  function lines(L, m, col, mode) {
    if (curLB !== L.b) { gl.bindBuffer(gl.ARRAY_BUFFER, L.b); gl.enableVertexAttribArray(AL.aPos); gl.vertexAttribPointer(AL.aPos, 3, gl.FLOAT, false, 12, 0); curLB = L.b; }
    gl.uniformMatrix4fv(AL.uM, false, m); gl.uniform4fv(AL.uColor, col);
    gl.drawArrays(mode || gl.LINES, 0, L.n);
  }
  var ID = ident();
  function draw() {
    if (!measured) return;
    computeCam();
    FOGV[0] = cam.r * 0.95; FOGV[1] = cam.r * 2.1; FOGV[2] = 0.85;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(TH.scene[0], TH.scene[1], TH.scene[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
    gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    var opaque = [], trans = [];
    objs.forEach(function (o) {
      if (o.hidden || (o.tag === 'dot' && !show.dots)) return;
      (o.trans ? trans : opaque).push(o);
    });
    useMesh(); opaque.forEach(mesh);
    useLines();
    if (LINES.grid) lines(LINES.grid, ID, TH.grid);
    opaque.forEach(function (o) { var e = edgeOf(o); if (e) lines(LINES.edges, o.m, e); });
    var names = Object.keys(paths);
    if (show.paths) names.forEach(function (n) { var P = paths[n]; lines(P.buf, ID, withA(TH[P.key], P.a), gl.LINE_STRIP); });
    carts.forEach(function (c) { if (c.visible) lines(LINES.edges, c.hit, withA(TH[c.key], c.line)); });
    boxes.forEach(function (b) { lines(LINES.edges, b.m, withA(TH[b.key], b.a)); });
    // transparent meshes, back to front
    trans.forEach(function (o) {
      var c = [(o.aabb[0] + o.aabb[3]) / 2, (o.aabb[1] + o.aabb[4]) / 2, (o.aabb[2] + o.aabb[5]) / 2];
      o.dist = Math.hypot(c[0] - eyeP[0], c[1] - eyeP[1], c[2] - eyeP[2]) + o.bias;
    });
    trans.sort(function (a, b) { return b.dist - a.dist; });
    gl.depthMask(false);
    useMesh(); trans.forEach(mesh);
    useLines();
    trans.forEach(function (o) {
      var e = edgeOf(o);
      if (e) lines(LINES.edges, o.m, e);
      if (o.lines && e) lines(LINES[o.lines], o.m, e);
    });
    // x-ray: the paths and carts that ask for it show faintly through blocks
    gl.disable(gl.DEPTH_TEST);
    if (show.paths) names.forEach(function (n) { var P = paths[n]; if (P.xray) lines(P.buf, ID, withA(TH[P.key], 0.28), gl.LINE_STRIP); });
    carts.forEach(function (c) { if (c.visible && c.xray) lines(LINES.edges, c.hit, withA(TH[c.key], 0.4)); });
    boxes.forEach(function (b) { lines(LINES.edges, b.m, withA(TH[b.key], b.a * 0.45)); });
    if (hoverPick) {
      var b = pickBox(hoverPick), e = 0.012;
      if (b) lines(LINES.edges, boxM([b[0] - e, b[1] - e, b[2] - e], [b[3] - b[0] + 2 * e, b[4] - b[1] + 2 * e, b[5] - b[2] + 2 * e]), withA(TH.focus, 0.95));
    }
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
    placeLabels();
  }
  function placeLabels() {
    var taken = [];
    LABELS.forEach(function (L) {
      if (!show.labels) { L.el.classList.add('hidden'); return; }
      var p = L.p, m = PV;
      var cx = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], cy = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
          cw = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
      if (cw <= 0.1) { L.el.classList.add('hidden'); return; }
      var sx = (cx / cw + 1) / 2 * cssW, sy = (1 - cy / cw) / 2 * cssH;
      if (sx < -80 || sx > cssW + 80 || sy < -40 || sy > cssH + 60) { L.el.classList.add('hidden'); return; }
      L.el.classList.remove('hidden');
      if (!L.w) L.w = L.el.offsetWidth;
      if (L.cls !== 'compass' && L.w) sx = Math.max(L.w / 2 + 6, Math.min(cssW - L.w / 2 - 6, sx));
      if (!L.h) L.h = L.el.offsetHeight;
      if (L.cls !== 'compass') {                          // one that would cover an earlier label waits until there is room
        var top = /below/.test(L.cls) ? sy + 8 : sy - L.h, r = [sx - L.w / 2 - 3, top - 2, sx + L.w / 2 + 3, top + L.h + 2];
        if (taken.some(function (q) { return r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1]; })) { L.el.classList.add('hidden'); return; }
        taken.push(r);
      }
      L.el.style.transform = 'translate(' + sx.toFixed(1) + 'px,' + sy.toFixed(1) + 'px) translate(-50%,' +
        (L.cls === 'compass' ? '-50%' : /below/.test(L.cls) ? '8px' : '-100%') + ')';
    });
  }

  /* ---------- api ---------- */
  var api = {
    canvas: canvas,
    ok: true,
    onUse: null,
    // drop everything: blocks, entities, paths, labels
    clear: function () {
      objs.length = 0; picks.length = 0; fitPts.length = 0; carts.length = 0; boxes.length = 0; dots = []; shadows = [];
      byPos = {}; notes = {}; signs = {}; rails = {}; railRec = {}; hoverPick = null; setTip(null); parts = []; rising = null;
      Object.keys(paths).forEach(function (n) { setPath(n, null); });
      setLabels([]);
      if (LINES.grid) { gl.deleteBuffer(LINES.grid.b); LINES.grid = null; }
      request();
    },
    // o.offset is subtracted from every coordinate (world positions lose precision in 32-bit floats)
    blocks: function (list, o) {
      o = o || {};
      notes = o.notes || {}; signs = o.signs || {};
      var off = o.offset || [0, 0, 0];
      list.forEach(function (b) { addBlock(b, off); });
      request();
    },
    // a grid on the floor: the bounds given, or the blocks' own with a margin; fit: frame it too
    grid: function (bd, margin, fit) {
      if (!bd) {
        bd = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9];
        fitPts.forEach(function (p) { for (var q = 0; q < 3; q++) { bd[q] = Math.min(bd[q], p[q]); bd[q + 3] = Math.max(bd[q + 3], p[q]); } });
      }
      var m = margin == null ? 2 : margin, x0 = Math.floor(bd[0]) - m, x1 = Math.ceil(bd[3]) + m, z0 = Math.floor(bd[2]) - m, z1 = Math.ceil(bd[5]) + m, gy = bd[1], a = [];
      for (var gx = x0; gx <= x1; gx++) a.push(gx, gy, z0, gx, gy, z1);
      for (var gz = z0; gz <= z1; gz++) a.push(x0, gy, gz, x1, gy, gz);
      if (LINES.grid) gl.deleteBuffer(LINES.grid.b);
      LINES.grid = lineBuf(a);
      // a soft shadow on the floor under every block column: a dark square and a fainter, wider one
      shadows.forEach(function (o) { var i = objs.indexOf(o); if (i >= 0) objs.splice(i, 1); });
      shadows = [];
      var cols = {};
      Object.keys(byPos).forEach(function (k) { var r = byPos[k]; if (/rail$|lever/.test(r.name)) return; cols[r.pos[0] + ',' + r.pos[2]] = r.pos; });
      Object.keys(cols).forEach(function (k) {
        var q = cols[k];
        shadows.push(add(boxM([q[0] - 0.12, gy + 0.001, q[2] - 0.12], [1.24, 0.001, 1.24]), 'shade', { a: 0.05, edge: null, tag: 'shadow' }));
        shadows.push(add(boxM([q[0] + 0.04, gy + 0.002, q[2] + 0.04], [0.92, 0.001, 0.92]), 'shade', { a: 0.1, edge: null, tag: 'shadow' }));
      });
      if (fit) fitPts.push([x0, gy, z0], [x1, gy, z1]);
      return [x0, gy, z0, x1, gy, z1];
    },
    cart: makeCart,
    stand: addStand,
    boat: addBoat,
    // an outline only: where something will be (the cart after its rail is broken)
    outline: function (mn, sz, key, a) { boxes.push({ m: boxM(mn, sz), key: key, a: a == null ? 0.7 : a }); fitPts.push(mn, [mn[0] + sz[0], mn[1] + sz[1], mn[2] + sz[2]]); request(); },
    path: setPath,
    dots: setDots,
    labels: setLabels,
    fitPoint: function (p) { fitPts.push(p); },
    // a powered rail or lever at "x,y,z" switched on or off
    power: function (key, on) {
      var rec = byPos[key];
      if (!rec) return;
      rec.live = on;
      if (rec.rails) rec.rails.forEach(function (o) { o.col = hex(on ? C.gold : C.goldOff); });
      if (rec.strip) rec.strip.col = hex(on ? C.lit : C.unlit);
      if (rec.handle) setM(rec.handle, leverM(rec.pos[0], rec.pos[1], rec.pos[2], rec.pr.facing, on));
      if (hoverPick && hoverPick.rec === rec && tip) tip.innerHTML = blockInfo(rec);
      request();
    },
    show: function (o) { Object.keys(o).forEach(function (k) { show[k] = !!o[k]; }); request(); },
    // frame the scene again (after new content); keeps the user's view if they moved it, unless forced
    frame: function (force) { if (!measured) return; fitHome(); if (force || !touched) resetView(); },
    reset: resetView,
    // turn the camera around its target by an angle (radians), for a view that spins by itself
    turn: function (a) { cam.az += a; request(); },
    // effects: particles at p (see burst), and the blocks dropping into place (done: when they have)
    burst: burst,
    rise: rise,
    // the camera now ({target, r, el, az}), or set any of those; and the framing that fits the
    // scene, without moving to it (for a page that glides there itself)
    camera: function (o) {
      if (o) {
        if (o.target) cam.target = o.target.slice();
        if (o.r != null) cam.r = o.r;
        if (o.el != null) cam.el = o.el;
        if (o.az != null) cam.az = o.az;
        request();
      }
      return { target: cam.target.slice(), r: cam.r, el: cam.el, az: cam.az };
    },
    fitted: function () { if (!measured) return null; fitHome(); return HOME && { target: HOME.target.slice(), r: HOME.r, el: HOME.el }; },
    follow: function (p) { follow = p ? p.slice() : null; if (p) touched = true; request(); },
    request: request,
    resize: resize,
    // the current picture as a PNG data URL (needs opt.keep)
    snapshot: function () { if (!measured) return null; draw(); dirty = false; try { return canvas.toDataURL('image/png'); } catch (e) { return null; } },
    debug: function () { return { cssW: cssW, cssH: cssH, pts: fitPts.length, home: HOME && { r: HOME.r, target: HOME.target }, cam: { r: cam.r, target: cam.target } }; }
  };
  readTheme();
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', readTheme); else if (mq.addListener) mq.addListener(readTheme);
  }
  new MutationObserver(readTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  resize();
  return api;
}
