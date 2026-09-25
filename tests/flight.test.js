// The flight rules against the game: FarCoolHat's launch off the top rail, the flight, the stop
// against the medium bud and the fall onto the honey, ticks 1 to 18 of the challenge's own run
// (the data in floatcart-3d.html). Built 128 blocks south, where the recorded numbers were taken
// (the last digits depend on where in the world a cart is).
const { engine, src, check, done } = require('./load');
const E = engine();
const page = src('floatcart-3d.html'), at = page.indexOf('var D = ');
const D = JSON.parse(page.slice(at + 8, page.indexOf('\n', at)).replace(/;\s*$/, '')), run = D.runs.built;
function track(origin, facing, s, k) { const T = E.newTrack(origin, facing, 1); T.shape[0] = E.shapeOf(E.FACINGS[facing], s); T.kind[0] = k; T.level[0] = s === 'D' ? -1 : 0; T.n = 1; return T; }
const Z0 = 128, launch = track([2, 7, 8 + Z0], 'north', 'D', 1), underHoney = track([2, 3, 6 + Z0], 'south', 'D', 1);
const full = [[1,0,2],[2,0,2],[2,0,7],[2,0,8],[2,0,9],[3,1,2],[2,1,3],[2,1,6],[1,1,8],[3,1,8],[0,2,2],[3,2,7],[2,5,5],[2,5,8],[2,1,10],[2,2,5],[2,6,9],[2,2,0],[2,2,1],[2,2,2],[2,2,7]];
const boxes = full.map(b => [b[0], b[1], b[2] + Z0, b[0] + 1, b[1] + 1, b[2] + 1 + Z0]);
boxes.push([2.0625, 3, 6.0625 + Z0, 2.9375, 3.9375, 6.9375 + Z0]);     // honey (2,3,6)
boxes.push([2.1875, 5.1875, 6.0 + Z0, 2.8125, 5.8125, 6.25 + Z0]);     // medium bud (2,5,6), facing south
const W = { tracks: [launch, underHoney], boxes, honey: [[2, 3, 6 + Z0]] };
const c = { x: 2.5, y: 6.5625, z: 8.5 + Z0, vx: 0, vy: 0, vz: 0, ground: false };
let bad = [];
for (let t = 1; t <= 18; t++) { E.worldTick(W, c); if (c.y !== run.y[t] || c.z - Z0 !== run.z[t]) bad.push(t); }
check('ticks 1-18 match the challenge run to the last digit', bad.length === 0, bad.length ? 'ticks ' + bad.join(',') : '');
done();
