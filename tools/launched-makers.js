// Adds the launched floatcart makers to floatcart-makers-3d.html: tracks started by the launcher
// (FarCoolHat's stopper), nothing placed on the track itself. Each one is built, run in full
// (launch, flight, stop, landing, track) and checked at the 60 positions, in the page's own data
// format. Run from the repository: node tools/launched-makers.js  (it replaces earlier launched makers).
const fs = require('fs'), path = require('path');
const E = new Function(fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8') + '\nreturn makeEngine;')()();
const PAGE = path.join(__dirname, '..', 'floatcart-makers-3d.html');
const PICKS = [
  { code: 'Dp Up Up Ur Ur E', stopper: 'cluster_tip', approach: 'behind' },
  { code: 'Dr Dr Dr Dr Fr Dr Dr Fr Dr Ur Fr E', stopper: 'medium_tip', approach: 'behind' },
  { code: 'Dr Dr Dr Dr Fr Dr Dr Dr Dr Fr Fr Fr E', stopper: 'block', approach: 'behind' },
  { code: 'Dr Fr Dr Fr Dr Dr Dr Dr Fr Dr Dr Dr Ur E', stopper: 'small_side', approach: 'front' }
];
const GROUP = 'Launched, nothing placed on the track';
const STOP_NAME = { block: 'plain block', honey: 'honey block', bud_side: 'medium bud (side)', small_side: 'small bud (side)', small_tip: 'small bud (tip)',
  medium_tip: 'medium bud (tip)', large_tip: 'large bud (tip)', cluster_tip: 'amethyst cluster (tip)' };

const src = fs.readFileSync(PAGE, 'utf8'), at = src.indexOf('var D = '), end = src.indexOf('\n', at);
const D = JSON.parse(src.slice(at + 8, end).replace(/;\s*$/, ''));
D.makers = D.makers.filter(m => !m.start);                     // earlier launched makers are replaced
function idx(list, item) { const k = JSON.stringify(item); let i = list.findIndex(x => JSON.stringify(x) === k); if (i < 0) { list.push(item); i = list.length - 1; } return i; }
const NOTE = {
  launch: idx(D.noteText, 'Launch slope: powered, it throws the cart off its foot toward the stopper. Place the minecart here.'),
  stopper: idx(D.noteText, 'Stopper: the flying cart stops dead against it and drops straight onto the start rail.'),
  support: idx(D.noteText, 'Holds the bud.'),
  landing: idx(D.noteText, 'Start rail: the launched cart lands here, at rest.'),
  launcherGlass: -1
};
const PH = {
  placed: idx(D.phases, 'Minecart placed on the launch slope'),
  flying: idx(D.phases, 'Launched: off the slope and flying at the stopper'),
  falling: idx(D.phases, 'Stopped dead by the stopper, falling onto the start rail'),
  caught: idx(D.phases, 'Caught by the start rail')
};
D.phaseRules[PH.placed] = ['M3', 'R2']; D.phaseRules[PH.flying] = ['P1', 'F1', 'F3', 'M5']; D.phaseRules[PH.falling] = ['F4', 'C5', 'M5']; D.phaseRules[PH.caught] = ['F5', 'M6', 'R10'];
Object.assign(D.ruleNames, { M3: 'Placing', M5: 'Gravity', M6: 'Rail lookup', F1: 'Speed cap', F3: 'Air drag', F4: 'Stopping in mid-air', F5: 'Landing on a rail', C5: 'No bounce', R10: 'Height and speed' });
const TRACK_PH = { Dr: 1, Dp: 8, Fr: 2, Fp: 6, Ur: 3, Up: 7 };
const TRACK_NOTE = { Dr: 0, Ur: 1, Fr: 2, Fp: 9, Up: 10, Dp: 11 };

let n = D.makers.length;
for (const pk of PICKS) {
  const o = { how: 'fly', boat: false, stopper: pk.stopper, approach: pk.approach }, L = E.parse(pk.code);
  const origin = [2, 100, 1], b = E.build(pk.code, [origin[0], origin[1] + 1, origin[2]], 'south', o);
  const r = E.run(pk.code, [origin[0], origin[1] + 1, origin[2]], 'south', true, 20000, o);
  if (!r.ok) throw new Error(pk.code + ': ' + r.why);
  const La = b.launcher, tokens = pk.code.split(' ');
  let minY = Infinity, minZ = Infinity;
  b.blocks.forEach(q => { minY = Math.min(minY, q.y); minZ = Math.min(minZ, q.z); });
  const dy = -minY, dz = -minZ;
  const railAt = {}; b.rails.forEach(rl => { railAt[rl.pos.join(',')] = rl.k; });
  const capAt = {}; b.caps.forEach(c => { capAt[c.rail.join(',')] = 'cap'; capAt[c.glass.join(',')] = 'capGlass'; });
  const key = p => p.join(',');
  const blocks = b.blocks.map(q => {
    const p = [q.x, q.y, q.z], name = q.name.replace('minecraft:', ''), kind = idx(D.kinds, [name, q.props]);
    let note = -1, rail = -1;
    if (key(p) in railAt) {
      rail = railAt[key(p)];
      note = rail === 0 ? NOTE.landing : rail === tokens.length - 1 ? 3 : TRACK_NOTE[tokens[rail]];
    } else if (capAt[key(p)] === 'cap') note = 5;
    else if (capAt[key(p)] === 'capGlass' && p[2] > b.rails[b.rails.length - 1].pos[2]) note = 4;
    else if (La.stop && key(p) === key(La.stop)) note = NOTE.stopper;
    else if (La.support && key(p) === key(La.support)) note = NOTE.support;
    else if (key(p) === key(La.launchRail)) note = NOTE.launch;
    else if (key(p) === key(La.power)) note = 8;
    else if (key(p) === key(La.lever)) note = 7;
    return [p[0], p[1] + dy, p[2] + dz, kind, note, rail];
  });
  const run = { y: [], z: [], vz: [], ph: [], rail: [] };
  r.path.forEach((q, t) => {
    const k = q[3];
    run.y.push(q[1] + dy); run.z.push(q[2] + dz);
    run.vz.push(t ? +(q[2] - r.path[t - 1][2]).toFixed(7) : 0);
    run.rail.push(k);
    run.ph.push(t === 0 ? PH.placed : k < 0 ? (t < r.stopTick ? PH.flying : PH.falling) : t === r.landTick ? PH.caught
      : k === tokens.length - 1 ? (t === r.path.length - 1 ? 5 : 4) : TRACK_PH[tokens[k]]);
  });
  const last = r.path.length - 1, fy = run.y[last], yfrac = fy - Math.floor(fy);
  Object.assign(run, { final_y: fy, yfrac, inside: yfrac > D.window[0] && yfrac < D.window[1], margin: Math.min(yfrac - D.window[0], D.window[1] - yfrac) });
  if (!run.inside) throw new Error(pk.code + ' is not a floatcart here');
  const v = E.verify(pk.code, Object.assign({ axis: 'y', target: 0.3000050119, lo: E.WIN_LO, hi: E.WIN_HI, facing: 'south' }, o));
  const xs = blocks.map(q => q[0]), ys = blocks.map(q => q[1]), zs = blocks.map(q => q[2]);
  const park = b.rails[b.rails.length - 1].pos, stopAt = La.stopAt;
  const labels = [
    { p: [2.5, La.start[1] + dy + 1.35, La.start[2] + dz + 0.5], t: 'Place the cart here' },
    { p: [2.5, stopAt[1] + dy - 0.05, stopAt[2] + dz], t: 'Stops here', cls: 'below' },
    { p: [2.5, park[1] + dy + 2.0, park[2] + dz + 0.5], t: 'Parking slope' },
    { p: [La.lever[0] + 0.5, La.lever[1] + dy - 0.05, La.lever[2] + dz + 0.5], t: 'Lever', cls: 'below' },
    { p: [2.5, 0, Math.min(...zs) - 1.25], t: 'N', cls: 'compass' }, { p: [2.5, 0, Math.max(...zs) + 1.25], t: 'S', cls: 'compass' }
  ];
  n++;
  D.makers.push({ id: 'm' + n, group: GROUP, code: pk.code, tokens, schematic: null, rails: tokens.length, levers: b.levers, blocksTotal: blocks.length,
    run, verified: { runs: v.runs, floatcarts: v.floatcarts, spread: v.max - v.min }, blocks, labels,
    bounds: [Math.min(...xs), Math.min(...ys), Math.min(...zs), Math.max(...xs), Math.max(...ys), Math.max(...zs)],
    start: { how: 'fly', stopper: pk.stopper, stopperName: STOP_NAME[pk.stopper], approach: pk.approach } });
  console.log('m' + n, pk.code, pk.stopper, pk.approach, 'y', yfrac.toFixed(10), 'checks', v.floatcarts + '/' + v.runs, run.y.length + ' ticks');
}
fs.writeFileSync(PAGE, src.slice(0, at + 8) + JSON.stringify(D) + ';' + src.slice(end));
