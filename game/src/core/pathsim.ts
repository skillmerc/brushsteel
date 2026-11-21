// Whole Path runs played by a reference player.
// Pure and deterministic: the duels use the same reference players and
// masters as masters.test.ts, with the run's brush and seals as the player's
// mods. Used by pathsim.test.ts to put a number on how often a run finishes.

import { aiAct, createAi, createRefPlayer, refPlayerAct, type RefPlayerOptions } from './ai.js';
import { createDuel, stepDuel, type FighterMods } from './duel.js';
import { masterByIndex } from './masters.js';
import { seedFromString } from './rng.js';
import { choices, duelSetup, generatePath, runReducer, type BrushId, type PathMap, type RunState, type SealId } from './path.js';

/** One duel with mods: reference player as fighter 0, the master as fighter 1. True if the player wins. */
export function simulateModDuel(seed: number, master: number, player: RefPlayerOptions, mods: [FighterMods | null, FighterMods | null] | undefined, maxTicks = 60 * 600): boolean {
  const duel = createDuel(seed, mods ? { mods } : {});
  const ai = createAi(masterByIndex(master).style, 1, seed);
  const bot = createRefPlayer(player, seed);
  while (duel.state.phase !== 'over' && duel.state.tick < maxTicks) stepDuel(duel, [refPlayerAct(bot, duel, 0), aiAct(ai, duel)]);
  return duel.state.winner === 0;
}

/** Seal order the scripted run prefers when a shrine offers several (most useful to a parrying bot first). */
export const SIM_SEAL_ORDER: readonly SealId[] = ['slow-ink', 'long-riposte', 'open-window', 'long-blade', 'heavy-hand', 'thrifty-cut', 'deep-well', 'quick-dip', 'iron-circle', 'light-feet', 'thin-line', 'blood-pact'];

/** The scripted route choice: a well when hurt, else a shrine, else the duel with the lowest master. */
function pickStep(run: RunState, map: PathMap): string {
  const opts = choices(run, map).map((id) => map.nodes[id]);
  const well = opts.find((n) => n.kind === 'well');
  if (well && run.lives < 3) return well.id;
  const shrine = opts.find((n) => n.kind === 'shrine');
  if (shrine) return shrine.id;
  const fights = opts.filter((n) => n.kind === 'duel' || n.kind === 'master').sort((a, b) => a.master - b.master || (a.id < b.id ? -1 : 1));
  return (fights[0] ?? opts[0]).id;
}

export interface PathRunResult {
  won: boolean;
  /** Act reached (0 to 2) when the run ended. */
  act: number;
  duels: number;
  losses: number;
  /** Tries at the final master (0 if never reached). */
  finalTries: number;
}

/** Play one whole run with a reference player. Every duel's seed comes from the run seed, the node and the try. */
export function simulatePathRun(seed: number, player: RefPlayerOptions, brush: BrushId = 'standard'): PathRunResult {
  const map = generatePath(seed);
  let run = runReducer(null, { type: 'start', seed, brush });
  let finalTries = 0;
  let guard = 0;
  while (run.status !== 'over' && guard++ < 200) {
    if (run.status === 'map') run = runReducer(run, { type: 'move', to: pickStep(run, map) }, map);
    else if (run.status === 'shrine') run = runReducer(run, { type: 'pick', seal: SIM_SEAL_ORDER.find((s) => run.offer.includes(s)) ?? null }, map);
    else {
      const setup = duelSetup(run, map);
      if (run.at === map.finalId) finalTries++;
      const duelSeed = (seed ^ seedFromString(`${run.at}#${run.duelsLost}`)) >>> 0;
      const won = simulateModDuel(duelSeed, setup.master, player, setup.mods);
      run = runReducer(run, { type: won ? 'duel-won' : 'duel-lost' }, map);
    }
  }
  const act = run.at ? map.nodes[run.at].act : 0;
  return { won: run.result === 'won', act, duels: run.duelsWon + run.duelsLost, losses: run.duelsLost, finalTries };
}
