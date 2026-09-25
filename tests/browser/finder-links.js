// Browser checks for the finder's links and memory, the result filter and grouping, and the quick
// pass of an every-stopper search. Usage: node finder-links.js <base-url>
const { chromium } = require('../playwright');
const base = process.argv[2];
const results = [];
function check(name, ok, detail) { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : '')); }
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const errors = [];
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(e.message));
  const click = sel => p.evaluate(s => document.querySelector(s).click(), sel);
  await p.goto(base + 'floatcart-finder.html'); await p.waitForTimeout(800);

  // settings are remembered and put in the address
  await click('input[name="cart"][value="boat"]'); await click('input[name="size"][value="0"]');
  await p.evaluate(() => { document.getElementById('posBox').open = true; }); await p.selectOption('#facing', 'east'); await p.waitForTimeout(100);
  const hash = await p.evaluate(() => location.hash);
  check('settings go into the address', /cart=boat/.test(hash) && /facing=east/.test(hash) && /size=0/.test(hash), hash.slice(0, 90));
  const p2 = await ctx.newPage(); await p2.goto(base + 'floatcart-finder.html'); await p2.waitForTimeout(600);
  const kept = await p2.evaluate(() => ({ cart: document.querySelector('input[name="cart"]:checked').value, facing: document.getElementById('facing').value, how: document.getElementById('how').value }));
  check('settings remembered on the next visit', kept.cart === 'boat' && kept.facing === 'east' && kept.how === 'fly', JSON.stringify(kept));
  await p2.close();

  // an every-stopper search: quick pass first, then the full search; filter and grouping
  await click('input[name="size"][value="1"]'); await click('#presetFloat');
  await p.click('#go');
  await p.waitForFunction(() => !document.getElementById('go').disabled && /Tried|Stopped/.test(document.getElementById('summary').textContent), null, { timeout: 300000 });
  const sum = await p.evaluate(() => document.getElementById('summary').textContent);
  check('every-stopper search finishes, counting the full search', /^Tried/.test(sum) && !/quick pass/.test(sum), sum.slice(0, 100));
  check('filter and grouping shown for several starts', await p.evaluate(() => !document.getElementById('resTools').hidden));
  const opts = await p.evaluate(() => [...document.getElementById('resFilter').options].filter(o => !o.disabled).map(o => o.value).join(','));
  check('filter offers only the kinds searched', opts === 'all,fly', opts);
  await p.check('#resGroup'); await p.waitForTimeout(200);
  const grouped = await p.evaluate(() => [...document.querySelectorAll('#rows tr.r .lay .code')].map(e => e.getAttribute('aria-label')));
  check('one row per layout', grouped.length > 0 && new Set(grouped).size === grouped.length, grouped.length + ' rows');
  await p.uncheck('#resGroup');

  // a result's link opens that track, with its start, in a fresh page
  await p.locator('#rows tr.r').first().click(); await p.waitForTimeout(1200);
  const listed = await p.evaluate(() => ({ val: document.querySelector('#rows tr.r .yf .mono').textContent, code: document.querySelector('#rows tr.r .code').getAttribute('aria-label') }));
  await p.click('#rows tr.detail .more-menu summary').then(() => p.click('#rows tr.detail [data-act="link"]')); await p.waitForTimeout(300);
  const link = await p.evaluate(() => navigator.clipboard.readText());
  check('copy link gives a link with the layout', link.indexOf('#') > 0 && /check=/.test(link), link.slice(0, 100));
  const p3 = await ctx.newPage(); p3.on('pageerror', e => errors.push(e.message));
  await p3.goto(link); await p3.waitForTimeout(1800);
  const opened = await p3.evaluate(() => ({ code: document.getElementById('code').value, table: !!document.querySelector('#checkOut table.res'),
    text: (document.querySelector('#checkOut') || {}).textContent || '', live: !!document.querySelector('#checkOut .glbox canvas') }));
  check('the link opens the track with its one start', opened.code === listed.code && !opened.table && opened.text.indexOf(listed.val) >= 0 && opened.live,
    opened.code + ' / ' + listed.val);
  await p3.close();

  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  const bad = results.filter(x => !x).length;
  console.log(bad ? bad + ' FAILED of ' + results.length : 'all ' + results.length + ' passed');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
