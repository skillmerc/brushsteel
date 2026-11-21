// The playable loop without the DOM: one duel against one master,
// the player's keys and drawn strokes turned into duel actions, the AI, the
// duel timer, pose choice for the figures, and a scripted demo pilot for CI.
// Pure TypeScript: unit-tested with node --test (src/input/match.test.ts).
//
// Frames. The duel's stage frame has x as the fighters and y up with y 0 on
// the ground (the AI's telegraph lines sit at y 0.3 to 2.9, sword height for a
// figure about 2.45 tall). The render world puts the ground at GROUND_WORLD_Y,
// so world y = stage y + GROUND_WORLD_Y. Screen points go through the camera
// frustum into world units and then into the stage frame, so the player's line
// and the foe's line are compared in one frame.

import {
  DUEL_RULES,
  canAct,
  createDuel,
  stepDuel,
  strokeSpeedToStage,
  segmentsCross,
  reachOf,
  type AttackKind,
  type Duel,
  type DuelAction,
  type DuelEvent,
  type Fighter,
  type FighterMods,
  type Segment,
  type Vec2,
} from '../core/duel.js';
import { STYLES, aiAct, createAi, parryCutAcross, telegraphSegment, type AiController, type AiStyle } from '../core/ai.js';
import { choosePose, type PoseName } from '../core/figure.js';
import { createRng, type Rng } from '../core/rng.js';
import { classifyStroke, type StrokePoint, type StrokeResult } from './strokes.js';

/** World y of the stage ground (render/figure.ts GROUND_Y; the figures stand on it). */
export const GROUND_WORLD_Y = -1.2;
export const PLAYER = 0;
export const FOE = 1;

/** Canvas size in CSS px and the camera frustum (world units) it shows. */
export interface View {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function pxPerUnit(v: View): number {
  return v.width / (v.right - v.left);
}

/** Classifier scale: 1 at 80 px per stage unit (1280 px across 16 units). */
export function classifierScale(v: View): number {
  return pxPerUnit(v) / DUEL_RULES.PX_PER_UNIT;
}

/** Screen point (CSS px, y down) to the duel's stage frame (y up, 0 on the ground). Writes into out. */
export function screenToStage(px: number, py: number, v: View, out: Vec2 = { x: 0, y: 0 }): Vec2 {
  out.x = v.left + (px / v.width) * (v.right - v.left);
  out.y = v.top - (py / v.height) * (v.top - v.bottom) - GROUND_WORLD_Y;
  return out;
}

/** Stage point to screen CSS px. */
export function stageToScreen(x: number, y: number, v: View, out: Vec2 = { x: 0, y: 0 }): Vec2 {
  out.x = ((x - v.left) / (v.right - v.left)) * v.width;
  out.y = ((v.top - (y + GROUND_WORLD_Y)) / (v.top - v.bottom)) * v.height;
  return out;
}

/**
 * Classify a drawn stroke (CSS px) and turn it into a duel action for `me`.
 * Passes the path length and the speed in stage units.
 * Returns a null action for 'none'.
 */
export function strokeToAction(points: readonly StrokePoint[], v: View, me: Pick<Fighter, 'x'>, foe: Pick<Fighter, 'x'>): { result: StrokeResult; action: DuelAction | null } {
  const scale = classifierScale(v);
  const result = classifyStroke(points, { foeSide: foe.x > me.x ? 'right' : 'left', scale });
  if (result.kind === 'none') return { result, action: null };
  const segment: Segment = {
    a: screenToStage(result.start.x, result.start.y, v),
    b: screenToStage(result.end.x, result.end.y, v),
  };
  return {
    result,
    action: {
      type: 'stroke',
      kind: result.kind,
      speed: strokeSpeedToStage(result.speed, scale),
      segment,
      length: result.length / pxPerUnit(v),
    },
  };
}

export interface Keys {
  /** A held (move left on screen). */
  left: boolean;
  /** D held (move right on screen). */
  right: boolean;
  /** Shift held: moves are dashes. */
  dash: boolean;
  /** S held: dip while the meter is not full. */
  dip: boolean;
}

export interface MatchStats {
  /** Player strokes sent to the duel (not 'none'). */
  strokes: number;
  /** Player strokes the classifier read as 'none'. */
  misses: number;
  /** Parries by fighter. */
  parries: [number, number];
  clashes: number;
  /** Events of kind 'strike' by fighter. */
  strikes: [number, number];
}

export interface Match {
  duel: Duel;
  ai: AiController;
  style: AiStyle;
  seed: number;
  keys: Keys;
  /** Live stroke being drawn (CSS px and ms). The render draws it as the ink trail. */
  live: StrokePoint[];
  drawing: boolean;
  /** Last released stroke's classification, for feedback. */
  lastResult: StrokeResult | null;
  /** A player stroke waiting for the next tick. */
  queued: DuelAction | null;
  queuedAge: number;
  /** Seconds not yet simulated. */
  acc: number;
  /** Ticks of play until the duel ended (the result-screen timer). */
  ticksFought: number;
  wasHit: [boolean, boolean];
  last: [AttackKind | 'feint' | null, AttackKind | 'feint' | null];
  /** The last strike of each fighter was a backhand cut (drawn away from the foe). */
  lastBack: [boolean, boolean];
  /** Segment of each fighter's latest pending strike (kept after it lands, for spray direction). */
  strikeLine: [Segment | null, Segment | null];
  /** The foe line each fighter last parried (parry pose height). */
  parryLine: [Segment | null, Segment | null];
  stats: MatchStats;
  /** Events of the last stepMatch call (reused array). */
  events: DuelEvent[];
  /** Optional scripted player (CI demo). Called once per tick before the actions. */
  pilot: ((m: Match) => void) | null;
  /** A named photo hold set by the demo pilot (CI shots): the match stops ticking until cleared. */
  hold: string | null;
}

export const TICK_S = 1 / DUEL_RULES.TICK_HZ;
/** Most ticks simulated in one frame (a 250 ms frame on a slow machine still advances in real time). */
export const MAX_TICKS_PER_FRAME = 15;
/** A stroke released mid-step waits this many ticks for the step to finish. */
const QUEUE_TICKS = 10;

/** Master 1, the first opponent. */
export const MASTER_1: AiStyle = STYLES.patient;

/** Mods (Path mode seals and brush) go to createDuel; without them the duel is the plain one. */
export function createMatch(seed: number, style: AiStyle = MASTER_1, mods?: [FighterMods | null, FighterMods | null]): Match {
  return {
    duel: mods ? createDuel(seed, { mods }) : createDuel(seed),
    ai: createAi(style, FOE, seed),
    style,
    seed,
    keys: { left: false, right: false, dash: false, dip: false },
    live: [],
    drawing: false,
    lastResult: null,
    queued: null,
    queuedAge: 0,
    acc: 0,
    ticksFought: 0,
    wasHit: [false, false],
    last: [null, null],
    lastBack: [false, false],
    strikeLine: [null, null],
    parryLine: [null, null],
    stats: { strokes: 0, misses: 0, parries: [0, 0], clashes: 0, strikes: [0, 0] },
    events: [],
    pilot: null,
    hold: null,
  };
}

// Constant actions: no allocation per tick.
const DIP: DuelAction = { type: 'dip' };
const STEP_IN: DuelAction = { type: 'step', dir: 'in' };
const STEP_OUT: DuelAction = { type: 'step', dir: 'out' };
const DASH_IN: DuelAction = { type: 'dash', dir: 'in' };
const DASH_OUT: DuelAction = { type: 'dash', dir: 'out' };

/** Start a stroke at a point (pointer down). */
export function beginStroke(m: Match, p: StrokePoint): void {
  m.live.length = 0;
  m.live.push(p);
  m.drawing = true;
}

/** Add a point to the live stroke (pointer move). */
export function extendStroke(m: Match, p: StrokePoint): void {
  if (m.drawing) m.live.push(p);
}

/** Release: classify the live stroke and queue its action. Returns the classification. */
export function finishStroke(m: Match, v: View): StrokeResult | null {
  if (!m.drawing) return null;
  m.drawing = false;
  if (m.duel.state.phase === 'over') return null;
  const [me, foe] = m.duel.state.fighters;
  const { result, action } = strokeToAction(m.live, v, me, foe);
  m.lastResult = result;
  if (action) {
    m.queued = action;
    m.queuedAge = 0;
    m.stats.strokes++;
  } else {
    m.stats.misses++;
  }
  return result;
}

/** The player's action this tick from the queue and the held keys. */
export function playerAction(m: Match): DuelAction | null {
  const me = m.duel.state.fighters[PLAYER];
  if (m.queued) {
    // Let a step finish first (a stroke released mid-step would fizzle as busy).
    if (me.moveTicks > 0 && m.queuedAge < QUEUE_TICKS) {
      m.queuedAge++;
      return null;
    }
    const a = m.queued;
    m.queued = null;
    return a;
  }
  if (!canAct(me)) return null;
  const k = m.keys;
  if (k.dip && me.ink < m.duel.rules.INK_MAX) return DIP;
  if (k.left !== k.right) {
    const screenDir = k.right ? 1 : -1;
    const inward = screenDir === me.facing;
    if (k.dash) return inward ? DASH_IN : DASH_OUT;
    return inward ? STEP_IN : STEP_OUT;
  }
  return null;
}

/** Advance the match by dt seconds (fixed 60 Hz ticks). Returns the events (reused array). */
export function stepMatch(m: Match, dt: number): DuelEvent[] {
  const ev = m.events;
  ev.length = 0;
  m.acc = Math.min(m.acc + Math.max(0, dt), MAX_TICKS_PER_FRAME * TICK_S);
  while (m.acc >= TICK_S - 1e-9 && !m.hold) {
    m.acc -= TICK_S;
    tick(m, ev);
  }
  if (m.hold) m.acc = 0;
  return ev;
}

/** One duel tick with both fighters' actions. */
export function tick(m: Match, ev: DuelEvent[]): void {
  const s = m.duel.state;
  if (m.pilot) m.pilot(m);
  const a = playerAction(m);
  const b = aiAct(m.ai, m.duel);
  const f0 = s.fighters[0];
  const f1 = s.fighters[1];
  // Lines pending before the tick: a parry this tick cancels the foe's strike.
  const line0 = f0.strike ? f0.strike.segment : null;
  const line1 = f1.strike ? f1.strike.segment : null;
  const out = stepDuel(m.duel, [a, b]);
  for (const e of out) {
    ev.push(e);
    switch (e.type) {
      case 'strike': {
        m.stats.strikes[e.who]++;
        m.last[e.who] = e.kind;
        const f = s.fighters[e.who];
        if (f.strike) {
          m.strikeLine[e.who] = f.strike.segment;
          m.lastBack[e.who] = f.strike.kind === 'cut' && isBackhand(f.strike.segment, f.facing);
        }
        break;
      }
      case 'feint':
        m.last[e.who] = 'feint';
        break;
      case 'parry':
        m.stats.parries[e.who]++;
        m.parryLine[e.who] = e.who === 0 ? line1 : line0;
        break;
      case 'clash':
        m.stats.clashes++;
        break;
      case 'hit':
        m.wasHit[e.who === 0 ? 1 : 0] = true;
        break;
      case 'resume':
        m.wasHit[0] = false;
        m.wasHit[1] = false;
        break;
      default:
        break;
    }
  }
  if (s.phase !== 'over') m.ticksFought++;
}

/** Duel time in seconds (stops when the duel ends). */
export function duelSeconds(m: Match): number {
  return m.ticksFought * TICK_S;
}

/** "m:ss" for the result screen. */
export function formatClock(seconds: number): string {
  const t = Math.max(0, Math.floor(seconds));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

/** A cut drawn away from the foe: the blade travels back toward the striker. */
export function isBackhand(seg: Segment, facing: 1 | -1): boolean {
  return (seg.b.x - seg.a.x) * facing < 0;
}

const SWAP_CUT: Partial<Record<PoseName, PoseName>> = { windup_cut: 'strike_cut', strike_cut: 'windup_cut' };

/**
 * The figure pose for a fighter: choosePose plus duel-loop fixes. A backhand
 * cut winds up where a forehand ends and ends where it winds up. A move away from the foe never shows the lunging step or dash:
 * a retreat step is idle, a retreat dash is the guarded parry stance
 *.
 */
export function poseFor(m: Match, who: 0 | 1): PoseName {
  const s = m.duel.state;
  const f = s.fighters[who];
  const p = choosePose(f, s.tick, {
    phase: s.phase,
    lost: s.phase === 'over' && s.winner !== who,
    wasHit: m.wasHit[who],
    last: m.last[who],
  });
  const back = f.strike ? f.strike.kind === 'cut' && isBackhand(f.strike.segment, f.facing) : f.stance === 'recover' && m.lastBack[who];
  if (back && SWAP_CUT[p]) return SWAP_CUT[p] as PoseName;
  if ((p === 'step' || p === 'dash') && f.moveDx * f.facing < 0) return p === 'dash' ? 'parry' : 'idle';
  return p;
}

/**
 * Parry pose height: radians to add to the sword's
 * angle so the blade tilts toward the parried line. Lines sit at stage y 0.3
 * (knee) to 2.9 (over the head); the base parry pose holds the sword up at
 * 95 degrees, which meets a line at about y 1.6.
 */
export function parrySwordTilt(line: Segment | null): number {
  if (!line) return 0;
  const mid = (line.a.y + line.b.y) / 2;
  return Math.max(-1.3, Math.min(0.35, (mid - 1.6) * 0.6));
}

// ------------------------------------------------------------------ demo pilot

/** Demo pace: master 1's style with a short quiet time, so a CI clip shows three exchanges. */
export const DEMO_STYLE: AiStyle = { ...MASTER_1, name: 'patient (demo pace)', pressMinMs: 1200, pressMaxMs: 2000 };

const SLASHES: readonly string[] = ['cut', 'overhead', 'rising'];
/** How long a scripted stroke takes to draw, ms. */
export const DEMO_DRAW_MS = 90;
/** Release this long before the foe's strike lands (inside the 300 ms parry window). */
const DEMO_PARRY_LEAD_MS = 200;

interface Plan {
  points: StrokePoint[];
  next: number;
  parry: boolean;
}

/** Points along a stage segment as a hand-drawn stroke (CSS px, ms), with a slight bow. */
export function scriptStroke(seg: Segment, v: View, t0: number, rng: Rng, drawMs = DEMO_DRAW_MS): StrokePoint[] {
  const a = stageToScreen(seg.a.x, seg.a.y, v);
  const b = stageToScreen(seg.b.x, seg.b.y, v);
  const n = 12;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const bow = (rng.next() - 0.5) * 0.06 * len;
  const out: StrokePoint[] = [];
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    const e = u * u * (3 - 2 * u); // slow start and end
    const off = Math.sin(Math.PI * e) * bow;
    out.push({ x: a.x + dx * e - (dy / len) * off, y: a.y + dy * e + (dx / len) * off, t: t0 + u * drawMs });
  }
  return out;
}

/**
 * Pick a scripted stroke the classifier reads as a slash. For a parry it must
 * also cross `line`; candidates turn the cut across the line by up to 40
 * degrees either way and try both directions.
 */
function pickStroke(base: Segment, v: View, me: Fighter, foe: Fighter, t0: number, rng: Rng, line: Segment | null, minReach: number): StrokePoint[] | null {
  const mx = (base.a.x + base.b.x) / 2;
  const my = (base.a.y + base.b.y) / 2;
  const hx = (base.b.x - base.a.x) / 2;
  const hy = (base.b.y - base.a.y) / 2;
  const turns = [0, 0.35, -0.35, 0.7, -0.7];
  for (const dir of [1, -1]) {
    for (const t of turns) {
      const c = Math.cos(t);
      const s = Math.sin(t);
      const rx = (hx * c - hy * s) * dir;
      const ry = (hx * s + hy * c) * dir;
      const seg: Segment = { a: { x: mx - rx, y: my - ry }, b: { x: mx + rx, y: my + ry } };
      const pts = scriptStroke(seg, v, t0, rng);
      const { result, action } = strokeToAction(pts, v, me, foe);
      if (!action || action.type !== 'stroke' || !SLASHES.includes(result.kind)) continue;
      if (line && !segmentsCross(action.segment, line)) continue;
      if (!line && reachOf(result.kind as AttackKind) < minReach) continue;
      return pts;
    }
  }
  return null;
}

/** Ticks after a hit at which the demo's hit photo is held (spray has flown about 150 ms). */
const PHOTO_HIT_TICKS = 9;

export interface DemoPilot {
  (m: Match): void;
  /** Photo holds taken so far (names). */
  photos: string[];
  /** Exchanges the pilot answered: parry strokes drawn, ripostes drawn. */
  stats: { parryStrokes: number; riposteStrokes: number };
}

/**
 * Scripted player for the CI duel (?demo=duel): reads each telegraph, draws a
 * stroke across it in the parry window, then ripostes with a cut. Strokes are
 * drawn point by point into m.live over DEMO_DRAW_MS of duel time and go
 * through the classifier like mouse strokes.
 */
export function createDemoPilot(getView: () => View, seed = 1, photos = false): DemoPilot {
  const rng = createRng(seed >>> 0);
  let plan: Plan | null = null;
  let answered = -1;
  let riposted = -1;
  const stats = { parryStrokes: 0, riposteStrokes: 0 };
  const taken: string[] = [];
  let dashed = false;
  let hitTick = -1;
  const photo = (m: Match, name: string) => {
    if (!photos || taken.includes(name)) return;
    taken.push(name);
    m.hold = name;
  };
  const tickMs = 1000 / DUEL_RULES.TICK_HZ;
  const pilot = ((m: Match) => {
    const s = m.duel.state;
    const now = s.tick * tickMs;
    const v = getView();
    m.keys.dash = m.keys.left = m.keys.right = false;
    // Hit photo: the first close hit (gap 1.6 or less), else the last; held ~150 ms after the hit.
    if (s.phase !== 'fight' && hitTick < 0) hitTick = s.tick;
    if (s.phase === 'fight') hitTick = -1;
    if (hitTick >= 0 && s.tick - hitTick === PHOTO_HIT_TICKS) {
      const gap = Math.abs(s.fighters[1].x - s.fighters[0].x);
      if (gap <= 1.6 || s.phase === 'over') photo(m, 'hit');
    }
    if (plan) {
      while (plan.next < plan.points.length && plan.points[plan.next].t <= now) {
        const p = plan.points[plan.next++];
        if (plan.next === 1) beginStroke(m, p);
        else extendStroke(m, p);
        // Parry photo: the first parry stroke half drawn across the foe's line.
        if (plan.parry && plan.next === Math.ceil(plan.points.length * 0.6)) photo(m, 'parry');
      }
      if (plan.next >= plan.points.length) {
        finishStroke(m, v);
        plan = null;
      }
      return;
    }
    if (s.phase !== 'fight') return;
    const me = s.fighters[PLAYER];
    const foe = s.fighters[FOE];
    // Close photo: the fighters overlap after the last-exchange dash.
    if (dashed && Math.abs(foe.x - me.x) <= 1.6 && me.moveTicks === 0) photo(m, 'close');
    const st = foe.strike;
    if (st && st.startTick !== answered && (st.landsAtTick - s.tick) * tickMs <= DEMO_PARRY_LEAD_MS + DEMO_DRAW_MS) {
      answered = st.startTick;
      const pts = pickStroke(parryCutAcross(st.segment, 0.9), v, me, foe, now, rng, st.segment, 0);
      if (pts) {
        plan = { points: pts, next: 0, parry: true };
        stats.parryStrokes++;
      }
      return;
    }
    if (me.riposte > 0 && riposted !== m.stats.parries[PLAYER] && canAct(me)) {
      riposted = m.stats.parries[PLAYER];
      const gap = Math.abs(foe.x - me.x);
      const pts = pickStroke(telegraphSegment('cut', me), v, me, foe, now, rng, null, gap);
      if (pts) {
        plan = { points: pts, next: 0, parry: false };
        stats.riposteStrokes++;
      }
      return;
    }
    // Last exchange: dash in close once, so the fighters overlap.
    if (!dashed && s.score[PLAYER] === m.duel.rules.HITS_TO_WIN - 1 && !st && canAct(me) && Math.abs(foe.x - me.x) > 1.6) {
      dashed = true;
      m.keys.dash = true;
      if (foe.x > me.x) m.keys.right = true;
      else m.keys.left = true;
    }
  }) as DemoPilot;
  pilot.stats = stats;
  pilot.photos = taken;
  return pilot;
}
