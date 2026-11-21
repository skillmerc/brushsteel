// Path mode wiring: screens, the run session and the duel.
// Every run change goes through session.dispatch (runReducer); duels start
// with the run's mods and report back through it.

import { dailySeed, dateKey, duelSetup } from './core/path.js';
import { masterByIndex } from './core/masters.js';
import type { KeyValueStore } from './core/save.js';
import { nextScrollIn, openSession, scrollLabel, type PathSession } from './core/session.js';
import type { DuelScene } from './render/duelScene.js';
import { createPathScreens } from './ui/pathScreens.js';
import { quitFight } from './core/front.js';
import { hudHiddenOn } from './core/hudVis.js';

export interface PathMode {
  /** True while a duel of the run is on screen (the caller then steps the duel). */
  readonly fighting: boolean;
  /** Called by the duel scene with each duel's result, when its result card appears. */
  onResult(won: boolean): void;
  /** Called by the duel scene when the player leaves the result card (Continue or R). */
  onContinue(): void;
  /** True while leaving now would cost a life (a fight under way). */
  readonly lifeAtStake: boolean;
  /** Quit to menu from Pause: a fight under way is booked as one loss at once. */
  leave(): boolean;
  /** A controller intent on a Path screen; true when the screen took it. */
  pad(intent: string): boolean;
}

export interface PathModeOptions {
  canvas: HTMLCanvasElement;
  store: KeyValueStore;
  /** The clock for the daily scroll (fixed in the CI demo). */
  now: () => Date;
  /** CI demo (?demo=path): a scripted start on a fixed scroll, then the screen to photograph. */
  demo?: 'map' | 'shrine' | 'brush' | 'end' | null;
  /**
   * Daily scroll from the menu: if the saved run is over or from an earlier
   * scroll, open at today's brush pick (the old run stays saved until a brush is picked).
   */
  daily?: boolean;
}

export function createPathMode(opts: PathModeOptions, getDuel: () => DuelScene): PathMode {
  const { canvas } = opts;
  const screens = createPathScreens();
  const session: PathSession = openSession(opts.store);
  let fighting = false;
  let note = '';

  const scroll = () => (session.run ? scrollLabel(session.run.seed, opts.now()) : scrollLabel(dailySeed(dateKey(opts.now())), opts.now()));
  const mark = (screen: string) => {
    canvas.dataset.mode = `path-${screen}`;
    // No duel HUD or help line behind a Path screen (CSS in ui/hud.ts).
    document.body.classList.toggle('bs-pathscreen', hudHiddenOn(screen));
    if (opts.demo) canvas.dataset.photo = screen;
  };

  const fight = () => {
    const run = session.run;
    const map = session.map;
    if (!run || !map || run.status !== 'duel') return show();
    const setup = duelSetup(run, map);
    // Save the fight as under way first: leaving it now (reload, tab closed, the Duel link)
    // is booked as one loss when the run is next opened (openSession).
    session.dispatch({ type: 'duel-begin' });
    screens.hide();
    fighting = true;
    mark('duel');
    getDuel().begin(masterByIndex(setup.master), setup.mods);
  };

  // A new run starts at the brush pick; the old one stays saved until then.
  const todaysBrush = (): void => {
    fighting = false;
    screens.brush({
      scroll: scrollLabel(dailySeed(dateKey(opts.now())), opts.now()),
      nextIn: nextScrollIn(opts.now()),
      onPick: (brush) => {
        note = '';
        session.dispatch({ type: 'start', seed: dailySeed(dateKey(opts.now())), brush });
        show();
      },
    });
    mark('brush');
  };

  const show = (): void => {
    const run = session.run;
    const map = session.map;
    fighting = false;
    if (!run || !map) {
      screens.brush({
        scroll: scroll(),
        nextIn: nextScrollIn(opts.now()),
        onPick: (brush) => {
          note = '';
          session.dispatch({ type: 'start', seed: dailySeed(dateKey(opts.now())), brush });
          show();
        },
      });
      return mark('brush');
    }
    if (run.status === 'over') {
      screens.end({
        run,
        map,
        scroll: scroll(),
        onNew: todaysBrush,
      });
      return mark('end');
    }
    const end = () => {
      session.dispatch({ type: 'end' });
      show();
    };
    if (run.status === 'shrine') {
      screens.shrine({
        run,
        scroll: scroll(),
        onPick: (seal) => {
          session.dispatch({ type: 'pick', seal });
          note = seal ? 'The seal is yours for the rest of the run.' : '';
          show();
        },
        onEnd: end,
      });
      return mark('shrine');
    }
    screens.map({
      run,
      map,
      scroll: scroll(),
      nextIn: nextScrollIn(opts.now()),
      note,
      onMove: (id) => {
        const before = session.run;
        const after = session.dispatch({ type: 'move', to: id });
        if (after === before) return;
        const kind = map.nodes[id].kind;
        note = kind === 'well' ? 'Ink well: your lives are full again.' : '';
        if (after.status === 'duel') fight();
        else show();
      },
      onFight: fight,
      onEnd: end,
    });
    mark('map');
  };

  // CI demo: a fixed scroll and a short scripted route through the reducer (no storage).
  if (opts.demo && opts.demo !== 'brush') {
    session.dispatch({ type: 'start', seed: dailySeed(dateKey(opts.now())), brush: 'standard' });
    const map = session.map;
    if (map) {
      session.dispatch({ type: 'move', to: map.start[0] });
      session.dispatch({ type: 'duel-won' });
      const run = session.run;
      const nextIds = run && run.at ? map.nodes[run.at].next : [];
      const shrine = nextIds.find((id) => map.nodes[id].kind === 'shrine');
      session.dispatch({ type: 'move', to: shrine ?? nextIds[0] });
      if (opts.demo !== 'shrine' && session.run?.status === 'shrine') session.dispatch({ type: 'pick', seal: session.run.offer[0] });
      if (opts.demo !== 'shrine' && session.run?.status === 'duel') session.dispatch({ type: 'duel-won' });
      if (opts.demo === 'end') session.dispatch({ type: 'end' });
    }
  }
  const stale = session.run && (session.run.status === 'over' || session.run.seed !== dailySeed(dateKey(opts.now())));
  if (opts.daily && !opts.demo && stale) todaysBrush();
  else show();

  return {
    get lifeAtStake() {
      return fighting && !!session.run?.fighting;
    },
    leave() {
      fighting = false;
      return quitFight(session);
    },
    get fighting() {
      return fighting;
    },
    pad(intent) {
      return !fighting && screens.pad(intent);
    },
    onResult(won) {
      const run = session.run;
      if (!run || run.status !== 'duel') return;
      const node = session.map && run.at ? session.map.nodes[run.at] : null;
      const after = session.dispatch({ type: won ? 'duel-won' : 'duel-lost' });
      if (won) note = node?.kind === 'master' && after.status !== 'over' ? `Master ${node.master} is beaten: one life back.` : '';
      else note = after.status === 'duel' ? 'Lost. The same master waits, and another life is at stake.' : '';
      // The duel's result card stays up; Continue goes back to the map.
    },
    onContinue() {
      show();
    },
  };
}
