// The search gives exactly the results it always has: every task's result, bit for bit, against
// digests recorded from the original engine (tests/golden/search.json, made by make-golden.js).
const { engine, sha, check, done } = require('./load');
const configs = require('./search-configs');
const E = engine(), golden = require('./golden/search.json');
const got = configs(E).map(cf => sha(configs.tasks(E, cf).map(o => JSON.stringify(E.searchTask(o))).join('\n')));
check('search configs recorded', got.length === golden.length, got.length + ' vs ' + golden.length);
const bad = got.filter((d, i) => d !== golden[i]).length;
check('every search result bit for bit as recorded', bad === 0, bad + ' of ' + got.length + ' configs differ');
done();
