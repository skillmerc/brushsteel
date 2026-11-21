// Stage looks: pure parameters for the procedural ink-wash landscape
// drawn behind the fighters by render/landscape.ts. No DOM, no three.js.
// One set per stage id in MASTERS, plus one for the title and one for the Path map.
// All heights are stage world units (the fighters stand on y -1.2, the view is
// about -4.5..4.5 high). Everything is monochrome ink except one red accent.

import { MASTERS } from './masters.js';
import { createRng, seedFromString } from './rng.js';

/** What sits on the landscape besides the ridges. Index order is the shader's motif code. */
export const MOTIFS = ['none', 'pines', 'bridge', 'bamboo', 'pond', 'steps', 'reeds', 'cliff', 'moon'] as const;
export type Motif = (typeof MOTIFS)[number];

/** The one red mark: none, a low sun disc, a square seal, or a hanging lantern. */
export const ACCENTS = ['none', 'sun', 'seal', 'lantern'] as const;
export type Accent = (typeof ACCENTS)[number];

export interface Ridge {
  /** Base height of the silhouette, world units. */
  base: number;
  /** Peak height above base, world units. */
  amp: number;
  /** Peaks per world unit (low is broad mountains). */
  freq: number;
  /** Ink density of the layer, 0..1 (far layers are pale). */
  tone: number;
}

export interface StageLook {
  id: string;
  seed: number;
  /** Up to three ridge layers, far to near. */
  ridges: Ridge[];
  motif: Motif;
  accent: Accent;
  /** Accent centre (world) and size (radius or half side, world units). */
  accentAt: [number, number, number];
  /** Rain streaks 0..1. */
  rain: number;
  /** Grey wash darkening the sky from the top, 0..1. */
  sky: number;
  /** Cap on ink density in the fighters' band (ground to +2.4), so figures stay readable. */
  bandCap: number;
}

/** Fighters stand here (input/match.ts GROUND_WORLD_Y). */
export const LANDSCAPE_GROUND = -1.2;
/** Upper edge of the fighters' band. */
export const BAND_TOP = 2.4;
/** Ink density never goes above this anywhere (the figures and HUD must win). */
export const MAX_TONE = 0.55;

interface Base {
  motif: Motif;
  accent: Accent;
  accentAt: [number, number, number];
  rain: number;
  sky: number;
  /** Tones of the far, middle and near ridges. */
  tones: [number, number, number];
  /** Rough height of the ridges. */
  height: number;
  /** Broadness: low is broad. */
  freq: number;
}

const BASES: Record<string, Base> = {
  'pine-mist': { motif: 'pines', accent: 'sun', accentAt: [-4.6, 2.6, 0.55], rain: 0, sky: 0.05, tones: [0.12, 0.2, 0.32], height: 2.4, freq: 0.32 },
  'stone-bridge': { motif: 'bridge', accent: 'seal', accentAt: [6.4, 3.4, 0.22], rain: 0, sky: 0.08, tones: [0.1, 0.18, 0.28], height: 1.8, freq: 0.4 },
  'bamboo-rain': { motif: 'bamboo', accent: 'none', accentAt: [0, 0, 0], rain: 0.8, sky: 0.22, tones: [0.12, 0.18, 0.24], height: 1.4, freq: 0.5 },
  'still-pond': { motif: 'pond', accent: 'sun', accentAt: [3.8, 2.9, 0.45], rain: 0, sky: 0.03, tones: [0.08, 0.16, 0.26], height: 1.6, freq: 0.28 },
  'temple-steps': { motif: 'steps', accent: 'lantern', accentAt: [-5.4, 1.6, 0.2], rain: 0, sky: 0.1, tones: [0.1, 0.2, 0.3], height: 2.2, freq: 0.36 },
  'reed-marsh': { motif: 'reeds', accent: 'seal', accentAt: [-6.4, 3.4, 0.22], rain: 0, sky: 0.06, tones: [0.08, 0.14, 0.22], height: 0.9, freq: 0.22 },
  'storm-cliff': { motif: 'cliff', accent: 'none', accentAt: [0, 0, 0], rain: 1, sky: 0.3, tones: [0.16, 0.26, 0.38], height: 2.8, freq: 0.6 },
  'moon-paper': { motif: 'moon', accent: 'seal', accentAt: [6.4, -3.4, 0.22], rain: 0, sky: 0.3, tones: [0.06, 0.12, 0.2], height: 1.2, freq: 0.3 },
  title: { motif: 'none', accent: 'sun', accentAt: [0, 2.2, 0.7], rain: 0, sky: 0.04, tones: [0.08, 0.15, 0.24], height: 2.0, freq: 0.3 },
  'path-map': { motif: 'pines', accent: 'none', accentAt: [0, 0, 0], rain: 0, sky: 0.02, tones: [0.06, 0.1, 0.14], height: 1.6, freq: 0.34 },
};

/** Every id with a look: the eight stages, then the title and the Path map. */
export const STAGE_LOOK_IDS: readonly string[] = Object.keys(BASES);

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * The look for a stage id. Deterministic: the same id and seed give the same look.
 * The seed only jitters ridge shape; the motif and accent come from the id.
 * Unknown ids get the first master's stage.
 */
export function stageLook(id: string, seed = 1): StageLook {
  const key = BASES[id] ? id : MASTERS[0].stageId;
  const b = BASES[key];
  const rng = createRng((seedFromString(key) ^ Math.imul(seed | 0, 2654435761)) >>> 0);
  const ridges: Ridge[] = b.tones.map((tone, i) => {
    const near = i / 2; // 0 far .. 1 near
    return {
      base: clamp(LANDSCAPE_GROUND + 1.4 - near * 1.1 + (rng.next() - 0.5) * 0.3, -1.2, 1.2),
      amp: clamp(b.height * (1 - near * 0.45) * (0.85 + rng.next() * 0.3), 0.2, 3.2),
      freq: clamp(b.freq * (1 + near * 0.8) * (0.9 + rng.next() * 0.2), 0.1, 1.2),
      tone: clamp(tone, 0, MAX_TONE),
    };
  });
  return {
    id: key,
    seed: Math.floor(rng.next() * 1000) / 1000,
    ridges,
    motif: b.motif,
    accent: b.accent,
    accentAt: [...b.accentAt],
    rain: clamp(b.rain, 0, 1),
    sky: clamp(b.sky, 0, 0.5),
    bandCap: 0.34,
  };
}

/**
 * What the landscape texture shows: the stage look, the view's half extents (world)
 * and the texture size (px). render/landscape.ts paints only when this key changes, so a resize
 * event that lands on the same size, or a stage set again to the same id, never repaints.
 */
export function landscapePaintKey(lookId: string, halfWidth: number, halfHeight: number, pxWidth: number, pxHeight: number): string {
  return `${lookId}|${halfWidth.toFixed(4)}|${halfHeight.toFixed(4)}|${Math.round(pxWidth)}x${Math.round(pxHeight)}`;
}

/** Motif and accent as numbers for the shader. */
export function lookCodes(l: StageLook): { motif: number; accent: number } {
  return { motif: MOTIFS.indexOf(l.motif), accent: ACCENTS.indexOf(l.accent) };
}
