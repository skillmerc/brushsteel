import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUD_SIDE, hudHiddenOn, hudMeterPx, hudSideCss } from './hudVis.js';

test('ink meter is wider than 100 px at every target screen size', () => {
  for (const w of [800, 1366, 1920, 3440]) assert.ok(hudMeterPx(w) > 100, `meter at ${w}px wide is ${hudMeterPx(w)}`);
  assert.equal(hudMeterPx(800), 240);
  assert.equal(hudMeterPx(3440), HUD_SIDE.max);
  assert.ok(hudMeterPx(200) >= HUD_SIDE.minMeter);
});

test('the HUD side CSS uses the tested numbers', () => {
  assert.equal(hudSideCss(), 'min(30vw,340px)');
});

test('HUD hides on every Path screen and shows in a duel', () => {
  for (const s of ['brush', 'map', 'shrine', 'end']) assert.equal(hudHiddenOn(s), true, s);
  assert.equal(hudHiddenOn('duel'), false);
  assert.equal(hudHiddenOn(''), false);
});
