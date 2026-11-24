// Minimal duel HUD: two ink meters, round score as red seals,
// a short how-to line, and the win or lose screen with the duel time and
// Restart. Plain DOM over the canvas; red never goes through the ink pass
// (the ink target is alpha only).
// Side rules are scoped to .bs-hud: the menu's own .bs-side
// (ui/front.ts, display:flex) made each meter a flex item 0 px wide. While a
// Path screen is up, body.bs-pathscreen hides the whole HUD and help line.

import { HUD_SIDE, hudSideCss } from '../core/hudVis.js';
import { guardDragClicks } from './dragGuard.js';
import { MISS_CUE_MS } from '../core/missCue.js';

export interface HudState {
  ink: [number, number];
  score: [number, number];
  hitsToWin: number;
  master: string;
}

export interface Hud {
  update(s: HudState): void;
  showResult(won: boolean, seconds: string, score: [number, number]): void;
  hideResult(): void;
  /** A short line under your seals for a moment: why your stroke did not score. */
  cue(text: string): void;
  dispose(): void;
}

const CSS = `
.bs-hud{position:fixed;inset:0;pointer-events:none;font:15px/1.3 Georgia,'Times New Roman',serif;color:#1b1611;user-select:none}
.bs-hud .bs-side{position:absolute;top:18px;display:block;width:${hudSideCss()}}
.bs-hud .bs-side.l{left:24px}.bs-hud .bs-side.r{right:24px;text-align:right}
body.bs-pathscreen .bs-hud{display:none}
.bs-name{letter-spacing:.12em;font-size:13px;opacity:.8;text-transform:uppercase}
.bs-hud .bs-meter{display:block;width:100%;min-width:${HUD_SIDE.minMeter}px;box-sizing:border-box;height:7px;margin-top:6px;background:rgba(27,22,17,.12);border-radius:4px;overflow:hidden}
.bs-meter i{display:block;height:100%;background:#1b1611;opacity:.82;transform-origin:left center}
.bs-hud .bs-side.r .bs-meter i{transform-origin:right center}
.bs-seals{margin-top:9px;display:flex;gap:7px}
.bs-hud .bs-side.r .bs-seals{justify-content:flex-end}
.bs-sealcap{margin-top:5px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;opacity:.6}
.bs-cue{margin-top:8px;font-size:16px;letter-spacing:.06em;color:#a61e18;opacity:0;transform:translateY(-3px);transition:opacity .12s,transform .12s}
.bs-cue.on{opacity:1;transform:none}
.bs-seal{width:20px;height:20px;border:1.5px solid rgba(166,30,24,.35);border-radius:3px;box-sizing:border-box}
.bs-seal.on{background:#a61e18;border-color:#a61e18;box-shadow:inset 0 0 0 3px #a61e18,inset 0 0 0 4.5px rgba(239,230,210,.75)}
.bs-help{position:absolute;left:0;right:0;bottom:16px;text-align:center;font-size:14px;opacity:.62}
.bs-result{position:absolute;inset:0;display:none;align-items:center;justify-content:center;pointer-events:auto;background:rgba(239,230,210,.55)}
.bs-result.on{display:flex}
.bs-card{text-align:center;padding:28px 44px}
.bs-title{font-size:56px;letter-spacing:.08em}
.bs-title.won{color:#a61e18}
.bs-line{margin-top:8px;font-size:18px;opacity:.85}
.bs-btn{margin-top:22px;font:inherit;font-size:18px;letter-spacing:.1em;padding:10px 28px;border:1.5px solid #1b1611;background:transparent;color:#1b1611;cursor:pointer;border-radius:3px}
.bs-btn:hover{background:#1b1611;color:#efe6d2}
`;

export function createHud(onRestart: () => void, buttonLabel = 'Restart', controls: () => string = () => 'A / D step, Shift dash, hold S to dip.', restartKey: () => string = () => 'R'): Hud {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  const root = document.createElement('div');
  root.className = 'bs-hud';
  root.innerHTML = `
    <div class="bs-side l"><div class="bs-name">You</div><div class="bs-meter"><i></i></div><div class="bs-seals"></div><div class="bs-sealcap">Your hits</div><div class="bs-cue" aria-live="polite"></div></div>
    <div class="bs-side r"><div class="bs-name"></div><div class="bs-meter"><i></i></div><div class="bs-seals"></div><div class="bs-sealcap">Master's hits</div></div>
    <div class="bs-help">Drag across to cut, down for an overhead, click to thrust after a parry. Cut across the faint line to parry. <span class="bs-keys"></span></div>
    <div class="bs-result"><div class="bs-card"><div class="bs-title"></div><div class="bs-line bs-time"></div><div class="bs-line bs-score"></div><button class="bs-btn" type="button">Restart</button><div class="bs-line" style="font-size:13px;opacity:.6">or press R</div></div></div>`;
  document.body.appendChild(root);
  const q = <T extends Element>(sel: string, i = 0) => root.querySelectorAll<T & Element>(sel)[i] as unknown as T;
  const meters = [q<HTMLElement>('.bs-meter i', 0), q<HTMLElement>('.bs-meter i', 1)];
  const sealRows = [q<HTMLElement>('.bs-seals', 0), q<HTMLElement>('.bs-seals', 1)];
  const foeName = q<HTMLElement>('.bs-name', 1);
  const result = q<HTMLElement>('.bs-result');
  const title = q<HTMLElement>('.bs-title');
  const time = q<HTMLElement>('.bs-time');
  const scoreLine = q<HTMLElement>('.bs-score');
  const button = q<HTMLButtonElement>('.bs-btn');
  button.textContent = buttonLabel;
  const keysLine = q<HTMLElement>('.bs-keys');
  const pressLine = q<HTMLElement>('.bs-line', 2);
  const caps = [q<HTMLElement>('.bs-sealcap', 0), q<HTMLElement>('.bs-sealcap', 1)];
  const cueLine = q<HTMLElement>('.bs-cue');
  let cueTimer = 0;
  // Keys can change in Pause > Settings > Keys mid-fight: both lines follow the bindings.
  let lastControls = '';
  let lastRestart = '';
  const drawKeys = () => {
    const c = controls();
    if (c !== lastControls) keysLine.textContent = lastControls = c;
    const r = restartKey();
    if (r !== lastRestart) pressLine.textContent = `or press ${(lastRestart = r)}`;
  };
  drawKeys();
  button.addEventListener('click', onRestart);
  guardDragClicks(q<HTMLElement>('.bs-result'));

  // Last drawn values: the DOM is touched only on change.
  const lastInk = [-1, -1];
  const lastScore = [-1, -1];
  let lastMaster = '';
  let seals = 0;

  return {
    update(s) {
      drawKeys();
      if (s.master !== lastMaster) {
        lastMaster = s.master;
        foeName.textContent = s.master;
      }
      if (seals !== s.hitsToWin) {
        seals = s.hitsToWin;
        for (const row of sealRows) row.innerHTML = '<span class="bs-seal"></span>'.repeat(seals);
        caps[0].textContent = `Your hits, first to ${seals}`;
        caps[1].textContent = "Master's hits";
        lastScore[0] = lastScore[1] = -1;
      }
      for (let i = 0; i < 2; i++) {
        const ink = Math.round(s.ink[i]);
        if (ink !== lastInk[i]) {
          lastInk[i] = ink;
          meters[i].style.transform = `scaleX(${ink / 100})`;
        }
        if (s.score[i] !== lastScore[i]) {
          lastScore[i] = s.score[i];
          const kids = sealRows[i].children;
          for (let k = 0; k < kids.length; k++) kids[k].classList.toggle('on', k < s.score[i]);
        }
      }
    },
    showResult(won, seconds, score) {
      title.textContent = won ? 'Victory' : 'Defeat';
      title.classList.toggle('won', won);
      time.textContent = `Duel time ${seconds}`;
      scoreLine.textContent = `Clean hits ${score[0]} : ${score[1]}`;
      drawKeys();
      result.classList.add('on');
    },
    hideResult() {
      result.classList.remove('on');
    },
    cue(text) {
      cueLine.textContent = text;
      cueLine.classList.add('on');
      window.clearTimeout(cueTimer);
      cueTimer = window.setTimeout(() => cueLine.classList.remove('on'), MISS_CUE_MS);
    },
    dispose() {
      root.remove();
      style.remove();
    },
  };
}
