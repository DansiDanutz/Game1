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

# 2. Every level solvable + generator healthy
node tools/ci-check.js

# 3. Browser smoke test — the game actually boots and is interactive.
#    Catches cross-file failures node --check can't see (e.g. a duplicate
#    top-level identifier that silently aborts app.js).
npm i -D playwright && npx playwright install chromium   # one-time
node tools/smoke.js
```

### Levels & the puzzle bank

Quest levels in `js/puzzle.js` (`WORLDS`) declare only a grid **`size`**; the
actual board is drawn at play time from `js/levels.js`, a bank of 100+ puzzles
with **verified unique solutions**. To regenerate / grow the bank:

```bash
node tools/genbank.js      # rewrites js/levels.js, then run ci-check
node tools/ci-check.js
```

`tools/genbank.js` builds random boards, keeps only those an exact-cover solver
proves have exactly one solution, dedupes them, and emits `js/levels.js`.

### Regenerating screenshots

`tools/shoot.js` uses Playwright to capture the README screenshots from a running
build. Install Playwright (`npm i playwright && npx playwright install chromium`)
and run `node tools/shoot.js`.
