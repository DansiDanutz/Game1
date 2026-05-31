/* Regenerate hand-made levels so every one is guaranteed solvable.
   - Reuses the proven generatePuzzle() from js/puzzle.js (constructive => always
     has a valid full tiling).
   - Verifies each board with an independent backtracking solver.
   - Keeps the original level names, sizes, and per-world difficulty curve.
   - Rewrites the WORLDS literal in js/puzzle.js in place.                       */
const fs = require('fs');
function fail(e){ fs.writeFileSync(__dirname+'/../../err.js','// ERROR\n/*\n'+(e&&e.stack||e)+'\n*/\n'); process.exit(1); }
process.on('uncaughtException', fail);
global.window = {};
require('../js/puzzle.js');
const { generatePuzzle } = global.window.SHIKAKU_PUZZLE;
try {

// independent solver — confirms a board has at least one valid tiling
function solvable(g){
  const N = g.length, clues = [];
  for (let r=0;r<N;r++) for (let c=0;c<N;c++) if (g[r][c]>0) clues.push({r,c,v:g[r][c]});
  if (clues.reduce((a,x)=>a+x.v,0) !== N*N) return false;
  const rects = [];
  for (const cl of clues){
    for (let h=1;h<=cl.v;h++){
      if (cl.v % h) continue; const w = cl.v/h;
      for (let r0=Math.max(0,cl.r-h+1); r0<=cl.r; r0++){ const r1=r0+h-1; if (r1>=N) continue;
        for (let c0=Math.max(0,cl.c-w+1); c0<=cl.c; c0++){ const c1=c0+w-1; if (c1>=N) continue;
          let cnt=0; for (let r=r0;r<=r1;r++) for (let c=c0;c<=c1;c++) if (g[r][c]>0) cnt++;
          if (cnt===1) rects.push({r0,r1,c0,c1});
        }}
    }
  }
  const cover = Array.from({length:N},()=>Array(N).fill(false));
  const fits = rc => { for (let r=rc.r0;r<=rc.r1;r++) for (let c=rc.c0;c<=rc.c1;c++) if (cover[r][c]) return false; return true; };
  const set  = (rc,v) => { for (let r=rc.r0;r<=rc.r1;r++) for (let c=rc.c0;c<=rc.c1;c++) cover[r][c]=v; };
  const first = () => { for (let r=0;r<N;r++) for (let c=0;c<N;c++) if (!cover[r][c]) return [r,c]; return null; };
  function bt(){
    const u = first(); if (!u) return true; const [ur,uc]=u;
    for (const rc of rects) if (ur>=rc.r0&&ur<=rc.r1&&uc>=rc.c0&&uc<=rc.c1&&fits(rc)){ set(rc,true); if (bt()) return true; set(rc,false); }
    return false;
  }
  return bt();
}

// count clues for a "nice" difficulty (avoid boards that are nearly all 1s or one huge block)
function clueCount(g){ let n=0; g.forEach(r=>r.forEach(v=>{if(v>0)n++;})); return n; }

// pick a deterministic seed that yields a solvable, nicely-clued board of size N
function makeBoard(N, maxArea, lo, hi){
  for (let seed=1; seed<5000; seed++){
    const { g } = generatePuzzle(N, seed, maxArea);
    const cc = clueCount(g);
    if (cc>=lo && cc<=hi && solvable(g)) return g;
  }
  // fallback: any solvable board
  for (let seed=1; seed<5000; seed++){ const { g } = generatePuzzle(N, seed, maxArea); if (solvable(g)) return g; }
  throw new Error('no board for N='+N);
}

// name + size + difficulty plan (mirrors the original progression)
const PLAN = [
  { name:"World 1 — Zen Garden", maxArea:4, levels:[
    ["Zen Garden — First Steps",4],["Calm Waters",4],["Stone Path",4],["Morning Mist",5],["Garden Gate",5] ]},
  { name:"World 2 — Crystal Caves", maxArea:6, levels:[
    ["First Spark",5],["Geode",5],["Deep Vein",6],["Echo Chamber",6],["Crystal Heart",6] ]},
  { name:"World 3 — Sky Citadel", maxArea:9, levels:[
    ["Cloud Step",6],["Windward",6],["High Tower",7],["Storm Wall",7],["Summit",7] ]},
];

const worlds = PLAN.map((w,wi)=>({
  name: w.name,
  levels: w.levels.map(([n,N],li)=>{
    const lo = Math.max(3, Math.round(N*0.9));      // a healthy number of clues
    const hi = Math.round(N*1.8);
    const g = makeBoard(N, w.maxArea, lo, hi);
    if (!solvable(g)) throw new Error('unsolvable '+n);
    return { n, g };
  })
}));

// serialize compactly: one level per line
function ser(worlds){
  const wl = worlds.map(w=>{
    const lv = w.levels.map(l=>`    {n:${JSON.stringify(l.n)}, g:${JSON.stringify(l.g)}},`).join('\n');
    return `  {name:${JSON.stringify(w.name)}, levels:[\n${lv}\n  ]},`;
  }).join('\n');
  return `const WORLDS = [\n${wl}\n];`;
}

const path = __dirname + '/../js/puzzle.js';
const src = fs.readFileSync(path,'utf8');
const head = src.slice(0, src.indexOf('const WORLDS'));
const tailIdx = src.indexOf('/* Seedable RNG');
const tail = src.slice(tailIdx);
fs.writeFileSync(path, head + ser(worlds) + '\n\n' + tail);

// report
const report = worlds.flatMap((w,wi)=>w.levels.map((l,li)=>{
  const N=l.g.length, sum=l.g.flat().reduce((a,v)=>a+(v>0?v:0),0);
  return `W${wi+1}L${li+1} ${l.n} N=${N} clueSum=${sum}/${N*N} clues=${clueCount(l.g)} solvable=${solvable(l.g)}`;
})).join('\n');
fs.writeFileSync(__dirname+'/genreport.txt', report+'\n');
fs.writeFileSync(__dirname+'/genstatus.js','// OK regenerated '+worlds.flatMap(w=>w.levels).length+' levels\n');
} catch(e){ fail(e); }
