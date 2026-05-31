# Shikaku: Puzzle Quest

A self-contained HTML5 logic puzzle game — now with **personalization**, **real-time
1v1 battles**, **cloud leaderboards**, and an **endless puzzle generator**.

Divide the grid into rectangles so each encloses exactly one number, and the
rectangle's area equals that number.

## Play

Open `index.html` in any modern browser. No build step, no bundler.

Or serve locally (recommended, so the module scripts load cleanly):

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

The game is **fully playable offline** out of the box. Cloud features
(profiles sync, leaderboards, online battles) light up once you add a Supabase
anon key — see [Cloud setup](#cloud-setup-supabase).

## Features

### Core
- Drag-to-draw rectangles, tap-to-clear
- 3 worlds × 5 hand-placed levels
- ♾️ **Endless mode** — an unlimited supply of randomly generated, always-solvable boards
- Live timer, move counter, and clues-remaining HUD
- Scoring with time/accuracy bonuses and star ratings
- Hints, undo, and reset

### Personalization
- 👤 **Player profile** — choose a display name and avatar
- 🎨 **Theme switcher** — Neon, Aurora, Sunset, Mono, Matrix, Daylight, plus a **custom accent color** picker
- ⚙️ **Settings panel** — toggle sound effects & animations, edit profile, reset progress
- Everything is saved locally and synced to the cloud when configured

### Cloud (Supabase)
- ☁️ **Cloud progress** — your best scores follow you across devices
- 🏆 **Leaderboards** — global Quest-score and Battle-wins rankings
- ⚔️ **Battle Arena** — real-time 1v1 races on an identical board. Create a room,
  share the 4-letter code, and the first to tile the grid wins. Live opponent
  progress bar included.

## Cloud setup (Supabase)

1. Open the Supabase SQL Editor for your project and run [`schema.sql`](schema.sql).
   It creates the `profiles` and `scores` tables with permissive
   (username-only) RLS policies. Multiplayer uses ephemeral Realtime broadcast
   channels and needs no extra setup.
2. Copy your **anon public** key from
   *Project Settings → API → Project API keys → anon public*.
3. Paste it into [`js/config.js`](js/config.js):

   ```js
   window.SHIKAKU_CONFIG = {
     SUPABASE_URL: "https://lxhjfdxowpxzrybxdasi.supabase.co",
     SUPABASE_ANON_KEY: "PASTE_YOUR_ANON_KEY_HERE"
   };
   ```

The anon key is safe to ship in client code — access is limited by the RLS
policies in `schema.sql`. There are no passwords; players are identified by a
device-generated UUID, so this is intended for a casual, public leaderboard.

## Project layout

```
index.html        UI / screens / modals
css/styles.css    styling + themes
js/config.js      Supabase URL + anon key  (edit me)
js/cloud.js       Supabase wrapper (degrades to no-op when offline)
js/puzzle.js      hand-placed levels + random puzzle generator
js/app.js         game, profile, themes, settings, leaderboard, battle
schema.sql        Supabase tables + RLS policies
```

## Tech

Vanilla HTML, CSS, and JavaScript. Cloud via the
[`@supabase/supabase-js`](https://github.com/supabase/supabase-js) CDN bundle.
Deploys to any static host (GitHub Pages, Netlify, Vercel).

## License

MIT — see [LICENSE](LICENSE).
