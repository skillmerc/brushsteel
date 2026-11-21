import * as THREE from 'three';
import { createRng } from '../core/rng.js';
import { SPRAY_CAPACITY, SprayPool } from '../core/inkfx.js';
import { FEEL, SpatterRing } from '../core/feel.js';

// Ink spray: one InstancedMesh with a fixed pool of 2000 drops (core/inkfx.ts
// SprayPool). Each frame the live drops are packed into the instance buffers
// and mesh.count is set to the live count, so dead drops cost nothing and
// nothing is allocated per frame. Drops are ragged ink blots stretched along
// their flight. The mesh belongs on the ink layer (render/inkpass.ts addInk).

const vertexShader = /* glsl */ `
  attribute vec2 aDrop; // alpha, seed
  varying vec2 vUv;
  varying vec2 vDrop;
  void main() {
    vUv = uv;
    vDrop = aDrop;
    vec4 p = vec4(position, 1.0);
    #ifdef USE_INSTANCING
      p = instanceMatrix * p;
    #endif
    gl_Position = projectionMatrix * modelViewMatrix * p;
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  uniform vec3 uInk;
  varying vec2 vUv;
  varying vec2 vDrop;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  void main() {
    vec2 q = vUv * 2.0 - 1.0;
    float r = length(q);
    // Ragged rim: the radius wobbles with the angle, different per drop.
    float ang = atan(q.y, q.x);
    float wob = hash(vec2(floor((ang + 3.1416) * 2.5), vDrop.y)) * 0.25;
    float a = 1.0 - smoothstep(0.55 - wob, 0.95 - wob, r);
    // A little paler at the heart, as wet ink pools at the rim.
    a *= 0.85 + 0.15 * smoothstep(0.1, 0.6, r);
    a *= vDrop.x;
    if (a < 0.02) discard;
    gl_FragColor = vec4(uInk, a);
  }
`;

export interface Spray {
  mesh: THREE.InstancedMesh;
  pool: SprayPool;
  /** Spray `count` drops from stage point (x, y) toward angle dir (radians, 0 = +x). */
  emit(x: number, y: number, dir: number, count: number): void;
  setLimit(n: number): void;
  /** Step the drops and upload the live ones. No allocation. */
  update(dt: number): void;
  dispose(): void;
}

export function createSpray(seed = 1, limit = SPRAY_CAPACITY): Spray {
  const pool = new SprayPool(createRng(seed >>> 0), SPRAY_CAPACITY, limit);
  const geometry = new THREE.PlaneGeometry(1, 1);
  const drops = new Float32Array(SPRAY_CAPACITY * 2);
  const aDrop = new THREE.InstancedBufferAttribute(drops, 2);
  aDrop.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('aDrop', aDrop);
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    uniforms: { uInk: { value: new THREE.Color('#1b1611') } },
  });
  const mesh = new THREE.InstancedMesh(geometry, material, SPRAY_CAPACITY);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  mesh.position.z = 2;
  mesh.count = 0;
  const matrices = mesh.instanceMatrix.array as Float32Array;

  return {
    mesh,
    pool,
    emit(x, y, dir, count) {
      pool.emit(x, y, dir, count);
    },
    setLimit(n) {
      pool.setLimit(n);
    },
    update(dt) {
      pool.step(dt);
      const n = pool.write(matrices, drops, 0);
      mesh.count = n;
      if (n > 0) {
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, n * 16);
        mesh.instanceMatrix.needsUpdate = true;
        aDrop.clearUpdateRanges();
        aDrop.addUpdateRange(0, n * 2);
        aDrop.needsUpdate = true;
      }
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      mesh.dispose();
    },
  };
}

// Ink spatter that stays: the blots a hit leaves on the paper, kept
// for the duel in a fixed ring of FEEL.SPATTER_CAP (core/feel.ts SpatterRing).
// Same blot shader as the spray, one InstancedMesh, one draw call; the
// instance buffers upload only when a hit adds blots or a restart clears them.

export interface Spatter {
  mesh: THREE.InstancedMesh;
  ring: SpatterRing;
  /** Upload the ring if it changed since the last call. Cheap when nothing changed. */
  sync(): void;
  dispose(): void;
}

export function createSpatter(capacity: number = FEEL.SPATTER_CAP): Spatter {
  const ring = new SpatterRing(capacity);
  const geometry = new THREE.PlaneGeometry(1, 1);
  const drops = new Float32Array(ring.capacity * 2);
  const aDrop = new THREE.InstancedBufferAttribute(drops, 2);
  geometry.setAttribute('aDrop', aDrop);
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    uniforms: { uInk: { value: new THREE.Color('#1b1611') } },
  });
  const mesh = new THREE.InstancedMesh(geometry, material, ring.capacity);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  mesh.position.z = 1.9;
  mesh.count = 0;
  const matrices = mesh.instanceMatrix.array as Float32Array;
  // No blots yet: not drawn at all until a hit adds some.
  mesh.visible = false;
  let seen = ring.version;
  return {
    mesh,
    ring,
    sync() {
      if (ring.version === seen) return;
      seen = ring.version;
      const n = ring.write(matrices, drops, 0);
      mesh.count = n;
      mesh.visible = n > 0;
      if (n > 0) {
        mesh.instanceMatrix.needsUpdate = true;
        aDrop.needsUpdate = true;
      }
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      mesh.dispose();
    },
  };
}
