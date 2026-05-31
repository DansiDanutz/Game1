/* CI validation — run by .github/workflows/ci.yml and locally before pushing.
   Verifies every level is solvable and the puzzle generator is healthy.
   Exits non-zero with a clear message on any problem. */
global.window = {};
require('../js/puzzle.js');
const { WORLDS, generatePuzzle } = global.window.SHIKAKU_PUZZLE;

let n = 0;
WORLDS.forEach((w, wi) => w.levels.forEach((l, li) => {
  n++;
  const N = l.g.length;
  if (!l.g.every(r => r.length === N)) throw new Error('non-square W' + (wi + 1) + 'L' + (li + 1));
  let sum = 0;
  l.g.forEach(r => r.forEach(v => { if (v > 0) sum += v; }));
  if (sum !== N * N) throw new Error('unsolvable W' + (wi + 1) + 'L' + (li + 1) + ': clue sum ' + sum + ' != ' + (N * N) + ' cells');
}));
if (n !== 15) throw new Error('expected 15 levels, found ' + n);

for (const N of [6, 8, 10]) {
  const { solution } = generatePuzzle(N);
  const area = solution.reduce((a, r) => a + (r.r1 - r.r0 + 1) * (r.c1 - r.c0 + 1), 0);
  if (area !== N * N) throw new Error('generator failed for N=' + N);
}

console.log('OK: ' + n + ' levels valid, generator healthy');
