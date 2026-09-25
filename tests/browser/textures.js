// The game-texture loader: a stand-in jar (tests/fixtures/make-fake-jar.js, made-up textures) is read in
// the browser, the 3D views switch to it, it's remembered, and "Use the drawn ones" switches back.
// Usage: node textures.js <base-url>
const { chromium } = require('../playwright');
const path = require('path'), os = require('os'), fs = require('fs');
const base = process.argv[2];
const results = [];
function check(name, ok, detail) { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : '')); }
(async () => {
  const jar = path.join(os.tmpdir(), 'floatcart-fake-' + process.pid + '.jar');
  require('child_process').execFileSync(process.execPath, [path.join(__dirname, '..', 'fixtures', 'make-fake-jar.js'), jar]);
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 860 } });
  const errors = [];
  let p = await ctx.newPage(); p.on('pageerror', e => errors.push(e.message));
  await p.goto(base + 'floatcart-makers-3d.html#m2'); await p.waitForTimeout(1200);
  const before = (await p.locator('#stage').screenshot()).toString('base64');
  await p.click('.tex-btn');
  await p.setInputFiles('.tex-panel input[type=file]', jar);
  await p.waitForFunction(() => /In use: \d+ textures/.test(document.querySelector('.tex-status').textContent), null, { timeout: 15000 });
  const st = await p.evaluate(() => document.querySelector('.tex-status').textContent);
  check('the jar is read: only the block textures', /In use: 8 textures from floatcart-fake/.test(st), st);
  await p.click('body', { position: { x: 5, y: 300 } }); await p.waitForTimeout(800);
  const after = (await p.locator('#stage').screenshot()).toString('base64');
  check('the 3D view redraws with them', before !== after);
  const p2 = await ctx.newPage(); p2.on('pageerror', e => errors.push(e.message));
  await p2.goto(base + 'index.html'); await p2.waitForTimeout(600);
  check('remembered on other pages', await p2.evaluate(() => !!(window.__mcTextures && window.__mcTextures.tex.rail) && document.querySelector('.tex-btn').classList.contains('on')));
  await p2.close();
  await p.click('.tex-btn'); await p.click('.tex-off'); await p.waitForTimeout(800);
  check('back to the drawn textures', await p.evaluate(() => !window.__mcTextures && !localStorage.getItem('floatcart-mc-textures')));
  const bad = await p.evaluate(() => FC.loadMcFile(new File([new Uint8Array([1, 2, 3])], 'x.zip')).then(() => 'ok', e => e.message));
  check('a file that is not a zip is refused', /not a zip/.test(bad), bad);
  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close(); fs.unlinkSync(jar);
  const failed = results.filter(x => !x).length;
  console.log(failed ? failed + ' FAILED of ' + results.length : 'all ' + results.length + ' passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
