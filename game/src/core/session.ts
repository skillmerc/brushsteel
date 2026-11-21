// Path mode session: the one place the game changes a run.
// Every state it keeps and saves came from runReducer.
// Pure apart from the injected storage, so tests need no browser.

import { PATH_RULES, dailySeed, dateKey, generatePath, runReducer, type PathMap, type PathNode, type RunAction, type RunState } from './path.js';
import { loadRun, saveRun, type KeyValueStore } from './save.js';

/**
 * A store that never throws. `get` may throw (window.localStorage in some
 * private modes) and so may each call (quota, security errors): then the game
 * plays on without a save, and nothing is written to the console.
 */
export function guardStore(get: () => KeyValueStore | null | undefined): KeyValueStore {
  let inner: KeyValueStore | null = null;
  try {
    inner = get() ?? null;
  } catch {
    inner = null;
  }
  return {
    getItem(key) {
      try {
        return inner ? inner.getItem(key) : null;
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      try {
        if (inner) inner.setItem(key, value);
      } catch {
        // No save this time: the run goes on. Drop the older save too, so a failed save of a
        // staked or lost duel never leaves an earlier state to reload.
        try {
          if (inner) inner.removeItem(key);
        } catch {
          /* nothing to do */
        }
      }
    },
    removeItem(key) {
      try {
        if (inner) inner.removeItem(key);
      } catch {
        /* nothing to do */
      }
    },
  };
}

/** A store in memory (the CI demo, and tests). */
export function memoryStore(): KeyValueStore {
  const data = new Map<string, string>();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

export interface PathSession {
  readonly run: RunState | null;
  readonly map: PathMap | null;
  /** Apply one action through runReducer; a changed state is saved. Returns the run after the action. */
  dispatch(action: RunAction): RunState;
}

/**
 * A run loaded with a fight under way was left mid-fight (reload, closed tab, the Duel link):
 * book that fight as one loss, the same as 'duel-lost' (retry staked, or the run over at 0).
 * Any other run comes back unchanged (same object), including a retry waiting on the map.
 */
export function bookLeftFight(run: RunState, map: PathMap): RunState {
  if (run.status !== 'duel' || !run.fighting) return run;
  return runReducer(run, { type: 'duel-lost' }, map);
}

/** Open the session: the saved run if there is a valid one, else none. A fight left under way is booked as lost and saved before anything else. */
export function openSession(store: KeyValueStore): PathSession {
  let run: RunState | null = loadRun(store);
  let map: PathMap | null = run ? generatePath(run.seed) : null;
  if (run && map) {
    const booked = bookLeftFight(run, map);
    if (booked !== run) {
      run = booked;
      saveRun(store, run);
    }
  }
  return {
    get run() {
      return run;
    },
    get map() {
      return map;
    },
    dispatch(action) {
      if (action.type === 'start') {
        run = runReducer(run, action);
        map = generatePath(run.seed);
        saveRun(store, run);
        return run;
      }
      const next = runReducer(run, action, map ?? undefined);
      if (next !== run) {
        run = next;
        saveRun(store, run);
      }
      return run as RunState;
    },
  };
}

// ---------------------------------------------------------------------------
// Screen text (pure, tested).

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "20 Nov" from a UTC date key YYYY-MM-DD. */
export function shortUtcDate(key: string): string {
  const [, m, d] = key.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

/**
 * Name of a run's scroll as the screen shows it. A daily scroll is named by its
 * UTC day, never the local date; looks back 7 days.
 */
export function scrollLabel(seed: number, now: Date): string {
  for (let back = 0; back < 8; back++) {
    const key = dateKey(new Date(now.getTime() - back * 86400000));
    if (dailySeed(key) === seed >>> 0) return `Daily scroll, ${shortUtcDate(key)} (UTC)`;
  }
  return `Scroll ${(seed >>> 0).toString(16).padStart(8, '0')}`;
}

/** Time to the next daily scroll (00:00 UTC), as "5 h 12 min". */
export function nextScrollIn(now: Date): string {
  const t = now.getTime();
  const next = Math.floor(t / 86400000) * 86400000 + 86400000;
  const min = Math.max(1, Math.ceil((next - t) / 60000));
  const h = Math.floor(min / 60);
  return h > 0 ? `${h} h ${min % 60} min` : `${min} min`;
}

/** Short label of a map node. */
export function nodeLabel(node: PathNode): string {
  if (node.kind === 'shrine') return 'Shrine';
  if (node.kind === 'well') return 'Ink well';
  return `Master ${node.master}`;
}

/** The end screen's title for a finished run. */
export function endTitle(run: RunState): string {
  if (run.result === 'won') return 'The path is walked';
  if (run.result === 'lost') return 'Out of ink';
  return 'Run ended';
}

/** Lives as filled and empty drops: in hand, at stake (in a duel), gone. */
export function livesShown(run: RunState): { inHand: number; atStake: number; gone: number } {
  const atStake = run.status === 'duel' ? 1 : 0;
  return { inHand: run.lives, atStake, gone: Math.max(0, PATH_RULES.LIVES - run.lives - atStake) };
}
