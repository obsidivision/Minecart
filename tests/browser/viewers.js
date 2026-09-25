// Browser checks for the finder 3D viewer and the tick player. Usage: node viewers.js <base-url>
const { chromium } = require('../playwright');
const base = process.argv[2];
const results = [];
function check(name, ok, detail) { results.push({ name, ok }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : '')); }

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const errors = [];
  async function open(page) {
    const p = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    p.on('pageerror', e => errors.push(page + ': ' + e.message));
    p.on('console', m => { if (m.type() === 'error') errors.push(page + ': ' + m.text()); });
    await p.goto(base + page); await p.waitForTimeout(700);
    return p;
  }
  // what each 3D box holds; EMPTY is the bug
  const boxes = p => p.evaluate(() => [...document.querySelectorAll('.glbox')].map(b =>
    b.querySelector('canvas') ? 'LIVE' : b.querySelector('img') ? 'snap' : b.children.length ? 'other' : 'EMPTY'));
  const noEmpty = s => s.length > 0 && !s.includes('EMPTY');
  // distinct colours in a screenshot of the element: a drawn scene has hundreds, a blank box a handful
  async function colours(p, loc) {
    const b64 = (await loc.screenshot()).toString('base64');
    return p.evaluate(async b64 => {
      const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data, set = new Set();
      for (let i = 0; i < d.length; i += 4) set.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      return set.size;
    }, b64);
  }

  /* ---------- finder: Check a layout, twice ---------- */
  let p = await open('floatcart-finder.html');
  await p.fill('#code', 'Dr Dr Fr Fr Fp Up Fr Fr Ur E');
  await p.click('#checkBtn'); await p.waitForTimeout(500);
  const glbox = p.locator('#checkOut .glbox');
  const box = await glbox.boundingBox();              // orbit the camera so a reset would show
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await p.mouse.down();
  await p.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 40, { steps: 8 }); await p.mouse.up();
  await p.waitForTimeout(300);
  const shotBefore = (await glbox.screenshot()).toString('base64');
  await p.click('#checkBtn'); await p.waitForTimeout(500);
  let st = await boxes(p);
  check('Simulate twice: the 3D box is live, not empty', st.join() === 'LIVE', JSON.stringify(st));
  const col = await colours(p, glbox);
  check('Simulate twice: the scene is actually drawn after the move', col > 200, col + ' distinct colours');
  const shotAfter = (await glbox.screenshot()).toString('base64');
  const changed = await p.evaluate(async ([a, b]) => {
    async function px(b64) {
      const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, c.width, c.height).data;
    }
    const A = await px(a), B = await px(b); let n = 0;
    for (let i = 0; i < A.length; i += 4) if (Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2])) > 2) n++;
    return n;
  }, [shotBefore, shotAfter]);
  check('Simulate twice: the camera the user turned is kept', changed === 0, changed + ' pixels differ by more than 2 levels');

  /* ---------- finder: the same result in the checker and in the results ---------- */
  await p.check('input[name="size"][value="0"]', { force: true });
  await p.click('#go');
  await p.waitForFunction(() => /^Done|Stopped|failed/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
  const firstCode = (await p.locator('#rows tr.r').first().getAttribute('data-id')).split('|')[0];
  await p.fill('#code', firstCode); await p.click('#checkBtn'); await p.waitForTimeout(400);
  const rowBtn = i => p.locator('#rows tr.r').nth(i).locator('td.more button');
  await rowBtn(0).click(); await p.waitForTimeout(400);             // same code, same settings, same key
  st = await boxes(p);
  check('Same result twice: one live, one picture, none empty', noEmpty(st) && st.filter(s => s === 'LIVE').length === 1, JSON.stringify(st));
  await rowBtn(1).click(); await p.waitForTimeout(400);             // re-render with a fresh result
  await rowBtn(1).click(); await p.waitForTimeout(400);             // and close it again
  st = await boxes(p);
  check('Same result twice, after re-renders: none empty', noEmpty(st) && st.filter(s => s === 'LIVE').length === 1, JSON.stringify(st));
  await p.fill('#code', ''); await p.click('#checkBtn'); await p.waitForTimeout(200);   // clear the checker
  await rowBtn(0).click(); await p.waitForTimeout(300);             // close row 1

  /* ---------- finder: open, open another, close, reopen ---------- */
  const steps = [['open row 1', 0], ['open row 2', 1], ['close row 2', 1], ['reopen row 2', 1], ['close row 2 again', 1], ['close row 1', 0], ['reopen row 1', 0]];
  let seq = [], allOk = true;
  for (const [name, i] of steps) {
    await rowBtn(i).click(); await p.waitForTimeout(350);
    st = await boxes(p); seq.push(name + ' ' + JSON.stringify(st));
    if (st.length && (!noEmpty(st) || st.filter(s => s === 'LIVE').length !== 1)) allOk = false;
  }
  check('Open / close / reopen results: always one live view, never an empty box', allOk, '\n      ' + seq.join('\n      '));
  await p.close();

  /* ---------- finder: a result left open while a search runs ---------- */
  p = await open('floatcart-finder.html');
  await p.check('input[name="size"][value="2"]', { force: true });   // Deep: long enough to re-render many times
  await p.click('#go');
  await p.waitForSelector('#rows tr.r', { timeout: 60000 });
  await p.locator('#rows tr.r').first().locator('td.more button').click();
  let polls = 0, empties = 0, rerenders = 0, running = true;
  while (running && polls < 600) {
    const r = await p.evaluate(() => {
      const b = document.querySelector('.glbox');
      let fresh = false;
      if (b && !b.dataset.probe) { fresh = true; b.dataset.probe = '1'; }
      return { state: b ? (b.querySelector('canvas') ? 'LIVE' : b.querySelector('img') ? 'snap' : 'EMPTY') : 'none', fresh,
               running: !/^Done|Stopped|failed/.test(document.getElementById('status').textContent) };
    });
    polls++; if (r.fresh) rerenders++; if (r.state === 'EMPTY') empties++; running = r.running;
    await p.waitForTimeout(100);
  }
  check('Open result during a running search: never empty', empties === 0 && rerenders > 2,
    rerenders + ' re-renders seen, ' + empties + ' empty samples in ' + polls + ' polls');
  await p.close();

  /* ---------- 3D pages: the slider and the tick readout agree ---------- */
  const readout = p => p.evaluate(() => ({ slider: +document.getElementById('tick').value, num: +document.getElementById('tickNum').textContent,
    max: +document.getElementById('tickMax').textContent, playing: document.getElementById('play').classList.contains('playing') }));
  const toStart = p => p.evaluate(() => { const t = document.getElementById('tick'); t.value = 0; t.dispatchEvent(new Event('input')); });
  async function pauseMidway(p, ms) {                    // from tick 0, play for ms, pause; null if the pause didn't take
    await toStart(p); await p.click('#play'); await p.waitForTimeout(ms); await p.click('#play');
    const r = await readout(p); return r.playing ? null : r;
  }
  for (const page of ['floatcart-3d.html', 'floatcart-makers-3d.html']) {
    p = await open(page);
    await p.selectOption('#speed', '1');
    let mismatches = 0, stepBad = 0, trials = 12, skipped = 0;
    for (let i = 0; i < trials; i++) {
      const a = await pauseMidway(p, 80 + 45 * i);         // 20 ticks a second: stays well inside every run
      if (!a) { skipped++; continue; }
      if (a.slider !== a.num) mismatches++;
      await p.click('#fwd'); const b = await readout(p);
      if (b.num !== a.num + 1 || b.slider !== b.num) stepBad++;
      await p.click('#back'); const c = await readout(p);
      if (c.num !== a.num || c.slider !== c.num) stepBad++;
    }
    check(page + ': paused mid-tick, slider matches the tick number', mismatches === 0 && skipped === 0, mismatches + ' of ' + trials + ' pauses disagreed, ' + skipped + ' skipped');
    check(page + ': next / previous tick move exactly one tick', stepBad === 0 && skipped === 0, stepBad + ' bad steps');
    if (page === 'floatcart-3d.html') {                  // switching runs keeps the tick on show
      let kept = 0, tries = 6, detail = [];
      for (let i = 0; i < tries; i++) {
        const target = i % 2 ? 'built' : 'solution';
        await p.click('[data-run="' + (target === 'built' ? 'solution' : 'built') + '"]');   // start from the other run
        const a = await pauseMidway(p, 120 + 70 * i);
        if (!a) { detail.push('pause missed'); continue; }
        await p.click('[data-run="' + target + '"]'); const b = await readout(p);
        const want = Math.min(a.num, b.max);
        if (b.num === want && b.slider === want) kept++; else detail.push(a.num + '->' + b.num);
      }
      check(page + ': switching runs keeps the tick on show', kept === tries, kept + ' of ' + tries + (detail.length ? ' ' + detail.join(', ') : ''));
    }
    await p.close();
  }

  /* ---------- every page loads without errors ---------- */
  for (const page of ['floatcart-3d.html', 'floatcart-makers-3d.html', 'floatcart-finder.html', 'floatcart-simulator-rules.html']) {
    p = await open(page); await p.waitForTimeout(500); await p.close();
  }
  check('No page errors on any page', errors.length === 0, errors.join(' | '));
  await browser.close();
  const failed = results.filter(r => !r.ok).length;
  console.log('\n' + (results.length - failed) + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
