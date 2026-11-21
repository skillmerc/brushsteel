import test from 'node:test';
import assert from 'node:assert/strict';
import { FEEL, SpatterRing, brushPressure, hitstopMs, hitstopTicks, kickDecay, kickFor, kickLeft, slowmoGameMs, slowmoRate } from './feel.js';
import { createDuel, DUEL_RULES, stepDuel, type DuelAction, type DuelEvent } from './duel.js';
import { createRng } from './rng.js';

const TICK_MS = 1000 / 60;

test('hit-stop: at least 3 frames (50 ms) on a hit, 80 to 120 ms on the killing blow', () => {
  assert.ok(hitstopMs(false) >= 50);
  assert.ok(hitstopTicks(false) >= 3);
  assert.ok(hitstopTicks(false) * TICK_MS >= 50);
  assert.ok(hitstopMs(true) >= 80 && hitstopMs(true) <= 120);
  const finalMs = hitstopTicks(true) * TICK_MS;
  assert.ok(finalMs >= 80 && finalMs <= 120, `final hit-stop ${finalMs} ms`);
  assert.ok(hitstopTicks(true) > hitstopTicks(false), 'the killing blow holds longer');
  assert.equal(DUEL_RULES.HITSTOP_MS, FEEL.HITSTOP_MS);
  assert.equal(DUEL_RULES.HITSTOP_FINAL_MS, FEEL.HITSTOP_FINAL_MS);
});

test('duel: a clean hit sets the hit-stop; the killing blow sets the longer one', () => {
  const cut: DuelAction = { type: 'stroke', kind: 'cut', speed: 30, segment: { a: { x: -2, y: 6 }, b: { x: 2, y: 6 } } };
  const land = (d: ReturnType<typeof createDuel>): DuelEvent[] => {
    d.state.fighters[0].x = -1;
    d.state.fighters[1].x = 1;
    const out: DuelEvent[] = [];
    for (let i = 0; i < 7; i++) out.push(...stepDuel(d, i === 0 ? [cut, null] : [null, null]));
    return out;
  };
  const a = createDuel(1);
  const ev = land(a);
  assert.ok(ev.some((e) => e.type === 'hit'), 'the cut lands');
  assert.equal(a.state.phase, 'point');
  assert.equal(a.state.hitstop, hitstopTicks(false));
  const b = createDuel(1);
  b.state.score[0] = DUEL_RULES.HITS_TO_WIN - 1;
  const evb = land(b);
  assert.ok(evb.some((e) => e.type === 'win'), 'the killing blow');
  assert.equal(b.state.phase, 'over');
  assert.equal(b.state.hitstop, hitstopTicks(true));
});

test('camera kick: decays under 200 ms, frame steps match the curve, reduced motion turns it off', () => {
  assert.equal(kickLeft(0), 1);
  assert.ok(kickLeft(0.2) < 0.05, `left at 200 ms: ${kickLeft(0.2)}`);
  assert.ok(kickLeft(0.05) > 0.3, 'still visible for the first frames');
  // 12 frames of 1/60 s equal the 200 ms curve.
  let k = 1;
  for (let i = 0; i < 12; i++) k *= kickDecay(1 / 60);
  assert.ok(Math.abs(k - kickLeft(0.2)) < 1e-9);
  assert.equal(kickDecay(-1), 1);
  const right = kickFor(1, false);
  const left = kickFor(-1, false);
  assert.ok(right.x > 0 && left.x < 0, 'toward the hit direction');
  assert.ok(Math.abs(right.x) <= 0.2, 'small: under 0.2 world units');
  const off = kickFor(1, true);
  assert.ok(off.x === 0 && off.y === 0);
});

test('final stroke slow motion: 0.3x for 600 ms of real time, then normal speed', () => {
  assert.equal(slowmoRate(Number.NaN), 1);
  assert.equal(slowmoRate(-1), 1);
  assert.equal(slowmoRate(0), 0.3);
  assert.equal(slowmoRate(599), 0.3);
  assert.equal(slowmoRate(600), 1);
  // Frame by frame at 60 fps: 600 real ms cover 180 game ms.
  let real = 0;
  let game = 0;
  while (real < 600 - 1e-9) {
    game += slowmoGameMs(real, TICK_MS);
    real += TICK_MS;
  }
  assert.ok(Math.abs(game - 180) < 1e-6, `game ms in slow motion: ${game}`);
  // A frame across the end is split: 50 ms slow + 50 ms normal.
  assert.ok(Math.abs(slowmoGameMs(550, 100) - (50 * 0.3 + 50)) < 1e-9);
  assert.equal(slowmoGameMs(700, 16), 16);
  assert.equal(slowmoGameMs(0, 0), 0);
});

test('spatter ring: fixed cap of 64, oldest replaced, clear empties, version marks uploads', () => {
  const r = new SpatterRing();
  assert.equal(r.capacity, FEEL.SPATTER_CAP);
  assert.equal(r.capacity, 64);
  const rng = createRng(9);
  const v0 = r.version;
  r.splash(0, 1, 0, rng);
  assert.equal(r.count, FEEL.SPATTER_PER_HIT);
  assert.ok(r.version > v0);
  for (let i = 0; i < 20; i++) r.splash(i * 0.1, 1, Math.PI, rng);
  assert.equal(r.count, 64, 'never past the cap');
  const xs = r.x;
  assert.equal(xs.length, 64, 'no growth');
  const m = new Float32Array(64 * 16);
  const a = new Float32Array(64 * 2);
  assert.equal(r.write(m, a), 64);
  for (let i = 0; i < 64; i++) {
    assert.ok(a[i * 2] > 0 && a[i * 2] <= 1, 'alpha in range');
    assert.ok(Number.isFinite(m[i * 16 + 12]) && Number.isFinite(m[i * 16 + 13]));
  }
  const v1 = r.version;
  r.clear();
  assert.equal(r.count, 0);
  assert.ok(r.version > v1, 'a clear is uploaded too');
  const v2 = r.version;
  r.clear();
  assert.equal(r.version, v2, 'clearing an empty ring changes nothing');
});

test('spatter: same seed, same blots; they land near the hit along its direction', () => {
  const a = new SpatterRing();
  const b = new SpatterRing();
  a.splash(1, 2, 0, createRng(4));
  b.splash(1, 2, 0, createRng(4));
  for (let i = 0; i < a.count; i++) {
    assert.equal(a.x[i], b.x[i]);
    assert.equal(a.y[i], b.y[i]);
    assert.ok(Math.hypot(a.x[i] - 1, a.y[i] - 2) <= 2.5, 'within 2.5 units of the hit');
    assert.ok(a.x[i] > 1 - 0.5, 'thrown along +x');
  }
});

test('brush pressure: slow strokes full width, fast flicks thin, never below half, smooth in between', () => {
  assert.equal(brushPressure(0), 1);
  assert.equal(brushPressure(Number.NaN), 1);
  assert.equal(brushPressure(-2), 1);
  assert.equal(brushPressure(0.4), 1);
  assert.equal(brushPressure(3), 0.5);
  assert.equal(brushPressure(50), 0.5);
  let prev = 1;
  for (let v = 0.4; v <= 3; v += 0.05) {
    const p = brushPressure(v);
    assert.ok(p <= prev + 1e-12 && p >= 0.5, `monotone at ${v}`);
    prev = p;
  }
});
