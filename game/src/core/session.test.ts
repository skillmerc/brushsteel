import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PATH_RULES, dailySeed, generatePath, runReducer, type PathMap, type RunState } from './path.js';
import { SAVE_KEY, deserializeRun, type KeyValueStore } from './save.js';
import { bookLeftFight, endTitle, guardStore, livesShown, memoryStore, nextScrollIn, nodeLabel, openSession, scrollLabel } from './session.js';

/** First duel node among the run's next steps. */
function firstDuel(run: RunState, map: PathMap): string {
  const next = run.at === null ? map.start : map.nodes[run.at].next;
  const id = next.find((n) => map.nodes[n].kind === 'duel' || map.nodes[n].kind === 'master');
  assert.ok(id, 'a duel to step to');
  return id as string;
}

test('session: reload mid-duel keeps the life taken (no free retry by reload)', () => {
  const store = memoryStore();
  const s1 = openSession(store);
  s1.dispatch({ type: 'start', seed: 42, brush: 'standard' });
  const map = s1.map as PathMap;
  s1.dispatch({ type: 'move', to: firstDuel(s1.run as RunState, map) });
  assert.equal(s1.run?.status, 'duel');
  assert.equal(s1.run?.lives, PATH_RULES.LIVES - 1, 'life taken when the duel starts');
  // Quit mid-duel: close the tab and come back.
  const s2 = openSession(store);
  assert.equal(s2.run?.status, 'duel');
  assert.equal(s2.run?.lives, PATH_RULES.LIVES - 1, 'reload keeps the life taken');
  // Quitting again and again never gives it back.
  const s3 = openSession(store);
  assert.equal(s3.run?.lives, PATH_RULES.LIVES - 1);
});

test('session: a win gives the life back; a loss costs exactly one in total', () => {
  const store = memoryStore();
  const s = openSession(store);
  s.dispatch({ type: 'start', seed: 42, brush: 'standard' });
  const map = s.map as PathMap;
  s.dispatch({ type: 'move', to: firstDuel(s.run as RunState, map) });
  s.dispatch({ type: 'duel-won' });
  assert.equal(s.run?.status, 'map');
  assert.equal(s.run?.lives, PATH_RULES.LIVES, 'won: life given back');
  s.dispatch({ type: 'move', to: firstDuel(s.run as RunState, map) });
  assert.equal(s.run?.lives, PATH_RULES.LIVES - 1);
  s.dispatch({ type: 'duel-lost' });
  // Retry staked: in hand 1, at stake 1, gone 1.
  assert.deepEqual(livesShown(s.run as RunState), { inHand: 1, atStake: 1, gone: 1 });
  s.dispatch({ type: 'duel-won' });
  assert.equal(s.run?.lives, PATH_RULES.LIVES - 1, 'lost once, then won: one life gone, not two');
  assert.equal(s.run?.duelsLost, 1);
  // The saved state is the reducer's state.
  assert.equal(JSON.stringify(deserializeRun(store.getItem(SAVE_KEY))), JSON.stringify(s.run));
});

test('session: out of lives after exactly LIVES lost tries, never sooner', () => {
  const s = openSession(memoryStore());
  s.dispatch({ type: 'start', seed: 5, brush: 'wide' });
  s.dispatch({ type: 'move', to: firstDuel(s.run as RunState, s.map as PathMap) });
  for (let i = 1; i < PATH_RULES.LIVES; i++) {
    s.dispatch({ type: 'duel-lost' });
    assert.equal(s.run?.status, 'duel', `loss ${i}: still fighting`);
  }
  s.dispatch({ type: 'duel-lost' });
  assert.equal(s.run?.status, 'over');
  assert.equal(s.run?.result, 'lost');
  assert.equal(s.run?.lives, 0);
  assert.equal(endTitle(s.run as RunState), 'Out of ink');
});

test('final master: beaten once ends the run, lives carry, a loss there is retried', () => {
  const map = generatePath(77);
  let run = runReducer(null, { type: 'start', seed: 77, brush: 'standard' });
  // Win every duel, take wells and no seals, up to the final master.
  for (let i = 0; i < 80 && !(run.status === 'duel' && run.at === map.finalId); i++) {
    if (run.status === 'shrine') run = runReducer(run, { type: 'pick', seal: null }, map);
    else if (run.status === 'duel') run = runReducer(run, { type: 'duel-won' }, map);
    else run = runReducer(run, { type: 'move', to: (run.at === null ? map.start : map.nodes[run.at].next)[0] }, map);
  }
  assert.equal(run.at, map.finalId);
  assert.equal(run.status, 'duel');
  const carried = run.lives + 1;
  assert.equal(carried, PATH_RULES.LIVES, 'lives carry into the final duel');
  run = runReducer(run, { type: 'duel-lost' }, map);
  assert.equal(run.status, 'duel', 'a loss at master 8 is retried while lives last');
  run = runReducer(run, { type: 'duel-won' }, map);
  assert.equal(run.status, 'over');
  assert.equal(run.result, 'won');
  assert.equal(run.lives, carried - 1, 'one life lost at the final, the stake given back');
  assert.equal(endTitle(run), 'The path is walked');
  assert.equal(map.nodes[map.finalId].master, 8);
});

test('session: only reducer states are saved; refused actions save nothing', () => {
  const store = memoryStore();
  let writes = 0;
  const counting: KeyValueStore = { getItem: (k) => store.getItem(k), setItem: (k, v) => (writes++, store.setItem(k, v)), removeItem: (k) => store.removeItem(k) };
  const s = openSession(counting);
  s.dispatch({ type: 'start', seed: 9, brush: 'fine' });
  assert.equal(writes, 1);
  s.dispatch({ type: 'move', to: 'nowhere' });
  s.dispatch({ type: 'duel-won' });
  assert.equal(writes, 1, 'refused actions write nothing');
  s.dispatch({ type: 'end' });
  assert.equal(writes, 2);
  assert.equal(openSession(store).run?.result, 'abandoned', 'an ended run stays ended after reload');
});

test('storage that throws: the run plays on without a save and with no console error', () => {
  const errors: unknown[] = [];
  const realError = console.error;
  const realWarn = console.warn;
  console.error = (...a: unknown[]) => void errors.push(a);
  console.warn = (...a: unknown[]) => void errors.push(a);
  try {
    const boom = () => {
      throw new Error('SecurityError: storage is off');
    };
    const throwing: KeyValueStore = { getItem: boom, setItem: boom, removeItem: boom };
    for (const store of [guardStore(boom), guardStore(() => throwing), guardStore(() => null)]) {
      const s = openSession(store);
      assert.equal(s.run as RunState | null, null);
      s.dispatch({ type: 'start', seed: 3, brush: 'standard' });
      s.dispatch({ type: 'move', to: (s.map as PathMap).start[0] });
      s.dispatch({ type: 'duel-won' });
      assert.equal((s.run as RunState | null)?.status, 'map');
      assert.equal(openSession(store).run, null, 'nothing was saved');
    }
  } finally {
    console.error = realError;
    console.warn = realWarn;
  }
  assert.equal(errors.length, 0);
});

test('screen text: the daily scroll is named by its UTC day, never the local date', () => {
  // 23:30 UTC on 19 Nov is already 20 Nov in South Africa: the screen must say 19 Nov.
  const late = new Date(Date.UTC(2026, 10, 19, 23, 30));
  assert.equal(scrollLabel(dailySeed('2026-11-19'), late), 'Daily scroll, 19 Nov (UTC)');
  assert.equal(scrollLabel(dailySeed('2026-11-18'), late), 'Daily scroll, 18 Nov (UTC)');
  assert.equal(scrollLabel(dailySeed('2026-11-20'), new Date(Date.UTC(2026, 10, 20, 0, 0))), 'Daily scroll, 20 Nov (UTC)');
  assert.equal(scrollLabel(0x1234abcd, late), 'Scroll 1234abcd');
  assert.equal(nextScrollIn(late), '30 min');
  assert.equal(nextScrollIn(new Date(Date.UTC(2026, 10, 19, 1, 15))), '22 h 45 min');
  const map = generatePath(1);
  assert.equal(nodeLabel(map.nodes[map.finalId]), 'Master 8');
});

// acceptance tests: leaving a fight under way (reload, closed tab, the Duel link)
// is booked as one loss when the run is loaded. Each "reload" is a fresh openSession on the store.

/** Start a run on seed 42 and step onto the first duel (stake taken, fight not begun). */
function onDuel(store: KeyValueStore): ReturnType<typeof openSession> {
  const s = openSession(store);
  s.dispatch({ type: 'start', seed: 42, brush: 'standard' });
  s.dispatch({ type: 'move', to: firstDuel(s.run as RunState, s.map as PathMap) });
  return s;
}

test('acceptance a: begin the fight, reload, win: lives 2 of 3, duelsLost 1', () => {
  const store = memoryStore();
  const s = onDuel(store);
  s.dispatch({ type: 'duel-begin' });
  assert.equal(s.run?.fighting, true);
  const r = openSession(store);
  assert.equal(r.run?.status, 'duel', 'the retry waits');
  assert.equal(r.run?.fighting, false);
  r.dispatch({ type: 'duel-won' });
  assert.equal(r.run?.lives, 2);
  assert.equal(r.run?.duelsLost, 1);
});

test('acceptance b: a fight on the last life left by reload ends the run, lost', () => {
  const store = memoryStore();
  const s = onDuel(store);
  s.dispatch({ type: 'duel-lost' });
  s.dispatch({ type: 'duel-lost' });
  // One life left in all: it is the one at stake (0 in hand).
  assert.deepEqual(livesShown(s.run as RunState), { inHand: 0, atStake: 1, gone: 2 });
  s.dispatch({ type: 'duel-begin' });
  const r = openSession(store);
  assert.equal(r.run?.status, 'over');
  assert.equal(r.run?.result, 'lost');
  assert.equal(r.run?.lives, 0);
  assert.equal(openSession(store).run?.result, 'lost', 'saved as lost');
});

test('acceptance c: lose, reload twice on the retry screen, win: lives 2, duelsLost 1', () => {
  const store = memoryStore();
  const s = onDuel(store);
  s.dispatch({ type: 'duel-begin' });
  s.dispatch({ type: 'duel-lost' });
  const r1 = openSession(store);
  assert.equal(r1.run?.status, 'duel');
  assert.equal(r1.run?.fighting, false, 'retry waiting, fight not begun');
  assert.equal(r1.run?.lives, 1);
  const r2 = openSession(store);
  assert.equal(r2.run?.lives, 1, 'reloading the retry screen costs nothing');
  r2.dispatch({ type: 'duel-begin' });
  r2.dispatch({ type: 'duel-won' });
  assert.equal(r2.run?.lives, 2);
  assert.equal(r2.run?.duelsLost, 1);
});

test('acceptance d: begin, then three reloads: exactly one loss booked', () => {
  const store = memoryStore();
  const s = onDuel(store);
  s.dispatch({ type: 'duel-begin' });
  const r1 = openSession(store);
  const saved = deserializeRun(store.getItem(SAVE_KEY));
  assert.deepEqual([saved?.lives, saved?.duelsLost, saved?.fighting], [1, 1, false], 'the first load saves the booked loss');
  const r2 = openSession(store);
  const r3 = openSession(store);
  for (const r of [r1, r2, r3]) {
    assert.equal(r.run?.duelsLost, 1);
    assert.equal(r.run?.lives, 1);
    assert.equal(r.run?.status, 'duel');
  }
});

test('acceptance e: a win booked at the result card, reload before Continue: map, life back', () => {
  const store = memoryStore();
  const s = onDuel(store);
  s.dispatch({ type: 'duel-begin' });
  s.dispatch({ type: 'duel-won' });
  const r = openSession(store);
  assert.equal(r.run?.status, 'map');
  assert.equal(r.run?.lives, PATH_RULES.LIVES);
  assert.equal(r.run?.duelsLost, 0);
  assert.equal(r.run?.duelsWon, 1);
});

test('acceptance f: a version 2 save is rejected and removed', () => {
  const store = memoryStore();
  const s = onDuel(store);
  const v3 = JSON.parse(store.getItem(SAVE_KEY) as string);
  assert.equal(v3.v, 3);
  const { fighting: _drop, ...old } = v3.run;
  void _drop;
  store.setItem(SAVE_KEY, JSON.stringify({ v: 2, run: { ...old, version: 2 } }));
  assert.equal(openSession(store).run, null);
  assert.equal(store.getItem(SAVE_KEY), null, 'removed');
  assert.ok(s.run, 'the old session object is untouched');
});

test('booking is pure: bookLeftFight changes only a fight under way', () => {
  const map = generatePath(42);
  let run = runReducer(null, { type: 'start', seed: 42, brush: 'standard' });
  assert.ok(bookLeftFight(run, map) === run);
  run = runReducer(run, { type: 'move', to: firstDuel(run, map) }, map);
  assert.ok(bookLeftFight(run, map) === run, 'retry or fresh duel not begun: unchanged');
  const begun = runReducer(run, { type: 'duel-begin' }, map);
  assert.ok(runReducer(begun, { type: 'duel-begin' }, map) === begun, 'begin twice: same state');
  const booked = bookLeftFight(begun, map);
  assert.deepEqual([booked.lives, booked.duelsLost, booked.fighting], [1, 1, false]);
  assert.ok(bookLeftFight(booked, map) === booked, 'booked once only');
});
