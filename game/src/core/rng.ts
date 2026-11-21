// Seeded random numbers (mulberry32). Same seed, same sequence, on every
// machine, so a daily scroll or a replay can be rebuilt from one number.

export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [min, max], both ends included. */
  int(min: number, max: number): number;
  /** Float in [min, max). */
  range(min: number, max: number): number;
}

/** Turn any string (for example a date) into a 32-bit seed. */
export function seedFromString(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(min: number, max: number): number {
      if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
        throw new RangeError(`bad int range ${min}..${max}`);
      }
      return min + Math.floor(next() * (max - min + 1));
    },
    range(min: number, max: number): number {
      return min + next() * (max - min);
    },
  };
}
