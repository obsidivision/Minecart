/* litematic.js — writes .litematic schematics (makeLitematicWriter), for the finder's downloads. */

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
