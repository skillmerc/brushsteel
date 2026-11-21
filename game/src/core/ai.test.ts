// Opponent AI v1: telegraphs, reaction windows, three styles,
// tuned by simulated duels against the scripted reference player.
//
// Win-rate bands (reference player REF_PLAYER, skill 0.7, wins this share of
// 500 duels at seeds 1..500). From the spec:
//   patient (master 1):   60 to 85 percent  (spec: "against master 1 between 60 and 85")
//   feinter:              30 to 55 percent  (spec: "against the feinter between 30 and 55")
//   aggressive:           45 to 75 percent  (chosen here: between the two, since the design
//                         needs bands that get harder from the first master to the last;
//                         slots it between master 1 and the feinter)
// and the order patient > aggressive > feinter must hold.
// Duration (a duel should take 30 seconds to 3 minutes): every simulated
// duel ends with a winner before the 10-minute safety cap; each style's median is
// inside 30 s to 3 min, no duel is over 3 min, and at least 85 percent of
// master 1 duels (75 percent for the other two) last 30 s or more. The bot
// never hesitates, so a human duel runs longer than these figures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDuel, stepDuel, reachOf, DUEL_RULES, type DuelAction } from './duel.js';
import { REAL_LINE_FLOOR_MS, STYLES, REF_PLAYER, createAi, aiAct, createRefPlayer, refPlayerAct, simulateDuel, telegraphSegment, parryCutAcross, atWall, STAGE_HALF_H, STAGE_FRAME_HALF_W, type AiStyle, type SimResult } from './ai.js';
import { segmentsCross } from './duel.js';

const SEEDS = Array.from({ length: 500 }, (_, i) => i + 1);
const TICKS_PER_S = DUEL_RULES.TICK_HZ;

const cache = new Map<string, SimResult[]>();
function results(name: keyof typeof STYLES): SimResult[] {
  let r = cache.get(name);
  if (!r) {
    r = SEEDS.map((s) => simulateDuel(s, STYLES[name]));
    cache.set(name, r);
  }
  return r;
}
function botWinRate(name: keyof typeof STYLES): number {
  const r = results(name);
  return r.filter((x) => x.winner === 0).length / r.length;
}
function quantile(sorted: number[], q: number): number {
  return sorted[Math.floor(q * (sorted.length - 1))];
}

const BANDS: Record<keyof typeof STYLES, [number, number]> = {
  patient: [0.6, 0.85],
  aggressive: [0.45, 0.75],
  feinter: [0.3, 0.55],
};

for (const name of Object.keys(BANDS) as (keyof typeof STYLES)[]) {
  test(`win-rate band: reference player (skill 0.7) vs ${name}`, () => {
    const rate = botWinRate(name);
    const [lo, hi] = BANDS[name];
    const r = results(name);
    const parries = r.reduce((t, x) => t + x.parries[0], 0) / r.length;
    const aiParries = r.reduce((t, x) => t + x.parries[1], 0) / r.length;
    const feints = r.reduce((t, x) => t + x.feints, 0) / r.length;
    console.log(
      `WIN RATE ${name}: reference player won ${(rate * 100).toFixed(1)}% of ${r.length} duels (band ${Math.round(lo * 100)}-${Math.round(hi * 100)}%); per duel: player parries ${parries.toFixed(2)}, AI parries ${aiParries.toFixed(2)}, AI feints ${feints.toFixed(2)}`,
    );
    assert.ok(rate >= lo && rate <= hi, `${name}: ${rate} outside ${lo}..${hi}`);
  });
}

test('bands get harder from master 1 to the feinter', () => {
  assert.ok(botWinRate('patient') > botWinRate('aggressive'));
  assert.ok(botWinRate('aggressive') > botWinRate('feinter'));
});

test('duration: every duel ends, inside 30 s to 3 min', () => {
  for (const name of Object.keys(BANDS) as (keyof typeof STYLES)[]) {
    const r = results(name);
    assert.ok(r.every((x) => x.winner !== null), `${name}: a duel hit the 10-minute cap`);
    const secs = r.map((x) => x.ticks / TICKS_PER_S).sort((a, b) => a - b);
    const inBand = secs.filter((s) => s >= 30 && s <= 180).length / secs.length;
    console.log(
      `DURATION ${name}: min ${secs[0].toFixed(1)} s, p5 ${quantile(secs, 0.05).toFixed(1)}, median ${quantile(secs, 0.5).toFixed(1)}, p95 ${quantile(secs, 0.95).toFixed(1)}, max ${secs[secs.length - 1].toFixed(1)} s; ${(inBand * 100).toFixed(1)}% within 30-180 s`,
    );
    const median = quantile(secs, 0.5);
    assert.ok(median >= 30 && median <= 180, `${name} median ${median}`);
    assert.ok(secs[secs.length - 1] <= 180, `${name} longest ${secs[secs.length - 1]}`);
    assert.ok(inBand >= (name === 'patient' ? 0.85 : 0.75), `${name}: ${inBand} within 30-180 s`);
  }
});

test('deterministic: same seed, same duel; no Math.random', () => {
  const real = Math.random;
  Math.random = () => {
    throw new Error('Math.random used');
  };
  try {
    for (const name of Object.keys(STYLES) as (keyof typeof STYLES)[]) {
      for (const seed of [1, 99, 4242]) assert.deepEqual(simulateDuel(seed, STYLES[name]), simulateDuel(seed, STYLES[name]));
    }
  } finally {
    Math.random = real;
  }
  assert.notDeepEqual(simulateDuel(1, STYLES.feinter), simulateDuel(2, STYLES.feinter));
});

test('every AI strike: telegraph at least MIN_TELEGRAPH_MS, line within reach of the striker, toward the foe, in the stage frame', () => {
  let strikes = 0;
  for (const name of Object.keys(STYLES) as (keyof typeof STYLES)[]) {
    for (const seed of SEEDS.slice(0, 60)) {
      const duel = createDuel(seed);
      const ai = createAi(STYLES[name], 1, seed);
      const bot = createRefPlayer(REF_PLAYER, seed);
      while (duel.state.phase !== 'over' && duel.state.tick < 60 * 600) {
        const ev = stepDuel(duel, [refPlayerAct(bot, duel, 0), aiAct(ai, duel)]);
        for (const e of ev) {
          if (e.type !== 'strike' || e.who !== 1) continue;
          strikes++;
          const me = duel.state.fighters[1];
          const s = me.strike!;
          assert.ok(s.windupMs >= DUEL_RULES.MIN_TELEGRAPH_MS, `windup ${s.windupMs}`);
          const reach = reachOf(s.kind);
          for (const p of [s.segment.a, s.segment.b]) {
            const ahead = (p.x - me.x) * me.facing;
            assert.ok(ahead >= 0 && ahead <= reach + 1e-9, `${name} ${seed}: ${s.kind} point ${ahead} ahead, reach ${reach}`);
            assert.ok(Math.abs(p.x) <= STAGE_FRAME_HALF_W && Math.abs(p.y) <= STAGE_HALF_H);
            assert.ok(p.y >= 0 && p.y <= 3.5, 'at sword height');
          }
        }
      }
    }
  }
  assert.ok(strikes > 500, `only ${strikes} strikes checked`);
});

test('telegraphSegment: each kind, both facings, at the walls', () => {
  for (const kind of ['cut', 'overhead', 'rising', 'thrust'] as const) {
    for (const f of [
      { x: 0, facing: 1 as const },
      { x: 0, facing: -1 as const },
      { x: -7.5, facing: 1 as const },
      { x: 7.5, facing: -1 as const },
    ]) {
      for (const w of [0, 0.5, 0.999]) {
        const s = telegraphSegment(kind, f, w);
        for (const p of [s.a, s.b]) {
          const ahead = (p.x - f.x) * f.facing;
          assert.ok(ahead > 0 && ahead <= reachOf(kind));
          assert.ok(Math.abs(p.x) <= STAGE_FRAME_HALF_W && Math.abs(p.y) <= STAGE_HALF_H);
        }
        assert.ok(segmentsCross(parryCutAcross(s), s), 'the parry cut crosses the line');
      }
    }
  }
});

test('the feinter feints, the others never do; the feint is a dropped line', () => {
  assert.ok(results('feinter').reduce((t, x) => t + x.feints, 0) > SEEDS.length);
  assert.equal(results('patient').reduce((t, x) => t + x.feints, 0), 0);
  assert.equal(results('aggressive').reduce((t, x) => t + x.feints, 0), 0);
  // Watch one feint: a line, then the feint event, then a different line within a second.
  let seen = false;
  for (const seed of SEEDS) {
    const duel = createDuel(seed);
    const ai = createAi(STYLES.feinter, 1, seed);
    let feintAt = -1;
    while (duel.state.phase !== 'over' && duel.state.tick < 60 * 600 && !seen) {
      const ev = stepDuel(duel, [null, aiAct(ai, duel)]);
      for (const e of ev) {
        if (e.type === 'feint' && e.who === 1) feintAt = duel.state.tick;
        if (e.type === 'strike' && e.who === 1 && feintAt >= 0) {
          assert.ok(duel.state.tick - feintAt <= 60, 'real strike follows the feint');
          assert.ok(duel.state.fighters[1].strike!.windupMs <= STYLES.feinter.windupMs);
          seen = true;
        }
      }
    }
    if (seen) break;
  }
  assert.ok(seen);
});

test('the AI answers a player line inside its reaction window and parries it', () => {
  const style: AiStyle = { ...STYLES.patient, parryChance: 1, reactionMs: 50 };
  const duel = createDuel(11);
  duel.state.fighters[0].x = -1;
  duel.state.fighters[1].x = 1;
  const ai = createAi(style, 1, 11);
  const cut: DuelAction = { type: 'stroke', kind: 'cut', speed: 20, segment: telegraphSegment('cut', duel.state.fighters[0]), length: 2 };
  let parried = false;
  for (let i = 0; i < 10 && !parried; i++) {
    const ev = stepDuel(duel, [i === 0 ? cut : null, aiAct(ai, duel)]);
    parried = ev.some((e) => e.type === 'parry' && e.who === 1);
  }
  assert.ok(parried);
  // Too slow a reaction never parries a 100 ms player stroke.
  const slow = createAi({ ...style, reactionMs: 150 }, 1, 11);
  const d2 = createDuel(11);
  d2.state.fighters[0].x = -1;
  d2.state.fighters[1].x = 1;
  const ev2 = [];
  for (let i = 0; i < 12; i++) ev2.push(...stepDuel(d2, [i === 0 ? cut : null, aiAct(slow, d2)]));
  assert.ok(!ev2.some((e) => e.type === 'parry'));
  assert.ok(ev2.some((e) => e.type === 'hit' && e.who === 0));
});

test('a cornered AI with low ink dips instead of stepping into the wall forever', () => {
  const duel = createDuel(12);
  duel.state.fighters[1].x = 7.5;
  duel.state.fighters[0].x = 5;
  duel.state.fighters[1].ink = 5;
  const ai = createAi(STYLES.patient, 1, 12);
  stepDuel(duel, [null, null]);
  assert.ok(atWall(duel.state.fighters[1], duel.rules));
  assert.deepEqual(aiAct(ai, duel), { type: 'dip' });
});

test('styles are data with every tuning number', () => {
  for (const s of Object.values(STYLES)) {
    for (const k of ['windupMs', 'reactionMs', 'parryChance', 'holdGap', 'pressMinMs', 'pressMaxMs', 'feintChance', 'dipBelow'] as const) {
      assert.equal(typeof s[k], 'number', `${s.name}.${k}`);
    }
    assert.ok(s.windupMs >= DUEL_RULES.MIN_TELEGRAPH_MS);
  }
  assert.equal(STYLES.patient.windupMs, 900);
});

test('every real AI line (not a dropped feint) shows at least REAL_LINE_FLOOR_MS before it lands, all styles', () => {
  assert.ok(REAL_LINE_FLOOR_MS >= 350, 'floor is 350 ms');
  const tickMs = 1000 / DUEL_RULES.TICK_HZ;
  const shortest: Record<string, number> = {};
  let real = 0;
  let follow = 0;
  for (const name of Object.keys(STYLES) as (keyof typeof STYLES)[]) {
    shortest[name] = Infinity;
    for (const seed of SEEDS.slice(0, 100)) {
      const duel = createDuel(seed);
      const ai = createAi(STYLES[name], 1, seed);
      const bot = createRefPlayer(REF_PLAYER, seed);
      // Lines shown this duel, as ms from appearing to landing; a feint event marks the pending one as dropped.
      const lines: { ms: number; feint: boolean; afterFeint: boolean }[] = [];
      let lastFeint = false;
      while (duel.state.phase !== 'over' && duel.state.tick < 60 * 600) {
        const ev = stepDuel(duel, [refPlayerAct(bot, duel, 0), aiAct(ai, duel)]);
        for (const e of ev) {
          if (e.type === 'feint' && e.who === 1) {
            lines[lines.length - 1].feint = true;
            lastFeint = true;
          }
          if (e.type === 'strike' && e.who === 1) {
            const s = duel.state.fighters[1].strike!;
            lines.push({ ms: (s.landsAtTick - s.startTick) * tickMs, feint: false, afterFeint: lastFeint });
            lastFeint = false;
          }
        }
      }
      for (const l of lines) {
        if (l.feint) continue;
        real++;
        if (l.afterFeint) follow++;
        shortest[name] = Math.min(shortest[name], l.ms);
        assert.ok(l.ms >= REAL_LINE_FLOOR_MS - 1e-9, `${name} seed ${seed}: real line shows ${l.ms} ms, floor ${REAL_LINE_FLOOR_MS}`);
      }
    }
  }
  console.log(`REAL LINE floor ${REAL_LINE_FLOOR_MS} ms: shortest patient ${shortest.patient.toFixed(0)}, aggressive ${shortest.aggressive.toFixed(0)}, feinter ${shortest.feinter.toFixed(0)} ms; ${real} real lines checked, ${follow} of them feint follow-ups`);
  assert.ok(real > 1000, `only ${real} real lines checked`);
  assert.ok(follow > 100, `only ${follow} feint follow-ups checked`);
});
