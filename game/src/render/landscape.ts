import * as THREE from 'three';
import { BAND_TOP, LANDSCAPE_GROUND, MAX_TONE, landscapePaintKey, lookCodes, stageLook, type StageLook } from '../core/stages.js';

// Procedural sumi-e landscape behind the fighters. One shader paints
// ridges from noise, a sky wash, the stage motif (pines, bridge, bamboo, pond,
// steps, reeds, cliff, moon) and at most one red accent into an offscreen
// texture, ONCE per stage change or resize. Each frame the scene only draws that
// texture on one quad between the paper (z -10) and the mist (z -6), so the ink
// pass and mist still sit on top and the cost per frame is one texture read.
// No image files.

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const paintShader = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform vec4 uView;      // left, right, bottom, top (world)
  uniform vec4 uRidge[3];  // base, amp, freq, tone
  uniform float uMotif;
  uniform float uAccent;
  uniform vec3 uAccentAt;
  uniform float uRain;
  uniform float uSky;
  uniform float uBandCap;
  uniform float uSeed;
  uniform float uGround;
  uniform float uBandTop;
  uniform float uMaxTone;
  uniform vec3 uInk;
  uniform vec3 uRed;

  float hash1(float x) { return fract(sin(x * 127.1 + uSeed * 31.7) * 43758.5453); }
  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21) + uSeed);
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float noise1(float x) {
    float i = floor(x);
    float f = fract(x);
    return mix(hash1(i), hash1(i + 1.0), f * f * (3.0 - 2.0 * f));
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  // Ridge line: broad peaks plus brushy detail.
  float ridgeY(vec4 r, float x, float k) {
    float n = noise1(x * r.z + k * 17.0) * 0.65 + noise1(x * r.z * 2.7 + k * 5.0) * 0.25 + noise1(x * r.z * 9.0 + k) * 0.1;
    return r.x + r.y * pow(n, 1.6);
  }
  // Ink of one ridge layer: dark along the crest, fading down into mist (wet wash).
  float ridgeInk(vec4 r, vec2 p, float k) {
    float top = ridgeY(r, p.x, k);
    float d = top - p.y;
    if (d < 0.0) return 0.0;
    float edge = smoothstep(0.0, 0.03, d);
    float fade = exp(-d * (1.2 + 0.4 * k)) * 0.75 + 0.25 * exp(-d * 0.25);
    float grain = 0.8 + 0.4 * noise(p * vec2(6.0, 1.5) + k * 9.0);
    return r.w * edge * fade * grain;
  }
  float seg(vec2 p, vec2 a, vec2 b, float w) {
    vec2 pa = p - a;
    vec2 ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return 1.0 - smoothstep(w * 0.6, w, length(pa - ba * h));
  }
  // One brush stroke from a to b: wide and pooled where the brush lands, narrowing
  // by taper (0..1) toward b, bent sideways by bend (share of the length), with a hand wobble and
  // dry-brush breaks that grow toward the tail. Returns 0..1 ink.
  float brush(vec2 p, vec2 a, vec2 b, float w, float taper, float bend, float k) {
    vec2 ba = b - a;
    float L = length(ba);
    vec2 dir = ba / L;
    vec2 nrm = vec2(-dir.y, dir.x);
    vec2 pa = p - a;
    float along = dot(pa, dir);
    float t = clamp(along / L, 0.0, 1.0);
    float off = bend * L * 4.0 * t * (1.0 - t) + (noise1(t * 3.0 * L + k * 7.3) - 0.5) * w * 0.9;
    float s = dot(pa, nrm) - off;
    float width = w * (1.0 - taper * smoothstep(0.1, 1.0, t)) * (0.85 + 0.3 * noise1(t * 6.0 * L + k * 3.1));
    width *= 1.0 + 0.3 * (1.0 - smoothstep(0.0, 0.1, t));
    float past = max(-along, along - L);
    float d = length(vec2(s, max(past, 0.0)));
    float body = 1.0 - smoothstep(width * 0.5, width, d);
    float streak = noise(vec2(along * 2.5 + k * 13.0, s / max(width, 0.001) * 3.5 + k * 5.0));
    float dry = smoothstep(0.12 + 0.45 * t * t, 0.3 + 0.45 * t * t, streak);
    float pool = 0.72 + 0.28 * (1.0 - smoothstep(0.0, 0.2, t));
    return body * mix(1.0, dry, 0.35 + 0.6 * t) * pool;
  }
  // A wet blot of ink (a pine needle mass): an uneven ellipse whose ends droop, darker where the ink
  // settles at the lower edge and along the rim, with needle streaks from the paper grain.
  float wash(vec2 p, vec2 c, vec2 r, float droop, float k) {
    vec2 q = (p - c) / r;
    q.y += droop * q.x * q.x;
    float n = noise(p * 2.6 + k * 5.1) * 0.6 + noise(p * 8.0 + k * 2.3) * 0.4;
    float d = length(q) + (n - 0.5) * 0.8;
    float body = 1.0 - smoothstep(0.6, 1.0, d);
    float settle = 0.6 + 0.4 * (1.0 - smoothstep(-0.7, 0.3, q.y));
    float needles = 0.75 + 0.25 * noise(vec2(p.x * 18.0 + k, p.y * 4.0));
    float rim = 1.0 + 0.25 * (1.0 - smoothstep(0.0, 0.15, abs(d - 0.85)));
    return min(1.0, body * settle * needles * rim);
  }
  // A crooked trunk in three knotted strokes, with drooping needle masses layered left and right.
  float pine(vec2 p, vec2 at, float h, float k) {
    float lean = (hash1(k) - 0.5) * 0.25 * h;
    vec2 a1 = at + vec2(0.09 * h + lean * 0.3, 0.36 * h);
    vec2 a2 = a1 + vec2(-0.11 * h + lean * 0.4, 0.33 * h);
    vec2 a3 = a2 + vec2(0.07 * h + lean * 0.3, 0.31 * h);
    float v = brush(p, at, a1, 0.05 * h, 0.25, 0.08, k);
    v = max(v, brush(p, a1, a2, 0.038 * h, 0.3, -0.1, k + 1.0));
    v = max(v, brush(p, a2, a3, 0.028 * h, 0.85, 0.06, k + 2.0));
    float flip = floor(hash1(k + 3.0) * 2.0);
    for (int i = 0; i < 4; i++) {
      float fi = float(i);
      float side = mod(fi + flip, 2.0) * 2.0 - 1.0;
      float f = 0.42 + 0.16 * fi;
      vec2 trunk = vec2(mix(at.x, a3.x, f), at.y + h * f);
      vec2 c = trunk + vec2(side * h * (0.2 - 0.035 * fi), 0.02 * h);
      vec2 r = vec2(h * (0.36 - 0.06 * fi), h * (0.085 - 0.01 * fi));
      v = max(v, wash(p, c, r, 0.45, k + 5.0 + fi) * (0.9 - 0.08 * fi));
      v = max(v, brush(p, trunk, c + vec2(side * r.x * 0.5, -r.y * 0.3), 0.018 * h, 0.9, 0.12 * side, k + 9.0 + fi));
    }
    v = max(v, wash(p, a3 + vec2(0.0, 0.02 * h), vec2(0.2 * h, 0.07 * h), 0.5, k + 20.0) * 0.85);
    return v;
  }

  void main() {
    vec2 p = vec2(mix(uView.x, uView.y, vUv.x), mix(uView.z, uView.w, vUv.y));
    float ink = 0.0;

    // Sky wash from the top.
    float skyT = smoothstep(uGround, uView.w, p.y);
    ink = max(ink, uSky * skyT * (0.7 + 0.3 * noise(p * vec2(0.4, 1.2))));

    // Moon: a pale disc cut out of the sky wash, with an ink rim.
    if (uMotif > 7.5) {
      float d = length(p - vec2(-3.6, 2.6));
      ink *= smoothstep(1.05, 1.15, d);
      ink = max(ink, 0.22 * (1.0 - smoothstep(0.0, 0.05, abs(d - 1.1))) * (0.6 + 0.4 * noise(p * 8.0)));
    }

    // Storm cliff: the near ridge rises into a sheer rock face on the right.
    vec4 r0 = uRidge[0];
    vec4 r1 = uRidge[1];
    vec4 r2 = uRidge[2];
    if (uMotif > 6.5 && uMotif < 7.5) {
      float face = smoothstep(4.2, 6.2, p.x + noise1(p.y * 3.0) * 0.5);
      r2.y += face * 3.6;
    }
    float far = ridgeInk(r0, p, 0.0);
    float mid = ridgeInk(r1, p, 1.0);
    float near = ridgeInk(r2, p, 2.0);
    ink = max(ink, far);
    ink = max(ink, mid);
    ink = max(ink, near);
    // The foreground under the ground line stays nearly empty paper (motifs below may draw there on purpose).
    if (p.y < uGround - 0.05) ink *= 0.25;

    // Motifs. Kept to the sides where the fighters' band lies.
    float mark = 0.0;
    if (uMotif > 0.5 && uMotif < 1.5) {
      // Pines on the middle ridge at both ends.
      mark = max(mark, pine(p, vec2(-6.2, ridgeY(r1, -6.2, 1.0) - 0.1), 1.9, 1.0));
      mark = max(mark, pine(p, vec2(-5.3, ridgeY(r1, -5.3, 1.0) - 0.1), 1.3, 30.0));
      mark = max(mark, pine(p, vec2(5.8, ridgeY(r1, 5.8, 1.0) - 0.1), 1.6, 60.0));
      mark *= 0.5;
    } else if (uMotif > 1.5 && uMotif < 2.5) {
      // Stone bridge over a stream, far behind: one arc stroke, thick where the brush lands on the
      // left and thinning to the right, an uneven two-stroke deck and leaning piers.
      vec2 c = vec2(0.0, 0.2);
      vec2 q = (p - c) * vec2(0.55, 1.0);
      float t = clamp(1.0 - atan(q.y, q.x) / 3.14159, 0.0, 1.0);
      float rad = 1.55 + (noise1(t * 6.0 + 4.0) - 0.5) * 0.12;
      float w = 0.17 * (1.0 - 0.7 * smoothstep(0.05, 1.0, t)) * (0.85 + 0.3 * noise1(t * 14.0));
      float arc = (1.0 - smoothstep(w * 0.5, w, abs(length(q) - rad))) * step(c.y - 0.05, p.y);
      float streak = noise(vec2(t * 20.0, (length(q) - rad) / w * 3.0));
      arc *= mix(1.0, smoothstep(0.15 + 0.4 * t * t, 0.32 + 0.4 * t * t, streak), 0.35 + 0.6 * t);
      arc *= 0.72 + 0.28 * (1.0 - smoothstep(0.0, 0.2, t));
      float deck = brush(p, vec2(-3.7, 1.74), vec2(0.3, 1.9), 0.08, 0.5, 0.04, 31.0);
      deck = max(deck, brush(p, vec2(-0.2, 1.88), vec2(3.7, 1.72), 0.07, 0.8, 0.05, 37.0));
      mark = max(arc, deck) * 0.42;
      mark = max(mark, brush(p, vec2(-3.35, 1.7), vec2(-3.05, 0.0), 0.11, 0.6, 0.12, 41.0) * 0.35);
      mark = max(mark, brush(p, vec2(3.3, 1.68), vec2(3.55, 0.05), 0.1, 0.7, -0.1, 43.0) * 0.35);
    } else if (uMotif > 2.5 && uMotif < 3.5) {
      // Bamboo stalks on both sides, with joints and a few leaves.
      float side = abs(p.x);
      if (side > 4.3) {
        float cell = floor(p.x / 0.55);
        float cx = (cell + 0.3 + 0.4 * hash1(cell)) * 0.55;
        float w = 0.06 + 0.03 * hash1(cell + 3.0);
        float stalk = 1.0 - smoothstep(w * 0.6, w, abs(p.x - cx));
        float joint = 1.0 - smoothstep(0.0, 0.03, abs(fract(p.y * 0.9 + hash1(cell)) - 0.5));
        stalk *= 1.0 - 0.6 * joint;
        float tone = 0.25 + 0.25 * hash1(cell + 7.0);
        mark = stalk * tone;
        vec2 q = vec2(p.x - cx, fract(p.y * 0.9 + hash1(cell)) - 0.5);
        float leaf = seg(q, vec2(0.0, 0.0), vec2(0.45 * sign(hash1(cell + 9.0) - 0.5), -0.12), 0.05) * step(0.5, hash1(floor(p.y * 0.9) + cell));
        mark = max(mark, leaf * 0.3);
        mark *= step(uGround - 0.3, p.y);
      }
    } else if (uMotif > 3.5 && uMotif < 4.5) {
      // Still pond: the ridges mirrored under the ground line, faint, broken by ripples.
      if (p.y < uGround) {
        vec2 m = vec2(p.x, 2.0 * uGround - p.y);
        float rip = 0.6 + 0.4 * step(0.35, noise(vec2(p.x * 0.8, p.y * 26.0)));
        mark = max(ridgeInk(r1, m, 1.0), ridgeInk(r0, m, 0.0)) * 0.6 * rip;
        mark = max(mark, seg(p, vec2(-7.5, uGround - 0.5), vec2(-3.5, uGround - 0.5), 0.02) * 0.12);
      }
    } else if (uMotif > 4.5 && uMotif < 5.5) {
      // Temple steps climbing to a roof on the right.
      // Each step is its own brush stroke: uneven start, length, height, weight and tone.
      for (int i = 0; i < 8; i++) {
        float fi = float(i);
        float y = uGround + 0.4 + fi * 0.38 + (hash1(fi + 50.0) - 0.5) * 0.08;
        float x0 = 3.8 + fi * 0.22 + (hash1(fi + 60.0) - 0.5) * 0.35;
        float x1 = 8.4 - hash1(fi + 70.0) * 1.1;
        float w = 0.04 + 0.04 * hash1(fi + 80.0);
        float tone = 0.3 + 0.12 * hash1(fi + 90.0);
        vec2 b = vec2(x1, y + (hash1(fi + 95.0) - 0.5) * 0.1);
        mark = max(mark, brush(p, vec2(x0, y), b, w, 0.7, (hash1(fi + 99.0) - 0.5) * 0.06, fi * 3.0 + 100.0) * tone);
      }
      // A sagging roof with upturned eave tips, an eave shadow and two hand-drawn pillars.
      float roofY = uGround + 3.9;
      float roof = brush(p, vec2(4.3, roofY + 0.22), vec2(6.4, roofY + 0.72), 0.1, 0.35, -0.07, 120.0);
      roof = max(roof, brush(p, vec2(6.35, roofY + 0.72), vec2(8.7, roofY + 0.2), 0.1, 0.75, -0.07, 125.0));
      roof = max(roof, brush(p, vec2(4.55, roofY + 0.16), vec2(4.1, roofY + 0.42), 0.06, 0.9, 0.15, 130.0));
      roof = max(roof, brush(p, vec2(8.45, roofY + 0.14), vec2(8.9, roofY + 0.42), 0.06, 0.9, -0.15, 135.0));
      roof = max(roof, brush(p, vec2(4.7, roofY + 0.05), vec2(8.3, roofY + 0.02), 0.06, 0.6, -0.03, 140.0) * 0.7);
      roof = max(roof, brush(p, vec2(5.05, roofY - 0.05), vec2(4.98, roofY - 1.05), 0.06, 0.55, 0.05, 145.0));
      roof = max(roof, brush(p, vec2(7.85, roofY - 0.05), vec2(7.95, roofY - 1.0), 0.055, 0.6, -0.05, 150.0));
      mark = max(mark, roof * 0.5);
    } else if (uMotif > 5.5 && uMotif < 6.5) {
      // Reeds at the water's edge, both ends, leaning in the wind.
      if (abs(p.x) > 4.6 && p.y < uGround + 2.2) {
        float cell = floor(p.x / 0.18);
        float cx = (cell + hash1(cell)) * 0.18;
        float h = 0.9 + 1.3 * hash1(cell + 2.0);
        float lean = (p.y - (uGround - 0.6)) * (0.18 + 0.1 * hash1(cell + 4.0));
        float blade = 1.0 - smoothstep(0.012, 0.03, abs(p.x - cx - lean));
        blade *= step(uGround - 0.6, p.y) * step(p.y, uGround - 0.6 + h);
        mark = blade * (0.3 + 0.2 * hash1(cell + 6.0));
      }
      if (p.y < uGround) mark = max(mark, seg(p, vec2(-8.0, uGround - 0.9), vec2(8.0, uGround - 0.9), 0.015) * 0.1);
    }
    ink = max(ink, mark);

    // Rain: thin slanting streaks.
    if (uRain > 0.0) {
      vec2 q = vec2(p.x + p.y * 0.25, p.y);
      float col = floor(q.x * 9.0);
      float len = fract(q.y * 0.35 + hash1(col) * 7.0);
      float streak = (1.0 - smoothstep(0.0, 0.12, abs(fract(q.x * 9.0) - 0.5))) * step(0.82, len) * step(0.55, hash1(col + 1.0));
      ink = max(ink, streak * 0.16 * uRain);
    }

    // Keep the fighters' band light and the foreground under the ground line nearly empty.
    float band = step(uGround - 0.05, p.y) * step(p.y, uBandTop) * (1.0 - smoothstep(4.0, 6.0, abs(p.x)));
    ink = min(ink, mix(uMaxTone, uBandCap, band));
    ink = min(ink, uMaxTone);

    // The one red accent.
    vec3 colr = uInk;
    float red = 0.0;
    vec2 a = p - uAccentAt.xy;
    float r = uAccentAt.z;
    if (uAccent > 0.5 && uAccent < 1.5) {
      red = (1.0 - smoothstep(r * 0.92, r, length(a))) * 0.7;
    } else if (uAccent > 1.5 && uAccent < 2.5) {
      vec2 b = abs(a);
      red = (1.0 - smoothstep(r * 0.9, r, max(b.x, b.y))) * 0.8 * (0.75 + 0.25 * noise(p * 30.0));
    } else if (uAccent > 2.5) {
      vec2 b = a * vec2(1.0, 0.8);
      red = (1.0 - smoothstep(r * 0.9, r, length(b))) * 0.75;
      ink = max(ink, seg(p, uAccentAt.xy + vec2(0.0, r), uAccentAt.xy + vec2(0.0, r + 1.2), 0.02) * 0.4);
    }
    if (red > 0.0) {
      colr = mix(uInk, uRed, red / max(red + ink, 0.001));
      ink = max(ink, red);
    }
    gl_FragColor = vec4(colr, ink);
  }
`;

const showShader = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tMap;
  void main() {
    vec4 c = texture2D(tMap, vUv);
    if (c.a < 0.004) discard;
    gl_FragColor = c;
  }
`;

const showVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export interface Landscape {
  mesh: THREE.Mesh;
  /** Paint the look for this stage id (title and path-map too). Static until the next call or resize. */
  setStage(id: string): void;
  /** Repaint for a new view (half extents, world) at this target size in pixels. */
  resize(halfWidth: number, halfHeight: number, pxWidth: number, pxHeight: number): void;
  /**
   * Paint now if the stage or size changed since the last paint. setStage and resize
   * only mark the look; the frame loop calls this once before it draws, so a resize storm or a
   * stage set twice at start-up costs one paint, and an unchanged stage or size costs nothing.
   * Returns true when it painted.
   */
  flush(): boolean;
  readonly stageId: string;
  dispose(): void;
}

/** Longest side of the painted texture: the background is soft, so it never needs full 4K. */
const MAX_SIDE = 1600;

export function createLandscape(renderer: THREE.WebGLRenderer, seed = 1): Landscape {
  const target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  const ridge = () => [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()];
  const paint = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader: paintShader,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uView: { value: new THREE.Vector4(-8, 8, -4.5, 4.5) },
      uRidge: { value: ridge() },
      uMotif: { value: 0 },
      uAccent: { value: 0 },
      uAccentAt: { value: new THREE.Vector3() },
      uRain: { value: 0 },
      uSky: { value: 0 },
      uBandCap: { value: 0.34 },
      uSeed: { value: 0 },
      uGround: { value: LANDSCAPE_GROUND },
      uBandTop: { value: BAND_TOP },
      uMaxTone: { value: MAX_TONE },
      uInk: { value: new THREE.Vector3(0.106, 0.086, 0.067) },
      uRed: { value: new THREE.Vector3(0.70, 0.13, 0.09) },
    },
  });
  const paintScene = new THREE.Scene();
  const paintQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), paint);
  paintQuad.frustumCulled = false;
  paintScene.add(paintQuad);
  const paintCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const show = new THREE.ShaderMaterial({
    vertexShader: showVertex,
    fragmentShader: showShader,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: { tMap: { value: target.texture } },
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), show);
  mesh.frustumCulled = false;
  // Over the paper (z -10, renderOrder -1), under the mist (z -6, renderOrder -0.5).
  mesh.position.z = -8;
  mesh.renderOrder = -0.75;

  let look: StageLook = stageLook('pine-mist', seed);
  // The id asked for (an unknown id paints the first stage but is kept, so it is not repainted every frame).
  let asked = look.id;
  const view = { hw: 8, hh: 4.5, w: 0, h: 0 };
  // What the texture holds now ('' = nothing painted yet).
  let painted = '';

  const repaint = () => {
    if (view.w < 1 || view.h < 1) return;
    const u = paint.uniforms;
    // Paint a little wider than the view so the camera kick never shows an edge.
    const hw = view.hw * 1.04;
    const hh = view.hh * 1.04;
    u.uView.value.set(-hw, hw, -hh, hh);
    const r = u.uRidge.value as THREE.Vector4[];
    for (let i = 0; i < 3; i++) {
      const g = look.ridges[i] ?? { base: -9, amp: 0, freq: 1, tone: 0 };
      r[i].set(g.base, g.amp, g.freq, g.tone);
    }
    const codes = lookCodes(look);
    u.uMotif.value = codes.motif;
    u.uAccent.value = codes.accent;
    u.uAccentAt.value.set(look.accentAt[0], look.accentAt[1], look.accentAt[2]);
    u.uRain.value = look.rain;
    u.uSky.value = look.sky;
    u.uBandCap.value = look.bandCap;
    u.uSeed.value = look.seed;
    mesh.scale.set(hw * 2, hh * 2, 1);
    const prev = renderer.getRenderTarget();
    const prevClear = renderer.getClearAlpha();
    const clearColor = new THREE.Color();
    renderer.getClearColor(clearColor);
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    renderer.render(paintScene, paintCam);
    renderer.setRenderTarget(prev);
    renderer.setClearColor(clearColor, prevClear);
  };

  return {
    mesh,
    get stageId() {
      return asked;
    },
    setStage(id) {
      if (id === asked) return;
      asked = id;
      look = stageLook(id, seed);
    },
    resize(halfWidth, halfHeight, pxWidth, pxHeight) {
      const k = Math.min(1, MAX_SIDE / Math.max(pxWidth, pxHeight, 1));
      const w = Math.max(1, Math.round(pxWidth * k));
      const h = Math.max(1, Math.round(pxHeight * k));
      view.hw = halfWidth;
      view.hh = halfHeight;
      if (w !== view.w || h !== view.h) {
        view.w = w;
        view.h = h;
        target.setSize(w, h);
        painted = '';
      }
    },
    flush() {
      if (view.w < 1 || view.h < 1) return false;
      const key = landscapePaintKey(look.id, view.hw, view.hh, view.w, view.h);
      if (key === painted) return false;
      repaint();
      painted = key;
      return true;
    },
    dispose() {
      target.dispose();
      paint.dispose();
      show.dispose();
      paintQuad.geometry.dispose();
      mesh.geometry.dispose();
    },
  };
}
