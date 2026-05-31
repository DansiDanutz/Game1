/* Generate the PWA app icons by rendering a neon Shikaku mark in headless
   Chromium and screenshotting it at the required sizes. Run: node tools/genicons.js
   Outputs icons/icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png */
const fs = require('fs');
const path = require('path');

// pad = fraction of inner padding (maskable needs a safe zone so the OS can crop)
function html(pad) {
  const inset = Math.round(pad * 100);
  return `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0}
  .wrap{width:512px;height:512px;display:flex;align-items:center;justify-content:center;
    background:radial-gradient(120% 120% at 50% 0%,#141d3a,#070b18 70%)}
  .mark{width:${100-inset*2}%;height:${100-inset*2}%;display:grid;
    grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:7%;
    padding:9%;box-sizing:border-box;border-radius:22%;
    background:linear-gradient(150deg,rgba(57,230,255,.16),rgba(177,75,255,.12));
    box-shadow:inset 0 0 60px rgba(57,230,255,.25),0 0 0 6px rgba(120,150,220,.18)}
  .c{border-radius:16%}
  .c1{background:linear-gradient(135deg,#39e6ff,#37d6ff);box-shadow:0 0 34px rgba(57,230,255,.7)}
  .c2{grid-row:span 2;background:linear-gradient(160deg,#b14bff,#7a3dff);box-shadow:0 0 34px rgba(177,75,255,.6)}
  .c3{background:linear-gradient(135deg,#ffcf4d,#ff9f1c);box-shadow:0 0 34px rgba(255,207,77,.6)}
  </style>
  <div class="wrap"><div class="mark">
    <div class="c c1"></div><div class="c c2"></div><div class="c c3"></div>
  </div></div>`;
}

(async () => {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { console.error('Playwright not installed: npm i -D playwright && npx playwright install chromium'); process.exit(1); }
  const dir = path.join(__dirname, '..', 'icons');
  fs.mkdirSync(dir, { recursive: true });
  const b = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });

  async function shot(file, size, pad) {
    const ctx = await b.newContext({ viewport: { width: 512, height: 512 }, deviceScaleFactor: size / 512 });
    const p = await ctx.newPage();
    await p.setContent(html(pad), { waitUntil: 'networkidle' });
    await p.locator('.wrap').screenshot({ path: path.join(dir, file) });
    await ctx.close();
    console.log('wrote icons/' + file + ' (' + size + 'px)');
  }

  await shot('icon-192.png', 192, 0.06);
  await shot('icon-512.png', 512, 0.06);
  await shot('icon-maskable-512.png', 512, 0.16);  // extra safe-zone padding
  await shot('apple-touch-icon.png', 180, 0.06);
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
