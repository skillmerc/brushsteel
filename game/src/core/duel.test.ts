import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from './rng.js';
import {
  DUEL_RULES,
  DUEL_STROKE_KINDS,
  createDuel,
  inkCost,
  knockback,
  msToTicks,
  segmentsCross,
  stepDuel,
  strokeSpeedToStage,
  type Duel,
  type DuelAction,
  type DuelEvent,
  type DuelStrokeKind,
  type Segment,
} from './duel.js';

const R = DUEL_RULES;
const seg = (ax: number, ay: number, bx: number, by: number): Segment => ({ a: { x: ax, y: ay }, b: { x: bx, y: by } });
const stroke = (kind: DuelStrokeKind, speed: number, segment: Segment, extra: { length?: number; windupMs?: number } = {}): DuelAction => ({
  type: 'stroke',
  kind,
  speed,
  segment,
  ...extra,
});
/** A fast 4-unit cut low on the stage, far from any test telegraph. */
const CUT = stroke('cut', 30, seg(-2, 6, 2, 6));

function setGap(d: Duel, gap: number): void {
  d.state.fighters[0].x = -gap / 2;
  d.state.fighters[1].x = gap / 2;
}

/** Step n ticks with the given actions on the first tick only. Returns all events. */
function run(d: Duel, n: number, first: [DuelAction | null, DuelAction | null] = [null, null]): DuelEvent[] {
  const out: DuelEvent[] = [];
  for (let i = 0; i < n; i++) out.push(...stepDuel(d, i === 0 ? first : [null, null]));
  return out;
}

const types = (ev: DuelEvent[]): string[] => ev.map((e) => e.type);

test('a fast cut in range lands after STRIKE_MS and scores a clean hit', () => {
  const d = createDuel(1);
  setGap(d, 2);
  const ev1 = run(d, 1, [CUT, null]);
  assert.deepEqual(types(ev1), ['strike']);
  assert.equal(d.state.fighters[0].stance, 'windup');
  const ticks = msToTicks(R.STRIKE_MS);
  assert.equal(ticks, 6);
  const ev2 = run(d, ticks - 1);
  assert.deepEqual(types(ev2), []);
  const ev3 = run(d, 1);
  const hit = ev3.find((e) => e.type === 'hit');
  assert.ok(hit && hit.type === 'hit');
  assert.equal(hit.who, 0);
  assert.deepEqual(d.state.score, [1, 0]);
  assert.equal(d.state.phase, 'point');
  assert.ok(d.state.hitstop * (1000 / 60) >= 50, 'hit-stop at least 50 ms');
  // Knocked back by length: 4 units * 0.2 = 0.8.
  assert.ok(Math.abs(d.state.fighters[1].x - (1 + 0.8)) < 1e-9);
});

test('out of range the cut whiffs and nobody scores', () => {
  const d = createDuel(1);
  setGap(d, R.REACH_CUT + 0.5);
  const ev = run(d, 10, [CUT, null]);
  assert.ok(types(ev).includes('whiff'));
  assert.ok(!types(ev).includes('hit'));
  assert.deepEqual(d.state.score, [0, 0]);
  assert.equal(d.state.phase, 'fight');
});

test('reach: exactly at reach hits, a thrust reaches further than a cut', () => {
  const d = createDuel(2);
  setGap(d, R.REACH_CUT);
  assert.ok(types(run(d, 7, [CUT, null])).includes('hit'));
  const t = createDuel(2);
  setGap(t, R.REACH_THRUST);
  assert.ok(types(run(t, 7, [stroke('thrust', 0, seg(0, 4, 0.1, 4)), null])).includes('hit'), 'a dot thrust has speed 0 and still counts');
});

// Foe (fighter 1) telegraphs a stroke: a vertical line at x 0 from y 2 to y 4, landing in 600 ms.
const TELEGRAPH = seg(0, 2, 0, 4);
const FOE_ATTACK = stroke('overhead', 30, TELEGRAPH, { windupMs: 600 });
const ACROSS = stroke('cut', 30, seg(-1, 3, 1, 3));

test('cutting across the telegraph inside the window parries and opens a 400 ms riposte', () => {
  const d = createDuel(3);
  setGap(d, 2);
  run(d, 1, [null, FOE_ATTACK]);
  const foeStrike = d.state.fighters[1].strike;
  assert.ok(foeStrike, 'telegraph is up');
  assert.equal(foeStrike.windupMs, 600);
  // Wait until the strike is 200 ms out (inside the 300 ms window).
  while ((foeStrike.landsAtTick - (d.state.tick + 1)) * (1000 / 60) > 200) run(d, 1);
  const ev = run(d, 1, [ACROSS, null]);
  assert.deepEqual(types(ev), ['parry']);
  assert.equal(d.state.fighters[1].strike, null, 'foe stroke cancelled');
  assert.equal(d.state.fighters[1].stun, 24);
  assert.equal(d.state.fighters[0].riposte, 24);
  assert.equal(msToTicks(R.RIPOSTE_MS) * (1000 / 60), 400);
  assert.equal(d.state.fighters[1].stance, 'stun');
  // The foe cannot act while stunned.
  const busy = run(d, 1, [null, CUT]);
  assert.ok(busy.some((e) => e.type === 'fizzle' && e.reason === 'busy'));
  // Riposte: a cut now lands inside the stun and hits.
  const rip = run(d, 7, [CUT, null]);
  assert.ok(types(rip).includes('hit'));
  assert.deepEqual(d.state.score, [1, 0]);
});

test('the riposte ends after 400 ms', () => {
  const d = createDuel(3);
  setGap(d, 2);
  run(d, 1, [null, FOE_ATTACK]);
  run(d, 25);
  run(d, 1, [ACROSS, null]);
  assert.equal(d.state.fighters[1].stun, 24);
  run(d, 24);
  assert.equal(d.state.fighters[1].stun, 0);
  assert.equal(d.state.fighters[0].riposte, 0);
  assert.equal(d.state.fighters[1].stance, 'ready');
});

test('crossing the line before the window does not parry: the foe stroke still lands', () => {
  const d = createDuel(4);
  setGap(d, 2);
  run(d, 1, [null, FOE_ATTACK]);
  const foeStrike = d.state.fighters[1].strike;
  assert.ok(foeStrike);
  // 500 ms out: outside the 300 ms window.
  assert.ok((foeStrike.landsAtTick - (d.state.tick + 1)) * (1000 / 60) > R.PARRY_WINDOW_MS);
  const ev = run(d, 1, [ACROSS, null]);
  assert.ok(!types(ev).includes('parry'));
  assert.ok(types(ev).includes('strike'), 'the early cut is just an attack');
  assert.ok(d.state.fighters[1].strike, 'foe stroke still pending');
});

test('inside the window, a cut that misses the line does not parry', () => {
  const d = createDuel(5);
  setGap(d, 3);
  run(d, 1, [null, FOE_ATTACK]);
  run(d, 25);
  const ev = run(d, 1, [stroke('cut', 30, seg(-1, 5, 1, 5)), null]);
  assert.ok(!types(ev).includes('parry'));
  assert.ok(d.state.fighters[1].strike);
});

test('after the foe stroke has landed, crossing where the line was does nothing', () => {
  const d = createDuel(6);
  setGap(d, 3); // foe overhead (reach 2.0) whiffs
  const ev1 = run(d, 1 + 36, [null, FOE_ATTACK]);
  assert.ok(types(ev1).includes('whiff'));
  const ev2 = run(d, 1, [ACROSS, null]);
  assert.ok(!types(ev2).includes('parry'));
});

test('two strikes landing within 80 ms clash: both pushed back, nobody scores', () => {
  const d = createDuel(7);
  setGap(d, 2);
  run(d, 1, [CUT, null]); // lands 6 ticks later
  run(d, 2);
  const x0 = d.state.fighters[0].x;
  const x1 = d.state.fighters[1].x;
  const ev = run(d, 10, [null, CUT]); // lands 3 ticks (50 ms) after the first
  const clash = ev.find((e) => e.type === 'clash');
  assert.ok(clash && clash.type === 'clash');
  assert.ok(!types(ev).includes('hit'));
  assert.deepEqual(d.state.score, [0, 0]);
  assert.ok(d.state.fighters[0].x < x0 - 0.7 && d.state.fighters[0].x > x0 - 0.9, `fighter 0 pushed left ${d.state.fighters[0].x - x0}`);
  assert.ok(d.state.fighters[1].x > x1 + 0.7 && d.state.fighters[1].x < x1 + 0.9, `fighter 1 pushed right ${d.state.fighters[1].x - x1}`);
  for (const p of clash.push) assert.ok(p >= R.CLASH_PUSH * 0.9 && p <= R.CLASH_PUSH * 1.1);
});

test('strikes landing 83 ms apart do not clash: the first one hits', () => {
  const d = createDuel(8);
  setGap(d, 2);
  run(d, 1, [CUT, null]);
  run(d, 4);
  const ev = run(d, 10, [null, CUT]); // 5 ticks = 83 ms apart
  assert.ok(!types(ev).includes('clash'));
  const hit = ev.find((e) => e.type === 'hit');
  assert.ok(hit && hit.type === 'hit' && hit.who === 0);
});

test('ink cost grows with length and speed; a slow long cut costs at least twice a fast short one', () => {
  const slowLong = inkCost('cut', 6, 5);
  const fastShort = inkCost('cut', 1.5, 40);
  assert.ok(slowLong >= 2 * fastShort, `${slowLong} vs ${fastShort}`);
  assert.ok(inkCost('cut', 4, 40) > inkCost('cut', 4, 10));
  assert.ok(inkCost('cut', 4, 10) > inkCost('cut', 2, 10));
  assert.equal(inkCost('cut', 4, R.MIN_STROKE_SPEED), R.INK_BASE + R.INK_PER_UNIT * 4);
  assert.equal(inkCost('cut', 4, 999), R.INK_BASE + R.INK_PER_UNIT * 4 * (1 + R.INK_SPEED_EXTRA));
  assert.equal(inkCost('cut', 50, 10), inkCost('cut', R.MAX_STROKE_LENGTH, 10), 'length is capped');
  // And it lands harder: knockback at least twice as far.
  assert.ok(knockback('cut', 6) >= 2 * knockback('cut', 1.5));
  // The meter drops by exactly the cost.
  const d = createDuel(9);
  setGap(d, 5);
  run(d, 1, [stroke('cut', 20, seg(-2, 6, 2, 6), { length: 5 }), null]);
  assert.ok(Math.abs(d.state.fighters[0].ink - (100 - inkCost('cut', 5, 20))) < 1e-9);
});

test('zero ink blocks the stroke; not enough ink blocks it too', () => {
  const d = createDuel(10);
  setGap(d, 2);
  d.state.fighters[0].ink = 0;
  const ev = run(d, 10, [CUT, null]);
  assert.deepEqual(types(ev), ['dry']);
  assert.equal(d.state.fighters[0].strike, null);
  assert.deepEqual(d.state.score, [0, 0]);
  const e = createDuel(10);
  setGap(e, 2);
  e.state.fighters[0].ink = inkCost('cut', 4, 30) - 0.01;
  assert.deepEqual(types(run(e, 10, [CUT, null])), ['dry']);
  // A circle guard needs ink too.
  e.state.fighters[0].ink = 0;
  assert.deepEqual(types(run(e, 1, [stroke('parry', 10, seg(0, 0, 0, 0)), null])), ['dry']);
});

test('a slow drag does nothing and costs no ink', () => {
  const d = createDuel(11);
  setGap(d, 2);
  // 400 px drawn over 8 s at scale 1: 0.05 px/ms.
  const slow = strokeSpeedToStage(400 / 8000);
  assert.ok(slow < R.MIN_STROKE_SPEED);
  const ev = run(d, 10, [stroke('cut', slow, seg(-2.5, 6, 2.5, 6)), null]);
  assert.ok(ev.some((e) => e.type === 'fizzle' && e.reason === 'slow'));
  assert.equal(d.state.fighters[0].ink, 100);
  assert.deepEqual(d.state.score, [0, 0]);
  // Speed conversion: 1 px/ms at scale 1 is 12.5 units/s; at scale 1.5 the same px speed is slower.
  assert.equal(strokeSpeedToStage(1), 12.5);
  assert.ok(Math.abs(strokeSpeedToStage(1.5, 1.5) - 12.5) < 1e-9);
});

test('kind none does nothing; a circle guards one strike but gives no riposte', () => {
  const d = createDuel(12);
  setGap(d, 2);
  assert.ok(run(d, 1, [stroke('none', 30, seg(0, 0, 1, 1)), null]).some((e) => e.type === 'fizzle' && e.reason === 'none'));
  assert.equal(d.state.fighters[0].ink, 100);
  run(d, 1, [null, CUT]); // foe cut lands in 6 ticks
  const ev = run(d, 8, [stroke('parry', 10, seg(0, 3, 0, 3)), null]);
  assert.deepEqual(types(ev), ['guard', 'blocked']);
  assert.equal(d.state.fighters[0].riposte, 0);
  assert.equal(d.state.fighters[1].stun, 0);
  assert.deepEqual(d.state.score, [0, 0]);
});

test('dip refills the meter and leaves the fighter open', () => {
  const d = createDuel(13);
  setGap(d, 2);
  d.state.fighters[0].ink = 10;
  const ev1 = run(d, 1, [{ type: 'dip' }, null]);
  assert.deepEqual(types(ev1), ['dip-start']);
  assert.equal(d.state.fighters[0].stance, 'dip');
  // Cannot stroke, guard or move while dipping.
  assert.ok(run(d, 1, [CUT, null]).some((e) => e.type === 'fizzle' && e.reason === 'busy'));
  const x = d.state.fighters[0].x;
  run(d, 1, [{ type: 'step', dir: 'out' }, null]);
  assert.equal(d.state.fighters[0].x, x);
  // Undisturbed, the dip finishes after DIP_MS and the meter is full.
  const ev2 = run(d, msToTicks(R.DIP_MS) - 3);
  assert.deepEqual(types(ev2), []);
  const ev3 = run(d, 1);
  assert.deepEqual(types(ev3), ['dip-done']);
  assert.equal(d.state.fighters[0].ink, 100);

  // The foe's cut during a dip is a clean hit, and the refill is lost.
  const e = createDuel(13);
  setGap(e, 2);
  e.state.fighters[0].ink = 10;
  run(e, 1, [{ type: 'dip' }, null]);
  const ev4 = run(e, 7, [null, CUT]);
  const hit = ev4.find((v) => v.type === 'hit');
  assert.ok(hit && hit.type === 'hit' && hit.who === 1);
  assert.equal(e.state.fighters[0].ink, 10);
});

test('step and dash move toward or away from the foe; dash costs ink; fighters never pass', () => {
  const d = createDuel(14);
  run(d, msToTicks(R.STEP_MS), [{ type: 'step', dir: 'in' }, null]);
  assert.ok(Math.abs(d.state.fighters[0].x - (-R.START_X + R.STEP_DIST)) < 1e-9);
  run(d, msToTicks(R.DASH_MS), [null, { type: 'dash', dir: 'out' }]);
  assert.ok(Math.abs(d.state.fighters[1].x - (R.START_X + R.DASH_DIST)) < 1e-9);
  assert.equal(d.state.fighters[1].ink, 100 - R.DASH_INK);
  for (let i = 0; i < 20; i++) run(d, msToTicks(R.DASH_MS), [{ type: 'dash', dir: 'in' }, null]);
  const [a, b] = d.state.fighters;
  assert.ok(b.x - a.x >= R.MIN_GAP - 1e-9);
  assert.equal(a.facing, 1);
  assert.equal(b.facing, -1);
  assert.ok(a.x >= -R.STAGE_HALF && b.x <= R.STAGE_HALF);
});

test('first to three clean hits wins, and the duel stops', () => {
  const d = createDuel(15);
  const hits: number[] = [];
  for (let round = 0; round < 3; round++) {
    setGap(d, 2);
    const ev = run(d, 7, [CUT, null]);
    assert.ok(types(ev).includes('hit'), `hit ${round + 1}`);
    hits.push(d.state.score[0]);
    if (round < 2) {
      assert.equal(d.state.phase, 'point');
      // Nobody acts during the pause.
      assert.ok(!types(run(d, 1, [CUT, CUT])).includes('strike'));
      const rest = run(d, msToTicks(R.POINT_PAUSE_MS));
      assert.ok(types(rest).includes('resume'));
      assert.equal(d.state.phase, 'fight');
    }
  }
  assert.deepEqual(hits, [1, 2, 3]);
  assert.equal(d.state.phase, 'over');
  assert.equal(d.state.winner, 0);
  assert.deepEqual(d.state.score, [3, 0]);
  const after = run(d, 30, [CUT, CUT]);
  assert.deepEqual(types(after), []);
  assert.deepEqual(d.state.score, [3, 0]);
});

test('a telegraph with the master minimum windup stays up at least 15 frames', () => {
  const d = createDuel(16);
  setGap(d, 3);
  run(d, 1, [null, stroke('cut', 30, TELEGRAPH, { windupMs: R.MIN_TELEGRAPH_MS })]);
  let frames = 0;
  while (d.state.fighters[1].strike && frames < 100) {
    frames++;
    run(d, 1);
  }
  assert.ok(frames >= 15, `${frames} frames`);
});

test('a thrust never parries, even a dot wobbled across the line', () => {
  const d = createDuel(17);
  setGap(d, 2);
  run(d, 1, [null, FOE_ATTACK]);
  run(d, 25);
  const ev = run(d, 1, [stroke('thrust', 0, seg(-0.05, 3, 0.05, 3)), null]);
  assert.ok(!types(ev).includes('parry'));
  assert.ok(d.state.fighters[1].strike, 'foe stroke still pending');
});

test('segment crossing', () => {
  assert.ok(segmentsCross(seg(-1, 0, 1, 0), seg(0, -1, 0, 1)));
  assert.ok(segmentsCross(seg(-1, 0, 0, 0), seg(0, -1, 0, 1)), 'touching counts');
  assert.ok(!segmentsCross(seg(-1, 0, -0.1, 0), seg(0, -1, 0, 1)));
  assert.ok(!segmentsCross(seg(-1, 2, 1, 2), seg(0, -1, 0, 1)));
  assert.ok(!segmentsCross(seg(-2, 6, 2, 6), seg(-1, 6, 3, 6)), 'overlap on one line is not a cut across');
  assert.ok(!segmentsCross(seg(0, 0, 0, 0), seg(0, -1, 0, 1)), 'a point is not a cut');
});

/** Random but seeded inputs: every kind of action, some nonsense. */
function randomActions(seed: number, n: number): [DuelAction | null, DuelAction | null][] {
  const rng = createRng(seed);
  const kinds: DuelStrokeKind[] = ['cut', 'overhead', 'rising', 'thrust', 'parry', 'none'];
  const one = (): DuelAction | null => {
    const r = rng.next();
    if (r < 0.6) return null;
    if (r < 0.7) return { type: 'step', dir: rng.next() < 0.6 ? 'in' : 'out' };
    if (r < 0.75) return { type: 'dash', dir: rng.next() < 0.6 ? 'in' : 'out' };
    if (r < 0.78) return { type: 'dip' };
    return stroke(kinds[rng.int(0, kinds.length - 1)], rng.range(0, 50), seg(rng.range(-3, 3), rng.range(0, 6), rng.range(-3, 3), rng.range(0, 6)), {
      windupMs: rng.next() < 0.5 ? undefined : rng.range(100, 900),
    });
  };
  return Array.from({ length: n }, () => [one(), one()] as [DuelAction | null, DuelAction | null]);
}

function replay(seed: number, inputs: [DuelAction | null, DuelAction | null][]): { state: string; events: string; kinds: Set<string> } {
  const d = createDuel(seed);
  const events: DuelEvent[] = [];
  for (const a of inputs) events.push(...stepDuel(d, a));
  return { state: JSON.stringify(d.state), events: JSON.stringify(events), kinds: new Set(events.map((e) => e.type)) };
}

test('same seed and same inputs give the same state after 1000 steps', () => {
  const inputs = randomActions(4242, 1000);
  const a = replay(77, inputs);
  const b = replay(77, inputs);
  assert.equal(a.state, b.state);
  assert.equal(a.events, b.events);
  assert.equal(JSON.parse(a.state).tick, 1000);
  // The run really exercised the rules.
  for (const k of ['strike', 'whiff']) assert.ok(a.kinds.has(k), `no ${k} in the replay`);
  console.log(`replay event kinds: ${[...a.kinds].sort().join(', ')}\n`);
});

test('clash push uses the seed: same seed same push, other seeds differ', () => {
  const pushOf = (seed: number): string => {
    const d = createDuel(seed);
    setGap(d, 2);
    run(d, 1, [CUT, CUT]);
    const ev = run(d, 8);
    const c = ev.find((e) => e.type === 'clash');
    assert.ok(c && c.type === 'clash');
    return JSON.stringify(c.push);
  };
  assert.equal(pushOf(99), pushOf(99));
  assert.ok(new Set([1, 2, 3, 4, 5].map(pushOf)).size > 1);
});

test('stroke kinds match src/input/strokes.ts', async () => {
  // Compiled by the input test build to .test-build/src/input/strokes.js; imported at run time
  // because the core build (rootDir src/core) cannot import src/input.
  const url = new URL('./src/input/strokes.js', import.meta.url).href;
  const mod: { STROKE_KINDS: readonly string[] } = await import(url);
  assert.deepEqual([...mod.STROKE_KINDS], [...DUEL_STROKE_KINDS]);
});
