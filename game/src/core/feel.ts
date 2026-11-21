// Game feel timing: pure numbers and curves, no DOM, no three.js.
// Hit-stop length, the camera kick decay, the slow-motion final stroke and
// the ink spatter that stays on the paper for the duel. Every number
// is in FEEL below.

export const FEEL = {
  /** Hit-stop on a clean hit: 67 ms, rounded up to 5 ticks (83 ms) at 60 Hz (the bar is 50 ms, 3 frames, or more). */
  HITSTOP_MS: 67,
  /** Hit-stop on the killing blow (80 to 120 ms): 100 ms = 6 ticks. */
  HITSTOP_FINAL_MS: 100,
  /** Camera kick on a hit, world units (the view is 16 units wide, so under 1 percent). */
  KICK: 0.14,
  /** Kick decay time constant, seconds. At 200 ms about 4 percent is left. */
  KICK_TAU_S: 0.0625,
  /** Final stroke slow motion: game time runs at this rate... */
  SLOWMO_RATE: 0.3,
  /** ...for this long in real time, from the end of the final hit-stop. */
  SLOWMO_MS: 600,
  /** Ink spatter blots kept on the paper; the oldest is replaced past this. */
  SPATTER_CAP: 64,
  /** Blots left by one hit. */
  SPATTER_PER_HIT: 9,
} as const;

/** Hit-stop length in ms for a hit; the killing blow holds longer. */
export function hitstopMs(final: boolean): number {
  return final ? FEEL.HITSTOP_FINAL_MS : FEEL.HITSTOP_MS;
}

/** Hit-stop in whole sim ticks (rounded up, at least 1). */
export function hitstopTicks(final: boolean, tickMs = 1000 / 60): number {
  return Math.max(1, Math.ceil(hitstopMs(final) / tickMs - 1e-9));
}

/** Kick left after t seconds, as a share of the start (1 at t = 0, falls toward 0). */
export function kickLeft(t: number): number {
  if (t <= 0) return 1;
  return Math.exp(-t / FEEL.KICK_TAU_S);
}

/** Per-frame decay factor for a frame of dt seconds (kick *= this). */
export function kickDecay(dt: number): number {
  return kickLeft(Math.max(0, dt));
}

/**
 * Kick offset for a hit: a push along the hit direction (dirX = hitter facing,
 * +1 or -1) and a little down. Scaled to 0 when the player asked for reduced motion.
 */
export function kickFor(dirX: number, reducedMotion: boolean): { x: number; y: number } {
  if (reducedMotion) return { x: 0, y: 0 };
  const s = dirX < 0 ? -1 : 1;
  return { x: FEEL.KICK * s, y: -FEEL.KICK * 0.5 };
}

/**
 * Time rate for the effects and figures after the duel ends. msSinceStop is
 * real time since the final hit-stop ended (negative or NaN: not started).
 * 0.3 for the first 600 ms, then 1.
 */
export function slowmoRate(msSinceStop: number): number {
  if (!(msSinceStop >= 0)) return 1;
  return msSinceStop < FEEL.SLOWMO_MS ? FEEL.SLOWMO_RATE : 1;
}

/**
 * Game time covered by a real frame of dtMs that starts msSinceStop after the
 * final hit-stop, splitting a frame that crosses the end of the slow motion.
 */
export function slowmoGameMs(msSinceStop: number, dtMs: number): number {
  if (dtMs <= 0) return 0;
  if (!(msSinceStop >= 0) || msSinceStop >= FEEL.SLOWMO_MS) return dtMs;
  const slowPart = Math.min(dtMs, FEEL.SLOWMO_MS - msSinceStop);
  return slowPart * FEEL.SLOWMO_RATE + (dtMs - slowPart);
}

/** Small deterministic random source, so spatter layouts are testable. */
export interface FeelRng {
  next(): number;
}

/**
 * Ink blots that stay on the paper for the duel: a fixed ring of SPATTER_CAP
 * slots, allocated once; add never allocates and past the cap replaces the
 * oldest blot. `version` changes on every add or clear so the renderer
 * uploads only then (one draw per frame, nothing else per frame).
 */
export class SpatterRing {
  readonly capacity: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly size: Float32Array;
  readonly angle: Float32Array;
  readonly stretch: Float32Array;
  readonly alpha: Float32Array;
  readonly seed: Float32Array;
  private cursor = 0;
  private n = 0;
  version = 0;

  constructor(capacity: number = FEEL.SPATTER_CAP) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.x = new Float32Array(this.capacity);
    this.y = new Float32Array(this.capacity);
    this.size = new Float32Array(this.capacity);
    this.angle = new Float32Array(this.capacity);
    this.stretch = new Float32Array(this.capacity);
    this.alpha = new Float32Array(this.capacity);
    this.seed = new Float32Array(this.capacity);
  }

  get count(): number {
    return this.n;
  }

  add(x: number, y: number, size: number, angle: number, stretch: number, alpha: number, seed: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.n < this.capacity) this.n++;
    this.x[i] = x;
    this.y[i] = y;
    this.size[i] = size;
    this.angle[i] = angle;
    this.stretch[i] = stretch;
    this.alpha[i] = alpha;
    this.seed[i] = seed;
    this.version++;
  }

  /**
   * The blots one hit leaves: SPATTER_PER_HIT of them from (x, y) out along
   * angle dir, the big ones near the cut, small far flecks thrown wider.
   */
  splash(x: number, y: number, dir: number, rng: FeelRng, per: number = FEEL.SPATTER_PER_HIT): void {
    for (let k = 0; k < per; k++) {
      const t = rng.next();
      const far = 0.25 + 2.2 * t * t;
      const a = dir + (rng.next() - 0.5) * (0.6 + 0.9 * t);
      const size = 0.05 + 0.2 * (1 - t) * (0.5 + 0.5 * rng.next());
      this.add(x + Math.cos(a) * far, y + Math.sin(a) * far, size, a, 1 + 1.6 * t, 0.55 + 0.35 * (1 - t), rng.next() * 100);
    }
  }

  clear(): void {
    if (this.n === 0) return;
    this.n = 0;
    this.cursor = 0;
    this.version++;
  }

  /** Pack blots into a column-major 4x4 per blot and (alpha, seed) pairs, like SprayPool.write. Returns the count. */
  write(matrices: Float32Array, attrs: Float32Array, z = 0): number {
    for (let i = 0; i < this.n; i++) {
      const ux = Math.cos(this.angle[i]);
      const uy = Math.sin(this.angle[i]);
      const s = this.size[i];
      const len = s * this.stretch[i];
      const k = i * 16;
      matrices[k] = ux * len; matrices[k + 1] = uy * len; matrices[k + 2] = 0; matrices[k + 3] = 0;
      matrices[k + 4] = -uy * s; matrices[k + 5] = ux * s; matrices[k + 6] = 0; matrices[k + 7] = 0;
      matrices[k + 8] = 0; matrices[k + 9] = 0; matrices[k + 10] = 1; matrices[k + 11] = 0;
      matrices[k + 12] = this.x[i]; matrices[k + 13] = this.y[i]; matrices[k + 14] = z; matrices[k + 15] = 1;
      attrs[i * 2] = this.alpha[i];
      attrs[i * 2 + 1] = this.seed[i];
    }
    return this.n;
  }
}

/** Brush pressure from stroke speed: slow ink is full width, a fast flick lifts the brush. */
export const BRUSH = {
  /** At or below this speed (screen px per ms) the brush is pressed fully. */
  SLOW_PX_MS: 0.4,
  /** At or above this speed the brush is lifted to MIN_PRESSURE. */
  FAST_PX_MS: 3,
  MIN_PRESSURE: 0.5,
} as const;

/** Width share 0.5..1 for a local stroke speed in px per ms; bad input counts as slow. */
export function brushPressure(pxPerMs: number): number {
  if (!(pxPerMs > BRUSH.SLOW_PX_MS)) return 1;
  if (pxPerMs >= BRUSH.FAST_PX_MS) return BRUSH.MIN_PRESSURE;
  const u = (pxPerMs - BRUSH.SLOW_PX_MS) / (BRUSH.FAST_PX_MS - BRUSH.SLOW_PX_MS);
  // Smooth step, so the edge never kinks.
  const s = u * u * (3 - 2 * u);
  return 1 - (1 - BRUSH.MIN_PRESSURE) * s;
}
