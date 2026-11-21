// Key rebinding. Pure: the store is passed in, so tests need no browser.
//
// Rules:
// - Five actions can be rebound: step left, step right, dip, dash, restart.
// - Bindable keys: one letter, one digit (read from the key's place, so Shift+1 is still 1),
//   Space, or Shift. Control, Alt and Meta are not: with a letter they fire browser shortcuts.
// - Esc, Enter, Tab, Backspace and the arrow keys are kept for menus and Pause. The Left,
//   Right and Down arrows always step left, step right and dip as well, whatever is bound.
// - A key already used by another action is refused, naming that action. Esc cancels.
// - Saved as { v: 1, keys } under brushsteel.keys; anything else read back gives the defaults.

import type { KeyValueStore } from './save.js';

export type KeyAction = 'left' | 'right' | 'dip' | 'dash' | 'restart';
export type KeyBindings = Record<KeyAction, string>;

export interface KeyActionInfo {
  action: KeyAction;
  /** Shown in Settings > Keys. */
  label: string;
  /** Used in refusals: "D already steps right". */
  verb: string;
  /** An arrow key that always does this too (not rebindable). */
  fixed?: string;
}

export const KEY_ACTIONS: readonly KeyActionInfo[] = [
  { action: 'left', label: 'Step left', verb: 'steps left', fixed: 'ArrowLeft' },
  { action: 'right', label: 'Step right', verb: 'steps right', fixed: 'ArrowRight' },
  { action: 'dip', label: 'Dip brush (hold)', verb: 'dips the brush', fixed: 'ArrowDown' },
  { action: 'dash', label: 'Dash (hold)', verb: 'dashes' },
  { action: 'restart', label: 'Restart after a duel', verb: 'restarts' },
];

export const DEFAULT_KEYS: KeyBindings = { left: 'a', right: 'd', dip: 's', dash: 'Shift', restart: 'r' };
export const KEYS_KEY = 'brushsteel.keys';
export const KEYS_VERSION = 1;
export const RESERVED_KEYS: readonly string[] = ['Escape', 'Enter', 'Tab', 'Backspace', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];

/** The parts of a KeyboardEvent the rules read. */
export interface KeyPress {
  key: string;
  code?: string;
}

const isLetter = (c: string) => [...c].length === 1 && c.toLowerCase() !== c.toUpperCase();

/** The stored name of a key, or null if it cannot be bound. Letters are lower case. */
export function bindableKey(p: KeyPress): string | null {
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(p.code ?? '');
  if (digit) return digit[1];
  if (p.key === ' ' || p.key === 'Spacebar') return 'Space';
  if (p.key === 'Shift') return 'Shift';
  if (/^\d$/.test(p.key)) return p.key;
  if (isLetter(p.key)) return p.key.toLowerCase();
  return null;
}

/** True if a stored name is one bindableKey can give. */
function validStored(k: unknown): k is string {
  return typeof k === 'string' && (k === 'Space' || k === 'Shift' || /^\d$/.test(k) || (isLetter(k) && k === k.toLowerCase()));
}

/** How a key is shown: "A", "7", "Space", "Shift", "Left arrow". */
export function keyLabel(k: string): string {
  if (k.startsWith('Arrow')) return `${k.slice(5)} arrow`;
  return [...k].length === 1 ? k.toUpperCase() : k;
}

/** The action a key press drives, if any (the fixed arrows included). */
export function actionForKey(b: KeyBindings, p: KeyPress): KeyAction | null {
  for (const a of KEY_ACTIONS) if (a.fixed && p.key === a.fixed) return a.action;
  const k = bindableKey(p);
  if (k === null) return null;
  for (const a of KEY_ACTIONS) if (b[a.action] === k) return a.action;
  return null;
}

export type RebindResult =
  | { kind: 'cancel' }
  | { kind: 'set'; keys: KeyBindings }
  | { kind: 'refused'; message: string; by?: KeyAction };

/** A key pressed while waiting to rebind an action. Esc cancels; a refusal says why. */
export function pressRebind(b: KeyBindings, action: KeyAction, p: KeyPress): RebindResult {
  if (p.key === 'Escape') return { kind: 'cancel' };
  if (RESERVED_KEYS.includes(p.key)) return { kind: 'refused', message: `${keyLabel(p.key)} is kept for menus and Pause.` };
  const k = bindableKey(p);
  if (k === null) return { kind: 'refused', message: 'Pick a letter, a digit, Space or Shift.' };
  for (const a of KEY_ACTIONS) {
    if (a.action !== action && b[a.action] === k) return { kind: 'refused', message: `${keyLabel(k)} already ${a.verb}.`, by: a.action };
  }
  return { kind: 'set', keys: { ...b, [action]: k } };
}

/** Bindings from the store; a wrong version, a bad or missing key, or two actions on one key give the defaults. Never throws. */
export function loadKeys(store: KeyValueStore): KeyBindings {
  let text: string | null = null;
  try {
    text = store.getItem(KEYS_KEY);
  } catch {
    return { ...DEFAULT_KEYS };
  }
  if (typeof text !== 'string' || text.length > 500) return { ...DEFAULT_KEYS };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ...DEFAULT_KEYS };
  }
  if (!data || typeof data !== 'object') return { ...DEFAULT_KEYS };
  const d = data as { v?: unknown; keys?: unknown };
  if (d.v !== KEYS_VERSION || !d.keys || typeof d.keys !== 'object') return { ...DEFAULT_KEYS };
  const raw = d.keys as Record<string, unknown>;
  const out = {} as KeyBindings;
  const used = new Set<string>();
  for (const a of KEY_ACTIONS) {
    const k = raw[a.action];
    if (!validStored(k) || used.has(k)) return { ...DEFAULT_KEYS };
    used.add(k);
    out[a.action] = k;
  }
  return out;
}

/** Save; false if the store refused (private mode). Never throws. */
export function saveKeys(store: KeyValueStore, b: KeyBindings): boolean {
  const keys = {} as KeyBindings;
  for (const a of KEY_ACTIONS) keys[a.action] = b[a.action];
  try {
    store.setItem(KEYS_KEY, JSON.stringify({ v: KEYS_VERSION, keys }));
    return true;
  } catch {
    return false;
  }
}

/** The short controls line for the duel help and How to play. */
export function controlsLine(b: KeyBindings): string {
  return `${keyLabel(b.left)} / ${keyLabel(b.right)} step, ${keyLabel(b.dash)} dash, hold ${keyLabel(b.dip)} to dip.`;
}
