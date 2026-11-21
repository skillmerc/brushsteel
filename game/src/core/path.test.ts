import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BRUSHES,
  PATH_RULES,
  SEALS,
  choices,
  combineMods,
  dailySeed,
  dateKey,
  duelSetup,
  generatePath,
  reachableFromStart,
  runReducer,
  shrineOffer,
  type PathMap,
  type RunState,
} from './path.js';
import { MASTERS } from './masters.js';

const SEEDS = Array.from({ length: 400 }, (_, i) => i * 7919 + 3);

/** Nodes from which the final master can be reached. */
function reachesFinal(map: PathMap): Set<string> {
  const ok = new Set<string>([map.finalId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of Object.values(map.nodes)) if (!ok.has(n.id) && n.next.some((x) => ok.has(x))) (ok.add(n.id), (grew = true));
  }
  return ok;
}

test('path map: every node is reachable from the start and leads to the final master, over 400 seeds', () => {
  for (const seed of SEEDS) {
    const map = generatePath(seed);
    const all = Object.keys(map.nodes);
    const fromStart = reachableFromStart(map);
    const toFinal = reachesFinal(map);
    const lost = all.filter((id) => !fromStart.has(id) || !toFinal.has(id));
    assert.equal(lost.length, 0, `seed ${seed}: cut-off nodes ${lost.join(',')}`);
    assert.equal(map.nodes[map.finalId].next.length, 0);
    assert.equal(map.nodes[map.finalId].master, 8, 'the run ends at master 8');
  }
});

test('path map: 3 acts of 4 to 5 steps; node kinds and masters as specified; 2 branches per step', () => {
  const lengths = new Set<number>();
  for (const seed of SEEDS) {
    const map = generatePath(seed);
    assert.equal(map.acts.length, 3);
    for (const act of map.acts) {
      const n = act.rows.length;
      lengths.add(n);
      assert.ok(n >= 4 && n <= 5, `seed ${seed} act ${act.index} has ${n} steps`);
      const kinds = (r: number) => act.rows[r].map((id) => map.nodes[id].kind);
      assert.ok(kinds(0).every((k) => k === 'duel'), 'first row: duels');
      assert.deepEqual(kinds(n - 1), ['master']);
      assert.deepEqual(kinds(n - 2).slice().sort(), ['shrine', 'well'], 'row before the master: one shrine, one well');
      for (let r = 1; r < n - 2; r++) assert.ok(kinds(r).includes('duel'), 'every middle row has a duel');
      assert.equal(map.nodes[act.rows[n - 1][0]].master, PATH_RULES.ACT_MASTERS[act.index]);
      for (let r = 0; r < n - 1; r++) {
        for (const id of act.rows[r]) {
          const node = map.nodes[id];
          const want = act.rows[r + 1].length >= 2 ? 2 : 1;
          assert.ok(node.next.length >= want, `${id} has ${node.next.length} branches`);
          assert.ok(node.next.every((x) => act.rows[r + 1].includes(x)), `${id} links only to the next row`);
          if (node.kind === 'duel') assert.ok(PATH_RULES.DUEL_POOLS[act.index].includes(node.master), `${id} master ${node.master}`);
          else assert.equal(node.master, 0);
        }
      }
    }
    for (const n of Object.values(map.nodes)) assert.ok(n.master === 0 || MASTERS.some((m) => m.index === n.master));
  }
  assert.deepEqual([...lengths].sort(), [4, 5], 'both act lengths occur');
});

test('path map: same seed gives the same map; seeds differ', () => {
  const a = JSON.stringify(generatePath(42));
  assert.ok(a === JSON.stringify(generatePath(42)), 'deterministic');
  const shapes = new Set(SEEDS.slice(0, 50).map((s) => JSON.stringify(Object.values(generatePath(s).nodes).map((n) => [n.kind, n.master, n.next]))));
  assert.ok(shapes.size >= 40, `only ${shapes.size} different maps in 50 seeds`);
});

test('daily scroll seed from the date', () => {
  assert.equal(dailySeed('2026-11-19'), dailySeed('2026-11-19'));
  assert.notEqual(dailySeed('2026-11-19'), dailySeed('2026-11-20'));
  for (const bad of ['2026-02-30', '19-11-2026', '2026-1-1', '', '2026-11-19T00:00']) assert.throws(() => dailySeed(bad), RangeError, bad);
  assert.equal(dateKey(new Date(Date.UTC(2026, 10, 19, 23, 59))), '2026-11-19');
  assert.ok(generatePath(dailySeed('2026-11-19')).acts.length === 3);
});

function walkTo(run: RunState, map: PathMap, kind: string): RunState {
  // Step forward, always taking the first choice of the wanted kind, else the first choice; fight wins.
  for (let i = 0; i < 40 && run.status !== 'over'; i++) {
    if (run.status === 'shrine') run = runReducer(run, { type: 'pick', seal: null }, map);
    else if (run.status === 'duel') run = runReducer(run, { type: 'duel-won' }, map);
    else {
      const opts = choices(run, map);
      const pick = opts.find((id) => map.nodes[id].kind === kind) ?? opts[0];
      run = runReducer(run, { type: 'move', to: pick }, map);
      if (map.nodes[pick].kind === kind) return run;
    }
  }
  return run;
}

test('run reducer: start, move, duel lost and retried, won, shrine pick, well refill, final win', () => {
  const map = generatePath(7);
  const r0 = runReducer(null, { type: 'start', seed: 7, brush: 'fine' });
  assert.equal(r0.status, 'map');
  assert.equal(r0.lives, PATH_RULES.LIVES);
  assert.ok(runReducer(r0, { type: 'move', to: 'nowhere' }, map) === r0, 'illegal move: same state');
  assert.ok(runReducer(r0, { type: 'duel-won' }, map) === r0, 'no duel to win');
  assert.throws(() => runReducer(r0, { type: 'move', to: map.start[0] }, generatePath(8)));
  const r1 = runReducer(r0, { type: 'move', to: map.start[0] }, map);
  assert.equal(r0.at, null, 'reducer does not mutate');
  assert.equal(r1.status, 'duel');
  assert.ok(duelSetup(r1, map).master >= 1);
  assert.equal(r1.lives, 2, 'the life at stake is taken when the duel starts');
  const r2 = runReducer(r1, { type: 'duel-lost' }, map);
  assert.equal(r2.lives, 1, 'the lost life is gone and the retry stakes the next');
  assert.equal(r2.status, 'duel', 'a lost duel is fought again');
  assert.equal(r2.at, r1.at);
  const r3 = runReducer(r2, { type: 'duel-won' }, map);
  assert.equal(r3.status, 'map');
  assert.equal(r3.lives, 2, 'a lost then won duel costs one life in total');
  // Well refills lives.
  const atWell = walkTo(r3, map, 'well');
  assert.equal(map.nodes[atWell.at as string].kind, 'well');
  assert.equal(atWell.lives, PATH_RULES.LIVES);
  // Shrine offers 3 seals; picking one adds it to the duel mods.
  const atShrine = walkTo(r3, map, 'shrine');
  assert.equal(atShrine.status, 'shrine');
  assert.equal(atShrine.offer.length, 3);
  assert.deepEqual(atShrine.offer, shrineOffer(7, atShrine.at as string, []));
  assert.ok(runReducer(atShrine, { type: 'pick', seal: SEALS.find((s) => !atShrine.offer.includes(s.id))!.id }, map) === atShrine, 'only offered seals');
  const picked = runReducer(atShrine, { type: 'pick', seal: atShrine.offer[0] }, map);
  assert.deepEqual(picked.seals, [atShrine.offer[0]]);
  assert.equal(picked.status, 'map');
  // Walk to the end winning every duel.
  let end = picked;
  for (let i = 0; i < 60 && end.status !== 'over'; i++) end = walkTo(end, map, 'master');
  assert.equal(end.status, 'over');
  assert.equal(end.result, 'won');
  assert.equal(end.at, map.finalId);
});

test('run reducer: out of lives ends the run; end abandons it; over is final', () => {
  const map = generatePath(11);
  let run = runReducer(runReducer(null, { type: 'start', seed: 11, brush: 'standard' }), { type: 'move', to: map.start[1] }, map);
  for (let i = 0; i < PATH_RULES.LIVES; i++) run = runReducer(run, { type: 'duel-lost' }, map);
  assert.equal(run.status, 'over');
  assert.equal(run.result, 'lost');
  assert.ok(runReducer(run, { type: 'duel-won' }, map) === run);
  const quit = runReducer(runReducer(null, { type: 'start', seed: 11, brush: 'wide' }), { type: 'end' });
  assert.equal(quit.result, 'abandoned');
  assert.throws(() => runReducer(null, { type: 'start', seed: 1, brush: 'nope' as never }));
});

test('seals and brushes as data: 12 seals with text, 3 brushes, combined mods', () => {
  assert.equal(SEALS.length, 12);
  assert.equal(new Set(SEALS.map((s) => s.id)).size, 12);
  for (const s of SEALS) assert.ok(s.text.length > 10 && Object.keys(s.mods).length > 0, s.id);
  assert.deepEqual(BRUSHES.map((b) => b.id), ['wide', 'standard', 'fine']);
  const m = combineMods([{ knockMul: 1.4, inkCostMul: { cut: 1.2 } }, { knockMul: 1.5, hitValue: 2, parryWindowMs: 100 }, { parryWindowMs: -100, inkCostMul: { cut: 0.5 } }]);
  assert.ok(Math.abs((m.knockMul as number) - 2.1) < 1e-9);
  assert.equal(m.hitValue, 2);
  assert.equal(m.parryWindowMs, 0);
  assert.ok(Math.abs((m.inkCostMul?.cut as number) - 0.6) < 1e-9);
});
