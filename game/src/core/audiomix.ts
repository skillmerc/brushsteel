// Audio rules: the pure part of the sound. Which duel event plays which sound and how
// loud, how tense the fight is, how loud each music layer is at that tension, and the volume
// curve. No WebAudio here, so node tests cover it; src/audio/ turns these numbers into sound.

import type { DuelEvent } from './duel.js';

export type Cue = 'swish' | 'clash' | 'parry' | 'guard' | 'splatter' | 'step' | 'dash' | 'dip' | 'dry' | 'seal' | 'win' | 'lose';

/** One sound to play: gain 0 to 1 (before master volume) and a pitch rate (1 = base pitch). */
export interface CueSpec {
  cue: Cue;
  gain: number;
  rate: number;
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

/**
 * Stroke speed 0 to 1 from a strike's path length (stage units) and its windup (ms).
 * A quick long cut is fast; a slow, held overhead is slow. 0.1 units per ms or more is full speed.
 */
export function strokeSpeed(length: number, windupMs: number): number {
  if (!Number.isFinite(length) || !Number.isFinite(windupMs) || windupMs <= 0) return 0.5;
  return clamp01(length / windupMs / 0.02);
}

/** Brush swish: louder and higher with speed. The foe's stroke sits a little lower and quieter. */
export function swishSpec(speed: number, who: 0 | 1): CueSpec {
  const s = clamp01(speed);
  return { cue: 'swish', gain: (0.35 + 0.55 * s) * (who === 0 ? 1 : 0.8), rate: (0.7 + 0.8 * s) * (who === 0 ? 1 : 0.9) };
}

export interface CueContext {
  /** Strike speed for this tick's strike events, 0 to 1, by fighter. */
  speed?: [number, number];
  /** Hits needed to win (DUEL_RULES.HITS_TO_WIN). */
  hitsToWin?: number;
}

/** The sounds for one duel event. Events with no sound give an empty list. */
export function cuesForEvent(e: DuelEvent, ctx: CueContext = {}): CueSpec[] {
  switch (e.type) {
    case 'strike':
      return [swishSpec(ctx.speed ? ctx.speed[e.who] : 0.6, e.who)];
    case 'feint':
      return [{ ...swishSpec(0.3, e.who), gain: 0.25 }];
    case 'clash':
      return [{ cue: 'clash', gain: 0.9, rate: 1 }];
    case 'parry':
      return [{ cue: 'parry', gain: 0.85, rate: e.who === 0 ? 1.1 : 0.95 }];
    case 'guard':
    case 'blocked':
      return [{ cue: 'guard', gain: 0.5, rate: 1 }];
    case 'hit': {
      // The deciding hit is the heaviest: lower and louder.
      const win = ctx.hitsToWin ?? 3;
      const final = e.score[e.who] >= win;
      return [{ cue: 'splatter', gain: final ? 1 : 0.8, rate: final ? 0.75 : 1 }];
    }
    case 'dip-start':
      return [{ cue: 'dip', gain: 0.6, rate: e.who === 0 ? 1 : 0.85 }];
    case 'dry':
      return [{ cue: 'dry', gain: 0.4, rate: 1 }];
    default:
      return [];
  }
}

/**
 * Footsteps on wood: a step or a dash starts when moveTicks goes from 0 to more than 0. The move
 * is a dash when its whole distance (dx per tick times ticks) reaches dashFrom (stage units).
 */
export function moveCue(prevTicks: number, ticks: number, dx: number, dashFrom: number, who: 0 | 1): CueSpec | null {
  if (!(prevTicks <= 0 && ticks > 0)) return null;
  const dash = Math.abs(dx) * ticks >= dashFrom;
  return { cue: dash ? 'dash' : 'step', gain: (dash ? 0.6 : 0.4) * (who === 0 ? 1 : 0.75), rate: who === 0 ? 1 : 0.9 };
}

/**
 * How tense the fight is, 0 to 1. Rises with hits landed (each side's progress to the win), with
 * low ink on both brushes, and is full on the final stroke (both one hit from winning).
 * 0 when the duel is over.
 */
export function tensionOf(score: readonly [number, number], hitsToWin: number, ink: readonly [number, number], over: boolean): number {
  if (over) return 0;
  const need = Math.max(1, hitsToWin - 1);
  if (hitsToWin > 1 && score[0] >= hitsToWin - 1 && score[1] >= hitsToWin - 1) return 1;
  const progress = (Math.min(need, score[0]) + Math.min(need, score[1])) / (2 * need);
  const lead = Math.max(score[0], score[1]) / need;
  const lowInk = 1 - Math.min(clamp01(ink[0] / 100), clamp01(ink[1] / 100));
  return clamp01(0.15 + 0.4 * progress + 0.2 * lead + 0.25 * lowInk * lowInk);
}

export interface LayerGains {
  drums: number;
  flute: number;
  wind: number;
}

/** Music layers by tension: wind always under, the flute comes in early, drums only as it heats. */
export function layerGains(tension: number): LayerGains {
  const t = clamp01(tension);
  return {
    wind: 0.35 + 0.15 * (1 - t),
    flute: clamp01((t - 0.1) / 0.5) * 0.45,
    drums: clamp01((t - 0.35) / 0.65) * 0.7,
  };
}

/** Settings volume 0 to 100 to a gain 0 to 1. Squared, so the slider feels even to the ear. */
export function volumeGain(volume: number): number {
  const v = clamp01(volume / 100);
  return v * v;
}
