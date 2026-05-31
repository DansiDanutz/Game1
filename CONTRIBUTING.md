# Contributing to Shikaku: Puzzle Quest

Thanks for your interest! This is a deliberately simple, dependency-free project.

## Principles

- **No build step, no framework.** Vanilla HTML / CSS / JS only.
- **Match the surrounding style.** Compact, readable, commented where it earns it.
- **Offline-first.** Every feature degrades gracefully when Supabase isn't configured.

## Local development

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

## Before you open a PR

CI runs these — please run them locally too:

```bash
# 1. JavaScript must parse
for f in js/*.js; do node --check "$f"; done

# 2. Every level must be solvable (clue sum == cell count)
node -e 'global.window={};require("./js/puzzle.js");
  const {WORLDS}=window.SHIKAKU_PUZZLE; let n=0;
  WORLDS.forEach((w,wi)=>w.levels.forEach((l,li)=>{n++;const N=l.g.length;let s=0;
    l.g.forEach(r=>r.forEach(v=>{if(v>0)s+=v}));
    if(s!==N*N)throw new Error("unsolvable W"+(wi+1)+"L"+(li+1));}));
  console.log(n+" levels OK");'
```

### Adding levels

Levels live in `js/puzzle.js` under `WORLDS`. A level is an N×N grid where `0` is
empty and a positive number is a clue. **The clues must sum to N×N** and a valid
tiling must exist. `tools/genlevels.js` can generate guaranteed-solvable boards.

### Regenerating screenshots

`tools/shoot.js` uses Playwright to capture the README screenshots from a running
build. Install Playwright (`npm i playwright && npx playwright install chromium`)
and run `node tools/shoot.js`.
