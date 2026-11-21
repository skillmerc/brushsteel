// BRUSHSTEEL stroke classifier. Pure TypeScript, no DOM, no Three.js.
//
// API (used by the duel rules and the core loop):
//
//   classifyStroke(points, { foeSide, scale? }) -> StrokeResult
//
//   points   One mouse stroke from pointer down to pointer up, in screen
//            pixels (x right, y DOWN, like DOM mouse events) with a time
//            stamp t in milliseconds. Points with a non-finite x, y or t are dropped.
//   foeSide  'left' or 'right': where the opponent stands on screen. A
//            thrust is a dot or a short fast flick toward this side.
//   scale    Multiplies every pixel threshold below. Tuned at 1 for a
//            1280x720 play area; pass playAreaHeight / 720 for others.
//
//   StrokeResult:
//     kind        'cut' | 'overhead' | 'rising' | 'thrust' | 'parry' | 'none'
//     direction   cut: 'left' | 'right'; overhead: 'down' | 'down-left' |
//                 'down-right'; rising: 'up' | 'up-left' | 'up-right';
//                 thrust: 'left' | 'right' (always toward the foe);
//                 parry: 'cw' | 'ccw' (as seen on screen); none: 'none'
//     towardFoe   true when the stroke moves toward foeSide (thrust always)
//     speed       path length / duration, screen px per ms (divide by scale for 1280x720 units)
//                 Duration is floored at 16 ms (one frame) for speed.
//     length      path length in px (the ink drawn)
//     duration    ms from first to last point (0 for a single point)
//     start, end  first and last point {x, y}
//     confidence  0..1, how well the stroke fits the returned kind (for
//                 'none', how far it was from every real stroke)
//     reason      only for 'none': 'empty' | 'too-short' | 'hold' |
//                 'scribble' | 'ambiguous'
//
// The six kinds:
//   cut       a long, roughly horizontal slash, either way.
//   overhead  a long downward slash (straight down or a down diagonal).
//   rising    a long upward slash (up diagonal, or straight up).
//   thrust    a dot (press and release without moving, under DOT_MAX_MS) or
//             a short, fast, straight flick toward the foe.
//   parry     a closed circle (or ellipse), either way round.
//   none      scribbles, tiny moves, slow short moves, long still holds, and
//             strokes that sit on the border between two kinds.
//
// How it works: a $1-unistroke-style matcher (Wobbrock, Wilson and Li 2007,
// written fresh here). The stroke is resampled to N points, moved so its
// centroid is the origin and scaled uniformly (aspect kept, so a line stays
// a line). Straight strokes are matched against eight line templates with NO
// rotation, because direction is the point. Circles are matched with
// rotation (indicative angle plus a golden-section search), because a parry
// may start anywhere. Simple features (straightness, sweep, closure,
// length, speed) gate each kind and send everything else to 'none'.

export type StrokeKind = 'cut' | 'overhead' | 'rising' | 'thrust' | 'parry' | 'none';
export type FoeSide = 'left' | 'right';
export type StrokeDirection =
  | 'left' | 'right' | 'up' | 'down'
  | 'up-left' | 'up-right' | 'down-left' | 'down-right'
  | 'cw' | 'ccw' | 'none';
export type NoneReason = 'empty' | 'too-short' | 'hold' | 'scribble' | 'ambiguous';

export interface StrokePoint {
  x: number;
  y: number;
  /** Time stamp in ms (any origin, increasing). */
  t: number;
}

export interface Point2 {
  x: number;
  y: number;
}

export interface ClassifyOptions {
  foeSide: FoeSide;
  /** Multiplies the pixel thresholds. Default 1 (1280x720 play area). */
  scale?: number;
}

export interface StrokeResult {
  kind: StrokeKind;
  direction: StrokeDirection;
  towardFoe: boolean;
  speed: number;
  length: number;
  duration: number;
  start: Point2;
  end: Point2;
  confidence: number;
  reason?: NoneReason;
}

export const STROKE_KINDS: readonly StrokeKind[] = ['cut', 'overhead', 'rising', 'thrust', 'parry', 'none'];

/** Thresholds, in px at scale 1, ms, px/ms, or 0..1 scores. */
export const STROKE_TUNING = {
  /** A stroke whose bounding box fits in this many px is a dot. */
  DOT_MAX_PX: 8,
  /** A dot held longer than this is a hold, not a thrust. */
  DOT_MAX_MS: 350,
  /** Bounding boxes smaller than this (and bigger than a dot) are 'none'. */
  MIN_SIZE_PX: 30,
  /** Cut, overhead and rising need at least this much ink. */
  SLASH_MIN_PX: 90,
  /** A flick (short straight stroke) must be at least this fast. */
  FLICK_MIN_SPEED: 0.8,
  /** A flick must aim within this many degrees of straight at the foe. */
  FLICK_MAX_ANGLE: 35,
  /** Chord / path length for any straight stroke. */
  MIN_STRAIGHTNESS: 0.8,
  /** Best template score needed to return a real kind. */
  MIN_SCORE: 0.8,
  /** Line strokes closer than this to a second kind's score are ambiguous. */
  MIN_MARGIN: 0.03,
  /** A parry must sweep at least this many degrees around its centre. */
  PARRY_MIN_TURN: 270,
  /** Gap between start and end, over the circle size, at most this. */
  PARRY_MAX_GAP: 0.4,
} as const;

const N = 64;
const HALF_DIAGONAL = 0.5 * Math.SQRT2;
const DEG = Math.PI / 180;

// ---- geometry helpers -------------------------------------------------

const dist = (a: Point2, b: Point2): number => Math.hypot(a.x - b.x, a.y - b.y);

function pathLength(p: readonly Point2[]): number {
  let d = 0;
  for (let i = 1; i < p.length; i++) d += dist(p[i - 1], p[i]);
  return d;
}

function resample(p: readonly Point2[], n: number): Point2[] {
  const interval = pathLength(p) / (n - 1);
  const out: Point2[] = [{ x: p[0].x, y: p[0].y }];
  if (interval === 0) {
    while (out.length < n) out.push({ x: p[0].x, y: p[0].y });
    return out;
  }
  let acc = 0;
  let prev: Point2 = { x: p[0].x, y: p[0].y };
  for (let i = 1; i < p.length; i++) {
    let cur = p[i];
    let d = dist(prev, cur);
    while (acc + d >= interval && out.length < n) {
      const k = (interval - acc) / d;
      const q = { x: prev.x + k * (cur.x - prev.x), y: prev.y + k * (cur.y - prev.y) };
      out.push(q);
      prev = q;
      d = dist(prev, cur);
      acc = 0;
    }
    acc += d;
    prev = { x: cur.x, y: cur.y };
  }
  const last = p[p.length - 1];
  while (out.length < n) out.push({ x: last.x, y: last.y });
  return out;
}

function centroid(p: readonly Point2[]): Point2 {
  let x = 0;
  let y = 0;
  for (const q of p) {
    x += q.x;
    y += q.y;
  }
  return { x: x / p.length, y: y / p.length };
}

function bounds(p: readonly Point2[]): { w: number; h: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const q of p) {
    if (q.x < minX) minX = q.x;
    if (q.x > maxX) maxX = q.x;
    if (q.y < minY) minY = q.y;
    if (q.y > maxY) maxY = q.y;
  }
  return { w: maxX - minX, h: maxY - minY };
}

function rotate(p: readonly Point2[], angle: number): Point2[] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return p.map((q) => ({ x: q.x * c - q.y * s, y: q.x * s + q.y * c }));
}

/** Resample, centre on the centroid, scale uniformly so the box's long side is 1. */
function normalise(p: readonly Point2[]): Point2[] {
  const r = resample(p, N);
  const c = centroid(r);
  const b = bounds(r);
  const size = Math.max(b.w, b.h) || 1;
  return r.map((q) => ({ x: (q.x - c.x) / size, y: (q.y - c.y) / size }));
}

/** Resample and centre, then scale so the path length is 1 (for line matching: every angle gets the same size). */
function normaliseByLength(p: readonly Point2[]): Point2[] {
  const r = resample(p, N);
  const c = centroid(r);
  const len = pathLength(r) || 1;
  return r.map((q) => ({ x: (q.x - c.x) / len, y: (q.y - c.y) / len }));
}

function pathDistance(a: readonly Point2[], b: readonly Point2[]): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += dist(a[i], b[i]);
  return d / a.length;
}

/** Turn so the centroid-to-first-point angle is 0 (the $1 indicative angle). */
function rotateToZero(p: readonly Point2[]): Point2[] {
  return rotate(p, -Math.atan2(p[0].y, p[0].x));
}

/** Smallest distance over rotations in [-range, range] (golden-section search). */
function distanceAtBestAngle(cand: readonly Point2[], tmpl: readonly Point2[], range: number): number {
  const phi = 0.5 * (Math.sqrt(5) - 1);
  let a = -range;
  let b = range;
  let x1 = phi * a + (1 - phi) * b;
  let x2 = (1 - phi) * a + phi * b;
  let f1 = pathDistance(rotate(cand, x1), tmpl);
  let f2 = pathDistance(rotate(cand, x2), tmpl);
  while (Math.abs(b - a) > 2 * DEG) {
    if (f1 < f2) {
      b = x2;
      x2 = x1;
      f2 = f1;
      x1 = phi * a + (1 - phi) * b;
      f1 = pathDistance(rotate(cand, x1), tmpl);
    } else {
      a = x1;
      x1 = x2;
      f1 = f2;
      x2 = (1 - phi) * a + phi * b;
      f2 = pathDistance(rotate(cand, x2), tmpl);
    }
  }
  return Math.min(f1, f2);
}

const scoreOf = (d: number): number => Math.max(0, 1 - d / HALF_DIAGONAL);

/** Points up to where the sweep around the origin first reaches one full turn. */
function firstTurn(p: readonly Point2[]): Point2[] {
  let sum = 0;
  for (let i = 1; i < p.length; i++) {
    let d = Math.atan2(p[i].y, p[i].x) - Math.atan2(p[i - 1].y, p[i - 1].x);
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    sum += d;
    if (Math.abs(sum) >= 2 * Math.PI) return p.slice(0, i + 1);
  }
  return p.slice();
}

/**
 * Signed sweep around the origin (the centroid after normalise), in degrees.
 * Positive is clockwise on screen. Far steadier than summing the turn at
 * each point, which mouse jitter on slow strokes throws off.
 */
function sweepAroundCentroid(p: readonly Point2[]): number {
  let sum = 0;
  for (let i = 1; i < p.length; i++) {
    let d = Math.atan2(p[i].y, p[i].x) - Math.atan2(p[i - 1].y, p[i - 1].x);
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    sum += d;
  }
  return sum / DEG;
}

// ---- templates --------------------------------------------------------

interface LineTemplate {
  /** Angle in degrees, maths style: 0 right, 90 up on screen. */
  angle: number;
  kind: 'cut' | 'overhead' | 'rising';
  points: Point2[];
}

function lineKind(angle: number): 'cut' | 'overhead' | 'rising' {
  if (angle === 0 || angle === 180) return 'cut';
  return angle > 0 && angle < 180 ? 'rising' : 'overhead';
}

const LINE_TEMPLATES: LineTemplate[] = [0, 45, 90, 135, 180, -135, -90, -45].map((angle) => {
  const dx = Math.cos(angle * DEG);
  const dy = -Math.sin(angle * DEG); // screen y is down
  return {
    angle,
    kind: lineKind(angle),
    points: normaliseByLength([{ x: 0, y: 0 }, { x: 100 * dx, y: 100 * dy }]),
  };
});

function circleTemplate(sign: 1 | -1): Point2[] {
  const raw: Point2[] = [];
  for (let i = 0; i <= 128; i++) {
    const a = (sign * i * 2 * Math.PI) / 128;
    raw.push({ x: 100 * Math.cos(a), y: 100 * Math.sin(a) });
  }
  return rotateToZero(normalise(raw));
}

// sign +1 runs clockwise on screen (y down), -1 counter-clockwise.
const CIRCLE_CW = circleTemplate(1);
const CIRCLE_CCW = circleTemplate(-1);

// ---- classifier -------------------------------------------------------

function sector(angle: number): StrokeDirection {
  const names: StrokeDirection[] = ['right', 'up-right', 'up', 'up-left', 'left', 'down-left', 'down', 'down-right'];
  const i = Math.round((((angle % 360) + 360) % 360) / 45) % 8;
  return names[i];
}

export function classifyStroke(rawPoints: readonly StrokePoint[], options: ClassifyOptions): StrokeResult {
  const points = rawPoints.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.t));
  const T = STROKE_TUNING;
  const scale = options.scale && options.scale > 0 ? options.scale : 1;
  const foeSign = options.foeSide === 'right' ? 1 : -1;
  const foeDir: StrokeDirection = options.foeSide;

  if (points.length === 0) {
    const o = { x: 0, y: 0 };
    return { kind: 'none', direction: 'none', towardFoe: false, speed: 0, length: 0, duration: 0, start: o, end: { ...o }, confidence: 1, reason: 'empty' };
  }

  const first = points[0];
  const last = points[points.length - 1];
  const start = { x: first.x, y: first.y };
  const end = { x: last.x, y: last.y };
  const length = pathLength(points);
  const duration = Math.max(0, last.t - first.t);
  const speed = length / Math.max(16, duration);
  const base = { speed, length, duration, start, end };
  const none = (reason: NoneReason, confidence: number): StrokeResult => ({
    kind: 'none', direction: 'none', towardFoe: false, ...base, confidence: clamp01(confidence), reason,
  });

  const box = bounds(points);
  const size = Math.max(box.w, box.h);

  // Dot: a press with (almost) no movement.
  if (size <= T.DOT_MAX_PX * scale) {
    if (duration > T.DOT_MAX_MS) return none('hold', 0.9);
    return { kind: 'thrust', direction: foeDir, towardFoe: true, ...base, confidence: clamp01(1 - (0.3 * size) / (T.DOT_MAX_PX * scale)) };
  }
  if (size < T.MIN_SIZE_PX * scale) return none('too-short', 0.9);

  const chord = dist(start, end);
  const straightness = chord / Math.max(length, 1e-9);
  const angle = Math.atan2(-(end.y - start.y), end.x - start.x) / DEG; // maths style, up positive
  const towardFoe = (end.x - start.x) * foeSign > 0;

  const cand = normalise(points);

  // Parry: closed loop, matched with rotation.
  const turning = sweepAroundCentroid(cand);
  const gap = chord / size;
  let parryScore = 0;
  if (Math.abs(turning) >= T.PARRY_MIN_TURN && (Math.abs(turning) >= 360 || gap <= T.PARRY_MAX_GAP)) {
    const c0 = rotateToZero(normalise(firstTurn(cand)));
    const range = 45 * DEG;
    parryScore = scoreOf(Math.min(distanceAtBestAngle(c0, CIRCLE_CW, range), distanceAtBestAngle(c0, CIRCLE_CCW, range)));
  }

  // Lines: matched with no rotation, best template per kind.
  const best: Record<'cut' | 'overhead' | 'rising', number> = { cut: 0, overhead: 0, rising: 0 };
  let lineBest = 0;
  let lineTemplate = LINE_TEMPLATES[0];
  const candLine = normaliseByLength(points);
  for (const tpl of LINE_TEMPLATES) {
    const s = scoreOf(pathDistance(candLine, tpl.points));
    if (s > best[tpl.kind]) best[tpl.kind] = s;
    if (s > lineBest) {
      lineBest = s;
      lineTemplate = tpl;
    }
  }
  const lineOk = straightness >= T.MIN_STRAIGHTNESS;

  if (parryScore >= T.MIN_SCORE && (!lineOk || parryScore > lineBest)) {
    return { kind: 'parry', direction: turning > 0 ? 'cw' : 'ccw', towardFoe: false, ...base, confidence: parryScore };
  }
  if (!lineOk) return none('scribble', 1 - Math.max(parryScore, lineBest * straightness));

  // Short straight stroke: a flick toward the foe, or nothing.
  if (length < T.SLASH_MIN_PX * scale) {
    const offFoe = options.foeSide === 'right' ? Math.abs(angle) : 180 - Math.abs(angle);
    if (towardFoe && offFoe <= T.FLICK_MAX_ANGLE && speed >= T.FLICK_MIN_SPEED * scale) {
      return { kind: 'thrust', direction: foeDir, towardFoe: true, ...base, confidence: clamp01(straightness * (1 - (0.3 * offFoe) / T.FLICK_MAX_ANGLE)) };
    }
    return none('too-short', 0.8);
  }

  if (lineBest < T.MIN_SCORE) return none('scribble', 1 - lineBest);
  const kind = lineTemplate.kind;
  const runnerUp = Math.max(...(Object.keys(best) as (keyof typeof best)[]).filter((k) => k !== kind).map((k) => best[k]));
  if (lineBest - runnerUp < T.MIN_MARGIN) return none('ambiguous', 0.5);

  let direction = sector(angle);
  if (kind === 'cut') direction = Math.abs(angle) <= 90 ? 'right' : 'left';
  else if (kind === 'rising' && !direction.startsWith('up')) direction = angle < 90 ? 'up-right' : 'up-left';
  else if (kind === 'overhead' && !direction.startsWith('down')) direction = angle > -90 ? 'down-right' : 'down-left';
  return { kind, direction, towardFoe, ...base, confidence: lineBest };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
