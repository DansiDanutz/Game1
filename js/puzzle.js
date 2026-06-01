/* ============================================================================
   Shikaku puzzles: hand-placed quest levels + a random generator.

   A Shikaku grid is an N×N array of integers; 0 = empty cell, k>0 = a clue
   meaning "the rectangle covering this cell has area k". The generator builds
   a valid rectangle tiling first, then drops one clue per rectangle — so every
   generated board is guaranteed solvable.
   ============================================================================ */

/* DIFFICULTY CURVE — a 108-level curriculum across 12 themed worlds.
   Each level declares a grid `size` and a `tier`. In Shikaku, more solutions =
   easier (any valid tiling wins), so the bank is bucketed by solution count:
     easy   = many solutions (very forgiving)
     medium = 3–5 solutions
     hard   = exactly 2 solutions
     expert = the single unique solution (you must find the exact logic)
   The curriculum ramps from tiny, many-solution boards up to large, unique ones.
   `mult` is the score multiplier for that level (bigger/harder = worth more),
   which — together with per-level time bonus — drives the leaderboard total. */
const TIER_LABEL = { easy:'Easy', medium:'Medium', hard:'Hard', expert:'Expert' };
const TIER_FALLBACK = ['expert','hard','medium','easy']; // hardest available first
const TIER_ORDER = ['easy','medium','hard','expert'];

const WORLD_THEMES = [
  'Zen Garden','Crystal Caves','Sky Citadel','Ember Forge','Tide Pools','Aurora Peaks',
  'Clockwork City','Mirage Dunes','Frost Hollow','Neon Grid','Starfall Reach','Obsidian Throne'
];
// Per-world difficulty profile: [minSize, maxSize, tiers allowed] — ramps up.
const WORLD_PROFILE = [
  [4,4,['easy','easy','medium']],
  [4,5,['easy','medium','medium']],
  [5,5,['medium','medium','hard']],
  [5,6,['medium','hard','hard']],
  [6,6,['medium','hard','expert']],
  [6,7,['hard','hard','expert']],
  [7,7,['hard','expert','expert']],
  [7,8,['hard','expert','expert']],
  [8,8,['hard','expert','expert']],
  [8,9,['expert','hard','expert']],
  [9,9,['hard','expert','expert']],
  [9,9,['expert','expert','expert']],
];
const LEVEL_NAMES = ['Dawn','Drift','Spark','Path','Echo','Vault','Cipher','Lattice','Summit'];

function buildWorlds(){
  const worlds = [];
  for (let w = 0; w < WORLD_PROFILE.length; w++){
    const [lo, hi, tiers] = WORLD_PROFILE[w];
    const levels = [];
    for (let li = 0; li < 9; li++){
      // size ramps within the world; tier ramps across its 9 levels
      const size = lo + Math.round((hi - lo) * (li / 8));
      const tier = tiers[Math.min(tiers.length - 1, Math.floor(li / 3))];
      // multiplier grows with absolute difficulty (size + tier) and world index
      const tierW = TIER_ORDER.indexOf(tier);                 // 0..3
      const mult = +(1 + (size - 4) * 0.45 + tierW * 0.5 + w * 0.12).toFixed(2);
      levels.push({ n: `${LEVEL_NAMES[li]}`, size, tier, mult });
    }
    worlds.push({ name: `World ${w + 1} — ${WORLD_THEMES[w]}`, levels });
  }
  return worlds;
}
const WORLDS = buildWorlds();

/* Pick a fresh random board for a level's size + tier from the bank. Falls back
   to an easier tier of the same size, then to the constructive generator, so a
   level always produces a board even if a bucket is thin. */
function levelGrid(size, tier){
  const bySize = (window.SHIKAKU_LEVELS && window.SHIKAKU_LEVELS[size]) || null;
  if (bySize){
    const order = [tier].concat(TIER_FALLBACK.filter(t => t !== tier));
    for (const t of order){
      const pool = bySize[t];
      if (pool && pool.length){
        const g = pool[Math.floor(Math.random() * pool.length)];
        return g.map(r => r.slice());   // copy so the template is never mutated
      }
    }
  }
  return generatePuzzle(size).g;
}

/* Seedable RNG (mulberry32) so a numeric seed reproduces the same board —
   used to give both multiplayer players an identical puzzle from a shared seed. */
function rng(seed){
  let s = seed >>> 0;
  return function(){
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Generate an N×N Shikaku puzzle. Returns { g, solution }.
   maxArea caps rectangle size (bigger = harder/looser). */
function generatePuzzle(N, seed, maxArea){
  seed = (seed == null) ? (Math.random() * 1e9) | 0 : seed;
  maxArea = maxArea || Math.min(8, N + 2);
  const rand = rng(seed);
  const ri = (n) => Math.floor(rand() * n);

  for (let attempt = 0; attempt < 60; attempt++){
    const owner = Array.from({length:N}, () => Array(N).fill(-1));
    const rects = [];
    let ok = true;

    for (let r = 0; r < N && ok; r++){
      for (let c = 0; c < N; c++){
        if (owner[r][c] !== -1) continue;
        // max height/width available from this top-left corner
        let maxH = 0; while (r + maxH < N && owner[r + maxH][c] === -1) maxH++;
        // choose a height, then the widest width valid for the whole height
        const cand = [];
        for (let h = 1; h <= maxH; h++){
          let w = 0;
          while (c + w < N && h * (w + 1) <= maxArea){
            let free = true;
            for (let rr = r; rr < r + h; rr++) if (owner[rr][c + w] !== -1){ free = false; break; }
            if (!free) break;
            w++;
          }
          for (let ww = 1; ww <= w; ww++) cand.push({h, w: ww});
        }
        if (!cand.length){ ok = false; break; }
        // bias toward larger rectangles a bit for nicer boards
        cand.sort((a, b) => (a.h * a.w) - (b.h * b.w));
        const pick = rand() < 0.55
          ? cand[cand.length - 1 - ri(Math.min(3, cand.length))]
          : cand[ri(cand.length)];
        const id = rects.length;
        for (let rr = r; rr < r + pick.h; rr++)
          for (let cc = c; cc < c + pick.w; cc++) owner[rr][cc] = id;
        rects.push({ r0: r, c0: c, r1: r + pick.h - 1, c1: c + pick.w - 1, area: pick.h * pick.w });
      }
    }
    if (!ok) continue;

    // place one clue (the area) in a random cell of each rectangle
    const g = Array.from({length:N}, () => Array(N).fill(0));
    rects.forEach(rc => {
      const rr = rc.r0 + ri(rc.r1 - rc.r0 + 1);
      const cc = rc.c0 + ri(rc.c1 - rc.c0 + 1);
      g[rr][cc] = rc.area;
    });
    return { g, solution: rects, seed };
  }
  // extremely unlikely fallback: all 1-cells
  const g = Array.from({length:N}, () => Array(N).fill(1));
  return { g, solution: [], seed };
}

/* Deterministic "Daily Challenge" board: everyone gets the SAME puzzle on a
   given calendar day. `dayNum` is YYYYMMDD as an integer. Size rotates 5→7 over
   a 3-day cycle so it stays fresh but fair. Returns { g, size }. */
function dailyGrid(dayNum){
  const seed = ((dayNum >>> 0) || 1) * 2654435761 >>> 0;   // spread the seed
  const size = 5 + (dayNum % 3);                            // 5, 6, or 7
  const maxArea = size + 2;
  return { g: generatePuzzle(size, seed, maxArea).g, size };
}

window.SHIKAKU_PUZZLE = { WORLDS, generatePuzzle, levelGrid, dailyGrid, rng, TIER_LABEL };
