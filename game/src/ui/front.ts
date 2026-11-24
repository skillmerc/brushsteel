// Front end screens: the title (a stroke across the name cuts
// it and starts; Enter or a tap also start), the main menu, the master pick,
// Settings, How to play, Credits, and Pause during a duel. Plain DOM over the
// paper canvas, ink on paper like the Path screens. Pure rules are in core/front.ts.

import { MASTERS } from '../core/masters.js';
import { STROKE_DEMOS, clampVolume, demoPath, frontReducer, nextFocus, strokeCutsTitle, type FrontAction, type FrontScreen, type Settings, type StrokeDemo } from '../core/front.js';
import { guardDragClicks } from './dragGuard.js';
import { versionLabel } from '../version.js';
import { DEFAULT_KEYS, KEY_ACTIONS, controlsLine, keyLabel, pressRebind, type KeyAction, type KeyBindings } from '../core/keys.js';

const INK = '#1b1611';
const RED = '#a61e18';
const PAPER = '#efe6d2';

const CSS = `
.bs-front{position:fixed;inset:0;z-index:25;overflow:auto;font:17px/1.45 Georgia,'Times New Roman',serif;color:${INK};touch-action:none;user-select:none;-webkit-user-select:none}
.bs-front.veil{background:rgba(239,230,210,.9)}
.bs-fw{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 24px;box-sizing:border-box}
.bs-title{position:relative;margin:0;font-weight:400;font-size:clamp(56px,11vw,190px);letter-spacing:.16em;line-height:1;padding-left:.16em;user-select:none;-webkit-user-select:none}
.bs-title span{display:block}
.bs-title .b{position:absolute;inset:0;padding-left:.16em}
.bs-title .a{clip-path:polygon(0 0,100% 0,100% 52%,0 52%)}
.bs-title .b{clip-path:polygon(0 52%,100% 52%,100% 100%,0 100%)}
.bs-title.cut .a{transform:translate(-.08em,-.06em) rotate(-1.2deg);transition:transform .45s cubic-bezier(.2,.8,.2,1)}
.bs-title.cut .b{transform:translate(.08em,.05em) rotate(.8deg);transition:transform .45s cubic-bezier(.2,.8,.2,1)}
.bs-ver{position:fixed;right:18px;bottom:12px;margin:0;font-size:12px;letter-spacing:.1em;opacity:.5;pointer-events:none}
.bs-hint{margin-top:34px;font-size:18px;letter-spacing:.06em;opacity:.75;text-align:center}
.bs-front button{font:inherit;color:${INK};background:none;border:0;cursor:pointer}
.bs-enter{margin-top:14px;font-size:15px!important;letter-spacing:.14em;text-transform:uppercase;opacity:.6;padding:8px 14px;border-bottom:1.5px solid transparent!important}
.bs-enter:hover,.bs-enter:focus-visible{opacity:1;border-bottom-color:${RED}!important;outline:none}
.bs-trail{position:fixed;inset:0;width:100%;height:100%;pointer-events:none}
.bs-trail polyline{fill:none;stroke:${INK};stroke-width:7;stroke-linecap:round;stroke-linejoin:round}
.bs-trail polyline.hit{stroke:${RED}}
.bs-h{font-size:clamp(34px,4.6vw,58px);letter-spacing:.16em;margin:0 0 6px;font-weight:400;text-align:center}
.bs-sub{opacity:.7;margin:0 0 26px;text-align:center;font-size:16px}
.bs-list{display:flex;flex-direction:column;gap:4px;width:min(560px,100%)}
.bs-item{display:flex!important;justify-content:space-between;align-items:baseline;gap:20px;width:100%;text-align:left;padding:12px 16px!important;border-left:2px solid transparent!important;box-sizing:border-box}
.bs-item b{font-weight:400;font-size:22px;letter-spacing:.12em;text-transform:uppercase}
.bs-item small{font-size:15px;opacity:.7;text-align:right}
.bs-item:hover,.bs-item:focus-visible{background:rgba(27,22,17,.06);border-left-color:${RED}!important;outline:none}
.bs-item[disabled]{cursor:default;opacity:.45}
.bs-item[disabled]:hover{background:none;border-left-color:transparent!important}
.bs-text{width:min(680px,100%)}
.bs-text p,.bs-text li{margin:0 0 10px}
.bs-text ul{padding-left:20px;margin:0 0 14px}
.bs-text h3{font-weight:400;letter-spacing:.12em;text-transform:uppercase;font-size:16px;margin:18px 0 8px;color:${RED}}
.bs-row{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:14px 0;border-bottom:1px solid rgba(27,22,17,.18)}
.bs-row label{letter-spacing:.1em;text-transform:uppercase;font-size:16px}
.bs-row input[type=range]{width:220px;accent-color:${RED};-webkit-appearance:none;appearance:none;background:transparent;height:22px;margin:0;cursor:pointer}
.bs-row input[type=range]::-webkit-slider-runnable-track{height:3px;background:${INK};border-radius:2px}
.bs-row input[type=range]::-moz-range-track{height:3px;background:${INK};border-radius:2px}
.bs-row input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:16px;height:16px;margin-top:-6.5px;border-radius:50%;background:${RED};border:1.5px solid ${INK};box-sizing:border-box}
.bs-row input[type=range]::-moz-range-thumb{width:16px;height:16px;border-radius:50%;background:${RED};border:1.5px solid ${INK};box-sizing:border-box}
.bs-row input[type=range]:focus{outline:none}
.bs-row input[type=range]:focus-visible{outline:2px solid ${RED};outline-offset:4px}
.bs-seg{display:flex;gap:4px}
.bs-seg button{padding:6px 14px!important;border:1.5px solid rgba(27,22,17,.35)!important;font-size:15px!important}
.bs-seg button.on{border-color:${RED}!important;color:${RED}}
.bs-note{font-size:15px;opacity:.75;margin-top:12px}
.bs-pad{font-size:14px;opacity:.75;margin:4px 0 8px}
.bs-back{margin-top:26px;letter-spacing:.14em;text-transform:uppercase;font-size:15px!important;padding:8px 14px!important;opacity:.75;border-bottom:1.5px solid transparent!important}
.bs-back:hover,.bs-back:focus-visible{opacity:1;border-bottom-color:${RED}!important;outline:none}
.bs-fw.bs-panel{height:100%;min-height:0}
.bs-scroll.more{-webkit-mask-image:linear-gradient(#000 calc(100% - 44px),transparent);mask-image:linear-gradient(#000 calc(100% - 44px),transparent)}
.bs-more{margin-top:6px;font-size:13px;letter-spacing:.12em;text-transform:uppercase;opacity:.6;visibility:hidden}
.bs-more.on{visibility:visible}
.bs-howto>.bs-text{width:min(440px,100%)}
@media (max-height:700px){.bs-fw{padding-top:20px;padding-bottom:20px}.bs-h{font-size:34px}.bs-text h3{margin:10px 0 6px}.bs-back{margin-top:10px}}
.bs-panel>*{flex-shrink:0}
.bs-scroll{flex:0 1 auto!important;min-height:0;overflow-y:auto;overflow-x:hidden;width:min(1000px,100%);display:flex;flex-direction:column;align-items:center;padding:0 10px;box-sizing:border-box;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:rgba(27,22,17,.4) transparent}
.bs-scroll .bs-list{flex-shrink:0}
.bs-cols{display:flex;flex-wrap:wrap;justify-content:center;align-items:flex-start;gap:0 56px;width:100%}
.bs-cols>.bs-text{width:min(440px,100%)}
.bs-cols .bs-row input[type=range]{width:150px}
.bs-side{display:flex;gap:18px;align-items:flex-start}
.bs-side ul{flex:1 1 auto;min-width:0}
.bs-demos{display:flex;flex-wrap:wrap;gap:8px 18px;margin:2px 0 12px}
.bs-demo{margin:0;display:flex;flex-direction:column;align-items:center;gap:2px;font-size:14px;letter-spacing:.08em}
.bs-demo svg{display:block;width:96px;height:64px;background:linear-gradient(rgba(27,22,17,.045),rgba(27,22,17,.045)),${PAPER};border-radius:3px}
.bs-demo .st{fill:none;stroke:${INK};stroke-width:5;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:100;stroke-dashoffset:100;animation:bs-draw 2.6s ease-in infinite}
.bs-demo .dot{fill:${INK};transform-box:fill-box;transform-origin:center;animation:bs-dot 2.6s ease-out infinite}
.bs-demo .ln{stroke:${RED};stroke-width:2;stroke-dasharray:3 4;opacity:0;animation:bs-warn 2.6s linear infinite}
.bs-demo.parry .st{animation-name:bs-draw-late}
.bs-demos.high .st,.bs-demos.high .dot{filter:drop-shadow(0 0 1.2px rgba(27,22,17,.7))}
@keyframes bs-draw{0%,12%{stroke-dashoffset:100;opacity:1}42%,74%{stroke-dashoffset:0;opacity:1}96%,100%{stroke-dashoffset:0;opacity:0}}
@keyframes bs-draw-late{0%,34%{stroke-dashoffset:100;opacity:1}56%,78%{stroke-dashoffset:0;opacity:1}96%,100%{stroke-dashoffset:0;opacity:0}}
@keyframes bs-dot{0%,20%{transform:scale(0);opacity:1}34%{transform:scale(1.5);opacity:1}46%,74%{transform:scale(1);opacity:1}96%,100%{transform:scale(1);opacity:0}}
@keyframes bs-warn{0%{opacity:0}18%,50%{opacity:.5}56%{opacity:1;stroke-dasharray:none}74%{opacity:.25}100%{opacity:0}}
@media (prefers-reduced-motion:reduce){.bs-demo .st,.bs-demo .dot,.bs-demo .ln{animation:none!important;stroke-dashoffset:0;opacity:1}.bs-demo .ln{opacity:.5}}
@media (max-height:800px){
.bs-fw{padding:18px 24px}
.bs-h{margin-bottom:2px}
.bs-sub{margin-bottom:12px}
.bs-row{padding:7px 0}
.bs-item{padding:8px 16px!important}
.bs-text h3{margin:10px 0 6px}
.bs-text p,.bs-text li{margin-bottom:6px}
.bs-note{margin-top:8px}
.bs-back{margin-top:12px}
}
`;

export interface FrontInfo {
  /** "Continue your run" or "Start a run". */
  pathLine: string;
  /** "20 Nov (UTC), next in 5 h 2 min" (the heading says DAILY SCROLL). */
  dailyLine: string;
  /** Masters met (1 always). */
  met: number[];
  settings: Settings;
  /** Key bindings (Settings > Keys). */
  keys: KeyBindings;
  /** False when the browser keeps no storage (private mode). */
  canSave: boolean;
  /** True while a controller is connected: Settings and How to play say so. */
  padConnected?: () => boolean;
}

export interface FrontHandlers {
  /** Leave the front end for a mode (the page reloads to it). */
  go(href: string): void;
  /** A setting changed: save it, return whether it was saved. */
  setSettings(s: Settings): boolean;
  /** Key bindings changed: save them, return whether they were saved. */
  setKeys(b: KeyBindings): boolean;
  /** For CI and tests: the screen now shown. */
  onScreen?(screen: FrontScreen): void;
}

let styled = false;
function style(): void {
  if (styled) return;
  styled = true;
  const s = document.createElement('style');
  s.textContent = CSS;
  document.head.appendChild(s);
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function backButton(onBack: () => void, label = 'Back'): HTMLButtonElement {
  const b = el('button', 'bs-back', label);
  b.type = 'button';
  b.addEventListener('click', onBack);
  return b;
}

/**
 * A screen with a heading, a body that scrolls inside its own area when the window is short,
 * and a Back button that always stays on screen.
 */
function panel(w: HTMLElement, head: HTMLElement[], body: HTMLElement[], back: HTMLButtonElement): void {
  w.classList.add('bs-panel');
  const scroll = el('div', 'bs-scroll');
  scroll.append(...body);
  // When the body is taller than its room, its foot fades and a line says there is more.
  const more = el('p', 'bs-more', 'Scroll for more');
  const check = () => {
    const below = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop > 2;
    scroll.classList.toggle('more', below);
    more.classList.toggle('on', below);
  };
  scroll.addEventListener('scroll', check, { passive: true });
  if (typeof ResizeObserver === 'function') new ResizeObserver(check).observe(scroll);
  requestAnimationFrame(check);
  w.append(...head, scroll, more, back);
}

/** Volume and quality beside Keys when the window is wide enough, stacked when not. */
function settingsColumns(settings: HTMLElement, keys: HTMLElement): HTMLElement {
  const cols = el('div', 'bs-cols');
  cols.append(settings, keys);
  return cols;
}

const SVG = 'http://www.w3.org/2000/svg';
/** One looping stroke example for How to play: CSS draws it, so it stops when the screen goes. */
export function strokeDemo(d: StrokeDemo, index: number): HTMLElement {
  const fig = el('figure', `bs-demo ${d.kind}`);
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 120 80');
  svg.setAttribute('aria-hidden', 'true');
  const delay = `${(index * 0.35).toFixed(2)}s`;
  if (d.line) {
    const ln = document.createElementNS(SVG, 'line');
    ln.setAttribute('class', 'ln');
    ln.setAttribute('x1', String(d.line[0].x));
    ln.setAttribute('y1', String(d.line[0].y));
    ln.setAttribute('x2', String(d.line[1].x));
    ln.setAttribute('y2', String(d.line[1].y));
    ln.style.animationDelay = delay;
    svg.appendChild(ln);
  }
  if (d.stroke.length === 1) {
    const dot = document.createElementNS(SVG, 'circle');
    dot.setAttribute('class', 'dot');
    dot.setAttribute('cx', String(d.stroke[0].x));
    dot.setAttribute('cy', String(d.stroke[0].y));
    dot.setAttribute('r', '7');
    dot.style.animationDelay = delay;
    svg.appendChild(dot);
  } else {
    const st = document.createElementNS(SVG, 'path');
    st.setAttribute('class', 'st');
    st.setAttribute('d', demoPath(d.stroke));
    // pathLength 100 lets one dash keyframe draw every stroke whatever its real length.
    st.setAttribute('pathLength', '100');
    st.style.animationDelay = delay;
    svg.appendChild(st);
  }
  fig.append(svg, el('figcaption', '', d.caption));
  return fig;
}

/** Settings rows: master volume and ink quality. Shared by the menu and Pause. */
export function settingsPanel(get: () => Settings, set: (s: Settings) => boolean, canSave: boolean, inDuel: boolean): HTMLElement {
  const box = el('div', 'bs-text');
  box.appendChild(el('h3', '', 'Sound and ink'));
  const vRow = el('div', 'bs-row');
  const vLabel = el('label', '', 'Master volume');
  vLabel.htmlFor = 'bs-volume';
  const vWrap = el('div', 'bs-seg');
  const range = el('input');
  range.type = 'range';
  range.id = 'bs-volume';
  range.min = '0';
  range.max = '100';
  range.step = '5';
  range.value = String(get().volume);
  const vOut = el('span', '', `${get().volume}%`);
  vOut.style.minWidth = '48px';
  range.addEventListener('input', () => {
    const volume = clampVolume(Number(range.value));
    vOut.textContent = `${volume}%`;
    set({ ...get(), volume });
  });
  vWrap.append(range, vOut);
  vRow.append(vLabel, vWrap);

  const qRow = el('div', 'bs-row');
  const qLabel = el('label', '', get().qualityBy === 'auto' ? 'Ink quality (auto)' : 'Ink quality');
  const seg = el('div', 'bs-seg');
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', 'Ink quality');
  const opts: [Settings['quality'], string][] = [['low', 'Low'], ['high', 'High']];
  const buttons = opts.map(([q, label]) => {
    const b = el('button', get().quality === q ? 'on' : '', label);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(get().quality === q));
    b.addEventListener('click', () => {
      set({ ...get(), quality: q, qualityBy: 'player' });
      qLabel.textContent = 'Ink quality';
      for (const [i, x] of buttons.entries()) {
        const on = opts[i][0] === q;
        x.className = on ? 'on' : '';
        x.setAttribute('aria-checked', String(on));
      }
    });
    seg.appendChild(b);
    return b;
  });
  qRow.append(qLabel, seg);
  const note = el('p', 'bs-note');
  note.textContent =
    (inDuel ? 'Quality changes from the next duel, never in the middle of one. ' : 'Low suits most laptops; High draws the ink at full size. ') +
    'Sound starts after your first click or key press (a controller press alone does not start it).' +
    (canSave ? '' : ' This browser keeps no storage (private mode), so settings last until the page closes.');
  box.append(vRow, qRow, note);
  return box;
}

/**
 * Settings > Keys: one row per action. Click a key, then press the new one; a key another
 * action uses is refused by name; Esc cancels. Rules in core/keys.ts. Shared by the menu and Pause.
 */
export function keysPanel(get: () => KeyBindings, set: (b: KeyBindings) => boolean): HTMLElement {
  const box = el('div', 'bs-text');
  box.appendChild(el('h3', '', 'Keys'));
  const note = el('p', 'bs-note', 'Click a key, then press the new one. Esc cancels.');
  note.setAttribute('aria-live', 'polite');
  const buttons = new Map<KeyAction, HTMLButtonElement>();
  let pending: KeyAction | null = null;
  const refresh = () => {
    for (const a of KEY_ACTIONS) {
      const b = buttons.get(a.action);
      if (!b) continue;
      b.textContent = keyLabel(get()[a.action]);
      b.className = '';
    }
  };
  const stop = () => {
    pending = null;
    window.removeEventListener('keydown', onKey, true);
    refresh();
  };
  // Capture phase on window: the key never reaches Pause (Esc) or the menu (Backspace, arrows).
  const onKey = (e: KeyboardEvent) => {
    if (!pending) return;
    if (!box.isConnected) return stop();
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    const action = pending;
    const r = pressRebind(get(), action, e);
    const info = KEY_ACTIONS.find((a) => a.action === action);
    if (r.kind === 'cancel') {
      note.textContent = 'Not changed.';
      stop();
    } else if (r.kind === 'refused') {
      note.textContent = `${r.message} Press another key, or Esc.`;
    } else {
      const saved = set(r.keys);
      note.textContent = `${info?.label ?? 'Key'}: ${keyLabel(r.keys[action])}.${saved ? '' : ' Not saved: this browser keeps no storage.'}`;
      stop();
    }
  };
  for (const a of KEY_ACTIONS) {
    const row = el('div', 'bs-row');
    row.appendChild(el('label', '', a.fixed ? `${a.label}, or ${keyLabel(a.fixed).toLowerCase()}` : a.label));
    const seg = el('div', 'bs-seg');
    const b = el('button');
    b.type = 'button';
    b.setAttribute('aria-label', `${a.label}: change key`);
    b.addEventListener('click', () => {
      const again = pending === a.action;
      stop();
      if (again) return;
      pending = a.action;
      b.textContent = 'Press a key';
      b.className = 'on';
      note.textContent = `Press the new key for ${a.label.toLowerCase()}. Esc cancels.`;
      window.addEventListener('keydown', onKey, true);
    });
    buttons.set(a.action, b);
    seg.appendChild(b);
    row.appendChild(seg);
    box.appendChild(row);
  }
  const resetRow = el('div', 'bs-row');
  resetRow.appendChild(el('label', '', 'Reset keys'));
  const resetSeg = el('div', 'bs-seg');
  const reset = el('button', '', 'Reset');
  reset.type = 'button';
  reset.addEventListener('click', () => {
    stop();
    set({ ...DEFAULT_KEYS });
    refresh();
    note.textContent = `Keys reset: ${controlsLine(DEFAULT_KEYS)}`;
  });
  resetSeg.appendChild(reset);
  resetRow.appendChild(resetSeg);
  box.append(resetRow, note);
  refresh();
  return box;
}

export interface FrontEnd {
  readonly screen: FrontScreen;
  dispatch(action: FrontAction): void;
  /** Draw the screen again (a controller came or went: the note on Settings and How to play). */
  refresh(): void;
  /** Settings changed outside the menus (the auto quality probe): keep the copy, no redraw. */
  syncSettings(s: Settings): void;
}

/** The title and the menus. Returns a handle for keyboard tests and CI. */
export function createFrontEnd(first: FrontScreen, info: FrontInfo, h: FrontHandlers): FrontEnd {
  style();
  const root = el('div', 'bs-front');
  root.setAttribute('role', 'main');
  document.body.appendChild(root);
  let screen = first;
  let settings = { ...info.settings };
  let keys = { ...info.keys };

  const dispatch = (a: FrontAction) => {
    const next = frontReducer(screen, a);
    if (next === screen) return;
    screen = next;
    draw();
  };

  const draw = () => {
    root.replaceChildren();
    root.onpointerdown = null;
    const w = el('div', 'bs-fw');
    root.appendChild(w);
    if (screen === 'title') drawTitle(w);
    else if (screen === 'menu') drawMenu(w);
    else if (screen === 'masters') drawMasters(w);
    else if (screen === 'settings') drawSettings(w);
    else if (screen === 'howto') drawHowTo(w);
    else drawCredits(w);
    h.onScreen?.(screen);
    const focus = root.querySelector<HTMLElement>('.bs-item:not([disabled]), .bs-enter, .bs-back');
    focus?.focus({ preventScroll: true });
  };

  const drawTitle = (w: HTMLElement) => {
    const title = el('h1', 'bs-title');
    title.setAttribute('aria-label', 'BRUSHSTEEL');
    title.append(el('span', 'a', 'BRUSHSTEEL'), el('span', 'b', 'BRUSHSTEEL'));
    title.lastElementChild?.setAttribute('aria-hidden', 'true');
    const hint = el('p', 'bs-hint', 'Draw a stroke across the name to begin');
    const enter = el('button', 'bs-enter', 'Or press Enter');
    enter.type = 'button';
    w.append(title, hint, enter, el('p', 'bs-ver', versionLabel()));
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'bs-trail');
    svg.setAttribute('aria-hidden', 'true');
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    svg.appendChild(line);
    root.appendChild(svg);
    let pts: { x: number; y: number }[] = [];
    let drawing = false;
    let done = false;
    const start = () => {
      if (done) return;
      done = true;
      dispatch({ type: 'start' });
    };
    const cut = () => {
      if (done) return;
      line.setAttribute('class', 'hit');
      title.classList.add('cut');
      hint.textContent = '';
      setTimeout(start, 650);
    };
    enter.addEventListener('click', (e) => {
      e.stopPropagation();
      start();
    });
    root.onpointerdown = (e) => {
      if (done || e.target === enter) return;
      drawing = true;
      pts = [{ x: e.clientX, y: e.clientY }];
      line.setAttribute('points', '');
      line.removeAttribute('class');
      root.setPointerCapture?.(e.pointerId);
    };
    root.onpointermove = (e) => {
      if (!drawing || done) return;
      pts.push({ x: e.clientX, y: e.clientY });
      if (pts.length > 400) pts.splice(1, 1);
      line.setAttribute('points', pts.map((p) => `${p.x},${p.y}`).join(' '));
    };
    root.onpointerup = () => {
      if (!drawing || done) return;
      drawing = false;
      const r = title.getBoundingClientRect();
      const span = pts.reduce((m, p) => Math.max(m, Math.hypot(p.x - pts[0].x, p.y - pts[0].y)), 0);
      if (strokeCutsTitle(pts, { left: r.left, top: r.top, width: r.width, height: r.height })) cut();
      // A tap (no real stroke) is the pointer fallback for players who cannot draw.
      else if (span < 8) start();
      else hint.textContent = 'Across the name, from one side to the other';
    };
  };

  const item = (title: string, line: string, onClick: (() => void) | null): HTMLButtonElement => {
    const b = el('button', 'bs-item');
    b.type = 'button';
    b.append(el('b', '', title), el('small', '', line));
    if (onClick) b.addEventListener('click', onClick);
    else b.disabled = true;
    return b;
  };

  const drawMenu = (w: HTMLElement) => {
    w.append(el('h2', 'bs-h', 'BRUSHSTEEL'), el('p', 'bs-sub', 'An ink-brush duel'));
    const list = el('nav', 'bs-list');
    list.setAttribute('aria-label', 'Main menu');
    list.append(
      item('Duel', `Face a master you have met (${info.met.length} of ${MASTERS.length})`, () => dispatch({ type: 'open', screen: 'masters' })),
      item('Path', info.pathLine, () => h.go('?mode=path')),
      item('Daily scroll', info.dailyLine, () => h.go('?mode=path&daily=1')),
      item('Settings', 'Volume, ink quality and keys', () => dispatch({ type: 'open', screen: 'settings' })),
      item('How to play', 'Strokes, parries and ink', () => dispatch({ type: 'open', screen: 'howto' })),
      item('Credits', 'Who made this, and with what', () => dispatch({ type: 'open', screen: 'credits' })),
    );
    w.appendChild(list);
  };

  const drawMasters = (w: HTMLElement) => {
    const list = el('nav', 'bs-list');
    list.setAttribute('aria-label', 'Masters');
    for (const m of MASTERS) {
      const met = info.met.includes(m.index);
      list.appendChild(
        met
          ? item(`${m.index}. ${m.name}`, `${m.title}, ${m.school}`, () => h.go(`?master=${m.index}`))
          : item(`${m.index}. ?`, 'Not met yet', null),
      );
    }
    panel(w, [el('h2', 'bs-h', 'Duel'), el('p', 'bs-sub', 'Masters you meet on the Path join this list.')], [list], backButton(() => dispatch({ type: 'back' })));
  };

  const drawSettings = (w: HTMLElement) => {
    const sp = settingsPanel(() => settings, (s) => {
      settings = s;
      return h.setSettings(s);
    }, info.canSave, false);
    const kp = keysPanel(() => keys, (b) => {
      keys = b;
      return h.setKeys(b);
    });
    const head = [el('h2', 'bs-h', 'Settings')];
    if (info.padConnected?.()) head.push(el('p', 'bs-pad', PAD_NOTE));
    panel(w, head, [settingsColumns(sp, kp)], backButton(() => dispatch({ type: 'back' })));
  };

  const drawHowTo = (w: HTMLElement) => {
    // Two columns side by side when the window is wide enough, one under the other when not.
    const cols = el('div', 'bs-cols bs-howto');
    const left = el('div', 'bs-text');
    const right = el('div', 'bs-text');
    cols.append(left, right);
    let t = left;
    const demos = (kinds: StrokeDemo['kind'][]) => {
      const box = el('div', `bs-demos ${settings.quality}`);
      for (const d of STROKE_DEMOS) if (kinds.includes(d.kind)) box.appendChild(strokeDemo(d, box.childElementCount));
      return box;
    };
    const sec = (head: string, lines: string[], demo?: HTMLElement, beside = false) => {
      t.appendChild(el('h3', '', head));
      const ul = el('ul');
      for (const l of lines) ul.appendChild(el('li', '', l));
      if (demo && beside) {
        const side = el('div', 'bs-side');
        side.append(ul, demo);
        t.appendChild(side);
      } else {
        if (demo) t.appendChild(demo);
        t.appendChild(ul);
      }
    };
    sec('Strike', [
      'Drag across the screen to cut. Drag down for an overhead, up for a rising cut.',
      'Click without dragging to thrust. A ready master turns a thrust aside: thrust right after you parry.',
      'Slow strokes do nothing. Draw them with intent.',
    ], demos(['cut', 'overhead', 'rising', 'thrust']));
    sec('Parry', [
      'When a master gets ready to strike, a faint ink line shows where the blow will land.',
      'Cut across that line to parry, then strike back at once.',
    ], demos(['parry']), true);
    t = right;
    sec('Move and ink', [
      `${keyLabel(keys.left)} and ${keyLabel(keys.right)}, or the arrow keys, step back and forward. ${keyLabel(keys.dash)} dashes.`,
      `Every stroke spends ink. Hold ${keyLabel(keys.dip)} to dip your brush and refill.`,
      'Change the keys in Settings.',
      'First to three hits wins. Esc pauses.',
    ]);
    sec('Path', [
      'A run over one daily scroll: duels, shrines with seals, ink wells and masters.',
      'You have three lives. Leaving a fight under way costs one.',
    ]);
    const head = [el('h2', 'bs-h', 'How to play')];
    if (info.padConnected?.()) head.push(el('p', 'bs-pad', PAD_NOTE));
    panel(w, head, [cols], backButton(() => dispatch({ type: 'back' })));
  };

  const drawCredits = (w: HTMLElement) => {
    const t = el('div', 'bs-text');
    t.append(
      el('p', '', 'Made by SKILLMERC for the OpenGame Game Jam #1.'),
      el('p', '', 'Fighting track.'),
      el('p', '', 'All game code was written during the jam, from 19 Nov 2026.'),
      el('p', '', "The art and sound are drawn and played by the game's own code."),
      el('h3', '', 'In the game'),
      el('p', '', 'Three.js 0.187.0 (MIT).'),
      el('h3', '', 'Build tools'),
      el('p', '', 'Vite, vite-plugin-singlefile and TypeScript.'),
      el('h3', '', 'Algorithms'),
      el('p', '', 'Seeded random numbers: mulberry32. String to seed: FNV-1a. Stroke matching: the $1 unistroke recogniser idea (Wobbrock, Wilson and Li, 2007), written fresh.'),
      el('p', 'bs-note', 'The full list with sources and licences is in CREDITS.md with the game code.'),
      el('p', 'bs-note', `Version ${versionLabel()}.`),
    );
    panel(w, [el('h2', 'bs-h', 'Credits')], [t], backButton(() => dispatch({ type: 'back' })));
  };

  window.addEventListener('keydown', (e) => {
    if (!root.isConnected) return;
    if (screen === 'title' && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      dispatch({ type: 'start' });
    } else if (screen !== 'title' && (e.key === 'Escape' || e.key === 'Backspace') && screen !== 'menu') {
      e.preventDefault();
      dispatch({ type: 'back' });
    } else if (screen !== 'title' && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      const items = [...root.querySelectorAll<HTMLElement>('.bs-item:not([disabled]), .bs-back')];
      if (!items.length) return;
      e.preventDefault();
      // A screen whose only stop is Back (How to play, Credits, Settings) scrolls its text with the
      // arrows when the text is taller than its area, so the keyboard can read all of it.
      const sc = root.querySelector<HTMLElement>('.bs-scroll');
      if (items.length === 1 && sc && sc.scrollHeight > sc.clientHeight + 1) {
        sc.scrollBy({ top: e.key === 'ArrowDown' ? 60 : -60 });
        return;
      }
      items[nextFocus(items.indexOf(document.activeElement as HTMLElement), items.length, e.key)].focus();
    }
  });

  draw();
  return {
    get screen() {
      return screen;
    },
    dispatch,
    refresh() {
      if (screen === 'settings' || screen === 'howto') draw();
    },
    syncSettings(s) {
      settings = { ...s };
    },
  };
}

/** Shown on Settings and How to play while a controller is connected. */
export const PAD_NOTE = 'Controller connected. Right stick draws strokes, left stick or d-pad steps, LB or RB dashes, X dips, RT thrusts, A picks, B goes back, Start pauses.';

export interface PauseHandlers {
  onResume(): void;
  onSettings(): void;
  onBack(): void;
  onQuit(): void;
  getSettings(): Settings;
  setSettings(s: Settings): boolean;
  getKeys(): KeyBindings;
  setKeys(b: KeyBindings): boolean;
  canSave: boolean;
}

/** Pause over a duel: Resume, Settings, Quit to menu. */
export function createPause(h: PauseHandlers & { lifeAtStake: () => boolean }) {
  style();
  const root = el('div', 'bs-front veil');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Paused');
  root.style.display = 'none';
  root.style.background = `rgba(239,230,210,.9)`;
  document.body.appendChild(root);
  guardDragClicks(root);
  let shown: 'paused' | 'settings' | null = null;
  // Keyboard as in the menu: arrows move over the items and Back, Backspace goes back from
  // Settings to Pause (on the Pause list itself it does nothing, as on the main menu; Esc resumes).
  window.addEventListener('keydown', (e) => {
    if (!shown) return;
    if (e.key === 'Backspace' && shown === 'settings') {
      e.preventDefault();
      h.onBack();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const items = [...root.querySelectorAll<HTMLElement>('.bs-item, .bs-back')];
      if (!items.length) return;
      e.preventDefault();
      items[nextFocus(items.indexOf(document.activeElement as HTMLElement), items.length, e.key)].focus();
    }
  });
  const show = (view: 'paused' | 'settings') => {
    shown = view;
    root.replaceChildren();
    const w = el('div', 'bs-fw');
    if (view === 'paused') {
      w.append(el('h2', 'bs-h', 'Paused'));
      const list = el('nav', 'bs-list');
      list.append(
        item2('Resume', 'Esc', h.onResume),
        item2('Settings', 'Volume, ink quality and keys', h.onSettings),
        item2('Quit to menu', h.lifeAtStake() ? 'Leaving this fight costs a life' : 'Back to the main menu', h.onQuit),
      );
      w.append(list, el('p', 'bs-ver', versionLabel()));
    } else {
      const b = el('button', 'bs-back', 'Back');
      b.type = 'button';
      b.addEventListener('click', h.onBack);
      panel(w, [el('h2', 'bs-h', 'Settings')], [settingsColumns(settingsPanel(h.getSettings, h.setSettings, h.canSave, true), keysPanel(h.getKeys, h.setKeys))], b);
    }
    root.appendChild(w);
    root.style.display = 'block';
    root.querySelector<HTMLElement>('.bs-item, .bs-back')?.focus({ preventScroll: true });
  };
  const item2 = (title: string, line: string, onClick: () => void) => {
    const b = el('button', 'bs-item');
    b.type = 'button';
    b.append(el('b', '', title), el('small', '', line));
    b.addEventListener('click', onClick);
    return b;
  };
  return {
    show,
    hide() {
      shown = null;
      root.style.display = 'none';
      root.replaceChildren();
    },
  };
}

export const FRONT_COLOURS = { INK, RED, PAPER };
