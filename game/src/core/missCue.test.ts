import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missCue } from './missCue.js';
import { createDuel, stepDuel, DUEL_RULES as R, type DuelAction } from './duel.js';

test('missCue: each way your stroke fails has a short line; the foe failing has none', () => {
  assert.equal(missCue({ type: 'parry', who: 1, cost: 5 }, 0), 'Parried');
  assert.equal(missCue({ type: 'parry', who: 0, cost: 5 }, 0), null);
  assert.equal(missCue({ type: 'blocked', who: 0 }, 0), 'Turned aside');
  assert.equal(missCue({ type: 'blocked', who: 1 }, 0), null);
  assert.equal(missCue({ type: 'whiff', who: 0 }, 0), 'Out of reach');
  assert.equal(missCue({ type: 'fizzle', who: 0, reason: 'slow' }, 0), 'Too slow');
  assert.equal(missCue({ type: 'fizzle', who: 0, reason: 'busy' }, 0), null);
  assert.equal(missCue({ type: 'dry', who: 0, cost: 9, ink: 2 }, 0), 'Out of ink: dip');
  assert.equal(missCue({ type: 'hit', who: 0, kind: 'cut', knockback: 1, score: [1, 0] }, 0), null);
  for (const line of ['Parried', 'Turned aside', 'Out of reach', 'Too slow', 'Out of ink: dip']) assert.ok(line.length <= 16, line);
});

test('missCue: a cut from too far away in a real duel shows Out of reach', () => {
  const d = createDuel(4);
  d.state.fighters[0].x = -3;
  d.state.fighters[1].x = 3;
  const cut: DuelAction = { type: 'stroke', kind: 'cut', speed: 25, segment: { a: { x: -2.6, y: 2 }, b: { x: -0.8, y: 0.8 } }, length: 2.2 };
  const lines: string[] = [];
  for (let i = 0; i < 12; i++) for (const e of stepDuel(d, [i === 0 ? cut : null, null])) { const l = missCue(e, 0); if (l) lines.push(l); }
  assert.ok(Math.abs(d.state.fighters[1].x - d.state.fighters[0].x) > R.REACH_CUT);
  assert.deepEqual(lines, ['Out of reach']);
});
