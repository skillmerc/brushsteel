// Sound. Every sound is made here from WebAudio nodes: no sample files, nothing from
// outside the game. The rules (which event, how loud, tension, layer mix, volume curve) live in
// core/audiomix.ts and are unit tested; this file only turns them into nodes.
//
// Browser rule: the AudioContext is made on the first click, tap or key, never before. Until then
// every call here is a no-op. Any failure turns sound off quietly (no console error) and is shown
// on the canvas as data-audio="error" for the CI smoke; data-audio is the context state otherwise.

import { layerGains, volumeGain, type Cue, type CueSpec } from '../core/audiomix.js';

type Ctx = AudioContext;

export interface GameAudio {
  /** Listen for the first user gesture on the window and start sound then. Call once. */
  install(canvas: HTMLElement, volume: number): void;
  /** Settings master volume, 0 to 100. Applies at once, also from Pause. */
  setVolume(volume: number): void;
  /** Play one effect (no-op before the first gesture). */
  play(c: CueSpec): void;
  /** Shortcut for a cue at full gain and base pitch. */
  cue(cue: Cue): void;
  /** Duel tension 0 to 1, read by the music layers. */
  setTension(t: number): void;
  /** Music on during a live fight, off (fading) on menus, Pause, Path screens and the result. Call every frame. */
  music(on: boolean): void;
}

function createGameAudio(): GameAudio {
  let ctx: Ctx | null = null;
  let master: GainNode | null = null;
  let sfx: GainNode | null = null;
  let noise: AudioBuffer | null = null;
  let mark: HTMLElement | null = null;
  let volume = 80;
  let tension = 0;
  let failed = false;
  // Music layers, made the first time music is wanted.
  let layers: { drums: GainNode; flute: GainNode; wind: GainNode } | null = null;
  let musicOn = false;
  let nextEighth = 0;
  let eighth = 0;
  let lastMix = -1;

  const fail = () => {
    failed = true;
    try {
      if (master && ctx) master.gain.setValueAtTime(0, ctx.currentTime);
    } catch {
      // Already off.
    }
    if (mark) mark.dataset.audio = 'error';
  };
  const guard = (fn: () => void) => {
    if (!ctx || failed) return;
    try {
      fn();
    } catch {
      fail();
    }
  };

  function start(): void {
    if (ctx || failed) return;
    const AC = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) {
      if (mark) mark.dataset.audio = 'none';
      return;
    }
    try {
      ctx = new AC();
      const c = ctx;
      master = c.createGain();
      master.gain.value = volumeGain(volume);
      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      master.connect(comp).connect(c.destination);
      sfx = c.createGain();
      sfx.gain.value = 0.9;
      sfx.connect(master);
      // Two seconds of white noise from a fixed seed, shared by every noisy sound.
      noise = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
      const d = noise.getChannelData(0);
      let s = 0x2545f491;
      for (let i = 0; i < d.length; i++) {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        d[i] = ((s >>> 0) / 4294967296) * 2 - 1;
      }
      const show = () => {
        if (mark && !failed) mark.dataset.audio = c.state;
      };
      c.onstatechange = show;
      show();
      if (c.state === 'suspended') c.resume().then(show, () => undefined);
      // A hidden tab draws no frames, so music(false) never comes and the wind loop would go on.
      document.addEventListener('visibilitychange', () => {
        if (failed) return;
        (document.hidden ? c.suspend() : c.resume()).then(show, () => undefined);
      });
    } catch {
      fail();
    }
  }

  // ---------- building blocks ----------

  /** A noise burst through a filter with an attack and an exponential fall. */
  function noiseHit(c: Ctx, out: AudioNode, at: number, o: { type: BiquadFilterType; f0: number; f1?: number; q?: number; gain: number; attack?: number; len: number; offset?: number }): void {
    const src = c.createBufferSource();
    src.buffer = noise;
    const f = c.createBiquadFilter();
    f.type = o.type;
    f.Q.value = o.q ?? 1;
    f.frequency.setValueAtTime(o.f0, at);
    if (o.f1 !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), at + o.len);
    const g = c.createGain();
    const a = o.attack ?? 0.004;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.gain), at + a);
    g.gain.exponentialRampToValueAtTime(0.0001, at + a + o.len);
    src.connect(f).connect(g).connect(out);
    src.start(at, o.offset ?? Math.random() * 1.5);
    src.stop(at + a + o.len + 0.05);
  }

  /** A pitched tone with a pitch glide and an exponential fall. */
  function tone(c: Ctx, out: AudioNode, at: number, o: { type: OscillatorType; f0: number; f1?: number; gain: number; attack?: number; len: number; glide?: number }): void {
    const osc = c.createOscillator();
    osc.type = o.type;
    osc.frequency.setValueAtTime(o.f0, at);
    if (o.f1 !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), at + (o.glide ?? o.len));
    const g = c.createGain();
    const a = o.attack ?? 0.003;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.gain), at + a);
    g.gain.exponentialRampToValueAtTime(0.0001, at + a + o.len);
    osc.connect(g).connect(out);
    osc.start(at);
    osc.stop(at + a + o.len + 0.05);
  }

  /** A breathy low flute note: sine plus a little triangle, slow attack, vibrato, breath noise. */
  function fluteNote(c: Ctx, out: AudioNode, at: number, freq: number, len: number, gain: number): void {
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.18);
    g.gain.setValueAtTime(gain, at + len * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, at + len);
    lp.connect(g).connect(out);
    const vib = c.createOscillator();
    vib.frequency.value = 5.2;
    const vibAmt = c.createGain();
    vibAmt.gain.setValueAtTime(0, at);
    vibAmt.gain.linearRampToValueAtTime(freq * 0.012, at + len * 0.5);
    vib.connect(vibAmt);
    for (const [type, mul, lvl] of [['sine', 1, 1], ['triangle', 2, 0.18]] as [OscillatorType, number, number][]) {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(freq * mul * 0.985, at);
      o.frequency.exponentialRampToValueAtTime(freq * mul, at + 0.08);
      vibAmt.connect(o.frequency);
      const og = c.createGain();
      og.gain.value = lvl;
      o.connect(og).connect(lp);
      o.start(at);
      o.stop(at + len + 0.05);
    }
    vib.start(at);
    vib.stop(at + len + 0.05);
    noiseHit(c, g, at, { type: 'bandpass', f0: freq * 2, q: 3, gain: 0.08, attack: 0.1, len: len * 0.8 });
  }

  /** A low drum: a falling sine body plus a short muffled noise skin. */
  function drum(c: Ctx, out: AudioNode, at: number, gain: number, pitch = 1): void {
    tone(c, out, at, { type: 'sine', f0: 95 * pitch, f1: 42 * pitch, gain, len: 0.45, glide: 0.25 });
    noiseHit(c, out, at, { type: 'lowpass', f0: 700, f1: 200, gain: gain * 0.35, len: 0.09 });
  }

  /** Footstep on a wooden floor: a hollow knock and a little scuff. */
  function knock(c: Ctx, out: AudioNode, at: number, gain: number, rate: number): void {
    tone(c, out, at, { type: 'sine', f0: 210 * rate, f1: 130 * rate, gain: gain * 0.9, len: 0.09 });
    noiseHit(c, out, at, { type: 'bandpass', f0: 1100 * rate, q: 5, gain: gain * 0.5, len: 0.04 });
  }

  const PENTA = [220, 261.63, 293.66, 329.63, 392, 440, 523.25, 587.33];

  // ---------- effects ----------

  function playNow(spec: CueSpec): void {
    const c = ctx as Ctx;
    const out = sfx as GainNode;
    const t = c.currentTime + 0.005;
    const g = Math.max(0, Math.min(1, spec.gain));
    const r = spec.rate > 0 ? spec.rate : 1;
    switch (spec.cue) {
      case 'swish':
        noiseHit(c, out, t, { type: 'bandpass', f0: 500 * r, f1: 3200 * r, q: 1.4, gain: g * 0.9, attack: 0.04, len: 0.16 + 0.08 / r });
        noiseHit(c, out, t + 0.02, { type: 'highpass', f0: 4000 * r, gain: g * 0.15, attack: 0.03, len: 0.08 });
        break;
      case 'clash':
      case 'parry': {
        const bright = spec.cue === 'parry' ? 1.3 : 1;
        const len = spec.cue === 'parry' ? 0.45 : 0.7;
        for (const [f, lvl] of [[1180, 0.35], [1760, 0.25], [2630, 0.2], [3920, 0.12]]) {
          tone(c, out, t, { type: 'triangle', f0: f * r * bright, gain: g * lvl, len: len * (1.2 - lvl) });
        }
        noiseHit(c, out, t, { type: 'highpass', f0: 2800, gain: g * 0.6, len: 0.06 });
        break;
      }
      case 'guard':
        tone(c, out, t, { type: 'triangle', f0: 240 * r, f1: 180 * r, gain: g * 0.6, len: 0.14 });
        noiseHit(c, out, t, { type: 'lowpass', f0: 1200, gain: g * 0.5, len: 0.08 });
        break;
      case 'splatter': {
        // Wet burst, a low body thump, then droplets landing.
        noiseHit(c, out, t, { type: 'lowpass', f0: 2600 * r, f1: 350, q: 2, gain: g, len: 0.32 });
        tone(c, out, t, { type: 'sine', f0: 110 * r, f1: 38, gain: g * 0.9, len: 0.35, glide: 0.2 });
        for (let i = 0; i < 7; i++) {
          const at = t + 0.05 + Math.random() * 0.28;
          noiseHit(c, out, at, { type: 'bandpass', f0: 900 + Math.random() * 1800, q: 6, gain: g * (0.15 + Math.random() * 0.2), len: 0.03 });
        }
        break;
      }
      case 'step':
        knock(c, out, t, g, r);
        break;
      case 'dash':
        knock(c, out, t, g, r);
        knock(c, out, t + 0.09, g * 0.8, r * 1.05);
        noiseHit(c, out, t, { type: 'bandpass', f0: 400, f1: 1500, q: 0.8, gain: g * 0.35, attack: 0.05, len: 0.18 });
        break;
      case 'dip':
        tone(c, out, t, { type: 'sine', f0: 280 * r, f1: 760 * r, gain: g * 0.6, attack: 0.01, len: 0.14 });
        tone(c, out, t + 0.16, { type: 'sine', f0: 360 * r, f1: 900 * r, gain: g * 0.35, attack: 0.01, len: 0.1 });
        noiseHit(c, out, t, { type: 'lowpass', f0: 900, gain: g * 0.25, attack: 0.05, len: 0.2 });
        break;
      case 'dry':
        noiseHit(c, out, t, { type: 'highpass', f0: 2600, gain: g * 0.5, len: 0.05 });
        noiseHit(c, out, t + 0.06, { type: 'highpass', f0: 3200, gain: g * 0.35, len: 0.05 });
        break;
      case 'seal':
        tone(c, out, t, { type: 'sine', f0: 140, f1: 48, gain: g, len: 0.3, glide: 0.15 });
        noiseHit(c, out, t, { type: 'lowpass', f0: 800, f1: 250, gain: g * 0.6, len: 0.1 });
        knock(c, out, t + 0.02, g * 0.5, 0.8);
        break;
      case 'win':
        [3, 4, 5, 7].forEach((n, i) => fluteNote(c, out, t + i * 0.16, PENTA[n] * r, i === 3 ? 1.2 : 0.3, g * 0.45));
        drum(c, out, t + 0.48, g * 0.8);
        break;
      case 'lose':
        [4, 3, 1, 0].forEach((n, i) => fluteNote(c, out, t + i * 0.32, PENTA[n] * 0.5 * r, i === 3 ? 1.6 : 0.45, g * 0.45));
        drum(c, out, t + 0.96, g * 0.7, 0.8);
        break;
    }
  }

  // ---------- music ----------

  // Low flute phrase, one note per two beats (D minor pentatonic, low).
  const PHRASE = [146.83, 174.61, 196, 174.61, 220, 196, 146.83, 130.81];
  const EIGHTH_S = 60 / 88 / 2;
  // Drum pattern per eighth: 0 none, 1 soft, 2 strong. The hot pattern joins at high tension.
  const CALM = [2, 0, 0, 1, 0, 0, 1, 0];
  const HOT = [2, 0, 1, 1, 0, 1, 2, 1];

  function buildLayers(c: Ctx): void {
    const out = master as GainNode;
    const mk = () => {
      const g = c.createGain();
      g.gain.value = 0;
      g.connect(out);
      return g;
    };
    layers = { drums: mk(), flute: mk(), wind: mk() };
    // Wind: looped noise through a slowly drifting band.
    const src = c.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 600;
    bp.Q.value = 0.9;
    const lfo = c.createOscillator();
    lfo.frequency.value = 0.07;
    const depth = c.createGain();
    depth.gain.value = 320;
    lfo.connect(depth).connect(bp.frequency);
    const wg = c.createGain();
    wg.gain.value = 0.18;
    src.connect(bp).connect(wg).connect(layers.wind);
    src.start();
    lfo.start();
    nextEighth = c.currentTime + 0.1;
  }

  function scheduleMusic(c: Ctx): void {
    if (!layers) return;
    // Look 0.2 s ahead; after a long stall, skip to now instead of a burst of notes.
    if (nextEighth < c.currentTime - 0.5) nextEighth = c.currentTime + 0.05;
    while (nextEighth < c.currentTime + 0.2) {
      const step = eighth % 8;
      const hit = (tension > 0.8 ? HOT : CALM)[step];
      if (hit) drum(c, layers.drums, nextEighth, hit === 2 ? 0.9 : 0.5, hit === 2 ? 1 : 1.25);
      if (eighth % 4 === 0) {
        const n = PHRASE[(eighth / 4) % PHRASE.length];
        fluteNote(c, layers.flute, nextEighth, n, EIGHTH_S * 3.6, 0.5);
      }
      eighth++;
      nextEighth += EIGHTH_S;
    }
  }

  function mix(c: Ctx): void {
    if (!layers) return;
    const want = musicOn ? layerGains(tension) : { drums: 0, flute: 0, wind: 0 };
    const key = Math.round(want.drums * 50) * 10000 + Math.round(want.flute * 50) * 100 + Math.round(want.wind * 50);
    if (key === lastMix) return;
    lastMix = key;
    const t = c.currentTime;
    layers.drums.gain.setTargetAtTime(want.drums, t, 0.5);
    layers.flute.gain.setTargetAtTime(want.flute, t, 0.6);
    layers.wind.gain.setTargetAtTime(want.wind, t, 0.8);
  }

  return {
    install(canvas, v) {
      mark = canvas;
      volume = v;
      const go = (e: Event) => {
        // A pad press reaches here as a made-up key event (padKey in main.ts): not a browser gesture.
        if (!e.isTrusted) return;
        start();
        if (!ctx || failed || ctx.state === 'running') {
          window.removeEventListener('pointerdown', go, true);
          window.removeEventListener('keydown', go, true);
          window.removeEventListener('touchend', go, true);
          return;
        }
        // Still suspended (a touch press down, or Esc first): try again on the next real gesture.
        ctx.resume().catch(() => undefined);
      };
      window.addEventListener('pointerdown', go, true);
      window.addEventListener('keydown', go, true);
      window.addEventListener('touchend', go, true);
    },
    setVolume(v) {
      volume = v;
      guard(() => {
        const c = ctx as Ctx;
        (master as GainNode).gain.setTargetAtTime(volumeGain(v), c.currentTime, 0.03);
      });
    },
    play(spec) {
      guard(() => playNow(spec));
    },
    cue(cue) {
      guard(() => playNow({ cue, gain: 1, rate: 1 }));
    },
    setTension(t) {
      tension = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0;
    },
    music(on) {
      guard(() => {
        const c = ctx as Ctx;
        if (on && !layers) buildLayers(c);
        if (on && !musicOn && layers) nextEighth = Math.max(nextEighth, c.currentTime + 0.05);
        musicOn = on;
        if (on) scheduleMusic(c);
        mix(c);
      });
    },
  };
}

/** The one sound engine of the page. */
export const gameAudio: GameAudio = createGameAudio();
