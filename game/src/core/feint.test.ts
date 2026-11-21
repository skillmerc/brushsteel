// Feint action: a pending strike can be dropped before it lands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDuel, stepDuel, DUEL_RULES, msToTicks, type Duel, type DuelAction, type DuelEvent, type Segment } from './duel.js';

const seg = (ax: number, ay: number, bx: number, by: number): Segment => ({ a: { x: ax, y: ay }, b: { x: bx, y: by } });
const FOE_LINE = seg(1.6, 2, 0.2, 0.8);
const FOE_ATTACK: DuelAction = { type: 'stroke', kind: 'cut', speed: 20, segment: FOE_LINE, length: 2, windupMs: 600 };
const PLAYER_CUT: DuelAction = { type: 'stroke', kind: 'cut', speed: 20, segment: seg(-0.4, 1.4, 0.4, 1.4), length: 2 };

function setGap(d: Duel, gap: number): void {
  d.state.fighters[0].x = -gap / 2;
  d.state.fighters[1].x = gap / 2;
}
function run(d: Duel, n: number, a: [DuelAction | null, DuelAction | null] = [null, null]): DuelEvent[] {
  const all: DuelEvent[] = [];
  for (let i = 0; i < n; i++) all.push(...stepDuel(d, i === 0 ? a : [null, null]));
  return all;
}
const types = (ev: DuelEvent[]) => ev.map((e) => e.type);

test('feint drops a pending strike: no hit, no refund, short recovery', () => {
  const d = createDuel(3);
  setGap(d, 2);
  run(d, 1, [null, FOE_ATTACK]);
  const strike = d.state.fighters[1].strike;
  assert.ok(strike);
  const inkAfterStrike = d.state.fighters[1].ink;
  const ev = run(d, 1, [null, { type: 'feint' }]);
  assert.deepEqual(types(ev), ['feint']);
  assert.equal(d.state.fighters[1].strike, null);
  assert.equal(d.state.fighters[1].ink, inkAfterStrike);
  assert.equal(d.state.fighters[1].recover, msToTicks(DUEL_RULES.FEINT_RECOVER_MS));
  const later = run(d, 60);
  assert.ok(!types(later).includes('hit'));
  assert.deepEqual(d.state.score, [0, 0]);
});

test('feint with nothing pending, or while stunned, does nothing', () => {
  const d = createDuel(4);
  setGap(d, 2);
  assert.deepEqual(run(d, 1, [{ type: 'feint' }, null]), []);
  assert.equal(d.state.fighters[0].recover, 0);
  run(d, 1, [null, FOE_ATTACK]);
  d.state.fighters[1].stun = 10;
  assert.deepEqual(run(d, 1, [null, { type: 'feint' }]), []);
  assert.ok(d.state.fighters[1].strike, 'still pending');
});

test('feint on the landing tick still drops the strike (actions apply before landings)', () => {
  const d = createDuel(5);
  setGap(d, 2);
  run(d, 1, [null, FOE_ATTACK]);
  const lands = d.state.fighters[1].strike!.landsAtTick;
  run(d, lands - d.state.tick - 1);
  assert.equal(d.state.tick, lands - 1);
  const ev = run(d, 1, [null, { type: 'feint' }]);
  assert.deepEqual(types(ev), ['feint']);
  assert.deepEqual(d.state.score, [0, 0]);
});

test('the player can feint too, and stroke again after the recovery', () => {
  const d = createDuel(6);
  setGap(d, 2);
  run(d, 1, [{ ...PLAYER_CUT, windupMs: 400 }, null]);
  assert.ok(d.state.fighters[0].strike);
  const ev = run(d, 1, [{ type: 'feint' }, null]);
  assert.deepEqual(ev, [{ type: 'feint', who: 0, kind: 'cut' }]);
  const busy = run(d, 1, [PLAYER_CUT, null]);
  assert.deepEqual(types(busy), ['fizzle']);
  run(d, msToTicks(DUEL_RULES.FEINT_RECOVER_MS));
  const again = run(d, 1, [PLAYER_CUT, null]);
  assert.deepEqual(types(again), ['strike']);
});

test('cutting where a feinted line was is not a parry', () => {
  const d = createDuel(7);
  setGap(d, 2);
  run(d, 1, [null, FOE_ATTACK]);
  run(d, 20, [null, null]);
  run(d, 1, [null, { type: 'feint' }]);
  const ev = run(d, 1, [{ ...PLAYER_CUT, segment: seg(0.9, 0.6, 0.9, 2.2) }, null]);
  assert.ok(!types(ev).includes('parry'));
  assert.deepEqual(types(ev), ['strike']);
});

test('a parry still works against the real line after a feint', () => {
  const d = createDuel(8);
  setGap(d, 2);
  run(d, 1, [null, FOE_ATTACK]);
  run(d, 1, [null, { type: 'feint' }]);
  run(d, msToTicks(DUEL_RULES.FEINT_RECOVER_MS));
  run(d, 1, [null, { ...FOE_ATTACK, windupMs: 250 }]);
  const ev = run(d, 1, [{ ...PLAYER_CUT, segment: seg(0.9, 0.6, 0.9, 2.2) }, null]);
  assert.ok(types(ev).includes('parry'));
});
