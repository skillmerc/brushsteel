// Fit the duel stage to any window. The camera always shows the whole stage
// (stageWidth x stageHeight world units); extra window space widens or
// heightens the view instead of cropping. Pure maths, no DOM.

export interface ViewFit {
  /** Canvas size in CSS pixels. */
  width: number;
  height: number;
  /** Device pixel ratio actually used (capped). */
  pixelRatio: number;
  /** Orthographic frustum in world units, centred on the stage. */
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const MAX_PIXEL_RATIO = 2;

export function capPixelRatio(dpr: number, max = MAX_PIXEL_RATIO): number {
  if (!Number.isFinite(dpr) || dpr <= 0) return 1;
  return Math.min(dpr, max);
}

export function fitStage(
  viewWidth: number,
  viewHeight: number,
  devicePixelRatio: number,
  stageWidth = 16,
  stageHeight = 9,
): ViewFit {
  const width = Math.max(1, Math.floor(viewWidth));
  const height = Math.max(1, Math.floor(viewHeight));
  const viewAspect = width / height;
  const stageAspect = stageWidth / stageHeight;
  let halfW: number;
  let halfH: number;
  if (viewAspect >= stageAspect) {
    halfH = stageHeight / 2;
    halfW = halfH * viewAspect;
  } else {
    halfW = stageWidth / 2;
    halfH = halfW / viewAspect;
  }
  return {
    width,
    height,
    pixelRatio: capPixelRatio(devicePixelRatio),
    left: -halfW,
    right: halfW,
    top: halfH,
    bottom: -halfH,
  };
}
