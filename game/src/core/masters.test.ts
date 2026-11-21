// The eight masters: data, win-rate bands for two reference
// players, the 350 ms real-line floor for every master, feint rules, the
// mirror and the fading ink.
//
// Bands (share of 500 duels at seeds 1..500 the reference player wins).
// Both must fall strictly from master 1 to master 8. REF_PLAYER is the skill-0.7 reference player (reactions 180
// to 450 ms); REF_PLAYER_SLOW is the same player with reactions of 250 to 550
// ms, nearer a typical human. Masters 1 to 3 must
// stay winnable for the slow player: at least 45 percent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDuel, stepDuel, segmentsCross, msToTicks, DUEL_RULES, type AttackKind, type DuelAction, type Segment } from './duel.js';
import {
  REAL_LINE_FLOOR_MS,
  REF_PLAYER,
  REF_PLAYER_SLOW,
  STYLES,
  aiAct,
  createAi,
  createRefPlayer,
  fakeWindup,
  parryCutAcross,
  refPlayerAct,
  simulateDuel,
  telegraphSegment,
  type RefPlayerOptions,
  type SimResult,
} from './ai.js';
import { MASTERS, masterByIndex, masterLabel, strokeSet, telegraphInk, type Master } from './masters.js';

const SEEDS = Array.from({ length: 500 }, (_, i) => i + 1);
const TICK_MS = 1000 / DUEL_RULES.TICK_HZ;

const FAST_BANDS: [number, number][] = [
  [0.7, 0.88],
  [0.68, 0.85],
  [0.58, 0.74],
  [0.52, 0.68],
  [0.38, 0.55],
  [0.33, 0.5],
  [0.28, 0.45],
  [0.18, 0.35],
];
const SLOW_BANDS: [number, number][] = [
  [0.65, 0.95],
  [0.6, 0.9],
  [0.45, 0.75],
  [0.25, 0.55],
  [0.15, 0.4],
  [0.05, 0.3],
  [0.02, 0.25],
  [0, 0.2],
];

const cache = new Map<string, SimResult[]>();
function results(m: Master, player: RefPlayerOptions): SimResult[] {
  const key = `${m.index}/${player === REF_PLAYER ? 'fast' : 'slow'}`;
  let r = cache.get(key);
  if (!r) {
    r = SEEDS.map((s) => simulateDuel(s, m.style, player));
    cache.set(key, r);
  }
  return r;
}
const winRate = (m: Master, p: RefPlayerOptions) => {
  const r = results(m, p);
  return r.filter((x) => x.winner === 0).length / r.length;
};
const pct = (x: number) => `${(x * 100).toFixed(1)}%`.padStart(6);

test('eight masters as data; master 1 is the patient, unchanged', () => {
  assert.equal(MASTERS.length, 8);
  MASTERS.forEach((m, i) => assert.equal(m.index, i + 1));
  assert.ok(MASTERS[0].style === STYLES.patient, 'master 1 plays STYLES.patient itself');
  assert.equal(masterLabel(MASTERS[0]), 'Master 1, the patient');
  assert.ok(masterByIndex(1) === MASTERS[0]);
  assert.ok(masterByIndex(99) === MASTERS[0]);
  assert.ok(masterByIndex(8) === MASTERS[7]);
  for (const key of ['name', 'title', 'school', 'tell', 'stageId'] as const) {
    assert.equal(new Set(MASTERS.map((m) => m[key])).size, 8, `${key} differs per master`);
  }
  for (const m of MASTERS) {
    for (const k of ['windupMs', 'windupJitterMs', 'reactionMs', 'parryChance', 'holdGap', 'pressMinMs', 'pressMaxMs', 'feintChance', 'feintDropMs', 'feintStrikeMs', 'dipBelow'] as const) {
      assert.equal(typeof m.style[k], 'number', `${m.title}.${k}`);
    }
    assert.ok(strokeSet(m).length >= 2, `${m.title} stroke set`);
    assert.ok(m.footwork.length > 0 && m.inkHabit.length > 0);
    // A parry cut needs a reaction under the player's 100 ms landing; every master can parry.
    assert.ok(m.style.reactionMs < 100, `${m.title} reaction ${m.style.reactionMs}`);
  }
  assert.deepEqual(
    MASTERS.filter((m) => m.fadingInk).map((m) => m.index),
    [8],
    'only the last master draws in fading ink',
  );
});

test('win-rate bands: both reference players, every master, falling from master 1 to master 8', () => {
  const rows: string[] = ['MASTERS win rate of the reference player, 500 duels each', ' #  master            skill 0.7 (180-450 ms)  slow (250-550 ms)'];
  const fast: number[] = [];
  const slow: number[] = [];
  for (const m of MASTERS) {
    const f = winRate(m, REF_PLAYER);
    const s = winRate(m, REF_PLAYER_SLOW);
    fast.push(f);
    slow.push(s);
    const fb = FAST_BANDS[m.index - 1];
    const sb = SLOW_BANDS[m.index - 1];
    rows.push(` ${m.index}  ${m.title.padEnd(16)}  ${pct(f)} (band ${Math.round(fb[0] * 100)}-${Math.round(fb[1] * 100)})    ${pct(s)} (band ${Math.round(sb[0] * 100)}-${Math.round(sb[1] * 100)})`);
  }
  console.log(rows.join('\n'));
  MASTERS.forEach((m, i) => {
    const [flo, fhi] = FAST_BANDS[i];
    const [slo, shi] = SLOW_BANDS[i];
    assert.ok(fast[i] >= flo && fast[i] <= fhi, `master ${m.index} fast ${fast[i]} outside ${flo}..${fhi}`);
    assert.ok(slow[i] >= slo && slow[i] <= shi, `master ${m.index} slow ${slow[i]} outside ${slo}..${shi}`);
  });
  for (let i = 1; i < 8; i++) {
    assert.ok(fast[i] < fast[i - 1], `fast: master ${i + 1} (${fast[i]}) not below master ${i} (${fast[i - 1]})`);
    assert.ok(slow[i] < slow[i - 1], `slow: master ${i + 1} (${slow[i]}) not below master ${i} (${slow[i - 1]})`);
  }
  assert.ok(fast[0] >= 0.8 && fast[7] <= 0.3, 'about 85 down to about 25');
  for (let i = 0; i < 3; i++) assert.ok(slow[i] >= 0.45, `master ${i + 1} must stay winnable for the slow player`);
});

test('duration: every master duel ends inside 30 s to 3 min, both players', () => {
  for (const p of [REF_PLAYER, REF_PLAYER_SLOW]) {
    for (const m of MASTERS) {
      const r = results(m, p);
      assert.ok(r.every((x) => x.winner !== null), `master ${m.index}: a duel hit the 10-minute cap`);
      const secs = r.map((x) => x.ticks / DUEL_RULES.TICK_HZ).sort((a, b) => a - b);
      const median = secs[Math.floor(secs.length / 2)];
      assert.ok(median >= 30 && median <= 180, `master ${m.index} median ${median}`);
      assert.ok(secs[secs.length - 1] <= 180, `master ${m.index} longest ${secs[secs.length - 1]}`);
    }
  }
});

interface Line {
  ms: number;
  feint: boolean;
  afterFeint: boolean;
  kind: AttackKind;
  gap: number;
  startTick: number;
  landsAtTick: number;
  dropTick: number;
  segment: Segment;
}

/** Every AI line of `duels` duels against the reference player, with feints marked. */
function linesOf(m: Master, duels: number): Line[] {
  const out: Line[] = [];
  for (const seed of SEEDS.slice(0, duels)) {
    const duel = createDuel(seed);
    const ai = createAi(m.style, 1, seed);
    const bot = createRefPlayer(REF_PLAYER, seed);
    let lastFeint = false;
    let open: Line | null = null;
    while (duel.state.phase !== 'over' && duel.state.tick < 60 * 600) {
      // A feint follow-up is the strike that clears the AI's pending follow-up.
      const hadFollow = ai.mem.feintFollow !== null;
      const act = aiAct(ai, duel);
      lastFeint = hadFollow && ai.mem.feintFollow === null && act?.type === 'stroke';
      const ev = stepDuel(duel, [refPlayerAct(bot, duel, 0), act]);
      for (const e of ev) {
        if (e.type === 'feint' && e.who === 1 && open) {
          open.feint = true;
          open.dropTick = duel.state.tick;
        }
        if (e.type === 'strike' && e.who === 1) {
          const f = duel.state.fighters;
          const s = f[1].strike!;
          open = {
            ms: (s.landsAtTick - s.startTick) * TICK_MS,
            feint: false,
            afterFeint: lastFeint,
            kind: s.kind,
            gap: Math.abs(f[0].x - f[1].x),
            startTick: s.startTick,
            landsAtTick: s.landsAtTick,
            dropTick: -1,
            segment: s.segment,
          };
          out.push(open);
        }
      }
    }
  }
  return out;
}
const lineCache = new Map<number, Line[]>();
const lines = (m: Master) => {
  let l = lineCache.get(m.index);
  if (!l) lineCache.set(m.index, (l = linesOf(m, 100)));
  return l;
};

test('every real line of every master (not a dropped feint) shows at least REAL_LINE_FLOOR_MS, 100 duels each', () => {
  assert.ok(REAL_LINE_FLOOR_MS >= 350);
  const report: string[] = [];
  for (const m of MASTERS) {
    const all = lines(m);
    const real = all.filter((l) => !l.feint);
    const follow = real.filter((l) => l.afterFeint);
    for (const l of real) assert.ok(l.ms >= REAL_LINE_FLOOR_MS - 1e-9, `master ${m.index}: real line shows ${l.ms} ms, floor ${REAL_LINE_FLOOR_MS}`);
    const shortest = Math.min(...real.map((l) => l.ms));
    report.push(`${m.index} ${m.title}: ${real.length} real, ${follow.length} feint follow-ups, shortest ${shortest.toFixed(0)} ms`);
    assert.ok(real.length >= 300, `master ${m.index}: only ${real.length} real lines checked`);
    if (m.style.feintChance > 0) assert.ok(follow.length >= 100, `master ${m.index}: only ${follow.length} feint follow-ups checked`);
    else assert.equal(follow.length, 0);
  }
  console.log(`REAL LINE floor ${REAL_LINE_FLOOR_MS} ms per master: ${report.join('; ')}`);
});

test('a fake line is never parryable: every feint drops before the parry window opens (ruling for feintDropMs of 400 ms and more)', () => {
  let feints = 0;
  for (const m of MASTERS) {
    if (m.style.feintChance === 0) continue;
    for (const l of lines(m).filter((x) => x.feint)) {
      feints++;
      assert.ok((l.landsAtTick - l.dropTick) * TICK_MS > DUEL_RULES.PARRY_WINDOW_MS, `master ${m.index}: feint dropped ${(l.landsAtTick - l.dropTick) * TICK_MS} ms before landing`);
      assert.ok(l.ms >= m.style.feintDropMs + DUEL_RULES.PARRY_WINDOW_MS);
    }
  }
  assert.ok(feints > 300, `only ${feints} feints checked`);
  assert.ok(MASTERS.some((m) => m.style.feintDropMs >= 400), 'a master with a slow (400 ms or more) feint is covered');
  assert.equal(fakeWindup(300, 450, DUEL_RULES), 450 + DUEL_RULES.PARRY_WINDOW_MS + 50);

  // Direct: the switch (drop 450 ms) shows a fake line; the player cuts across it on the last tick before the drop. Not a parry.
  const sw = MASTERS.find((m) => m.style.feintDropMs >= 400)!;
  let checked = 0;
  for (const seed of SEEDS.slice(0, 40)) {
    const duel = createDuel(seed);
    const ai = createAi({ ...sw.style, feintChance: 1 }, 1, seed);
    ai.mem.pressAt = 0;
    duel.state.fighters[0].x = -1;
    duel.state.fighters[1].x = 1;
    let parried = false;
    while (duel.state.phase === 'fight' && duel.state.tick < 600) {
      const a = aiAct(ai, duel);
      const s = duel.state.fighters[1].strike;
      let mine: DuelAction | null = null;
      if (s && ai.mem.feintDropAt === duel.state.tick + 1) {
        mine = { type: 'stroke', kind: 'cut', speed: 20, segment: parryCutAcross(s.segment), length: 1.6 };
        checked++;
      }
      const ev = stepDuel(duel, [mine, a]);
      if (mine) {
        parried = ev.some((e) => e.type === 'parry');
        break;
      }
    }
    assert.ok(!parried, `seed ${seed}: the fake line was parried`);
  }
  assert.ok(checked >= 20, `only ${checked} fake lines cut`);
});

test('the switch strikes another kind after its feint, often from another gap', () => {
  const sw = MASTERS.find((m) => m.style.feintFollow === 'other' && !m.fadingInk)!;
  const all = lines(sw);
  let follows = 0;
  let otherGap = 0;
  for (let i = 1; i < all.length; i++) {
    const l = all[i];
    const prev = all[i - 1];
    if (!l.afterFeint || !prev.feint) continue;
    follows++;
    assert.notEqual(l.kind, prev.kind, 'follow-up is another kind');
    if (Math.abs(l.gap - prev.gap) >= 0.25) otherGap++;
  }
  console.log(`SWITCH master ${sw.index}: ${follows} feint follow-ups, all another kind, ${otherGap} (${((100 * otherGap) / follows).toFixed(0)}%) from a gap at least 0.25 away`);
  assert.ok(follows >= 100);
  assert.ok(otherGap / follows >= 0.2, 'a fair share come from another gap');
  // The plain feinter keeps the old rule: kinds that reach, often the same.
  assert.equal(MASTERS[5].style.feintFollow, undefined);
});

test("the mirror answers with the kind of the player's last stroke", () => {
  const mirror = MASTERS.find((m) => (m.style.mirror ?? 0) > 0)!;
  for (const kind of ['rising', 'overhead', 'thrust', 'cut'] as AttackKind[]) {
    const duel = createDuel(5);
    duel.state.fighters[0].x = -0.8;
    duel.state.fighters[1].x = 0.8;
    const ai = createAi({ ...mirror.style, mirror: 1 }, 1, 5);
    ai.mem.pressAt = 0;
    ai.mem.foeLastKind = kind;
    const a = aiAct(ai, duel);
    assert.ok(a && a.type === 'stroke', 'attacks');
    assert.equal(a.type === 'stroke' && a.kind, kind);
    assert.ok(a.type === 'stroke' && (a.windupMs ?? 0) >= REAL_LINE_FLOOR_MS);
  }
  // It learns the kind from the player's real stroke.
  const duel = createDuel(6);
  duel.state.fighters[0].x = -0.8;
  duel.state.fighters[1].x = 0.8;
  const ai = createAi({ ...mirror.style, parryChance: 0 }, 1, 6);
  const rising: DuelAction = { type: 'stroke', kind: 'rising', speed: 20, segment: telegraphSegment('rising', duel.state.fighters[0]), length: 2 };
  stepDuel(duel, [rising, aiAct(ai, duel)]);
  aiAct(ai, duel);
  assert.equal(ai.mem.foeLastKind, 'rising');
});

test('fading ink: what shows, and a cut across what shows parries (master 8)', () => {
  const fading = MASTERS[7];
  const f = fading.fadingInk!;
  assert.ok(f.solidTo > 0.5 && f.solidTo < 1, 'solid part holds the middle of the line');
  assert.deepEqual(telegraphInk(MASTERS[0], 0), { solidTo: 1, tipAlpha: 1 });
  assert.deepEqual(telegraphInk(MASTERS[0], 900), { solidTo: 1, tipAlpha: 1 });
  assert.equal(telegraphInk(fading, 0).tipAlpha, 1);
  assert.ok(telegraphInk(fading, f.fadeMs / 2).tipAlpha > 0 && telegraphInk(fading, f.fadeMs / 2).tipAlpha < 1);
  assert.equal(telegraphInk(fading, f.fadeMs).tipAlpha, 0);
  assert.equal(telegraphInk(fading, 5000).tipAlpha, 0);

  // Every real line of master 8 in 100 duels: the solid part stays at full ink
  // for the whole windup (at least the 350 ms floor) and holds the midpoint;
  // a cut across the middle of the solid part crosses the real line.
  let real = 0;
  for (const l of lines(fading).filter((x) => !x.feint)) {
    real++;
    for (let t = l.startTick; t <= l.landsAtTick; t++) {
      const ink = telegraphInk(fading, (t - l.startTick) * TICK_MS);
      assert.ok(ink.solidTo >= 0.5, 'solid part reaches the midpoint');
    }
    assert.ok((l.landsAtTick - l.startTick) * TICK_MS >= REAL_LINE_FLOOR_MS - 1e-9);
    const solid = solidPart(l.segment, f.solidTo);
    assert.ok(segmentsCross(parryCutAcross(solid, 0.6), l.segment), 'a cut across the solid part crosses the line');
  }
  assert.ok(real >= 300, `only ${real} master 8 real lines`);

  // In the duel: the player cuts across the solid part inside the parry window. It parries.
  const duel = createDuel(9);
  duel.state.fighters[0].x = -1;
  duel.state.fighters[1].x = 1;
  const ai = createAi({ ...fading.style, feintChance: 0 }, 1, 9);
  ai.mem.pressAt = 0;
  stepDuel(duel, [null, aiAct(ai, duel)]);
  const s = duel.state.fighters[1].strike!;
  assert.ok(s, 'master 8 strikes');
  while (duel.state.tick < s.landsAtTick - msToTicks(200)) stepDuel(duel, [null, null]);
  const ev = stepDuel(duel, [{ type: 'stroke', kind: 'cut', speed: 20, segment: parryCutAcross(solidPart(s.segment, f.solidTo), 0.6), length: 1.2 }, null]);
  assert.ok(ev.some((e) => e.type === 'parry' && e.who === 0), 'cut across the solid part parries');
});

function solidPart(seg: Segment, to: number): Segment {
  return { a: seg.a, b: { x: seg.a.x + (seg.b.x - seg.a.x) * to, y: seg.a.y + (seg.b.y - seg.a.y) * to } };
}
