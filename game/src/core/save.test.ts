import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choices, generatePath, runReducer, type RunState } from './path.js';
import { SAVE_KEY, clearRun, deserializeRun, loadRun, saveRun, serializeRun, type KeyValueStore } from './save.js';

function memStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

function midRun(): RunState {
  const map = generatePath(99);
  let run = runReducer(null, { type: 'start', seed: 99, brush: 'wide' });
  run = runReducer(run, { type: 'move', to: map.start[0] }, map);
  run = runReducer(run, { type: 'duel-lost' }, map);
  run = runReducer(run, { type: 'duel-won' }, map);
  run = runReducer(run, { type: 'move', to: choices(run, map)[1] }, map);
  return run;
}

test('save: round trip through an injected store', () => {
  const store = memStore();
  const run = midRun();
  assert.equal(loadRun(store), null);
  saveRun(store, run);
  assert.ok(store.data.has(SAVE_KEY));
  const back = loadRun(store);
  assert.ok(back && serializeRun(back) === serializeRun(run), 'same run after load');
  assert.ok(JSON.parse(store.data.get(SAVE_KEY) as string).v === 3, 'version field');
  clearRun(store);
  assert.equal(loadRun(store), null);
});

test('save: corrupt, old and tampered saves are rejected and removed', () => {
  const good = JSON.parse(serializeRun(midRun()));
  const bad: string[] = [
    'not json{',
    '',
    'null',
    '[]',
    JSON.stringify({ v: 1, run: { ...good.run, version: 1 } }),
    JSON.stringify({ v: 2, run: { ...good.run, version: 2 } }),
    JSON.stringify({ v: 4, run: good.run }),
    JSON.stringify({ ...good, run: { ...good.run, fighting: 'yes' } }),
    JSON.stringify({ ...good, run: { ...good.run, fighting: true, status: 'map' } }),
    JSON.stringify({ v: 1 }),
    JSON.stringify({ ...good, run: { ...good.run, brush: 'gold' } }),
    JSON.stringify({ ...good, run: { ...good.run, lives: -1 } }),
    JSON.stringify({ ...good, run: { ...good.run, lives: 2.5 } }),
    JSON.stringify({ ...good, run: { ...good.run, seals: ['no-such-seal'] } }),
    JSON.stringify({ ...good, run: { ...good.run, seals: ['slow-ink', 'slow-ink'] } }),
    JSON.stringify({ ...good, run: { ...good.run, visited: ['a9r9c9'], at: 'a9r9c9' } }),
    JSON.stringify({ ...good, run: { ...good.run, at: 'a0r0c0', visited: good.run.visited } }),
    JSON.stringify({ ...good, run: { ...good.run, visited: [...good.run.visited, 'a2r0c0'], at: 'a2r0c0' } }),
    JSON.stringify({ ...good, run: { ...good.run, status: 'over' } }),
    JSON.stringify({ ...good, run: { ...good.run, status: 'shrine', offer: [] } }),
    JSON.stringify({ ...good, run: { ...good.run, seed: 'x' } }),
  ];
  // The tampered `at` case must really differ from the good one.
  assert.notEqual(good.run.at, 'a0r0c0');
  for (const [i, text] of bad.entries()) {
    assert.equal(deserializeRun(text), null, `bad save ${i} accepted`);
    const store = memStore();
    store.setItem(SAVE_KEY, text);
    assert.equal(loadRun(store), null);
    assert.equal(store.data.has(SAVE_KEY), false, `bad save ${i} left in the store`);
  }
  assert.ok(deserializeRun(JSON.stringify(good)), 'the untouched save still loads');
  const throwing: KeyValueStore = { getItem: () => { throw new Error('denied'); }, setItem: () => {}, removeItem: () => {} };
  assert.equal(loadRun(throwing), null, 'storage that throws (private mode) gives no run');
});

test('save: lives in a duel are 0 to 2 (one is at stake), never 3', () => {
  const map = generatePath(99);
  let run = runReducer(null, { type: 'start', seed: 99, brush: 'wide' });
  const duelId = map.start.find((id) => map.nodes[id].kind === 'duel' || map.nodes[id].kind === 'master') as string;
  run = runReducer(run, { type: 'move', to: duelId }, map);
  assert.equal(run.status, 'duel');
  const good = JSON.parse(serializeRun(run));
  assert.equal(good.run.lives, 2);
  assert.ok(deserializeRun(JSON.stringify(good)), 'a duel with 2 lives in hand loads');
  assert.ok(deserializeRun(JSON.stringify({ ...good, run: { ...good.run, lives: 0 } })), 'a duel on the last life loads');
  assert.equal(deserializeRun(JSON.stringify({ ...good, run: { ...good.run, lives: 3 } })), null, '3 lives in hand in a duel is a tampered save');
});
