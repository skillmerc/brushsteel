// Duel length and the wind-up rule, by scripted players.
//
// Seeded duels over the duel core at its fixed 60 Hz tick, no DOM. Four
// scripted players face master 1 (Oro, STYLES.patient):
//   SPAMMER         strikes as often as it can, steps in when out of reach
//   WINDUP-STRIKER  strikes the moment each new master line appears
//   PARRIER         cuts across each master line inside the parry window, then ripostes
//   IDLE            does nothing
// Bars: median duel 30 s or more for every
// player that finishes; SPAMMER and WINDUP-STRIKER win under half their
// duels; PARRIER wins over half; IDLE never wins.

import test from 'node:test';
import assert from 'node:assert/strict';
import { canAct, createDuel, inkCost, stepDuel, DUEL_RULES, type Duel, type DuelAction, type Segment } from './duel.js';
import { STYLES, aiAct, createAi, parryCutAcross, telegraphSegment, type AiStyle } from './ai.js';

type Bot = (duel: Duel, mem: { judged: number }) => DuelAction | null;

const R = DUEL_RULES;
const segLen = (s: Segment) => Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
const cutAction = (seg: Segment): DuelAction => ({ type: 'stroke', kind: 'cut', speed: 25, segment: seg, length: segLen(seg) });

function hold(duel: Duel, target: number): DuelAction | null {
  const [me, foe] = duel.state.fighters;
  const gap = Math.abs(foe.x - me.x);
  if (gap > target + 0.25) return { type: 'step', dir: 'in' };
  return null;
}

function lowInk(duel: Duel): boolean {
  const me = duel.state.fighters[0];
  const line = telegraphSegment('cut', me, 0.5, duel.rules);
  return me.ink < inkCost('cut', segLen(line), 25, duel.rules);
}

const SPAMMER: Bot = (duel) => {
  if (duel.state.phase !== 'fight') return null;
  const [me, foe] = duel.state.fighters;
  if (!canAct(me)) return null;
  if (lowInk(duel)) return { type: 'dip' };
  if (Math.abs(foe.x - me.x) > R.REACH_CUT - 0.1) return { type: 'step', dir: 'in' };
  return cutAction(telegraphSegment('cut', me, 0.5, duel.rules));
};

const WINDUP_STRIKER: Bot = (duel, mem) => {
  if (duel.state.phase !== 'fight') return null;
  const [me, foe] = duel.state.fighters;
  const t = foe.strike;
  if (t && t.startTick !== mem.judged && canAct(me)) {
    mem.judged = t.startTick;
    if (!lowInk(duel)) return cutAction(telegraphSegment('cut', me, 0.5, duel.rules));
  }
  if (!canAct(me) || t) return null;
  if (lowInk(duel) || me.ink < 30) return { type: 'dip' };
  return hold(duel, 2.2);
};

const PARRIER: Bot = (duel, mem) => {
  if (duel.state.phase !== 'fight') return null;
  const [me, foe] = duel.state.fighters;
  const t = foe.strike;
  const gap = Math.abs(foe.x - me.x);
  if (t && t.startTick !== mem.judged && canAct(me)) {
    const msLeft = (t.landsAtTick - duel.state.tick) * (1000 / duel.rules.TICK_HZ);
    if (msLeft <= duel.rules.PARRY_WINDOW_MS - 100) {
      mem.judged = t.startTick;
      return cutAction(parryCutAcross(t.segment));
    }
    return null;
  }
  if (!canAct(me)) return null;
  if (me.riposte > 0 && gap <= R.REACH_CUT) return cutAction(telegraphSegment('cut', me, 0.5, duel.rules));
  if (t) return null;
  if (me.ink < 30) return { type: 'dip' };
  return hold(duel, 2.2);
};

const IDLE: Bot = () => null;

interface Tally {
  wins: number;
  finished: number;
  medianS: number;
  winRate: number;
}

function play(bot: Bot, style: AiStyle, seeds: number): Tally {
  const lengths: number[] = [];
  let wins = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const duel = createDuel(seed);
    const ai = createAi(style, 1, seed);
    const mem = { judged: -1 };
    const maxTicks = 60 * 300;
    while (duel.state.phase !== 'over' && duel.state.tick < maxTicks) stepDuel(duel, [bot(duel, mem), aiAct(ai, duel)]);
    if (duel.state.phase === 'over') {
      lengths.push(duel.state.tick / 60);
      if (duel.state.winner === 0) wins++;
    }
  }
  lengths.sort((a, b) => a - b);
  const medianS = lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0;
  return { wins, finished: lengths.length, medianS, winRate: wins / seeds };
}

const SEEDS = 60;
const oro = STYLES.patient;
const res = {
  spammer: play(SPAMMER, oro, SEEDS),
  windup: play(WINDUP_STRIKER, oro, SEEDS),
  parrier: play(PARRIER, oro, SEEDS),
  idle: play(IDLE, oro, SEEDS),
};
const fmt = (t: Tally) => `median ${t.medianS.toFixed(1)} s, won ${t.wins}/${SEEDS}, finished ${t.finished}`;
console.log(`# duel length vs Oro: SPAMMER ${fmt(res.spammer)}; WINDUP-STRIKER ${fmt(res.windup)}; PARRIER ${fmt(res.parrier)}; IDLE ${fmt(res.idle)}`);

test(`median duel vs Oro is 30 s or more for every scripted player that finishes (SPAMMER ${res.spammer.medianS.toFixed(1)}, WINDUP-STRIKER ${res.windup.medianS.toFixed(1)}, PARRIER ${res.parrier.medianS.toFixed(1)}, IDLE ${res.idle.medianS.toFixed(1)} s)`, () => {
  for (const [name, t] of Object.entries(res)) {
    if (t.finished === 0) continue;
    assert.ok(t.medianS >= 30, `${name}: median ${t.medianS} s`);
  }
});

test(`spamming and striking each wind-up lose to Oro (SPAMMER ${res.spammer.wins}/${SEEDS}, WINDUP-STRIKER ${res.windup.wins}/${SEEDS} wins)`, () => {
  assert.ok(res.spammer.winRate < 0.5, `spammer won ${res.spammer.wins}`);
  assert.ok(res.windup.winRate < 0.5, `windup striker won ${res.windup.wins}`);
});

test(`parrying each line beats Oro (PARRIER ${res.parrier.wins}/${SEEDS} wins)`, () => {
  assert.ok(res.parrier.winRate > 0.5, `parrier won ${res.parrier.wins}`);
});

test(`idling never wins: Oro still attacks (IDLE ${res.idle.wins}/${SEEDS} wins, ${res.idle.finished} finished)`, () => {
  assert.equal(res.idle.wins, 0);
  assert.equal(res.idle.finished, SEEDS);
});

test('a strike into a committed wind-up is turned aside and the line lands; a parry still works', () => {
  // Fighter 1 shows a 900 ms line; fighter 0 strikes into it 100 ms later.
  const d = createDuel(7);
  d.state.fighters[0].x = -1;
  d.state.fighters[1].x = 1;
  const foe = d.state.fighters[1];
  const line = telegraphSegment('cut', foe, 0.5, d.rules);
  stepDuel(d, [null, { type: 'stroke', kind: 'cut', speed: 20, segment: line, length: segLen(line), windupMs: 900 }]);
  for (let i = 0; i < 5; i++) stepDuel(d, [null, null]);
  const me = d.state.fighters[0];
  stepDuel(d, [cutAction(telegraphSegment('cut', me, 0.5, d.rules)), null]);
  const seen: string[] = [];
  for (let i = 0; i < 70 && d.state.phase === 'fight'; i++) for (const e of stepDuel(d, [null, null])) seen.push(e.type);
  assert.ok(seen.includes('blocked'), seen.join(','));
  assert.deepEqual(d.state.score, [0, 1]);

  // Same line, cut across inside the window: a parry, no point.
  const p = createDuel(7);
  p.state.fighters[0].x = -1;
  p.state.fighters[1].x = 1;
  const foe2 = p.state.fighters[1];
  const line2 = telegraphSegment('cut', foe2, 0.5, p.rules);
  stepDuel(p, [null, { type: 'stroke', kind: 'cut', speed: 20, segment: line2, length: segLen(line2), windupMs: 900 }]);
  for (let i = 0; i < 40; i++) stepDuel(p, [null, null]);
  const ev = stepDuel(p, [cutAction(parryCutAcross(line2)), null]);
  assert.ok(ev.some((e) => e.type === 'parry'));
  assert.deepEqual(p.state.score, [0, 0]);
});

test('a parry cut may be drawn mid-step: it stops the step and parries', () => {
  const d = createDuel(9);
  d.state.fighters[0].x = -1;
  d.state.fighters[1].x = 1;
  const foe = d.state.fighters[1];
  const line = telegraphSegment('cut', foe, 0.5, d.rules);
  stepDuel(d, [null, { type: 'stroke', kind: 'cut', speed: 20, segment: line, length: segLen(line), windupMs: 900 }]);
  for (let i = 0; i < 38; i++) stepDuel(d, [null, null]);
  stepDuel(d, [{ type: 'step', dir: 'out' }, null]);
  assert.ok(d.state.fighters[0].moveTicks > 0);
  const ev = stepDuel(d, [cutAction(parryCutAcross(line)), null]);
  assert.ok(ev.some((e) => e.type === 'parry'), JSON.stringify(ev));
  assert.equal(d.state.fighters[0].moveTicks, 0);
});

test('Oro cuts a stroke started first and does not strike back or rush the stunned player', () => {
  const d = createDuel(11);
  const ai = createAi(oro, 1, 11);
  d.state.fighters[0].x = -1;
  d.state.fighters[1].x = 1.1;
  let parries = 0;
  let oroStrikes = 0;
  const me = d.state.fighters[0];
  for (let i = 0; i < 40; i++) {
    const a = i === 0 ? cutAction(telegraphSegment('cut', me, 0.5, d.rules)) : null;
    for (const e of stepDuel(d, [a, aiAct(ai, d)])) {
      if (e.type === 'parry' && e.who === 1) parries++;
      if (e.type === 'strike' && e.who === 1) oroStrikes++;
    }
  }
  assert.equal(parries, 1);
  assert.equal(oroStrikes, 0);
  assert.deepEqual(d.state.score, [0, 0]);
});
