// A drag (a cut) that starts or ends over a button must not click it.
// Pointer down is noted on the root; a click that follows a press which moved
// more than DRAG_CLICK_SLOP_PX is stopped in the capture phase, before any
// button under the pointer sees it. The rule itself is in core/front.ts.

import { isDragNotClick } from '../core/front.js';

export function guardDragClicks(root: HTMLElement): void {
  let down: { x: number; y: number } | null = null;
  let dragged = false;
  root.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY };
    dragged = false;
  }, true);
  root.addEventListener('pointermove', (e) => {
    if (down && isDragNotClick(down, { x: e.clientX, y: e.clientY })) dragged = true;
  }, true);
  // A press that began outside (on the canvas, mid-cut) and is let go here is no click either.
  root.addEventListener('pointerup', (e) => {
    if (!down || isDragNotClick(down, { x: e.clientX, y: e.clientY })) dragged = true;
  }, true);
  root.addEventListener('click', (e) => {
    // Keyboard and pad clicks have no pointer press (detail 0): always allowed.
    const fromPointer = e.detail > 0;
    if (fromPointer && dragged) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    down = null;
    dragged = false;
  }, true);
}
