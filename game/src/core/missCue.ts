// Why a stroke of yours did not score, as a short line the HUD shows for a
// moment under your seals. Pure: one duel event in, one line or null out.

import type { DuelEvent } from './duel.js';

/** How long the HUD shows a miss line, ms. */
export const MISS_CUE_MS = 1100;

export function missCue(e: DuelEvent, player: 0 | 1): string | null {
  const foe = player === 0 ? 1 : 0;
  switch (e.type) {
    case 'parry':
      return e.who === foe ? 'Parried' : null;
    case 'blocked':
      return e.who === player ? 'Turned aside' : null;
    case 'whiff':
      return e.who === player ? 'Out of reach' : null;
    case 'fizzle':
      return e.who === player && e.reason === 'slow' ? 'Too slow' : null;
    case 'dry':
      return e.who === player ? 'Out of ink: dip' : null;
    default:
      return null;
  }
}
