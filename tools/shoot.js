/* Capture real screenshots of the live game with Playwright.
   Cloud is disabled (config route stubbed) so demo runs never touch Supabase.
   Seeds a demo profile so onboarding is skipped and progress looks populated. */
const { chromium } = require('playwright');
const fs = require('fs');

const OUT  = '/home/user/Game1/docs/screenshots';
const SITE = process.env.SHOOT_URL || 'http://127.0.0.1:8191';

const profile = (theme) => ({
  id:'demo-screenshot', username:'NeonNinja', avatar:'🦊',
  theme, accent:null, sound:true, anim:true,
  progress:{'0-0':{score:980,stars:'★★★'},'0-1':{score:870,stars:'★★'},
            '0-2':{score:760,stars:'★★'},'0-3':{score:910,stars:'★★★'},'1-0':{score:840,stars:'★★'}},
  wins:7, losses:3
});

const states = [
  ['menu',     'neon',   null],
  ['sunset',   'sunset', null],
  ['play',     'neon',   'game.startLevel(0,0)'],
  ['settings', 'aurora', 'openSettings()'],
  ['battle',   'neon',   'openBattle()'],
  ['how',      'neon',   "show('how')"],
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  for (const [name, theme, call] of states) {
    const ctx = await browser.newContext({ viewport: { width: 460, height: 1000 }, deviceScaleFactor: 2 });
    await ctx.route('**/js/config.js', r =>
      r.fulfill({ contentType: 'application/javascript',
        body: 'window.SHIKAKU_CONFIG={SUPABASE_URL:"",SUPABASE_ANON_KEY:""};' }));
    const page = await ctx.newPage();
    await page.addInitScript(p => localStorage.setItem('shikaku_profile', JSON.stringify(p)), profile(theme));
    await page.goto(SITE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1100);
    if (call) { await page.evaluate(c => eval(c), call); await page.waitForTimeout(800); }
    await page.screenshot({ path: `${OUT}/${name}.png` });
    await ctx.close();
    console.log('captured', name);
  }
  await browser.close();

  let bad = 0;
  for (const [name] of states) {
    const b = fs.readFileSync(`${OUT}/${name}.png`);
    if (!(b[0] === 0x89 && b[1] === 0x50) || b.length < 8000) { console.error('BAD', name, b.length); bad++; }
  }
  if (bad) process.exit(1);
  console.log('SHOTS_OK');
})().catch(e => { console.error(e); process.exit(1); });
