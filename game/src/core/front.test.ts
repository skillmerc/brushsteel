import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS, MET_KEY, SETTINGS_KEY, addMet, frontReducer, loadMet, loadSettings, pauseReducer, qualityFor,
  median, needsQualityProbe, pickAutoQuality, withAutoQuality,
  dailyMenuLine, nextFocus, isDragNotClick, pauseOnBlur, DRAG_CLICK_SLOP_PX, pathPadStep, STROKE_DEMOS, crossesSegment, demoPath, quitFight, saveSettings, startScreen, strokeCutsTitle, type FrontScreen,
} from './front.js';
import { PATH_RULES, dailySeed, type PathMap, type RunState } from './path.js';
import type { KeyValueStore } from './save.js';
import { guardStore, memoryStore, openSession } from './session.js';

const throwing: KeyValueStore = {
  getItem() { throw new DOMException('denied', 'SecurityError'); },
  setItem() { throw new DOMException('denied', 'SecurityError'); },
  removeItem() { throw new DOMException('denied', 'SecurityError'); },
};

test('front: the title only leaves by a cut (or Enter), and every sub screen goes back to the menu', () => {
  assert.equal(frontReducer('title', { type: 'back' }), 'title');
  assert.equal(frontReducer('title', { type: 'open', screen: 'settings' }), 'title');
  assert.equal(frontReducer('title', { type: 'start' }), 'menu');
  for (const s of ['masters', 'settings', 'howto', 'credits'] as const) {
    assert.equal(frontReducer('menu', { type: 'open', screen: s }), s);
    assert.equal(frontReducer(s, { type: 'back' }), 'menu');
    assert.equal(frontReducer(s, { type: 'open', screen: 'credits' }), s, 'no jump between sub screens');
  }
  assert.equal(frontReducer('menu', { type: 'back' }), 'menu');
  assert.equal(frontReducer('menu', { type: 'start' }), 'menu');
});

test('front: where a page opens', () => {
  const cases: [string, FrontScreen | null][] = [
    ['', 'title'], ['?', 'title'], ['?menu=1', 'menu'], ['?menu=settings', 'settings'],
    ['?menu=masters', 'masters'], ['?menu=howto', 'howto'], ['?menu=credits', 'credits'], ['?menu=title', 'menu'], ['?menu=nope', 'menu'],
    ['?mode=path', null], ['?master=3', null], ['?demo=duel', null], ['?debug=poses', null], ['?quality=high', 'title'],
  ];
  for (const [q, want] of cases) assert.equal(startScreen(q), want, q);
});

test('pause: Esc opens and closes, Settings goes back to Pause on Esc', () => {
  assert.equal(pauseReducer('playing', { type: 'esc' }), 'paused');
  assert.equal(pauseReducer('paused', { type: 'esc' }), 'playing');
  assert.equal(pauseReducer('paused', { type: 'resume' }), 'playing');
  assert.equal(pauseReducer('paused', { type: 'settings' }), 'settings');
  assert.equal(pauseReducer('settings', { type: 'esc' }), 'paused');
  assert.equal(pauseReducer('playing', { type: 'settings' }), 'playing');
  assert.equal(pauseReducer('paused', { type: 'quit' }), 'paused', 'quit is the caller\'s');
});

function onPathDuel(store: KeyValueStore) {
  const s = openSession(store);
  s.dispatch({ type: 'start', seed: 42, brush: 'standard' });
  const map = s.map as PathMap;
  const run = s.run as RunState;
  const id = (run.at === null ? map.start : map.nodes[run.at].next).find((n) => map.nodes[n].kind === 'duel' || map.nodes[n].kind === 'master');
  assert.ok(id);
  s.dispatch({ type: 'move', to: id as string });
  return s;
}

test('pause quit in Path: a fight under way costs a life (booked at once, and not twice on reopen)', () => {
  const store = memoryStore();
  const s = onPathDuel(store);
  s.dispatch({ type: 'duel-begin' });
  assert.equal(s.run?.lives, PATH_RULES.LIVES - 1, 'one life at stake');
  let p = pauseReducer('playing', { type: 'esc' });
  assert.equal(p, 'paused');
  assert.equal(quitFight(s), true, 'quit books the loss');
  assert.equal(s.run?.duelsLost, 1);
  assert.equal(s.run?.fighting, false);
  assert.equal(s.run?.lives, PATH_RULES.LIVES - 2, 'the staked life is gone and the retry stakes the next');
  const again = openSession(store);
  assert.equal(again.run?.duelsLost, 1, 'reopening does not book it twice');
  assert.equal(again.run?.lives, PATH_RULES.LIVES - 2);
  p = pauseReducer(p, { type: 'resume' });
  assert.equal(p, 'playing');
});

test('pause quit in Path: no fight under way (retry waiting on the map) costs nothing', () => {
  const store = memoryStore();
  const s = onPathDuel(store);
  const before = s.run;
  assert.equal(quitFight(s), false);
  assert.ok(s.run === before);
  assert.equal(quitFight(null), false, 'a plain duel has no run');
});

test('pause quit: the last life lost ends the run', () => {
  const store = memoryStore();
  const s = onPathDuel(store);
  for (let i = 0; i < PATH_RULES.LIVES; i++) {
    if (s.run?.status !== 'duel') break;
    s.dispatch({ type: 'duel-begin' });
    quitFight(s);
  }
  assert.equal(s.run?.status, 'over');
  assert.equal(s.run?.result, 'lost');
});

test('settings: save and load, bad values fall back, a throwing store never throws', () => {
  const store = memoryStore();
  assert.deepEqual(loadSettings(store), DEFAULT_SETTINGS);
  assert.equal(saveSettings(store, { volume: 35, quality: 'high' }), true);
  assert.deepEqual(loadSettings(store), { volume: 35, quality: 'high' });
  saveSettings(store, { volume: 250, quality: 'low' });
  assert.deepEqual(loadSettings(store), { volume: 100, quality: 'low' });
  for (const bad of ['{', 'null', '[]', '{"volume":"x","quality":"ultra"}', 'x'.repeat(3000)]) {
    store.setItem(SETTINGS_KEY, bad);
    assert.deepEqual(loadSettings(store), DEFAULT_SETTINGS, bad.slice(0, 20));
  }
  store.setItem(SETTINGS_KEY, '{"volume":-4}');
  assert.deepEqual(loadSettings(store), { volume: 0, quality: 'low' });
  assert.deepEqual(loadSettings(throwing), DEFAULT_SETTINGS);
  assert.equal(saveSettings(throwing, { volume: 10, quality: 'high' }), false);
  const guarded = guardStore(() => { throw new DOMException('denied', 'SecurityError'); });
  assert.equal(saveSettings(guarded, { volume: 10, quality: 'high' }), true);
  assert.deepEqual(loadSettings(guarded), DEFAULT_SETTINGS);
});

test('settings: ?quality= in the address wins over the setting', () => {
  assert.equal(qualityFor('', { volume: 50, quality: 'high' }), 'high');
  assert.equal(qualityFor('?quality=medium', { volume: 50, quality: 'high' }), 'medium');
  assert.equal(qualityFor('?menu=1&quality=low', { volume: 50, quality: 'high' }), 'low');
});

test('met: master 1 always, others once faced, junk ignored, throwing store safe', () => {
  const store = memoryStore();
  assert.deepEqual(loadMet(store), [1]);
  assert.deepEqual(addMet(store, 3), [1, 3]);
  assert.deepEqual(addMet(store, 3), [1, 3]);
  assert.deepEqual(addMet(store, 99), [1, 3], 'no master 99');
  assert.deepEqual(loadMet(store), [1, 3]);
  store.setItem(MET_KEY, '[2,"5",8,8,-1,{}]');
  assert.deepEqual(loadMet(store), [1, 2, 8]);
  store.setItem(MET_KEY, 'not json');
  assert.deepEqual(loadMet(store), [1]);
  assert.deepEqual(loadMet(throwing), [1]);
  assert.deepEqual(addMet(throwing, 4), [1, 4], 'kept for the call even when the store refuses');
});

test('title cut: a stroke across the title cuts it; short, above or below does not', () => {
  const r = { left: 100, top: 200, width: 600, height: 120 };
  const line = (x0: number, y0: number, x1: number, y1: number) => [{ x: x0, y: y0 }, { x: x1, y: y1 }];
  assert.equal(strokeCutsTitle(line(50, 260, 750, 260), r), true, 'straight across');
  assert.equal(strokeCutsTitle(line(80, 180, 720, 340), r), true, 'diagonal through, two points only');
  assert.equal(strokeCutsTitle(line(750, 250, 50, 290), r), true, 'right to left');
  assert.equal(strokeCutsTitle(line(300, 260, 500, 260), r), false, 'too short');
  assert.equal(strokeCutsTitle(line(50, 150, 750, 150), r), false, 'above');
  assert.equal(strokeCutsTitle(line(50, 400, 750, 400), r), false, 'below');
  assert.equal(strokeCutsTitle(line(400, 100, 400, 500), r), false, 'straight down');
  assert.equal(strokeCutsTitle([], r), false);
});

test('front: arrow keys move focus over a list and wrap (menu and Pause)', () => {
  assert.equal(nextFocus(0, 3, 'ArrowDown'), 1);
  assert.equal(nextFocus(2, 3, 'ArrowDown'), 0);
  assert.equal(nextFocus(0, 3, 'ArrowUp'), 2);
  assert.equal(nextFocus(-1, 3, 'ArrowDown'), 0);
  assert.equal(nextFocus(-1, 3, 'ArrowUp'), 2);
  assert.equal(nextFocus(0, 0, 'ArrowDown'), -1);
});

test('front: the Daily scroll menu line does not repeat "Daily scroll" and warns before ending an older run', () => {
  const now = new Date(Date.UTC(2026, 10, 20, 18, 58));
  const line = dailyMenuLine(null, now);
  assert.match(line, /^20 Nov \(UTC\), next in /);
  assert.equal(/daily scroll/i.test(line), false);
  assert.equal(dailyMenuLine({ status: 'map', seed: dailySeed('2026-11-20') }, now), line);
  assert.equal(dailyMenuLine({ status: 'map', seed: dailySeed('2026-11-19') }, now), '20 Nov (UTC), ends your older run');
  assert.equal(dailyMenuLine({ status: 'over', seed: dailySeed('2026-11-19') }, now), line);
});

test('front: How to play stroke demos match the duel directions', () => {
  const by = (k: string) => {
    const d = STROKE_DEMOS.find((x) => x.kind === k);
    assert.ok(d, k);
    return d;
  };
  assert.deepEqual(STROKE_DEMOS.map((d) => d.kind), ['cut', 'overhead', 'rising', 'thrust', 'parry']);
  for (const d of STROKE_DEMOS) {
    for (const p of [...d.stroke, ...(d.line ?? [])]) assert.ok(p.x >= 0 && p.x <= 120 && p.y >= 0 && p.y <= 80, `${d.kind} inside the box`);
    assert.ok(d.caption.length > 0);
  }
  const first = (k: string) => by(k).stroke[0];
  const last = (k: string) => by(k).stroke[by(k).stroke.length - 1];
  assert.ok(last('overhead').y - first('overhead').y > 40, 'overhead goes down');
  assert.ok(first('rising').y - last('rising').y > 40, 'rising goes up');
  assert.ok(Math.abs(last('cut').x - first('cut').x) > 60, 'cut goes across');
  assert.equal(by('thrust').stroke.length, 1, 'thrust is a click');
  const parry = by('parry');
  assert.ok(parry.line);
  assert.ok(crossesSegment(parry.stroke, parry.line[0], parry.line[1]), 'parry cuts the faint line');
  assert.ok(!crossesSegment(by('rising').stroke, { x: 0, y: 79 }, { x: 120, y: 79 }), 'no false cross');
  assert.equal(demoPath([{ x: 1, y: 2 }, { x: 3, y: 4 }]), 'M1 2 L3 4');
});

test('front: a pad on a Path screen moves focus with up and down, A activates a map node, B and Start take the usual route', () => {
  assert.deepEqual(pathPadStep('down', -1, 3, false), { focus: 0 });
  assert.deepEqual(pathPadStep('up', -1, 3, false), { focus: 2 });
  assert.deepEqual(pathPadStep('down', 2, 3, true), { focus: 0 });
  assert.deepEqual(pathPadStep('up', 1, 3, true), { focus: 0 });
  assert.equal(pathPadStep('down', -1, 0, false), null);
  assert.deepEqual(pathPadStep('confirm', 0, 3, false), { activate: true });
  assert.equal(pathPadStep('confirm', 0, 3, true), null, 'a button keeps the click route');
  assert.equal(pathPadStep('confirm', -1, 3, false), null, 'nothing focused: nothing to press');
  for (const i of ['back', 'pause', 'left', 'right']) assert.equal(pathPadStep(i, 0, 3, false), null, i);
});

test('auto quality: median and the 14 ms threshold', () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.ok(Number.isNaN(median([])));
  const fast = Array.from({ length: 100 }, (_, i) => (i % 10 === 0 ? 40 : 8.3));
  assert.equal(pickAutoQuality(fast), 'high');
  assert.equal(pickAutoQuality(Array(50).fill(16.7)), 'low');
  assert.equal(pickAutoQuality(Array(50).fill(14)), 'low');
  assert.equal(pickAutoQuality(Array(50).fill(13.9)), 'high');
  assert.equal(pickAutoQuality([8, 8, 8]), null);
  assert.equal(pickAutoQuality([...Array(20).fill(NaN), ...Array(5).fill(8)]), null);
});

test('auto quality: the player choice wins, the address wins, saved and loaded', () => {
  const plain = { volume: 80, quality: 'low' as const };
  assert.equal(needsQualityProbe('', plain), true);
  assert.equal(needsQualityProbe('?menu=1', plain), true);
  assert.equal(needsQualityProbe('?quality=low', plain), false);
  assert.equal(needsQualityProbe('?menu=1&quality=high', plain), false);
  assert.equal(needsQualityProbe('', { ...plain, qualityBy: 'player' }), false);
  assert.equal(needsQualityProbe('', { ...plain, qualityBy: 'auto' }), false);
  assert.equal(needsQualityProbe('', { volume: 80, quality: 'high' }), false, 'an old save with high was the player');
  assert.deepEqual(withAutoQuality(plain, 'high'), { volume: 80, quality: 'high', qualityBy: 'auto' });
  const mine = { volume: 80, quality: 'low' as const, qualityBy: 'player' as const };
  assert.ok(withAutoQuality(mine, 'high') === mine);
  assert.ok(withAutoQuality(plain, null) === plain);
  assert.equal(qualityFor('?quality=low', withAutoQuality(plain, 'high')), 'low');
  assert.equal(qualityFor('', withAutoQuality(plain, 'high')), 'high');
  const store = memoryStore();
  saveSettings(store, withAutoQuality(plain, 'high'));
  assert.deepEqual(loadSettings(store), { volume: 80, quality: 'high', qualityBy: 'auto' });
  saveSettings(store, { volume: 80, quality: 'low', qualityBy: 'player' });
  assert.deepEqual(loadSettings(store), { volume: 80, quality: 'low', qualityBy: 'player' });
  store.setItem(SETTINGS_KEY, '{"volume":50,"quality":"high","qualityBy":"robot"}');
  assert.deepEqual(loadSettings(store), { volume: 50, quality: 'high' });
});

test('front: a cut dragged over a button is not a click; a still press is', () => {
  assert.equal(isDragNotClick({ x: 100, y: 100 }, { x: 103, y: 104 }), false);
  assert.equal(isDragNotClick({ x: 100, y: 100 }, { x: 100 + DRAG_CLICK_SLOP_PX + 1, y: 100 }), true);
  assert.equal(isDragNotClick({ x: 10, y: 10 }, { x: 400, y: 260 }), true);
  assert.equal(isDragNotClick(null, { x: 0, y: 0 }), false);
});

test('front: a blur pauses a live fight only when the page has really lost focus', () => {
  const live = { playing: true, fighting: true };
  assert.equal(pauseOnBlur({ ...live, hasFocus: true, hidden: false }), false);
  assert.equal(pauseOnBlur({ ...live, hasFocus: false, hidden: false }), true);
  assert.equal(pauseOnBlur({ ...live, hasFocus: true, hidden: true }), true);
  assert.equal(pauseOnBlur({ playing: false, fighting: true, hasFocus: false, hidden: false }), false);
  assert.equal(pauseOnBlur({ playing: true, fighting: false, hasFocus: false, hidden: false }), false);
});
