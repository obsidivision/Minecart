// The homepage keeps showing new random tracks, with no page errors, in both themes and on a phone.
// Usage: node home.js <base-url>
const { chromium } = require('../playwright');
const base = process.argv[2];
let failed = 0;
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  for (const [theme, w, h] of [['dark', 1300, 900], ['light', 1300, 900], ['dark', 390, 900]]) {
    const p = await b.newPage({ viewport: { width: w, height: h } });
    const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    await p.addInitScript(t => { try { localStorage.setItem('floatcart-rules-theme', t); } catch (e) {} }, theme);
    await p.goto(base + 'index.html');
    const codes = new Set();
    for (let i = 0; i < 16; i++) { await p.waitForTimeout(1000); codes.add(await p.evaluate(() => (document.querySelector('#now .mono') || {}).textContent)); }
    const ok = codes.size >= 3 && !errs.length;
    if (!ok) failed++;
    console.log((ok ? 'PASS ' : 'FAIL ') + 'homepage ' + theme + ' ' + w + 'px: ' + codes.size + ' tracks in 16 s' + (errs.length ? ', errors: ' + errs.join('; ') : ''));
    await p.close();
  }
  // the track on show opens in the finder, with its layout checked
  const p = await b.newPage({ viewport: { width: 1300, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(base + 'index.html'); await p.waitForTimeout(1500);
  const code = await p.evaluate(() => document.querySelector('#now .mono').textContent);
  await p.click('#now .open'); await p.waitForLoadState('load'); await p.waitForTimeout(1500);
  const got = await p.evaluate(() => ({ url: location.pathname, code: document.getElementById('code').value, detail: !!document.querySelector('#checkOut .dv') }));
  const ok = /floatcart-finder\.html$/.test(got.url) && got.code === code && got.detail && !errs.length;
  if (!ok) failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + 'homepage track opens in the finder  ' + code + ' -> ' + JSON.stringify(got) + (errs.length ? ' errors: ' + errs.join('; ') : ''));
  await b.close();
  console.log(failed ? failed + ' failed' : 'all passed');
  process.exit(failed ? 1 : 0);
})();
