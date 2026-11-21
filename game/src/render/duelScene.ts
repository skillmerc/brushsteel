import * as THREE from 'three';
import { BONE } from '../core/figure.js';
import { MASTERS, masterLabel, type Master } from '../core/masters.js';
import {
  FOE,
  GROUND_WORLD_Y,
  PLAYER,
  beginStroke,
  createDemoPilot,
  createMatch,
  DEMO_STYLE,
  duelSeconds,
  extendStroke,
  finishStroke,
  formatClock,
  parrySwordTilt,
  poseFor,
  stepMatch,
  type Match,
  type View,
} from '../input/match.js';
import { DUEL_RULES, type FighterMods } from '../core/duel.js';
import { cuesForEvent, moveCue, strokeSpeed, tensionOf } from '../core/audiomix.js';
import { gameAudio } from '../audio/index.js';
import { createHud } from '../ui/hud.js';
import { DEFAULT_KEYS, actionForKey, controlsLine, keyLabel, type KeyBindings } from '../core/keys.js';
import { createFigureView, type FigureView } from './figure.js';
import type { PadFrame } from '../input/gamepad.js';
import type { InkComposer } from './inkpass.js';
import { createInkLine } from './inkLine.js';
import { createSpatter } from './spray.js';
import { FEEL, brushPressure, kickDecay, kickFor, slowmoGameMs } from '../core/feel.js';
import { createRng } from '../core/rng.js';
import type { Stage } from './index.js';

// The playable duel: figures driven by the duel, the player's
// live ink trail and the foe's telegraph line drawn sharp over the ink
// composite, hit-stop with spray and a camera kick,
// HUD and restart. ?demo=duel plays a scripted duel for the CI clip.

/** Spray drops per hit and per parry (keep a burst near 200 or less). */
export const HIT_DROPS = 160;
export const PARRY_DROPS = 50;
// Camera kick, hit-stop, slow-motion final stroke and the spatter cap: core/feel.ts.
/** Points kept for the trail mesh; longer strokes draw every n-th point. */
const TRAIL_MAX = 160;
/** Trail fades out this long after release (s). */
const TRAIL_FADE_S = 0.6;
const TRAIL_WIDTH_PX = 9;

export interface DuelScene {
  /** Advance and draw one frame (dt in seconds, already clamped by the caller to 0.25). */
  frame(dt: number): void;
  /** Path mode: a fresh duel against this master with these mods (player is fighter 0). */
  begin(master: Master, mods: [FighterMods | null, FighterMods | null] | undefined): void;
  /**
   * Controller input for this frame, only called while a pad is connected and
   * the duel is live. null lets go of everything the pad holds and ends its stroke (pause, pad gone).
   */
  pad(f: PadFrame | null): void;
}

export interface DuelSceneOptions {
  demo: boolean;
  seed: number;
  shots?: boolean;
  /** CI heap check: the demo restarts itself 1 s after each result until this many are played. */
  duels?: number;
  master?: Master;
  /**
   * Path mode: called once with the result the moment the result card appears,
   * so the run is saved as won or lost then. Without it the duel restarts as before.
   */
  onResult?: (won: boolean) => void;
  /** Path mode: Continue (button or R) on the result card; only goes back to the map. */
  onContinue?: () => void;
  /** Key bindings (Settings > Keys), read on every key so a change in Pause applies at once. */
  keys?: () => KeyBindings;
  /** ?stage=<id>: this background for every duel instead of the master's stage. */
  stageId?: string;
}

export function createDuelScene(stage: Stage, ink: InkComposer, canvas: HTMLCanvasElement, opts: DuelSceneOptions): DuelScene {
  // The foe comes from the masters list; master 1, the patient, by default.
  let master = opts.master ?? MASTERS[0];
  // Path mode seals and brush; undefined is the plain duel.
  let mods: [FighterMods | null, FighterMods | null] | undefined;
  const { renderer, scene, camera } = stage;
  const view: View = { width: 1, height: 1, left: -8, right: 8, top: 4.5, bottom: -4.5 };
  const readView = () => {
    view.width = canvas.clientWidth || window.innerWidth;
    view.height = canvas.clientHeight || window.innerHeight;
    view.left = camera.left;
    view.right = camera.right;
    view.top = camera.top;
    view.bottom = camera.bottom;
  };
  readView();

  let restarts = 0;
  let match: Match = makeMatch();
  function makeMatch(): Match {
    const m = createMatch(opts.seed + restarts * 7919, opts.demo ? DEMO_STYLE : master.style, mods);
    if (opts.demo) m.pilot = createDemoPilot(() => view, opts.seed + restarts, !!opts.shots);
    return m;
  }

  // Ink spatter that stays on the paper for the duel, cleared on restart.
  const spatter = createSpatter();
  scene.add(spatter.mesh);
  ink.addInk(spatter.mesh);
  const spatterRng = createRng((opts.seed ^ 0x5eed) >>> 0);
  // The OS reduced-motion setting turns the camera kick off (the front screen already honours it).
  const motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

  // Figures on the ink layer, once each.
  const figures: [FigureView, FigureView] = [
    createFigureView({ x: match.duel.state.fighters[0].x, facing: 1, seed: 11, ground: GROUND_WORLD_Y }),
    createFigureView({ x: match.duel.state.fighters[1].x, facing: -1, seed: 29, ground: GROUND_WORLD_Y }),
  ];
  for (const f of figures) {
    scene.add(f.mesh);
    ink.addInk(f.mesh);
  }

  // Overlay drawn at full resolution after the composite: sharp, never on the half-res layer.
  const overlay = new THREE.Scene();
  const overlayCam = new THREE.OrthographicCamera(-8, 8, 4.5, -4.5, 0.1, 100);
  overlayCam.position.set(0, 0, 20);

  // Foe telegraph: the faint brush line (same look as the ground stroke), along the strike segment.
  const tele = createInkLine();
  const teleMat = tele.material as THREE.ShaderMaterial;
  tele.visible = false;
  tele.renderOrder = 1;
  overlay.add(tele);
  let teleStart = -1;

  // Player trail: a ribbon of TRAIL_MAX points, buffers allocated once.
  const trailPos = new Float32Array(TRAIL_MAX * 2 * 3);
  const trailIdx = new Uint16Array((TRAIL_MAX - 1) * 6);
  for (let i = 0; i < TRAIL_MAX - 1; i++) {
    const a = i * 2;
    trailIdx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6);
  }
  const trailGeo = new THREE.BufferGeometry();
  const trailAttr = new THREE.BufferAttribute(trailPos, 3);
  trailAttr.setUsage(THREE.DynamicDrawUsage);
  trailGeo.setAttribute('position', trailAttr);
  trailGeo.setIndex(new THREE.BufferAttribute(trailIdx, 1));
  trailGeo.setDrawRange(0, 0);
  const trailMat = new THREE.MeshBasicMaterial({ color: '#1b1611', transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
  const trail = new THREE.Mesh(trailGeo, trailMat);
  trail.frustumCulled = false;
  trail.renderOrder = 2;
  overlay.add(trail);
  let trailFade = 0;
  let trailDirty = false;

  const writeTrail = () => {
    const pts = match.live;
    const n = pts.length;
    if (n < 2) {
      trailGeo.setDrawRange(0, 0);
      return;
    }
    const count = Math.min(n, TRAIL_MAX);
    const sx = (view.right - view.left) / view.width;
    const sy = (view.top - view.bottom) / view.height;
    const half = (TRAIL_WIDTH_PX / 2) * sx;
    for (let k = 0; k < count; k++) {
      // Spread the kept points over the whole stroke; the newest point is always last.
      const i = count === n ? k : Math.round((k * (n - 1)) / (count - 1));
      const p = pts[i];
      const prev = pts[Math.max(0, i - 1)];
      const next = pts[Math.min(n - 1, i + 1)];
      const x = view.left + p.x * sx;
      const y = view.top - p.y * sy;
      let dx = (next.x - prev.x) * sx;
      let dy = -(next.y - prev.y) * sy;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      // Brush: pressed start, full body, head still wide under the cursor; a fast
      // part of the stroke lifts the brush and thins the line (pressure from speed).
      const u = k / (count - 1);
      const dtp = next.t - prev.t;
      const pressure = dtp > 0 ? brushPressure(Math.hypot(next.x - prev.x, next.y - prev.y) / dtp) : 1;
      const w = half * (0.45 + 0.55 * Math.min(1, u * 3)) * (0.85 + 0.15 * Math.sin(u * 17)) * pressure;
      const o = k * 6;
      trailPos[o] = x - dy * w;
      trailPos[o + 1] = y + dx * w;
      trailPos[o + 2] = 0;
      trailPos[o + 3] = x + dy * w;
      trailPos[o + 4] = y - dx * w;
      trailPos[o + 5] = 0;
    }
    trailAttr.needsUpdate = true;
    trailAttr.clearUpdateRanges();
    trailAttr.addUpdateRange(0, count * 6);
    trailGeo.setDrawRange(0, (count - 1) * 6);
  };

  // HUD and restart.
  const bindings = () => opts.keys?.() ?? DEFAULT_KEYS;
  const hud = createHud(() => (opts.onResult ? report() : restart()), opts.onResult ? 'Continue' : 'Restart', () => controlsLine(bindings()), () => keyLabel(bindings().restart));
  let resultShown = false;
  // Path mode: the result was reported when the card appeared; Continue leaves the card once.
  let reported = false;
  const report = () => {
    if (!opts.onResult || !resultShown || reported) return;
    reported = true;
    hud.hideResult();
    opts.onContinue?.();
  };
  const restart = () => {
    restarts++;
    match = makeMatch();
    spatter.ring.clear();
    slowT = 0;
    const st = match.duel.state;
    for (let i = 0; i < 2; i++) {
      const fs = figures[i].state;
      fs.x = st.fighters[i].x;
      fs.facing = st.fighters[i].facing;
    }
    for (const f of figures) {
      f.setPose('idle');
      f.update(0.5);
    }
    hud.hideResult();
    prevMove[0] = 0;
    prevMove[1] = 0;
    resultShown = false;
    reported = false;
    trailGeo.setDrawRange(0, 0);
    tele.visible = false;
    teleStart = -1;
    kickX = kickY = 0;
    canvas.dataset.restarts = String(restarts);
  };

  // Input: mouse drag strokes, A/D step, Shift dash, S hold to dip, R restart.
  if (!opts.demo) {
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || match.duel.state.phase === 'over') return;
      canvas.setPointerCapture(e.pointerId);
      beginStroke(match, { x: e.offsetX, y: e.offsetY, t: e.timeStamp });
      trailMat.opacity = 0.9;
      trailFade = 0;
      trailDirty = true;
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!match.drawing) return;
      const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      if (list.length) for (const c of list) extendStroke(match, { x: c.offsetX, y: c.offsetY, t: c.timeStamp });
      else extendStroke(match, { x: e.offsetX, y: e.offsetY, t: e.timeStamp });
      trailDirty = true;
    });
    const release = (e: PointerEvent) => {
      if (!match.drawing) return;
      extendStroke(match, { x: e.offsetX, y: e.offsetY, t: e.timeStamp });
      readView();
      finishStroke(match, view);
      trailFade = TRAIL_FADE_S;
      trailDirty = true;
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    const key = (down: boolean) => (e: KeyboardEvent) => {
      const bound = bindings();
      const act = actionForKey(bound, e);
      const keys = match.keys;
      if (act === 'left') keys.left = down;
      else if (act === 'right') keys.right = down;
      else if (act === 'dip') keys.dip = down;
      else if (act === 'dash') keys.dash = down;
      else if (act === 'restart') {
        if (down && match.duel.state.phase === 'over') {
          if (opts.onResult) report();
          else restart();
        }
      }
      else return;
      // Shift as dash is read from the event too, so a Shift let go during another key is not missed.
      if (bound.dash === 'Shift') keys.dash = e.shiftKey;
      e.preventDefault();
    };
    window.addEventListener('keydown', key(true));
    window.addEventListener('keyup', key(false));
    window.addEventListener('blur', () => {
      const keys = match.keys;
      keys.left = keys.right = keys.dash = keys.dip = false;
    });
  }

  // Controller. Held moves are written only when the pad's own state changes,
  // so the keyboard keeps working beside it. Strokes go through the same begin/extend/finish as the mouse.
  const padHeld = { left: false, right: false, dash: false, dip: false };
  let padDrawing = false;
  const padInput = (f: PadFrame | null) => {
    if (opts.demo) return;
    const keys = match.keys;
    for (const k of ['left', 'right', 'dash', 'dip'] as const) {
      const now = f ? f.moves[k] : false;
      if (now !== padHeld[k]) {
        padHeld[k] = now;
        keys[k] = now;
      }
    }
    const over = match.duel.state.phase === 'over';
    const release = () => {
      if (!padDrawing) return;
      padDrawing = false;
      if (!match.drawing) return;
      readView();
      finishStroke(match, view);
      trailFade = TRAIL_FADE_S;
      trailDirty = true;
    };
    if (!f) {
      release();
      return;
    }
    if (f.moves.restart && over) {
      if (opts.onResult) report();
      else restart();
      return;
    }
    for (const e of f.strokes) {
      if (e.type === 'begin') {
        if (over || match.drawing) continue;
        padDrawing = true;
        beginStroke(match, e.p);
        trailMat.opacity = 0.9;
        trailFade = 0;
        trailDirty = true;
      } else if (e.type === 'extend') {
        if (padDrawing) {
          extendStroke(match, e.p);
          trailDirty = true;
        }
      } else release();
    }
    // A thrust is a dot: press and release at one point, the centre of the stick's circle.
    if (f.moves.thrust && !over && !match.drawing) {
      readView();
      const p = { x: view.width / 2, y: view.height / 2, t: performance.now() };
      beginStroke(match, p);
      finishStroke(match, view);
    }
  };

  let kickX = 0;
  /** Real seconds since the final hit-stop ended (slow motion clock). */
  let slowT = 0;
  let kickY = 0;
  let lastLive = 0;
  const hudState = { ink: [100, 100] as [number, number], score: [0, 0] as [number, number], hitsToWin: 3, master: masterLabel(master) };
  canvas.dataset.master = String(master.index);
  let overFor = 0;
  // Results shown so far (data-duels-played), for the CI heap check over several demo duels.
  let duelsPlayed = 0;
  const duelsWanted = opts.demo ? Math.max(1, Math.min(10, Math.floor(opts.duels ?? 1))) : 1;
  // Sound: footsteps start when a fighter's move begins; a dash covers more ground than a step.
  const prevMove: [number, number] = [0, 0];
  const DASH_FROM = (DUEL_RULES.STEP_DIST + DUEL_RULES.DASH_DIST) / 2;
  const speeds: [number, number] = [0.6, 0.6];
  // Reused every frame: no array or object literals in frame().
  const inkPair: [number, number] = [100, 100];
  const cueCtx = { speed: speeds, hitsToWin: 3 };
  // Last values written to the canvas data attributes; a string is built only when one changes.
  let shownScore0 = -1;
  let shownScore1 = -1;
  let shownStrokes = -1;
  let shownGap = NaN;
  let shownMid = NaN;
  let shownSpatter = -1;
  canvas.dataset.mode = opts.demo ? 'demo-duel' : 'duel';
  // CI photo holds (?demo=duel&shots=1): the smoke reads data-photo, takes its shot, then resumes.
  let holdFor = 0;
  if (opts.demo && opts.shots) {
    (window as unknown as { __brushsteelResume: () => void }).__brushsteelResume = () => {
      match.hold = null;
      holdFor = 0;
      canvas.dataset.photo = '';
    };
  }

  return {
    pad: padInput,
    begin(next, nextMods) {
      master = next;
      mods = nextMods;
      hudState.master = masterLabel(master);
      canvas.dataset.master = String(master.index);
      restart();
    },
    frame(dt) {
      readView();
      // The master's stage background, repainted only when it changes.
      const wantStage = opts.stageId ?? master.stageId;
      if (stage.landscape.stageId !== wantStage) stage.landscape.setStage(wantStage);
      stage.landscape.flush();
      canvas.dataset.stage = stage.landscape.stageId;
      const m = match;
      const st = m.duel.state;
      const events = stepMatch(m, m.hold ? 0 : dt);
      if (m.hold) {
        canvas.dataset.photo = m.hold;
        holdFor += dt;
        // Never hang a run: a hold lets go by itself after 40 s.
        if (holdFor > 40) {
          m.hold = null;
          holdFor = 0;
        }
      }
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e.type === 'strike') {
          const s = st.fighters[e.who].strike;
          speeds[e.who] = s ? strokeSpeed(s.length, s.windupMs) : 0.6;
        }
        cueCtx.hitsToWin = m.duel.rules.HITS_TO_WIN;
        for (const c of cuesForEvent(e, cueCtx)) gameAudio.play(c);
        if (e.type === 'hit') {
          const hitter = st.fighters[e.who];
          const victim = st.fighters[e.who === 0 ? 1 : 0];
          const seg = m.strikeLine[e.who];
          // Spray along the cut and a little down.
          let dx = hitter.facing as number;
          let dy = -0.2;
          if (seg) {
            dx = seg.b.x - seg.a.x;
            dy = seg.b.y - seg.a.y;
            const l = Math.hypot(dx, dy) || 1;
            dx /= l;
            dy = dy / l - 0.35;
          }
          ink.emit(victim.x, GROUND_WORLD_Y + 1.5, Math.atan2(dy, dx), HIT_DROPS);
          spatter.ring.splash(victim.x, GROUND_WORLD_Y + 1.5, Math.atan2(dy, dx), spatterRng);
          const kick = kickFor(hitter.facing, !!motionQuery?.matches);
          kickX = kick.x;
          kickY = kick.y;
          canvas.dataset.hits = String(st.score[0] + st.score[1]);
        } else if (e.type === 'parry') {
          const line = m.parryLine[e.who];
          if (line) ink.emit((line.a.x + line.b.x) / 2, (line.a.y + line.b.y) / 2 + GROUND_WORLD_Y, Math.PI / 2, PARRY_DROPS);
          canvas.dataset.parries = String(m.stats.parries[0] + m.stats.parries[1]);
          if (e.who === PLAYER) canvas.dataset.playerParries = String(m.stats.parries[PLAYER]);
        } else if (e.type === 'clash') {
          if (!motionQuery?.matches) kickY = FEEL.KICK * 0.4;
        }
      }

      for (let i = 0; i < 2; i++) {
        const f = st.fighters[i];
        const step = moveCue(prevMove[i], f.moveTicks, f.moveDx, DASH_FROM, i as 0 | 1);
        if (step) gameAudio.play(step);
        prevMove[i] = f.moveTicks;
      }
      inkPair[0] = st.fighters[0].ink;
      inkPair[1] = st.fighters[1].ink;
      gameAudio.setTension(tensionOf(st.score, m.duel.rules.HITS_TO_WIN, inkPair, st.phase === 'over'));

      // Figures follow the duel; during hit-stop they hold still.
      const freeze = st.hitstop > 0;
      // Final stroke slow motion: after the killing blow's hit-stop the
      // figures and ink run at 0.3x for 600 ms of real time, then at normal speed.
      let gdt = dt;
      if (st.phase === 'over' && !freeze && !m.hold) {
        gdt = slowmoGameMs(slowT * 1000, dt * 1000) / 1000;
        slowT += dt;
      }
      canvas.dataset.slowmo = st.phase === 'over' && !freeze && slowT * 1000 <= FEEL.SLOWMO_MS ? '1' : '0';
      const fdt = Math.min(gdt, 0.1);
      for (let i = 0; i < 2; i++) {
        const f = st.fighters[i];
        const fv = figures[i];
        fv.state.x = f.x;
        fv.state.facing = f.facing;
        const pose = poseFor(m, i as 0 | 1);
        fv.setPose(pose);
        if (pose === 'parry' && f.riposte > 0) {
          // Blend the sword toward the parried line; setPose has just reset
          // the target when the pose changed, so add the tilt once per pose entry.
          if (fv.state.poseTime === 0) fv.state.target[BONE.sword] += parrySwordTilt(m.parryLine[i]);
        }
        if (!freeze && !m.hold) fv.update(fdt);
      }

      // Camera kick, decaying; the overlay camera never kicks so the trail stays under the cursor.
      const decay = kickDecay(dt);
      kickX *= decay;
      kickY *= decay;
      camera.position.x = kickX;
      camera.position.y = kickY;
      if (overlayCam.left !== camera.left || overlayCam.top !== camera.top) {
        overlayCam.left = camera.left;
        overlayCam.right = camera.right;
        overlayCam.top = camera.top;
        overlayCam.bottom = camera.bottom;
        overlayCam.updateProjectionMatrix();
      }

      // Foe telegraph line: faint, for the whole windup.
      const foe = st.fighters[FOE];
      if (foe.strike && st.phase === 'fight') {
        const s = foe.strike.segment;
        if (teleStart !== foe.strike.startTick) {
          teleStart = foe.strike.startTick;
          const ax = s.a.x;
          const ay = s.a.y + GROUND_WORLD_Y;
          const bx = s.b.x;
          const by = s.b.y + GROUND_WORLD_Y;
          tele.position.set((ax + bx) / 2, (ay + by) / 2, 0);
          tele.rotation.z = Math.atan2(by - ay, bx - ax);
          tele.scale.set(Math.hypot(bx - ax, by - ay) / 9, 0.9, 1);
          canvas.dataset.telegraphs = String(Number(canvas.dataset.telegraphs || 0) + 1);
        }
        tele.visible = true;
        teleMat.uniforms.uOpacity.value = Math.min(0.42, 0.42 * ((st.tick - foe.strike.startTick) / 6 + 0.2));
      } else {
        tele.visible = false;
      }

      // Player trail.
      if (m.live.length !== lastLive) {
        lastLive = m.live.length;
        trailDirty = true;
        if (opts.demo && m.drawing) {
          trailMat.opacity = 0.9;
          trailFade = 0;
        }
      }
      let fadeStarted = false;
      if (opts.demo && !m.drawing && trailFade === 0 && m.live.length > 1 && trailMat.opacity > 0.89) {
        trailFade = TRAIL_FADE_S;
        fadeStarted = true;
      }
      if (trailDirty) {
        writeTrail();
        trailDirty = false;
      }
      if (trailFade > 0 && !fadeStarted) {
        // Full ink for the first 40 percent of the fade, then out.
        trailFade = Math.max(0, trailFade - (m.hold ? 0 : dt));
        trailMat.opacity = 0.9 * Math.min(1, trailFade / TRAIL_FADE_S / 0.6);
        if (trailFade === 0) {
          trailMat.opacity = 0;
          trailGeo.setDrawRange(0, 0);
        }
      }

      // HUD.
      hudState.ink[0] = st.fighters[0].ink;
      hudState.ink[1] = st.fighters[1].ink;
      hudState.score[0] = st.score[0];
      hudState.score[1] = st.score[1];
      hudState.hitsToWin = m.duel.rules.HITS_TO_WIN;
      hud.update(hudState);
      overFor = st.phase === 'over' ? overFor + (m.hold ? 0 : gdt) : 0;
      // The result screen waits for the fall and the last spray (1.2 s).
      if (st.phase === 'over' && !resultShown && overFor >= 1.2) {
        resultShown = true;
        // Path mode: book the result now, before any Continue (a reload on the card keeps it).
        if (opts.onResult) opts.onResult(st.winner === PLAYER);
        hud.showResult(st.winner === PLAYER, formatClock(duelSeconds(m)), st.score);
        gameAudio.cue(st.winner === PLAYER ? 'win' : 'lose');
        canvas.dataset.winner = st.winner === PLAYER ? 'player' : 'foe';
        canvas.dataset.duelSeconds = duelSeconds(m).toFixed(1);
        duelsPlayed++;
        canvas.dataset.duelsPlayed = String(duelsPlayed);
      }
      // Demo with &duels=N: the next duel starts 1 s after the result card, until N are played.
      if (resultShown && duelsPlayed < duelsWanted && overFor >= 2.2) {
        restart();
      }
      canvas.dataset.phase = st.phase;
      if (st.score[0] !== shownScore0 || st.score[1] !== shownScore1) {
        shownScore0 = st.score[0];
        shownScore1 = st.score[1];
        canvas.dataset.score = `${st.score[0]}-${st.score[1]}`;
      }
      if (m.stats.strokes !== shownStrokes) {
        shownStrokes = m.stats.strokes;
        canvas.dataset.strokes = String(m.stats.strokes);
      }
      const gap = Math.abs(st.fighters[1].x - st.fighters[0].x);
      if (gap !== shownGap) {
        shownGap = gap;
        canvas.dataset.gap = gap.toFixed(2);
      }
      const mid = (st.fighters[1].x + st.fighters[0].x) / 2;
      if (mid !== shownMid) {
        shownMid = mid;
        canvas.dataset.mid = mid.toFixed(2);
      }

      // Effects step with the real clamped dt, also during hit-stop.
      ink.update(m.hold ? 0 : fdt, camera);
      spatter.sync();
      if (spatter.ring.count !== shownSpatter) {
        shownSpatter = spatter.ring.count;
        canvas.dataset.spatter = String(spatter.ring.count);
      }
      ink.render(scene, camera);
      renderer.autoClear = false;
      renderer.render(overlay, overlayCam);
      renderer.autoClear = true;
    },
  };
}
