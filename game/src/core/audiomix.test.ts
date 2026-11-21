import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cuesForEvent, layerGains, moveCue, strokeSpeed, swishSpec, tensionOf, volumeGain } from './audiomix.js';
import { DUEL_RULES } from './duel.js';

test('every sounding duel event maps to its cue', () => {
  const names = (e: Parameters<typeof cuesForEvent>[0]) => cuesForEvent(e).map((c) => c.cue).join(',');
  assert.equal(names({ type: 'strike', who: 0, kind: 'cut', cost: 10, landsAtTick: 5 }), 'swish');
  assert.equal(names({ type: 'clash', push: [1, -1] }), 'clash');
  assert.equal(names({ type: 'parry', who: 1, cost: 5 }), 'parry');
  assert.equal(names({ type: 'guard', who: 0, cost: 5 }), 'guard');
  assert.equal(names({ type: 'blocked', who: 0 }), 'guard');
  assert.equal(names({ type: 'hit', who: 0, kind: 'cut', knockback: 1, score: [1, 0] }), 'splatter');
  assert.equal(names({ type: 'dip-start', who: 0 }), 'dip');
  assert.equal(names({ type: 'dry', who: 0, cost: 10, ink: 2 }), 'dry');
  assert.equal(names({ type: 'feint', who: 1, kind: 'thrust' }), 'swish');
  assert.equal(names({ type: 'whiff', who: 0 }), '');
  assert.equal(names({ type: 'resume' }), '');
  assert.equal(names({ type: 'dip-done', who: 0 }), '');
});

test('the deciding hit is louder and lower than an earlier one', () => {
  const early = cuesForEvent({ type: 'hit', who: 0, kind: 'cut', knockback: 1, score: [1, 0] }, { hitsToWin: 3 })[0];
  const last = cuesForEvent({ type: 'hit', who: 0, kind: 'cut', knockback: 1, score: [3, 2] }, { hitsToWin: 3 })[0];
  assert.ok(last.gain > early.gain);
  assert.ok(last.rate < early.rate);
});

test('a faster stroke swishes louder and higher; bad input gives a middle speed', () => {
  const slow = swishSpec(strokeSpeed(2, 1500), 0);
  const fast = swishSpec(strokeSpeed(8, 100), 0);
  assert.ok(fast.gain > slow.gain);
  assert.ok(fast.rate > slow.rate);
  assert.equal(strokeSpeed(5, 0), 0.5);
  assert.equal(strokeSpeed(Number.NaN, 100), 0.5);
  for (const s of [-1, 0, 0.5, 1, 9]) {
    const c = swishSpec(s, 0);
    assert.ok(c.gain > 0 && c.gain <= 1 && c.rate > 0);
  }
  const ctx = { speed: [1, 0] as [number, number] };
  const p = cuesForEvent({ type: 'strike', who: 0, kind: 'cut', cost: 10, landsAtTick: 5 }, ctx)[0];
  const f = cuesForEvent({ type: 'strike', who: 1, kind: 'cut', cost: 10, landsAtTick: 5 }, ctx)[0];
  assert.ok(p.rate > f.rate);
});

test('footsteps start once per move; a dash is told from a step', () => {
  const from = (DUEL_RULES.STEP_DIST + DUEL_RULES.DASH_DIST) / 2;
  assert.equal(moveCue(0, 9, DUEL_RULES.STEP_DIST / 9, from, 0)?.cue, 'step');
  assert.equal(moveCue(0, 12, -DUEL_RULES.DASH_DIST / 12, from, 0)?.cue, 'dash');
  // A slowed dash (a seal stretches its time) is still a dash.
  assert.equal(moveCue(0, 20, DUEL_RULES.DASH_DIST / 20, from, 1)?.cue, 'dash');
  assert.equal(moveCue(5, 4, 0.1, from, 0), null);
  assert.equal(moveCue(0, 0, 0, from, 0), null);
});

test('tension rises with hits and low ink, is full on the final stroke and zero when over', () => {
  const calm = tensionOf([0, 0], 3, [100, 100], false);
  const one = tensionOf([1, 0], 3, [100, 100], false);
  const dry = tensionOf([0, 0], 3, [10, 15], false);
  assert.ok(calm > 0 && calm < 0.3);
  assert.ok(one > calm);
  assert.ok(dry > calm);
  assert.equal(tensionOf([2, 2], 3, [100, 100], false), 1);
  assert.equal(tensionOf([2, 2], 3, [100, 100], true), 0);
  for (const s of [[0, 0], [1, 2], [2, 0], [5, 5]] as [number, number][]) {
    const t = tensionOf(s, 3, [50, 50], false);
    assert.ok(t >= 0 && t <= 1, String(t));
  }
});

test('layers: drums silent when calm, every layer up when tense', () => {
  const calm = layerGains(0.1);
  const hot = layerGains(1);
  assert.equal(calm.drums, 0);
  assert.ok(calm.wind > 0);
  assert.ok(hot.drums > calm.drums && hot.flute > calm.flute);
  for (const t of [-1, 0, 0.3, 0.6, 1, 2, Number.NaN]) {
    const g = layerGains(t);
    for (const v of [g.drums, g.flute, g.wind]) assert.ok(v >= 0 && v <= 1);
  }
});

test('volume curve: 0 is silent, 100 is full, the middle is quieter than linear', () => {
  assert.equal(volumeGain(0), 0);
  assert.equal(volumeGain(100), 1);
  assert.ok(volumeGain(50) < 0.5 && volumeGain(50) > 0);
  assert.equal(volumeGain(-5), 0);
  assert.equal(volumeGain(500), 1);
  assert.equal(volumeGain(Number.NaN), 0);
});
