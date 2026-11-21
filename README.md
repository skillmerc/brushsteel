# BRUSHSTEEL

An ink-brush duel for the browser. Your mouse is the brush: every stroke you draw is a sword cut. Read the faint ink line that shows where your opponent will strike, cut across it to parry, then strike back. Watch your ink, dip the brush to refill it, and win three points before the master does.

Entry for the OpenGame Game Jam #1, Fighting track.

## Play

- Download `play/brushsteel.html` and open it in a desktop browser. It is one self-contained file: no install and no internet needed.
- Drag to cut, drag down for an overhead, click to thrust. A and D (or the arrow keys) step, Shift dashes, hold S to dip your brush for more ink.
- Duel mode: pick one of eight masters. Path mode: a short run up a branching scroll of duels, shrines and ink wells, with 3 lives.
- A controller works too (optional). Full controls: `play/HOW-TO-PLAY.md`.

## Build and test

Needs Node.js 22.

```sh
cd game
npm ci
npm test              # unit tests for the game rules (node --test, no browser)
npm run build         # type check, then build to game/dist/
npm run build:single  # one self-contained file, game/dist-single/index.html
```

The browser checks (first frame, frame rate, resize, screens, a scripted duel) live in `ci/` and run in GitHub Actions: see `.github/workflows/ci.yml`. The quick job runs on every push and pull request; the full job runs on pushes to main and by hand.

## Layout

- `game/` the game: Vite, TypeScript and Three.js. `src/core/` holds the pure rules with unit tests next to them.
- `ci/` the headless browser checks used by the workflow.
- `play/` the playable single-file build and how to play.

## Credits and licence

Made by Kyle Pretorius with AI coding agents (Claude). Art, code and sound were generated and assembled with AI tools under his direction.

Copyright 2026 Kyle Pretorius. All rights reserved. The source is published so the jam judges and players can read it; it is not open source. Terms: `LICENSE`. Third-party code keeps its own licence: `NOTICE`. Outside libraries, tools and how the game was made: `game/CREDITS.md`.

More of my work: skillmerc.com
