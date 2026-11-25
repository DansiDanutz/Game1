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
// cloudStub is switched on only for the account checks, which run the cloud code
// against a stubbed Supabase SDK (see fakeSupabase) instead of the network.
let cloudStub = false;
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  // stub config so we never hit Supabase during the test
  if (p === '/js/config.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    return res.end(cloudStub
      ? 'window.SHIKAKU_CONFIG={SUPABASE_URL:"https://smoke.invalid",SUPABASE_ANON_KEY:"smoke",PLUS:{enabled:true,price:"$4.99",credits:100}};'
      : 'window.SHIKAKU_CONFIG={SUPABASE_URL:"",SUPABASE_ANON_KEY:""};');
  }
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('nf');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

function fail(msg) { console.error('SMOKE FAIL: ' + msg); process.exitCode = 1; }

// Runs inside the page before any script: a signed-in device (name CITester with
// a PIN session) and a Supabase SDK stub. window.__fake sets the server's answers.
function fakeSupabase() {
  localStorage.setItem('shikaku_profile', JSON.stringify({ id: 'smoke-id', username: 'CITester',
    avatar: '\u{1F3AE}', theme: 'neon', accent: null, sound: true, anim: true, progress: {}, wins: 0, losses: 0 }));
  localStorage.setItem('shikaku_session', JSON.stringify({ key: 'citester', token: 'tok-smoke' }));
  const t = window.__fake = { left: 9, reset: '2026-11-26T00:00:00+00:00', limit: false,
    linkError: null, otpError: null, verifyError: null,
    email: false, calls: [], billing: [], finish: 'won', match: { status: 'open', result: null, puzzle: null },
    plus: { credits: 0, trophies: 0, wins: 0, losses: 0, subscription_status: null, cancel_at_period_end: null, current_period_end: null } };
  const ok = (data) => Promise.resolve({ data: data, error: null });
  const fail = (message) => Promise.resolve({ data: null, error: { message: message } });
  const rpc = (fn, args) => {
    if (fn === 'shikaku_account_status') return ok('claimed');
    if (fn === 'shikaku_game_quota') return ok([{ games_left: t.left, reset_at: t.reset }]);
    if (fn === 'shikaku_start_game') {
      if (t.limit) return ok([{ status: 'limit', ticket: null, games_left: 0, reset_at: t.reset }]);
      t.left -= 1;
      return ok([{ status: 'ok', ticket: 'smoke-ticket', games_left: t.left, reset_at: t.reset }]);
    }
    t.calls.push([fn, args]);
    if (fn === 'shikaku_deal_board') return ok([{ puzzle: [[2, 0], [2, 0]] }]);
    if (fn === 'shikaku_finish_game') return ok([{ status: 'ok', score: 777, stars: 2, time_sec: 83 }]);
    if (fn === 'shikaku_play_status') return ok([Object.assign({ username: 'CITester' }, t.plus)]);
    if (fn === 'shikaku_start_extra_game') { t.plus.credits -= 1; return ok([{ status: 'ok', ticket: 'extra', credits: t.plus.credits }]); }
    if (fn === 'shikaku_match_create') return ok([{ match_id: 'm1', code: 'ABC234' }]);
    if (fn === 'shikaku_match_state') return ok([t.match]);
    if (fn === 'shikaku_match_finish') { return ok([{ status: t.finish }]); }
    if (fn === 'shikaku_link_email') return t.linkError ? fail(t.linkError) : ok(null);
    if (fn === 'shikaku_email_sign_in') return ok([{ username: 'CITester', token: 'tok-email' }]);
    return ok(null);
  };
  const query = () => {
    const q = { select() { return q; }, eq() { return q; }, ilike() { return q; }, gt() { return q; },
      order() { return q; }, limit() { return ok([]); }, maybeSingle() { return ok(null); },
      then(res, rej) { return ok([]).then(res, rej); } };
    return q;
  };
  const client = {
    rpc: rpc, from: query,
    auth: {
      signInWithOtp: () => (t.otpError ? fail(t.otpError) : ok({})),
      verifyOtp: () => (t.verifyError ? fail(t.verifyError) : ok({})),
      getSession: () => ok({ session: t.email ? {} : null }),
      signOut: () => { t.email = false; return ok(null); },
    },
    functions: { invoke: (name, o) => { t.billing.push(o.body.action); return ok(o.body.action === 'cancel' ? { ended: false } : { url: 'https://evil.test/' }); } },
  };
  window.supabase = { createClient: () => client };
}

// Free daily games and email sign-in, in a second page with the cloud stubbed on.
async function accountChecks(browser, url) {
  cloudStub = true;
  const context = await browser.newContext({ viewport: { width: 460, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_CERT|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'application/javascript', body: '', headers: { 'access-control-allow-origin': '*' } }));
  await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.addInitScript(fakeSupabase);
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(500);
    const text = (sel) => page.$eval(sel, el => el.textContent || '');
    const shown = (sel) => page.$eval(sel, el => el.classList.contains('show'));
    const hidden = (sel) => page.$eval(sel, el => el.classList.contains('hide'));
    const isFocused = (id) => page.evaluate((x) => document.activeElement && document.activeElement.id === x, id);

    // a) the menu says how many free games are left today
    try {
      await page.waitForFunction(() => /9 of 10 free games left today/.test(document.getElementById('gamesLeft').textContent), null, { timeout: 5000 });
    } catch { fail('menu does not show "9 of 10 free games left today"'); }

    // b) the 11th board: the limit screen shows instead of the board, focused, with the reset time
    await page.evaluate(() => { window.__fake.limit = true; });
    await page.click('#worlds .lv');
    await page.waitForTimeout(400);
    if (!(await shown('#ov-limit'))) fail('limit screen did not open when the daily limit was reached');
    if (!(await hidden('#screen-game'))) fail('the board opened even though the daily limit was reached');
    if (!/midnight UTC/.test(await text('#limitReset'))) fail('limit screen does not say when games reset');
    if (!(await isFocused('limitTitle'))) fail('limit screen does not move focus to its heading');
    await page.evaluate(() => { window.__fake.limit = false; });
    await page.click('#ov-limit .btn.primary');
    await page.waitForTimeout(200);

    // b1) the board, the time and the score are the server's
    await page.evaluate(() => { window.__fake.limit = false; hideAll(); window.game.startLevel(0, 0); });
    await page.waitForTimeout(400);
    const gb = await (await page.$('#board')).boundingBox();
    for (const row of [.25, .75]) {
      await page.mouse.move(gb.x + gb.width * .25, gb.y + gb.height * row); await page.mouse.down();
      await page.mouse.move(gb.x + gb.width * .75, gb.y + gb.height * row, { steps: 5 }); await page.mouse.up();
    }
    await page.waitForTimeout(500);
    if (!/^777 pts/.test(await text('#sFinal')) || !/01:23/.test(await text('#winStats'))) fail('the win screen does not show the server result: ' + await text('#sFinal') + ' ' + await text('#winStats'));
    const shot = await page.evaluate(() => (window.__fake.calls.find(c => c[0] === 'shikaku_finish_game') || [])[1]);
    if (!shot || 'p_score' in shot || 'p_time_sec' in shot) fail('the browser still sends its own score');
    await page.evaluate(() => hideAll());
    // b2) Plus: the terms are shown before paying, and only Stripe's pages are opened
    await page.evaluate(() => backToMenu());
    await page.click('#plusBtn');
    await page.waitForTimeout(300);
    if (await hidden('#plusSignIn')) fail('Plus does not ask for the email first');
    await page.evaluate(() => { window.__fake.email = true; });
    await page.evaluate(() => Plus.open());
    await page.waitForTimeout(300);
    if (await hidden('#plusBuy') || !(await hidden('#plusPlay'))) fail('a player without a plan should see only the subscription');
    if (!/\$4\.99 a month, charged until you cancel.*no cash value/.test(await text('#plusTerms'))) fail('price and cancellation terms are not next to the button');
    const here = page.url();
    await page.click('#plusSubscribe');
    await page.waitForTimeout(300);
    if (page.url() !== here) fail('checkout opened a page that is not Stripe');
    // b3) a subscriber plays a match, and the result is the server's
    await page.evaluate(() => { Object.assign(window.__fake.plus, { credits: 5, subscription_status: 'active', cancel_at_period_end: false, current_period_end: '2026-12-25T00:00:00Z' }); });
    await page.evaluate(() => Plus.open());
    await page.waitForTimeout(300);
    if (!(await hidden('#plusBuy')) || await hidden('#plusPlay') || await hidden('#plusManage')) fail('a subscriber should see matches and plan controls, not a second sale');
    if (!/5 play credits.*Renews on/.test(await text('#plusSummary'))) fail('summary is wrong: ' + await text('#plusSummary'));
    await page.click('#plusCreate');
    await page.waitForTimeout(300);
    if (await hidden('#plusWait') || (await text('#plusMyCode')) !== 'ABC234') fail('the match code is not shown while waiting');
    await page.evaluate(() => { window.__fake.match = { status: 'playing', result: null, opponent: '<img src=x>', puzzle: [[2,0],[2,0]] }; });
    await page.waitForFunction(() => !document.getElementById('screen-ranked').classList.contains('hide'), null, { timeout: 5000 });
    if (await page.$('#rankedStatus img')) fail('an opponent name was rendered as HTML');
    const rb = await (await page.$('#rboard')).boundingBox();
    const drag = async (row) => {
      await page.mouse.move(rb.x + rb.width * .25, rb.y + rb.height * (.25 + row * .5)); await page.mouse.down();
      await page.mouse.move(rb.x + rb.width * .75, rb.y + rb.height * (.25 + row * .5), { steps: 5 }); await page.mouse.up();
    };
    await drag(0); await drag(1);
    await page.waitForTimeout(400);
    const sent = await page.evaluate(() => (window.__fake.calls.find(c => c[0] === 'shikaku_match_finish') || [])[1]);
    if (!sent || sent.p_rects.length !== 2) fail('the solution was not sent to the server');
    if (!/You win/.test(await text('#rankedStatus'))) fail('the winning result is not shown');
    await page.click('#rankedLeave');
    // b4) at the limit, an extra game costs a credit only when asked for
    await page.evaluate(() => { window.__fake.limit = true; });
    await page.click('#worlds .lv');
    await page.waitForTimeout(300);
    if (await hidden('#limitPlus')) fail('the limit screen does not offer an extra game');
    if (await page.evaluate(() => window.__fake.plus.credits) !== 5) fail('a credit was spent without being asked for');
    await page.click('#limitExtra');
    await page.waitForTimeout(300);
    if (await page.evaluate(() => window.__fake.plus.credits) !== 4 || await hidden('#screen-game')) fail('the extra game did not start for one credit');
    await page.evaluate(() => { window.__fake.limit = false; backToMenu(); });

    // c) link an email to the signed-in name: dialog semantics, labelled fields, Enter submits
    await page.evaluate(() => openSettings());
    await page.waitForTimeout(150);
    if (await hidden('#settingsEmailWrap')) fail('settings has no "Link an email" button while signed in');
    await page.click('#settingsEmail');
    await page.waitForTimeout(150);
    if (!(await shown('#ov-email'))) fail('email sign-in overlay did not open');
    const dialog = await page.$eval('#ov-email .modal', el => [el.getAttribute('role'), el.getAttribute('aria-modal'), el.getAttribute('aria-labelledby')]);
    if (dialog.join('|') !== 'dialog|true|emailTitle') fail('email overlay is not a labelled modal dialog: ' + dialog.join('|'));
    const labelled = await page.$eval('#inpEmail', el => !!document.querySelector('label[for="inpEmail"]') && el.type === 'email' && el.getAttribute('autocomplete') === 'email');
    if (!labelled) fail('email field has no label, type or autocomplete');
    if (!(await isFocused('inpEmail'))) fail('email field is not focused when the overlay opens');
    if (!/LINK YOUR EMAIL/.test(await text('#emailTitle'))) fail('link mode title is wrong');
    await page.fill('#inpEmail', 'ann@example.com');
    await page.press('#inpEmail', 'Enter');
    await page.waitForTimeout(300);
    if (await hidden('#emailStep2')) fail('pressing Enter did not send the code and show the code step');
    const codeField = await page.$eval('#inpEmailCode', el => [el.getAttribute('autocomplete'), el.getAttribute('inputmode')]);
    if (codeField.join('|') !== 'one-time-code|numeric') fail('code field is not set up for one-time codes: ' + codeField.join('|'));
    await page.fill('#inpEmailCode', '123456');
    await page.press('#inpEmailCode', 'Enter');
    await page.waitForTimeout(400);
    if (await shown('#ov-email')) fail('overlay stayed open after the email was linked');
    if (!/Email linked/.test(await text('#toast'))) fail('no confirmation after linking the email');
    const stored = await page.evaluate(() => Object.values(localStorage).some(v => v.indexOf('ann@example.com') !== -1));
    if (stored) fail('the email address was written to localStorage');

    // d) friendly error for an email that is already linked; Escape closes the overlay
    await page.evaluate(() => { window.__fake.linkError = 'shikaku: email already linked'; });
    await page.evaluate(() => openSettings());
    await page.click('#settingsEmail');
    await page.fill('#inpEmail', 'ann@example.com');
    await page.click('#emailSend');
    await page.waitForTimeout(200);
    await page.fill('#inpEmailCode', '123456');
    await page.click('#emailVerify');
    await page.waitForTimeout(300);
    const friendly = await text('#emailMsg');
    if (!/already linked to another name/.test(friendly)) fail('linking an already-linked email gave an unfriendly message: ' + friendly);
    if (!(await page.$eval('#emailMsg', el => el.getAttribute('role') === 'status' && el.getAttribute('aria-live') === 'polite'))) fail('error message is not announced (role=status, aria-live)');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    if (await shown('#ov-email')) fail('Escape does not close the email overlay');
    await page.evaluate(() => { window.__fake.linkError = null; });

    // e) sign in with an email from the profile screen (the sign-in title, not the link title)
    await page.evaluate(() => openProfile());
    await page.waitForTimeout(150);
    await page.click('#profEmail');
    await page.waitForTimeout(150);
    if (!/SIGN IN WITH EMAIL/.test(await text('#emailTitle'))) fail('profile "Sign in with email" does not open sign-in mode');

    if (errors.length) fail('runtime errors in the account checks:\n  ' + errors.join('\n  '));
    if (!process.exitCode) console.log('SMOKE OK: account checks · quota line · limit screen · Plus, match and extra game · email link and sign-in');
  } catch (e) {
    fail('account checks: ' + e.message);
  } finally {
    cloudStub = false;
    await context.close();
  }
}

(async () => {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { console.log('SMOKE SKIP: playwright not installed'); return; }

  await new Promise(r => server.listen(PORT, r));
  const errors = [];
  let browser;
  try {
    // SMOKE_CHROME lets a developer run against an installed Chrome (no browser
    // download needed); CI leaves it unset and uses Playwright's Chromium.
    browser = await chromium.launch({
      executablePath: process.env.SMOKE_CHROME || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
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
      manifest: !!document.querySelector('link[rel="manifest"]'),
      installBtn: !!document.getElementById('installBtn'),
      installFn: typeof window.installApp === 'function',
      dailyCard: !!document.getElementById('dailyCard'),
      dailyFn: typeof window.startDaily === 'function',
      dailyGen: !!(window.SHIKAKU_PUZZLE && typeof window.SHIKAKU_PUZZLE.dailyGrid === 'function'),
    }));
    if (!api.game) fail('window.game is undefined (app.js did not run)');
    if (!api.battle) fail('window.battle is undefined');
    if (!api.puzzle) fail('SHIKAKU_PUZZLE.WORLDS missing');
    if (!api.manifest) fail('PWA manifest <link> missing');
    if (!api.installBtn || !api.installFn) fail('PWA install button/handler missing');
    if (!api.dailyCard || !api.dailyFn || !api.dailyGen) fail('Daily Challenge wiring missing');

    // 2) onboarding -> name -> menu renders all level tiles
    if (api.onboarding) {
      await page.fill('#inpName', 'CITester');
      await page.click('#ov-profile .btn.primary');
      await page.waitForTimeout(300);
    }
    const tiles = await page.$$eval('#worlds .lv', els => els.length);
    if (tiles < 100) fail(`expected >= 100 level tiles, got ${tiles}`);

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

    // 3b) Daily Challenge starts and is deterministic for the day
    const daily = await page.evaluate(() => {
      window.game.startDaily();
      const cells = document.querySelectorAll('#board .cell').length;
      const a = window.SHIKAKU_PUZZLE.dailyGrid(20260101);
      const b = window.SHIKAKU_PUZZLE.dailyGrid(20260101);
      const same = JSON.stringify(a.g) === JSON.stringify(b.g);
      return { cells, deterministic: same };
    });
    if (daily.cells < 4) fail(`daily board has too few cells (${daily.cells})`);
    if (!daily.deterministic) fail('daily puzzle is not deterministic for a given day');
    // return to a quest level so the interactivity step below has a live board
    await page.evaluate(() => { backToMenu(); window.game.startLevel(0, 0); });
    await page.waitForTimeout(300);

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

    if (await page.$eval('#plusBtn', el => !el.classList.contains('hide'))) fail('Plus is shown although it is switched off');

    if (errors.length) fail('runtime errors:\n  ' + errors.join('\n  '));
    if (!process.exitCode) console.log(`SMOKE OK: game boots · ${tiles} levels · board ${board.cells} cells/${board.numbers} clues · draw + battle interactive`);

    await accountChecks(browser, `http://127.0.0.1:${PORT}/`);
  } catch (e) {
    fail(e.message);
  } finally {
    if (browser) await browser.close();
    server.close();
  }
})();
