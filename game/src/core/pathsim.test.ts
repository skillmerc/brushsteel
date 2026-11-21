// how often a reference player finishes a whole Path run.
// Fixed seeds, deterministic. The target bands are in the tests below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REF_PLAYER, REF_PLAYER_SLOW, type RefPlayerOptions } from './ai.js';
import { simulateModDuel, simulatePathRun, type PathRunResult } from './pathsim.js';
import { SEALS, combineMods, sealById } from './path.js';

const RUN_SEEDS = Array.from({ length: 200 }, (_, i) => 1000 + i);

function summary(player: RefPlayerOptions): { won: number; reachedFinal: number; finalFirstTry: number; acts: number[] } {
  const rs: PathRunResult[] = RUN_SEEDS.map((s) => simulatePathRun(s, player));
  const acts = [0, 0, 0];
  for (const r of rs) acts[r.act]++;
  return {
    won: rs.filter((r) => r.won).length / rs.length,
    reachedFinal: rs.filter((r) => r.finalTries > 0).length / rs.length,
    finalFirstTry: rs.filter((r) => r.won && r.finalTries === 1).length / rs.length,
    acts,
  };
}

test('Path run finish rates of both reference players (200 seeded runs each, standard brush)', () => {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const fast = summary(REF_PLAYER);
  const slow = summary(REF_PLAYER_SLOW);
  console.log(
    [
      'PATH runs, 200 seeded runs each, standard brush, scripted route and seal picks',
      ` normal (180-450 ms): finished ${pct(fast.won)}, reached master 8 ${pct(fast.reachedFinal)}, beat master 8 on the first try ${pct(fast.finalFirstTry)}, ended in act 1/2/3: ${fast.acts.join('/')}`,
      ` slow   (250-550 ms): finished ${pct(slow.won)}, reached master 8 ${pct(slow.reachedFinal)}, beat master 8 on the first try ${pct(slow.finalFirstTry)}, ended in act 1/2/3: ${slow.acts.join('/')}`,
    ].join('\n'),
  );
  assert.ok(fast.won > slow.won, 'the slower player finishes less often');
  // Bands the design is tuned to: most normal players finish, a slow one finishes about 1 run in 4.
  assert.ok(fast.won >= 0.45 && fast.won <= 0.8, `normal finish ${fast.won}`);
  assert.ok(slow.won >= 0.15 && slow.won <= 0.45, `slow finish ${slow.won}`);
  // The ending does not need master 8 in one try: some slow wins came after a lost try.
  assert.ok(slow.won > slow.finalFirstTry, 'retries at master 8 matter');
});

test('a Path run is deterministic per seed', () => {
  const a = simulatePathRun(1234, REF_PLAYER_SLOW, 'fine');
  const b = simulatePathRun(1234, REF_PLAYER_SLOW, 'fine');
  assert.ok(JSON.stringify(a) === JSON.stringify(b));
});

test('master 8 win rate of the slow player with each seal alone, and with a typical 3-seal set (200 duels each)', () => {
  const seeds = Array.from({ length: 200 }, (_, i) => 5000 + i);
  const rate = (mods: Parameters<typeof simulateModDuel>[3]) => seeds.filter((s) => simulateModDuel(s, 8, REF_PLAYER_SLOW, mods)).length / seeds.length;
  const plain = rate(undefined);
  const rows = [`MASTER 8 vs slow player, 200 duels: no seal ${(plain * 100).toFixed(1)}%`];
  for (const seal of SEALS) rows.push(` ${seal.id.padEnd(13)} ${(rate([seal.mods, null]) * 100).toFixed(1)}%`);
  const set3 = rate([combineMods(['slow-ink', 'long-riposte', 'open-window'].map((id) => sealById(id as never).mods)), null]);
  rows.push(` slow-ink + long-riposte + open-window ${(set3 * 100).toFixed(1)}%`);
  console.log(rows.join('\n'));
  assert.ok(plain < 0.2 && set3 > plain);
});
