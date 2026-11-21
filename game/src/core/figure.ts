// Fighter figure maths, DOM-free so node tests can import it.
// A 14-bone 2D skeleton, poses as joint-angle data (JSON-shaped, degrees),
// spring tweening of the joint angles, forward kinematics with grounding and
// facing, and robe, sash and hair as verlet chains. render/figure.ts draws it.
//
// Conventions: stage units (1 unit is about 0.7 m), y up. Poses are authored
// facing right (+x). Pose angles are absolute degrees: 0 points forward
// (toward the foe), 90 up, -90 down, 180 back. They become local radians
// (relative to the parent bone) once at load; springs tween the local angles,
// so children follow their parents. Facing -1 mirrors x around the fighter.
//
// No allocation in stepFigure: every buffer is a typed array made at create.

import { DUEL_RULES, msToTicks, type AttackKind, type Fighter, type Phase } from './duel.js';

export interface BoneDef {
  name: string;
  /** Index of the parent bone, -1 for the root. Parents come before children. */
  parent: number;
  /** Stage units. */
  length: number;
  /** Where the bone starts on its parent: the parent's end (usual) or its start (legs on the hips). */
  attach: 'end' | 'start';
}

export const BONES: readonly BoneDef[] = [
  { name: 'hips', parent: -1, length: 0.25, attach: 'end' },
  { name: 'spine', parent: 0, length: 0.45, attach: 'end' },
  { name: 'chest', parent: 1, length: 0.35, attach: 'end' },
  { name: 'neck', parent: 2, length: 0.12, attach: 'end' },
  { name: 'head', parent: 3, length: 0.28, attach: 'end' },
  { name: 'upperArmF', parent: 2, length: 0.36, attach: 'end' },
  { name: 'forearmF', parent: 5, length: 0.32, attach: 'end' },
  { name: 'upperArmB', parent: 2, length: 0.36, attach: 'end' },
  { name: 'forearmB', parent: 7, length: 0.32, attach: 'end' },
  { name: 'sword', parent: 6, length: 1.05, attach: 'end' },
  { name: 'thighF', parent: 0, length: 0.5, attach: 'start' },
  { name: 'shinF', parent: 10, length: 0.5, attach: 'end' },
  { name: 'thighB', parent: 0, length: 0.5, attach: 'start' },
  { name: 'shinB', parent: 12, length: 0.5, attach: 'end' },
];

export const BONE_COUNT = BONES.length;
export const BONE = {
  hips: 0, spine: 1, chest: 2, neck: 3, head: 4, upperArmF: 5, forearmF: 6, upperArmB: 7,
  forearmB: 8, sword: 9, thighF: 10, shinF: 11, thighB: 12, shinB: 13,
} as const;
export type BoneName = keyof typeof BONE;
/** Spring channels: one per bone angle, then the root's forward offset. */
export const CHANNELS = BONE_COUNT + 1;
const ROOT_X = BONE_COUNT;

export type PoseName =
  | 'idle' | 'step' | 'dash' | 'dip'
  | 'windup_cut' | 'strike_cut' | 'windup_overhead' | 'strike_overhead'
  | 'windup_rising' | 'strike_rising' | 'windup_thrust' | 'strike_thrust'
  | 'parry' | 'feint' | 'hit' | 'fall';

export interface PoseDef {
  /** Root (hips) offset toward the foe, stage units. */
  rootX: number;
  /** Spring angular frequency (rad/s) used while tweening into this pose. */
  omega: number;
  /** Spring damping ratio (1 = critically damped). */
  zeta: number;
  /** Absolute angle of each bone, degrees, facing right. */
  deg: Record<BoneName, number>;
}

const d = (
  hips: number, spine: number, chest: number, neck: number, head: number,
  upperArmF: number, forearmF: number, upperArmB: number, forearmB: number, sword: number,
  thighF: number, shinF: number, thighB: number, shinB: number,
): Record<BoneName, number> => ({ hips, spine, chest, neck, head, upperArmF, forearmF, upperArmB, forearmB, sword, thighF, shinF, thighB, shinB });

/**
 * The pose table. Plain JSON-shaped data (numbers only), so it can move to a
 * .json file or be tuned by hand. Column order of d(): hips, spine, chest,
 * neck, head, upperArmF, forearmF, upperArmB, forearmB, sword, thighF, shinF,
 * thighB, shinB.
 */
export const POSES: Record<PoseName, PoseDef> = {
  idle: { rootX: 0, omega: 16, zeta: 0.9, deg: d(90, 92, 95, 95, 85, -60, 10, -70, 20, 35, -70, -95, -115, -100) },
  step: { rootX: 0.1, omega: 22, zeta: 0.9, deg: d(90, 90, 93, 92, 85, -55, 15, -65, 25, 30, -55, -85, -125, -110) },
  dash: { rootX: 0.2, omega: 26, zeta: 0.85, deg: d(80, 75, 70, 75, 80, -80, -30, -100, -40, -160, -35, -95, -140, -150) },
  dip: { rootX: 0, omega: 12, zeta: 0.95, deg: d(85, 70, 55, 40, 20, -100, -110, -80, -70, -120, -5, -92, -95, -175) },
  windup_cut: { rootX: -0.1, omega: 14, zeta: 0.9, deg: d(90, 100, 110, 100, 88, -140, 150, -120, 160, 170, -65, -90, -120, -105) },
  strike_cut: { rootX: 0.35, omega: 34, zeta: 0.8, deg: d(85, 80, 75, 80, 85, -5, 0, -20, -5, 0, -45, -88, -135, -120) },
  windup_overhead: { rootX: -0.05, omega: 14, zeta: 0.9, deg: d(90, 95, 100, 95, 85, 100, 130, 110, 135, 150, -70, -92, -115, -102) },
  strike_overhead: { rootX: 0.3, omega: 34, zeta: 0.8, deg: d(80, 70, 60, 70, 80, -20, -35, -30, -40, -40, -40, -90, -140, -125) },
  windup_rising: { rootX: -0.05, omega: 14, zeta: 0.9, deg: d(88, 85, 82, 85, 85, -110, -140, -100, -140, -150, -60, -100, -125, -110) },
  strike_rising: { rootX: 0.25, omega: 34, zeta: 0.8, deg: d(92, 100, 105, 98, 88, 40, 60, 30, 55, 70, -55, -88, -130, -115) },
  windup_thrust: { rootX: -0.15, omega: 14, zeta: 0.9, deg: d(88, 95, 100, 95, 85, -120, 5, -135, 10, 0, -60, -95, -125, -110) },
  strike_thrust: { rootX: 0.5, omega: 34, zeta: 0.8, deg: d(80, 70, 65, 70, 80, 0, 0, -10, 0, 2, -20, -80, -150, -160) },
  parry: { rootX: -0.05, omega: 30, zeta: 0.85, deg: d(92, 95, 97, 95, 88, -30, 60, -45, 50, 95, -75, -95, -110, -100) },
  feint: { rootX: 0.05, omega: 24, zeta: 0.85, deg: d(90, 96, 105, 100, 88, 20, 70, 10, 70, 110, -68, -94, -118, -104) },
  hit: { rootX: -0.2, omega: 28, zeta: 0.75, deg: d(100, 115, 125, 130, 125, -120, -80, 170, -170, -100, -80, -95, -105, -95) },
  fall: { rootX: -0.4, omega: 8, zeta: 0.95, deg: d(175, 178, 180, 180, 178, -175, 175, 160, 170, -20, 10, -5, -5, -10) },
};

export const POSE_NAMES = Object.keys(POSES) as PoseName[];

const DEG = Math.PI / 180;

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  else if (r > Math.PI) r -= 2 * Math.PI;
  return r;
}

const localCache = new Map<PoseName, Float32Array>();

/** Spring targets for a pose: local radians per bone (relative to the parent), then rootX. Cached; do not modify. */
export function poseTargets(name: PoseName): Float32Array {
  let t = localCache.get(name);
  if (t) return t;
  const p = POSES[name];
  t = new Float32Array(CHANNELS);
  for (let i = 0; i < BONE_COUNT; i++) {
    const b = BONES[i];
    const own = p.deg[b.name as BoneName] * DEG;
    const parent = b.parent < 0 ? 0 : p.deg[BONES[b.parent].name as BoneName] * DEG;
    t[i] = wrapAngle(own - parent);
  }
  t[ROOT_X] = p.rootX;
  localCache.set(name, t);
  return t;
}

// ---------------------------------------------------------------- chains

export interface ChainDef {
  name: string;
  /** Bone the chain hangs from, and the joint on it. */
  bone: number;
  at: 'start' | 'end';
  /** Anchor offset from that joint, facing right (x forward). */
  offX: number;
  offY: number;
  /** Points in the chain (the first is pinned to the anchor). */
  points: number;
  /** Rest length of each segment. */
  segment: number;
  /** Rest direction, facing right (unit-ish; normalised at create). */
  restX: number;
  restY: number;
  /** Pull toward the rest shape per substep, 0..1. Keeps cloth from folding flat. */
  shape: number;
  /** Velocity kept per substep. */
  damping: number;
}

export const CHAINS: readonly ChainDef[] = [
  { name: 'robeBack', bone: BONE.hips, at: 'start', offX: -0.1, offY: 0.08, points: 6, segment: 0.13, restX: -0.25, restY: -1, shape: 0.02, damping: 0.985 },
  { name: 'robeFront', bone: BONE.hips, at: 'start', offX: 0.1, offY: 0.08, points: 6, segment: 0.13, restX: 0.15, restY: -1, shape: 0.02, damping: 0.985 },
  { name: 'sash', bone: BONE.hips, at: 'end', offX: -0.12, offY: -0.05, points: 5, segment: 0.1, restX: -0.6, restY: -1, shape: 0.01, damping: 0.98 },
  { name: 'hair', bone: BONE.head, at: 'end', offX: -0.1, offY: -0.08, points: 6, segment: 0.09, restX: -0.8, restY: -1, shape: 0.015, damping: 0.975 },
];

export const FIGURE_PHYSICS = {
  /** Spring and verlet substep, seconds. */
  SUBSTEP: 1 / 120,
  /** Longest frame stepFigure accepts; longer frames are clamped (tab switch). */
  MAX_DT: 0.1,
  /** Stage units per s^2 (9.8 m/s^2 at 0.7 m per unit). */
  GRAVITY: 14,
  /** Wind gust strength, stage units per s^2, so cloth keeps moving when the body stops. */
  WIND: 2.5,
  /** Distance-constraint passes per substep. */
  ITERATIONS: 4,
  /** Breathing on the chest, radians and Hz. */
  BREATH_AMP: 0.02,
  BREATH_HZ: 0.35,
} as const;

// ---------------------------------------------------------------- state

export interface FigureState {
  /** Fighter x on the stage (the duel's x). */
  x: number;
  facing: 1 | -1;
  /** Ground height, stage y. */
  ground: number;
  pose: PoseName;
  omega: number;
  zeta: number;
  /** Current spring values: local bone angles (rad) then rootX. */
  value: Float32Array;
  velocity: Float32Array;
  target: Float32Array;
  /** World joints per bone: start x, start y, end x, end y. */
  joints: Float32Array;
  /** Absolute world angle per bone, already mirrored (radians). */
  angles: Float32Array;
  /** Chain points, x y pairs, and previous positions. Same order as CHAINS. */
  chains: Float32Array[];
  chainPrev: Float32Array[];
  time: number;
  /** Seconds since the last setPose that changed the pose. */
  poseTime: number;
}

export function createFigure(x: number, facing: 1 | -1, ground = 0, pose: PoseName = 'idle'): FigureState {
  const s: FigureState = {
    x, facing, ground, pose,
    omega: POSES[pose].omega,
    zeta: POSES[pose].zeta,
    value: new Float32Array(CHANNELS),
    velocity: new Float32Array(CHANNELS),
    target: new Float32Array(CHANNELS),
    joints: new Float32Array(BONE_COUNT * 4),
    angles: new Float32Array(BONE_COUNT),
    chains: CHAINS.map((c) => new Float32Array(c.points * 2)),
    chainPrev: CHAINS.map((c) => new Float32Array(c.points * 2)),
    time: 0,
    poseTime: 0,
  };
  snapPose(s, pose);
  return s;
}

/** Start tweening toward a pose. Calling it again with the same pose does nothing. */
export function setPose(s: FigureState, name: PoseName): void {
  if (s.pose === name) return;
  s.pose = name;
  s.omega = POSES[name].omega;
  s.zeta = POSES[name].zeta;
  s.target.set(poseTargets(name));
  s.poseTime = 0;
}

/** Jump to a pose with no tween, and lay the chains out at rest. */
export function snapPose(s: FigureState, name: PoseName): void {
  s.pose = name;
  s.omega = POSES[name].omega;
  s.zeta = POSES[name].zeta;
  s.target.set(poseTargets(name));
  s.value.set(s.target);
  s.velocity.fill(0);
  s.poseTime = 0;
  solveFigure(s);
  resetChains(s);
}

/**
 * Forward kinematics from the spring values: joints and angles in world
 * space, the lowest body joint (sword excluded) on the ground, mirrored for
 * facing -1.
 */
export function solveFigure(s: FigureState): void {
  const j = s.joints;
  const ang = s.angles;
  const v = s.value;
  const breath = FIGURE_PHYSICS.BREATH_AMP * Math.sin(2 * Math.PI * FIGURE_PHYSICS.BREATH_HZ * s.time);
  // Local frame first (facing right, root at (rootX, 0)).
  for (let i = 0; i < BONE_COUNT; i++) {
    const b = BONES[i];
    const local = v[i] + (i === BONE.chest ? breath : 0);
    let sx: number;
    let sy: number;
    if (b.parent < 0) {
      ang[i] = local;
      sx = v[ROOT_X];
      sy = 0;
    } else {
      ang[i] = ang[b.parent] + local;
      const p = b.parent * 4;
      sx = b.attach === 'end' ? j[p + 2] : j[p];
      sy = b.attach === 'end' ? j[p + 3] : j[p + 1];
    }
    const k = i * 4;
    j[k] = sx;
    j[k + 1] = sy;
    j[k + 2] = sx + b.length * Math.cos(ang[i]);
    j[k + 3] = sy + b.length * Math.sin(ang[i]);
  }
  let minY = Infinity;
  for (let i = 0; i < BONE_COUNT; i++) {
    if (i === BONE.sword) continue;
    const k = i * 4;
    if (j[k + 1] < minY) minY = j[k + 1];
    if (j[k + 3] < minY) minY = j[k + 3];
  }
  const dy = s.ground - minY;
  const f = s.facing;
  for (let i = 0; i < BONE_COUNT; i++) {
    const k = i * 4;
    j[k] = s.x + f * j[k];
    j[k + 1] += dy;
    j[k + 2] = s.x + f * j[k + 2];
    j[k + 3] += dy;
    // Mirror the angle: (cos, sin) -> (f cos, sin).
    if (f < 0) ang[i] = Math.PI - ang[i];
  }
}

function anchorOf(s: FigureState, c: ChainDef): { x: number; y: number } {
  const k = c.bone * 4 + (c.at === 'end' ? 2 : 0);
  anchorTmp.x = s.joints[k] + s.facing * c.offX;
  anchorTmp.y = s.joints[k + 1] + c.offY;
  return anchorTmp;
}
const anchorTmp = { x: 0, y: 0 };

function restDir(s: FigureState, c: ChainDef): { x: number; y: number } {
  const n = Math.hypot(c.restX, c.restY) || 1;
  restTmp.x = (s.facing * c.restX) / n;
  restTmp.y = c.restY / n;
  return restTmp;
}
const restTmp = { x: 0, y: 0 };

/** Lay every chain out along its rest direction, at rest. */
export function resetChains(s: FigureState): void {
  for (let ci = 0; ci < CHAINS.length; ci++) {
    const c = CHAINS[ci];
    const a = anchorOf(s, c);
    const ax = a.x;
    const ay = a.y;
    const r = restDir(s, c);
    const p = s.chains[ci];
    for (let i = 0; i < c.points; i++) {
      p[i * 2] = ax + r.x * c.segment * i;
      p[i * 2 + 1] = Math.max(s.ground, ay + r.y * c.segment * i);
    }
    s.chainPrev[ci].set(p);
  }
}

function stepChains(s: FigureState, h: number): void {
  const P = FIGURE_PHYSICS;
  const t = s.time;
  for (let ci = 0; ci < CHAINS.length; ci++) {
    const c = CHAINS[ci];
    const p = s.chains[ci];
    const q = s.chainPrev[ci];
    const a = anchorOf(s, c);
    const ax = a.x;
    const ay = a.y;
    const r = restDir(s, c);
    const rx = r.x;
    const ry = r.y;
    // Integrate the free points.
    for (let i = 1; i < c.points; i++) {
      const xi = i * 2;
      const wind = P.WIND * (0.6 * Math.sin(1.3 * t + i * 0.7 + ci * 1.9) + 0.4 * Math.sin(2.9 * t + i * 1.3 + ci * 0.6));
      const vx = (p[xi] - q[xi]) * c.damping;
      const vy = (p[xi + 1] - q[xi + 1]) * c.damping;
      q[xi] = p[xi];
      q[xi + 1] = p[xi + 1];
      p[xi] += vx + wind * h * h;
      p[xi + 1] += vy - P.GRAVITY * h * h;
      // Soft pull toward the rest shape.
      p[xi] += (ax + rx * c.segment * i - p[xi]) * c.shape;
      p[xi + 1] += (ay + ry * c.segment * i - p[xi + 1]) * c.shape;
    }
    // Pin the first point to the anchor.
    q[0] = p[0];
    q[1] = p[1];
    p[0] = ax;
    p[1] = ay;
    // Keep the segment lengths.
    for (let it = 0; it < P.ITERATIONS; it++) {
      for (let i = 1; i < c.points; i++) {
        const a0 = (i - 1) * 2;
        const b0 = i * 2;
        const dx = p[b0] - p[a0];
        const dy = p[b0 + 1] - p[a0 + 1];
        const dist = Math.hypot(dx, dy) || 1e-6;
        const diff = (dist - c.segment) / dist;
        if (i === 1) {
          p[b0] -= dx * diff;
          p[b0 + 1] -= dy * diff;
        } else {
          p[a0] += dx * diff * 0.5;
          p[a0 + 1] += dy * diff * 0.5;
          p[b0] -= dx * diff * 0.5;
          p[b0 + 1] -= dy * diff * 0.5;
        }
      }
      for (let i = 1; i < c.points; i++) if (p[i * 2 + 1] < s.ground) p[i * 2 + 1] = s.ground;
    }
  }
}

/** Advance springs, kinematics and chains by dt seconds. No allocation. */
export function stepFigure(s: FigureState, dt: number): void {
  const P = FIGURE_PHYSICS;
  const total = Math.min(P.MAX_DT, Math.max(0, dt));
  if (total <= 0) return;
  const n = Math.max(1, Math.ceil(total / P.SUBSTEP - 1e-9));
  const h = total / n;
  const w = s.omega;
  const k = w * w;
  const c = 2 * s.zeta * w;
  const v = s.value;
  const vel = s.velocity;
  const tg = s.target;
  for (let step = 0; step < n; step++) {
    for (let i = 0; i < CHANNELS; i++) {
      const err = i === ROOT_X ? tg[i] - v[i] : wrapAngle(tg[i] - v[i]);
      vel[i] += (k * err - c * vel[i]) * h;
      v[i] += vel[i] * h;
    }
    s.time += h;
    s.poseTime += h;
    solveFigure(s);
    stepChains(s, h);
  }
}

// ---------------------------------------------------------------- duel to pose

export interface PoseContext {
  phase?: Phase;
  /** This fighter lost the duel (phase 'over'). */
  lost?: boolean;
  /** This fighter was hit this point (phase 'point'); the duel loop reads it from the 'hit' event. */
  wasHit?: boolean;
  /** What this fighter last did, for the recovery pose: an attack kind, a feint, or null. */
  last?: AttackKind | 'feint' | null;
  /** Ticks before landing at which the windup turns into the strike. Default STRIKE_MS in ticks. */
  strikeLeadTicks?: number;
}

const DEFAULT_LEAD = msToTicks(DUEL_RULES.STRIKE_MS, DUEL_RULES);
/** |moveDx| per tick above which a move reads as a dash (step 0.056, dash 0.125 with DUEL_RULES). */
export const DASH_DX = 0.09;

/** Pick the pose for a fighter from duel state. Pure; the duel loop calls it each tick and passes the result to setPose. */
export function choosePose(f: Fighter, tick: number, ctx: PoseContext = {}): PoseName {
  if (ctx.phase === 'over' && ctx.lost) return 'fall';
  if (ctx.wasHit) return 'hit';
  if (f.stance === 'stun') return 'hit';
  if (f.stance === 'dip') return 'dip';
  if (f.strike) {
    const lead = ctx.strikeLeadTicks ?? DEFAULT_LEAD;
    return (f.strike.landsAtTick - tick <= lead ? 'strike_' : 'windup_') + f.strike.kind as PoseName;
  }
  if (f.riposte > 0) return 'parry';
  if (f.stance === 'recover') {
    if (ctx.last === 'feint') return 'feint';
    if (ctx.last) return ('strike_' + ctx.last) as PoseName;
    return 'idle';
  }
  if (f.stance === 'guard') return 'parry';
  if (f.stance === 'move') return Math.abs(f.moveDx) > DASH_DX ? 'dash' : 'step';
  return 'idle';
}
