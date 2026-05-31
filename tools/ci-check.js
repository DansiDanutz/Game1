/* CI validation — run by .github/workflows/ci.yml and locally before pushing.
   Verifies:
     1. every quest level declares a valid grid size,
     2. the level bank (js/levels.js) has >= 100 templates,
     3. EVERY bank template has exactly one solution (verified by solver),
     4. levelGrid() returns a board of the requested size,
     5. the constructive generator is healthy (battle / endless).
   Exits non-zero with a clear message on any problem. */
global.window = {};
require('../js/levels.js');
require('../js/puzzle.js');
const { WORLDS, generatePuzzle, levelGrid } = global.window.SHIKAKU_PUZZLE;
const BANK = global.window.SHIKAKU_LEVELS;

/* --- exact-cover solution counter (cap at 2 → "is it unique?") --- */
function candidatesFor(g, N, cr, cc, val) {
  const out = [];
  for (let h = 1; h <= val; h++) {
    if (val % h) continue;
    const w = val / h;
    if (h > N || w > N) continue;
    for (let r0 = Math.max(0, cr - h + 1); r0 <= cr && r0 + h <= N; r0++)
      for (let c0 = Math.max(0, cc - w + 1); c0 <= cc && c0 + w <= N; c0++) {
        const r1 = r0 + h - 1, c1 = c0 + w - 1;
        let cl = 0;
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (g[r][c] > 0) cl++;
        if (cl === 1) out.push({ r0, c0, r1, c1 });
      }
  }
  return out;
}
function countSolutions(g, N, cap) {
  const clues = [];
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (g[r][c] > 0) clues.push({ r, c, v: g[r][c] });
  if (clues.reduce((a, x) => a + x.v, 0) !== N * N) return 0;
  const cand = clues.map(cl => candidatesFor(g, N, cl.r, cl.c, cl.v));
  if (cand.some(l => !l.length)) return 0;
  const cov = Array.from({ length: N }, () => Array(N).fill(false));
  const used = new Array(clues.length).fill(false);
  const fits = rc => { for (let r = rc.r0; r <= rc.r1; r++) for (let c = rc.c0; c <= rc.c1; c++) if (cov[r][c]) return false; return true; };
  const mk = (rc, v) => { for (let r = rc.r0; r <= rc.r1; r++) for (let c = rc.c0; c <= rc.c1; c++) cov[r][c] = v; };
  const fe = () => { for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (!cov[r][c]) return [r, c]; return null; };
  let f = 0;
  (function bt() {
    if (f >= cap) return;
    const e = fe(); if (!e) { f++; return; }
    const [er, ec] = e;
    for (let i = 0; i < clues.length; i++) {
      if (used[i]) continue;
      for (const rc of cand[i]) if (er >= rc.r0 && er <= rc.r1 && ec >= rc.c0 && ec <= rc.c1 && fits(rc)) {
        used[i] = true; mk(rc, true); bt(); mk(rc, false); used[i] = false; if (f >= cap) return;
      }
    }
  })();
  return f;
}

/* 1. levels declare valid sizes */
let n = 0;
WORLDS.forEach((w, wi) => w.levels.forEach((l, li) => {
  n++;
  if (!Number.isInteger(l.size) || l.size < 3 || l.size > 10)
    throw new Error('bad size at W' + (wi + 1) + 'L' + (li + 1) + ': ' + l.size);
  if (!BANK[l.size] || !BANK[l.size].length)
    throw new Error('no bank templates for size ' + l.size + ' (W' + (wi + 1) + 'L' + (li + 1) + ')');
}));
if (n !== 15) throw new Error('expected 15 levels, found ' + n);

/* 2 + 3. bank size & uniqueness */
let total = 0, seen = new Set();
for (const size of Object.keys(BANK)) {
  const N = +size;
  BANK[size].forEach((g, i) => {
    total++;
    if (!g.every(r => r.length === N)) throw new Error('non-square template size ' + N + ' #' + i);
    const k = g.map(r => r.join('')).join('|');
    if (seen.has(k)) throw new Error('duplicate template size ' + N + ' #' + i);
    seen.add(k);
    const sols = countSolutions(g, N, 2);
    if (sols !== 1) throw new Error('template size ' + N + ' #' + i + ' has ' + sols + ' solutions (want exactly 1)');
  });
}
if (total < 100) throw new Error('level bank has only ' + total + ' templates, need >= 100');

/* 4. levelGrid returns correct size */
[4, 5, 6, 7].forEach(s => {
  const g = levelGrid(s);
  if (g.length !== s || !g.every(r => r.length === s)) throw new Error('levelGrid(' + s + ') wrong size');
});

/* 5. generator health */
for (const N of [6, 8, 10]) {
  const { solution } = generatePuzzle(N);
  const area = solution.reduce((a, r) => a + (r.r1 - r.r0 + 1) * (r.c1 - r.c0 + 1), 0);
  if (area !== N * N) throw new Error('generator failed for N=' + N);
}

console.log('OK: ' + n + ' levels, ' + total + ' unique-solution templates verified, generator healthy');
