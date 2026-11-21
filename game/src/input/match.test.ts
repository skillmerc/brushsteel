import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEMO_STYLE,
  GROUND_WORLD_Y,
  MASTER_1,
  createDemoPilot,
  createMatch,
  duelSeconds,
  finishStroke,
  beginStroke,
  extendStroke,
  formatClock,
  parrySwordTilt,
  playerAction,
  poseFor,
  screenToStage,
  stageToScreen,
  stepMatch,
  strokeToAction,
  type View,
} from './match.js';
import { DUEL_RULES } from '../core/duel.js';

// 1280x720 canvas showing the 16 x 9 stage: 80 px per unit, classifier scale 1.
const VIEW: View = { width: 1280, height: 720, left: -8, right: 8, top: 4.5, bottom: -4.5 };
// 1920x1080: 120 px per unit, scale 1.5.
const VIEW_HD: View = { width: 1920, height: 1080, left: -8, right: 8, top: 4.5, bottom: -4.5 };

test('screen and stage frames round-trip, stage y 0 on the ground', () => {
  const p = screenToStage(640, 360, VIEW);
  assert.ok(Math.abs(p.x) < 1e-9);
  assert.ok(Math.abs(p.y - -GROUND_WORLD_Y) < 1e-9);
  const q = stageToScreen(2.5, 1.3, VIEW_HD);
  const r = screenToStage(q.x, q.y, VIEW_HD);
  assert.ok(Math.abs(r.x - 2.5) < 1e-9 && Math.abs(r.y - 1.3) < 1e-9);
});

test('a drawn cut becomes a stroke action with the path length and stage speed', () => {
  // A bowed cut toward a foe on the right, 300 px over 150 ms.
  const pts = [];
  for (let i = 0; i <= 20; i++) {
    const u = i / 20;
    pts.push({ x: 500 + 300 * u, y: 250 + 200 * u + Math.sin(Math.PI * u) * 40, t: 1000 + 150 * u });
  }
  const { result, action } = strokeToAction(pts, VIEW, { x: -2.5 }, { x: 2.5 });
  assert.notEqual(result.kind, 'none');
  assert.ok(action && action.type === 'stroke');
  if (action?.type !== 'stroke') return;
  const chord = Math.hypot(action.segment.b.x - action.segment.a.x, action.segment.b.y - action.segment.a.y);
  assert.ok((action.length ?? 0) > chord, `length ${action.length} should exceed the chord ${chord}`);
  assert.ok(Math.abs((action.length ?? 0) - result.length / 80) < 1e-9);
  assert.ok(action.speed > 10, `speed ${action.speed} units/s`);
});

test('keys map to steps, dashes and dips relative to facing', () => {
  const m = createMatch(3);
  m.keys.right = true;
  assert.equal(JSON.stringify(playerAction(m)), JSON.stringify({ type: 'step', dir: 'in' }));
  m.keys.dash = true;
  assert.equal(JSON.stringify(playerAction(m)), JSON.stringify({ type: 'dash', dir: 'in' }));
  m.keys.right = false;
  m.keys.left = true;
  assert.equal(JSON.stringify(playerAction(m)), JSON.stringify({ type: 'dash', dir: 'out' }));
  m.keys.left = false;
  m.keys.dip = true;
  assert.equal(playerAction(m), null, 'dip does nothing with a full meter');
  m.duel.state.fighters[0].ink = 40;
  assert.equal(playerAction(m)?.type, 'dip');
});

test('a released stroke reaches the duel as the player strike', () => {
  const m = createMatch(5);
  // Walk into cut reach first.
  m.duel.state.fighters[0].x = 0;
  m.duel.state.fighters[1].x = 1.8;
  const pts = [];
  for (let i = 0; i <= 12; i++) {
    const u = i / 12;
    pts.push({ x: 600 + 220 * u, y: 300 + 140 * u, t: 50 * u });
  }
  beginStroke(m, pts[0]);
  for (const p of pts.slice(1)) extendStroke(m, p);
  const r = finishStroke(m, VIEW);
  assert.ok(r && r.kind !== 'none', `classified ${r?.kind}`);
  const ev = stepMatch(m, 1 / 60 + 1e-6);
  assert.ok(ev.some((e) => e.type === 'strike' && e.who === 0) || m.duel.state.fighters[0].strike !== null);
  assert.equal(m.stats.strokes, 1);
});

test('backhand cuts swap the windup side; retreats never lunge', () => {
  const m = createMatch(9);
  const f = m.duel.state.fighters[0];
  f.strike = { kind: 'cut', segment: { a: { x: -1, y: 2 }, b: { x: 1, y: 0.8 } }, length: 2, windupMs: 900, startTick: 0, landsAtTick: 100 };
  f.stance = 'windup';
  assert.equal(poseFor(m, 0), 'windup_cut');
  f.strike.segment = { a: { x: 1, y: 2 }, b: { x: -1, y: 0.8 } };
  assert.equal(poseFor(m, 0), 'strike_cut', 'backhand windup starts where a forehand ends');
  f.strike = null;
  f.stance = 'move';
  f.moveTicks = 5;
  f.moveDx = -0.056;
  assert.equal(poseFor(m, 0), 'idle');
  f.moveDx = -0.125;
  assert.equal(poseFor(m, 0), 'parry');
  f.moveDx = 0.125;
  assert.equal(poseFor(m, 0), 'dash');
});

test('parry pose tilts toward the line height', () => {
  assert.equal(parrySwordTilt(null), 0);
  const low = parrySwordTilt({ a: { x: 0, y: 0.3 }, b: { x: 1, y: 0.4 } });
  const high = parrySwordTilt({ a: { x: 0, y: 2.9 }, b: { x: 1, y: 2.8 } });
  assert.ok(low < -0.5 && high > 0.2, `low ${low} high ${high}`);
});

test('scripted demo duel: strokes, a parry and a round won by the player', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const m = createMatch(seed, DEMO_STYLE);
    const pilot = createDemoPilot(() => VIEW_HD, seed);
    m.pilot = pilot;
    let frames = 0;
    // 5 fps frames (CI SwiftShader) for at most 3 minutes of duel time.
    while (m.duel.state.phase !== 'over' && frames < 5 * 180) {
      stepMatch(m, 0.2);
      frames++;
    }
    assert.equal(m.duel.state.winner, 0, `seed ${seed}: winner ${m.duel.state.winner}, score ${m.duel.state.score}`);
    assert.ok(m.stats.parries[0] >= 1, `seed ${seed}: parries ${m.stats.parries}`);
    assert.ok(m.stats.strokes >= 2);
    assert.ok(duelSeconds(m) < 40, `seed ${seed}: ${duelSeconds(m).toFixed(1)} s`);
    console.log(`demo seed ${seed}: won ${m.duel.state.score.join('-')} in ${duelSeconds(m).toFixed(1)} s, parries ${m.stats.parries[0]}, strokes ${m.stats.strokes}`);
  }
});

test('demo photo holds: parry stroke half drawn, fighters close, then a hit, and the duel still ends in a win', () => {
  for (const seed of [1, 2, 3]) {
    const m = createMatch(seed, DEMO_STYLE);
    m.pilot = createDemoPilot(() => VIEW_HD, seed, true);
    const holds: string[] = [];
    let frames = 0;
    let gapAtHit = -1;
    let after = 0;
    // Run on 2 s past the end: the last hit's photo is held 9 ticks after it.
    while (after < 10) {
      stepMatch(m, 0.2);
      if (m.duel.state.phase === 'over') after++;
      if (m.hold) {
        holds.push(m.hold);
        if (m.hold === 'parry') {
          assert.ok(m.drawing && m.live.length >= 5, 'trail on screen');
          assert.ok(m.duel.state.fighters[1].strike, 'foe line on screen');
        }
        if (m.hold === 'hit') gapAtHit = Math.abs(m.duel.state.fighters[1].x - m.duel.state.fighters[0].x);
        m.hold = null;
      }
      if (++frames > 5 * 180) break;
    }
    assert.equal(holds.join(','), 'parry,close,hit', `seed ${seed}`);
    assert.equal(m.duel.state.winner, 0);
    console.log(`demo photos seed ${seed}: gap at hit photo ${gapAtHit.toFixed(2)}`);
  }
});

test('an idle player still loses to master 1 within 3 minutes', () => {
  const m = createMatch(11, MASTER_1);
  let n = 0;
  while (m.duel.state.phase !== 'over' && n < 60 * 600) {
    stepMatch(m, 1 / 60 + 1e-9);
    n++;
  }
  assert.equal(m.duel.state.winner, 1);
  assert.ok(duelSeconds(m) <= 180, `${duelSeconds(m)} s`);
  assert.equal(formatClock(duelSeconds(m)).includes(':'), true);
});

test('timer stops at the end and frames clamp to 15 ticks', () => {
  assert.equal(formatClock(83.9), '1:23');
  const m = createMatch(1);
  stepMatch(m, 5);
  assert.equal(m.duel.state.tick, 15);
  assert.ok(Math.abs(duelSeconds(m) - 15 / DUEL_RULES.TICK_HZ) < 1e-9);
});
