// Browser checks for the finder's starts: hand, launched (every stopper), boat carts, Check a layout.
// Usage: node finder-starts.js <base-url>
const { chromium } = require('../playwright');
const base = process.argv[2];
const results = [];
function check(name, ok, detail) { results.push({ name, ok }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : '')); }

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const errors = [];
  const p = await browser.newPage({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto(base + 'floatcart-finder.html'); await p.waitForTimeout(800);
  const val = id => p.evaluate(id => document.getElementById(id).value, id);
  const text = sel => p.evaluate(sel => { const e = document.querySelector(sel); return e ? e.textContent : null; }, sel);
  const hidden = id => p.evaluate(id => document.getElementById(id).hidden, id);
  const opts = () => p.evaluate(() => [...document.getElementById('how').options].filter(o => !o.disabled).map(o => o.value).join(','));

  /* ---------- the settings ---------- */
  check('default start is placed by hand', await val('how') === 'hand', await val('how'));
  check('stopper box hidden for a hand start', await hidden('stopBox'));
  check('empty cart offers hand, fly, both', await opts() === 'hand,fly,both', await opts());
  await p.evaluate(sel => document.querySelector(sel).click(), 'input[name="cart"][value="boat"]'); await p.waitForTimeout(100);
  check('boat cart switches to launched', await val('how') === 'fly', await val('how'));
  check('boat cart offers fly and loader only', await opts() === 'fly,loader', await opts());
  check('stopper box shown', !(await hidden('stopBox')));
  check('every stopper by default, the pick hidden', await p.evaluate(() => document.querySelector('input[name="stopAll"]:checked').value) === 'all' && await hidden('stopPick'));
  let hint = await text('#sizeHint');
  check('size hint counts 16 starts', /\(16 starts\)/.test(hint), hint);
  let ch = await text('#cartHint');
  check('cart hint: launcher, nothing to break, 16 starts', /launcher/.test(ch) && /Nothing to break/.test(ch) && /16 starts/.test(ch), ch);
await p.evaluate(sel => document.querySelector(sel).click(), 'input[name="stopAll"][value="one"]'); await p.waitForTimeout(50);
  check('pick one shows the selects', !(await hidden('stopPick')));
  await p.selectOption('#stopper', 'honey'); await p.selectOption('#approach', 'behind'); await p.waitForTimeout(100);
  ch = await text('#cartHint');
  check('one stopper: hint gives the fraction', /Starts at 0\.\d{10}/.test(ch) && !/starts/.test(await text('#sizeHint')), ch);
  await p.selectOption('#how', 'loader'); await p.waitForTimeout(100);
  ch = await text('#cartHint');
  check('loader hint mentions breaking the glass', /glass block/.test(ch), ch);
  await p.evaluate(sel => document.querySelector(sel).click(), 'input[name="cart"][value="empty"]'); await p.waitForTimeout(100);
  check('back to empty: hand again', await val('how') === 'hand', await val('how'));
  await p.evaluate(sel => document.querySelector(sel).click(), 'input[name="cart"][value="boat"]'); await p.waitForTimeout(100);
  check('back to boat: its own choice (loader) kept', await val('how') === 'loader', await val('how'));
  await p.selectOption('#how', 'fly'); await p.evaluate(sel => document.querySelector(sel).click(), 'input[name="stopAll"][value="all"]');
  await p.evaluate(sel => document.querySelector(sel).click(), 'input[name="cart"][value="empty"]'); await p.waitForTimeout(100);
  await p.selectOption('#how', 'both'); await p.waitForTimeout(100);
  hint = await text('#sizeHint');
  check('both ways: 17 starts', /\(17 starts\)/.test(hint), hint);

  /* ---------- a quick search over every start ---------- */
  await p.evaluate(sel => document.querySelector(sel).click(), 'input[name="size"][value="0"]');
  await p.click('#presetFloat');
  await p.click('#go');
  await p.waitForFunction(() => document.getElementById('go').disabled === false && /Tried|Stopped/.test(document.getElementById('summary').textContent), null, { timeout: 180000 });
  const sum = await text('#summary');
  check('search over 17 starts finishes', /Tried/.test(sum), sum.slice(0, 160));
  const rows = await p.evaluate(() => [...document.querySelectorAll('#rows tr.r')].map(tr => ({ id: tr.getAttribute('data-id'), start: (tr.querySelector('.startv') || {}).textContent, val: tr.querySelector('.yf .mono') && tr.querySelector('.yf .mono').textContent })));
  check('rows carry their start', rows.length === 20 && rows.every(r => r.start), rows.slice(0, 3).map(r => r.start + ' ' + r.val).join(' | '));
  const kinds = new Set(rows.map(r => r.start.split(':')[0]));
  check('both kinds of start can show up', true, [...kinds].join(', '));
  // open the first launched row
  const li = rows.findIndex(r => /^Launched/.test(r.start));
  check('a launched result is listed', li >= 0);
  await p.locator('#rows tr.r').nth(li).click(); await p.waitForTimeout(1500);
  const det = await p.evaluate(() => {
    const d = document.querySelector('#rows tr.detail');
    return d ? { text: d.textContent, live: !!d.querySelector('.glbox canvas'), labels: [...d.querySelectorAll('.gl-labels *')].map(e => e.textContent).filter(Boolean),
                 tester: !!d.querySelector('[data-act="tester"]'), fracs: [...d.querySelectorAll('.facts b.mono')].map(b => b.textContent) } : null;
  });
  check('launched detail: launcher paragraph', det && /Launcher, \d+ blocks up/.test(det.text) && /Nothing to break/.test(det.text), det && det.text.slice(det.text.indexOf('Launcher,'), det.text.indexOf('Launcher,') + 200));
  check('launched detail: rail 0 is where it lands', det && /the cart lands here/.test(det.text));
  check('launched detail: 3D view live', det && det.live);
  check('launched detail: step labels', det && det.labels.some(t => /Place the cart/.test(t)) && det.labels.some(t => /Stops here/.test(t)) && det.labels.some(t => /Parks here/.test(t)), det && det.labels.join(' | '));
  check('launched detail: tester button', det && det.tester);
  check('launched detail: lands and parks tick facts', det && /lands at tick \d+, parks at tick \d+/.test(det.text));
  // the row's value and the full flight agree (else a note says by how much)
  const rowVal = rows[li].val, detVal = det && det.text.match(/y fraction (0\.\d{10})/);
  check('row value equals the full flight (or a note says)', detVal && (detVal[1] === rowVal || /away from the listed value/.test(det.text)), rowVal + ' vs ' + (detVal && detVal[1]));
  // play the launched run from the start
  const n0 = await p.evaluate(() => +document.querySelector('#rows .gl-play .tickread span').textContent);
  await p.evaluate(() => { const s = document.querySelector('#rows .gl-play input'); s.value = 0; s.dispatchEvent(new Event('input')); });
  await p.click('#rows .gl-play .play'); await p.waitForTimeout(1200);
  const t1 = await p.evaluate(() => +document.querySelector('#rows .gl-play .tickread b').textContent);
  check('play runs the launched cart from the launcher', t1 > 5 && t1 < n0, t1 + ' of ' + n0);
  await p.click('#rows .gl-play .play');
  // download
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#rows tr.detail [data-act="lite"]')]);
  const name = dl.suggestedFilename();
  check('download names the start', /^track-.*-fly-[a-z_]+-(behind|front)\.litematic$/.test(name), name);
  const fs = require('fs'), zlib = require('zlib'), path = await dl.path(), raw = zlib.gunzipSync(fs.readFileSync(path));
  check('download is a gzip NBT file with the launcher described', raw[0] === 10 && /flies off the launch slope/.test(raw.toString('latin1')), raw.length + ' bytes');
  // check at 60 positions
  await p.click('#rows tr.detail [data-act="verify"]');
  await p.waitForFunction(() => { const v = document.querySelector('#rows tr.detail .verify'); return v && !v.hidden; }, null, { timeout: 120000 });
  const vt = await text('#rows tr.detail .verify');
  check('check at 60 positions: all parked, flight included', /60 of 60<\/b>|60 of 60/.test(vt) && /launched/.test(vt), vt.slice(0, 200));

  /* ---------- boat cart, launched, one stopper ---------- */
  await p.evaluate(sel => document.querySelector(sel).click(), 'input[name="cart"][value="boat"]'); await p.waitForTimeout(100);
  await p.selectOption('#how', 'fly'); await p.evaluate(sel => document.querySelector(sel).click(), 'input[name="stopAll"][value="one"]'); await p.selectOption('#stopper', 'small_tip'); await p.selectOption('#approach', 'front');
  await p.click('#go');
  await p.waitForFunction(() => document.getElementById('go').disabled === false && /Tried|Stopped/.test(document.getElementById('summary').textContent), null, { timeout: 180000 });
  const bs = await text('#summary');
  check('boat search names its one start in the summary', /, launched into the tip of the small bud from in front\./.test(bs), bs.slice(-160));
  await p.locator('#rows tr.r').first().click(); await p.waitForTimeout(1500);
  const bd = await p.evaluate(() => { const d = document.querySelector('#rows tr.detail'); return { text: d.textContent, labels: [...d.querySelectorAll('.gl-labels *')].map(e => e.textContent).filter(Boolean) }; });
  check('boat detail: put a boat on the rail', /Put a boat on the rail at/.test(bd.text), '');
  check('boat detail: labels number the boat step', bd.labels.some(t => /^2 Boat/.test(t)) && bd.labels.some(t => /^3 Stops here/.test(t)) && bd.labels.some(t => /^4 Parks here/.test(t)), bd.labels.join(' | '));

  const [td] = await Promise.all([p.waitForEvent('download'), p.click('#rows tr.detail [data-act="tester"]')]);
  const traw = require('zlib').gunzipSync(require('fs').readFileSync(await td.path())).toString('latin1');
  check('boat tester: summons the boat and the cart', /summon oak_boat/.test(traw) && /summon minecart/.test(traw) && /-fly-small_tip-front\.litematic$/.test(td.suggestedFilename()), td.suggestedFilename());
  const tn = await text('#rows tr.detail .note[data-for]');
  check('boat tester note', /spawns the boat, then the cart on the launcher/.test(tn), tn.slice(0, 160));

  /* ---------- check a layout over every start ---------- */
  await p.evaluate(sel => document.querySelector(sel).click(), 'input[name="stopAll"][value="all"]');
  await p.fill('#code', 'Dr Dr Fr Fr Fp Up Fr Fr Ur E');
  await p.click('#checkBtn'); await p.waitForTimeout(3000);
  const co = await p.evaluate(() => ({ rows: document.querySelectorAll('#checkOut tr.r').length, open: document.querySelectorAll('#checkOut tr.detail').length,
    live: !!document.querySelector('#checkOut .glbox canvas'), first: (document.querySelector('#checkOut tr.r .startv') || {}).textContent }));
  check('check a layout: one row per start, the closest open', co.rows === 16 && co.open === 1 && co.live, JSON.stringify(co));
  await p.locator('#checkOut tr.r').nth(3).click(); await p.waitForTimeout(800);
  const co2 = await p.evaluate(() => document.querySelectorAll('#checkOut tr.detail').length);
  check('check a layout: another start opens too', co2 === 2, String(co2));

  /* ---------- hand start: as before ---------- */
  await p.evaluate(sel => document.querySelector(sel).click(), 'input[name="cart"][value="empty"]'); await p.waitForTimeout(100);
  await p.selectOption('#how', 'hand');
  await p.click('#checkBtn'); await p.waitForTimeout(1500);
  const hc = await p.evaluate(() => ({ table: !!document.querySelector('#checkOut table.res'), tester: !!document.querySelector('#checkOut [data-act="tester"]'),
    text: document.querySelector('#checkOut').textContent }));
  check('hand check: details directly, tester offered', !hc.table && hc.tester && /place the cart here/.test(hc.text));

  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  const bad = results.filter(r => !r.ok).length;
  console.log(bad ? bad + ' FAILED of ' + results.length : 'all ' + results.length + ' passed');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
