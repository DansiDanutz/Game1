/* Headless smoke-test: actually loads the game in a real browser and asserts it
   boots and is interactive. This catches whole classes of failures that a
   per-file `node --check` cannot — e.g. a cross-file top-level identifier
   collision (the "Identifier 'WORLDS' has already been declared" bug that once
   silenced all of app.js and shipped a dead, static page to production).

   Serves the repo on a local port, drives it with Playwright, and fails (exit 1)
   on any page error or if the core surfaces don't render. Cloud is stubbed off
   so the test never touches Supabase. Run by CI and locally:  node tools/smoke.js
*/
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.SMOKE_PORT || 8231;
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
               '.png':'image/png', '.svg':'image/svg+xml', '.json':'application/json' };

// minimal static server
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  // stub config so we never hit Supabase during the test
  if (p === '/js/config.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    return res.end('window.SHIKAKU_CONFIG={SUPABASE_URL:"",SUPABASE_ANON_KEY:""};');
  }
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('nf');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

function fail(msg) { console.error('SMOKE FAIL: ' + msg); process.exitCode = 1; }

(async () => {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { console.log('SMOKE SKIP: playwright not installed'); return; }

  await new Promise(r => server.listen(PORT, r));
  const errors = [];
  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage({ viewport: { width: 460, height: 1000 } });
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/ERR_CERT|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });

    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(600);

    // 1) core objects exist (proves app.js executed end-to-end)
    const api = await page.evaluate(() => ({
      game: typeof window.game !== 'undefined',
      battle: typeof window.battle !== 'undefined',
      puzzle: !!(window.SHIKAKU_PUZZLE && window.SHIKAKU_PUZZLE.WORLDS),
      fx: typeof window.FX !== 'undefined',
      onboarding: document.getElementById('ov-profile').classList.contains('show'),
    }));
    if (!api.game) fail('window.game is undefined (app.js did not run)');
    if (!api.battle) fail('window.battle is undefined');
    if (!api.puzzle) fail('SHIKAKU_PUZZLE.WORLDS missing');

    // 2) onboarding -> name -> menu renders all level tiles
    if (api.onboarding) {
      await page.fill('#inpName', 'CITester');
      await page.click('#ov-profile .btn.primary');
      await page.waitForTimeout(300);
    }
    const tiles = await page.$$eval('#worlds .lv', els => els.length);
    if (tiles !== 15) fail(`expected 15 level tiles, got ${tiles}`);

    // 3) starting a level renders a board with cells + clues
    await page.evaluate(() => window.game.startLevel(0, 0));
    await page.waitForTimeout(400);
    const board = await page.evaluate(() => ({
      visible: !document.getElementById('screen-game').classList.contains('hide'),
      cells: document.querySelectorAll('#board .cell').length,
      numbers: document.querySelectorAll('#board .num').length,
    }));
    if (!board.visible) fail('game screen did not show after startLevel');
    if (board.cells < 4) fail(`board has too few cells (${board.cells})`);
    if (board.numbers < 1) fail('board shows no clue numbers');

    // 4) drawing a rectangle works (interactivity)
    const box = await (await page.$('#board')).boundingBox();
    await page.mouse.move(box.x + 6, box.y + 6); await page.mouse.down();
    await page.mouse.move(box.x + 36, box.y + 6, { steps: 4 }); await page.mouse.up();
    await page.waitForTimeout(200);
    const rects = await page.$$eval('#board .rect', e => e.length);
    if (rects < 1) fail('drawing a rectangle produced no .rect element');

    // 5) battle lobby opens
    await page.evaluate(() => openBattle());
    await page.waitForTimeout(200);
    const lobby = await page.evaluate(() => document.getElementById('ov-lobby').classList.contains('show'));
    if (!lobby) fail('battle lobby did not open');

    if (errors.length) fail('runtime errors:\n  ' + errors.join('\n  '));
    if (!process.exitCode) console.log(`SMOKE OK: game boots · ${tiles} levels · board ${board.cells} cells/${board.numbers} clues · draw + battle interactive`);
  } catch (e) {
    fail(e.message);
  } finally {
    if (browser) await browser.close();
    server.close();
  }
})();
