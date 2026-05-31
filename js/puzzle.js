/* ============================================================================
   Shikaku puzzles: hand-placed quest levels + a random generator.

   A Shikaku grid is an N×N array of integers; 0 = empty cell, k>0 = a clue
   meaning "the rectangle covering this cell has area k". The generator builds
   a valid rectangle tiling first, then drops one clue per rectangle — so every
   generated board is guaranteed solvable.
   ============================================================================ */

const WORLDS = [
  {name:"World 1 — Zen Garden", levels:[
    {n:"Zen Garden — First Steps", g:[[2,0,2,0],[0,0,0,0],[3,0,0,3],[0,0,0,0]]},
    {n:"Calm Waters", g:[[0,4,0,2],[0,0,0,0],[2,0,0,0],[0,4,0,2]]},
    {n:"Stone Path", g:[[3,0,0,2],[0,0,3,0],[0,0,0,0],[4,0,0,1]]},
    {n:"Morning Mist", g:[[2,0,2,0,3],[0,0,0,0,0],[2,0,4,0,0],[0,0,0,0,0],[2,0,0,0,2]]},
    {n:"Garden Gate", g:[[5,0,0,0,5],[0,0,0,0,0],[0,3,0,2,0],[0,0,0,0,0],[5,0,0,0,5]]},
  ]},
  {name:"World 2 — Crystal Caves", levels:[
    {n:"First Spark", g:[[0,6,0,0,0],[0,0,0,4,0],[2,0,0,0,0],[0,0,3,0,0],[0,5,0,0,0]]},
    {n:"Geode", g:[[4,0,0,0,2],[0,0,2,0,0],[0,0,0,0,0],[0,0,4,0,0],[3,0,0,0,6]]},
    {n:"Deep Vein", g:[[2,0,3,0,0,4],[0,0,0,0,0,0],[3,0,0,0,0,0],[0,0,0,0,0,3],[0,0,0,0,0,0],[4,0,3,0,2,0]]},
    {n:"Echo Chamber", g:[[0,0,4,0,0,0],[6,0,0,0,2,0],[0,0,0,0,0,0],[0,0,0,0,0,6],[0,2,0,0,0,0],[0,0,0,4,0,0]]},
    {n:"Crystal Heart", g:[[3,0,0,0,0,3],[0,0,4,0,0,0],[0,0,0,0,2,0],[0,3,0,0,0,0],[0,0,0,4,0,0],[3,0,0,0,0,3]]},
  ]},
  {name:"World 3 — Sky Citadel", levels:[
    {n:"Cloud Step", g:[[0,0,6,0,0,0],[5,0,0,0,0,4],[0,0,0,0,0,0],[0,0,0,0,0,0],[3,0,0,0,0,3],[0,0,0,6,0,0]]},
    {n:"Windward", g:[[4,0,0,2,0,0],[0,0,0,0,0,4],[0,3,0,0,0,0],[0,0,0,0,6,0],[2,0,0,0,0,0],[0,0,4,0,0,3]]},
    {n:"High Tower", g:[[0,8,0,0,0,0,2],[0,0,0,0,0,0,0],[3,0,0,0,4,0,0],[0,0,0,0,0,0,0],[0,0,5,0,0,0,3],[0,0,0,0,0,0,0],[4,0,0,0,0,7,0]]},
    {n:"Storm Wall", g:[[6,0,0,0,0,3,0],[0,0,0,0,0,0,0],[0,0,4,0,4,0,0],[0,0,0,0,0,0,0],[0,0,5,0,3,0,0],[0,0,0,0,0,0,0],[0,5,0,0,0,0,7]]},
    {n:"Summit", g:[[4,0,0,0,0,0,4],[0,0,6,0,5,0,0],[0,0,0,0,0,0,0],[0,3,0,0,0,2,0],[0,0,0,0,0,0,0],[0,0,5,0,6,0,0],[3,0,0,0,0,0,4]]},
  ]},
];

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

window.SHIKAKU_PUZZLE = { WORLDS, generatePuzzle, rng };
