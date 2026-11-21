import * as THREE from 'three';
import { MIST_LAYERS, mistOffset } from '../core/inkfx.js';

// Mist: 2 to 4 horizontal bands of grey ink wash with wispy, fbm-shaped edges,
// drawn over the paper and behind the figures (figures go through the ink
// target of render/inkpass.ts, which is composited on top). Each band follows
// the camera; only its noise slides, by parallax * camera x plus wind drift
// (core/inkfx.ts mistOffset). Procedural, no textures.

const vertexShader = /* glsl */ `
  varying vec2 vLocal;
  void main() {
    vLocal = position.xy; // -0.5..0.5 across the band
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  varying vec2 vLocal;
  uniform vec3 uWash;
  uniform float uAlpha;
  uniform float uOffset;
  uniform float uScale;
  uniform vec2 uSize;   // band width and height, stage units
  uniform float uSeed;

  float hash(vec2 p) {
    p = fract(p * vec2(127.1, 311.7) + uSeed);
    p += dot(p, p + 34.23);
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
    float x = vLocal.x * uSize.x + uOffset;
    float y = vLocal.y * uSize.y;
    // Three octaves: long banks, rolling lumps, fine wisps.
    vec2 p = vec2(x * uScale, y * uScale * 1.6);
    float n = noise(p) * 0.55 + noise(p * 2.3 + 7.1) * 0.3 + noise(p * 5.2 + 3.3) * 0.15;
    // Soft band: the top edge is torn by the noise, the bottom fades out slowly.
    float v = vLocal.y + 0.5; // 0 bottom .. 1 top
    float top = 1.0 - smoothstep(0.35 + 0.45 * n, 0.95, v);
    float bottom = smoothstep(0.0, 0.35, v);
    float a = top * bottom * smoothstep(0.25, 0.75, n) * uAlpha;
    // Fade at the band's left and right ends so no seam shows when the view is wider.
    a *= smoothstep(0.5, 0.42, abs(vLocal.x));
    if (a < 0.004) discard;
    gl_FragColor = vec4(uWash, a);
  }
`;

export interface Mist {
  group: THREE.Group;
  /** Show the first n layers (clamped to 2..4). */
  setLayers(n: number): void;
  /** Follow the camera and slide the wisps. No allocation. */
  update(dt: number, camera: THREE.OrthographicCamera): void;
  dispose(): void;
}

export function createMist(seed = 0): Mist {
  const group = new THREE.Group();
  group.renderOrder = 0;
  const geometry = new THREE.PlaneGeometry(1, 1);
  const layers = MIST_LAYERS.map((l, i) => {
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uWash: { value: new THREE.Color('#8f877a') },
        uAlpha: { value: l.alpha },
        uOffset: { value: 0 },
        uScale: { value: l.scale },
        uSize: { value: new THREE.Vector2(20, l.height) },
        uSeed: { value: ((seed + i * 97) % 1000) / 1000 },
      },
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    // Between the paper (z -10, renderOrder -1) and the ground line and figures.
    mesh.position.set(0, l.y, -6 + i);
    mesh.renderOrder = -0.5 + i * 0.01;
    group.add(mesh);
    return { mesh, material };
  });

  let time = 0;
  let shown = layers.length;
  return {
    group,
    setLayers(n) {
      shown = Math.max(2, Math.min(layers.length, Math.floor(n)));
      for (let i = 0; i < layers.length; i++) layers[i].mesh.visible = i < shown;
    },
    update(dt, camera) {
      time += dt;
      const cx = camera.position.x;
      const width = (camera.right - camera.left) * 1.3;
      for (let i = 0; i < shown; i++) {
        const L = layers[i];
        L.mesh.position.x = cx;
        L.mesh.scale.set(width, MIST_LAYERS[i].height, 1);
        L.material.uniforms.uSize.value.x = width;
        L.material.uniforms.uOffset.value = mistOffset(i, cx, time);
      }
    },
    dispose() {
      geometry.dispose();
      for (const l of layers) l.material.dispose();
    },
  };
}
