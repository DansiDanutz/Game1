/* Build a tiered Shikaku level bank, bucketed by DIFFICULTY = solution count.

   In Shikaku, any valid tiling wins, so a board with many solutions is easy
   (hard to get wrong) and a board with exactly one solution is hard (you must
   find the precise logic). We bucket boards by how many solutions they have:

     easy    : >= 6 solutions      medium : 3-5 solutions
     hard    : exactly 2           expert : exactly 1 (unique)

   Pipeline: generatePuzzle() makes a random full tiling + one clue per rect
   (always solvable); an exact-cover solver counts solutions up to a small cap;
   the board is filed into the matching bucket. Output: js/levels.js, shaped
     window.SHIKAKU_LEVELS = { "<size>": { easy:[...], medium:[...], hard:[...], expert:[...] } }

   Run: node tools/genbank.js
*/
const fs = require('fs');
global.window = {};
require('../js/puzzle.js');
const { generatePuzzle } = global.window.SHIKAKU_PUZZLE;

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

// Count solutions up to `cap`. Bounded by `maxSteps` so a pathological board
// can't stall generation; returns -1 if the step budget is exceeded.
function countSolutions(g, N, cap, maxSteps = 250000) {
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
  let f = 0, steps = 0, blown = false;
  (function bt() {
    if (blown || f >= cap) return;
    if (++steps > maxSteps) { blown = true; return; }
    const e = fe(); if (!e) { f++; return; }
    const [er, ec] = e;
    for (let i = 0; i < clues.length; i++) {
      if (used[i]) continue;
      for (const rc of cand[i]) if (er >= rc.r0 && er <= rc.r1 && ec >= rc.c0 && ec <= rc.c1 && fits(rc)) {
        used[i] = true; mk(rc, true); bt(); mk(rc, false); used[i] = false;
        if (blown || f >= cap) return;
      }
    }
  })();
  return blown ? -1 : f;
}

function bucketOf(g, N) {
  const c = countSolutions(g, N, 6);
  if (c === -1) return null;          // too expensive — skip
  if (c === 1) return 'expert';
  if (c === 2) return 'hard';
  if (c >= 3 && c <= 5) return 'medium';
  if (c >= 6) return 'easy';
  return null;                        // 0 = unsolvable (shouldn't happen)
}

const key = g => g.map(r => r.join('')).join('|');

// Targets: how many boards we want per (size, tier). Larger / unique boards are
// rarer, so we ask for fewer of them. Only combos the quest uses are generated.
const TARGETS = {
  4: { easy: 14, medium: 10, hard: 8 },
  5: { easy: 14, medium: 12, hard: 8, expert: 6 },
  6: { easy: 12, medium: 12, hard: 8, expert: 6 },
  7: { medium: 8, hard: 8, expert: 6 },
  8: { hard: 6, expert: 5 },
  9: { hard: 5, expert: 4 },
};
const MAXAREA = { 4: 4, 5: 6, 6: 8, 7: 9, 8: 10, 9: 12 };

const bank = {};
let total = 0;

for (const sizeStr of Object.keys(TARGETS)) {
  const N = +sizeStr;
  const want = TARGETS[N];
  const got = {}; const seen = new Set();
  for (const t of Object.keys(want)) got[t] = [];
  const need = () => Object.keys(want).some(t => got[t].length < want[t]);

  let seed = 1; const limit = 4000000;
  while (need() && seed < limit) {
    const { g } = generatePuzzle(N, seed++, MAXAREA[N]);
    const k = key(g);
    if (seen.has(k)) continue;
    const b = bucketOf(g, N);
    if (!b || !(b in want) || got[b].length >= want[b]) continue;
    seen.add(k);
    got[b].push(g);
  }
  bank[N] = got;
  const line = Object.keys(want).map(t => `${t}:${got[t].length}/${want[t]}`).join('  ');
  total += Object.values(got).reduce((a, x) => a + x.length, 0);
  console.log(`N=${N}  ${line}  (seeds up to ${seed})`);
}

if (total < 100) { console.error(`Only ${total} templates — need >= 100`); process.exit(1); }

const TIER_ORDER = ['easy', 'medium', 'hard', 'expert'];
function ser(bank) {
  return Object.entries(bank).map(([N, tiers]) => {
    const inner = TIER_ORDER.filter(t => tiers[t] && tiers[t].length)
      .map(t => `    "${t}": [\n${tiers[t].map(g => '      ' + JSON.stringify(g)).join(',\n')}\n    ]`)
      .join(',\n');
    return `  "${N}": {\n${inner}\n  }`;
  }).join(',\n');
}

const out = `/* ============================================================================
   Shikaku level bank — ${total} puzzles bucketed by difficulty (= solution count).

   AUTO-GENERATED by tools/genbank.js. Do not edit by hand.
   Shape: SHIKAKU_LEVELS["<size>"]["<tier>"] = [ NxN grids ]
   Tiers (Shikaku-specific): easy = many solutions (forgiving) … expert = the
   unique solution (you must find the exact logic). Every board was checked by
   an exact-cover solver. The quest draws a fresh random board of the right
   size + tier on each play, so it's never the same twice.
   ============================================================================ */
window.SHIKAKU_LEVELS = {
${ser(bank)}
};
`;
fs.writeFileSync(__dirname + '/../js/levels.js', out);
console.log(`\nWrote js/levels.js with ${total} templates across tiers.`);
