import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDuel, type AttackKind } from './duel.js';
import {
  BONES, BONE, BONE_COUNT, CHAINS, CHANNELS, POSES, POSE_NAMES, FIGURE_PHYSICS,
  createFigure, setPose, snapPose, stepFigure, solveFigure, poseTargets, wrapAngle, choosePose,
  type FigureState, type PoseName,
} from './figure.js';

const EPS = 1e-4;

function boneLengthError(s: FigureState): number {
  let worst = 0;
  for (let i = 0; i < BONE_COUNT; i++) {
    const k = i * 4;
    const len = Math.hypot(s.joints[k + 2] - s.joints[k], s.joints[k + 3] - s.joints[k + 1]);
    worst = Math.max(worst, Math.abs(len - BONES[i].length));
  }
  return worst;
}

function attachError(s: FigureState): number {
  let worst = 0;
  for (let i = 0; i < BONE_COUNT; i++) {
    const b = BONES[i];
    if (b.parent < 0) continue;
    const p = b.parent * 4 + (b.attach === 'end' ? 2 : 0);
    const k = i * 4;
    worst = Math.max(worst, Math.hypot(s.joints[k] - s.joints[p], s.joints[k + 1] - s.joints[p + 1]));
  }
  return worst;
}

function lowestBodyY(s: FigureState): number {
  let m = Infinity;
  for (let i = 0; i < BONE_COUNT; i++) {
    if (i === BONE.sword) continue;
    m = Math.min(m, s.joints[i * 4 + 1], s.joints[i * 4 + 3]);
  }
  return m;
}

function maxChannelGap(s: FigureState, name: PoseName): number {
  const t = poseTargets(name);
  let worst = 0;
  for (let i = 0; i < CHANNELS; i++) {
    const gap = i < BONE_COUNT ? wrapAngle(s.value[i] - t[i]) : s.value[i] - t[i];
    worst = Math.max(worst, Math.abs(gap));
  }
  return worst;
}

test('skeleton has 14 bones, parents before children', () => {
  assert.equal(BONE_COUNT, 14);
  for (let i = 0; i < BONE_COUNT; i++) {
    assert.ok(BONES[i].parent < i, `bone ${BONES[i].name} parent order`);
    assert.ok(BONES[i].length > 0);
    assert.equal(BONE[BONES[i].name as keyof typeof BONE], i);
  }
});

test('pose table is plain JSON data with every bone and finite numbers', () => {
  const round = JSON.parse(JSON.stringify(POSES)) as typeof POSES;
  assert.equal(POSE_NAMES.length, 16);
  for (const name of POSE_NAMES) {
    const p = round[name];
    assert.ok(Number.isFinite(p.rootX) && p.omega > 0 && p.zeta > 0 && p.zeta <= 1, name);
    for (const b of BONES) assert.ok(Number.isFinite(p.deg[b.name as keyof typeof p.deg]), `${name}.${b.name}`);
  }
});

test('pose names cover every duel attack kind and action', () => {
  const kinds: AttackKind[] = ['cut', 'overhead', 'rising', 'thrust'];
  for (const k of kinds) {
    assert.ok(POSE_NAMES.includes(`windup_${k}` as PoseName), `windup_${k}`);
    assert.ok(POSE_NAMES.includes(`strike_${k}` as PoseName), `strike_${k}`);
  }
  for (const n of ['idle', 'step', 'dash', 'dip', 'parry', 'feint', 'hit', 'fall']) assert.ok(POSE_NAMES.includes(n as PoseName), n);
});

test('every pose keeps bone lengths, joints attached, and the body on the ground', () => {
  for (const name of POSE_NAMES) {
    for (const facing of [1, -1] as const) {
      const s = createFigure(1.5, facing, -1.2, name);
      assert.ok(boneLengthError(s) < EPS, `${name} lengths`);
      assert.ok(attachError(s) < EPS, `${name} attach`);
      assert.ok(Math.abs(lowestBodyY(s) - -1.2) < EPS, `${name} grounded`);
    }
  }
});

test('snapPose lands exactly on the pose (tween start point)', () => {
  const s = createFigure(0, 1, 0, 'idle');
  snapPose(s, 'windup_cut');
  assert.ok(maxChannelGap(s, 'windup_cut') < 1e-6);
});

test('spring tween ends on the target pose for every pair, keeping bone lengths on the way', () => {
  const dt = 1 / 60;
  for (const from of POSE_NAMES) {
    for (const to of POSE_NAMES) {
      if (from === to) continue;
      const s = createFigure(0, 1, 0, from);
      setPose(s, to);
      let worstLen = 0;
      for (let f = 0; f < 240; f++) {
        stepFigure(s, dt);
        worstLen = Math.max(worstLen, boneLengthError(s));
      }
      assert.ok(maxChannelGap(s, to) < 1e-3, `${from} -> ${to} gap ${maxChannelGap(s, to)}`);
      assert.ok(worstLen < EPS, `${from} -> ${to} length ${worstLen}`);
    }
  }
});

test('tween does not snap: first frame moves little, overshoot stays small', () => {
  const s = createFigure(0, 1, 0, 'idle');
  const startGap = maxChannelGap(s, 'strike_thrust');
  setPose(s, 'strike_thrust');
  stepFigure(s, 1 / 60);
  // After one frame of the fastest spring the figure is still far from the target.
  assert.ok(maxChannelGap(s, 'strike_thrust') > 0.7 * startGap);
  // Overshoot on the root offset (a plain number channel) stays under 10% of the move.
  const t = poseTargets('strike_thrust')[BONE_COUNT];
  const from = poseTargets('idle')[BONE_COUNT];
  let peak = -Infinity;
  for (let f = 0; f < 120; f++) {
    stepFigure(s, 1 / 60);
    peak = Math.max(peak, s.value[BONE_COUNT]);
  }
  assert.ok(peak - t < 0.1 * Math.abs(t - from), `overshoot ${peak - t}`);
});

test('the right-hand fighter is an exact mirror of the left', () => {
  const a = createFigure(2, 1, 0, 'idle');
  const b = createFigure(2, -1, 0, 'idle');
  for (const name of ['strike_cut', 'windup_overhead', 'dash'] as PoseName[]) {
    setPose(a, name);
    setPose(b, name);
    for (let f = 0; f < 20; f++) {
      stepFigure(a, 1 / 60);
      stepFigure(b, 1 / 60);
    }
    for (let i = 0; i < BONE_COUNT; i++) {
      const k = i * 4;
      assert.ok(Math.abs((a.joints[k] - 2) + (b.joints[k] - 2)) < EPS, `${name} x ${i}`);
      assert.ok(Math.abs(a.joints[k + 3] - b.joints[k + 3]) < EPS, `${name} y ${i}`);
      assert.ok(Math.abs(Math.cos(a.angles[i]) + Math.cos(b.angles[i])) < EPS, `${name} angle ${i}`);
    }
  }
  // The sword points toward the foe in the strike: forward for facing 1, back for -1.
  snapPose(a, 'strike_cut');
  snapPose(b, 'strike_cut');
  assert.ok(a.joints[BONE.sword * 4 + 2] > a.joints[BONE.sword * 4]);
  assert.ok(b.joints[BONE.sword * 4 + 2] < b.joints[BONE.sword * 4]);
});

test('large or odd frame times stay stable and finite', () => {
  const s = createFigure(0, 1, 0, 'idle');
  setPose(s, 'fall');
  stepFigure(s, 5); // clamped to MAX_DT
  stepFigure(s, -1);
  stepFigure(s, Number.NaN);
  for (let f = 0; f < 300; f++) stepFigure(s, 1 / 30);
  for (const v of s.value) assert.ok(Number.isFinite(v));
  for (const c of s.chains) for (const v of c) assert.ok(Number.isFinite(v));
  assert.ok(s.time <= 300 / 30 + FIGURE_PHYSICS.MAX_DT + 1e-6);
});

test('verlet chains keep their segment lengths, stay pinned and stay above the ground', () => {
  const s = createFigure(-2.5, 1, -1.2, 'idle');
  const seq: PoseName[] = ['dash', 'strike_thrust', 'hit', 'idle', 'windup_overhead', 'strike_overhead', 'dip'];
  for (const p of seq) {
    setPose(s, p);
    for (let f = 0; f < 30; f++) {
      s.x += 0.01;
      stepFigure(s, 1 / 60);
    }
  }
  for (let ci = 0; ci < CHAINS.length; ci++) {
    const c = CHAINS[ci];
    const p = s.chains[ci];
    for (let i = 1; i < c.points; i++) {
      const len = Math.hypot(p[i * 2] - p[i * 2 - 2], p[i * 2 + 1] - p[i * 2 - 1]);
      assert.ok(Math.abs(len - c.segment) < 0.05 * c.segment, `${c.name} seg ${i} ${len}`);
      assert.ok(p[i * 2 + 1] >= -1.2 - 1e-6, `${c.name} under ground`);
    }
    const k = c.bone * 4 + (c.at === 'end' ? 2 : 0);
    assert.ok(Math.abs(p[0] - (s.joints[k] + c.offX)) < 1e-5 && Math.abs(p[1] - (s.joints[k + 1] + c.offY)) < 1e-5, `${c.name} pinned`);
  }
});

test('robe and hair keep moving after the body stops, and trail a sudden move', () => {
  const s = createFigure(0, 1, 0, 'idle');
  for (let f = 0; f < 120; f++) stepFigure(s, 1 / 60); // settle
  const hair = CHAINS.findIndex((c) => c.name === 'hair');
  const tip = (CHAINS[hair].points - 1) * 2;
  const before = s.chains[hair][tip];
  for (let f = 0; f < 60; f++) stepFigure(s, 1 / 60);
  assert.ok(Math.abs(s.chains[hair][tip] - before) > 0.002, 'hair sways at rest');
  // A dash forward: the robe hem lags behind the hips.
  const robe = CHAINS.findIndex((c) => c.name === 'robeBack');
  const hemBefore = s.chains[robe][(CHAINS[robe].points - 1) * 2];
  s.x += 0.4;
  stepFigure(s, 1 / 60);
  const hemMove = s.chains[robe][(CHAINS[robe].points - 1) * 2] - hemBefore;
  assert.ok(hemMove < 0.3, `hem moved ${hemMove}`);
});

test('choosePose maps duel state to poses', () => {
  const duel = createDuel(1);
  const f = duel.state.fighters[0];
  assert.equal(choosePose(f, 0), 'idle');
  f.stance = 'move'; f.moveTicks = 5; f.moveDx = 0.5 / 9;
  assert.equal(choosePose(f, 0), 'step');
  f.moveDx = -1.5 / 12;
  assert.equal(choosePose(f, 0), 'dash');
  f.stance = 'windup';
  f.strike = { kind: 'overhead', segment: { a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }, length: 1, windupMs: 500, startTick: 0, landsAtTick: 30 };
  assert.equal(choosePose(f, 0), 'windup_overhead');
  assert.equal(choosePose(f, 24), 'strike_overhead');
  f.strike = null; f.stance = 'recover'; f.recover = 5;
  assert.equal(choosePose(f, 31, { last: 'thrust' }), 'strike_thrust');
  assert.equal(choosePose(f, 31, { last: 'feint' }), 'feint');
  f.stance = 'ready'; f.riposte = 10;
  assert.equal(choosePose(f, 40), 'parry');
  f.riposte = 0; f.stance = 'guard';
  assert.equal(choosePose(f, 40), 'parry');
  f.stance = 'dip';
  assert.equal(choosePose(f, 40), 'dip');
  f.stance = 'stun';
  assert.equal(choosePose(f, 40), 'hit');
  f.stance = 'ready';
  assert.equal(choosePose(f, 40, { wasHit: true }), 'hit');
  assert.equal(choosePose(f, 40, { phase: 'over', lost: true }), 'fall');
  assert.equal(choosePose(f, 40, { phase: 'over', lost: false }), 'idle');
});
