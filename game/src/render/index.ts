import * as THREE from 'three';
import { fitStage } from '../core/fit.js';
import { createInkLine } from './inkLine.js';
import { createPaper } from './paper.js';
import { createLandscape, type Landscape } from './landscape.js';

// The Three.js side: renderer, orthographic camera on a 2.5D stage, paper,
// and live resize that follows the window.

export interface Stage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  /** Ink-wash landscape behind the fighters, painted once per stage or resize. */
  landscape: Landscape;
  resize(): void;
  dispose(): void;
}

export function createStage(canvas: HTMLCanvasElement, seed = 0): Stage {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setClearColor('#efe6d2', 1);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-8, 8, 4.5, -4.5, 0.1, 100);
  camera.position.set(0, 0, 20);
  camera.lookAt(0, 0, 0);

  const paper = createPaper(seed);
  scene.add(paper.mesh);
  const landscape = createLandscape(renderer, seed);
  scene.add(landscape.mesh);
  // Ground stroke: level, under the fighters' feet (figures stand on y -1.2).
  const ground = createInkLine();
  ground.position.set(0, -1.22, 0);
  ground.rotation.z = 0;
  ground.scale.x = 15.6 / 9;
  scene.add(ground);

  const resize = () => {
    const fit = fitStage(window.innerWidth, window.innerHeight, window.devicePixelRatio);
    renderer.setPixelRatio(fit.pixelRatio);
    renderer.setSize(fit.width, fit.height, false);
    camera.left = fit.left;
    camera.right = fit.right;
    camera.top = fit.top;
    camera.bottom = fit.bottom;
    camera.updateProjectionMatrix();
    paper.cover(fit.right, fit.top);
    landscape.resize(fit.right, fit.top, fit.width, fit.height);
    canvas.dataset.size = `${fit.width}x${fit.height}@${fit.pixelRatio}`;
  };
  resize();
  window.addEventListener('resize', resize);

  return {
    renderer,
    scene,
    camera,
    landscape,
    resize,
    dispose() {
      window.removeEventListener('resize', resize);
      renderer.setAnimationLoop(null);
      landscape.dispose();
      renderer.dispose();
    },
  };
}
