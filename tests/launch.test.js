// The launcher run in full (flight, collisions, boat pickup) lands the cart where the search
// assumes: at rest on the start rail at the stopper's fraction. Every stopper, side, cart,
// direction and world position; the full flight may differ only in the last digits.
const { engine, check, done } = require('./load');
const E = engine();
const codes = ['Dr Dr Fr Fr Fp Up Fr Fr Ur E', 'S Dp Fr Fr Up Ur Up Fr Ur E', 'Dp Fr Ur Fr Dr Up Ur E', 'S Fr Ur Fp Dr Up Fr Ur Fr E', 'Dr Up Fr Dp Fr Up Fr Ur Ur E'];
let n = 0, exact = 0, near = 0, fails = [], worst = 0;
for (const boat of [false, true]) for (const stopper of Object.keys(E.STOPPERS)) for (const approach of E.APPROACHES)
  for (const code of codes) for (const facing of ['south', 'north', 'east', 'west']) for (const p of E.PLACEMENTS.slice(0, 8)) {
    const origin = code[0] === 'S' ? p : [p[0], p[1] + 1, p[2]];
    const model = E.run(code, origin, facing, false, 20000, { boat, how: 'loader', stopper, approach });
    const got = E.run(code, origin, facing, false, 20000, { boat, how: 'fly', stopper, approach });
    n++;
    if (!got.ok || !model.ok) { if (got.ok !== model.ok) fails.push(code + ' ' + facing + ' ' + stopper + ' ' + approach + (boat ? ' boat' : '') + ': ' + (got.why || model.why)); else exact++; continue; }
    const d = Math.max(Math.abs(got.x - model.x), Math.abs(got.y - model.y), Math.abs(got.z - model.z));
    if (d === 0) exact++; else if (d < 1e-10) { near++; worst = Math.max(worst, d); } else fails.push(code + ' ' + facing + ' ' + stopper + ': off by ' + d);
  }
check('every launched run parks where the search says', fails.length === 0, n + ' runs, ' + exact + ' exact, ' + near + ' within ' + worst.toExponential(1) + (fails.length ? '; ' + fails.slice(0, 3).join(' | ') : ''));
// the boat is taken aboard wherever it sits on its rail
let boatFails = 0;
for (const sp of Object.keys(E.STOPPERS)) for (const ap of E.APPROACHES) for (const fc of ['south', 'east']) {
  const r = E.run('Dr Dr Fr Fr Fp Up Fr Fr Ur E', [5, 65, -3], fc, false, 20000, { how: 'fly', boat: true, stopper: sp, approach: ap });
  if (!r.ok) boatFails++;
}
check('boat carts pick the boat up from every spot on its rail', boatFails === 0, boatFails + ' failures');
done();
