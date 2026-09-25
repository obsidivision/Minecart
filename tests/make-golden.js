// Records the search digests for engine.test.js from an engine file: node tests/make-golden.js [engine file]
// Run it only on an engine whose results are known right (the originals came from the engine the
// in-game checks were made with).
const fs = require('fs'), path = require('path');
const { engine, sha } = require('./load');
const configs = require('./search-configs');
const E = engine(process.argv[2]);
const out = configs(E).map(cf => sha(configs.tasks(E, cf).map(o => JSON.stringify(E.searchTask(o))).join('\n')));
fs.writeFileSync(path.join(__dirname, 'golden', 'search.json'), JSON.stringify(out, null, 1) + '\n');
console.log(out.length + ' configs recorded');
