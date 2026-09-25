// Runs the tests: node tests/run.js           the engine, launcher, flight and tester tests
//                 node tests/run.js --browser  those, plus the pages in a real browser (Playwright)
const { spawnSync } = require('child_process'), http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
let failed = 0;
function run(file, args) {
  console.log('\n== ' + path.relative(ROOT, file) + (args ? ' ' + args.join(' ') : ''));
  const r = spawnSync(process.execPath, [file].concat(args || []), { stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0) failed++;
}
['engine', 'launch', 'flight', 'tester', 'contrast'].forEach(n => run(path.join(__dirname, n + '.test.js')));
if (process.argv.includes('--browser')) {
  // the site as a plain static server, like any web host
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
  const server = http.createServer((req, res) => {
    const f = path.join(ROOT, decodeURIComponent(req.url.split(/[?#]/)[0]).replace(/^\/+/, '') || 'index.html');
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  server.listen(0, '127.0.0.1', () => {
    const base = 'http://127.0.0.1:' + server.address().port + '/';
    // the browser tests run as their own processes, so the server has to answer while they run
    const { spawn } = require('child_process');
    const files = ['finder-starts', 'finder-links', 'viewers', 'home'].map(n => path.join(__dirname, 'browser', n + '.js'));
    (function next(i) {
      if (i >= files.length) { server.close(); finish(); return; }
      console.log('\n== ' + path.relative(ROOT, files[i]));
      spawn(process.execPath, [files[i], base], { stdio: 'inherit', cwd: ROOT }).on('exit', code => { if (code !== 0) failed++; next(i + 1); });
    })(0);
  });
} else finish();
function finish() {
  console.log('\n' + (failed ? failed + ' test file(s) failed' : 'all tests passed'));
  process.exit(failed ? 1 : 0);
}
