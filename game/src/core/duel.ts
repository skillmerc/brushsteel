// Duel rules core. Pure TypeScript: no DOM, no Three.js.
//
// A fixed-step simulation at 60 Hz. Two fighters stand on a 16 x 9 stage
// (x from -8 to 8, the same units as fit.ts). Each tick takes at most one
// action per fighter and moves the duel forward by one step. Same seed and
// same actions give the same state on every machine.
//
// API (for the opponent AI and the core loop):
//
//   const duel = createDuel(seed, { rules? })
//   const events = stepDuel(duel, [actionForFighter0, actionForFighter1])
//   duel.state   plain data, safe to JSON.stringify (no functions, no rng)
//
// Strokes come from the classifier in src/input/strokes.ts. Convert its
// points to stage units with the fitStage camera,
// its length by 80 * scale, and speed (px per ms) with strokeSpeedToStage().
// Both fighters' segments must be in that one frame. The core cannot import src/input (the core test
// build has rootDir src/core), so StrokeKind is mirrored here and a test
// checks the two lists stay the same.
//
// Every number is in DUEL_RULES below.

import { FEEL } from './feel.js';
import { createRng, type Rng } from './rng.js';

/** Same list as StrokeKind in src/input/strokes.ts (a test keeps them equal). */
export type DuelStrokeKind = 'cut' | 'overhead' | 'rising' | 'thrust' | 'parry' | 'none';
export const DUEL_STROKE_KINDS: readonly DuelStrokeKind[] = ['cut', 'overhead', 'rising', 'thrust', 'parry', 'none'];

/** Stroke kinds that make an attack. */
export type AttackKind = 'cut' | 'overhead' | 'rising' | 'thrust';

export interface Vec2 {
  x: number;
  y: number;
}

/** A straight line on the stage, start a to end b. */
export interface Segment {
  a: Vec2;
  b: Vec2;
}

export type MoveDir = 'in' | 'out';

export type DuelAction =
  | { type: 'step'; dir: MoveDir }
  | { type: 'dash'; dir: MoveDir }
  | { type: 'dip' }
  /** Drop this fighter's own pending strike before it lands (a feint). Ink already spent is lost; FEINT_RECOVER_MS of recovery follows. Does nothing with no strike pending or while stunned. */
  | { type: 'feint' }
  | {
      type: 'stroke';
      kind: DuelStrokeKind;
      /** Stage units per second (strokeSpeedToStage turns classifier px/ms into this). */
      speed: number;
      /** Start to end of the drawn stroke, in stage units. Used for the parry test. */
      segment: Segment;
      /** Path length in stage units. Defaults to the segment length. */
      length?: number;
      /** Time from release to landing. Clamped to [STRIKE_MS, MAX_WINDUP_MS]. Default STRIKE_MS. The AI sets this; the player uses the default. */
      windupMs?: number;
    };

export type Stance = 'ready' | 'move' | 'windup' | 'recover' | 'dip' | 'guard' | 'stun';

/** A stroke on its way. For the foe this is the telegraph the player reads. */
export interface Strike {
  kind: AttackKind;
  segment: Segment;
  /** Path length used for knockback, stage units. */
  length: number;
  windupMs: number;
  startTick: number;
  landsAtTick: number;
}

export interface Fighter {
  x: number;
  /** +1 faces right, -1 faces left. Always toward the other fighter. */
  facing: 1 | -1;
  stance: Stance;
  /** 0..100. */
  ink: number;
  /** Ticks left of stun (no actions, cannot parry or guard). */
  stun: number;
  /** Ticks left of the riposte this fighter earned by a parry (for render and AI; the foe is stunned for the same time). */
  riposte: number;
  /** Ticks left of a circle guard. */
  guard: number;
  /** Ticks left of recovery after a strike lands or whiffs. */
  recover: number;
  /** Ticks left of a dip. Ink refills when it reaches 0. */
  dip: number;
  /** Ticks left of a step or dash, and the x change per tick. */
  moveTicks: number;
  moveDx: number;
  /** The pending attack, if any (the telegraph). */
  strike: Strike | null;
}

export type Phase = 'fight' | 'point' | 'over';

export interface DuelState {
  seed: number;
  tick: number;
  phase: Phase;
  /** Ticks left of the pause after a hit (phase 'point'). */
  pause: number;
  /** Ticks left of hit-stop (render freezes; part of the point pause). */
  hitstop: number;
  fighters: [Fighter, Fighter];
  /** Clean hits each. */
  score: [number, number];
  winner: 0 | 1 | null;
}

export type DuelEvent =
  | { type: 'strike'; who: 0 | 1; kind: AttackKind; cost: number; landsAtTick: number }
  | { type: 'fizzle'; who: 0 | 1; reason: 'slow' | 'none' | 'busy' }
  | { type: 'dry'; who: 0 | 1; cost: number; ink: number }
  | { type: 'parry'; who: 0 | 1; cost: number }
  | { type: 'guard'; who: 0 | 1; cost: number }
  | { type: 'blocked'; who: 0 | 1 }
  | { type: 'clash'; push: [number, number] }
  | { type: 'whiff'; who: 0 | 1 }
  | { type: 'hit'; who: 0 | 1; kind: AttackKind; knockback: number; score: [number, number] }
  | { type: 'feint'; who: 0 | 1; kind: AttackKind }
  | { type: 'dip-start'; who: 0 | 1 }
  | { type: 'dip-done'; who: 0 | 1 }
  | { type: 'resume' }
  | { type: 'win'; who: 0 | 1 };

/** All duel numbers. ms values become ticks with msToTicks (rounded up). */
export const DUEL_RULES = {
  /** Simulation rate. */
  TICK_HZ: 60,
  /** Stage half width; fighters stay inside +-this. */
  STAGE_HALF: 7.5,
  /** Start positions: fighter 0 at -START_X, fighter 1 at +START_X. */
  START_X: 2.5,
  /** Fighters can never be closer than this. */
  MIN_GAP: 0.8,
  /** Classifier px per stage unit at scale 1 (1280 px / 16 units). */
  PX_PER_UNIT: 80,

  STEP_DIST: 0.5,
  STEP_MS: 150,
  DASH_DIST: 1.5,
  DASH_MS: 200,
  DASH_INK: 5,

  INK_MAX: 100,
  /** Ink cost of a stroke = INK_BASE + INK_PER_UNIT * length * (1 + INK_SPEED_EXTRA * f), f = 0 at MIN_STROKE_SPEED up to 1 at FAST_STROKE_SPEED. */
  INK_BASE: 2,
  INK_PER_UNIT: 3,
  INK_SPEED_EXTRA: 0.5,
  /** Lengths above this count as this much for ink and knockback. */
  MAX_STROKE_LENGTH: 8,
  /** A thrust (dot or flick) counts as this long, at full speed, for ink and knockback. */
  THRUST_LENGTH: 2,
  /** Slashes (cut, overhead, rising) slower than this, in stage units per second, do nothing and cost nothing. */
  MIN_STROKE_SPEED: 4,
  FAST_STROKE_SPEED: 40,
  /** A circle guard costs this. */
  GUARD_INK: 6,
  GUARD_MS: 250,

  /** Reach in stage units: a strike hits if the gap is at most this. */
  REACH_CUT: 2.4,
  REACH_OVERHEAD: 2.0,
  REACH_RISING: 2.0,
  REACH_THRUST: 3.0,

  /** Release to landing for the player's strokes, and the shortest windup anyone may use. */
  STRIKE_MS: 100,
  MAX_WINDUP_MS: 1500,
  /** Opponent masters should use at least this windup so the line shows 15 frames. Not enforced by the core. */
  MIN_TELEGRAPH_MS: 250,
  /** A cut across the foe's line parries only in the last PARRY_WINDOW_MS before it lands. */
  PARRY_WINDOW_MS: 300,
  /** A parry stuns the foe for this long and gives the parrier a riposte of the same length. */
  RIPOSTE_MS: 400,
  /** After a strike lands or whiffs. */
  RECOVER_MS: 120,
  /** After a feint drops a pending strike: no action for this long (a feint is not free). */
  FEINT_RECOVER_MS: 100,

  /**
   * A foe line with a windup of at least this long is a committed wind-up.
   * A strike landing on a committed wind-up whose line showed
   * before the strike started is turned aside ('blocked'): the striker is
   * staggered until that line lands plus COMMIT_STAGGER_MS, so the line lands
   * clean. The only answer to a committed line is to cut across it (a parry).
   * Player strokes (100 ms) are never committed.
   */
  COMMIT_MS: 250,
  COMMIT_STAGGER_MS: 150,
  /** Two strikes landing this close together clash. */
  CLASH_MS: 80,
  /** Both are pushed back this far (times a seeded 0.9..1.1). */
  CLASH_PUSH: 0.8,
  CLASH_JITTER: 0.1,
  CLASH_STAGGER_MS: 200,

  /** Knockback on a hit = KNOCK_PER_UNIT * length, clamped to KNOCK_MIN..KNOCK_MAX. */
  KNOCK_PER_UNIT: 0.2,
  KNOCK_MIN: 0.2,
  KNOCK_MAX: 2.0,
  /** Render freeze on a hit (the bar is 50 ms or more); numbers from core/feel.ts. */
  HITSTOP_MS: FEEL.HITSTOP_MS as number,
  /** Longer freeze on the killing blow (80 to 120 ms). */
  HITSTOP_FINAL_MS: FEEL.HITSTOP_FINAL_MS as number,
  /** Pause after a hit before play resumes; pending strikes are dropped. */
  POINT_PAUSE_MS: 900,

  DIP_MS: 700,
  /** First to this many clean hits wins. */
  HITS_TO_WIN: 3,
};

export type DuelRules = typeof DUEL_RULES;

/**
 * Per-fighter changes to the rules (Path mode seals and brushes, path.ts).
 * Every field is optional; a missing field, or no mods at all, leaves the
 * duel exactly as without this hook (multipliers default to 1, additions to 0).
 */
export interface FighterMods {
  /** Ink cost of this fighter's strokes, times this, per kind. */
  inkCostMul?: Partial<Record<AttackKind, number>>;
  /** Ms added to the parry window when this fighter parries (may be negative). */
  parryWindowMs?: number;
  /** Riposte (and the foe's stun) after this fighter's parry, times this. */
  riposteMul?: number;
  /** This fighter's dip time, times this. */
  dipMul?: number;
  /** This fighter's circle guard: ink times guardInkMul, length times guardMsMul. */
  guardInkMul?: number;
  guardMsMul?: number;
  /** Knockback of this fighter's hits, times this. */
  knockMul?: number;
  /** Points a clean hit by this fighter scores. Default 1. */
  hitValue?: number;
  /** Time of this fighter's steps and dashes, times this. */
  moveMsMul?: number;
  /** Extra ink this fighter holds (start and refill). */
  inkMaxBonus?: number;
  /** Stage units added to this fighter's reach for every kind (landing test only). */
  reachBonus?: number;
  /** Ms added to this fighter's own windups. */
  ownWindupMs?: number;
  /** Ms added to the OTHER fighter's windups (its telegraph shows longer, or shorter if negative). */
  foeWindupMs?: number;
}

export interface Duel {
  state: DuelState;
  rules: DuelRules;
  rng: Rng;
  /** Present only when createDuel got mods. */
  mods?: [FighterMods | null, FighterMods | null];
}

export interface DuelOptions {
  /** Override any rule (Path seals, tests). */
  rules?: Partial<DuelRules>;
  /** Per-fighter rule changes (Path seals and brushes). Omit for the plain duel. */
  mods?: [FighterMods | null, FighterMods | null];
}

function modsOf(duel: Duel, who: 0 | 1): FighterMods | null {
  return duel.mods ? duel.mods[who] : null;
}

/** Ink capacity of a fighter: INK_MAX plus its inkMaxBonus. */
export function inkMaxOf(rules: DuelRules, m: FighterMods | null | undefined): number {
  return m && m.inkMaxBonus ? rules.INK_MAX + m.inkMaxBonus : rules.INK_MAX;
}

/** Milliseconds per tick at the given rate. */
export function tickMs(rules: DuelRules = DUEL_RULES): number {
  return 1000 / rules.TICK_HZ;
}

/** Whole ticks covering ms (rounded up, 400 ms = 24 ticks at 60 Hz). */
export function msToTicks(ms: number, rules: DuelRules = DUEL_RULES): number {
  return Math.max(0, Math.ceil(ms / tickMs(rules) - 1e-9));
}

/** Classifier speed (screen px per ms) to stage units per second. */
export function strokeSpeedToStage(pxPerMs: number, scale = 1, rules: DuelRules = DUEL_RULES): number {
  const s = scale > 0 && Number.isFinite(scale) ? scale : 1;
  return ((pxPerMs / s) * 1000) / rules.PX_PER_UNIT;
}

function newFighter(x: number, facing: 1 | -1, rules: DuelRules, m: FighterMods | null = null): Fighter {
  return {
    x,
    facing,
    stance: 'ready',
    ink: inkMaxOf(rules, m),
    stun: 0,
    riposte: 0,
    guard: 0,
    recover: 0,
    dip: 0,
    moveTicks: 0,
    moveDx: 0,
    strike: null,
  };
}

export function createDuel(seed: number, options: DuelOptions = {}): Duel {
  const rules: DuelRules = { ...DUEL_RULES, ...(options.rules ?? {}) };
  const s = seed >>> 0;
  const mods = options.mods;
  const duel: Duel = {
    rules,
    rng: createRng(s),
    state: {
      seed: s,
      tick: 0,
      phase: 'fight',
      pause: 0,
      hitstop: 0,
      fighters: [newFighter(-rules.START_X, 1, rules, mods ? mods[0] : null), newFighter(rules.START_X, -1, rules, mods ? mods[1] : null)],
      score: [0, 0],
      winner: null,
    },
  };
  if (mods) duel.mods = [mods[0] ?? null, mods[1] ?? null];
  return duel;
}

export function reachOf(kind: AttackKind, rules: DuelRules = DUEL_RULES): number {
  switch (kind) {
    case 'cut':
      return rules.REACH_CUT;
    case 'overhead':
      return rules.REACH_OVERHEAD;
    case 'rising':
      return rules.REACH_RISING;
    case 'thrust':
      return rules.REACH_THRUST;
  }
}

/** Effective length and speed of a stroke for cost and knockback. */
function strokeMeasure(kind: AttackKind, length: number, speed: number, rules: DuelRules): { length: number; speed: number } {
  if (kind === 'thrust') return { length: rules.THRUST_LENGTH, speed: rules.FAST_STROKE_SPEED };
  const len = Math.min(Math.max(0, Number.isFinite(length) ? length : 0), rules.MAX_STROKE_LENGTH);
  return { length: len, speed: Number.isFinite(speed) ? speed : 0 };
}

/** Ink a stroke costs. Thrusts count as THRUST_LENGTH at full speed. */
export function inkCost(kind: AttackKind, length: number, speed: number, rules: DuelRules = DUEL_RULES): number {
  const m = strokeMeasure(kind, length, speed, rules);
  const span = rules.FAST_STROKE_SPEED - rules.MIN_STROKE_SPEED;
  const f = span > 0 ? Math.min(1, Math.max(0, (m.speed - rules.MIN_STROKE_SPEED) / span)) : 1;
  return rules.INK_BASE + rules.INK_PER_UNIT * m.length * (1 + rules.INK_SPEED_EXTRA * f);
}

/** How far a landed hit pushes the foe back. */
export function knockback(kind: AttackKind, length: number, rules: DuelRules = DUEL_RULES): number {
  const m = strokeMeasure(kind, length, rules.FAST_STROKE_SPEED, rules);
  return Math.min(rules.KNOCK_MAX, Math.max(rules.KNOCK_MIN, rules.KNOCK_PER_UNIT * m.length));
}

function cross(o: Vec2, p: Vec2, q: Vec2): number {
  return (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
}

function onSegment(p: Vec2, q: Vec2, r: Vec2): boolean {
  return Math.min(p.x, r.x) <= q.x && q.x <= Math.max(p.x, r.x) && Math.min(p.y, r.y) <= q.y && q.y <= Math.max(p.y, r.y);
}

/** True when one segment cuts across the other (crossing or touching). Two segments on one line never cut across. */
export function segmentsCross(s: Segment, t: Segment): boolean {
  const d1 = cross(t.a, t.b, s.a);
  const d2 = cross(t.a, t.b, s.b);
  const d3 = cross(s.a, s.b, t.a);
  const d4 = cross(s.a, s.b, t.b);
  if ((d1 === 0 && d2 === 0) || (d3 === 0 && d4 === 0)) return false;
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  if (d1 === 0 && onSegment(t.a, s.a, t.b)) return true;
  if (d2 === 0 && onSegment(t.a, s.b, t.b)) return true;
  if (d3 === 0 && onSegment(s.a, t.a, s.b)) return true;
  if (d4 === 0 && onSegment(s.a, t.b, s.b)) return true;
  return false;
}

/** True when the fighter may take a new action this tick. */
export function canAct(f: Fighter): boolean {
  return f.stun === 0 && f.recover === 0 && f.dip === 0 && f.moveTicks === 0 && f.strike === null;
}

function isFiniteSegment(s: Segment | undefined): s is Segment {
  return !!s && [s.a?.x, s.a?.y, s.b?.x, s.b?.y].every((v) => typeof v === 'number' && Number.isFinite(v));
}

function startMove(f: Fighter, dir: MoveDir, dist: number, ms: number, rules: DuelRules, m: FighterMods | null = null): void {
  if (m && m.moveMsMul !== undefined) ms = ms * m.moveMsMul;
  const ticks = Math.max(1, msToTicks(ms, rules));
  const sign = dir === 'in' ? f.facing : -f.facing;
  f.moveTicks = ticks;
  f.moveDx = (sign * dist) / ticks;
}

/** True when the only thing stopping this fighter is a move, and the stroke would parry the foe's line now. */
function isParryMidMove(duel: Duel, who: 0 | 1, action: Extract<DuelAction, { type: 'stroke' }>): boolean {
  const { state, rules } = duel;
  const me = state.fighters[who];
  const t = state.fighters[who === 0 ? 1 : 0].strike;
  if (!t || me.moveTicks === 0 || me.stun > 0 || me.recover > 0 || me.dip > 0 || me.strike) return false;
  if (action.kind !== 'cut' && action.kind !== 'overhead' && action.kind !== 'rising') return false;
  if (!isFiniteSegment(action.segment) || !(Number.isFinite(action.speed) && action.speed >= rules.MIN_STROKE_SPEED)) return false;
  const m = modsOf(duel, who);
  const win = m && m.parryWindowMs ? rules.PARRY_WINDOW_MS + m.parryWindowMs : rules.PARRY_WINDOW_MS;
  return (t.landsAtTick - state.tick) * tickMs(rules) <= win && segmentsCross(action.segment, t.segment);
}

function applyAction(duel: Duel, who: 0 | 1, action: DuelAction, events: DuelEvent[]): void {
  const { state, rules } = duel;
  const me = state.fighters[who];
  const foe = state.fighters[who === 0 ? 1 : 0];
  const myMods = modsOf(duel, who);
  const foeMods = modsOf(duel, who === 0 ? 1 : 0);
  if (action.type === 'feint') {
    // A feint drops the fighter's own pending strike before it lands. Actions apply before landings, so a feint on the landing tick still drops it.
    const s = me.strike;
    if (!s || me.stun > 0) return;
    me.strike = null;
    me.recover = Math.max(1, msToTicks(rules.FEINT_RECOVER_MS, rules));
    events.push({ type: 'feint', who, kind: s.kind });
    return;
  }
  // A parry cut may be drawn in the middle of a step or dash: it stops the move.
  if (!canAct(me) && action.type === 'stroke' && isParryMidMove(duel, who, action)) {
    me.moveTicks = 0;
    me.moveDx = 0;
  }
  if (!canAct(me)) {
    if (action.type === 'stroke') events.push({ type: 'fizzle', who, reason: 'busy' });
    return;
  }
  switch (action.type) {
    case 'step':
      startMove(me, action.dir, rules.STEP_DIST, rules.STEP_MS, rules, myMods);
      return;
    case 'dash':
      if (me.ink < rules.DASH_INK) return;
      me.ink -= rules.DASH_INK;
      startMove(me, action.dir, rules.DASH_DIST, rules.DASH_MS, rules, myMods);
      return;
    case 'dip':
      if (me.ink >= inkMaxOf(rules, myMods)) return;
      me.dip = Math.max(1, msToTicks(myMods && myMods.dipMul !== undefined ? rules.DIP_MS * myMods.dipMul : rules.DIP_MS, rules));
      me.guard = 0;
      events.push({ type: 'dip-start', who });
      return;
    case 'stroke':
      break;
  }
  const kind = action.kind;
  if (kind === 'none') {
    events.push({ type: 'fizzle', who, reason: 'none' });
    return;
  }
  if (kind === 'parry') {
    // A circle: a short guard that blocks a strike landing on it. No riposte.
    const guardInk = myMods && myMods.guardInkMul !== undefined ? rules.GUARD_INK * myMods.guardInkMul : rules.GUARD_INK;
    const guardMs = myMods && myMods.guardMsMul !== undefined ? rules.GUARD_MS * myMods.guardMsMul : rules.GUARD_MS;
    if (me.ink < guardInk) {
      events.push({ type: 'dry', who, cost: guardInk, ink: me.ink });
      return;
    }
    me.ink -= guardInk;
    me.guard = Math.max(1, msToTicks(guardMs, rules));
    events.push({ type: 'guard', who, cost: guardInk });
    return;
  }
  if (!isFiniteSegment(action.segment)) {
    events.push({ type: 'fizzle', who, reason: 'none' });
    return;
  }
  const seg = action.segment;
  const rawLength = action.length ?? Math.hypot(seg.b.x - seg.a.x, seg.b.y - seg.a.y);
  const speed = Number.isFinite(action.speed) ? action.speed : 0;
  if (kind !== 'thrust' && speed < rules.MIN_STROKE_SPEED) {
    events.push({ type: 'fizzle', who, reason: 'slow' });
    return;
  }
  let cost = inkCost(kind, rawLength, speed, rules);
  if (myMods && myMods.inkCostMul && myMods.inkCostMul[kind] !== undefined) cost = cost * (myMods.inkCostMul[kind] as number);
  if (me.ink <= 0 || me.ink < cost) {
    events.push({ type: 'dry', who, cost, ink: me.ink });
    return;
  }
  me.ink = Math.max(0, me.ink - cost);

  // Parry: a slash (cut, overhead, rising; never a thrust, which has no speed gate) crosses the foe's pending line inside its window.
  const t = foe.strike;
  const parryWindow = myMods && myMods.parryWindowMs ? rules.PARRY_WINDOW_MS + myMods.parryWindowMs : rules.PARRY_WINDOW_MS;
  if (t && kind !== 'thrust' && (t.landsAtTick - state.tick) * tickMs(rules) <= parryWindow && segmentsCross(seg, t.segment)) {
    const r = Math.max(1, msToTicks(myMods && myMods.riposteMul !== undefined ? rules.RIPOSTE_MS * myMods.riposteMul : rules.RIPOSTE_MS, rules));
    foe.strike = null;
    foe.stun = r;
    foe.moveTicks = 0;
    foe.guard = 0;
    me.riposte = r;
    events.push({ type: 'parry', who, cost });
    return;
  }

  let windupMs = Math.min(rules.MAX_WINDUP_MS, Math.max(rules.STRIKE_MS, Number.isFinite(action.windupMs) ? (action.windupMs as number) : rules.STRIKE_MS));
  const extraWindup = (myMods && myMods.ownWindupMs ? myMods.ownWindupMs : 0) + (foeMods && foeMods.foeWindupMs ? foeMods.foeWindupMs : 0);
  if (extraWindup !== 0) windupMs = Math.min(rules.MAX_WINDUP_MS, Math.max(rules.STRIKE_MS, windupMs + extraWindup));
  const landsAtTick = state.tick + Math.max(1, msToTicks(windupMs, rules));
  me.strike = {
    kind,
    segment: { a: { ...seg.a }, b: { ...seg.b } },
    length: strokeMeasure(kind, rawLength, speed, rules).length,
    windupMs,
    startTick: state.tick,
    landsAtTick,
  };
  me.guard = 0;
  events.push({ type: 'strike', who, kind, cost, landsAtTick });
}

function keepApart(state: DuelState, rules: DuelRules, mover: 0 | 1 | null): void {
  const [a, b] = state.fighters;
  for (const f of state.fighters) f.x = Math.min(rules.STAGE_HALF, Math.max(-rules.STAGE_HALF, f.x));
  const gap = Math.abs(b.x - a.x);
  if (gap >= rules.MIN_GAP) return;
  const left = a.x <= b.x ? a : b;
  const right = left === a ? b : a;
  const need = rules.MIN_GAP - gap;
  // The mover gives way; with no mover both give half.
  if (mover === null) {
    left.x -= need / 2;
    right.x += need / 2;
  } else if (state.fighters[mover] === left) left.x -= need;
  else right.x += need;
  // Walls win: push the other one instead.
  if (left.x < -rules.STAGE_HALF) {
    left.x = -rules.STAGE_HALF;
    right.x = left.x + rules.MIN_GAP;
  }
  if (right.x > rules.STAGE_HALF) {
    right.x = rules.STAGE_HALF;
    left.x = right.x - rules.MIN_GAP;
  }
}

function pushBack(state: DuelState, who: 0 | 1, dist: number): void {
  const f = state.fighters[who];
  f.x -= f.facing * dist;
}

function resolveLanding(duel: Duel, who: 0 | 1, events: DuelEvent[]): void {
  const { state, rules } = duel;
  const me = state.fighters[who];
  const otherIdx: 0 | 1 = who === 0 ? 1 : 0;
  const foe = state.fighters[otherIdx];
  const s = me.strike;
  if (!s) return;
  const gap = Math.abs(foe.x - me.x);
  const recover = Math.max(1, msToTicks(rules.RECOVER_MS, rules));

  // Clash: the foe's strike lands within CLASH_MS of this one, and one of them can reach.
  const o = foe.strike;
  if (o && Math.abs(o.landsAtTick - s.landsAtTick) * tickMs(rules) <= rules.CLASH_MS && gap <= Math.max(reachOf(s.kind, rules), reachOf(o.kind, rules))) {
    const push: [number, number] = [0, 0];
    for (const i of [0, 1] as const) {
      push[i] = rules.CLASH_PUSH * (1 + rules.CLASH_JITTER * (2 * duel.rng.next() - 1));
      pushBack(state, i, push[i]);
      const f = state.fighters[i];
      f.strike = null;
      f.moveTicks = 0;
      f.guard = 0;
      f.stun = Math.max(f.stun, Math.max(1, msToTicks(rules.CLASH_STAGGER_MS, rules)));
    }
    keepApart(state, rules, null);
    events.push({ type: 'clash', push });
    return;
  }

  const myMods = modsOf(duel, who);
  me.strike = null;
  me.recover = recover;
  if (gap > (myMods && myMods.reachBonus ? reachOf(s.kind, rules) + myMods.reachBonus : reachOf(s.kind, rules))) {
    events.push({ type: 'whiff', who });
    return;
  }
  // Committed wind-up: a strike into a line that was already
  // showing is turned aside and the striker is staggered until that line lands.
  if (o && o.windupMs >= rules.COMMIT_MS && o.startTick < s.startTick) {
    me.stun = Math.max(me.stun, o.landsAtTick - state.tick + Math.max(1, msToTicks(rules.COMMIT_STAGGER_MS, rules)));
    me.moveTicks = 0;
    me.guard = 0;
    events.push({ type: 'blocked', who });
    return;
  }
  if (foe.guard > 0 && foe.dip === 0 && foe.stun === 0) {
    foe.guard = 0;
    events.push({ type: 'blocked', who });
    return;
  }
  // Clean hit.
  const kb = myMods && myMods.knockMul !== undefined ? knockback(s.kind, s.length, rules) * myMods.knockMul : knockback(s.kind, s.length, rules);
  state.score[who] += myMods && myMods.hitValue !== undefined ? myMods.hitValue : 1;
  pushBack(state, otherIdx, kb);
  keepApart(state, rules, otherIdx);
  const score: [number, number] = [state.score[0], state.score[1]];
  events.push({ type: 'hit', who, kind: s.kind, knockback: kb, score });
  // Every pending action stops; nobody acts during the pause.
  for (const f of state.fighters) {
    f.strike = null;
    f.moveTicks = 0;
    f.moveDx = 0;
    f.guard = 0;
    f.dip = 0;
    f.stun = 0;
    f.riposte = 0;
    f.recover = 0;
  }
  const final = state.score[who] >= rules.HITS_TO_WIN;
  state.hitstop = Math.max(1, msToTicks(final ? rules.HITSTOP_FINAL_MS : rules.HITSTOP_MS, rules));
  if (final) {
    state.phase = 'over';
    state.winner = who;
    events.push({ type: 'win', who });
  } else {
    state.phase = 'point';
    state.pause = Math.max(1, msToTicks(rules.POINT_PAUSE_MS, rules));
  }
}

function stanceOf(f: Fighter): Stance {
  if (f.stun > 0) return 'stun';
  if (f.dip > 0) return 'dip';
  if (f.strike) return 'windup';
  if (f.recover > 0) return 'recover';
  if (f.guard > 0) return 'guard';
  if (f.moveTicks > 0) return 'move';
  return 'ready';
}

function refreshFacing(state: DuelState): void {
  const [a, b] = state.fighters;
  if (a.x === b.x) return;
  a.facing = b.x > a.x ? 1 : -1;
  b.facing = a.x > b.x ? 1 : -1;
}

/**
 * Advance the duel one tick (1/60 s). actions[i] is fighter i's input this
 * tick, or null. Returns what happened, for render, audio and the AI.
 * Order inside a tick: timers count down, actions apply (fighter 0 first),
 * movement, then strikes due this tick land (earliest start first).
 */
export function stepDuel(duel: Duel, actions: readonly [DuelAction | null, DuelAction | null]): DuelEvent[] {
  const { state, rules } = duel;
  const events: DuelEvent[] = [];
  if (state.phase === 'over') {
    if (state.hitstop > 0) state.hitstop--;
    state.tick++;
    return events;
  }
  state.tick++;
  if (state.hitstop > 0) state.hitstop--;
  if (state.phase === 'point') {
    state.pause--;
    if (state.pause <= 0) {
      state.pause = 0;
      state.phase = 'fight';
      events.push({ type: 'resume' });
    }
    for (const f of state.fighters) f.stance = stanceOf(f);
    return events;
  }

  // Timers.
  state.fighters.forEach((f, i) => {
    if (f.stun > 0) f.stun--;
    if (f.riposte > 0) f.riposte--;
    if (f.guard > 0) f.guard--;
    if (f.recover > 0) f.recover--;
    if (f.dip > 0) {
      f.dip--;
      if (f.dip === 0) {
        f.ink = inkMaxOf(rules, modsOf(duel, i as 0 | 1));
        events.push({ type: 'dip-done', who: i as 0 | 1 });
      }
    }
  });

  // Actions.
  for (const who of [0, 1] as const) {
    const a = actions[who];
    if (a) applyAction(duel, who, a, events);
  }

  // Movement.
  for (const who of [0, 1] as const) {
    const f = state.fighters[who];
    if (f.moveTicks > 0) {
      f.x += f.moveDx;
      f.moveTicks--;
      if (f.moveTicks === 0) f.moveDx = 0;
      keepApart(state, rules, who);
    }
  }
  refreshFacing(state);

  // Landings, earliest start first, fighter 0 first on a tie.
  const due = ([0, 1] as const)
    .filter((i) => {
      const s = state.fighters[i].strike;
      return s !== null && s.landsAtTick <= state.tick;
    })
    .sort((i, j) => (state.fighters[i].strike as Strike).startTick - (state.fighters[j].strike as Strike).startTick || i - j);
  for (const who of due) {
    if (state.phase !== 'fight') break;
    if (state.fighters[who].strike) resolveLanding(duel, who, events);
  }
  refreshFacing(state);
  for (const f of state.fighters) f.stance = stanceOf(f);
  return events;
}
