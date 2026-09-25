// Loads the site's scripts into Node the way the pages load them: plain files that define globals.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
function src(file) { return fs.readFileSync(path.join(ROOT, file), 'utf8'); }
function engine(file) { return new Function(src(file || 'engine.js') + '\nreturn makeEngine;')()(); }
function all() {
  const M = new Function(src('engine.js') + src('litematic.js') + src('tester.js') + '\nreturn { makeEngine, makeLitematicWriter, makeTester };')();
  const E = M.makeEngine(), LW = M.makeLitematicWriter();
  return { E, LW, TS: M.makeTester(E, LW) };
}
function sha(s) { return require('crypto').createHash('sha1').update(s).digest('hex'); }
let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}
function done() { if (failed) { console.log(failed + ' failed'); process.exit(1); } }
module.exports = { ROOT, src, engine, all, sha, check, done };
