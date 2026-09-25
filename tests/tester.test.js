// The "Download with tester" builds: no block placed over another, the cart (and boat) summoned
// exactly where the simulation starts them, and hand-placed testers byte for byte as recorded.
const { all, sha, check, done } = require('./load');
const { E, TS } = all();
const layouts = ['Dr Dr Fr Fr Fp Up Fr Fr Ur E', 'S Fr Ur E', 'Dp Dr Ur Fr E', 'Dr E', 'S Up Up Fr Dr Dr E'];
const starts = [null];
for (const how of ['fly', 'loader']) for (const boat of how === 'loader' ? [true] : [false, true])
  for (const sp of Object.keys(E.STOPPERS)) for (const ap of E.APPROACHES) starts.push({ how, boat, stopper: sp, approach: ap });
let n = 0, errs = [];
for (const code of layouts) for (const facing of ['south', 'north', 'east', 'west']) for (const axis of ['y', 'x', 'z']) for (const o of starts) {
  if (axis !== 'y' && (axis === 'x') !== (facing === 'east' || facing === 'west')) continue;
  n++;
  try {
    const f = TS.file(code, [5, 64, -3], facing, axis, 0.2, 0.4, 'abc123', 0, o), i = f.info;
    if (o) {
      const b = E.build(code, code[0] === 'S' ? [5, 64, -3] : [5, 65, -3], facing, o), P = (b.launcher || b.loader).place;
      if (i.dy + i.summon[1] + 0.5 !== P[1] || i.summon[0] + 0.5 !== P[0] || i.summon[2] + 0.5 !== P[2]) throw new Error('cart summoned off its spot');
      if (o.boat && !i.boatSummon) throw new Error('no boat summon');
    }
  } catch (e) { errs.push(code + ' ' + facing + ' ' + axis + ' ' + JSON.stringify(o) + ': ' + e.message); }
}
check('every tester builds cleanly', errs.length === 0, n + ' testers' + (errs.length ? '; ' + errs.slice(0, 3).join(' | ') : ''));
const golden = require('./golden/tester.json'), got = {};
for (const code of layouts) for (const facing of ['south', 'east']) got[code + '|' + facing] = sha(Buffer.from(TS.file(code, [7, 70, -9], facing, 'y', 0.3, 0.31, 'aaaaaa', 1e12).bytes).toString('hex'));
const diff = Object.keys(golden).filter(k => golden[k] !== got[k]);
check('hand-placed testers byte for byte as recorded', diff.length === 0 && Object.keys(golden).length === Object.keys(got).length, diff.join(', '));
if (process.argv[2] === '--record') require('fs').writeFileSync(__dirname + '/golden/tester.json', JSON.stringify(got, null, 1) + '\n');
done();
