# Shikaku: Puzzle Quest

A self-contained HTML5 logic puzzle game. Divide the grid into rectangles so each encloses exactly one number, and the rectangle's area equals that number.

## Play

Open `index.html` in any modern browser. No build step, no dependencies.

Or serve locally:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Features

- Drag-to-draw rectangles, tap-to-clear
- 3 worlds × 5 hand-placed levels
- Live timer, move counter, and clues-remaining HUD
- Scoring with time/accuracy bonuses and star ratings
- Hints, undo, and reset
- Local progress saved via `localStorage`

## Tech

Single static `index.html` — vanilla HTML, CSS, and JavaScript. Works offline and deploys to any static host (GitHub Pages, Netlify, Vercel).

## Roadmap

- Additional worlds
- Sound effects (Web Audio)
- Local same-screen 2-player mode

## License

MIT — see [LICENSE](LICENSE).
