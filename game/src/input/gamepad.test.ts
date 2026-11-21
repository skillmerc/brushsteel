import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyStroke, type StrokePoint } from './strokes.js';
import { createPadReader, padArea, PAD_BUTTON, PAD_TUNING, strokesFrom, type PadFrame, type PadSnapshot } from './gamepad.js';

const AREA = padArea(1280, 720);
const FRAME_MS = 16;

/** A standard-mapping snapshot: 4 axes, 17 buttons, all at rest unless set. */
function pad(o: { axes?: number[]; down?: number[] } = {}): PadSnapshot {
  const axes = [0, 0, 0, 0];
  (o.axes ?? []).forEach((v, i) => (axes[i] = v));
  const buttons = Array.from({ length: 17 }, (_, i) => ({ pressed: (o.down ?? []).includes(i), value: (o.down ?? []).includes(i) ? 1 : 0 }));
  return { axes, buttons };
}

/** Feed snapshots one frame apart, starting at rest. */
function run(snaps: PadSnapshot[], t0 = 1000): PadFrame[] {
  const r = createPadReader();
  const frames = [r.read(pad(), t0, AREA)];
  snaps.forEach((s, i) => frames.push(r.read(s, t0 + (i + 1) * FRAME_MS, AREA)));
  return frames;
}

/** Right stick from rest to (x, y) over n frames, held one frame, then back to rest over 2 frames. */
function flick(x: number, y: number, n = 4): PadSnapshot[] {
  const out: PadSnapshot[] = [];
  for (let i = 1; i <= n; i++) out.push(pad({ axes: [0, 0, (x * i) / n, (y * i) / n] }));
  out.push(pad({ axes: [0, 0, x, y] }));
  out.push(pad({ axes: [0, 0, x * 0.4, y * 0.4] }));
  out.push(pad());
  return out;
}

test('pad: A, B and Start fire once per press, never while held', () => {
  const held = Array.from({ length: 60 }, () => pad({ down: [PAD_BUTTON.A] }));
  const frames = run([...held, pad(), pad({ down: [PAD_BUTTON.B] }), pad({ down: [PAD_BUTTON.B] }), pad({ down: [PAD_BUTTON.START] })]);
  const all = frames.flatMap((f) => f.menu);
  assert.deepEqual(all, ['confirm', 'back', 'pause']);
});

test('pad: a button already down on the first read does not fire', () => {
  const r = createPadReader();
  assert.deepEqual(r.read(pad({ down: [PAD_BUTTON.A] }), 0, AREA).menu, []);
  assert.deepEqual(r.read(pad({ down: [PAD_BUTTON.A] }), 16, AREA).menu, []);
  r.read(pad(), 32, AREA);
  assert.deepEqual(r.read(pad({ down: [PAD_BUTTON.A] }), 48, AREA).menu, ['confirm']);
});

test('pad: a held direction fires once, then repeats after the delay', () => {
  const r = createPadReader();
  r.read(pad(), 0, AREA);
  const fired: number[] = [];
  for (let t = 16; t <= 16 + 1000; t += 16) if (r.read(pad({ down: [PAD_BUTTON.DOWN] }), t, AREA).menu.includes('down')) fired.push(t);
  assert.equal(fired[0], 16);
  assert.ok(fired[1] - fired[0] >= PAD_TUNING.REPEAT_DELAY_MS, `second fire at ${fired[1]}`);
  for (let i = 2; i < fired.length; i++) assert.ok(fired[i] - fired[i - 1] >= PAD_TUNING.REPEAT_EVERY_MS);
  assert.ok(fired.length >= 3 && fired.length <= 6, `fired ${fired.length} times`);
});

test('pad: a short tap on a slow machine moves once, a long hold there still repeats', () => {
  // About 5 fps, as in CI software rendering: a tap held across 3 or 4 polls spans 400 ms or more.
  for (const [gap, polls] of [[200, 3], [200, 4], [150, 4], [450, 2]] as const) {
    const r = createPadReader();
    r.read(pad(), 0, AREA);
    let moves = 0;
    for (let i = 1; i <= polls; i++) moves += r.read(pad({ down: [PAD_BUTTON.UP] }), i * gap, AREA).menu.filter((m) => m === 'up').length;
    r.read(pad(), (polls + 1) * gap, AREA);
    assert.equal(moves, 1, `gap ${gap} ms, ${polls} polls: ${moves} moves`);
  }
  const r = createPadReader();
  r.read(pad(), 0, AREA);
  let moves = 0;
  for (let i = 1; i <= 10; i++) moves += r.read(pad({ down: [PAD_BUTTON.UP] }), i * 200, AREA).menu.filter((m) => m === 'up').length;
  assert.ok(moves >= 3, `a 2 s hold at 5 fps moved ${moves} times`);
});

test('pad: left stick reads as directions and steps; small tilts do nothing', () => {
  const frames = run([pad({ axes: [0.3, 0.2] }), pad({ axes: [-0.9, 0] }), pad({ axes: [0, -0.9] })]);
  assert.deepEqual(frames[1].menu, []);
  assert.equal(frames[1].moves.left || frames[1].moves.right, false);
  assert.deepEqual(frames[2].menu, ['left']);
  assert.equal(frames[2].moves.left, true);
  assert.deepEqual(frames[3].menu, ['up']);
  assert.equal(frames[3].moves.left, false);
});

test('pad: duel moves from the d-pad, shoulders and triggers', () => {
  const f = run([pad({ down: [PAD_BUTTON.RIGHT, PAD_BUTTON.LB, PAD_BUTTON.X] }), pad({ down: [PAD_BUTTON.RT, PAD_BUTTON.Y] }), pad({ down: [PAD_BUTTON.RT, PAD_BUTTON.Y] })]);
  assert.deepEqual({ ...f[1].moves }, { left: false, right: true, dash: true, dip: true, thrust: false, restart: false });
  assert.equal(f[2].moves.thrust, true);
  assert.equal(f[2].moves.restart, true);
  assert.equal(f[3].moves.thrust, false, 'a held trigger thrusts once');
  assert.equal(f[3].moves.restart, false);
});

test('pad: the right stick inside the deadzone draws nothing', () => {
  const frames = run(Array.from({ length: 30 }, (_, i) => pad({ axes: [0, 0, 0.2 * Math.cos(i), 0.2 * Math.sin(i)] })));
  assert.equal(frames.flatMap((f) => f.strokes).length, 0);
});

test('pad: a right-stick flick reads as the same stroke kind as a mouse drag', () => {
  const cases: [number, number, string][] = [[0, 1, 'overhead'], [0, -1, 'rising'], [1, 0, 'cut'], [-1, 0, 'cut'], [0.7, 0.7, 'overhead']];
  for (const [x, y, want] of cases) {
    const strokes = strokesFrom(run(flick(x, y)));
    assert.equal(strokes.length, 1, `one stroke for ${x},${y}`);
    const got = classifyStroke(strokes[0], { foeSide: 'right' });
    // The same line drawn by a mouse over the same time.
    const s = strokes[0];
    const mouse: StrokePoint[] = [s[0], { x: (s[0].x + s[s.length - 1].x) / 2, y: (s[0].y + s[s.length - 1].y) / 2, t: (s[0].t + s[s.length - 1].t) / 2 }, s[s.length - 1]];
    assert.equal(got.kind, want, `flick ${x},${y}: ${got.kind} ${got.reason ?? ''}`);
    assert.equal(classifyStroke(mouse, { foeSide: 'right' }).kind, got.kind);
  }
});

test('pad: a stick held still adds no points, so a held flick is not slowed down', () => {
  const held = flick(0, 1);
  held.splice(4, 0, ...Array.from({ length: 40 }, () => pad({ axes: [0, 0, 0, 1] })));
  const s = strokesFrom(run(held))[0];
  assert.ok(s.length <= 5, `${s.length} points`);
  assert.equal(classifyStroke(s, { foeSide: 'right' }).kind, 'overhead');
});

test('pad: the spring back to the centre is not part of the stroke', () => {
  const s = strokesFrom(run(flick(0, 1)))[0];
  for (let i = 1; i < s.length; i++) assert.ok(s[i].y >= s[i - 1].y, 'never moves back up');
  assert.ok(s[s.length - 1].y - AREA.cy > 0.9 * AREA.radius);
});

test('pad: a full circle on the right stick is a parry', () => {
  const snaps: PadSnapshot[] = [pad({ axes: [0, 0, 0.5, 0] })];
  for (let i = 0; i <= 24; i++) {
    const a = (i / 24) * 2 * Math.PI;
    snaps.push(pad({ axes: [0, 0, Math.cos(a), Math.sin(a)] }));
  }
  snaps.push(pad());
  const strokes = strokesFrom(run(snaps));
  assert.equal(strokes.length, 1);
  assert.equal(classifyStroke(strokes[0], { foeSide: 'right' }).kind, 'parry');
});

test('pad: a stick already out at the start, or a lost pad, does not draw', () => {
  const r = createPadReader();
  assert.equal(r.read(pad({ axes: [0, 0, 1, 0] }), 0, AREA).strokes.length, 0);
  assert.equal(r.read(pad({ axes: [0, 0, 1, 0] }), 16, AREA).strokes.length, 0);
  r.read(pad(), 32, AREA);
  assert.equal(r.read(pad({ axes: [0, 0, 1, 0] }), 48, AREA).strokes[0]?.type, 'begin');
  const lost = r.read(null, 64, AREA);
  assert.equal(lost.strokes[0]?.type, 'end');
  assert.equal(lost.moves.left || lost.moves.dash || lost.moves.dip, false);
});

test('pad: number buttons and odd axes are read safely', () => {
  const r = createPadReader();
  r.read({ axes: [], buttons: [] }, 0, AREA);
  const f = r.read({ axes: [NaN, Infinity, 5, -5], buttons: [1, 0] }, 16, AREA);
  assert.deepEqual(f.menu, ['confirm']);
  assert.equal(f.strokes[0]?.type, 'begin');
  assert.ok(Number.isFinite(f.strokes[0].type === 'begin' ? f.strokes[0].p.x : NaN));
});
