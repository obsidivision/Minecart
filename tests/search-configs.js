// The searches the engine test runs: every start, y / x / z targets, both sorts, boat carts
module.exports = function configs(E) {
  const origins = [[0, 64, 0], [123456, 70, -654321], [-29999000, 64, 29999000], [2, 1, 9]];
  const facings = ['south', 'north', 'east', 'west'], out = [];
  for (const o of origins) for (const fc of facings)
    out.push({ alphabet: 'dry', starts: ['S', 'Dr', 'Dp'], depth: 4, split: 2, origin: o, facing: fc, axis: 'y', lo: E.WIN_LO, hi: E.WIN_HI, target: 0.3000050119, sort: 'close', keep: 20 });
  for (const o of origins.slice(0, 2)) for (const fc of facings) {
    out.push({ alphabet: 'plain', starts: ['Dr'], depth: 8, split: 3, origin: o, facing: fc, axis: 'y', target: 0.3, tol: 0.001, sort: 'short', keep: 50, minMid: 3 });
    const ax = fc === 'east' || fc === 'west' ? 'x' : 'z';
    out.push({ alphabet: 'dry', starts: ['S', 'Dr', 'Dp'], depth: 4, split: 2, origin: o, facing: fc, axis: ax, lo: 0.9, hi: 0.1, target: 0.0, sort: 'close', keep: 20 });
  }
  for (const [stopper, approach] of [['block', 'behind'], ['honey', 'front'], ['bud_side', 'behind'], ['small_side', 'front'], ['small_tip', 'behind'], ['cluster_tip', 'front']])
    for (const fc of ['south', 'west'])
      out.push({ alphabet: 'dry', starts: ['S', 'Dr', 'Dp'], depth: 4, split: 2, origin: [0, 64, 0], facing: fc, axis: 'y', lo: E.WIN_LO, hi: E.WIN_HI, target: 0.3000050119, sort: 'close', keep: 20, boat: true, stopper, approach });
  return out;
};
// every task of a config, with the origin the page gives it
module.exports.tasks = function (E, cf) {
  return E.makeTasks(cf.alphabet, cf.starts, cf.depth, cf.split).map(t =>
    Object.assign({}, cf, { depth: t.depth, start: t.start, first: t.first, origin: t.start === 'S' ? cf.origin : [cf.origin[0], cf.origin[1] + 1, cf.origin[2]] }));
};
