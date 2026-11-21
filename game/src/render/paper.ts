import * as THREE from 'three';

// Warm paper with procedural grain and long fibres, a little darker at the
// edges. Drawn on a plane that always covers the camera view.

const vertexShader = /* glsl */ `
  varying vec2 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xy;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  varying vec2 vWorld;
  uniform vec2 uHalfView;
  uniform float uSeed;
  uniform vec3 uPaper;
  uniform vec3 uShade;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21) + uSeed);
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

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
      v += a * noise(p);
      p *= 2.03;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    // Soft cloudy pulp, fine tooth and stretched fibres.
    float cloud = fbm(vWorld * 0.6);
    float tooth = noise(vWorld * 90.0);
    float fibre = noise(vec2(vWorld.x * 2.0, vWorld.y * 40.0));
    float grain = cloud * 0.55 + tooth * 0.25 + fibre * 0.20;
    vec3 col = mix(uShade, uPaper, 0.82 + 0.18 * grain);

    // Edge darkening relative to the visible view.
    vec2 q = vWorld / max(uHalfView, vec2(0.001));
    float vignette = smoothstep(1.6, 0.6, length(q * vec2(0.85, 1.0)));
    col *= mix(0.86, 1.0, vignette);

    gl_FragColor = vec4(col, 1.0);
  }
`;

export interface Paper {
  mesh: THREE.Mesh;
  /** Stretch the paper to cover a view of the given half extents. */
  cover(halfWidth: number, halfHeight: number): void;
}

export function createPaper(seed = 0): Paper {
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    depthWrite: false,
    uniforms: {
      uHalfView: { value: new THREE.Vector2(8, 4.5) },
      uSeed: { value: (seed % 1000) / 1000 },
      uPaper: { value: new THREE.Color('#f1e7d0') },
      uShade: { value: new THREE.Color('#cdbd9c') },
    },
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  mesh.position.z = -10;
  mesh.renderOrder = -1;
  return {
    mesh,
    cover(halfWidth: number, halfHeight: number) {
      mesh.scale.set(halfWidth * 2 * 1.02, halfHeight * 2 * 1.02, 1);
      material.uniforms.uHalfView.value.set(halfWidth, halfHeight);
    },
  };
}
