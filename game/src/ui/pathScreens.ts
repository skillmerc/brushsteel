// Path mode screens: brush pick, the scroll map, shrine and
// the end of a run. Plain DOM and SVG over the canvas, ink on paper. Every
// seal and brush shows its full text; the map names the
// daily scroll by its UTC day (limit 3) and always offers End run (limit 4).

import { gameAudio } from '../audio/index.js';
import { BRUSHES, PATH_RULES, brushById, choices, sealById, type BrushId, type PathMap, type RunState, type SealId } from '../core/path.js';
import { endTitle, livesShown, nodeLabel } from '../core/session.js';
import { pathPadStep } from '../core/front.js';

const INK = '#1b1611';
const RED = '#a61e18';
const PAPER = '#efe6d2';

const CSS = `
.bs-path{position:fixed;inset:0;z-index:20;display:none;overflow:auto;background:rgba(239,230,210,.78);background-image:radial-gradient(ellipse at 50% 40%,rgba(255,250,236,.7),rgba(239,230,210,0) 70%);font:16px/1.4 Georgia,'Times New Roman',serif;color:${INK}}
.bs-path.on{display:block}
.bs-pw{max-width:1180px;margin:0 auto;padding:64px 32px 40px;box-sizing:border-box}
.bs-ph{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;flex-wrap:wrap;border-bottom:1.5px solid rgba(27,22,17,.25);padding-bottom:14px}
.bs-pt{font-size:44px;letter-spacing:.14em;line-height:1}
.bs-ps{font-size:15px;opacity:.75;margin-top:8px}
.bs-pr{text-align:right;font-size:15px}
.bs-lives{display:inline-flex;gap:6px;vertical-align:middle;margin-left:8px}
.bs-drop{width:14px;height:14px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);border:1.5px solid ${INK};box-sizing:border-box}
.bs-drop.in{background:${INK}}.bs-drop.stake{background:${RED};border-color:${RED}}.bs-drop.gone{opacity:.3}
.bs-pmap{display:block;width:100%;height:auto;margin:18px 0 8px}
.bs-pmap .go{cursor:pointer}
.bs-pmap .go circle.ring{animation:bs-pulse 1.6s ease-in-out infinite}
@keyframes bs-pulse{50%{stroke-opacity:.35}}
.bs-pmap .go:hover circle.body,.bs-pmap .go:focus-visible circle.body{fill:rgba(166,30,24,.14)}
.bs-pmap .go{outline:none}
.bs-pmap .go:focus-visible circle.ring{stroke:${INK};stroke-width:4;stroke-opacity:1;animation:none}
.bs-pmap text{font-family:Georgia,'Times New Roman',serif}
.bs-prow{display:flex;justify-content:space-between;align-items:flex-start;gap:28px;flex-wrap:wrap;margin-top:6px}
.bs-pseals{flex:1;min-width:280px;font-size:14px}
.bs-pseals b{color:${RED};font-weight:normal;letter-spacing:.04em}
.bs-pnote{font-size:16px;margin:4px 0 10px;min-height:22px}
.bs-pbtns{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.bs-pb{font:inherit;font-size:16px;letter-spacing:.08em;padding:9px 22px;border:1.5px solid ${INK};background:transparent;color:${INK};cursor:pointer;border-radius:3px}
.bs-pb:hover{background:${INK};color:${PAPER}}
.bs-pb.main{border-color:${RED};color:${RED}}
.bs-pb.main:hover{background:${RED};color:${PAPER}}
.bs-pb:focus{outline:none}
.bs-pb:focus-visible{outline:2px solid ${RED};outline-offset:3px}
.bs-pb.quiet{border-color:rgba(27,22,17,.4);opacity:.8}
.bs-pcards{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:18px;margin:26px 0}
.bs-pc{border:1.5px solid rgba(27,22,17,.35);border-radius:4px;padding:20px 22px;background:rgba(255,250,236,.35);display:flex;flex-direction:column;gap:12px}
.bs-pc:focus-within{border-color:${RED}}
.bs-pc h3{margin:0;font-weight:normal;font-size:22px;letter-spacing:.06em;color:${RED}}
.bs-pc p{margin:0;flex:1}
.bs-pend{text-align:center;padding-top:12vh}
.bs-pend .bs-pt{font-size:60px}
.bs-pend .bs-pt.won{color:${RED}}
.bs-pend p{margin:10px 0;font-size:18px}
.bs-pend .bs-pbtns{justify-content:center;margin-top:26px}
`;

export interface PathScreens {
  brush(o: { scroll: string; nextIn: string; onPick: (b: BrushId) => void }): void;
  map(o: { run: RunState; map: PathMap; scroll: string; nextIn: string; note: string; onMove: (id: string) => void; onFight: () => void; onEnd: () => void }): void;
  shrine(o: { run: RunState; scroll: string; onPick: (s: SealId | null) => void; onEnd: () => void }): void;
  end(o: { run: RunState; map: PathMap; scroll: string; onNew: () => void }): void;
  hide(): void;
  /**
   * A controller intent while a Path screen is up. True when the screen took it
   * (up and down move focus, A on a map node); false sends it the usual way (A clicks a focused
   * button, B and Start send Escape, which a Path screen ignores).
   */
  pad(intent: string): boolean;
  readonly root: HTMLElement;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function button(text: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', `bs-pb ${cls}`.trim(), text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/** "End run" asks once more before it ends the run. */
function endButton(onEnd: () => void): HTMLButtonElement {
  let armed = false;
  const b = button('End run', 'quiet', () => {
    if (armed) return onEnd();
    armed = true;
    b.textContent = 'End this run? Click again';
  });
  return b;
}

function livesRow(run: RunState): HTMLElement {
  const wrap = el('span');
  wrap.append('Lives');
  const drops = el('span', 'bs-lives');
  const l = livesShown(run);
  const add = (n: number, cls: string) => {
    for (let i = 0; i < n; i++) drops.append(el('span', `bs-drop ${cls}`));
  };
  add(l.inHand, 'in');
  add(l.atStake, 'stake');
  add(l.gone, 'gone');
  wrap.append(drops);
  wrap.title = l.atStake ? 'Red: the life at stake in this duel. A win gives it back.' : `${l.inHand} of ${PATH_RULES.LIVES}`;
  return wrap;
}

function header(title: string, sub: string[], right: Node[]): HTMLElement {
  const h = el('div', 'bs-ph');
  const left = el('div');
  left.append(el('div', 'bs-pt', title));
  for (const s of sub) left.append(el('div', 'bs-ps', s));
  const r = el('div', 'bs-pr');
  for (const x of right) {
    const line = el('div');
    line.append(x);
    r.append(line);
  }
  h.append(left, r);
  return h;
}

const SVGNS = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

const ROMAN = ['I', 'II', 'III', 'IV'];

function drawMap(run: RunState, map: PathMap, onMove: (id: string) => void): SVGSVGElement {
  const W = 1100;
  const H = 330;
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'bs-pmap', role: 'img', 'aria-label': 'The scroll map' });
  // Columns: every row of every act, with a wider gap between acts.
  const cols: { act: number; x: number }[] = [];
  const GAP = 0.7;
  let c = 0;
  const xOf: Record<string, number> = {};
  const yOf: Record<string, number> = {};
  const colIndex: number[][] = [];
  for (const act of map.acts) {
    colIndex.push([]);
    for (let r = 0; r < act.rows.length; r++) {
      colIndex[act.index].push(c);
      cols.push({ act: act.index, x: c });
      c += 1;
    }
    c += GAP;
  }
  const span = c - GAP - 1;
  const x0 = 50;
  const step = (W - 2 * x0) / span;
  for (const act of map.acts) {
    act.rows.forEach((row, r) => {
      row.forEach((id, k) => {
        xOf[id] = x0 + colIndex[act.index][r] * step;
        yOf[id] = 175 + (k - (row.length - 1) / 2) * 92;
      });
    });
    const a = colIndex[act.index];
    const mid = x0 + ((a[0] + a[a.length - 1]) / 2) * step;
    const t = svg('text', { x: mid, y: 30, 'text-anchor': 'middle', 'font-size': 17, 'letter-spacing': 3, fill: INK, opacity: 0.7 });
    t.textContent = `Act ${ROMAN[act.index]}`;
    s.append(t);
    if (act.index > 0) {
      const sepX = x0 + (a[0] - (GAP + 1) / 2) * step;
      s.append(svg('line', { x1: sepX, y1: 48, x2: sepX, y2: H - 10, stroke: INK, 'stroke-opacity': 0.12, 'stroke-width': 1.5, 'stroke-dasharray': '2 7' }));
    }
  }
  // Links: faint brush lines; the walked route in full ink.
  const walked = new Set<string>();
  for (let i = 1; i < run.visited.length; i++) walked.add(`${run.visited[i - 1]}>${run.visited[i]}`);
  const links = svg('g', {});
  for (const node of Object.values(map.nodes)) {
    for (const n of node.next) {
      const on = walked.has(`${node.id}>${n}`);
      const mx = (xOf[node.id] + xOf[n]) / 2;
      links.append(svg('path', {
        d: `M${xOf[node.id]},${yOf[node.id]} C${mx},${yOf[node.id]} ${mx},${yOf[n]} ${xOf[n]},${yOf[n]}`,
        fill: 'none', stroke: INK, 'stroke-width': on ? 3.4 : 1.6, 'stroke-opacity': on ? 0.85 : 0.22, 'stroke-linecap': 'round',
      }));
    }
  }
  s.append(links);
  // Nodes.
  const next = new Set(choices(run, map));
  const visited = new Set(run.visited);
  for (const node of Object.values(map.nodes)) {
    const x = xOf[node.id];
    const y = yOf[node.id];
    const isMaster = node.kind === 'master';
    const R = isMaster ? 23 : 17;
    const go = next.has(node.id);
    const g = svg('g', { class: go ? 'go' : '' });
    const done = visited.has(node.id);
    const here = run.at === node.id;
    if (here) g.append(svg('circle', { cx: x, cy: y, r: R + 8, fill: 'none', stroke: RED, 'stroke-width': 2 }));
    if (go) g.append(svg('circle', { class: 'ring', cx: x, cy: y, r: R + 7, fill: 'none', stroke: RED, 'stroke-width': 2.5 }));
    const fill = isMaster ? (done ? RED : PAPER) : done ? INK : PAPER;
    g.append(svg('circle', { class: 'body', cx: x, cy: y, r: R, fill, 'fill-opacity': done && !isMaster ? 0.85 : 1, stroke: isMaster ? RED : INK, 'stroke-width': isMaster ? 2.5 : 2 }));
    const glyphColor = done ? PAPER : isMaster ? RED : INK;
    if (node.kind === 'shrine') g.append(svg('rect', { x: x - 6, y: y - 6, width: 12, height: 12, rx: 1.5, fill: done ? PAPER : RED }));
    else if (node.kind === 'well') g.append(svg('path', { d: `M${x},${y - 9} C${x + 8},${y + 1} ${x + 6},${y + 8} ${x},${y + 8} C${x - 6},${y + 8} ${x - 8},${y + 1} ${x},${y - 9}Z`, fill: glyphColor }));
    else {
      const t = svg('text', { x, y: y + (isMaster ? 7 : 6), 'text-anchor': 'middle', 'font-size': isMaster ? 20 : 16, fill: glyphColor });
      t.textContent = String(node.master);
      g.append(t);
    }
    const label = svg('text', { x, y: y + R + (go || here ? 26 : 20), 'text-anchor': 'middle', 'font-size': 13, fill: INK, opacity: go ? 1 : 0.62 });
    label.textContent = nodeLabel(node);
    g.append(label);
    if (go) {
      g.setAttribute('tabindex', '0');
      g.setAttribute('role', 'button');
      g.setAttribute('aria-label', nodeLabel(node));
      g.addEventListener('click', () => onMove(node.id));
      g.addEventListener('keydown', (e) => {
        const k = e as KeyboardEvent;
        if (k.key !== 'Enter' && k.key !== ' ') return;
        // The press ends here: its keypress must not click the stop the next screen opens on
        // (a shrine opens with "Take this seal" focused), and a held key does not walk on.
        k.preventDefault();
        if (!k.repeat) onMove(node.id);
      });
    }
    s.append(g);
  }
  return s;
}

function sealList(ids: readonly SealId[]): HTMLElement {
  const box = el('div', 'bs-pseals');
  if (!ids.length) {
    box.append(el('div', '', 'Seals: none yet. Shrines offer them.'));
    return box;
  }
  box.append(el('div', '', 'Seals held'));
  for (const id of ids) {
    const s = sealById(id);
    const line = el('div');
    line.append(el('b', '', s.name), `: ${s.text}`);
    box.append(line);
  }
  return box;
}

export function createPathScreens(): PathScreens {
  const style = el('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  const root = el('div', 'bs-path');
  document.body.appendChild(root);
  // The stops of the open screen in page order: reachable map nodes and buttons.
  const stops = () => [...root.querySelectorAll<HTMLElement | SVGElement>('button:not([disabled]), [tabindex="0"]')];
  const show = (...kids: HTMLElement[]) => {
    root.replaceChildren(...kids);
    root.classList.add('on');
    root.scrollTop = 0;
    // A controller player has no pointer: start on the first stop, unless something on it already has focus.
    if (!root.contains(document.activeElement)) stops()[0]?.focus();
  };

  return {
    root,
    brush({ scroll, nextIn, onPick }) {
      const w = el('div', 'bs-pw');
      w.append(header('PATH', [scroll, `A new scroll every day at 00:00 UTC, next in ${nextIn}.`], []));
      w.append(el('p', 'bs-pnote', `Three acts of duels, shrines and ink wells, up to Master 8. You carry ${PATH_RULES.LIVES} lives: a lost duel costs one, and so does leaving a duel before it ends. Pick your brush for the run.`));
      const cards = el('div', 'bs-pcards');
      for (const b of BRUSHES) {
        const c = el('div', 'bs-pc');
        c.append(el('h3', '', b.name), el('p', '', b.text), button('Take this brush', 'main', () => onPick(b.id)));
        cards.append(c);
      }
      w.append(cards);
      show(w);
    },
    map({ run, map, scroll, nextIn, note, onMove, onFight, onEnd }) {
      const w = el('div', 'bs-pw');
      w.append(header('PATH', [scroll, `Next scroll in ${nextIn}.`], [livesRow(run), document.createTextNode(brushById(run.brush).name)]));
      w.append(drawMap(run, map, onMove));
      const row = el('div', 'bs-prow');
      const left = el('div');
      const btns = el('div', 'bs-pbtns');
      if (run.status === 'duel' && run.at) {
        const node = map.nodes[run.at];
        left.append(el('div', 'bs-pnote', note || `${nodeLabel(node)} waits. One life is at stake: a win gives it back.`));
        btns.append(button(`Fight ${nodeLabel(node)}`, 'main', onFight));
      } else {
        left.append(el('div', 'bs-pnote', note || 'Choose your next step: the red rings.'));
      }
      btns.append(endButton(onEnd));
      left.append(btns);
      row.append(left, sealList(run.seals));
      w.append(row);
      show(w);
    },
    shrine({ run, scroll, onPick, onEnd }) {
      const w = el('div', 'bs-pw');
      w.append(header('SHRINE', [scroll, 'Take one seal for the rest of the run, or none.'], [livesRow(run), document.createTextNode(brushById(run.brush).name)]));
      const cards = el('div', 'bs-pcards');
      for (const id of run.offer) {
        const s = sealById(id);
        const c = el('div', 'bs-pc');
        c.append(el('h3', '', s.name), el('p', '', s.text), button('Take this seal', 'main', () => {
          gameAudio.cue('seal');
          onPick(id);
        }));
        cards.append(c);
      }
      w.append(cards);
      const btns = el('div', 'bs-pbtns');
      btns.append(button('Take none', '', () => onPick(null)), endButton(onEnd));
      w.append(btns);
      const held = sealList(run.seals);
      held.style.marginTop = '22px';
      w.append(held);
      show(w);
    },
    end({ run, map, scroll, onNew }) {
      const w = el('div', 'bs-pw bs-pend');
      const t = el('div', 'bs-pt', endTitle(run));
      if (run.result === 'won') t.classList.add('won');
      w.append(t);
      const act = run.at ? map.nodes[run.at].act : 0;
      const where = run.result === 'won' ? 'Master 8 is beaten.' : `The run ended in act ${ROMAN[act]}${run.at ? `, at ${nodeLabel(map.nodes[run.at])}` : ''}.`;
      w.append(el('p', '', where));
      w.append(el('p', '', `Duels won ${run.duelsWon}, lost ${run.duelsLost}. ${brushById(run.brush).name}.`));
      w.append(el('p', '', run.seals.length ? `Seals: ${run.seals.map((s) => sealById(s).name).join(', ')}.` : 'No seals taken.'));
      w.append(el('p', 'bs-ps', scroll));
      const btns = el('div', 'bs-pbtns');
      btns.append(button('New run', 'main', onNew));
      w.append(btns);
      show(w);
    },
    hide() {
      root.classList.remove('on');
      root.replaceChildren();
    },
    pad(intent) {
      if (!root.classList.contains('on')) return false;
      const list = stops();
      const a = document.activeElement;
      const index = list.findIndex((x) => x === a);
      const step = pathPadStep(intent, index, list.length, a instanceof HTMLButtonElement);
      if (!step) return false;
      if ('focus' in step) list[step.focus].focus();
      else list[index].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    },
  };
}
