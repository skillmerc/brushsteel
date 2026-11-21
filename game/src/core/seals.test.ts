// One effect test per seal (12) and per brush (3): each shows, in a scripted
// duel, the rule change its text names. Plus: no mods (or empty mods) leave a
// whole duel exactly as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDuel, msToTicks, stepDuel, type Duel, type DuelAction, type DuelEvent, type FighterMods, type Segment } from './duel.js';
import { aiAct, createAi, createRefPlayer, parryCutAcross, refPlayerAct, REF_PLAYER, REF_PLAYER_SLOW, telegraphSegment } from './ai.js';
import { masterByIndex } from './masters.js';
import { brushById, sealById, type SealId } from './path.js';
import { simulateModDuel } from './pathsim.js';

const duelWith = (m: FighterMods | null) => createDuel(5, m ? { mods: [m, null] } : {});
const seal = (id: SealId) => sealById(id).mods;
const cutLine = (d: Duel, who: 0 | 1): Segment => telegraphSegment('cut', d.state.fighters[who], 0.5, d.rules);
const stroke = (segment: Segment, windupMs?: number): DuelAction => {
  const a: DuelAction = { type: 'stroke', kind: 'cut', speed: 20, segment, length: Math.hypot(segment.b.x - segment.a.x, segment.b.y - segment.a.y) };
  if (windupMs !== undefined) a.windupMs = windupMs;
  return a;
};
const ofType = <T extends DuelEvent['type']>(ev: DuelEvent[], t: T) => ev.find((e) => e.type === t) as Extract<DuelEvent, { type: T }> | undefined;

/** Fighters at a gap of `gap`, centred. */
function placeAt(d: Duel, gap: number): void {
  d.state.fighters[0].x = -gap / 2;
  d.state.fighters[1].x = gap / 2;
}

/** The foe (fighter 1) starts a cut with this windup; the player cuts across it when `msLeft` ms remain. Returns the player's events. */
function parryAt(m: FighterMods | null, windupMs: number, msLeft: number): { d: Duel; ev: DuelEvent[]; foeLands: number } {
  const d = duelWith(m);
  placeAt(d, 2.0);
  stepDuel(d, [null, stroke(cutLine(d, 1), windupMs)]);
  const s = d.state.fighters[1].strike;
  assert.ok(s, 'foe strike pending');
  const lands = s.landsAtTick;
  const at = lands - msToTicks(msLeft, d.rules);
  while (d.state.tick + 1 < at) stepDuel(d, [null, null]);
  const ev = stepDuel(d, [stroke(parryCutAcross(s.segment)), null]);
  return { d, ev, foeLands: lands };
}

/** The player cuts the idle foe at a gap; returns the events through the landing. */
function playerCut(m: FighterMods | null, gap: number): { d: Duel; ev: DuelEvent[] } {
  const d = duelWith(m);
  placeAt(d, gap);
  const ev: DuelEvent[] = [];
  ev.push(...stepDuel(d, [stroke(cutLine(d, 0)), null]));
  for (let i = 0; i < 30 && !ev.some((e) => e.type === 'hit' || e.type === 'whiff'); i++) ev.push(...stepDuel(d, [null, null]));
  return { d, ev };
}

/** Ticks until the foe's 350 ms line lands. */
function foeWindupTicks(m: FighterMods | null): number {
  const d = duelWith(m);
  placeAt(d, 2.0);
  stepDuel(d, [null, stroke(cutLine(d, 1), 350)]);
  const s = d.state.fighters[1].strike!;
  return s.landsAtTick - s.startTick;
}

test('seal long-riposte: a parry stuns the foe 600 ms, not 400', () => {
  assert.equal(parryAt(null, 600, 200).d.state.fighters[0].riposte, 24);
  const { d, ev } = parryAt(seal('long-riposte'), 600, 200);
  assert.ok(ofType(ev, 'parry'));
  assert.equal(d.state.fighters[0].riposte, 36);
  assert.equal(d.state.fighters[1].stun, 36);
});

test('seal thrifty-cut: cuts cost 40% less ink', () => {
  const base = ofType(playerCut(null, 2.0).ev, 'strike')!.cost;
  const cheap = ofType(playerCut(seal('thrifty-cut'), 2.0).ev, 'strike')!.cost;
  assert.ok(Math.abs(cheap - base * 0.6) < 1e-9, `${cheap} vs ${base}`);
});

test('seal open-window: a cut 380 ms before the foe lands parries only with the seal', () => {
  assert.equal(ofType(parryAt(null, 700, 380).ev, 'parry'), undefined, 'outside the 300 ms window');
  assert.ok(ofType(parryAt(seal('open-window'), 700, 380).ev, 'parry'), 'inside the 400 ms window');
});

test('seal quick-dip: dipping takes 420 ms, not 700', () => {
  for (const [m, ticks] of [[null, 42], [seal('quick-dip'), 26]] as const) {
    const d = duelWith(m);
    d.state.fighters[0].ink = 50;
    stepDuel(d, [{ type: 'dip' }, null]);
    assert.equal(d.state.fighters[0].dip, ticks);
  }
});

test('seal iron-circle: a circle guard costs 3 ink, not 6, and lasts 500 ms, not 250', () => {
  const guard = (m: FighterMods | null) => {
    const d = duelWith(m);
    const ev = stepDuel(d, [{ type: 'stroke', kind: 'parry', speed: 20, segment: { a: { x: 0, y: 0 }, b: { x: 0, y: 1 } } }, null]);
    return { cost: ofType(ev, 'guard')!.cost, ticks: d.state.fighters[0].guard, ink: d.state.fighters[0].ink };
  };
  assert.deepEqual(guard(null), { cost: 6, ticks: 15, ink: 94 });
  assert.deepEqual(guard(seal('iron-circle')), { cost: 3, ticks: 30, ink: 97 });
});

test('seal heavy-hand: hits knock the foe back 50% further', () => {
  const a = ofType(playerCut(null, 2.0).ev, 'hit')!.knockback;
  const b = ofType(playerCut(seal('heavy-hand'), 2.0).ev, 'hit')!.knockback;
  assert.ok(Math.abs(b - a * 1.5) < 1e-9, `${b} vs ${a}`);
});

test('seal slow-ink: foe lines show 50 ms longer', () => {
  assert.equal(foeWindupTicks(null), 21);
  assert.equal(foeWindupTicks(seal('slow-ink')), 24);
});

test('seal deep-well: the brush holds 130 ink and refills to 130', () => {
  const d = duelWith(seal('deep-well'));
  assert.equal(d.state.fighters[0].ink, 130);
  assert.equal(d.state.fighters[1].ink, 100, 'the foe is unchanged');
  d.state.fighters[0].ink = 110;
  stepDuel(d, [{ type: 'dip' }, null]);
  for (let i = 0; i < 50; i++) stepDuel(d, [null, null]);
  assert.equal(d.state.fighters[0].ink, 130);
  const plain = duelWith(null);
  plain.state.fighters[0].ink = 110;
  stepDuel(plain, [{ type: 'dip' }, null]);
  assert.equal(plain.state.fighters[0].dip, 0, 'plain: 110 ink is over the 100 cap, no dip');
});

test('seal light-feet: a step takes 7 ticks, not 9', () => {
  for (const [m, ticks] of [[null, 9], [seal('light-feet'), 7]] as const) {
    const d = duelWith(m);
    stepDuel(d, [{ type: 'step', dir: 'in' }, null]);
    assert.equal(d.state.fighters[0].moveTicks + 1, ticks);
  }
});

test('seal long-blade: a cut reaches 0.3 further (gap 2.6 hits, plain cut whiffs)', () => {
  assert.ok(ofType(playerCut(null, 2.6).ev, 'whiff'));
  assert.ok(ofType(playerCut(seal('long-blade'), 2.6).ev, 'hit'));
});

test('seal blood-pact: hits count double, the parry window is 100 ms shorter', () => {
  const hit = ofType(playerCut(seal('blood-pact'), 2.0).ev, 'hit')!;
  assert.deepEqual(hit.score, [2, 0]);
  assert.ok(ofType(parryAt(null, 700, 250).ev, 'parry'), 'plain: 250 ms left parries');
  assert.equal(ofType(parryAt(seal('blood-pact'), 700, 250).ev, 'parry'), undefined, 'pact: window is 200 ms');
  // Two doubled hits win (3 to win).
  const d = playerCut(seal('blood-pact'), 2.0).d;
  assert.equal(d.state.phase, 'point');
});

test('seal thin-line: foe lines land 80 ms sooner, the riposte lasts twice as long', () => {
  assert.equal(foeWindupTicks(seal('thin-line')), 17);
  assert.equal(parryAt(seal('thin-line'), 600, 200).d.state.fighters[0].riposte, 48);
});

test('brush wide: strokes land 60 ms later, cost 20% more, knock back 40% further, reach 0.2 more', () => {
  const plain = playerCut(null, 2.0);
  const wide = playerCut(brushById('wide').mods, 2.0);
  const sp = ofType(plain.ev, 'strike')!;
  const sw = ofType(wide.ev, 'strike')!;
  assert.equal(sw.landsAtTick - sp.landsAtTick, 4);
  assert.ok(Math.abs(sw.cost - sp.cost * 1.2) < 1e-9);
  assert.ok(Math.abs(ofType(wide.ev, 'hit')!.knockback - ofType(plain.ev, 'hit')!.knockback * 1.4) < 1e-9);
  assert.ok(ofType(playerCut(brushById('wide').mods, 2.55).ev, 'hit'));
});

test('brush fine: 25% less ink, 30% less knockback, 0.2 less reach', () => {
  const plain = playerCut(null, 2.0);
  const fine = playerCut(brushById('fine').mods, 2.0);
  assert.ok(Math.abs(ofType(fine.ev, 'strike')!.cost - ofType(plain.ev, 'strike')!.cost * 0.75) < 1e-9);
  assert.ok(Math.abs(ofType(fine.ev, 'hit')!.knockback - ofType(plain.ev, 'hit')!.knockback * 0.7) < 1e-9);
  assert.ok(ofType(playerCut(brushById('fine').mods, 2.3).ev, 'whiff'));
  assert.ok(ofType(playerCut(null, 2.3).ev, 'hit'));
});

test('brush standard, and no mods at all: whole duels are the same as the plain duel', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const runs = [undefined, [null, null], [brushById('standard').mods, null], [{}, {}]] as const;
    const states = runs.map((mods) => {
      const d = createDuel(seed, mods ? { mods: mods as [FighterMods | null, FighterMods | null] } : {});
      for (let i = 0; i < 3000; i++) stepDuel(d, [i % 97 === 0 ? stroke(cutLine(d, 0)) : i % 13 === 0 ? { type: 'step', dir: 'in' } : null, i % 71 === 5 ? stroke(cutLine(d, 1), 400) : null]);
      return JSON.stringify(d.state);
    });
    assert.ok(states.every((s) => s === states[0]), `seed ${seed}: mods changed a plain duel`);
    const w = [simulateModDuel(seed, 4, REF_PLAYER_SLOW, undefined), simulateModDuel(seed, 4, REF_PLAYER_SLOW, [brushById('standard').mods, null])];
    assert.equal(w[0], w[1]);
    for (const m of [2, 6]) {
      const logs = [undefined, [{}, {}]].map((mods) => {
        const d = createDuel(seed, mods ? { mods: mods as [FighterMods | null, FighterMods | null] } : {});
        const ai = createAi(masterByIndex(m).style, 1, seed);
        const bot = createRefPlayer(REF_PLAYER_SLOW, seed);
        const log: string[] = [];
        while (d.state.phase !== 'over' && d.state.tick < 60 * 600) log.push(JSON.stringify([stepDuel(d, [refPlayerAct(bot, d, 0), aiAct(ai, d)]), d.state]));
        return log.join('\n');
      });
      assert.ok(logs[0] === logs[1], `seed ${seed}, master ${m}: empty mods changed a reference duel tick by tick`);
    }
    assert.equal(simulateModDuel(seed, 2, REF_PLAYER, undefined), simulateModDuel(seed, 2, REF_PLAYER, [null, null]));
  }
});
