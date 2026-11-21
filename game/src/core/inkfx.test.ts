import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from './rng.js';
import {
  INK_PRESETS, INK_QUALITIES, MIST_LAYERS, SPRAY_CAPACITY, SPRAY_PHYSICS, SprayPool,
  mistLayersFor, mistOffset, parseQuality, sprayAlpha, targetSize,
} from './inkfx.js';

test('presets: low is half-res and cheapest, high is full-res; all inside the pool and 2 to 4 mist layers', () => {
  assert.equal(INK_PRESETS.low.scale, 0.5);
  assert.equal(INK_PRESETS.high.scale, 1);
  assert.deepEqual(INK_QUALITIES, ['low', 'medium', 'high']);
  for (let i = 1; i < INK_QUALITIES.length; i++) {
    const a = INK_PRESETS[INK_QUALITIES[i - 1]];
    const b = INK_PRESETS[INK_QUALITIES[i]];
    assert.ok(a.scale <= b.scale && a.bleedTaps <= b.bleedTaps && a.mistLayers <= b.mistLayers && a.sprayLimit <= b.sprayLimit);
  }
  for (const q of INK_QUALITIES) {
    const p = INK_PRESETS[q];
    assert.ok(p.sprayLimit > 0 && p.sprayLimit <= SPRAY_CAPACITY, q);
    assert.ok(mistLayersFor(q) >= 2 && mistLayersFor(q) <= 4, q);
  }
});

test('targetSize: half-res on low, never below 1 px', () => {
  assert.deepEqual(targetSize(1920, 1080, 'low'), { width: 960, height: 540 });
  assert.deepEqual(targetSize(1920, 1080, 'high'), { width: 1920, height: 1080 });
  assert.deepEqual(targetSize(1, 1, 'low'), { width: 1, height: 1 });
});

test('parseQuality reads ?quality= and falls back', () => {
  assert.equal(parseQuality('?quality=low'), 'low');
  assert.equal(parseQuality('?debug=poses&quality=high'), 'high');
  assert.equal(parseQuality('?quality=ultra'), 'medium');
  assert.equal(parseQuality('', 'low'), 'low');
});

test('mist parallax: zero at rest, linear in camera x, near layers move more than far ones', () => {
  for (let i = 0; i < MIST_LAYERS.length; i++) assert.equal(mistOffset(i, 0, 0), 0);
  for (let i = 1; i < MIST_LAYERS.length; i++) {
    assert.ok(MIST_LAYERS[i].parallax > MIST_LAYERS[i - 1].parallax);
    assert.ok(Math.abs(mistOffset(i, 2, 0)) > Math.abs(mistOffset(i - 1, 2, 0)));
  }
  assert.ok(Math.abs(mistOffset(2, 3, 0) - 3 * mistOffset(2, 1, 0)) < 1e-9);
  assert.ok(mistOffset(0, 0, 10) > 0, 'wind drift moves the mist with time');
  for (const l of MIST_LAYERS) assert.ok(l.parallax > 0 && l.parallax < 1 && l.alpha > 0 && l.alpha < 0.5);
});

test('spray: emit spawns the asked count at the point, flying roughly along dir', () => {
  const pool = new SprayPool(createRng(1));
  pool.emit(1, 2, 0, 50);
  assert.equal(pool.live, 50);
  let sumVx = 0;
  for (let i = 0; i < 50; i++) {
    assert.equal(pool.x[i], 1);
    assert.equal(pool.y[i], 2);
    assert.ok(pool.life[i] >= SPRAY_PHYSICS.lifeMin && pool.life[i] <= SPRAY_PHYSICS.lifeMax);
    sumVx += pool.vx[i];
  }
  assert.ok(sumVx > 50 * SPRAY_PHYSICS.speedMin * 0.5, 'mean velocity points along +x');
});

test('spray: no growth past 2000, oldest slot recycled when full', () => {
  const pool = new SprayPool(createRng(2));
  assert.equal(pool.capacity, SPRAY_CAPACITY);
  const xs = pool.x;
  pool.emit(0, 0, 1, 2000);
  assert.equal(pool.live, 2000);
  pool.step(0.1);
  assert.equal(pool.live, 2000);
  assert.ok(pool.age[0] > 0);
  pool.emit(5, 5, 1, 1);
  assert.equal(pool.live, 2000, 'still 2000 after one more');
  assert.equal(pool.age[0], 0, 'slot 0 (the oldest) was reused');
  assert.equal(pool.x[0], 5);
  pool.emit(0, 0, 1, 5000);
  assert.equal(pool.live, 2000);
  assert.ok(pool.x === xs && pool.x.length === 2000, 'same storage, same length');
});

test('spray: preset limit caps live drops and lowering it kills the rest', () => {
  const pool = new SprayPool(createRng(3), SPRAY_CAPACITY, INK_PRESETS.low.sprayLimit);
  pool.emit(0, 0, 0, 1500);
  assert.equal(pool.live, INK_PRESETS.low.sprayLimit);
  pool.setLimit(INK_PRESETS.high.sprayLimit);
  pool.emit(0, 0, 0, 1000);
  assert.equal(pool.live, 1600);
  pool.setLimit(100);
  assert.equal(pool.live, 100);
  pool.setLimit(99999);
  assert.equal(pool.limit, SPRAY_CAPACITY);
});

test('spray: life runs out, drops fall under gravity and fade to nothing', () => {
  const pool = new SprayPool(createRng(4));
  pool.emit(0, 0, Math.PI / 2, 20);
  const vy0 = pool.vy[0];
  pool.step(0.05);
  assert.ok(pool.vy[0] < vy0, 'gravity pulls down');
  for (let t = 0; t < 1.2; t += 0.05) pool.step(0.05);
  assert.equal(pool.live, 0, 'all dead after the longest life');
  assert.equal(sprayAlpha(0, 1), 1);
  assert.equal(sprayAlpha(0.5, 1), 1);
  assert.ok(sprayAlpha(0.8, 1) > 0 && sprayAlpha(0.8, 1) < 1);
  assert.equal(sprayAlpha(1, 1), 0);
  let prev = 1;
  for (let a = 0; a <= 1; a += 0.05) {
    const v = sprayAlpha(a, 1);
    assert.ok(v <= prev + 1e-12, 'fade never brightens');
    prev = v;
  }
});

test('spray: write packs only live drops and leaves storage untouched in size', () => {
  const pool = new SprayPool(createRng(5));
  const m = new Float32Array(SPRAY_CAPACITY * 16);
  const a = new Float32Array(SPRAY_CAPACITY * 2);
  assert.equal(pool.write(m, a), 0);
  pool.emit(3, -1, 0, 10);
  pool.step(0.02);
  const n = pool.write(m, a, 0.5);
  assert.equal(n, 10);
  for (let i = 0; i < n; i++) {
    assert.ok(a[i * 2] > 0 && a[i * 2] <= 1, 'alpha in range');
    assert.equal(m[i * 16 + 14], 0.5, 'z written');
    assert.equal(m[i * 16 + 15], 1);
    // The quad is stretched along the velocity: the x axis is at least as long as the y axis.
    assert.ok(Math.hypot(m[i * 16], m[i * 16 + 1]) >= Math.hypot(m[i * 16 + 4], m[i * 16 + 5]) - 1e-6);
  }
  assert.equal(m.length, SPRAY_CAPACITY * 16);
});
