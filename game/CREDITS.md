# BRUSHSTEEL credits

Made by Kyle Pretorius with AI coding agents (Claude). Art, code and sound were generated and assembled with AI tools under his direction. Made for the OpenGame Game Jam #1 (Fighting track).

All game code in this folder was written during the jam, from 19 Nov 2026. Every outside file, library or asset is listed here with its source, licence and the date it was added.

## AI tools and models

The code, shaders and audio were written by AI coding agents: Anthropic Claude models, run through the Aside agent app. The agents wrote every file in `src/`, the shader code in `src/render/` and the WebAudio sound code in `src/audio/`. No AI image, voice or music service made anything in the game (see "Art, fonts, audio" below).

## Libraries shipped in the game

| What | Version | Source | Licence | Added |
|---|---|---|---|---|
| Three.js | 0.187.0 | https://threejs.org, npm `three` | MIT | 19 Nov 2026 |

## Build tools (not shipped in the game)

| What | Version | Source | Licence | Added |
|---|---|---|---|---|
| Vite | 8.3.8 | https://vite.dev, npm `vite` | MIT | 19 Nov 2026 |
| vite-plugin-singlefile | 2.3.4 | https://github.com/richardtallent/vite-plugin-singlefile | MIT | 19 Nov 2026 |
| TypeScript | 7.0.2 | https://www.typescriptlang.org, npm `typescript` | Apache-2.0 | 19 Nov 2026 |
| @types/three | 0.187.0 | DefinitelyTyped | MIT | 19 Nov 2026 |
| @types/node | 26.6.6 | DefinitelyTyped | MIT | 19 Nov 2026 |

Vite pulls in its own dependencies (rolldown MIT, lightningcss MPL-2.0, postcss MIT and others); see package-lock.json. None of them ship in the game build.

## Algorithms

- Seeded random numbers: mulberry32 (public domain algorithm), written fresh in `src/core/rng.ts`.
- String to seed: FNV-1a hash (public domain algorithm), written fresh.
- Stroke matching: the $1 unistroke recogniser idea (Wobbrock, Wilson and Li, UIST 2007, published algorithm), written fresh in `src/input/strokes.ts`.

## Art, fonts, audio

No outside files. The paper, the ink line and the eight stage landscapes (plus the title and Path map backgrounds) are procedural shaders written for this game (`src/render/landscape.ts`, 20 Nov 2026). Every sound and the music are made in the browser from WebAudio oscillators, filters and generated noise, written for this game in `src/audio/`: no samples, no recordings, no AI voice or music services.

## Art decision

The plan allowed AI-generated backgrounds only if the generating tool's terms plainly allow use in a published game. The image tool available to us (the Aside image generation skill) does not name its model provider or link any terms of use, so we could not check from a primary source that its output may ship in a game. We took the plan's fallback: every background is drawn by our own shader code at run time. No AI-generated images, no image files, no outside art.
