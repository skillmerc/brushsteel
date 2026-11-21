// Optional controller support. Pure: it reads a Gamepad-like snapshot
// (axes and buttons, standard mapping) and returns what the game should do. No DOM, so tests
// feed it synthetic snapshots.
//
// Standard mapping (https://w3c.github.io/gamepad/#remapping):
//   axes 0,1 left stick, axes 2,3 right stick (y down, like the screen)
//   buttons 0 A, 1 B, 2 X, 3 Y, 4 LB, 5 RB, 6 LT, 7 RT, 9 Start, 11 right stick click,
//   12 d-pad up, 13 down, 14 left, 15 right
//
// Menus: d-pad or left stick moves (one step on press, then repeats after REPEAT_DELAY_MS every
// REPEAT_EVERY_MS while held), A confirms, B goes back, Start pauses. Buttons never repeat.
// Duel: left stick or d-pad steps left and right, LB or RB held dashes, X or LT held dips,
// RT or the right stick click thrusts (a dot stroke), A or Y restarts once a duel is over.
// Strokes: the right stick moves a cursor around a centre point (cursor = centre + stick * radius).
// Leaving the deadzone starts a stroke, every poll that moves it adds a point, and the stick going back
// (springing toward the centre) or into the deadzone ends it. The points go to the same classifier
// as a mouse drag, so a flick down is an overhead, a flick across is a cut, a circle is a parry.

import type { StrokePoint } from './strokes.js';

export interface PadButtonLike {
  pressed: boolean;
  value?: number;
}

/** The parts of a Gamepad this module reads. Buttons may be objects or plain numbers. */
export interface PadSnapshot {
  axes: readonly number[];
  buttons: readonly (PadButtonLike | number)[];
}

export type MenuIntent = 'up' | 'down' | 'left' | 'right' | 'confirm' | 'back' | 'pause';

export interface PadMoves {
  left: boolean;
  right: boolean;
  dash: boolean;
  dip: boolean;
  /** Pressed this poll (edge): thrust as a dot stroke at the cursor centre. */
  thrust: boolean;
  /** Pressed this poll (edge): restart or continue after a duel. */
  restart: boolean;
}

export type PadStrokeEvent =
  | { type: 'begin'; p: StrokePoint }
  | { type: 'extend'; p: StrokePoint }
  | { type: 'end'; t: number };

/** Where the right-stick cursor lives, in the same CSS px the mouse strokes use. */
export interface PadArea {
  cx: number;
  cy: number;
  radius: number;
}

export interface PadFrame {
  menu: MenuIntent[];
  moves: PadMoves;
  strokes: PadStrokeEvent[];
}

export const PAD_TUNING = {
  /** Stick magnitude below this is rest. */
  DEADZONE: 0.25,
  /** Left stick past this on an axis counts as a direction (menus and steps). */
  AXIS_ON: 0.5,
  /** A held direction repeats after this long. */
  REPEAT_DELAY_MS: 400,
  /**
   * And only once the direction has been read held in this many polls. On a slow machine
   * (frames 130 ms or more apart, as in software rendering) a short tap spans 3 or 4 polls and
   * 400 ms of frame time, so the delay alone moved focus twice for one tap. At 30 fps or more the
   * delay is the later of the two, so nothing changes there.
   */
  REPEAT_MIN_POLLS: 6,
  /** Then once per this long. */
  REPEAT_EVERY_MS: 150,
  /** Once a stroke has reached this magnitude, falling under RETURN_RATIO of its peak ends it (the spring back). */
  RETURN_MIN_PEAK: 0.6,
  RETURN_RATIO: 0.7,
} as const;

export const PAD_BUTTON = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, START: 9, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
} as const;

/** Area for the right-stick cursor: centre of the play area, radius scaled to its size. */
export function padArea(width: number, height: number): PadArea {
  return { cx: width / 2, cy: height / 2, radius: Math.max(40, Math.min(0.22 * width, 0.42 * height)) };
}

export function buttonDown(s: PadSnapshot, i: number): boolean {
  const b = s.buttons[i];
  if (b === undefined || b === null) return false;
  if (typeof b === 'number') return b > 0.5;
  return !!b.pressed || (typeof b.value === 'number' && b.value > 0.5);
}

function axis(s: PadSnapshot, i: number): number {
  const v = s.axes[i];
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
}

/** The four directions held, from the d-pad or the left stick. */
function directions(s: PadSnapshot): Record<'up' | 'down' | 'left' | 'right', boolean> {
  const x = axis(s, 0);
  const y = axis(s, 1);
  const on = PAD_TUNING.AXIS_ON;
  return {
    up: buttonDown(s, PAD_BUTTON.UP) || y < -on,
    down: buttonDown(s, PAD_BUTTON.DOWN) || y > on,
    left: buttonDown(s, PAD_BUTTON.LEFT) || x < -on,
    right: buttonDown(s, PAD_BUTTON.RIGHT) || x > on,
  };
}

export interface PadReader {
  /** Read one snapshot at time t (ms). Pass null when the pad is gone: open strokes end, nothing is held. */
  read(s: PadSnapshot | null, t: number, area: PadArea): PadFrame;
  /** Forget held state (after a screen change or blur): the next press counts as new. */
  reset(): void;
}

const DIRS = ['up', 'down', 'left', 'right'] as const;
const EDGE_BUTTONS: readonly [MenuIntent, number][] = [
  ['confirm', PAD_BUTTON.A],
  ['back', PAD_BUTTON.B],
  ['pause', PAD_BUTTON.START],
];

export function createPadReader(): PadReader {
  // Time a direction went down (-1 when up) and when it last fired.
  const heldSince: Record<string, number> = { up: -1, down: -1, left: -1, right: -1 };
  const lastFire: Record<string, number> = { up: 0, down: 0, left: 0, right: 0 };
  // Polls in a row a direction has been read held.
  const heldPolls: Record<string, number> = { up: 0, down: 0, left: 0, right: 0 };
  const prevButtons = new Map<number, boolean>();
  let drawing = false;
  let peak = 0;
  // Ignore a stick that is already out when reading starts or after a stroke ends by spring back,
  // until it comes back to rest.
  let waitRest = true;
  let lastX = 0;
  let lastY = 0;

  const edge = (s: PadSnapshot | null, i: number): boolean => {
    const now = s ? buttonDown(s, i) : false;
    const was = prevButtons.get(i) ?? true; // a button already down on the first read does not fire
    prevButtons.set(i, now);
    return now && !was;
  };

  return {
    reset() {
      for (const d of DIRS) {
        heldSince[d] = -1;
        heldPolls[d] = 0;
      }
      prevButtons.clear();
      drawing = false;
      peak = 0;
      waitRest = true;
    },
    read(s, t, area) {
      const menu: MenuIntent[] = [];
      const strokes: PadStrokeEvent[] = [];
      const dirs = s ? directions(s) : { up: false, down: false, left: false, right: false };
      for (const d of DIRS) {
        if (!dirs[d]) {
          heldSince[d] = -1;
          heldPolls[d] = 0;
          continue;
        }
        heldPolls[d]++;
        if (heldSince[d] < 0) {
          heldSince[d] = t;
          lastFire[d] = t;
          menu.push(d);
        } else if (
          t - heldSince[d] >= PAD_TUNING.REPEAT_DELAY_MS &&
          heldPolls[d] >= PAD_TUNING.REPEAT_MIN_POLLS &&
          t - lastFire[d] >= PAD_TUNING.REPEAT_EVERY_MS
        ) {
          lastFire[d] = t;
          menu.push(d);
        }
      }
      for (const [intent, i] of EDGE_BUTTONS) if (edge(s, i)) menu.push(intent);
      const thrust = edge(s, PAD_BUTTON.RT) || edge(s, PAD_BUTTON.RS);
      const restart = edge(s, PAD_BUTTON.Y);
      const moves: PadMoves = {
        left: dirs.left && !dirs.right,
        right: dirs.right && !dirs.left,
        dash: !!s && (buttonDown(s, PAD_BUTTON.LB) || buttonDown(s, PAD_BUTTON.RB)),
        dip: !!s && (buttonDown(s, PAD_BUTTON.X) || buttonDown(s, PAD_BUTTON.LT)),
        thrust,
        restart: restart || menu.includes('confirm'),
      };

      // Right stick strokes.
      const rx = s ? axis(s, 2) : 0;
      const ry = s ? axis(s, 3) : 0;
      const mag = Math.hypot(rx, ry);
      const p: StrokePoint = { x: area.cx + rx * area.radius, y: area.cy + ry * area.radius, t };
      const out = mag >= PAD_TUNING.DEADZONE;
      if (!out) waitRest = false;
      if (drawing) {
        const springing = peak >= PAD_TUNING.RETURN_MIN_PEAK && mag < peak * PAD_TUNING.RETURN_RATIO;
        if (!out || springing) {
          drawing = false;
          // The end point is the last point drawn: the spring back is not part of the stroke.
          strokes.push({ type: 'end', t });
          if (out) waitRest = true;
        } else {
          peak = Math.max(peak, mag);
          // A stick held still adds nothing, so holding at the end does not make the stroke slow.
          if (Math.hypot(p.x - lastX, p.y - lastY) >= 1) {
            lastX = p.x;
            lastY = p.y;
            strokes.push({ type: 'extend', p });
          }
        }
      } else if (out && !waitRest) {
        drawing = true;
        peak = mag;
        lastX = p.x;
        lastY = p.y;
        strokes.push({ type: 'begin', p });
      }
      return { menu, moves, strokes };
    },
  };
}

/** Collect the points of every finished stroke in a run of frames (tests and tools). */
export function strokesFrom(frames: readonly PadFrame[]): StrokePoint[][] {
  const out: StrokePoint[][] = [];
  let cur: StrokePoint[] | null = null;
  for (const f of frames) {
    for (const e of f.strokes) {
      if (e.type === 'begin') cur = [e.p];
      else if (e.type === 'extend') cur?.push(e.p);
      else if (cur) {
        out.push(cur);
        cur = null;
      }
    }
  }
  return out;
}
