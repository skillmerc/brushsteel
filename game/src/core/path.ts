// Path mode: a short run up a branching scroll map. Pure and
// seeded: no DOM, no storage, no Math.random. The map is rebuilt from the
// run seed, so a save only needs the seed and the run state (save.ts).
//
//   const map = generatePath(seed)            // 3 acts, 4 or 5 steps each
//   let run = runReducer(null, { type: 'start', seed, brush: 'standard' })
//   run = runReducer(run, { type: 'move', to: map.start[0] }, map)
//   const setup = duelSetup(run, map)         // master + mods for createDuel
//
// Seals and brushes are FighterMods (duel.ts) for fighter 0, the player.
// The finish rates of the reference players are checked in pathsim.test.ts.

import { createRng, seedFromString, type Rng } from './rng.js';
import type { FighterMods } from './duel.js';
import { MASTERS } from './masters.js';

// ---------------------------------------------------------------------------
// Seals: relics that change duel rules for the player.

export type SealId =
  | 'long-riposte'
  | 'thrifty-cut'
  | 'open-window'
  | 'quick-dip'
  | 'iron-circle'
  | 'heavy-hand'
  | 'slow-ink'
  | 'deep-well'
  | 'light-feet'
  | 'long-blade'
  | 'blood-pact'
  | 'thin-line';

export interface Seal {
  id: SealId;
  name: string;
  /** Names the rule it changes. */
  text: string;
  mods: FighterMods;
}

export const SEALS: readonly Seal[] = [
  { id: 'long-riposte', name: 'Long Riposte', text: 'Your parry stuns the foe 50% longer (600 ms, not 400).', mods: { riposteMul: 1.5 } },
  { id: 'thrifty-cut', name: 'Thrifty Cut', text: 'Cuts cost 40% less ink.', mods: { inkCostMul: { cut: 0.6 } } },
  { id: 'open-window', name: 'Open Window', text: 'Your parry window is 100 ms longer (400 ms, not 300).', mods: { parryWindowMs: 100 } },
  { id: 'quick-dip', name: 'Quick Dip', text: 'Dipping the brush takes 420 ms, not 700.', mods: { dipMul: 0.6 } },
  { id: 'iron-circle', name: 'Iron Circle', text: 'Circle guards cost half the ink and last twice as long.', mods: { guardInkMul: 0.5, guardMsMul: 2 } },
  { id: 'heavy-hand', name: 'Heavy Hand', text: 'Your hits knock the foe back 50% further.', mods: { knockMul: 1.5 } },
  { id: 'slow-ink', name: 'Slow Ink', text: 'Foe lines show 50 ms longer before they land.', mods: { foeWindupMs: 50 } },
  { id: 'deep-well', name: 'Deep Well', text: 'Your brush holds 130 ink, not 100.', mods: { inkMaxBonus: 30 } },
  { id: 'light-feet', name: 'Light Feet', text: 'Steps and dashes take 30% less time.', mods: { moveMsMul: 0.7 } },
  { id: 'long-blade', name: 'Long Blade', text: 'Every stroke reaches 0.3 further.', mods: { reachBonus: 0.3 } },
  { id: 'blood-pact', name: 'Blood Pact', text: 'Your hits count double, but your parry window is 100 ms shorter.', mods: { hitValue: 2, parryWindowMs: -100 } },
  { id: 'thin-line', name: 'Thin Line', text: 'Foe lines land 80 ms sooner, but your riposte lasts twice as long.', mods: { foeWindupMs: -80, riposteMul: 2 } },
];

export const SEAL_IDS: readonly SealId[] = SEALS.map((s) => s.id);

export function sealById(id: SealId): Seal {
  const s = SEALS.find((x) => x.id === id);
  if (!s) throw new RangeError(`unknown seal ${id}`);
  return s;
}

// ---------------------------------------------------------------------------
// Brushes: picked at the start of a run.

export type BrushId = 'wide' | 'standard' | 'fine';

export interface Brush {
  id: BrushId;
  name: string;
  text: string;
  mods: FighterMods;
}

export const BRUSHES: readonly Brush[] = [
  { id: 'wide', name: 'Wide brush', text: 'Big slow hits: 40% more knockback and 0.2 more reach, strokes land 60 ms later and cost 20% more ink.', mods: { knockMul: 1.4, reachBonus: 0.2, ownWindupMs: 60, inkCostMul: { cut: 1.2, overhead: 1.2, rising: 1.2, thrust: 1.2 } } },
  { id: 'standard', name: 'Standard brush', text: 'The plain duel rules.', mods: {} },
  { id: 'fine', name: 'Fine brush', text: 'Thin strokes: 25% less ink, 30% less knockback, 0.2 less reach.', mods: { knockMul: 0.7, reachBonus: -0.2, inkCostMul: { cut: 0.75, overhead: 0.75, rising: 0.75, thrust: 0.75 } } },
];

export const BRUSH_IDS: readonly BrushId[] = BRUSHES.map((b) => b.id);

export function brushById(id: BrushId): Brush {
  const b = BRUSHES.find((x) => x.id === id);
  if (!b) throw new RangeError(`unknown brush ${id}`);
  return b;
}

/** One FighterMods from a brush and any seals: multipliers multiply, additions add, hitValue takes the largest. */
export function combineMods(list: readonly FighterMods[]): FighterMods {
  const out: FighterMods = {};
  const mul = ['riposteMul', 'dipMul', 'guardInkMul', 'guardMsMul', 'knockMul', 'moveMsMul'] as const;
  const add = ['parryWindowMs', 'inkMaxBonus', 'reachBonus', 'ownWindupMs', 'foeWindupMs'] as const;
  for (const m of list) {
    for (const k of mul) if (m[k] !== undefined) out[k] = (out[k] ?? 1) * (m[k] as number);
    for (const k of add) if (m[k] !== undefined) out[k] = (out[k] ?? 0) + (m[k] as number);
    if (m.hitValue !== undefined) out.hitValue = Math.max(out.hitValue ?? 1, m.hitValue);
    if (m.inkCostMul) {
      const c = { ...(out.inkCostMul ?? {}) };
      for (const [k, v] of Object.entries(m.inkCostMul) as [keyof typeof c, number][]) c[k] = (c[k] ?? 1) * v;
      out.inkCostMul = c;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The map.

export type NodeKind = 'duel' | 'shrine' | 'well' | 'master';

export interface PathNode {
  id: string;
  act: number;
  row: number;
  col: number;
  kind: NodeKind;
  /** Master (1 to 8) fought here; 0 for shrines and wells. */
  master: number;
  /** Ids of the nodes this one leads to (the next act's first row after an act master; none after the last). */
  next: string[];
}

export interface PathAct {
  index: number;
  /** Node ids by row; the last row is the act master alone. */
  rows: string[][];
  master: number;
}

export interface PathMap {
  seed: number;
  acts: PathAct[];
  nodes: Record<string, PathNode>;
  /** The first row of act 1: where a run picks its first step. */
  start: string[];
  /** The last act's master: beat it to finish the run. */
  finalId: string;
}

export const PATH_RULES = {
  ACTS: 3,
  /** Steps per act, master included (any route through an act is this long). */
  ACT_MIN: 4,
  ACT_MAX: 5,
  /** Nodes per row before the master row. */
  ROW_MIN: 2,
  ROW_MAX: 3,
  /** Act masters, from masters.ts (the last is the ending). */
  ACT_MASTERS: [3, 5, 8],
  /** Masters met at duel nodes, per act. */
  DUEL_POOLS: [[1, 2], [2, 3, 4], [3, 4, 5]],
  /**
   * Lives (run ink): a lost duel costs one and may be retried; at 0 the run ends. The life is
   * taken when a duel starts (and saved), and given back on a win, so quitting a duel you are
   * losing (closing the tab, reloading) costs the life too: no free retry.
   */
  LIVES: 3,
  /** Lives regained by beating an act master (capped at LIVES). */
  ACT_MASTER_HEAL: 1,
  /** Seals a shrine offers (pick one or none). */
  SHRINE_OFFER: 3,
};

export function nodeId(act: number, row: number, col: number): string {
  return `a${act}r${row}c${col}`;
}

function shuffle<T>(rng: Rng, xs: T[]): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Build the map from a seed. Each act: row 0 all duels; middle rows a seeded
 * mix of duels, shrines and wells; the row before the master one shrine and
 * one well (so every act has both, and every route rests before its master);
 * the last row the act master. Every node links to at least 2 nodes of the
 * next row when that row has 2 or more, and every node has a
 * way in, so the final master is reachable from every node.
 */
export function generatePath(seed: number): PathMap {
  const rng = createRng((seed ^ 0x5eed9a7f) >>> 0);
  const R = PATH_RULES;
  const nodes: Record<string, PathNode> = {};
  const acts: PathAct[] = [];
  for (let a = 0; a < R.ACTS; a++) {
    const len = rng.int(R.ACT_MIN, R.ACT_MAX);
    const rows: string[][] = [];
    const pool = R.DUEL_POOLS[a];
    for (let r = 0; r < len; r++) {
      const isMaster = r === len - 1;
      const isRest = r === len - 2;
      const width = isMaster ? 1 : isRest ? 2 : rng.int(R.ROW_MIN, R.ROW_MAX);
      const kinds: NodeKind[] = [];
      if (isMaster) kinds.push('master');
      else if (isRest) kinds.push(...shuffle(rng, ['shrine', 'well'] as NodeKind[]));
      else if (r === 0) for (let c = 0; c < width; c++) kinds.push('duel');
      else {
        // At least one duel per middle row; the rest a seeded mix.
        kinds.push('duel');
        for (let c = 1; c < width; c++) {
          const x = rng.next();
          kinds.push(x < 0.5 ? 'duel' : x < 0.75 ? 'shrine' : 'well');
        }
        kinds.splice(0, kinds.length, ...shuffle(rng, kinds));
      }
      const ids: string[] = [];
      kinds.forEach((kind, c) => {
        const id = nodeId(a, r, c);
        const master = kind === 'master' ? R.ACT_MASTERS[a] : kind === 'duel' ? pool[rng.int(0, pool.length - 1)] : 0;
        nodes[id] = { id, act: a, row: r, col: c, kind, master, next: [] };
        ids.push(id);
      });
      rows.push(ids);
    }
    acts.push({ index: a, rows, master: R.ACT_MASTERS[a] });
  }
  // Links inside each act, then act master to the next act's first row.
  for (const act of acts) {
    for (let r = 0; r + 1 < act.rows.length; r++) {
      const here = act.rows[r];
      const there = act.rows[r + 1];
      if (there.length === 1) {
        for (const id of here) nodes[id].next = [there[0]];
        continue;
      }
      // Each node: its own column (clamped) and one neighbour, so 2 choices.
      here.forEach((id, c) => {
        const j = Math.min(c, there.length - 1);
        const k = j + 1 < there.length ? j + 1 : j - 1;
        const pick = rng.next() < 0.5 && j - 1 >= 0 && j - 1 !== k ? j - 1 : k;
        nodes[id].next = [there[Math.min(j, pick)], there[Math.max(j, pick)]];
      });
      // Any node of the next row with no way in gets one from the nearest node.
      there.forEach((tid, j) => {
        if (here.some((id) => nodes[id].next.includes(tid))) return;
        const from = here[Math.min(j, here.length - 1)];
        nodes[from].next = [...nodes[from].next, tid].sort();
      });
    }
    const last = act.rows[act.rows.length - 1][0];
    const nextAct = acts[act.index + 1];
    nodes[last].next = nextAct ? nextAct.rows[0].slice() : [];
  }
  const lastAct = acts[acts.length - 1];
  return { seed: seed >>> 0, acts, nodes, start: acts[0].rows[0].slice(), finalId: lastAct.rows[lastAct.rows.length - 1][0] };
}

/** Every node reachable from the start row (breadth first). */
export function reachableFromStart(map: PathMap): Set<string> {
  const seen = new Set<string>(map.start);
  const queue = map.start.slice();
  while (queue.length) {
    const id = queue.shift() as string;
    for (const n of map.nodes[id].next) if (!seen.has(n)) (seen.add(n), queue.push(n));
  }
  return seen;
}

// ---------------------------------------------------------------------------
// Daily scroll seed.

/** Seed of the daily scroll for a date string YYYY-MM-DD. Throws on any other shape. */
export function dailySeed(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RangeError(`date must be YYYY-MM-DD, got ${date}`);
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) throw new RangeError(`no such date ${date}`);
  return seedFromString(`brushsteel-daily-${date}`);
}

/** The UTC date key of a moment (one daily scroll worldwide). */
export function dateKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Run state: a pure reducer. The map is not stored; it comes from run.seed.

// Version 2: in 'duel' the life at stake is already taken off `lives`.
// Version 3: `fighting` marks a fight under way, so a reload books it as lost.
export const RUN_VERSION = 3;

export type RunStatus = 'map' | 'duel' | 'shrine' | 'over';

export interface RunState {
  version: number;
  seed: number;
  brush: BrushId;
  /** Current node, or null before the first step. */
  at: string | null;
  /** Nodes entered, in order. */
  visited: string[];
  seals: SealId[];
  /** Lives in hand. In 'duel' one more is at stake: already taken, given back on a win. */
  lives: number;
  /** Seals offered by the shrine the run stands on (empty elsewhere). */
  offer: SealId[];
  status: RunStatus;
  result: 'won' | 'lost' | 'abandoned' | null;
  duelsWon: number;
  duelsLost: number;
  /**
   * A fight is under way (set by 'duel-begin', cleared by its result). A run loaded with this
   * set was left mid-fight: openSession books it as one loss (bookLeftFight), so leaving a
   * fight never gives a free retry. False while the retry waits on the map.
   */
  fighting: boolean;
}

export type RunAction =
  | { type: 'start'; seed: number; brush: BrushId }
  | { type: 'move'; to: string }
  | { type: 'pick'; seal: SealId | null }
  | { type: 'duel-begin' }
  | { type: 'duel-won' }
  | { type: 'duel-lost' }
  | { type: 'end' };

/** Seals a shrine offers: seeded by run seed and node, never one already held. */
export function shrineOffer(seed: number, node: string, held: readonly SealId[]): SealId[] {
  const rng = createRng((seed ^ seedFromString(`shrine-${node}`)) >>> 0);
  return shuffle(rng, SEAL_IDS.filter((s) => !held.includes(s))).slice(0, PATH_RULES.SHRINE_OFFER);
}

/** Where the run may step next. */
export function choices(run: RunState, map: PathMap): string[] {
  if (run.status !== 'map') return [];
  return run.at === null ? map.start.slice() : map.nodes[run.at].next.slice();
}

export function newRun(seed: number, brush: BrushId): RunState {
  brushById(brush);
  return { version: RUN_VERSION, seed: seed >>> 0, brush, at: null, visited: [], seals: [], lives: PATH_RULES.LIVES, offer: [], status: 'map', result: null, duelsWon: 0, duelsLost: 0, fighting: false };
}

/**
 * Next run state. Never mutates. An action that is not allowed now returns the
 * same state object (callers can compare with ===). 'start' needs no map.
 */
export function runReducer(run: RunState | null, action: RunAction, map?: PathMap): RunState {
  if (action.type === 'start') return newRun(action.seed, action.brush);
  if (!run) throw new Error('no run: start one first');
  if (run.status === 'over') return run;
  if (action.type === 'end') return { ...run, status: 'over', result: 'abandoned', offer: [], fighting: false };
  if (!map || map.seed !== run.seed) throw new Error('map does not match the run seed');
  switch (action.type) {
    case 'move': {
      if (!choices(run, map).includes(action.to)) return run;
      const node = map.nodes[action.to];
      const next: RunState = { ...run, at: node.id, visited: [...run.visited, node.id], offer: [] };
      if (node.kind === 'duel' || node.kind === 'master') {
        // Take the life at stake now: a reload mid-duel keeps it taken.
        next.status = 'duel';
        next.lives = run.lives - 1;
      }
      else if (node.kind === 'shrine') {
        next.offer = shrineOffer(run.seed, node.id, run.seals);
        next.status = next.offer.length ? 'shrine' : 'map';
      } else next.lives = PATH_RULES.LIVES;
      return next;
    }
    case 'pick': {
      if (run.status !== 'shrine') return run;
      if (action.seal !== null && !run.offer.includes(action.seal)) return run;
      return { ...run, seals: action.seal ? [...run.seals, action.seal] : run.seals, offer: [], status: 'map' };
    }
    case 'duel-begin': {
      if (run.status !== 'duel' || run.fighting) return run;
      return { ...run, fighting: true };
    }
    case 'duel-won': {
      if (run.status !== 'duel' || run.at === null) return run;
      const node = map.nodes[run.at];
      // The life at stake comes back.
      const back = run.lives + 1;
      if (node.id === map.finalId) return { ...run, lives: back, duelsWon: run.duelsWon + 1, status: 'over', result: 'won', fighting: false };
      const lives = node.kind === 'master' ? Math.min(PATH_RULES.LIVES, back + PATH_RULES.ACT_MASTER_HEAL) : back;
      return { ...run, duelsWon: run.duelsWon + 1, lives, status: 'map', fighting: false };
    }
    case 'duel-lost': {
      if (run.status !== 'duel') return run;
      // The life at stake is gone (it was taken when the duel started). With lives left the run
      // stays on this node and the retry takes the next life now; with none the run ends.
      if (run.lives <= 0) return { ...run, duelsLost: run.duelsLost + 1, lives: 0, status: 'over', result: 'lost', fighting: false };
      return { ...run, duelsLost: run.duelsLost + 1, lives: run.lives - 1, status: 'duel', result: null, fighting: false };
    }
  }
}

/** What the duel at the run's node needs: the master and the mods for createDuel (player is fighter 0). */
export function duelSetup(run: RunState, map: PathMap): { master: number; mods: [FighterMods, null] } {
  if (run.status !== 'duel' || run.at === null) throw new Error('not at a duel');
  const node = map.nodes[run.at];
  const mods = combineMods([brushById(run.brush).mods, ...run.seals.map((s) => sealById(s).mods)]);
  return { master: node.master, mods: [mods, null] };
}

/** Number of masters on the ladder (the final act master is the last). */
export const PATH_MASTER_COUNT = MASTERS.length;
