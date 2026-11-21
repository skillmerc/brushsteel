import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRng, seedFromString } from './rng.js';

test('same seed gives the same sequence', () => {
  const a = createRng(42);
  const b = createRng(42);
  for (let i = 0; i < 100; i++) assert.equal(a.next(), b.next());
});

test('different seeds give different sequences', () => {
  const a = createRng(1);
  const b = createRng(2);
  const same = Array.from({ length: 20 }, () => a.next() === b.next()).filter(Boolean).length;
  assert.ok(same < 2, `too many equal values: ${same}`);
});

test('next stays in [0, 1) and spreads out', () => {
  const r = createRng(7);
  const buckets = new Array(10).fill(0);
  for (let i = 0; i < 10000; i++) {
    const v = r.next();
    assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
    buckets[Math.floor(v * 10)]++;
  }
  for (const n of buckets) assert.ok(n > 800 && n < 1200, `uneven bucket ${n}`);
});

test('int covers both ends and nothing outside', () => {
  const r = createRng(99);
  const seen = new Set<number>();
  for (let i = 0; i < 2000; i++) {
    const v = r.int(-2, 3);
    assert.ok(Number.isInteger(v) && v >= -2 && v <= 3, `bad int ${v}`);
    seen.add(v);
  }
  assert.equal(seen.size, 6);
});

test('int rejects a bad range', () => {
  assert.throws(() => createRng(1).int(5, 1), RangeError);
});

test('seedFromString is stable and spreads', () => {
  assert.equal(seedFromString('2026-11-19'), seedFromString('2026-11-19'));
  assert.notEqual(seedFromString('2026-11-19'), seedFromString('2026-11-20'));
  assert.equal(typeof seedFromString(''), 'number');
});
