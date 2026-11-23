// Opponent AI v1 and the scripted reference player used to tune it.
// Pure TypeScript on top of duel.ts: no DOM, no Math.random.
//
// The AI reads duel.state each tick and returns one DuelAction (or null).
// It is deterministic: its choices come from its own seeded rng (rng.ts),
// never from duel.rng (that one is for the clash push spread only).
//
//   const ai = createAi(STYLES.patient, 1, seed)
//   const action = aiAct(ai, duel)          // before stepDuel, every tick
//
// Every tuning number of a style is data (AiStyle) so the eight
// masters in masters.ts can be built from these three.

import { createRng, type Rng } from './rng.js';
import {
  canAct,
  createDuel,
  inkCost,
  msToTicks,
  reachOf,
  stepDuel,
  type AttackKind,
  type Duel,
  type DuelAction,
  type DuelRules,
  type Fighter,
  type Segment,
  type Strike,
} from './duel.js';

/**
 * Floor for every real AI strike line (one that is not dropped as a feint):
 * it shows at least this long before it lands. Above the core's 250 ms
 * MIN_TELEGRAPH_MS (15 frames) so a human can read and cut it
 * in time. Ripostes and feint follow-ups use it too.
 */
export const REAL_LINE_FLOOR_MS = 350;

/**
 * Mashing. A player attack that starts
 * within CHAIN_MS of the start of the player's previous attack is a chained
 * stroke, and for CHAIN_MS after any player attack the master is "being
 * mashed". Masters 2 to 8 then fight the way Oro fights every stroke: they cut
 * each chained stroke that can reach them (even from mid-step, as the core
 * allows) and do not strike back or rush the stunned player after that cut;
 * they dip when the player dips; they drop their feints and show slow
 * committed lines of MASH_LINE_MS, so a stroke thrown into one is turned
 * aside; and they wait MASH_PRESS_EXTRA_MS longer before pressing. A single
 * deliberate stroke keeps the master's parry chance and riposte. The window
 * spans a point pause, so mashing straight after a point is still a chain.
 * Oro (cutsFirst) is unchanged.
 */
export const CHAIN_MS = 4500;
export const MASH_LINE_MS = 800;
export const MASH_PRESS_EXTRA_MS = 5000;
/** A master dips with a mashing player who dips when its own ink is under this. */
export const MASH_DIP_BELOW = 60;

/** Stage height used for telegraph lines (fit.ts: 16 x 9, y from -4.5 to 4.5). */
export const STAGE_HALF_H = 4.5;
/** Stage half width of the fit.ts frame (lines may run past the walls at 7.5, not past the frame). */
export const STAGE_FRAME_HALF_W = 8;

export interface AiStyle {
  name: string;
  /** Telegraph lead time: windup of every strike, ms. The line shows this long before it lands. Keep at or above REAL_LINE_FLOOR_MS. */
  windupMs: number;
  /** Seeded spread added to windupMs, 0..this ms. */
  windupJitterMs: number;
  /** Reaction window: ms from the player's line appearing to the AI's answer. A player stroke lands 100 ms after release, so only reactions under 100 ms can parry it. */
  reactionMs: number;
  /** Chance the AI answers a player line that can reach it with a parry cut. */
  parryChance: number;
  /** Gap the AI holds between its attacks (cut reach is 2.4, thrust 3.0). */
  holdGap: number;
  /** Quiet time before the AI presses in and attacks, rolled between these after each strike or point, ms. Keeps every duel moving. */
  pressMinMs: number;
  pressMaxMs: number;
  /** Chance an attack is a feint: telegraph one line, drop it, strike another. */
  feintChance: number;
  /** Ms after the feint line appears that it is dropped. */
  feintDropMs: number;
  /** Windup of the real strike that follows a feint, ms. Raised to REAL_LINE_FLOOR_MS if lower. */
  feintStrikeMs: number;
  /** Ink under which the AI backs off and dips. */
  dipBelow: number;
  /** Relative weights of the attack kinds. */
  kinds: Record<AttackKind, number>;
  /**
   * What follows a feint. 'reach' (default):
   * any kind that reaches from here, often the same line. 'other': a different
   * kind from the shown one, struck from that kind's own gap (the AI steps in
   * or out first), so the real line comes from another place.
   */
  feintFollow?: 'reach' | 'other';
  /** Chance an attack copies the kind of the player's last stroke when it reaches (the mirror master). Default 0. */
  mirror?: number;
  /**
   * Strike back at once after its own parry, and rush a stunned or dipping
   * player (default true). False for Oro: he cuts a stroke
   * started first and goes back to his quiet rhythm, so swinging first wastes
   * the player's ink and time and never scores; his points come from his own
   * presses.
   */
  riposte?: boolean;
  /**
   * Oro's tell: he cuts a stroke started first. A player line
   * that comes into reach after it appeared is still judged, and the parry cut
   * may stop his own step (the core allows a parry mid-move). Default false.
   */
  cutsFirst?: boolean;
}

/**
 * The three v1 styles. Master 1 is `patient`. Bands they are tuned to are in
 * ai.test.ts (spec: a skill-0.7 reference player beats master 1 in
 * 60 to 85 percent of duels and the feinter in 30 to 55 percent).
 */
export const STYLES: Record<'patient' | 'aggressive' | 'feinter', AiStyle> = {
  // Patient counter-cutter: slow thick lines, waits, parries the player's cuts.
  patient: {
    name: 'patient',
    windupMs: 900,
    windupJitterMs: 150,
    reactionMs: 67,
    parryChance: 1,
    holdGap: 2.2,
    pressMinMs: 7000,
    pressMaxMs: 13000,
    feintChance: 0,
    feintDropMs: 0,
    feintStrikeMs: 0,
    dipBelow: 30,
    kinds: { cut: 3, overhead: 2, rising: 1, thrust: 0 },
    riposte: false,
    cutsFirst: true,
  },
  // Aggressive presser: short telegraphs, attacks often, rarely parries.
  aggressive: {
    name: 'aggressive',
    windupMs: 350,
    windupJitterMs: 100,
    reactionMs: 83,
    parryChance: 0.25,
    holdGap: 2.6,
    pressMinMs: 5000,
    pressMaxMs: 10000,
    feintChance: 0,
    feintDropMs: 0,
    feintStrikeMs: 0,
    dipBelow: 20,
    kinds: { cut: 2, overhead: 1, rising: 1, thrust: 2 },
  },
  // Feinter: shows a slow line, drops it, then strikes the real line at the
  // 350 ms floor; fights its ink low before it dips.
  feinter: {
    name: 'feinter',
    windupMs: 700,
    windupJitterMs: 150,
    reactionMs: 83,
    parryChance: 0.4,
    holdGap: 3.2,
    pressMinMs: 6000,
    pressMaxMs: 11000,
    feintChance: 1,
    feintDropMs: 300,
    feintStrikeMs: 350,
    dipBelow: 15,
    kinds: { cut: 2, overhead: 2, rising: 2, thrust: 1 },
  },
};

/** Speed the AI draws its slashes at, stage units per second. */
export const AI_STROKE_SPEED = 20;

/** A point on the line the blade travels, stage frame (x as the fighters, y up). */
function clampFrame(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.min(STAGE_FRAME_HALF_W, Math.max(-STAGE_FRAME_HALF_W, x)),
    y: Math.min(STAGE_HALF_H, Math.max(-STAGE_HALF_H, y)),
  };
}

/**
 * Where the striker's blade will travel: a line from just
 * in front of the striker out toward the foe, never further out than the
 * kind's reach, in the one shared stage frame.
 * `wobble` (0..1, from the AI's rng) varies the heights a little.
 */
export function telegraphSegment(kind: AttackKind, f: Pick<Fighter, 'x' | 'facing'>, wobble = 0.5, rules?: DuelRules): Segment {
  const reach = reachOf(kind, rules);
  const d = f.facing;
  const w = (wobble - 0.5) * 0.3;
  const at = (dx: number, y: number) => clampFrame(f.x + d * dx, y + w);
  switch (kind) {
    case 'cut':
      return { a: at(0.4, 2.0), b: at(reach * 0.95, 0.8) };
    case 'overhead':
      return { a: at(0.5, 2.9), b: at(reach * 0.9, 0.5) };
    case 'rising':
      return { a: at(0.5, 0.3), b: at(reach * 0.9, 2.1) };
    case 'thrust':
      return { a: at(0.5, 1.5), b: at(reach * 0.95, 1.3) };
  }
}

/** A short cut across the middle of a line, at right angles: the stroke that parries it. */
export function parryCutAcross(line: Segment, halfLength = 0.8): Segment {
  const mx = (line.a.x + line.b.x) / 2;
  const my = (line.a.y + line.b.y) / 2;
  const dx = line.b.x - line.a.x;
  const dy = line.b.y - line.a.y;
  const n = Math.hypot(dx, dy) || 1;
  const px = (-dy / n) * halfLength;
  const py = (dx / n) * halfLength;
  return { a: { x: mx - px, y: my - py }, b: { x: mx + px, y: my + py } };
}

function segLength(s: Segment): number {
  return Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
}

function strokeAction(kind: AttackKind, segment: Segment, windupMs?: number): DuelAction {
  const a: DuelAction = { type: 'stroke', kind, speed: AI_STROKE_SPEED, segment, length: segLength(segment) };
  if (windupMs !== undefined) a.windupMs = windupMs;
  return a;
}

/** A real line's windup: never under REAL_LINE_FLOOR_MS (nor the core's MIN_TELEGRAPH_MS). */
function realWindup(ms: number, rules: DuelRules): number {
  return Math.max(REAL_LINE_FLOOR_MS, rules.MIN_TELEGRAPH_MS, ms);
}

/** Longest the 'other' follow-up spends taking its gap after the drop, ms. */
export const FEINT_FOLLOW_MOVE_MS = 600;

/**
 * Windup of a line that will be dropped as a feint: it outlasts the drop by
 * more than the parry window, so the drop always comes before the window
 * opens and cutting the fake line is never a parry.
 */
export function fakeWindup(windupMs: number, feintDropMs: number, rules: DuelRules): number {
  return Math.max(windupMs, feintDropMs + rules.PARRY_WINDOW_MS + 50);
}

/** A kind other than `not`, weighted by the style's kinds; `not` itself if no other has weight. */
function otherKind(rng: Rng, kinds: Record<AttackKind, number>, not: AttackKind): AttackKind {
  const pool = (['cut', 'overhead', 'rising', 'thrust'] as AttackKind[]).filter((k) => k !== not && kinds[k] > 0);
  if (pool.length === 0) return not;
  const total = pool.reduce((t, k) => t + kinds[k], 0);
  let r = rng.next() * total;
  for (const k of pool) {
    r -= kinds[k];
    if (r < 0) return k;
  }
  return pool[pool.length - 1];
}

function pickKind(rng: Rng, kinds: Record<AttackKind, number>, gap: number, rules: DuelRules): AttackKind {
  const all: AttackKind[] = ['cut', 'overhead', 'rising', 'thrust'];
  // Only kinds that reach from here; if none do, the longest.
  let pool = all.filter((k) => kinds[k] > 0 && reachOf(k, rules) >= gap);
  if (pool.length === 0) pool = all.filter((k) => kinds[k] > 0).sort((a, b) => reachOf(b, rules) - reachOf(a, rules)).slice(0, 1);
  const total = pool.reduce((t, k) => t + kinds[k], 0);
  let r = rng.next() * total;
  for (const k of pool) {
    r -= kinds[k];
    if (r < 0) return k;
  }
  return pool[pool.length - 1];
}

interface AiMemory {
  /** Tick at or after which the AI presses in and attacks. */
  pressAt: number;
  /** Start tick of the foe line already judged, and the answer. */
  judged: number;
  parryAt: number;
  willParry: boolean;
  /** A feint in progress: drop the line at this tick, then strike this kind. */
  feintDropAt: number;
  feintFollow: AttackKind | null;
  /** Tick after which a pending 'other' follow-up is given up if still out of place. */
  feintFollowUntil: number;
  /** Kind of the foe's most recent stroke (for the mirror). */
  foeLastKind: AttackKind | null;
  /** Start tick of the foe's previous attack (for chained strokes), -1 for none. */
  foeLastStrike: number;
  /** The judged foe line is a chained stroke. */
  chained: boolean;
  /** No riposte and no rush before this tick (after cutting a chained stroke). */
  calmUntil: number;
  lastPhase: string;
  feints: number;
}

export interface AiController {
  who: 0 | 1;
  style: AiStyle;
  rng: Rng;
  mem: AiMemory;
}

export function createAi(style: AiStyle, who: 0 | 1, seed: number): AiController {
  return {
    who,
    style,
    rng: createRng((seed ^ 0x9e3779b9 ^ (who * 0x85ebca6b)) >>> 0),
    mem: { pressAt: -1, judged: -1, parryAt: 0, willParry: false, feintDropAt: -1, feintFollow: null, feintFollowUntil: -1, foeLastKind: null, foeLastStrike: -1, chained: false, calmUntil: -1, lastPhase: 'fight', feints: 0 },
  };
}

function rollTicks(rng: Rng, minMs: number, maxMs: number, rules: DuelRules): number {
  return msToTicks(rng.range(minMs, Math.max(minMs, maxMs)), rules);
}

/** Lines that would land on `me`: a pending foe strike whose reach covers the gap (plus a small margin for steps). */
function threatens(s: Strike | null, gap: number, rules: DuelRules): s is Strike {
  return !!s && gap <= reachOf(s.kind, rules) + 0.3;
}

/**
 * Footwork toward a target gap, or null when close enough. Dash when far and
 * ink allows.
 */
function moveToward(me: Fighter, gap: number, target: number, rules: DuelRules): DuelAction | null {
  if (gap > target + 1.6 && me.ink >= rules.DASH_INK + 20) return { type: 'dash', dir: 'in' };
  if (gap > target + 0.25) return { type: 'step', dir: 'in' };
  if (gap < target - 0.25) return { type: 'step', dir: 'out' };
  return null;
}

/** True when the fighter cannot step further away (back to the wall). */
export function atWall(f: Pick<Fighter, 'x' | 'facing'>, rules: DuelRules): boolean {
  return f.x * -f.facing >= rules.STAGE_HALF - 0.3;
}

/** The AI's action for this tick. Call once per tick, before stepDuel. */
export function aiAct(ai: AiController, duel: Duel): DuelAction | null {
  const { state, rules } = duel;
  const { style, rng, mem } = ai;
  const me = state.fighters[ai.who];
  const foe = state.fighters[ai.who === 0 ? 1 : 0];
  const gap = Math.abs(foe.x - me.x);

  if (state.phase !== 'fight') {
    mem.lastPhase = state.phase;
    return null;
  }
  // New exchange (start or after a point): roll when to press.
  if (mem.pressAt < 0 || mem.lastPhase !== 'fight') {
    mem.pressAt = state.tick + rollTicks(rng, style.pressMinMs, style.pressMaxMs, rules);
    mem.feintDropAt = -1;
    mem.feintFollow = null;
  }
  mem.lastPhase = 'fight';

  // A feint in progress: drop the shown line on time.
  if (me.strike && mem.feintDropAt >= 0 && state.tick >= mem.feintDropAt && me.stun === 0) {
    mem.feintDropAt = -1;
    mem.feints++;
    return { type: 'feint' };
  }

  // Riposte after our parry: a full-telegraph cut still lands inside the stun.
  if (me.riposte > 0 && canAct(me) && style.riposte !== false && state.tick >= mem.calmUntil) {
    const k = pickKind(rng, { cut: 1, overhead: 0, rising: 0, thrust: 1 }, gap, rules);
    if (gap <= reachOf(k, rules)) {
      const line = telegraphSegment(k, me, rng.next(), rules);
      if (me.ink >= inkCost(k, segLength(line), AI_STROKE_SPEED, rules)) {
        return strokeAction(k, line, realWindup(REAL_LINE_FLOOR_MS, rules));
      }
    }
  }

  // The player's line: judge it once, answer after the reaction window.
  const t = foe.strike;
  if (t && t.startTick !== mem.judged) {
    mem.judged = t.startTick;
    mem.foeLastKind = t.kind;
    mem.chained = !style.cutsFirst && mem.foeLastStrike >= 0 && t.startTick - mem.foeLastStrike <= msToTicks(CHAIN_MS, rules);
    mem.foeLastStrike = t.startTick;
    // A chained stroke is always cut (the rng is still rolled, so other rolls stay the same).
    mem.willParry = threatens(t, gap, rules) && (rng.next() < style.parryChance || mem.chained);
    mem.parryAt = t.startTick + msToTicks(style.reactionMs, rules);
  }
  // Oro: a line out of reach when it appeared is cut once it comes into reach.
  if (t && style.cutsFirst && !mem.willParry && mem.judged === t.startTick && threatens(t, gap, rules) && t.landsAtTick > state.tick) {
    mem.willParry = rng.next() < style.parryChance;
  }
  const freeToParry = style.cutsFirst || mem.chained ? me.stun === 0 && me.recover === 0 && me.dip === 0 && me.strike === null : canAct(me);
  if (t && mem.willParry && mem.judged === t.startTick && state.tick >= mem.parryAt && freeToParry) {
    mem.willParry = false;
    if (mem.chained) mem.calmUntil = state.tick + msToTicks(rules.RIPOSTE_MS, rules) + 1;
    return strokeAction('cut', parryCutAcross(t.segment));
  }
  // Oro waits to cut a judged player line; he never starts his own press over it (his tell).
  if (t && (style.cutsFirst || mem.chained) && mem.willParry && mem.judged === t.startTick) return null;

  if (!canAct(me)) return null;

  // Follow-up strike after a feint: the real line, short telegraph.
  if (mem.feintFollow) {
    const k = mem.feintFollow;
    // 'other': first take this kind's own gap (a different place from the shown line).
    if (style.feintFollow === 'other' && state.tick < mem.feintFollowUntil) {
      const move = moveToward(me, gap, reachOf(k, rules) - 0.4, rules);
      if (move) return move;
    }
    mem.feintFollow = null;
    // 'other' given up (out of reach or ink): a fresh quiet time, so the next attack is a new one.
    if (style.feintFollow === 'other') mem.pressAt = state.tick + rollTicks(rng, style.pressMinMs, style.pressMaxMs, rules);
    const line = telegraphSegment(k, me, rng.next(), rules);
    if (gap <= reachOf(k, rules) && me.ink >= inkCost(k, segLength(line), AI_STROKE_SPEED, rules)) {
      mem.pressAt = state.tick + rollTicks(rng, style.pressMinMs, style.pressMaxMs, rules);
      return strokeAction(k, line, realWindup(style.feintStrikeMs, rules));
    }
  }

  // Being mashed: the player attacked within CHAIN_MS. Oro is left as he is.
  const mashed = !style.cutsFirst && mem.foeLastStrike >= 0 && state.tick - mem.foeLastStrike <= msToTicks(CHAIN_MS, rules);
  // Dip when a mashing player dips, so its fresh ink never meets this master dipping.
  if (mashed && foe.dip > 0 && me.ink < MASH_DIP_BELOW) return { type: 'dip' };

  // Low ink: back off out of reach, then dip.
  if (me.ink < style.dipBelow) {
    if (gap > reachOf('thrust', rules) + 0.6 || foe.dip > 0 || atWall(me, rules)) return { type: 'dip' };
    return { type: 'step', dir: 'out' };
  }

  // Punish a dipping or stunned player.
  const open = style.riposte !== false && state.tick >= mem.calmUntil && (foe.dip > 0 || foe.stun > 0);

  if (state.tick >= mem.pressAt + (mashed ? msToTicks(MASH_PRESS_EXTRA_MS, rules) : 0) || open) {
    let kind = pickKind(rng, style.kinds, gap, rules);
    // The mirror: answer with the player's own last kind when it reaches.
    if (style.mirror && mem.foeLastKind && reachOf(mem.foeLastKind, rules) >= gap && rng.next() < style.mirror) kind = mem.foeLastKind;
    const reach = reachOf(kind, rules);
    if (gap > reach - 0.15) return moveToward(me, gap, reach - 0.4, rules) ?? { type: 'step', dir: 'in' };
    const line = telegraphSegment(kind, me, rng.next(), rules);
    // Too little ink for this stroke: back off, and dip with its back to the wall
    // (a master with a low dipBelow otherwise stepped into the wall forever).
    if (me.ink < inkCost(kind, segLength(line), AI_STROKE_SPEED, rules)) return atWall(me, rules) ? { type: 'dip' } : { type: 'step', dir: 'out' };
    // Against a masher: one slow committed line, no feint.
    const windup = Math.max(mashed ? MASH_LINE_MS : 0, realWindup(style.windupMs + rng.next() * style.windupJitterMs, rules));
    if (rng.next() < style.feintChance && !mashed) {
      mem.feintDropAt = state.tick + Math.max(1, msToTicks(style.feintDropMs, rules));
      mem.feintFollow = style.feintFollow === 'other' ? otherKind(rng, style.kinds, kind) : pickKind(rng, style.kinds, gap, rules);
      mem.feintFollowUntil = mem.feintDropAt + msToTicks(FEINT_FOLLOW_MOVE_MS, rules);
      // The shown line must outlast the drop by the whole parry window, so a fake
      // line is never parryable.
      return strokeAction(kind, line, fakeWindup(windup, style.feintDropMs, rules));
    }
    mem.pressAt = state.tick + rollTicks(rng, style.pressMinMs, style.pressMaxMs, rules);
    return strokeAction(kind, line, windup);
  }

  // Between attacks: hold the gap.
  return moveToward(me, gap, style.holdGap, rules);
}

// ---------------------------------------------------------------------------
// Scripted reference player (fighter 0 in the tuning duels).

export interface RefPlayerOptions {
  /** Chance it reads a line in time and tries to parry it (0..1). */
  skill: number;
  /** Its reaction time to a new line is rolled between these, ms. Lines that land sooner are missed. */
  reactMinMs: number;
  reactMaxMs: number;
  /** Chance per tick that it attacks when the foe is idle and in cut reach. */
  attackRate: number;
  /** Gap it drifts back to. */
  holdGap: number;
}

export const REF_PLAYER: RefPlayerOptions = { skill: 0.7, reactMinMs: 180, reactMaxMs: 450, attackRate: 0.004, holdGap: 2.4 };

/** A slower reference player: same skill, reactions of 250 to 550 ms, nearer a typical human. */
export const REF_PLAYER_SLOW: RefPlayerOptions = { ...REF_PLAYER, reactMinMs: 250, reactMaxMs: 550 };

export interface RefPlayer {
  opts: RefPlayerOptions;
  rng: Rng;
  judged: number;
  parryAt: number;
  willParry: boolean;
}

export function createRefPlayer(opts: RefPlayerOptions, seed: number): RefPlayer {
  return { opts, rng: createRng((seed * 2654435761) >>> 0), judged: -1, parryAt: 0, willParry: false };
}

/** The reference player's action as fighter `who`: parries lines it reads in time, ripostes, attacks now and then, dips when dry. */
export function refPlayerAct(p: RefPlayer, duel: Duel, who: 0 | 1): DuelAction | null {
  const { state, rules } = duel;
  if (state.phase !== 'fight') return null;
  const me = state.fighters[who];
  const foe = state.fighters[who === 0 ? 1 : 0];
  const gap = Math.abs(foe.x - me.x);
  const cut = (seg: Segment): DuelAction => ({ type: 'stroke', kind: 'cut', speed: 25, segment: seg, length: segLength(seg) });

  const t = foe.strike;
  if (t && t.startTick !== p.judged) {
    p.judged = t.startTick;
    p.willParry = threatens(t, gap, rules) && p.rng.next() < p.opts.skill;
    p.parryAt = t.startTick + rollTicks(p.rng, p.opts.reactMinMs, p.opts.reactMaxMs, rules);
  }
  if (t && p.willParry && p.judged === t.startTick && state.tick >= p.parryAt && canAct(me)) {
    // Too early for the window: wait for it.
    const msLeft = (t.landsAtTick - state.tick) * (1000 / rules.TICK_HZ);
    if (msLeft <= rules.PARRY_WINDOW_MS) {
      p.willParry = false;
      return cut(parryCutAcross(t.segment));
    }
    return null;
  }
  if (!canAct(me)) return null;
  if (me.riposte > 0 && gap <= rules.REACH_CUT) return cut(telegraphSegment('cut', me, 0.5, rules));
  if (t) return null;
  if (me.ink < 25) {
    if (gap > rules.REACH_THRUST + 0.6 || atWall(me, rules)) return { type: 'dip' };
    return { type: 'step', dir: 'out' };
  }
  if (foe.dip > 0 || foe.stun > 0) {
    if (gap <= rules.REACH_CUT - 0.1) return cut(telegraphSegment('cut', me, 0.5, rules));
    return { type: 'step', dir: 'in' };
  }
  if (gap <= rules.REACH_CUT - 0.1 && p.rng.next() < p.opts.attackRate) return cut(telegraphSegment('cut', me, 0.5, rules));
  return moveToward(me, gap, p.opts.holdGap, rules);
}

export interface SimResult {
  winner: 0 | 1 | null;
  ticks: number;
  score: [number, number];
  feints: number;
  parries: [number, number];
}

/** One deterministic duel: reference player as fighter 0, the AI style as fighter 1. Stops at the win or at maxTicks. */
export function simulateDuel(seed: number, style: AiStyle, player: RefPlayerOptions = REF_PLAYER, maxTicks = 60 * 600): SimResult {
  const duel = createDuel(seed);
  const ai = createAi(style, 1, seed);
  const bot = createRefPlayer(player, seed);
  const parries: [number, number] = [0, 0];
  while (duel.state.phase !== 'over' && duel.state.tick < maxTicks) {
    const ev = stepDuel(duel, [refPlayerAct(bot, duel, 0), aiAct(ai, duel)]);
    for (const e of ev) if (e.type === 'parry') parries[e.who]++;
  }
  return { winner: duel.state.winner, ticks: duel.state.tick, score: [duel.state.score[0], duel.state.score[1]], feints: ai.mem.feints, parries };
}
