import { createStage } from './render/index.js';
import { createPoseDebug, type PoseDebug } from './render/debugPoses.js';
import { createInkComposer } from './render/inkpass.js';
import { createDuelScene, type DuelScene } from './render/duelScene.js';
import { seedFromString } from './core/rng.js';
import { STAGE_LOOK_IDS } from './core/stages.js';
import { masterByIndex } from './core/masters.js';
import { guardStore, memoryStore, openSession } from './core/session.js';
import { AUTO_PROBE_MS, AUTO_PROBE_SKIP_MS, BLUR_PAUSE_CHECK_MS, pauseOnBlur, addMet, dailyMenuLine, loadMet, loadSettings, needsQualityProbe, pauseReducer, pickAutoQuality, qualityFor, saveSettings, startScreen, withAutoQuality, type PauseState, type Settings } from './core/front.js';
import { loadKeys, saveKeys, type KeyBindings } from './core/keys.js';
import { createPathMode, type PathMode } from './pathMode.js';
import { createModeSwitch } from './ui/modeSwitch.js';
import { createFrontEnd, createPause, type FrontEnd } from './ui/front.js';
import { createPadReader, padArea, type MenuIntent } from './input/gamepad.js';
import { gameAudio } from './audio/index.js';

const canvas = document.getElementById('stage');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('BRUSHSTEEL: canvas #stage missing');

const params = new URLSearchParams(location.search);
// Settings and masters met. localStorage may be missing or throw (private mode):
// then nothing is saved and nothing is written to the console.
const store = guardStore(() => window.localStorage);
const canSave = (() => {
  try {
    const ls = window.localStorage;
    ls.setItem('brushsteel.probe', '1');
    ls.removeItem('brushsteel.probe');
    return true;
  } catch {
    return false;
  }
})();
let settings: Settings = loadSettings(store);
const setSettings = (next: Settings): boolean => {
  settings = next;
  canvas.dataset.volume = String(settings.volume);
  // The master volume applies at once, from the menu and from Pause.
  gameAudio.setVolume(settings.volume);
  return saveSettings(store, settings) && canSave;
};
canvas.dataset.volume = String(settings.volume);
// Sound starts on the first click, tap or key (browser rule), never before.
gameAudio.install(canvas, settings.volume);
// Key bindings (Settings > Keys): bad stored values give the defaults.
let keys: KeyBindings = loadKeys(store);
const setKeys = (next: KeyBindings): boolean => {
  keys = next;
  return saveKeys(store, keys) && canSave;
};
// The title for a bare address, the menu for ?menu=1; any mode, demo or debug address skips them.
const front = startScreen(location.search);
const seed = seedFromString('brushsteel');
const stage = createStage(canvas, seed);
// Background: the title and menus get the calm title landscape; a duel sets its master's stage.
const stageParam = STAGE_LOOK_IDS.includes(params.get('stage') ?? '') ? (params.get('stage') as string) : undefined;
stage.landscape.setStage(stageParam ?? 'title');
canvas.dataset.stage = stage.landscape.stageId;

// Ink post-process, mist and spray on every scene (?quality=low|medium|high, else the Settings
// choice, low or high). Default low
// (half-res targets): on CI SwiftShader at 1920x1080 medium measured 4.8 and 5.0 fps against
// 5.8 and 6.2 for low (runs 44510985344, 44512010266). Never changed mid-duel.
const ink = createInkComposer(stage.renderer, stage.scene, { quality: qualityFor(location.search, settings), seed });
canvas.dataset.inkQuality = ink.quality;

// ?debug=poses shows the figure pose cycle, with an ink spray burst on each strike pose.
// Otherwise the duel against master 1; ?master=2 to 8 picks another master from the
// masters list (core/masters.ts); ?demo=duel plays the scripted CI duel (master 1 only).
const debug: PoseDebug | null = front === null && params.get('debug') === 'poses'
  ? createPoseDebug(stage, canvas, (x, y, dir) => ink.emit(x, y, dir, 90))
  : null;
if (debug) for (const f of debug.figures) ink.addInk(f.mesh);
// Path mode: ?mode=path, or ?demo=path for the CI shot of the map (fixed scroll of
// 20 Nov 2026, saved in memory only; &screen=shrine|brush|end for the other screens).
const demoPath = params.get('demo') === 'path';
const pathOn = front === null && !debug && (params.get('mode') === 'path' || demoPath);
let path: PathMode | null = null;
const duel: DuelScene | null = debug || front !== null
  ? null
  : pathOn
    ? createDuelScene(stage, ink, canvas, { demo: false, seed, master: masterByIndex(1), onResult: (won) => path?.onResult(won), onContinue: () => path?.onContinue(), keys: () => keys })
    : createDuelScene(stage, ink, canvas, { demo: params.get('demo') === 'duel', seed, shots: params.get('shots') === '1', duels: Number(params.get('duels') ?? 1) || 1, master: masterByIndex(params.get('demo') === 'duel' ? 1 : Number(params.get('master') ?? 1)), keys: () => keys, stageId: stageParam });
if (duel && pathOn) {
  const screen = params.get('screen');
  const fixedNow = new Date(Date.UTC(2026, 10, 20, 9, 0));
  path = createPathMode(
    {
      canvas,
      // localStorage may be missing or throw (private mode): then no save, no console error.
      store: demoPath ? memoryStore() : guardStore(() => window.localStorage),
      now: demoPath ? () => fixedNow : () => new Date(),
      demo: demoPath ? (screen === 'shrine' || screen === 'brush' || screen === 'end' ? screen : 'map') : null,
      daily: params.get('daily') === '1',
    },
    // Every master the Path puts you in front of is met.
    () => ({
      frame: (dt: number) => duel.frame(dt),
      pad: (f) => duel.pad(f),
      begin: (m, mods) => {
        if (!demoPath) addMet(store, m.index);
        duel.begin(m, mods);
      },
    }),
  );
}
const demo = params.get('demo');
if (duel && !pathOn && !demo) addMet(store, Number(canvas.dataset.master || 1));
// Menu, Duel or Path, top centre (not on the CI duel demo, the pose debug or the front end).
if (front === null && !debug && demo !== 'duel') createModeSwitch(pathOn ? 'path' : 'duel');

// Controller. Nothing is polled until a pad is connected.
const listPads = (): Gamepad[] => {
  try {
    return [...(navigator.getGamepads?.() ?? [])].filter((g): g is Gamepad => !!g && g.connected !== false);
  } catch {
    return [];
  }
};
let padOn = listPads().length > 0;
let frontEnd: FrontEnd | null = null;
const padReader = createPadReader();
const padChanged = () => {
  const was = padOn;
  padOn = listPads().length > 0;
  if (padOn) canvas.dataset.pad = '1';
  else delete canvas.dataset.pad;
  if (was !== padOn) {
    padReader.reset();
    if (!padOn) duel?.pad(null);
    frontEnd?.refresh();
  }
};
if (padOn) canvas.dataset.pad = '1';
window.addEventListener('gamepadconnected', padChanged);
window.addEventListener('gamepaddisconnected', padChanged);

// Title and menus.
if (front !== null) {
  const now = new Date();
  // A fight left by a top link is booked here too (openSession), so the menu shows the lives really left.
  const run = openSession(store).run;
  frontEnd = createFrontEnd(
    front,
    {
      pathLine: run && run.status !== 'over' ? `Continue your run, ${run.lives} ${run.lives === 1 ? 'life' : 'lives'} in hand` : 'Start a run on the daily scroll',
      dailyLine: dailyMenuLine(run, now),
      met: loadMet(store),
      settings,
      keys,
      canSave,
      padConnected: () => padOn,
    },
    {
      go: (href) => location.assign(href),
      setSettings,
      setKeys,
      onScreen: (s) => {
        canvas.dataset.front = s;
        canvas.dataset.mode = `front-${s}`;
      },
    },
  );
}

// Pause: Esc during a duel. The duel does not advance while paused. Quit to menu
// in Path books a fight under way as one loss at once (the rule openSession applies on reload).
let pause: PauseState = 'playing';
if (duel && demo === null) {
  const view = createPause({
    onResume: () => setPause({ type: 'resume' }),
    onSettings: () => setPause({ type: 'settings' }),
    onBack: () => setPause({ type: 'esc' }),
    onQuit: () => {
      path?.leave();
      location.assign('?menu=1');
    },
    getSettings: () => settings,
    setSettings,
    getKeys: () => keys,
    setKeys,
    canSave,
    lifeAtStake: () => !!path?.lifeAtStake,
  });
  const setPause = (a: Parameters<typeof pauseReducer>[1]) => {
    pause = pauseReducer(pause, a);
    canvas.dataset.pause = pause;
    if (pause === 'playing') view.hide();
    else view.show(pause);
  };
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Path screens (map, shrine, brush, end) have their own buttons; only a fight pauses.
    // Esc still closes a Pause left open (R on a paused result card goes on to the map).
    if (path && !path.fighting && pause === 'playing') return;
    e.preventDefault();
    setPause({ type: 'esc' });
  });
  // Pause when the page really loses focus, read a moment after the blur, so a
  // blur while a cut is drawn (focus moving inside the page) never opens Pause.
  window.addEventListener('blur', () => {
    window.setTimeout(() => {
      if (pauseOnBlur({ playing: pause === 'playing', fighting: !path || path.fighting, hasFocus: document.hasFocus(), hidden: document.hidden })) setPause({ type: 'esc' });
    }, BLUR_PAUSE_CHECK_MS);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && pause === 'playing' && (!path || path.fighting)) setPause({ type: 'esc' });
  });
}

// Pad menu intents go through the same handlers as the keyboard: a key event on the window for
// moves, Back and Pause, a click on the focused button for A. Left and right move a focused slider.
const padKey = (key: string) => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { key, cancelable: true }));
};
const padMenu = (i: MenuIntent) => {
  // Path screens (map, shrine, brush, end) do not read window keys: up, down and A on a map node go to them.
  if (path && !path.fighting && path.pad(i)) return;
  const a = document.activeElement;
  if (i === 'up' || i === 'down') padKey(i === 'up' ? 'ArrowUp' : 'ArrowDown');
  else if (i === 'left' || i === 'right') {
    if (a instanceof HTMLInputElement && a.type === 'range') {
      if (i === 'left') a.stepDown();
      else a.stepUp();
      a.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } else if (i === 'back') padKey('Escape');
  else if (i === 'confirm' || (i === 'pause' && frontEnd?.screen === 'title')) {
    if (a instanceof HTMLButtonElement || a instanceof HTMLAnchorElement) a.click();
  } else if (i === 'pause' && duel) padKey('Escape');
};
// First connected pad, without building an array each frame.
const firstPad = (): Gamepad | null => {
  try {
    const all = navigator.getGamepads?.();
    if (!all) return null;
    for (let i = 0; i < all.length; i++) {
      const g = all[i];
      if (g && g.connected !== false) return g;
    }
  } catch {
    // Same as listPads: no pad.
  }
  return null;
};
let padWasLive = false;
const pollPad = (now: number) => {
  const g = firstPad();
  const f = padReader.read(g, now, padArea(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight));
  const live = !!duel && demo === null && pause === 'playing' && (!path || path.fighting);
  if (live !== padWasLive) {
    padWasLive = live;
    // A press that opened or closed a screen does not carry over into the next one.
    padReader.reset();
    if (!live) duel?.pad(null);
    return;
  }
  if (live) {
    duel?.pad(f);
    if (f.menu.includes('pause')) padKey('Escape');
  } else for (const i of f.menu) padMenu(i);
};

// Auto quality: with no quality chosen and no ?quality=, time the title or menu frames
// for 2 s (the first 250 ms ignored) and save high if the median frame is under 14 ms, else low.
// The ink composer was made at load, so the pick applies from the next page (the next duel),
// never mid-duel. The player's own choice in Settings always wins.
let probe: { t0: number; ms: number[] } | null = front !== null && needsQualityProbe(location.search, settings) ? { t0: -1, ms: [] } : null;
const probeFrame = (now: number, prev: number) => {
  if (!probe) return;
  if (document.hidden) {
    // A hidden tab gets no frames worth timing: try again on the next visit.
    probe = null;
    return;
  }
  if (probe.t0 < 0) {
    probe.t0 = now;
    return;
  }
  const since = now - probe.t0;
  if (since > AUTO_PROBE_SKIP_MS && prev >= 0) probe.ms.push(now - prev);
  if (since < AUTO_PROBE_MS) return;
  const pick = pickAutoQuality(probe.ms);
  probe = null;
  if (pick === null) return;
  canvas.dataset.autoQuality = pick;
  const next = withAutoQuality(settings, pick);
  if (next === settings) return;
  setSettings(next);
  frontEnd?.syncSettings(next);
};

let frames = 0;
let last = -1;
// Path screens hold a still picture: what was last drawn under them, and how many
// frames since it changed. Nothing moves there, so the canvas is drawn twice after a change
// (stage, size or ink quality) and then left alone instead of re-rendering every frame.
let pathDrawnKey = '';
let pathStill = 0;
stage.renderer.setAnimationLoop((now: number) => {
  if (padOn) pollPad(now);
  // Paint the landscape texture only if its stage or size changed since the last paint.
  // With a duel on, every branch below paints through duel.frame or the Path branch, so painting
  // here as well would paint the title and then the master's stage on the first frame.
  let painted = duel ? false : stage.landscape.flush();
  // Music plays only in a live fight: not on menus, Path screens, Pause or the CI demo duel.
  gameAudio.music(!!duel && demo === null && pause === 'playing' && (!path || path.fighting) && canvas.dataset.phase !== 'over');
  const raw = last < 0 ? 0 : (now - last) / 1000;
  if (probe) probeFrame(now, last);
  last = now;
  if (duel && path && !path.fighting) {
    // Path screens cover the stage: draw the paper and the calm map landscape only.
    if (stage.landscape.stageId !== 'path-map') stage.landscape.setStage('path-map');
    canvas.dataset.stage = 'path-map';
    painted = stage.landscape.flush() || painted;
    const key = `${canvas.width}x${canvas.height}|${ink.quality}`;
    if (painted || key !== pathDrawnKey) {
      pathDrawnKey = key;
      pathStill = 0;
    }
    if (pathStill < 2) {
      pathStill++;
      ink.update(0, stage.camera);
      ink.render(stage.scene, stage.camera);
    }
  } else if (duel && pause !== 'playing') {
    pathDrawnKey = '';
    // Paused: draw the frame, advance nothing.
    duel.frame(0);
  } else if (duel) {
    pathDrawnKey = '';
    // The duel catches up at most 250 ms a frame (15 ticks), so a slow frame keeps real time.
    duel.frame(Math.min(0.25, raw));
  } else {
    const dt = Math.min(0.1, raw);
    if (debug) debug.update(dt);
    // Clamp the effects' dt so a stalled tab does not fling the spray.
    ink.update(dt, stage.camera);
    ink.render(stage.scene, stage.camera);
  }
  frames++;
  if (frames === 1) {
    canvas.dataset.ready = '1';
    // Milliseconds from navigation start to the first drawn frame.
    canvas.dataset.firstFrame = String(Math.round(performance.now()));
  }
});
