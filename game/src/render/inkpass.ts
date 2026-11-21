import * as THREE from 'three';
import { INK_PRESETS, mistLayersFor, targetSize, type InkQuality } from '../core/inkfx.js';
import { createMist, type Mist } from './mist.js';
import { createSpray, type Spray } from './spray.js';

// The ink post-process. One call per frame, composer.render(scene, camera):
//   1. the scene on layer 0 (paper, mist, ground line) goes to an offscreen target;
//   2. everything on the ink layer (figures, spray) goes to a second target, cleared
//      to transparent, with MAX blending, so overlapping strokes keep the darkest
//      stroke's coverage instead of stacking into darker bands;
//   3. one full-screen GLSL pass lays the ink on the paper: ink bleed (feathered
//      wash creeping past the edges along paper fibres), edge darkening (ink pools
//      on the inner side of each edge), dry-brush breaks where coverage is thin,
//      a soft density knee, screen-space paper grain over the whole frame and a
//      slight darkening toward the frame edges.
// Quality presets (core/inkfx.ts INK_PRESETS) set the target scale (half-res on
// low), bleed taps, mist layers and the spray limit. No textures, no network.

/** three.js layer for ink objects. The main scene pass does not draw it. */
export const INK_LAYER = 1;

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  uniform sampler2D tScene;
  uniform sampler2D tInk;
  uniform vec2 uTexel;     // 1 / target size
  uniform float uBleed;    // bleed radius in target pixels
  uniform float uGrain;
  uniform float uSeed;
  uniform vec3 uInk;
  uniform vec2 uDirs[TAPS];
  varying vec2 vUv;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21) + uSeed);
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  void main() {
    vec3 scene = texture2D(tScene, vUv).rgb;
    float a0 = texture2D(tInk, vUv).a;

    // Paper tooth (per pixel) and fibres (short horizontal streaks), in screen pixels.
    vec2 px = floor(gl_FragCoord.xy);
    float tooth = hash(px);
    float fibre = hash(vec2(floor(px.x / 7.0), px.y * 1.37));

    // Ring of taps around the pixel, turned by the tooth so the edge is not a clean circle.
    // One sin/cos per pixel; the tap directions are a fixed table (no trig per tap).
    float turn = tooth * 1.3;
    mat2 rot = mat2(cos(turn), sin(turn), -sin(turn), cos(turn));
    float ring = 0.0;
    for (int i = 0; i < TAPS; i++) {
      float r = uBleed * (0.55 + 0.9 * fract(tooth * 7.31 + float(i) * 0.379));
      ring += texture2D(tInk, vUv + rot * uDirs[i] * r * uTexel).a;
    }
    ring /= float(TAPS);

    // Edge darkening: the inner side of an edge (denser than its ring) pools darker.
    float rim = clamp(a0 - ring, 0.0, 1.0);
    // Bleed: outside the edge the ink creeps into the paper along the fibres.
    float halo = clamp(ring - a0, 0.0, 1.0) * (0.2 + 0.6 * fibre);
    // Dry-brush breaks: where coverage is thin, the brush skips the high tooth.
    float thin = clamp(a0 * (1.0 - a0) * 4.0, 0.0, 1.0);
    float dry = 1.0 - thin * 0.5 * step(0.6, tooth);
    float cover = clamp(a0 * dry + rim * 0.7 + halo * 0.6, 0.0, 1.0);
    // Density knee: washes stay as they are, the top is flattened so stacked ink cannot band.
    cover = cover < 0.75 ? cover : 0.75 + 0.22 * (1.0 - exp(-(cover - 0.75) * 4.5));

    vec3 col = mix(scene, uInk, cover);
    // Paper grain over everything: ink, mist and paper all soak into the same tooth.
    float grain = tooth * 0.65 + fibre * 0.35 - 0.5;
    col *= 1.0 + uGrain * grain;
    // Slight darkening toward the frame edges, like a worn scroll.
    vec2 q = vUv * 2.0 - 1.0;
    col *= mix(0.93, 1.0, smoothstep(1.45, 0.55, length(q * vec2(0.92, 1.0))));
    gl_FragColor = vec4(col, 1.0);
  }
`;

export interface InkComposerOptions {
  quality?: InkQuality;
  seed?: number;
}

export interface InkComposer {
  readonly quality: InkQuality;
  mist: Mist;
  spray: Spray;
  /** Draw the frame: scene pass, ink pass, composite to the canvas. */
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  /** Step mist (parallax from the camera x) and spray. Call once per frame before render. */
  update(dt: number, camera: THREE.OrthographicCamera): void;
  setQuality(q: InkQuality): void;
  /** Move an object (and its children) to the ink layer with max blending. Draws only through render(). */
  addInk(obj: THREE.Object3D): void;
  /** Ink spray on a hit: count drops from (x, y) toward angle dir (radians). */
  emit(x: number, y: number, dir: number, count: number): void;
  dispose(): void;
}

function makeTarget(): THREE.WebGLRenderTarget {
  const t = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  return t;
}

/** Unit vectors evenly round a circle, half a step off the axes. */
function tapDirs(n: number): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((i + 0.5) * Math.PI * 2) / n;
    out.push(new THREE.Vector2(Math.cos(a), Math.sin(a)));
  }
  return out;
}

function setInkBlending(m: THREE.Material): void {
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.MaxEquation;
  m.blendEquationAlpha = THREE.MaxEquation;
  m.transparent = true;
}

export function createInkComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  opts: InkComposerOptions = {},
): InkComposer {
  let quality: InkQuality = opts.quality ?? 'medium';
  const seed = opts.seed ?? 0;
  const sceneRT = makeTarget();
  const inkRT = makeTarget();

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
    defines: { TAPS: INK_PRESETS[quality].bleedTaps },
    uniforms: {
      tScene: { value: sceneRT.texture },
      tInk: { value: inkRT.texture },
      uTexel: { value: new THREE.Vector2(1, 1) },
      uBleed: { value: 3 },
      uGrain: { value: INK_PRESETS[quality].grain },
      uSeed: { value: (seed % 1000) / 1000 },
      uInk: { value: new THREE.Color('#1b1611') },
      uDirs: { value: tapDirs(INK_PRESETS[quality].bleedTaps) },
    },
  });
  // One triangle that covers the screen.
  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const quad = new THREE.Mesh(tri, material);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);
  const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const mist = createMist(seed);
  scene.add(mist.group);
  const spray = createSpray(seed + 1, INK_PRESETS[quality].sprayLimit);
  scene.add(spray.mesh);

  const addInk = (obj: THREE.Object3D) => {
    obj.traverse((o) => {
      o.layers.set(INK_LAYER);
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(m)) m.forEach(setInkBlending);
      else if (m) setInkBlending(m);
    });
  };
  addInk(spray.mesh);

  // Reused every frame: no allocation in render.
  const size = new THREE.Vector2();
  const clear = new THREE.Color();
  let w = 0;
  let h = 0;
  let dirty = true;

  const apply = () => {
    const p = INK_PRESETS[quality];
    const t = targetSize(w, h, quality);
    sceneRT.setSize(t.width, t.height);
    inkRT.setSize(t.width, t.height);
    material.uniforms.uTexel.value.set(1 / t.width, 1 / t.height);
    material.uniforms.uBleed.value = p.bleedPx * (h / 1080) * p.scale;
    material.uniforms.uGrain.value = p.grain;
    if (material.defines.TAPS !== p.bleedTaps) {
      material.defines.TAPS = p.bleedTaps;
      material.uniforms.uDirs.value = tapDirs(p.bleedTaps);
      material.needsUpdate = true;
    }
    mist.setLayers(mistLayersFor(quality));
    spray.setLimit(p.sprayLimit);
    dirty = false;
  };

  return {
    get quality() {
      return quality;
    },
    mist,
    spray,
    render(sc, camera) {
      renderer.getDrawingBufferSize(size);
      if (size.x !== w || size.y !== h) {
        w = size.x;
        h = size.y;
        dirty = true;
      }
      if (dirty) apply();
      const mask = camera.layers.mask;
      const prev = renderer.getRenderTarget();

      camera.layers.set(0);
      renderer.setRenderTarget(sceneRT);
      renderer.render(sc, camera);

      renderer.getClearColor(clear);
      const clearAlpha = renderer.getClearAlpha();
      renderer.setClearColor(0x000000, 0);
      camera.layers.set(INK_LAYER);
      renderer.setRenderTarget(inkRT);
      renderer.render(sc, camera);
      renderer.setClearColor(clear, clearAlpha);
      camera.layers.mask = mask;

      renderer.setRenderTarget(prev);
      renderer.render(quadScene, quadCamera);
    },
    update(dt, camera) {
      mist.update(dt, camera);
      spray.update(dt);
    },
    setQuality(q) {
      if (q === quality) return;
      quality = q;
      dirty = true;
    },
    addInk,
    emit(x, y, dir, count) {
      spray.emit(x, y, dir, count);
    },
    dispose() {
      scene.remove(mist.group, spray.mesh);
      mist.dispose();
      spray.dispose();
      sceneRT.dispose();
      inkRT.dispose();
      tri.dispose();
      material.dispose();
    },
  };
}
