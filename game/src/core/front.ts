// Front end: the menu state machine, settings, the masters
// you have met, the title cut test and quitting a fight from Pause. Pure: the
// storage is passed in, so tests need no browser.

import { MASTERS } from './masters.js';
import type { KeyValueStore } from './save.js';
import { dailySeed, dateKey } from './path.js';
import { bookLeftFight, nextScrollIn, scrollLabel, type PathSession } from './session.js';

// ---------- Screens ----------

export type FrontScreen = 'title' | 'menu' | 'masters' | 'settings' | 'howto' | 'credits';

export type FrontAction =
  | { type: 'start' }
  | { type: 'open'; screen: 'masters' | 'settings' | 'howto' | 'credits' }
  | { type: 'back' };

/** The next front-end screen. The title only leaves by 'start'; every sub screen goes back to the menu. */
export function frontReducer(screen: FrontScreen, action: FrontAction): FrontScreen {
  if (screen === 'title') return action.type === 'start' ? 'menu' : 'title';
  if (action.type === 'open' && screen === 'menu') return action.screen;
  if (action.type === 'back' && screen !== 'menu') return 'menu';
  return screen;
}

/** Where a page opens: the title for a bare address, the menu for ?menu=1 (or ?menu=settings), else a mode. */
export function startScreen(search: string): FrontScreen | null {
  const p = new URLSearchParams(search);
  const menu = p.get('menu');
  // ?menu=settings|masters|howto|credits opens that screen (Back still leads to the menu); CI shots use them.
  if (menu === 'settings' || menu === 'masters' || menu === 'howto' || menu === 'credits') return menu;
  if (menu !== null) return 'menu';
  for (const k of ['mode', 'master', 'demo', 'debug']) if (p.get(k) !== null) return null;
  return 'title';
}

// ---------- Pause ----------

export type PauseState = 'playing' | 'paused' | 'settings';
export type PauseAction = { type: 'esc' } | { type: 'resume' } | { type: 'settings' } | { type: 'quit' };

/** Esc opens Pause and closes it again (from Settings, Esc goes back to Pause). Quit is handled by the caller. */
export function pauseReducer(state: PauseState, action: PauseAction): PauseState {
  if (action.type === 'esc') return state === 'playing' ? 'paused' : state === 'settings' ? 'paused' : 'playing';
  if (action.type === 'resume') return 'playing';
  if (action.type === 'settings') return state === 'paused' ? 'settings' : state;
  return state;
}

/**
 * Quit to menu from Pause. In Path mode a fight under way is booked at once as one
 * loss, the same rule openSession applies to a fight left by reload (bookLeftFight).
 * Returns true if a life was taken.
 */
export function quitFight(session: PathSession | null): boolean {
  const run = session?.run;
  const map = session?.map;
  if (!session || !run || !map) return false;
  if (bookLeftFight(run, map) === run) return false;
  session.dispatch({ type: 'duel-lost' });
  return true;
}

// ---------- Settings ----------

export type QualitySetting = 'low' | 'high';
export interface Settings {
  /** Master volume, 0 to 100 (used by audio). */
  volume: number;
  /** Ink quality, applied when a duel next starts (never mid-duel). */
  quality: QualitySetting;
  /**
   * Who set quality: 'player' in Settings, or 'auto' from the frame-time probe.
   * Absent means never chosen (the default, or a save from before).
   */
  qualityBy?: 'auto' | 'player';
}

export const SETTINGS_KEY = 'brushsteel.settings';
export const DEFAULT_SETTINGS: Settings = { volume: 80, quality: 'low' };

/** Settings from the store; anything missing, broken or out of range falls back to the default. Never throws. */
export function loadSettings(store: KeyValueStore): Settings {
  let text: string | null = null;
  try {
    text = store.getItem(SETTINGS_KEY);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  const out = { ...DEFAULT_SETTINGS };
  if (typeof text !== 'string' || text.length > 2000) return out;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return out;
  }
  if (!data || typeof data !== 'object') return out;
  const d = data as Record<string, unknown>;
  if (typeof d.volume === 'number' && Number.isFinite(d.volume)) out.volume = clampVolume(d.volume);
  if (d.quality === 'low' || d.quality === 'high') out.quality = d.quality;
  if (d.qualityBy === 'auto' || d.qualityBy === 'player') out.qualityBy = d.qualityBy;
  return out;
}

export function clampVolume(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : DEFAULT_SETTINGS.volume;
}

/** Save; false if the store refused (private mode). Never throws. */
export function saveSettings(store: KeyValueStore, s: Settings): boolean {
  try {
    const data: Record<string, unknown> = { volume: clampVolume(s.volume), quality: s.quality === 'high' ? 'high' : 'low' };
    if (s.qualityBy === 'auto' || s.qualityBy === 'player') data.qualityBy = s.qualityBy;
    store.setItem(SETTINGS_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

// ---------- Auto quality ----------

/** The probe: frame times on the title or menu for 2 s, the first 250 ms ignored. */
export const AUTO_PROBE_MS = 2000;
export const AUTO_PROBE_SKIP_MS = 250;
/** High when the median frame is under this many ms (about 70 fps), else low. */
export const AUTO_HIGH_UNDER_MS = 14;
/** Fewer samples than this (a stalled or hidden tab) gives no pick. */
export const AUTO_MIN_SAMPLES = 10;

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const a = [...xs].sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** The auto pick from frame times in ms: high if the median is under 14 ms, else low; null if too few. */
export function pickAutoQuality(frameMs: readonly number[]): QualitySetting | null {
  const ok = frameMs.filter((x) => Number.isFinite(x) && x > 0);
  if (ok.length < AUTO_MIN_SAMPLES) return null;
  return median(ok) < AUTO_HIGH_UNDER_MS ? 'high' : 'low';
}

/** Run the probe only when ?quality= is not in the address and nobody (player or probe) has set quality yet. */
export function needsQualityProbe(search: string, s: Settings): boolean {
  if (/[?&]quality=(low|medium|high)(?:&|$)/.test(search)) return false;
  // A save from before that says high was the player's own pick (the default is low): keep it.
  if (s.qualityBy === undefined && s.quality === 'high') return false;
  return s.qualityBy !== 'player' && s.qualityBy !== 'auto';
}

/** The settings after an auto pick: the player's own choice always wins (same object back). */
export function withAutoQuality(s: Settings, pick: QualitySetting | null): Settings {
  if (pick === null || s.qualityBy === 'player') return s;
  return { ...s, quality: pick, qualityBy: 'auto' };
}

/** The renderer quality: ?quality= in the address wins, else the setting (player, auto or default). */
export function qualityFor(search: string, s: Settings): 'low' | 'medium' | 'high' {
  const m = /[?&]quality=(low|medium|high)(?:&|$)/.exec(search);
  return m ? (m[1] as 'low' | 'medium' | 'high') : s.quality;
}

// ---------- Masters met ----------

export const MET_KEY = 'brushsteel.met';

/**
 * Masters you have met: faced in a duel (Duel or Path), win or lose. Master 1 is
 * always met. Sorted, only real master numbers. Never throws.
 */
export function loadMet(store: KeyValueStore): number[] {
  const met = new Set<number>([1]);
  try {
    const data: unknown = JSON.parse(store.getItem(MET_KEY) ?? '[]');
    if (Array.isArray(data)) for (const n of data) if (MASTERS.some((m) => m.index === n)) met.add(n as number);
  } catch {
    /* broken or refused: master 1 only */
  }
  return [...met].sort((a, b) => a - b);
}

/** Mark a master as met. Returns the new list. Never throws. */
export function addMet(store: KeyValueStore, index: number): number[] {
  const met = loadMet(store);
  if (!MASTERS.some((m) => m.index === index) || met.includes(index)) return met;
  const next = [...met, index].sort((a, b) => a - b);
  try {
    store.setItem(MET_KEY, JSON.stringify(next));
  } catch {
    /* private mode: kept for this page only */
  }
  return next;
}

// ---------- Title cut ----------

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Does a stroke cut the title? It must pass through the title's band (its middle
 * 80% of height) and run across at least 60% of the title's width while inside it.
 */
export function strokeCutsTitle(points: readonly { x: number; y: number }[], r: Rect): boolean {
  const top = r.top + r.height * 0.1;
  const bottom = r.top + r.height * 0.9;
  let lo = Infinity;
  let hi = -Infinity;
  const take = (x: number) => {
    const c = Math.max(r.left, Math.min(r.left + r.width, x));
    lo = Math.min(lo, c);
    hi = Math.max(hi, c);
  };
  // Each segment clipped to the band, so a fast stroke with few points still counts.
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    if (a.y >= top && a.y <= bottom) take(a.x);
    const b = points[i + 1];
    if (!b || a.y === b.y) continue;
    for (const y of [top, bottom]) {
      const t = (y - a.y) / (b.y - a.y);
      if (t > 0 && t < 1) take(a.x + (b.x - a.x) * t);
    }
  }
  return hi - lo >= r.width * 0.6;
}

// ---------- Keyboard focus ----------

/** Arrow keys move focus over a list and wrap; -1 (nothing focused) goes to the first or last. Shared by the menu and Pause. */
export function nextFocus(index: number, count: number, key: 'ArrowDown' | 'ArrowUp'): number {
  if (count <= 0) return -1;
  if (index < 0 || index >= count) return key === 'ArrowDown' ? 0 : count - 1;
  return key === 'ArrowDown' ? (index + 1) % count : (index - 1 + count) % count;
}

/**
 * A controller on a Path screen (map, shrine, brush, end). Those screens do not
 * read window keys, so the pad drives them directly: up and down move focus through the screen's
 * stops in page order (wrapping, like the menus), A on a stop that is not a button (a map node)
 * activates it. Everything else (A on a button, B, Start) returns null and takes the usual route,
 * so B does what Escape does there for the keyboard: nothing.
 */
export type PathPadStep = { focus: number } | { activate: true } | null;
export function pathPadStep(intent: string, index: number, count: number, focusIsButton: boolean): PathPadStep {
  if (intent === 'up' || intent === 'down') {
    const i = nextFocus(index, count, intent === 'up' ? 'ArrowUp' : 'ArrowDown');
    return i < 0 ? null : { focus: i };
  }
  if (intent === 'confirm' && index >= 0 && index < count && !focusIsButton) return { activate: true };
  return null;
}

// ---------- Menu lines ----------

/**
 * The Daily scroll menu line under its DAILY SCROLL heading, so without those words again
 * reads: "20 Nov (UTC), next in 5 h 2 min", or "..., ends your older run" when a
 * run from an earlier UTC day is still live (a brush pick replaces it).
 */
export function dailyMenuLine(run: { status: string; seed: number } | null, now: Date): string {
  const today = dailySeed(dateKey(now));
  const day = scrollLabel(today, now).replace(/^Daily scroll, /, '');
  return run && run.status !== 'over' && run.seed !== today ? `${day}, ends your older run` : `${day}, next in ${nextScrollIn(now)}`;
}

// ---------- How to play stroke demos ----------

export type StrokeDemoKind = 'cut' | 'overhead' | 'rising' | 'thrust' | 'parry';
export interface StrokeDemo {
  kind: StrokeDemoKind;
  /** Short caption under the demo. */
  caption: string;
  /** The brush stroke in a 120 by 80 box. A thrust is a single point. */
  stroke: readonly { x: number; y: number }[];
  /** Parry only: the faint ink line that shows where the blow lands. */
  line?: readonly [{ x: number; y: number }, { x: number; y: number }];
}

/** The looping examples on How to play: the same stroke directions the duel reads. */
export const STROKE_DEMOS: readonly StrokeDemo[] = [
  { kind: 'cut', caption: 'Cut', stroke: [{ x: 14, y: 54 }, { x: 46, y: 44 }, { x: 78, y: 34 }, { x: 106, y: 26 }] },
  { kind: 'overhead', caption: 'Overhead', stroke: [{ x: 54, y: 8 }, { x: 58, y: 30 }, { x: 62, y: 52 }, { x: 64, y: 72 }] },
  { kind: 'rising', caption: 'Rising', stroke: [{ x: 44, y: 72 }, { x: 52, y: 50 }, { x: 62, y: 28 }, { x: 72, y: 8 }] },
  { kind: 'thrust', caption: 'Thrust (click)', stroke: [{ x: 60, y: 40 }] },
  {
    kind: 'parry',
    caption: 'Parry',
    line: [{ x: 30, y: 10 }, { x: 90, y: 70 }],
    stroke: [{ x: 16, y: 62 }, { x: 46, y: 46 }, { x: 76, y: 30 }, { x: 104, y: 16 }],
  },
];

/** SVG path data for a stroke ("M x y L x y ..."). */
export function demoPath(points: readonly { x: number; y: number }[]): string {
  return points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ');
}

/** True when the polyline crosses the segment a-b (used to check the parry demo cuts its line). */
export function crossesSegment(points: readonly { x: number; y: number }[], a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  const side = (p: { x: number; y: number }, q: { x: number; y: number }, r: { x: number; y: number }) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1];
    const q = points[i];
    if (side(a, b, p) * side(a, b, q) < 0 && side(p, q, a) * side(p, q, b) < 0) return true;
  }
  return false;
}
