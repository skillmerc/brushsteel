import { BONE, POSE_NAMES } from '../core/figure.js';
import { DUEL_RULES } from '../core/duel.js';
import { createFigureView, type FigureView } from './figure.js';
import type { Stage } from './index.js';

// Debug scene (?debug=poses): two figures at the duel start positions, facing
// each other, cycling every pose. The left one walks the list in order, the
// right one starts half way round. The pose names show in a small label and in
// canvas data attributes (data-pose, data-poses-shown) for the CI smoke test.
// With an onStrike callback (main.ts passes the ink composer's emit), each
// strike pose throws an ink spray burst from the sword tip once the blade is out.

/** Seconds each pose is held. */
export const POSE_HOLD_S = 0.9;
/** Delay after a strike pose starts before its spray burst (the blade swings first). */
export const SPRAY_DELAY_S = 0.18;

/** Called with the sword tip and the direction the blade flies (radians). */
export type StrikeHook = (x: number, y: number, dir: number) => void;

export interface PoseDebug {
  figures: [FigureView, FigureView];
  update(dt: number): void;
}

export function createPoseDebug(stage: Stage, canvas: HTMLCanvasElement, onStrike?: StrikeHook): PoseDebug {
  const left = createFigureView({ x: -DUEL_RULES.START_X, facing: 1, seed: 11 });
  const right = createFigureView({ x: DUEL_RULES.START_X, facing: -1, seed: 29 });
  stage.scene.add(left.mesh, right.mesh);

  const label = document.createElement('div');
  label.style.cssText = 'position:fixed;left:12px;bottom:10px;font:14px/1.3 Georgia,serif;color:#1b1611;opacity:.75;pointer-events:none';
  document.body.appendChild(label);

  const half = Math.floor(POSE_NAMES.length / 2);
  let t = 0;
  let index = -1;
  let shown = 0;
  // Countdown to each figure's spray burst; below 0 means none pending. Plain numbers, no allocation.
  const sprayIn = [-1, -1];
  const show = (i: number) => {
    const a = POSE_NAMES[i % POSE_NAMES.length];
    const b = POSE_NAMES[(i + half) % POSE_NAMES.length];
    left.setPose(a);
    right.setPose(b);
    sprayIn[0] = a.startsWith('strike_') ? SPRAY_DELAY_S : -1;
    sprayIn[1] = b.startsWith('strike_') ? SPRAY_DELAY_S : -1;
    shown++;
    label.textContent = `poses: ${a} / ${b}`;
    canvas.dataset.pose = `${a}/${b}`;
    canvas.dataset.posesShown = String(shown);
  };

  return {
    figures: [left, right],
    update(dt) {
      t += dt;
      const i = Math.floor(t / POSE_HOLD_S);
      if (i !== index) {
        index = i;
        show(i);
      }
      left.update(dt);
      right.update(dt);
      if (onStrike) {
        for (let f = 0; f < 2; f++) {
          if (sprayIn[f] < 0) continue;
          sprayIn[f] -= dt;
          if (sprayIn[f] >= 0) continue;
          sprayIn[f] = -1;
          const st = (f === 0 ? left : right).state;
          const k = BONE.sword * 4;
          // From the tip, along the blade's own swing: away from the hilt, tilted up a little.
          const dir = Math.atan2(st.joints[k + 3] - st.joints[k + 1], st.joints[k + 2] - st.joints[k]) + 0.25 * st.facing;
          onStrike(st.joints[k + 2], st.joints[k + 3], dir);
        }
      }
    },
  };
}
