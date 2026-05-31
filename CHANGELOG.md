# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [2.0.0] — 2026-05-31

The big personalization + multiplayer release.

### Added
- **Player profiles** — display name + avatar, synced to Supabase.
- **Theme switcher** — Neon, Aurora, Sunset, Mono, Matrix, Daylight + custom accent color.
- **Settings panel** — sound effects, animations, profile editing, reset progress.
- **Cloud progress & leaderboards** — global Quest-score and Battle-wins rankings (Supabase + RLS).
- **Battle Arena** — real-time 1v1 races via Supabase Realtime broadcast, 4-letter room codes, live opponent progress, disconnect detection, join timeout.
- **Endless mode** — unlimited, guaranteed-solvable generated boards.
- **Visual overhaul** — neon glass UI, animated aurora background, starfield canvas, gradient-sheen logo, victory confetti, tactile micro-interactions.
- Modular file split; `schema.sql`, CI, issue/PR templates, screenshots.

### Fixed
- **Unsolvable levels** — regenerated all 15 hand-made levels so every clue set sums to the cell count and a valid tiling exists (14 of 15 original levels were uncompletable).
- **Leaderboard XSS** — escape player avatar rendered via `innerHTML`.
- **Double-counted battle stats** in the cloud.
- Exposed `game`/`battle` to inline handlers; stabilized starfield colors.

## [1.0.0]

- Initial Shikaku: Puzzle Quest — single-file game, 3 worlds × 5 levels, scoring, hints, `localStorage` progress.
