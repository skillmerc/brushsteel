// The eight masters: each a school with its own tell, as data.
// Pure TypeScript: no DOM. The AI numbers of each master are an AiStyle
// (ai.ts); master 1 is STYLES.patient itself, so the default game is unchanged.
//
// Win-rate bands for both reference players are in masters.test.ts.
// Re-run `npm test` after any tuning change: the
// bands must fall from master 1 to master 8.

import { STYLES, type AiStyle } from './ai.js';
import type { AttackKind } from './duel.js';

/**
 * Fading ink (master 8): part of the telegraph line fades away.
 *
 * What "shows" means for a line in fading ink: the solid part, from the striker's end of the line to
 * `solidTo` of its length, is drawn at full opacity for the whole windup,
 * like any other master's line. Only the outer part, from `solidTo` to the
 * tip, fades from full opacity to nothing over `fadeMs` after the line
 * appears. `solidTo` is above 0.5, so the solid part always holds the middle
 * of the line, where a cut across it parries. The 350 ms floor
 * (REAL_LINE_FLOOR_MS) counts the solid part: it shows for the whole windup.
 */
export interface FadingInk {
  /** Fraction of the line, from the striker's end, that stays solid. Above 0.5. */
  solidTo: number;
  /** Ms after the line appears over which the outer part fades to nothing. */
  fadeMs: number;
}

export interface Master {
  /** 1 to 8, the order of the ladder (hardest last). */
  index: number;
  /** Personal name. */
  name: string;
  /** Epithet; the HUD shows "Master <index>, <title>". */
  title: string;
  /** School the master fights in. */
  school: string;
  /** The tell in a few words, what a tester should be able to name. */
  tell: string;
  /** Stage (background) id, one per master. */
  stageId: string;
  /** Stroke set, windups, feint rate and drop time, footwork and ink habits: the AI numbers. */
  style: AiStyle;
  /** Footwork in words (the numbers are style.holdGap and style.pressMinMs/pressMaxMs). */
  footwork: string;
  /** Ink habits in words (the number is style.dipBelow). */
  inkHabit: string;
  /** Present only on the master whose telegraph fades. */
  fadingInk?: FadingInk;
}

const NO_FEINT = { feintChance: 0, feintDropMs: 0, feintStrikeMs: 0 };

export const MASTERS: readonly Master[] = [
  {
    index: 1,
    name: 'Oro',
    title: 'the patient',
    school: 'Still Water',
    tell: 'slow thick lines; cuts yours if you swing first',
    stageId: 'pine-mist',
    style: STYLES.patient,
    footwork: 'holds a gap of 2.2, presses in after 7 to 13 quiet seconds',
    inkHabit: 'dips early, under 30 ink',
  },
  {
    index: 2,
    name: 'Gan',
    title: 'the heavy',
    school: 'Falling Stone',
    tell: 'big slow overheads from close in',
    stageId: 'stone-bridge',
    style: {
      name: 'heavy',
      windupMs: 800,
      windupJitterMs: 150,
      reactionMs: 75,
      parryChance: 0.6,
      holdGap: 1.9,
      pressMinMs: 6000,
      pressMaxMs: 11000,
      ...NO_FEINT,
      dipBelow: 20,
      kinds: { cut: 0, overhead: 3, rising: 1, thrust: 0 },
    },
    footwork: 'stands close (gap 1.9), presses in after 6 to 11 s',
    inkHabit: 'dips under 20 ink',
  },
  {
    index: 3,
    name: 'Hayo',
    title: 'the swift',
    school: 'Swallow',
    tell: 'quick cuts and thrusts',
    stageId: 'bamboo-rain',
    style: {
      name: 'swift',
      windupMs: 480,
      windupJitterMs: 150,
      reactionMs: 75,
      parryChance: 0.85,
      holdGap: 2.0,
      pressMinMs: 6000,
      pressMaxMs: 11000,
      ...NO_FEINT,
      dipBelow: 20,
      kinds: { cut: 3, overhead: 0, rising: 2, thrust: 1 },
    },
    footwork: 'stands close (gap 2.0), presses in after 6 to 11 s',
    inkHabit: 'dips under 20 ink',
  },
  {
    index: 4,
    name: 'Kagami',
    title: 'the mirror',
    school: 'Still Pond',
    tell: 'answers with the stroke you last drew',
    stageId: 'still-pond',
    style: {
      name: 'mirror',
      windupMs: 420,
      windupJitterMs: 150,
      reactionMs: 75,
      parryChance: 0.95,
      holdGap: 2.0,
      pressMinMs: 6000,
      pressMaxMs: 11000,
      ...NO_FEINT,
      dipBelow: 20,
      kinds: { cut: 2, overhead: 1, rising: 1, thrust: 1 },
      mirror: 0.8,
    },
    footwork: 'stands close (gap 2.0), presses in after 6 to 11 s',
    inkHabit: 'dips under 20 ink',
  },
  {
    index: 5,
    name: 'Sen',
    title: 'the switch',
    school: 'Two Rivers',
    tell: 'shows one stroke, drops it, strikes another kind from another distance',
    stageId: 'temple-steps',
    style: {
      name: 'switch',
      windupMs: 600,
      windupJitterMs: 150,
      reactionMs: 75,
      parryChance: 0.6,
      holdGap: 2.0,
      pressMinMs: 6000,
      pressMaxMs: 11000,
      feintChance: 0.7,
      feintDropMs: 450,
      feintStrikeMs: 350,
      feintFollow: 'other',
      dipBelow: 15,
      kinds: { cut: 2, overhead: 2, rising: 1, thrust: 2 },
    },
    footwork: "stands close (gap 2.0); after a feint steps to the real stroke's own distance",
    inkHabit: 'fights its ink low, dips under 15',
  },
  {
    index: 6,
    name: 'Ura',
    title: 'the feinter',
    school: 'Hidden Hand',
    tell: 'every first line is fake; the real one is short',
    stageId: 'reed-marsh',
    style: { ...STYLES.feinter, name: 'feinter (close)', holdGap: 2.0, parryChance: 0.6 },
    footwork: 'stands close (gap 2.0), presses in after 6 to 11 s',
    inkHabit: 'fights its ink low, dips under 15',
  },
  {
    index: 7,
    name: 'Arashi',
    title: 'the storm',
    school: 'Storm',
    tell: 'short fast lines; parries nearly every cut',
    stageId: 'storm-cliff',
    style: {
      name: 'storm',
      windupMs: 350,
      windupJitterMs: 50,
      reactionMs: 67,
      parryChance: 0.85,
      holdGap: 2.0,
      pressMinMs: 7000,
      pressMaxMs: 12000,
      ...NO_FEINT,
      dipBelow: 10,
      kinds: { cut: 2, overhead: 1, rising: 1, thrust: 2 },
    },
    footwork: 'stands close (gap 2.0), presses in after 7 to 12 s',
    inkHabit: 'runs nearly dry, dips under 10',
  },
  {
    index: 8,
    name: 'Kesu',
    title: 'the fading ink',
    school: 'Vanishing Ink',
    tell: 'the far end of its line fades away',
    stageId: 'moon-paper',
    style: {
      name: 'fading ink',
      windupMs: 350,
      windupJitterMs: 50,
      reactionMs: 67,
      parryChance: 1,
      holdGap: 2.0,
      pressMinMs: 7000,
      pressMaxMs: 12000,
      feintChance: 0.5,
      feintDropMs: 250,
      feintStrikeMs: 350,
      feintFollow: 'other',
      dipBelow: 10,
      kinds: { cut: 1, overhead: 1, rising: 1, thrust: 2 },
    },
    footwork: 'stands close (gap 2.0), presses in after 7 to 12 s; after a feint steps to the real stroke\'s own distance',
    inkHabit: 'runs nearly dry, dips under 10',
    fadingInk: { solidTo: 0.6, fadeMs: 200 },
  },
];

/** The HUD name: "Master 1, the patient". */
export function masterLabel(m: Pick<Master, 'index' | 'title'>): string {
  return `Master ${m.index}, ${m.title}`;
}

/** Master by its ladder number (1 to 8); master 1 for anything else. */
export function masterByIndex(n: number): Master {
  return MASTERS.find((m) => m.index === n) ?? MASTERS[0];
}

/** How a telegraph line is drawn at a moment of its windup. */
export interface TelegraphInk {
  /** The line is drawn solid (full opacity) from its start (the striker's end) to this fraction. */
  solidTo: number;
  /** Opacity of the rest of the line, from solidTo to the tip, 0..1. */
  tipAlpha: number;
}

/** The telegraph's ink `msShown` ms after the line appeared. Every master but the fading one: the whole line, solid. */
export function telegraphInk(m: Pick<Master, 'fadingInk'>, msShown: number): TelegraphInk {
  const f = m.fadingInk;
  if (!f) return { solidTo: 1, tipAlpha: 1 };
  return { solidTo: f.solidTo, tipAlpha: Math.max(0, 1 - Math.max(0, msShown) / f.fadeMs) };
}

/** The kinds a master uses (stroke set). */
export function strokeSet(m: Pick<Master, 'style'>): AttackKind[] {
  return (['cut', 'overhead', 'rising', 'thrust'] as AttackKind[]).filter((k) => m.style.kinds[k] > 0);
}
