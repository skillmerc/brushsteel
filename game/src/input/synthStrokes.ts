// Seeded synthetic mouse strokes for the classifier tests (and later for
// scripted duels in CI). Pure TypeScript, no DOM. Same seed, same strokes.
//
// Each stroke is drawn the way a hand moves a mouse: samples every 7 to 17
// ms, a bell-shaped speed curve (slow start, fast middle, slow end), a bow
// in the line, a slow wobble and per-sample jitter of about 1.5 px. The
// play area is 1280x720 (classifier scale 1).

import type { Rng } from '../core/rng.js';
import type { FoeSide, Point2, StrokePoint } from './strokes.js';

export type SynthKind = 'cut' | 'overhead' | 'rising' | 'thrust' | 'parry' | 'scribble' | 'tiny';

const DEG = Math.PI / 180;

/** Roughly normal noise (sum of three uniforms), mean 0, sd about sigma. */
function noise(rng: Rng, sigma: number): number {
  return (rng.next() + rng.next() + rng.next() - 1.5) * 2 * sigma;
}

/**
 * Sample a path pos(u), u in [0, 1], as a timed stroke. lengthPx is the rough
 * path length, speed the mean speed in px/ms.
 */
function timed(rng: Rng, pos: (u: number) => Point2, lengthPx: number, speed: number, jitter: number): StrokePoint[] {
  const duration = Math.max(20, lengthPx / speed);
  const ease = rng.range(0.4, 1); // how bell-shaped the speed curve is
  const out: StrokePoint[] = [];
  let t = 0;
  const t0 = rng.range(1000, 5000);
  for (;;) {
    const s = Math.min(1, t / duration);
    const u = (1 - ease) * s + ease * (0.5 - 0.5 * Math.cos(Math.PI * s));
    const p = pos(u);
    out.push({ x: p.x + noise(rng, jitter), y: p.y + noise(rng, jitter), t: t0 + t });
    if (s >= 1) break;
    t += rng.range(7, 17);
  }
  return out;
}

function startPoint(rng: Rng): Point2 {
  return { x: rng.range(300, 980), y: rng.range(200, 520) };
}

/** A slightly bowed, wobbly straight slash at `angle` degrees (maths style, up positive). */
function slash(rng: Rng, angle: number, length: number, speed: number, hard = false): StrokePoint[] {
  const c = startPoint(rng);
  const dx = Math.cos(angle * DEG);
  const dy = -Math.sin(angle * DEG);
  const bowMax = hard ? 0.2 : 0.12;
  const bow = rng.range(-bowMax, bowMax) * length;
  const wobA = rng.range(0, 0.025) * length;
  const wobF = rng.range(1, 3);
  const wobP = rng.range(0, 2 * Math.PI);
  const sx = c.x - (dx * length) / 2;
  const sy = c.y - (dy * length) / 2;
  return timed(rng, (u) => {
    const off = bow * Math.sin(Math.PI * u) + wobA * Math.sin(2 * Math.PI * wobF * u + wobP);
    return { x: sx + dx * length * u - dy * off, y: sy + dy * length * u + dx * off };
  }, length, speed, hard ? 3 : 1.5);
}

function circle(rng: Rng): StrokePoint[] {
  const c = startPoint(rng);
  const r = rng.range(40, 125);
  const aspect = rng.range(0.7, 1);
  const tilt = rng.range(0, Math.PI);
  const a0 = rng.range(0, 2 * Math.PI);
  const cover = rng.range(330, 390) * DEG;
  const sign = rng.next() < 0.5 ? 1 : -1;
  const wobA = rng.range(0, 0.06);
  const wobP = rng.range(0, 2 * Math.PI);
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  return timed(rng, (u) => {
    const a = a0 + sign * cover * u;
    const rr = r * (1 + wobA * Math.sin(3 * a + wobP));
    const x = rr * Math.cos(a);
    const y = rr * aspect * Math.sin(a);
    return { x: c.x + x * ct - y * st, y: c.y + x * st + y * ct };
  }, r * cover, rng.range(0.4, 2), 1.5);
}

function dot(rng: Rng): StrokePoint[] {
  const c = startPoint(rng);
  const n = rng.int(1, 8);
  const out: StrokePoint[] = [];
  let t = rng.range(1000, 5000);
  for (let i = 0; i < n; i++) {
    out.push({ x: c.x + noise(rng, 1), y: c.y + noise(rng, 1), t });
    t += rng.range(7, 40);
  }
  return out;
}

/** Polyline through random waypoints, smoothed a little. */
function through(rng: Rng, way: Point2[], speed: number): StrokePoint[] {
  let total = 0;
  for (let i = 1; i < way.length; i++) total += Math.hypot(way[i].x - way[i - 1].x, way[i].y - way[i - 1].y);
  const segs = way.length - 1;
  return timed(rng, (u) => {
    const f = Math.min(segs - 1e-9, u * segs);
    const i = Math.floor(f);
    const k = f - i;
    const s = k * k * (3 - 2 * k) * 0.5 + k * 0.5; // soften the corners
    return { x: way[i].x + (way[i + 1].x - way[i].x) * s, y: way[i].y + (way[i + 1].y - way[i].y) * s };
  }, total, speed, 1.5);
}

function scribble(rng: Rng, hard = false): StrokePoint[] {
  const c = startPoint(rng);
  const box = rng.range(80, 300);
  const style = rng.next();
  const way: Point2[] = [];
  if (style < 0.55) {
    // Random waypoints (hard: only 3, so some are bent lines or a V).
    const n = hard ? 3 : rng.int(4, 8);
    for (let i = 0; i < n; i++) way.push({ x: c.x + rng.range(-box, box) / 2, y: c.y + rng.range(-box, box) / 2 });
  } else if (style < 0.8) {
    // Zigzag: back and forth while drifting.
    const n = rng.int(4, 8);
    const across = rng.range(0, Math.PI);
    const drift = across + Math.PI / 2;
    for (let i = 0; i < n; i++) {
      const side = (i % 2 === 0 ? -0.5 : 0.5) * box;
      const along = ((i / (n - 1)) - 0.5) * box * rng.range(0.3, 0.8);
      way.push({
        x: c.x + side * Math.cos(across) + along * Math.cos(drift) + noise(rng, box * 0.05),
        y: c.y + side * Math.sin(across) + along * Math.sin(drift) + noise(rng, box * 0.05),
      });
    }
  } else {
    // Loopy squiggle: small loops travelling along a line ("eeee").
    const loops = rng.int(2, 5);
    const r = box * rng.range(0.1, 0.2);
    const dir = rng.range(0, 2 * Math.PI);
    const steps = loops * 12;
    for (let i = 0; i <= steps; i++) {
      const a = (i / 12) * 2 * Math.PI;
      const along = (i / steps - 0.5) * box;
      way.push({
        x: c.x + along * Math.cos(dir) + r * Math.cos(a),
        y: c.y + along * Math.sin(dir) + r * Math.sin(a),
      });
    }
  }
  return through(rng, way, rng.range(0.4, 2.5));
}

function tiny(rng: Rng): StrokePoint[] {
  const c = startPoint(rng);
  const box = rng.range(12, 26);
  const n = rng.int(2, 6);
  const way: Point2[] = [];
  // The first two waypoints sit at opposite corners, so the move spans at
  // least 12 px (smaller than DOT_MAX_PX it would be a dot).
  way.push({ x: c.x - box / 2, y: c.y - box / 2 }, { x: c.x + box / 2, y: c.y + rng.range(-box, box) / 2 });
  for (let i = 2; i < n; i++) way.push({ x: c.x + rng.range(-box, box) / 2, y: c.y + rng.range(-box, box) / 2 });
  return through(rng, way, rng.range(0.1, 1.5));
}

/**
 * One synthetic stroke of the given kind. For 'thrust', `variant` picks a dot
 * or a flick (default: a coin toss). foeSide matters for thrusts only.
 * `hard` is a stress set: slashes reach to within 5 degrees of the borders
 * between kinds (cut 0-20, rising 25-85, overhead 25-155 below horizontal),
 * bow up to 20 percent, twice the jitter, and random scribbles with only
 * three waypoints.
 */
export function synthStroke(rng: Rng, kind: SynthKind, foeSide: FoeSide, variant?: 'dot' | 'flick', hard = false): StrokePoint[] {
  const either = (a: number): number => (rng.next() < 0.5 ? a : 180 - a);
  switch (kind) {
    case 'cut':
      return slash(rng, either(hard ? rng.range(-20, 20) : rng.range(-15, 15)), rng.range(120, 420), rng.range(0.5, 3), hard);
    case 'overhead':
      return slash(rng, hard ? rng.range(-155, -25) : rng.range(-130, -50), rng.range(100, 350), rng.range(0.5, 3), hard);
    case 'rising':
      return slash(rng, either(hard ? rng.range(25, 85) : rng.range(30, 75)), rng.range(100, 350), rng.range(0.5, 3), hard);
    case 'thrust': {
      const v = variant ?? (rng.next() < 0.5 ? 'dot' : 'flick');
      if (v === 'dot') return dot(rng);
      const a = rng.range(-25, 25);
      return slash(rng, foeSide === 'right' ? a : 180 - a, rng.range(38, 80), rng.range(1.2, 3), hard);
    }
    case 'parry':
      return circle(rng);
    case 'scribble':
      return scribble(rng, hard);
    case 'tiny':
      return tiny(rng);
  }
}
