// Path run save. Pure: the storage is passed in, so tests need no
// browser. In the game, pass window.localStorage (no account, no network).
// The save holds the run state only; the map is rebuilt from run.seed.

import { BRUSH_IDS, PATH_RULES, RUN_VERSION, SEAL_IDS, generatePath, type RunState } from './path.js';

/** The part of localStorage the save uses. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const SAVE_KEY = 'brushsteel.path';

export function serializeRun(run: RunState): string {
  return JSON.stringify({ v: RUN_VERSION, run });
}

const isInt = (x: unknown, lo: number, hi: number): x is number => typeof x === 'number' && Number.isInteger(x) && x >= lo && x <= hi;

/** The run in a save string, or null if it is not a valid save of this version. */
export function deserializeRun(text: string | null): RunState | null {
  if (typeof text !== 'string' || text.length > 20000) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const { v, run } = data as { v?: unknown; run?: unknown };
  if (v !== RUN_VERSION || !run || typeof run !== 'object') return null;
  const r = run as Record<string, unknown>;
  if (r.version !== RUN_VERSION || !isInt(r.seed, 0, 0xffffffff)) return null;
  if (typeof r.brush !== 'string' || !(BRUSH_IDS as readonly string[]).includes(r.brush)) return null;
  if (!['map', 'duel', 'shrine', 'over'].includes(r.status as string)) return null;
  if (![null, 'won', 'lost', 'abandoned'].includes(r.result as string | null)) return null;
  if ((r.status === 'over') !== (r.result !== null)) return null;
  // Lives in hand: 1 to 3 on the map or at a shrine, 0 to 2 in a duel (one is at stake), 0 to 3 when over.
  const livesLo = r.status === 'map' || r.status === 'shrine' ? 1 : 0;
  const livesHi = r.status === 'duel' ? PATH_RULES.LIVES - 1 : PATH_RULES.LIVES;
  if (!isInt(r.lives, livesLo, livesHi) || !isInt(r.duelsWon, 0, 999) || !isInt(r.duelsLost, 0, 999)) return null;
  const sealList = (x: unknown) => Array.isArray(x) && x.every((s) => (SEAL_IDS as readonly string[]).includes(s)) && new Set(x).size === x.length;
  if (!sealList(r.seals) || !sealList(r.offer)) return null;
  if (!Array.isArray(r.visited) || !r.visited.every((x) => typeof x === 'string')) return null;
  // Every node must exist on the map rebuilt from the seed, and the route must follow its links.
  const map = generatePath(r.seed);
  const visited = r.visited as string[];
  for (let i = 0; i < visited.length; i++) {
    const id = visited[i];
    if (!map.nodes[id]) return null;
    const ok = i === 0 ? map.start.includes(id) : visited[i - 1] === id || map.nodes[visited[i - 1]].next.includes(id);
    if (!ok) return null;
  }
  if (r.at !== null && typeof r.at !== 'string') return null;
  const at = r.at as string | null;
  if (at === null ? visited.length !== 0 : visited[visited.length - 1] !== at) return null;
  if (r.status === 'shrine' && (r.offer as string[]).length === 0) return null;
  if (r.status === 'duel' && (at === null || !['duel', 'master'].includes(map.nodes[at].kind))) return null;
  // A fight under way only in a duel.
  if (typeof r.fighting !== 'boolean' || (r.fighting && r.status !== 'duel')) return null;
  return {
    version: RUN_VERSION,
    seed: r.seed,
    brush: r.brush as RunState['brush'],
    at: at as string | null,
    visited: visited.slice(),
    seals: (r.seals as RunState['seals']).slice(),
    lives: r.lives,
    offer: (r.offer as RunState['offer']).slice(),
    status: r.status as RunState['status'],
    result: r.result as RunState['result'],
    duelsWon: r.duelsWon,
    duelsLost: r.duelsLost,
    fighting: r.fighting,
  };
}

export function saveRun(store: KeyValueStore, run: RunState): void {
  store.setItem(SAVE_KEY, serializeRun(run));
}

/** The saved run, or null. A corrupt or old save is removed and null returned. */
export function loadRun(store: KeyValueStore): RunState | null {
  let text: string | null = null;
  try {
    text = store.getItem(SAVE_KEY);
  } catch {
    return null;
  }
  if (text === null) return null;
  const run = deserializeRun(text);
  if (!run) store.removeItem(SAVE_KEY);
  return run;
}

export function clearRun(store: KeyValueStore): void {
  store.removeItem(SAVE_KEY);
}
