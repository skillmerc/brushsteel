import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRng, seedFromString } from '../core/rng.js';
import { classifyStroke, STROKE_KINDS, type FoeSide, type StrokeKind, type StrokePoint, type StrokeResult } from './strokes.js';
import { synthStroke } from './synthStrokes.js';

const PER_KIND = 200;

interface Sample {
  want: StrokeKind;
  label: string;
  foeSide: FoeSide;
  points: StrokePoint[];
}

/** The seeded test set: 200 noisy strokes per kind, foe side alternating. */
function buildSet(hard = false): Sample[] {
  const out: Sample[] = [];
  for (const want of STROKE_KINDS) {
    const rng = createRng(seedFromString(`brushsteel-strokes-${hard ? 'hard' : 'v1'}-${want}`));
    for (let i = 0; i < PER_KIND; i++) {
      const foeSide: FoeSide = i % 2 === 0 ? 'right' : 'left';
      if (want === 'none') {
        // 150 scribbles, 50 tiny moves.
        const label = i < 150 ? 'scribble' : 'tiny';
        out.push({ want, label, foeSide, points: synthStroke(rng, label, foeSide, undefined, hard) });
      } else if (want === 'thrust') {
        const label = i < 100 ? 'dot' : 'flick';
        out.push({ want, label, foeSide, points: synthStroke(rng, 'thrust', foeSide, label, hard) });
      } else {
        out.push({ want, label: want, foeSide, points: synthStroke(rng, want, foeSide, undefined, hard) });
      }
    }
  }
  return out;
}

const pad = (s: string | number, n: number): string => String(s).padStart(n);

function report(set: Sample[], title: string): { failed: string[]; falseRate: number } {
  const confusion = new Map<StrokeKind, Map<StrokeKind, number>>();
  for (const k of STROKE_KINDS) confusion.set(k, new Map(STROKE_KINDS.map((j) => [j, 0])));
  const byLabel = new Map<string, { n: number; ok: number }>();
  for (const s of set) {
    const got = classifyStroke(s.points, { foeSide: s.foeSide }).kind;
    const row = confusion.get(s.want)!;
    row.set(got, row.get(got)! + 1);
    const l = byLabel.get(s.label) ?? { n: 0, ok: 0 };
    l.n++;
    if (got === s.want) l.ok++;
    byLabel.set(s.label, l);
  }

  const lines: string[] = [];
  lines.push(title);
  lines.push(`${'kind'.padEnd(9)} ${pad('right', 5)} ${pad('of', 4)} ${pad('pct', 6)}`);
  const failed: string[] = [];
  for (const k of STROKE_KINDS) {
    const ok = confusion.get(k)!.get(k)!;
    const pct = (100 * ok) / PER_KIND;
    lines.push(`${k.padEnd(9)} ${pad(ok, 5)} ${pad(PER_KIND, 4)} ${pad(pct.toFixed(1), 6)}`);
    if (pct < 95) failed.push(`${k} ${pct.toFixed(1)}%`);
  }
  lines.push('Confusion counts (row = drawn, column = classified)');
  lines.push(`${''.padEnd(9)}${STROKE_KINDS.map((k) => pad(k, 9)).join('')}`);
  for (const k of STROKE_KINDS) {
    lines.push(`${k.padEnd(9)}${STROKE_KINDS.map((j) => pad(confusion.get(k)!.get(j)!, 9)).join('')}`);
  }
  lines.push('By sub-type: ' + [...byLabel].map(([label, v]) => `${label} ${v.ok}/${v.n}`).join(', '));
  const sc = byLabel.get('scribble')!;
  const falseRate = (100 * (sc.n - sc.ok)) / sc.n;
  lines.push(`Scribble false-stroke rate: ${sc.n - sc.ok} of ${sc.n} scribbles (${falseRate.toFixed(1)}%) came back as a real stroke`);
  console.log(lines.join('\n') + '\n');
  return { failed, falseRate };
}

test('accuracy: at least 95 percent per stroke kind on 200 seeded noisy strokes each', () => {
  const { failed, falseRate } = report(buildSet(), 'Stroke classifier accuracy, 200 seeded noisy strokes per kind (the done test)');
  assert.deepEqual(failed, [], `kinds under 95 percent: ${failed.join(', ')}`);
  assert.ok(falseRate <= 5, `scribble false-stroke rate ${falseRate.toFixed(1)}% is over 5%`);
});

test('stress set (report only, not gated): strokes near the borders, more bow and jitter, three-point scribbles', () => {
  // Strokes within 5 degrees of a border are expected to drop to 'none'
  // ('ambiguous') some of the time: that is the dead zone doing its job.
  const { failed } = report(buildSet(true), 'Stress set, 200 seeded strokes per kind (report only)');
  assert.ok(Array.isArray(failed));
});

test('the seeded set and its results are identical on a second run', () => {
  const key = (r: StrokeResult) => `${r.kind}|${r.direction}|${r.length.toFixed(6)}|${r.confidence.toFixed(6)}`;
  const a = buildSet().map((s) => key(classifyStroke(s.points, { foeSide: s.foeSide })));
  const b = buildSet().map((s) => key(classifyStroke(s.points, { foeSide: s.foeSide })));
  assert.equal(a.length, 6 * PER_KIND);
  assert.ok(a.every((v, i) => v === b[i]), 'second run differs');
});

/** A clean straight stroke from (x0,y0) to (x1,y1) over ms milliseconds. */
function line(x0: number, y0: number, x1: number, y1: number, ms: number, steps = 30): StrokePoint[] {
  const out: StrokePoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    out.push({ x: x0 + (x1 - x0) * u, y: y0 + (y1 - y0) * u, t: 100 + ms * u });
  }
  return out;
}

test('directions: cut either way, overhead down, rising up diagonal', () => {
  const r = classifyStroke(line(300, 400, 700, 400, 200), { foeSide: 'right' });
  assert.equal(r.kind, 'cut');
  assert.equal(r.direction, 'right');
  assert.equal(r.towardFoe, true);
  const l = classifyStroke(line(700, 400, 300, 400, 200), { foeSide: 'right' });
  assert.equal(l.kind, 'cut');
  assert.equal(l.direction, 'left');
  assert.equal(l.towardFoe, false);
  const d = classifyStroke(line(500, 150, 500, 500, 200), { foeSide: 'left' });
  assert.equal(d.kind, 'overhead');
  assert.equal(d.direction, 'down');
  const u = classifyStroke(line(300, 500, 550, 250, 200), { foeSide: 'left' });
  assert.equal(u.kind, 'rising');
  assert.equal(u.direction, 'up-right');
  const ul = classifyStroke(line(550, 500, 300, 250, 200), { foeSide: 'left' });
  assert.equal(ul.kind, 'rising');
  assert.equal(ul.direction, 'up-left');
  assert.equal(ul.towardFoe, true);
});

test('features: speed, length, duration, start and end', () => {
  const r = classifyStroke(line(100, 300, 500, 300, 250), { foeSide: 'left' });
  assert.ok(Math.abs(r.length - 400) < 1e-9);
  assert.equal(r.duration, 250);
  assert.ok(Math.abs(r.speed - 1.6) < 1e-9);
  assert.deepEqual(r.start, { x: 100, y: 300 });
  assert.deepEqual(r.end, { x: 500, y: 300 });
  assert.ok(r.confidence > 0.9 && r.confidence <= 1);
});

test('thrust goes toward the foe on either side', () => {
  const dotPts: StrokePoint[] = [{ x: 400, y: 300, t: 0 }, { x: 401, y: 301, t: 60 }];
  for (const foeSide of ['left', 'right'] as const) {
    const d = classifyStroke(dotPts, { foeSide });
    assert.equal(d.kind, 'thrust');
    assert.equal(d.direction, foeSide);
  }
  // A short fast flick right is a thrust only when the foe is on the right.
  const flick = line(400, 300, 460, 296, 30, 5);
  assert.equal(classifyStroke(flick, { foeSide: 'right' }).kind, 'thrust');
  assert.equal(classifyStroke(flick, { foeSide: 'left' }).kind, 'none');
  // The same flick drawn slowly is not a thrust.
  assert.equal(classifyStroke(line(400, 300, 460, 296, 400, 20), { foeSide: 'right' }).kind, 'none');
});

test('parry: circles either way round', () => {
  const circ = (sign: 1 | -1): StrokePoint[] =>
    Array.from({ length: 50 }, (_, i) => {
      const a = (sign * i * 2 * Math.PI) / 48;
      return { x: 600 + 80 * Math.cos(a), y: 360 + 80 * Math.sin(a), t: i * 12 };
    });
  const cw = classifyStroke(circ(1), { foeSide: 'right' });
  assert.equal(cw.kind, 'parry');
  assert.equal(cw.direction, 'cw');
  const ccw = classifyStroke(circ(-1), { foeSide: 'right' });
  assert.equal(ccw.kind, 'parry');
  assert.equal(ccw.direction, 'ccw');
});

test('none: empty, tiny, long hold, and a slash on the cut/rising border', () => {
  assert.equal(classifyStroke([], { foeSide: 'right' }).reason, 'empty');
  const tinyR = classifyStroke(line(400, 300, 415, 290, 100, 6), { foeSide: 'right' });
  assert.equal(tinyR.kind, 'none');
  assert.equal(tinyR.reason, 'too-short');
  const hold = classifyStroke([{ x: 400, y: 300, t: 0 }, { x: 401, y: 300, t: 900 }], { foeSide: 'right' });
  assert.equal(hold.kind, 'none');
  assert.equal(hold.reason, 'hold');
  // Exactly between cut (0 degrees) and rising (45 degrees).
  const a = 22.5 * (Math.PI / 180);
  const border = classifyStroke(line(300, 400, 300 + 300 * Math.cos(a), 400 - 300 * Math.sin(a), 200), { foeSide: 'right' });
  assert.equal(border.kind, 'none');
  assert.equal(border.reason, 'ambiguous');
});

test('scale multiplies the pixel thresholds', () => {
  // 20 px wide is a tiny move at scale 1, a dot at scale 3 (dot limit 24 px).
  const pts = line(400, 300, 420, 300, 50, 4);
  assert.equal(classifyStroke(pts, { foeSide: 'right' }).kind, 'none');
  assert.equal(classifyStroke(pts, { foeSide: 'right', scale: 3 }).kind, 'thrust');
});

test('held-out seed, any angle: a slash is its own kind or none, never another kind', () => {
  // Fresh seed the thresholds were never tuned on; angles uniform over the whole circle, so strokes cross every border.
  const rng = createRng(seedFromString('brushsteel-strokes-heldout-any-angle'));
  const truthOf = (deg: number): StrokeKind => (Math.abs(deg) <= 22.5 || Math.abs(deg) >= 157.5 ? 'cut' : deg > 0 ? 'rising' : 'overhead');
  const borderGap = (deg: number): number => Math.min(...[22.5, 157.5, -22.5, -157.5].map((b) => Math.abs(deg - b)));
  const total = 600;
  let wrong = 0;
  let far = 0;
  let farNone = 0;
  for (let i = 0; i < total; i++) {
    const foeSide: FoeSide = i % 2 === 0 ? 'right' : 'left';
    const base = synthStroke(rng, 'cut', foeSide);
    const turn = rng.range(-Math.PI, Math.PI);
    const c = base[0];
    const pts = base.map((p) => ({
      x: c.x + (p.x - c.x) * Math.cos(turn) - (p.y - c.y) * Math.sin(turn),
      y: c.y + (p.x - c.x) * Math.sin(turn) + (p.y - c.y) * Math.cos(turn),
      t: p.t,
    }));
    const s = pts[0];
    const e = pts[pts.length - 1];
    const deg = Math.atan2(-(e.y - s.y), e.x - s.x) * (180 / Math.PI);
    const got = classifyStroke(pts, { foeSide }).kind;
    if (got !== 'none' && got !== truthOf(deg)) wrong++;
    if (borderGap(deg) >= 8) {
      far++;
      if (got === 'none') farNone++;
    }
  }
  console.log(`Any-angle held-out: ${wrong} of ${total} read as another kind; none on ${farNone} of ${far} strokes 8+ degrees from a border\n`);
  assert.ok(wrong <= total * 0.01, `${wrong} slashes read as another real kind`);
  assert.ok(farNone <= far * 0.05, `${farNone} of ${far} clear slashes read as none`);
});

test('parry: overdrawn circles up to two turns and ovals down to 0.6', () => {
  const loop = (deg: number, aspect = 1): StrokePoint[] =>
    Array.from({ length: 60 }, (_, i) => {
      const a = ((deg * Math.PI) / 180) * (i / 59);
      return { x: 640 + 90 * Math.cos(a), y: 360 + 90 * aspect * Math.sin(a), t: i * 10 };
    });
  for (const deg of [340, 360, 400, 450, 540, 720]) assert.equal(classifyStroke(loop(deg), { foeSide: 'right' }).kind, 'parry', `${deg} degrees`);
  assert.equal(classifyStroke(loop(360, 0.6), { foeSide: 'left' }).kind, 'parry');
});

test('bad input never gives NaN or Infinity, and flick speed scales with the screen', () => {
  const bad: StrokePoint[][] = [
    [{ x: 300, y: 400, t: 0 }, { x: NaN, y: 400, t: 50 }, { x: 700, y: 400, t: 100 }],
    [{ x: 300, y: 400, t: NaN }, { x: 700, y: 400, t: NaN }],
    [{ x: 300, y: 400, t: 0 }, { x: Infinity, y: 400, t: 50 }],
    [{ x: 300, y: 400, t: 50 }, { x: 700, y: 400, t: 50 }],
    [{ x: 300, y: 400, t: 100 }, { x: 500, y: 400, t: 50 }, { x: 700, y: 400, t: 0 }],
    [{ x: 5, y: 5, t: 0 }],
    [{ x: -1e6, y: 0, t: 0 }, { x: 1e6, y: 0, t: 200 }],
  ];
  for (const pts of bad) {
    const r = classifyStroke(pts, { foeSide: 'right' });
    for (const v of [r.speed, r.length, r.duration, r.start.x, r.start.y, r.end.x, r.end.y, r.confidence]) assert.ok(Number.isFinite(v), JSON.stringify(r));
    assert.ok(r.confidence >= 0 && r.confidence <= 1);
  }
  for (const scale of [1, 1366 / 1280, 1.5]) {
    assert.equal(classifyStroke(line(400 * scale, 300 * scale, 460 * scale, 296 * scale, 30, 5), { foeSide: 'right', scale }).kind, 'thrust', `fast flick at scale ${scale}`);
    assert.equal(classifyStroke(line(400 * scale, 300 * scale, 460 * scale, 296 * scale, 90, 8), { foeSide: 'right', scale }).kind, 'none', `slow flick at scale ${scale}`);
  }
});
