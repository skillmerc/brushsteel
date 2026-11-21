import * as THREE from 'three';
import { createRng } from '../core/rng.js';
import {
  BONE, BONE_COUNT, CHAINS, createFigure, setPose, stepFigure,
  type FigureState, type PoseName,
} from '../core/figure.js';

// A fighter drawn as brush strokes: one instanced quad per bone and per
// verlet chain segment, in one draw call per figure. The ink look (taper,
// ragged bleeding edge, dry-brush breaks, bristle streaks) comes from a
// procedural brush texture made once at start (no image files) and the
// fragment shader. The maths lives in core/figure.ts.

/** Stage y of the ground line (the faint ink line of render/inkLine.ts). */
export const GROUND_Y = -1.2;

const vertexShader = /* glsl */ `
  attribute vec4 aStroke;
  varying vec2 vUv;
  varying vec4 vStroke;
  void main() {
    vUv = uv;
    vStroke = aStroke;
    vec4 p = vec4(position, 1.0);
    #ifdef USE_INSTANCING
      p = instanceMatrix * p;
    #endif
    gl_Position = projectionMatrix * modelViewMatrix * p;
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  uniform sampler2D uBrush;
  uniform vec3 uInk;
  varying vec2 vUv;
  varying vec4 vStroke; // seed, alpha, length (stage units), taper style

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }

  void main() {
    float seed = vStroke.x;
    float alpha = vStroke.y;
    float len = max(vStroke.z, 0.05);
    float blob = vStroke.w; // 1 = round blob (head), 0 = a pulled stroke
    float u = vUv.x;
    float v = vUv.y * 2.0 - 1.0;

    // Pressed start, swelling body, lifted tail, rounded ends (no square cut); a blob is round at both ends.
    float capIn = smoothstep(0.0, 0.16, u);
    float capOut = smoothstep(1.0, 0.78, u);
    float width = 0.92 * mix(0.35, 1.0, capIn) * mix(0.3, 1.0, capOut) * (1.0 - 0.25 * smoothstep(0.4, 1.0, u));
    if (blob > 0.5) width = 0.92 * sqrt(max(0.0, 1.0 - pow(abs(u * 2.0 - 1.0), 2.0)));

    // Ragged, bleeding edge: low-frequency wobble plus fine fibre noise.
    float wob = noise(vec2(u * len * 6.0 + seed * 17.0, seed)) - 0.5;
    float fib = noise(vec2(u * len * 40.0 + seed * 3.0, v * 9.0 + seed)) - 0.5;
    float edge = width + wob * 0.16 + fib * 0.08;
    float core = 1.0 - smoothstep(edge - 0.12, edge + 0.02, abs(v));

    // Bristle streaks along the stroke, and dry-brush breaks toward the tail.
    float br = texture2D(uBrush, vec2(u * len * 0.45 + seed, v * 0.5 + 0.5)).r;
    float dryness = mix(0.12, 0.62, smoothstep(0.35, 1.0, u)) * (1.0 - blob * 0.7);
    float dry = smoothstep(dryness - 0.12, dryness + 0.12, br);
    float a = core * mix(0.55, 1.0, dry) * (0.82 + 0.18 * br);

    // Wet bleed: a faint wash feathering past the edge.
    float halo = (1.0 - smoothstep(edge, edge + 0.3, abs(v))) * (0.16 + 0.12 * fib);
    a = max(a, halo) * alpha;
    // Soft ends so overlapping strokes blend instead of stacking into bands.
    a *= smoothstep(0.0, 0.05, u) * smoothstep(1.0, 0.93, u);
    if (a < 0.012) discard;
    gl_FragColor = vec4(uInk, a);
  }
`;

let brushTexture: THREE.DataTexture | null = null;

/** Procedural brush: 256 x 64, bristles across (v), streaks along (u) with dry gaps. Made once, shared. */
export function getBrushTexture(): THREE.DataTexture {
  if (brushTexture) return brushTexture;
  const W = 256;
  const H = 64;
  const rng = createRng(0xb7_05_4e_11);
  const data = new Uint8Array(W * H * 4);
  const bristle = new Float32Array(H);
  for (let y = 0; y < H; y++) bristle[y] = 0.55 + 0.45 * rng.next();
  // Smooth neighbouring bristles a little so streaks are a few texels wide.
  for (let y = 1; y < H - 1; y++) bristle[y] = (bristle[y - 1] + 2 * bristle[y] + bristle[y + 1]) / 4;
  for (let y = 0; y < H; y++) {
    let x = 0;
    let level = bristle[y];
    while (x < W) {
      // Runs of ink, then short gaps where the bristle skips the paper.
      const run = 6 + Math.floor(rng.next() * 40);
      const gap = rng.next() < 0.35 ? 1 + Math.floor(rng.next() * 6) : 0;
      for (let i = 0; i < run && x < W; i++, x++) {
        const val = Math.min(1, level * (0.85 + 0.15 * rng.next()));
        const k = (y * W + x) * 4;
        data[k] = data[k + 1] = data[k + 2] = Math.round(val * 255);
        data[k + 3] = 255;
      }
      for (let i = 0; i < gap && x < W; i++, x++) {
        const k = (y * W + x) * 4;
        data[k] = data[k + 1] = data[k + 2] = Math.round(level * 0.15 * 255);
        data[k + 3] = 255;
      }
      level = Math.min(1, Math.max(0.3, level + (rng.next() - 0.5) * 0.2));
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  brushTexture = tex;
  return tex;
}

interface StrokeDef {
  /** Bone index, or -1 for a chain segment. */
  bone: number;
  chain: number;
  seg: number;
  /** Stroke width, stage units. */
  width: number;
  alpha: number;
  blob: number;
}

// Stroke widths per bone (stage units) and ink strength. Back limbs are a grey
// wash so the two sides read apart.
const BONE_LOOK: Record<string, { width: number; alpha: number; blob?: number }> = {
  hips: { width: 0.34, alpha: 0.9 },
  spine: { width: 0.36, alpha: 0.92 },
  chest: { width: 0.42, alpha: 0.95 },
  neck: { width: 0.12, alpha: 0.9 },
  head: { width: 0.34, alpha: 0.96, blob: 1 },
  upperArmF: { width: 0.16, alpha: 0.95 },
  forearmF: { width: 0.13, alpha: 0.95 },
  upperArmB: { width: 0.15, alpha: 0.5 },
  forearmB: { width: 0.12, alpha: 0.5 },
  sword: { width: 0.055, alpha: 0.98 },
  thighF: { width: 0.21, alpha: 0.92 },
  shinF: { width: 0.16, alpha: 0.92 },
  thighB: { width: 0.2, alpha: 0.5 },
  shinB: { width: 0.15, alpha: 0.5 },
};

const CHAIN_LOOK: Record<string, { width: number; alpha: number }> = {
  robeBack: { width: 0.4, alpha: 0.42 },
  robeFront: { width: 0.38, alpha: 0.78 },
  sash: { width: 0.07, alpha: 0.85 },
  hair: { width: 0.09, alpha: 0.95 },
};

// Draw order, back to front.
const ORDER: Array<{ bone: string } | { chain: string }> = [
  { chain: 'robeBack' }, { bone: 'upperArmB' }, { bone: 'forearmB' }, { bone: 'thighB' }, { bone: 'shinB' },
  { chain: 'hair' }, { bone: 'hips' }, { bone: 'spine' }, { bone: 'chest' }, { bone: 'neck' }, { bone: 'head' },
  { chain: 'sash' }, { bone: 'thighF' }, { bone: 'shinF' }, { chain: 'robeFront' },
  { bone: 'upperArmF' }, { bone: 'forearmF' }, { bone: 'sword' },
];

function buildStrokes(): StrokeDef[] {
  const out: StrokeDef[] = [];
  for (const o of ORDER) {
    if ('bone' in o) {
      const i = BONE[o.bone as keyof typeof BONE];
      const look = BONE_LOOK[o.bone];
      out.push({ bone: i, chain: -1, seg: 0, width: look.width, alpha: look.alpha, blob: look.blob ?? 0 });
    } else {
      const ci = CHAINS.findIndex((c) => c.name === o.chain);
      const look = CHAIN_LOOK[o.chain];
      const n = CHAINS[ci].points - 1;
      for (let s = 0; s < n; s++) {
        // Robes widen toward the hem, hair and sash thin toward the tip.
        const t = s / Math.max(1, n - 1);
        const w = o.chain.startsWith('robe') ? look.width * (0.75 + 0.35 * t) : look.width * (1 - 0.6 * t);
        out.push({ bone: -1, chain: ci, seg: s, width: w, alpha: look.alpha, blob: 0 });
      }
    }
  }
  return out;
}

export interface FigureView {
  mesh: THREE.InstancedMesh;
  state: FigureState;
  /** Tween toward a pose (from choosePose). */
  setPose(name: PoseName): void;
  /** Advance the figure by dt seconds and write the instance matrices. No allocation. */
  update(dt: number): void;
  dispose(): void;
}

export interface FigureOptions {
  x: number;
  facing: 1 | -1;
  seed?: number;
  ground?: number;
  pose?: PoseName;
  /** Stage z of the figure (above the paper). */
  z?: number;
}

const sharedGeometry = new THREE.PlaneGeometry(1, 1);

export function createFigureView(opts: FigureOptions): FigureView {
  const state = createFigure(opts.x, opts.facing, opts.ground ?? GROUND_Y, opts.pose ?? 'idle');
  const strokes = buildStrokes();
  const count = strokes.length;
  const rng = createRng((opts.seed ?? 1) >>> 0);

  const geometry = sharedGeometry.clone();
  const strokeAttr = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    strokeAttr[i * 4] = rng.next() * 50;
    strokeAttr[i * 4 + 1] = strokes[i].alpha;
    strokeAttr[i * 4 + 2] = 0.3;
    strokeAttr[i * 4 + 3] = strokes[i].blob;
  }
  const aStroke = new THREE.InstancedBufferAttribute(strokeAttr, 4);
  aStroke.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('aStroke', aStroke);

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    uniforms: {
      uBrush: { value: getBrushTexture() },
      uInk: { value: new THREE.Color('#1b1611') },
    },
  });

  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.position.z = opts.z ?? 1;
  mesh.renderOrder = 2;
  const m = mesh.instanceMatrix.array as Float32Array;

  // Write one quad from (ax, ay) to (bx, by) of width w into instance i (column-major 4x4).
  const writeQuad = (i: number, ax: number, ay: number, bx: number, by: number, w: number) => {
    let dx = bx - ax;
    let dy = by - ay;
    const len = Math.hypot(dx, dy) || 1e-4;
    const ux = dx / len;
    const uy = dy / len;
    // Run a little past both joints so neighbouring strokes overlap like real brushwork.
    const ext = w * 0.5;
    const L = len + 2 * ext;
    dx = ux * L;
    dy = uy * L;
    const k = i * 16;
    m[k] = dx; m[k + 1] = dy; m[k + 2] = 0; m[k + 3] = 0;
    m[k + 4] = -uy * w; m[k + 5] = ux * w; m[k + 6] = 0; m[k + 7] = 0;
    m[k + 8] = 0; m[k + 9] = 0; m[k + 10] = 1; m[k + 11] = 0;
    m[k + 12] = (ax + bx) / 2; m[k + 13] = (ay + by) / 2; m[k + 14] = i * 0.001; m[k + 15] = 1;
    strokeAttr[i * 4 + 2] = L;
  };

  const write = () => {
    const j = state.joints;
    for (let i = 0; i < count; i++) {
      const s = strokes[i];
      if (s.bone >= 0) {
        const k = s.bone * 4;
        writeQuad(i, j[k], j[k + 1], j[k + 2], j[k + 3], s.width);
      } else {
        const p = state.chains[s.chain];
        const a = s.seg * 2;
        writeQuad(i, p[a], p[a + 1], p[a + 2], p[a + 3], s.width);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    aStroke.needsUpdate = true;
  };
  write();

  return {
    mesh,
    state,
    setPose(name) {
      setPose(state, name);
    },
    update(dt) {
      stepFigure(state, dt);
      write();
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      mesh.dispose();
    },
  };
}

/** Number of brush strokes (instances) in one figure. */
export const STROKES_PER_FIGURE = BONE_COUNT + CHAINS.reduce((n, c) => n + c.points - 1, 0);
