import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capPixelRatio, fitStage } from './fit.js';

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('16:9 window shows exactly the stage', () => {
  const f = fitStage(1920, 1080, 1);
  close(f.right - f.left, 16);
  close(f.top - f.bottom, 9);
});

test('wide window keeps stage height and widens the view', () => {
  const f = fitStage(2560, 1080, 1);
  close(f.top - f.bottom, 9);
  close(f.right - f.left, 9 * (2560 / 1080));
  assert.ok(f.right - f.left > 16);
});

test('tall window keeps stage width and heightens the view', () => {
  const f = fitStage(800, 1200, 1);
  close(f.right - f.left, 16);
  close(f.top - f.bottom, 16 / (800 / 1200));
});

test('frustum is centred and matches the window aspect', () => {
  for (const [w, h] of [[1024, 640], [1366, 768], [2560, 1440], [390, 844]]) {
    const f = fitStage(w, h, 1);
    close(f.left, -f.right);
    close(f.bottom, -f.top);
    close((f.right - f.left) / (f.top - f.bottom), w / h);
  }
});

test('pixel ratio is capped at 2 and sane', () => {
  assert.equal(capPixelRatio(1), 1);
  assert.equal(capPixelRatio(1.5), 1.5);
  assert.equal(capPixelRatio(3), 2);
  assert.equal(capPixelRatio(0), 1);
  assert.equal(capPixelRatio(Number.NaN), 1);
  assert.equal(fitStage(100, 100, 4).pixelRatio, 2);
});

test('zero or fractional sizes never break the maths', () => {
  const f = fitStage(0, 0, 1);
  assert.equal(f.width, 1);
  assert.equal(f.height, 1);
  assert.ok(Number.isFinite(f.left) && Number.isFinite(f.top));
  assert.equal(fitStage(1023.7, 639.2, 1).width, 1023);
});
