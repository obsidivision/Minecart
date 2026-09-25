// A small stand-in for a Minecraft jar, for the texture tests: made-up 16 x 16 textures (plain
// colours, checkers and a cut-out rail) at the paths the game uses. Not Mojang's art.
// node tests/fixtures/make-fake-jar.js <out.zip>
const zlib = require('zlib'), fs = require('fs');
function png(w, h, px) {                       // px(x, y) -> [r, g, b, a]
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; for (let x = 0; x < w; x++) px(x, y).forEach((v, i) => { raw[y * (w * 4 + 1) + 1 + x * 4 + i] = v; }); }
  function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td)); return Buffer.concat([len, td, crc]); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const check = (a, b) => (x, y) => ((x >> 2) + (y >> 2)) % 2 ? a : b;
const T = {
  white_concrete: check([230, 230, 230, 255], [200, 200, 200, 255]),
  white_stained_glass: (x, y) => x === 0 || y === 0 || x === 15 || y === 15 ? [255, 255, 255, 220] : [255, 255, 255, 50],
  honey_block_side: check([250, 170, 40, 200], [220, 140, 20, 200]),
  rail: (x, y) => (x === 3 || x === 12) ? [160, 160, 170, 255] : y % 4 === 1 ? [120, 80, 40, 255] : [0, 0, 0, 0],
  powered_rail: (x, y) => (x === 3 || x === 12) ? [200, 160, 40, 255] : y % 4 === 1 ? [120, 80, 40, 255] : [0, 0, 0, 0],
  powered_rail_on: (x, y) => (x === 3 || x === 12) ? [240, 200, 60, 255] : (x > 6 && x < 9) ? [230, 40, 30, 255] : y % 4 === 1 ? [120, 80, 40, 255] : [0, 0, 0, 0],
  cobblestone: check([130, 130, 130, 255], [100, 100, 100, 255]),
  amethyst_block: check([150, 90, 210, 255], [120, 70, 180, 255])
};
// a stored (uncompressed) zip, and one entry deflated, as jars mix both
const files = Object.keys(T).map((n, i) => ({ name: 'assets/minecraft/textures/block/' + n + '.png', data: png(16, 16, T[n]), deflate: i % 2 === 0 }));
files.push({ name: 'net/minecraft/client/Main.class', data: Buffer.from('not a texture'), deflate: false });
const parts = [], cd = []; let off = 0;
for (const f of files) {
  const body = f.deflate ? zlib.deflateRawSync(f.data) : f.data, name = Buffer.from(f.name), crc = zlib.crc32(f.data);
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(f.deflate ? 8 : 0, 8);
  lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26);
  parts.push(lh, name, body);
  const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(f.deflate ? 8 : 0, 10);
  ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(f.data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
  cd.push(ch, name);
  off += 30 + name.length + body.length;
}
const cdBuf = Buffer.concat(cd), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(off, 16);
fs.writeFileSync(process.argv[2], Buffer.concat(parts.concat([cdBuf, end])));
