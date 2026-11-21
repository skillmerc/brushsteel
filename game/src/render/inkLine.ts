import * as THREE from 'three';

// Placeholder: one faint brush line with tapered ends and a ragged edge.
// The real strokes come later (input/ and render/).

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform vec3 uInk;
  uniform float uOpacity;

  float hash(float n) { return fract(sin(n) * 43758.5453); }

  void main() {
    // Thick in the middle, thin at the ends, heavier at the start.
    float taper = smoothstep(0.0, 0.08, vUv.x) * smoothstep(1.0, 0.55, vUv.x);
    float width = 0.15 + 0.85 * taper;
    float d = abs(vUv.y - 0.5) * 2.0;
    float edge = 1.0 - smoothstep(width - 0.15, width, d);
    float dry = 0.75 + 0.25 * hash(floor(vUv.x * 160.0) + floor(vUv.y * 6.0) * 17.0);
    float a = edge * dry * uOpacity;
    if (a < 0.01) discard;
    gl_FragColor = vec4(uInk, a);
  }
`;

export function createInkLine(): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uInk: { value: new THREE.Color('#1b1611') },
      uOpacity: { value: 0.22 },
    },
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(9, 0.18), material);
  mesh.position.set(-0.4, -1.2, 0);
  mesh.rotation.z = 0.06;
  return mesh;
}
