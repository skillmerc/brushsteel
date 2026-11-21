// Pure maths for the ink look: quality presets, mist parallax and
// the ink spray particle pool. No DOM, no Three.js, so node --test can run it.
// The GPU side lives in render/inkpass.ts, render/mist.ts and render/spray.ts.

import type { Rng } from './rng.js';

export type InkQuality = 'low' | 'medium' | 'high';

export interface InkPreset {
  /** Scale of the offscreen scene and ink targets against the canvas (0.5 = half-res). */
  scale: number;
  /** Texture taps around each pixel for ink bleed and edge darkening. */
  bleedTaps: number;
  /** Bleed radius in canvas pixels at 1080 p (scaled with the canvas height). */
  bleedPx: number;
  /** Visible mist layers (2 to 4). */
  mistLayers: number;
  /** Spray particles alive at once (the pool itself is always SPRAY_CAPACITY). */
  sprayLimit: number;
  /** Strength of the screen-space paper grain laid over everything (0 to 1). */
  grain: number;
}

export const INK_PRESETS: Readonly<Record<InkQuality, Readonly<InkPreset>>> = {
  low: { scale: 0.5, bleedTaps: 4, bleedPx: 3, mistLayers: 2, sprayLimit: 600, grain: 0.07 },
  medium: { scale: 0.75, bleedTaps: 6, bleedPx: 3.5, mistLayers: 3, sprayLimit: 1200, grain: 0.08 },
  high: { scale: 1, bleedTaps: 8, bleedPx: 4, mistLayers: 4, sprayLimit: 2000, grain: 0.09 },
};

export const INK_QUALITIES = Object.keys(INK_PRESETS) as InkQuality[];

/** Quality from a query string (`?quality=low`), else the fallback. */
export function parseQuality(search: string, fallback: InkQuality = 'medium'): InkQuality {
  const m = /[?&]quality=(low|medium|high)(?:&|$)/.exec(search);
  return m ? (m[1] as InkQuality) : fallback;
}

/** Offscreen target size for a canvas size and preset, at least 1 x 1. */
export function targetSize(width: number, height: number, quality: InkQuality): { width: number; height: number } {
  const s = INK_PRESETS[quality].scale;
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

// ---------------------------------------------------------------- mist

export interface MistLayer {
  /** Parallax factor: 0 = pinned to the far scroll, 1 = moves with the stage. */
  parallax: number;
  /** Slow drift, stage units per second (wind). */
  drift: number;
  /** Centre height of the band, stage units. */
  y: number;
  /** Band height, stage units. */
  height: number;
  /** Peak opacity of the grey wash. */
  alpha: number;
  /** Noise scale along x (bigger = finer wisps). */
  scale: number;
}

// Far to near. Far layers are paler, higher and slower; all sit behind the figures.
export const MIST_LAYERS: readonly MistLayer[] = [
  { parallax: 0.15, drift: 0.05, y: 0.9, height: 2.6, alpha: 0.16, scale: 0.35 },
  { parallax: 0.35, drift: 0.09, y: 0.0, height: 2.4, alpha: 0.2, scale: 0.5 },
  { parallax: 0.6, drift: 0.14, y: -0.9, height: 2.0, alpha: 0.22, scale: 0.7 },
  { parallax: 0.85, drift: 0.2, y: -1.7, height: 1.4, alpha: 0.26, scale: 0.95 },
];

/** Layers shown for a preset: the far ones always, near ones added with quality. */
export function mistLayersFor(quality: InkQuality): number {
  return Math.min(MIST_LAYERS.length, Math.max(2, INK_PRESETS[quality].mistLayers));
}

/**
 * Noise offset (stage units) for layer i: the band slides by parallax * cameraX
 * plus its wind drift. The mesh itself follows the camera, so this is the only
 * thing that moves the wisps.
 */
export function mistOffset(i: number, cameraX: number, timeS: number): number {
  const l = MIST_LAYERS[i];
  return cameraX * l.parallax + timeS * l.drift;
}

// ---------------------------------------------------------------- spray

export const SPRAY_CAPACITY = 2000;

export const SPRAY_PHYSICS = {
  /** Spread either side of the emit direction, radians. */
  spread: 0.65,
  speedMin: 2.0,
  speedMax: 7.5,
  gravity: -9.0,
  /** Velocity kept per second (exponential drag). */
  dragPerS: 0.18,
  lifeMin: 0.35,
  lifeMax: 0.95,
  sizeMin: 0.025,
  sizeMax: 0.11,
  /** Share of the life over which a drop fades out at the end. */
  fadeShare: 0.45,
};

/** Opacity of a drop of the given age and life: full, then a linear fade over the last fadeShare. */
export function sprayAlpha(age: number, life: number): number {
  if (life <= 0 || age >= life) return 0;
  const left = (life - age) / life;
  const f = SPRAY_PHYSICS.fadeShare;
  return left >= f ? 1 : Math.max(0, left / f);
}

/**
 * Fixed pool of ink drops. All storage is allocated once in the constructor;
 * emit, step and write never allocate. When the active limit is full, emit
 * recycles the oldest emitted slot (a ring), so the pool never grows.
 */
export class SprayPool {
  readonly capacity: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly age: Float32Array;
  readonly life: Float32Array;
  readonly size: Float32Array;
  readonly seed: Float32Array;
  private limitN: number;
  private cursor = 0;
  private liveN = 0;
  private readonly rng: Rng;

  constructor(rng: Rng, capacity = SPRAY_CAPACITY, limit = capacity) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.x = new Float32Array(this.capacity);
    this.y = new Float32Array(this.capacity);
    this.vx = new Float32Array(this.capacity);
    this.vy = new Float32Array(this.capacity);
    this.age = new Float32Array(this.capacity);
    this.life = new Float32Array(this.capacity); // 0 = dead slot
    this.size = new Float32Array(this.capacity);
    this.seed = new Float32Array(this.capacity);
    this.rng = rng;
    this.limitN = this.clampLimit(limit);
  }

  private clampLimit(n: number): number {
    return Math.max(1, Math.min(this.capacity, Math.floor(n)));
  }

  /** Active ceiling (from the preset). Lowering it kills drops beyond the new limit. */
  setLimit(n: number): void {
    const next = this.clampLimit(n);
    for (let i = next; i < this.limitN; i++) this.life[i] = 0;
    // Raised: fill the newly opened (empty) slots first.
    if (next > this.limitN) this.cursor = this.limitN;
    this.limitN = next;
    if (this.cursor >= next) this.cursor = 0;
    this.countLive();
  }

  get limit(): number {
    return this.limitN;
  }

  /** Drops alive after the last emit or step. */
  get live(): number {
    return this.liveN;
  }

  /** Spray `count` drops from (x, y) toward angle `dir` (radians, 0 = +x). */
  emit(x: number, y: number, dir: number, count: number): void {
    const P = SPRAY_PHYSICS;
    const r = this.rng;
    const n = Math.max(0, Math.floor(count));
    for (let k = 0; k < n; k++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.limitN;
      if (this.life[i] <= 0) this.liveN++;
      // Bigger drops fly slower; a few fine drops go wide.
      const t = r.next();
      const a = dir + (r.next() - 0.5) * 2 * P.spread * (0.4 + 0.6 * r.next());
      const speed = P.speedMin + (P.speedMax - P.speedMin) * (1 - t) * (0.6 + 0.4 * r.next());
      this.x[i] = x;
      this.y[i] = y;
      this.vx[i] = Math.cos(a) * speed;
      this.vy[i] = Math.sin(a) * speed;
      this.age[i] = 0;
      this.life[i] = P.lifeMin + (P.lifeMax - P.lifeMin) * r.next();
      this.size[i] = P.sizeMin + (P.sizeMax - P.sizeMin) * t * t;
      this.seed[i] = r.next() * 100;
    }
  }

  /** Advance every drop by dt seconds. */
  step(dt: number): void {
    if (dt <= 0) return;
    const P = SPRAY_PHYSICS;
    const drag = Math.pow(P.dragPerS, dt);
    let live = 0;
    for (let i = 0; i < this.limitN; i++) {
      if (this.life[i] <= 0) continue;
      const age = this.age[i] + dt;
      if (age >= this.life[i]) {
        this.life[i] = 0;
        continue;
      }
      this.age[i] = age;
      this.vx[i] *= drag;
      this.vy[i] = this.vy[i] * drag + P.gravity * dt;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      live++;
    }
    this.liveN = live;
  }

  private countLive(): void {
    let live = 0;
    for (let i = 0; i < this.limitN; i++) if (this.life[i] > 0) live++;
    this.liveN = live;
  }

  /**
   * Pack live drops into instance data: a column-major 4x4 per drop (stretched
   * along its velocity) into `matrices` and (alpha, seed) pairs into `attrs`.
   * Returns the number written; the arrays must hold capacity entries.
   */
  write(matrices: Float32Array, attrs: Float32Array, z = 0): number {
    let n = 0;
    for (let i = 0; i < this.limitN; i++) {
      const life = this.life[i];
      if (life <= 0) continue;
      const vx = this.vx[i];
      const vy = this.vy[i];
      const sp = Math.hypot(vx, vy);
      const ux = sp > 1e-5 ? vx / sp : 1;
      const uy = sp > 1e-5 ? vy / sp : 0;
      const s = this.size[i];
      const len = s * (1 + Math.min(2.5, sp * 0.18));
      const k = n * 16;
      matrices[k] = ux * len; matrices[k + 1] = uy * len; matrices[k + 2] = 0; matrices[k + 3] = 0;
      matrices[k + 4] = -uy * s; matrices[k + 5] = ux * s; matrices[k + 6] = 0; matrices[k + 7] = 0;
      matrices[k + 8] = 0; matrices[k + 9] = 0; matrices[k + 10] = 1; matrices[k + 11] = 0;
      matrices[k + 12] = this.x[i]; matrices[k + 13] = this.y[i]; matrices[k + 14] = z; matrices[k + 15] = 1;
      attrs[n * 2] = sprayAlpha(this.age[i], life);
      attrs[n * 2 + 1] = this.seed[i];
      n++;
    }
    return n;
  }
}
