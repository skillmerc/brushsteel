// BRUSHSTEEL headless smoke test. Runs in GitHub Actions.
// Usage: node smoke.mjs <distDir> <outDir>
// Serves the build from 127.0.0.1, loads it in headless Chromium with WebGL through SwiftShader,
// and writes <outDir>/fps.json, screenshots and a webm clip of the scripted duel (?demo=duel).
// Fails (exit 1) if the canvas has no non-blank frame within 30 s, if the canvas does not follow a
// live resize, or on any uncaught page error or console error.
// fps here is a software-render figure for spotting regressions, not a laptop number.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const dist = path.resolve(process.argv[2] || '../game/dist');
const out = path.resolve(process.argv[3] || 'out');
const FIRST_FRAME_LIMIT_MS = 30000;
const FPS_SAMPLE_MS = 10000;
const CLIP_MAX_MS = 75000;
// Performance budget: first drawn frame (data-first-frame, ms since navigation) and the
// JS heap after the scripted duel (Chromium performance.memory).
const PERF_FIRST_FRAME_MS = 3000;
const PERF_HEAP_MB = 400;
// The 3-duel heap load: each scripted duel is under 40 s of game time; cap the load at 150 s.
const HEAP_DUELS_MAX_MS = 150000;
const SIZES = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
];
const RESIZE_STEPS = [
  { width: 1024, height: 640 },
  { width: 2560, height: 1440 },
];
fs.mkdirSync(path.join(out, 'screens'), { recursive: true });
fs.mkdirSync(path.join(out, 'video-tmp'), { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const failures = [];
const consoleErrors = [];

// Static server for dist, bound to 127.0.0.1 only.
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(dist, path.normalize(p));
  if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
log('serving', dist, 'at', url);

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
log('chromium', browser.version());

// One failed step must not poison the rest. Every context is tracked; a failed step
// closes its page and context (at most 15 s) and the next step or section opens a fresh one,
// because one stuck 3440x1440 page kept the software GPU busy and timed out every later goto.
const liveCtx = new Set();
const openCtx = browser.newContext.bind(browser);
browser.newContext = async (o) => {
  const c = await openCtx(o);
  liveCtx.add(c);
  c.on('close', () => liveCtx.delete(c));
  return c;
};
const closeCtx = (c) => Promise.race([c.close().catch(() => {}), new Promise((r) => setTimeout(r, 15000))]).finally(() => liveCtx.delete(c));
const closeLeft = async () => { for (const c of [...liveCtx]) await closeCtx(c); };
// Front shots at 3440x1440 take ~50 s in SwiftShader; the default 30 s screenshot timeout is too tight there.
const shotTimeout = (key) => (/3440x1440/.test(key) ? 90000 : undefined);

function watch(page, label) {
  page.on('pageerror', (e) => consoleErrors.push({ where: label, type: 'pageerror', text: String(e && e.stack || e) }));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push({ where: label, type: 'console.error', text: m.text() });
  });
}

const waitReady = (page) => page.waitForFunction(
  () => document.getElementById('stage')?.dataset.ready === '1',
  null, { timeout: FIRST_FRAME_LIMIT_MS, polling: 50 },
);

const waitSize = (page, w, h) => page.waitForFunction(
  ([w, h]) => {
    const c = document.getElementById('stage');
    const m = /^(\d+)x(\d+)@([\d.]+)$/.exec(c?.dataset.size || '');
    if (!m || Number(m[1]) !== w || Number(m[2]) !== h) return false;
    const r = Number(m[3]);
    return c.width === Math.floor(w * r) && c.height === Math.floor(h * r);
  },
  [w, h], { timeout: 15000, polling: 50 },
);

// Count distinct colours on a sampled grid of a PNG screenshot (decoded in the page).
async function distinctColours(page, png) {
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const seen = new Set();
    const step = Math.max(1, Math.floor(c.width / 160));
    for (let y = 0; y < c.height; y += step) {
      for (let x = 0; x < c.width; x += step) {
        const i = (y * c.width + x) * 4;
        seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      }
    }
    return seen.size;
  }, png.toString('base64'));
}

async function sampleFps(page) {
  return page.evaluate((ms) => new Promise((resolve) => {
    let frames = 0;
    let worst = 0;
    let last = performance.now();
    const start = last;
    const tick = (now) => {
      frames++;
      worst = Math.max(worst, now - last);
      last = now;
      if (now - start < ms) requestAnimationFrame(tick);
      else resolve({ frames, ms: Math.round(now - start), worstFrameMs: Math.round(worst) });
    };
    requestAnimationFrame(tick);
  }), FPS_SAMPLE_MS).then((r) => ({ ...r, fps: Number((r.frames * 1000 / r.ms).toFixed(1)) }));
}

const result = {
  generatedAt: new Date().toISOString(),
  chromium: browser.version(),
  note: 'Headless Chromium, WebGL through SwiftShader (software). Use for regressions, not as a laptop figure.',
  firstFrameLimitMs: FIRST_FRAME_LIMIT_MS,
  timeToFirstFrameMs: null,
  webglRenderer: null,
  nonBlank: null,
  sizes: {},
  resize: [],
  clip: null,
  perf: { firstFrameMs: null, heapMB: null, duels: 0, heapAfterOneDuelMB: null, firstFrameLimitMs: PERF_FIRST_FRAME_MS, heapLimitMB: PERF_HEAP_MB },
  consoleErrors,
  openGameCheck: 'skipped for now (OpenGame CLI check, not run in this workflow yet)',
};

try {
  // 1. Load, first frame, fps at each size, screenshots.
  const ctx = await browser.newContext({ viewport: SIZES[0], deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  watch(page, 'smoke');
  const t0 = Date.now();
  // The bare address opens the title screen; fps is measured on the duel (?master=1).
  await page.goto(url + '?master=1', { waitUntil: 'load', timeout: FIRST_FRAME_LIMIT_MS });
  try {
    await waitReady(page);
    result.timeToFirstFrameMs = Date.now() - t0;
    log('first frame after', result.timeToFirstFrameMs, 'ms');
    const ff = Number(await page.evaluate(() => document.getElementById('stage').dataset.firstFrame || ''));
    result.perf.firstFrameMs = Number.isFinite(ff) && ff > 0 ? ff : null;
    // main.ts sets data-first-frame in the same frame as data-ready, so a missing marker here is a regression.
    if (result.perf.firstFrameMs === null) failures.push('perf: data-ready seen but no data-first-frame');
  } catch {
    failures.push(`no data-ready="1" within ${FIRST_FRAME_LIMIT_MS / 1000} s`);
  }
  result.webglRenderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl');
    if (!gl) return 'no WebGL';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });
  log('webgl', result.webglRenderer);

  if (result.timeToFirstFrameMs !== null) {
    for (const s of SIZES) {
      const key = `${s.width}x${s.height}`;
      await page.setViewportSize(s);
      try { await waitSize(page, s.width, s.height); } catch { failures.push(`canvas did not follow ${key}`); }
      await page.waitForTimeout(500);
      const png = await page.screenshot({ type: 'png' });
      fs.writeFileSync(path.join(out, 'screens', `scene-${key}.png`), png);
      const colours = await distinctColours(page, png);
      if (result.nonBlank === null) {
        result.nonBlank = { distinctColoursSampled: colours, ok: colours >= 8 };
        if (colours < 8) failures.push(`canvas looks blank (${colours} distinct colours sampled)`);
      }
      const f = await sampleFps(page);
      const dataSize = await page.evaluate(() => document.getElementById('stage').dataset.size);
      result.sizes[key] = { ...f, dataSize, distinctColoursSampled: colours };
      log(key, 'fps', f.fps, 'frames', f.frames, 'worst frame', f.worstFrameMs, 'ms');
    }

    // 2. Live resize.
    for (const s of RESIZE_STEPS) {
      const key = `${s.width}x${s.height}`;
      const t = Date.now();
      await page.setViewportSize(s);
      let ok = true;
      try { await waitSize(page, s.width, s.height); } catch { ok = false; failures.push(`live resize: canvas did not follow ${key}`); }
      const state = await page.evaluate(() => {
        const c = document.getElementById('stage');
        return { dataSize: c.dataset.size, canvasWidth: c.width, canvasHeight: c.height };
      });
      result.resize.push({ to: key, ok, followedInMs: ok ? Date.now() - t : null, ...state });
      log('resize', key, ok ? 'ok' : 'FAILED', state.dataSize);
    }
  }
  await ctx.close();

  // 2a. Front end: every screen (title, menu, duel pick, settings with
  // Keys, how to play, credits, pause, pause settings) at 1920x1080 and 1024x640, no sideways
  // overflow and no vertical clipping (the screen fits, or its body scrolls inside a visible
  // scroll area with Back on screen and nothing overlapping); a stroke drawn across the title opens the menu; Enter does too; Esc in a
  // duel opens Pause; settings survive a reload; the title still works with storage switched off.
  if (result.timeToFirstFrameMs !== null) {
    result.front = { shots: [], checks: {} };
    // A range input cannot be filled; set it and send the input event the page listens for.
    const setRange = (p, v) => p.locator('#bs-volume').evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, v);
    const FRONT_SIZES = [{ width: 1920, height: 1080 }, { width: 1024, height: 640 }, { width: 3440, height: 1440 }];
    const fd = (p, k) => p.evaluate((k) => document.getElementById('stage')?.dataset[k] || '', k);
    // Fit rules for the visible front-end layer: the layer itself must not scroll (that would hide
    // its foot), each block of the screen sits inside the window in order without overlapping, Back
    // is fully on screen, and a body taller than its room scrolls inside a .bs-scroll area that
    // is at least 100 px tall and does not scroll sideways.
    const frontFit = (p) => p.evaluate(() => {
      const r = [...document.querySelectorAll('.bs-front')].find((e) => getComputedStyle(e).display !== 'none');
      const problems = [];
      if (!r) return { overflowX: false, overflowY: false, scrolls: false, problems: ['no visible front-end layer'], text: '' };
      const text = r.textContent || '';
      const overflowX = document.documentElement.scrollWidth > innerWidth || r.scrollWidth > r.clientWidth;
      const overflowY = r.scrollHeight > r.clientHeight + 1;
      if (overflowY) problems.push(`layer is ${r.scrollHeight}px tall in ${r.clientHeight}px (cut off with no scroll area)`);
      const w = r.querySelector('.bs-fw');
      const blocks = w ? [...w.children].map((c) => ({ cls: c.className || c.tagName, b: c.getBoundingClientRect() })) : [];
      for (const [i, x] of blocks.entries()) {
        if (x.b.top < -1 || x.b.bottom > innerHeight + 1) problems.push(`${x.cls} outside the window (${Math.round(x.b.top)} to ${Math.round(x.b.bottom)})`);
        const next = blocks[i + 1];
        if (next && next.b.top < x.b.bottom - 1) problems.push(`${x.cls} overlaps ${next.cls}`);
      }
      const back = r.querySelector('.bs-back');
      if (back) {
        const b = back.getBoundingClientRect();
        if (b.top < 0 || b.bottom > innerHeight || b.height < 10) problems.push('Back button not fully on screen');
      }
      let scrolls = false;
      for (const s of r.querySelectorAll('.bs-scroll')) {
        if (s.scrollWidth > s.clientWidth + 1) problems.push('scroll area overflows sideways');
        if (s.scrollHeight > s.clientHeight + 1) {
          scrolls = true;
          const oy = getComputedStyle(s).overflowY;
          if (oy !== 'auto' && oy !== 'scroll') problems.push('body cut off: its area does not scroll');
          if (s.clientHeight < 100) problems.push(`scroll area only ${s.clientHeight}px tall`);
        }
      }
      return { overflowX, overflowY, scrolls, problems, text };
    });
    const onScreen = (p, name) => p.waitForFunction((n) => document.getElementById('stage')?.dataset.front === n, name, { timeout: 15000 });
    // Check the fit of what is on screen now, shoot it as front-<name>-<key>.png and fail on clipping.
    const fitShoot = async (p, name, key) => {
      const fit = await frontFit(p);
      const file = `front-${name}-${key}.png`;
      fs.writeFileSync(path.join(out, 'screens', file), await p.screenshot({ type: 'png', timeout: shotTimeout(key) }));
      result.front.shots.push({ file, overflowX: fit.overflowX, overflowY: fit.overflowY, scrolls: fit.scrolls, problems: fit.problems });
      log('front', name, key, 'overflowX', fit.overflowX, 'overflowY', fit.overflowY, 'scrolls', fit.scrolls, 'fit', fit.problems.length ? 'FAILED ' + fit.problems.join('; ') : 'ok', JSON.stringify(fit.text.slice(0, 160)));
      if (fit.overflowX) failures.push(`front ${name} ${key}: sideways overflow`);
      for (const pr of fit.problems) failures.push(`front ${name} ${key}: ${pr}`);
      if (/undefined|NaN|TODO|lorem/i.test(fit.text)) failures.push(`front ${name} ${key}: placeholder text`);
      return fit.problems.length === 0 && !fit.overflowX;
    };
    const FRONT_SCREENS = [['title', '', 'title'], ['menu', '?menu=1', 'menu'], ['duelpick', '?menu=masters', 'masters'], ['settings', '?menu=settings', 'settings'], ['howto', '?menu=howto', 'howto'], ['credits', '?menu=credits', 'credits']];
    const openPause = async (p, withSettings) => {
      await p.goto(url + '?master=1', { waitUntil: 'load', timeout: FIRST_FRAME_LIMIT_MS });
      await waitReady(p);
      await p.keyboard.press('Escape');
      await p.waitForFunction(() => document.getElementById('stage')?.dataset.pause === 'paused', null, { timeout: 10000 });
      if (!withSettings) return;
      await p.getByRole('dialog').getByRole('button', { name: /^Settings/ }).click();
      await p.waitForFunction(() => document.getElementById('stage')?.dataset.pause === 'settings', null, { timeout: 10000 });
    };
    try {
      for (const size of FRONT_SIZES) {
        const key = `${size.width}x${size.height}`;
        const fctx = await browser.newContext({ viewport: size, deviceScaleFactor: 1 });
        try {
        const fpage = await fctx.newPage();
        watch(fpage, 'front-' + key);
        const shoot = async (name) => {
          await fpage.waitForTimeout(400);
          await fitShoot(fpage, name, key);
        };
        for (const [name, q, scr] of FRONT_SCREENS) {
          await fpage.goto(url + q, { waitUntil: 'load', timeout: FIRST_FRAME_LIMIT_MS });
          await onScreen(fpage, scr);
          await shoot(name);
          if (name === 'howto') {
            const demos = await fpage.evaluate(() => [...document.querySelectorAll('.bs-demo')].map((f) => {
              const a = f.querySelector('.st, .dot');
              return { kind: f.className.replace('bs-demo ', ''), anim: a ? getComputedStyle(a).animationName : '' };
            }));
            log('front howto demos', JSON.stringify(demos));
            if (demos.length !== 5 || demos.some((d) => !d.anim || d.anim === 'none') || demos.find((d) => d.kind === 'parry')?.anim !== 'bs-draw-late') failures.push(`front howto ${key}: stroke demos missing or not animated ` + JSON.stringify(demos));
            // When the text scrolls, ArrowDown must scroll it (the keyboard has no other way to reach the end).
            const sc0 = await fpage.evaluate(() => { const s = document.querySelector('.bs-front .bs-scroll'); return s && s.scrollHeight > s.clientHeight + 1 ? s.scrollTop : null; });
            if (sc0 !== null) {
              await fpage.keyboard.press('ArrowDown');
              const sc1 = await fpage.evaluate(() => document.querySelector('.bs-front .bs-scroll')?.scrollTop ?? 0);
              log('front howto arrow scroll', key, sc0, sc1);
              if (!(sc1 > sc0)) failures.push(`front howto ${key}: ArrowDown does not scroll the text`);
            }
          }
        }
        // Pause and Pause > Settings over a duel at this size.
        await openPause(fpage, false);
        await shoot('pause');
        await fpage.getByRole('dialog').getByRole('button', { name: /^Settings/ }).click();
        await fpage.waitForFunction(() => document.getElementById('stage')?.dataset.pause === 'settings', null, { timeout: 10000 });
        await shoot('pause-settings');
        } catch (e) {
          failures.push(`front end ${key}: ` + (e && e.message || e));
        } finally {
          await closeCtx(fctx);
        }
      }
      // Live resize: in one page, each screen opens at 1920x1080, then the window
      // goes to 1024x640 and to 3440x1440 with no reload; after two animation frames each must still fit.
      {
        const rctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
        try {
        const rpage = await rctx.newPage();
        watch(rpage, 'front-resize');
        const twoFrames = () => rpage.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        let resized = 0;
        let allFit = true;
        const resizeCheck = async (name) => {
          for (const s of [{ width: 1024, height: 640 }, { width: 3440, height: 1440 }]) {
            await rpage.setViewportSize(s);
            await twoFrames();
            if (!(await fitShoot(rpage, name, `resized-${s.width}x${s.height}`))) allFit = false;
          }
          resized++;
        };
        for (const [name, q, scr] of FRONT_SCREENS) {
          await rpage.setViewportSize({ width: 1920, height: 1080 });
          await rpage.goto(url + q, { waitUntil: 'load', timeout: FIRST_FRAME_LIMIT_MS });
          await onScreen(rpage, scr);
          await rpage.waitForTimeout(300);
          await resizeCheck(name);
        }
        for (const [name, withSettings] of [['pause', false], ['pause-settings', true]]) {
          await rpage.setViewportSize({ width: 1920, height: 1080 });
          await openPause(rpage, withSettings);
          await rpage.waitForTimeout(300);
          await resizeCheck(name);
        }
        result.front.checks.resize = { screens: resized, allFit };
        log('front resize', allFit ? 'OK' : 'FAILED', resized, 'screens');
        } catch (e) {
          failures.push('front resize: ' + (e && e.message || e));
        } finally {
          await closeCtx(rctx);
        }
      }
      const cctx = await browser.newContext({ viewport: SIZES[0], deviceScaleFactor: 1 });
      const cpage = await cctx.newPage();
      watch(cpage, 'front-flow');
      // A stroke across the title cuts it and opens the menu.
      await cpage.goto(url, { waitUntil: 'load', timeout: FIRST_FRAME_LIMIT_MS });
      await onScreen(cpage, 'title');
      // Sound: no AudioContext before the first gesture, one after it, and no audio error.
      const audioBefore = await fd(cpage, 'audio');
      if (audioBefore) failures.push('audio: started before any click or key (data-audio=' + audioBefore + ')');
      const box = await cpage.locator('.bs-title').boundingBox();
      const y = box.y + box.height / 2;
      await cpage.mouse.move(box.x - 60, y + 10);
      await cpage.mouse.down();
      for (let i = 1; i <= 16; i++) await cpage.mouse.move(box.x - 60 + (box.width + 120) * i / 16, y + 10 - 20 * i / 16);
      await cpage.waitForTimeout(80);
      fs.writeFileSync(path.join(out, 'screens', 'front-title-cut-1920x1080.png'), await cpage.screenshot({ type: 'png' }));
      await cpage.mouse.up();
      await onScreen(cpage, 'menu');
      result.front.checks.strokeOpensMenu = true;
      const audioAfter = await cpage.waitForFunction(() => {
        const a = document.getElementById('stage')?.dataset.audio;
        return a && a !== 'suspended' ? a : a === 'suspended' ? 'suspended' : false;
      }, null, { timeout: 5000 }).then((h) => h.jsonValue()).catch(() => '');
      result.front.checks.audio = { before: audioBefore || '', after: audioAfter };
      log('audio before', audioBefore || '(none)', 'after first gesture', audioAfter || '(none)');
      if (audioAfter !== 'running' && audioAfter !== 'suspended') failures.push('audio: no working AudioContext after the first gesture (data-audio=' + (audioAfter || 'missing') + ')');
      // Enter on the title.
      await cpage.goto(url, { waitUntil: 'load' });
      await onScreen(cpage, 'title');
      await cpage.keyboard.press('Enter');
      await onScreen(cpage, 'menu');
      result.front.checks.enterOpensMenu = true;
      // Settings: change both, reload, read back.
      await cpage.goto(url + '?menu=settings', { waitUntil: 'load' });
      await onScreen(cpage, 'settings');
      await setRange(cpage, '35');
      await cpage.getByRole('radio', { name: 'High' }).click();
      await cpage.reload({ waitUntil: 'load' });
      await onScreen(cpage, 'settings');
      const kept = { volume: await cpage.locator('#bs-volume').inputValue(), high: await cpage.getByRole('radio', { name: 'High' }).getAttribute('aria-checked'), quality: await fd(cpage, 'inkQuality') };
      result.front.checks.settingsKept = kept;
      if (kept.volume !== '35' || kept.high !== 'true' || kept.quality !== 'high') failures.push('front: settings not kept over a reload ' + JSON.stringify(kept));
      // Back to low quality for the rest of the run, then Esc in a duel opens Pause.
      await cpage.getByRole('radio', { name: 'Low' }).click();
      await cpage.goto(url + '?master=1', { waitUntil: 'load' });
      await waitReady(cpage);
      await cpage.keyboard.press('Escape');
      await cpage.waitForFunction(() => document.getElementById('stage')?.dataset.pause === 'paused', null, { timeout: 10000 });
      fs.writeFileSync(path.join(out, 'screens', 'front-pause-1920x1080.png'), await cpage.screenshot({ type: 'png' }));
      await cpage.getByRole('button', { name: /Quit to menu/ }).click();
      await onScreen(cpage, 'menu');
      result.front.checks.pauseQuitToMenu = true;
      await cctx.close();
      // Storage switched off (private mode): the title, the menu and settings still work, no error.
      const pctx = await browser.newContext({ viewport: SIZES[0], deviceScaleFactor: 1 });
      await pctx.addInitScript(() => {
        Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('denied', 'SecurityError'); } });
      });
      const ppage = await pctx.newPage();
      watch(ppage, 'front-private');
      await ppage.goto(url, { waitUntil: 'load' });
      await onScreen(ppage, 'title');
      await ppage.keyboard.press('Enter');
      await onScreen(ppage, 'menu');
      await ppage.getByRole('button', { name: /Settings/ }).click();
      await onScreen(ppage, 'settings');
      await setRange(ppage, '20');
      const note = await ppage.locator('.bs-note').first().textContent();
      if (!/private mode/.test(note || '')) failures.push('front private: no private-mode note in settings');
      result.front.checks.privateMode = true;
      await pctx.close();
      // Controller: a fake standard pad. A on the title opens the menu, A on Duel
      // opens the masters, B goes back; Settings shows the controller note; a right-stick sweep in a duel
      // is a stroke; Start pauses. Each press waits two animation frames, as the game polls once a frame.
      const gctx = await browser.newContext({ viewport: SIZES[0], deviceScaleFactor: 1 });
      await gctx.addInitScript(() => {
        const pad = { id: 'CI fake pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) };
        window.__ciPad = pad;
        Object.defineProperty(navigator, 'getGamepads', { value: () => [pad, null, null, null], configurable: true });
        window.addEventListener('load', () => {
          const e = new Event('gamepadconnected');
          e.gamepad = pad;
          window.dispatchEvent(e);
        });
      });
      const gpage = await gctx.newPage();
      watch(gpage, 'front-pad');
      const frames2 = (pg) => pg.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
      const padSet = async (pg, fn, arg) => { await pg.evaluate(fn, arg); await frames2(pg); };
      // A tap: down for three animation frames, then up, all inside the page. Setting and
      // clearing the button from two evaluate calls left it down for two CDP round trips as well, with
      // no bound on wall time; on a busy runner that passed the 400 ms repeat delay and one tap moved twice.
      const padPress = async (pg, i) => {
        await pg.evaluate((i) => new Promise((r) => {
          window.__ciPad.buttons[i] = { pressed: true, touched: true, value: 1 };
          requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => {
            window.__ciPad.buttons[i] = { pressed: false, touched: false, value: 0 };
            r();
          })));
        }), i);
        await frames2(pg);
      };
      const padStick = (pg, x, y) => padSet(pg, ([x, y]) => { window.__ciPad.axes = [0, 0, x, y]; }, [x, y]);
      const pad = {};
      await gpage.goto(url, { waitUntil: 'load', timeout: FIRST_FRAME_LIMIT_MS });
      await onScreen(gpage, 'title');
      await frames2(gpage);
      await padPress(gpage, 0);
      await onScreen(gpage, 'menu');
      pad.aOpensMenu = true;
      await padPress(gpage, 0);
      await onScreen(gpage, 'masters');
      pad.aOpensMasters = true;
      await padPress(gpage, 1);
      await onScreen(gpage, 'menu');
      pad.bGoesBack = true;
      await gpage.goto(url + '?menu=settings', { waitUntil: 'load' });
      await onScreen(gpage, 'settings');
      pad.settingsNote = /Controller connected/.test((await gpage.locator('.bs-pad').textContent()) || '');
      if (!pad.settingsNote) failures.push('front pad: no controller note in settings');
      await gpage.goto(url + '?master=1', { waitUntil: 'load' });
      await waitReady(gpage);
      await frames2(gpage);
      const before = Number(await fd(gpage, 'strokes') || 0);
      await padStick(gpage, 0, 0.4);
      await padStick(gpage, 0, 1);
      await padStick(gpage, 0, 0);
      await gpage.waitForFunction((n) => Number(document.getElementById('stage')?.dataset.strokes || 0) > n, before, { timeout: 10000 }).catch(() => {});
      pad.strokesBefore = before;
      pad.strokesAfter = Number(await fd(gpage, 'strokes') || 0);
      if (!(pad.strokesAfter > before)) failures.push(`front pad: right-stick sweep gave no stroke (${before} -> ${pad.strokesAfter})`);
      await padPress(gpage, 9);
      await gpage.waitForFunction(() => document.getElementById('stage')?.dataset.pause === 'paused', null, { timeout: 10000 });
      pad.startPauses = true;
      result.front.checks.pad = pad;
      log('pad checks', JSON.stringify(pad));
      // Path screens with the pad: the brush pick opens with a button focused, A takes
      // it; the map opens on its first stop, down and up move focus, B leaves the map as it is (Escape
      // does nothing there), A on a map node starts the fight.
      const pp = {};
      const pmode = () => fd(gpage, 'mode');
      const active = () => gpage.evaluate(() => {
        const a = document.activeElement;
        const stops = [...document.querySelectorAll('.bs-path.on button:not([disabled]), .bs-path.on [tabindex="0"]')];
        return { index: stops.indexOf(a), count: stops.length, node: !!a?.closest('.bs-pmap g.go'), button: a?.tagName === 'BUTTON', text: (a?.textContent || '').slice(0, 40) };
      });
      await gpage.goto(url + '?mode=path', { waitUntil: 'load', timeout: FIRST_FRAME_LIMIT_MS });
      await gpage.waitForFunction(() => document.getElementById('stage')?.dataset.mode === 'path-brush', null, { timeout: 30000 });
      await frames2(gpage);
      const b0 = await active();
      pp.brushFocused = b0.index === 0 && b0.button;
      await padPress(gpage, 0);
      await gpage.waitForFunction(() => document.getElementById('stage')?.dataset.mode === 'path-map', null, { timeout: 10000 }).catch(() => {});
      pp.aPicksBrush = (await pmode()) === 'path-map';
      const m0 = await active();
      pp.mapFocused = m0.index === 0 && m0.node;
      await padPress(gpage, 13);
      const m1 = await active();
      pp.downMoves = m0.count > 1 && m1.index === 1;
      await padPress(gpage, 12);
      const m2 = await active();
      pp.upMoves = m2.index === 0;
      await padPress(gpage, 1);
      const m3 = await active();
      pp.bLeavesMap = (await pmode()) === 'path-map' && m3.index === 0;
      await padPress(gpage, 0);
      await gpage.waitForFunction(() => document.getElementById('stage')?.dataset.mode === 'path-duel', null, { timeout: 10000 }).catch(() => {});
      pp.aOnNodeFights = (await pmode()) === 'path-duel';
      result.front.checks.pathPad = pp;
      log('path pad checks', JSON.stringify(pp), 'stops', m0.count);
      for (const [k, v] of Object.entries(pp)) if (v !== true) failures.push(`path pad: ${k} failed`);
      await gctx.close();
      log('front checks', JSON.stringify(result.front.checks));
    } catch (e) {
      failures.push('front end: ' + (e && e.message || e));
    }
    await closeLeft();
  }

  // 2a2. Path screens fit: map, shrine, brush and end from
  // ?demo=path at 1024x640 and 1920x1080. The layer scrolls as a whole (overflow auto), so the rule is:
  // nothing wider than the window, the blocks of the screen in order without overlap, every stop
  // (button or map node) at least 10 px and its label not cut, and a taller layer really scrolls.
  if (result.timeToFirstFrameMs !== null) {
    result.pathFit = [];
    const pathFit = (p) => p.evaluate(() => {
      const r = document.querySelector('.bs-path.on');
      const problems = [];
      if (!r) return { problems: ['no visible Path layer'], scrolls: false, text: '' };
      const W = r.clientWidth;
      if (document.documentElement.scrollWidth > innerWidth || r.scrollWidth > W + 1) problems.push(`sideways overflow (${r.scrollWidth}px in ${W}px)`);
      const scrolls = r.scrollHeight > r.clientHeight + 1;
      const oy = getComputedStyle(r).overflowY;
      if (scrolls && oy !== 'auto' && oy !== 'scroll') problems.push('layer cut off: it does not scroll');
      const w = r.querySelector('.bs-pw');
      const blocks = w ? [...w.children].map((c) => ({ cls: c.className || c.tagName, b: c.getBoundingClientRect() })) : [];
      for (const [i, x] of blocks.entries()) {
        if (x.b.left < -1 || x.b.right > W + 1) problems.push(`${x.cls} outside the window sideways (${Math.round(x.b.left)} to ${Math.round(x.b.right)})`);
        const next = blocks[i + 1];
        if (next && next.b.top < x.b.bottom - 1) problems.push(`${x.cls} overlaps ${next.cls}`);
      }
      for (const e of r.querySelectorAll('.bs-pc, .bs-pbtns, .bs-pseals, .bs-pmap')) {
        const b = e.getBoundingClientRect();
        if (b.left < -1 || b.right > W + 1) problems.push(`${e.getAttribute('class')} outside the window sideways`);
      }
      for (const e of r.querySelectorAll('button, [tabindex="0"]')) {
        const b = e.getBoundingClientRect();
        const name = (e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 30);
        if (b.width < 10 || b.height < 10) problems.push(`stop "${name}" too small (${Math.round(b.width)}x${Math.round(b.height)})`);
        if (b.left < -1 || b.right > W + 1) problems.push(`stop "${name}" outside the window sideways`);
        if (e.tagName === 'BUTTON' && (e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1)) problems.push(`button "${name}" label cut`);
      }
      return { problems, scrolls, text: r.textContent || '' };
    });
    for (const size of [{ width: 1024, height: 640 }, { width: 1920, height: 1080 }]) {
      const key = `${size.width}x${size.height}`;
      let pctx2 = await browser.newContext({ viewport: size, deviceScaleFactor: 1 });
      let ppage2 = await pctx2.newPage();
      watch(ppage2, 'path-fit-' + key);
      for (const screen of ['map', 'shrine', 'brush', 'end']) {
        try {
          await ppage2.goto(url + '?demo=path&shots=1' + (screen === 'map' ? '' : '&screen=' + screen), { waitUntil: 'load', timeout: FIRST_FRAME_LIMIT_MS });
          await ppage2.waitForFunction((s) => document.getElementById('stage')?.dataset.photo === s, screen, { timeout: 30000 });
          await ppage2.waitForTimeout(400);
          const fit = await pathFit(ppage2);
          // The duel HUD and help line exist on the page but stay hidden behind Path screens.
          const hud = await ppage2.evaluate(() => { const h = [...document.querySelectorAll('.bs-hud')]; return { n: h.length, shown: h.filter((e) => getComputedStyle(e).display !== 'none').length }; });
          if (hud.n === 0) failures.push(`path ${screen} ${key}: no duel HUD on the page to check`);
          else if (hud.shown) failures.push(`path ${screen} ${key}: duel HUD shows behind the screen`);
          const file = `pathfit-${screen}-${key}.png`;
          fs.writeFileSync(path.join(out, 'screens', file), await ppage2.screenshot({ type: 'png' }));
          result.pathFit.push({ file, scrolls: fit.scrolls, problems: fit.problems });
          log('path fit', screen, key, 'scrolls', fit.scrolls, 'fit', fit.problems.length ? 'FAILED ' + fit.problems.join('; ') : 'ok');
          for (const pr of fit.problems) failures.push(`path ${screen} ${key}: ${pr}`);
          if (/undefined|NaN|TODO|lorem/i.test(fit.text)) failures.push(`path ${screen} ${key}: placeholder text`);
        } catch (e) {
          failures.push(`path fit ${screen} ${key}: ` + (e && e.message || e));
          await closeCtx(pctx2);
          pctx2 = await browser.newContext({ viewport: size, deviceScaleFactor: 1 });
          ppage2 = await pctx2.newPage();
          watch(ppage2, 'path-fit-' + key);
        }
      }
      await closeCtx(pctx2);
    }
    const bad = result.pathFit.filter((x) => x.problems.length).length;
    log('path fit', bad ? 'FAILED' : 'OK', result.pathFit.length, 'shots');
  }

  // 2b. Figure debug scene (?debug=poses): two figures cycling poses. One full shot at
  // 1920x1080 and a crop around the left figure for the ink check.
  if (result.timeToFirstFrameMs !== null) {
    const dctx = await browser.newContext({ viewport: SIZES[0], deviceScaleFactor: 1 });
    const dpage = await dctx.newPage();
    watch(dpage, 'debug-poses');
    try {
      await dpage.goto(url + '?debug=poses', { waitUntil: 'load', timeout: FIRST_FRAME_LIMIT_MS });
      await waitReady(dpage);
      await dpage.waitForFunction(() => Number(document.getElementById('stage')?.dataset.posesShown || 0) >= 3, null, { timeout: 15000, polling: 100 });
      const png = await dpage.screenshot({ type: 'png' });
      fs.writeFileSync(path.join(out, 'screens', 'debug-poses-1920x1080.png'), png);
      fs.writeFileSync(path.join(out, 'screens', 'debug-poses-left-figure-crop.png'),
        await dpage.screenshot({ type: 'png', clip: { x: 420, y: 280, width: 520, height: 460 } }));
      const colours = await distinctColours(dpage, png);
      const pose = await dpage.evaluate(() => document.getElementById('stage').dataset.pose);
      result.debugPoses = { ok: colours >= 8, distinctColoursSampled: colours, lastPose: pose };
      if (colours < 8) failures.push(`debug poses scene looks blank (${colours} colours)`);
      log('debug poses', pose, 'colours', colours);
    } catch (e) {
      failures.push('debug poses scene: ' + (e && e.message || e));
    }
    await closeCtx(dctx);
    await closeLeft();
  }

  // 2c. Medium ink preset (?quality=medium, 0.75-scale targets, 6 bleed taps). fps and
  // one shot at 1920x1080, next to the default (low, half-res) figures above. Informational, no new pass mark.
  if (result.timeToFirstFrameMs !== null) {
    const lctx = await browser.newContext({ viewport: SIZES[0], deviceScaleFactor: 1 });
    const lpage = await lctx.newPage();
    watch(lpage, 'ink-medium');
    try {
      await lpage.goto(url + '?quality=medium', { waitUntil: 'load', timeout: FIRST_FRAME_LIMIT_MS });
      await waitReady(lpage);
      await lpage.waitForTimeout(500);
      const png = await lpage.screenshot({ type: 'png' });
      fs.writeFileSync(path.join(out, 'screens', 'ink-medium-1920x1080.png'), png);
      const colours = await distinctColours(lpage, png);
      const f = await sampleFps(lpage);
      const quality = await lpage.evaluate(() => document.getElementById('stage').dataset.inkQuality);
      result.inkMedium = { quality, ...f, distinctColoursSampled: colours };
      if (colours < 8) failures.push(`ink medium scene looks blank (${colours} colours)`);
      log('ink medium', quality, 'fps', f.fps, 'colours', colours);
    } catch (e) {
      failures.push('ink medium scene: ' + (e && e.message || e));
    }
    await closeCtx(lctx);
  }

  // 2c2. Stage backgrounds: one shot per master's stage at 1366x768 (?master=1..8),
  // checking the duel painted that master's landscape (data-stage). Informational shots plus one pass mark.
  if (result.timeToFirstFrameMs !== null) {
    const STAGE_IDS = ['pine-mist', 'stone-bridge', 'bamboo-rain', 'still-pond', 'temple-steps', 'reed-marsh', 'storm-cliff', 'moon-paper'];
    let sctx = await browser.newContext({ viewport: SIZES[1], deviceScaleFactor: 1 });
    let spage = await sctx.newPage();
    watch(spage, 'stages');
    result.stages = [];
    for (let i = 0; i < STAGE_IDS.length; i++) {
      const id = STAGE_IDS[i];
      try {
        await spage.goto(url + '?master=' + (i + 1), { waitUntil: 'load', timeout: FIRST_FRAME_LIMIT_MS });
        await waitReady(spage);
        await spage.waitForFunction((want) => document.getElementById('stage')?.dataset.stage === want, id, { timeout: 10000 });
        await spage.waitForTimeout(300);
        const file = 'stage-' + id + '-1366x768.png';
        const png = await spage.screenshot({ type: 'png' });
        fs.writeFileSync(path.join(out, 'screens', file), png);
        const colours = await distinctColours(spage, png);
        result.stages.push({ id, file, distinctColoursSampled: colours });
        log('stage', id, 'colours', colours);
      } catch (e) {
        failures.push('stage ' + id + ': ' + (e && e.message || e));
        await closeCtx(sctx);
        sctx = await browser.newContext({ viewport: SIZES[1], deviceScaleFactor: 1 });
        spage = await sctx.newPage();
        watch(spage, 'stages');
      }
    }
    await closeCtx(sctx);
  }

  // 2d. Scripted duel at 1920x1080 (?demo=duel): shots of the first player parry, the
  // first hit (fighters close, spray) and the result screen. Must end in a
  // player win with at least one stroke and one parry.
  if (result.timeToFirstFrameMs !== null) {
    const dctx = await browser.newContext({ viewport: SIZES[0], deviceScaleFactor: 1 });
    const dpage = await dctx.newPage();
    watch(dpage, 'demo-duel');
    const ds = (k) => dpage.evaluate((k) => document.getElementById('stage')?.dataset[k] || '', k);
    try {
      await dpage.goto(url + '?demo=duel&shots=1', { waitUntil: 'load', timeout: FIRST_FRAME_LIMIT_MS });
      await waitReady(dpage);
      await dpage.evaluate(() => {
        const w = window;
        w.__duelFrames = 0;
        w.__duelT0 = performance.now();
        const f = () => { w.__duelFrames++; if (document.getElementById('stage').dataset.winner) { w.__duelT1 = performance.now(); return; } requestAnimationFrame(f); };
        requestAnimationFrame(f);
      });
      const shots = {};
      // The game holds still on data-photo (parry stroke half drawn; fighters overlapping after a dash; ~150 ms after the closest or
      // last hit) until window.__brushsteelResume(), so slow SwiftShader shots catch the moment.
      const shoot = async (name, cond, timeout) => {
        await dpage.waitForFunction(cond, null, { timeout, polling: 30 });
        const state = await dpage.evaluate(() => ({ ...document.getElementById('stage').dataset }));
        const png = await dpage.screenshot({ type: 'png' });
        fs.writeFileSync(path.join(out, 'screens', `${name}-1920x1080.png`), png);
        const mid = Number(await ds('mid')) || 0;
        const cx = Math.max(0, Math.min(1920 - 700, Math.round(960 + mid * 120 - 350)));
        fs.writeFileSync(path.join(out, 'screens', `${name}-fighters-crop.png`),
          await dpage.screenshot({ type: 'png', clip: { x: cx, y: 260, width: 700, height: 520 } }));
        shots[name] = { photo: state.photo || '', gap: Number(state.gap), score: state.score, colours: await distinctColours(dpage, png) };
        await dpage.evaluate(() => window.__brushsteelResume && window.__brushsteelResume());
        log('demo duel shot', name, JSON.stringify(shots[name]));
      };
      await shoot('duel-parry', () => document.getElementById('stage')?.dataset.photo === 'parry', 60000);
      // Both ink meters must have a real width in a fight (they once laid out 0 px wide).
      const meterW = await dpage.evaluate(() => [...document.querySelectorAll('.bs-hud .bs-meter')].map((m) => Math.round(m.getBoundingClientRect().width)));
      result.hudMeters = meterW;
      log('hud ink meters px', meterW.join(','));
      if (meterW.length !== 2 || meterW.some((w) => !(w > 100))) failures.push(`hud: ink meter widths ${meterW.join(',') || 'none'} (need two above 100 px)`);
      await shoot('duel-close', () => document.getElementById('stage')?.dataset.photo === 'close', 60000);
      await shoot('duel-hit', () => document.getElementById('stage')?.dataset.photo === 'hit', 60000);
      await shoot('duel-won', () => !!document.querySelector('.bs-result.on'), 90000);
      const fr = await dpage.evaluate(() => ({ frames: window.__duelFrames, ms: Math.round((window.__duelT1 || performance.now()) - window.__duelT0) }));
      result.demoDuel = {
        shots,
        winner: await ds('winner'), score: await ds('score'), duelSeconds: Number(await ds('duelSeconds')),
        strokes: Number(await ds('strokes')), playerParries: Number(await ds('playerParries')), telegraphs: Number(await ds('telegraphs')), spatter: Number(await ds('spatter')),
        fpsDuringDuel: Number((fr.frames * 1000 / Math.max(1, fr.ms)).toFixed(1)), wallMs: fr.ms,
      };
      log('demo duel', JSON.stringify(result.demoDuel));
      const heap = await dpage.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : 0));
      result.perf.heapAfterOneDuelMB = heap > 0 ? Number((heap / 1048576).toFixed(1)) : null;
      result.perf.heapMB = result.perf.heapAfterOneDuelMB;
      const d = result.demoDuel;
      if (d.winner !== 'player' || d.strokes < 1 || d.playerParries < 1) failures.push(`demo duel: winner ${d.winner}, strokes ${d.strokes}, parries ${d.playerParries}`);
    } catch (e) {
      failures.push('demo duel: ' + (e && e.message || e));
    }
    await closeCtx(dctx);
    await closeLeft();
  }

  // 2e. Heap after 3 duels: ?demo=duel&duels=3 restarts the scripted duel 1 s
  // after each result until 3 are played (data-duels-played), in one page, no shots, at a small
  // 960x540 so SwiftShader keeps near real time. Then performance.memory replaces the one-duel heap.
  if (result.timeToFirstFrameMs !== null) {
    const hctx = await browser.newContext({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
    const hpage = await hctx.newPage();
    watch(hpage, 'heap-3-duels');
    const t0 = Date.now();
    try {
      await hpage.goto(url + '?demo=duel&duels=3', { waitUntil: 'load', timeout: FIRST_FRAME_LIMIT_MS });
      await waitReady(hpage);
      let done = true;
      try {
        await hpage.waitForFunction(() => Number(document.getElementById('stage')?.dataset.duelsPlayed || 0) >= 3, null, { timeout: HEAP_DUELS_MAX_MS, polling: 500 });
      } catch { done = false; }
      const hs = await hpage.evaluate(() => ({ played: Number(document.getElementById('stage')?.dataset.duelsPlayed || 0), heap: performance.memory ? performance.memory.usedJSHeapSize : 0 }));
      result.perf.duels = hs.played;
      // No figure after 3 duels: null (logged), never the one-duel figure under the 3-duel name.
      result.perf.heapMB = hs.heap > 0 ? Number((hs.heap / 1048576).toFixed(1)) : null;
      result.perf.heapDuelsWallMs = Date.now() - t0;
      if (!done) failures.push(`perf: only ${hs.played} of 3 duels played in ${HEAP_DUELS_MAX_MS / 1000} s`);
    } catch (e) {
      failures.push('perf 3 duels: ' + (e && e.message || e));
    }
    await closeCtx(hctx);
    await closeLeft();
  }

  // Performance line. Fails only over budget; a missing value is logged, not failed.
  log('perf firstFrameMs', result.perf.firstFrameMs, 'heapMB', result.perf.heapMB, 'duels', result.perf.duels);
  if (result.perf.firstFrameMs !== null && result.perf.firstFrameMs > PERF_FIRST_FRAME_MS) failures.push(`perf: first frame ${result.perf.firstFrameMs} ms over ${PERF_FIRST_FRAME_MS} ms`);
  if (result.perf.heapMB !== null && result.perf.heapMB > PERF_HEAP_MB) failures.push(`perf: heap ${result.perf.heapMB} MB over ${PERF_HEAP_MB} MB`);

  // 3. Clip at 1280x720 of the scripted duel (?demo=duel) from the start to 2 s after the result
  // screen, at most 75 s.
  // (Before the scripted duel: 30 s of synthetic mouse strokes on the empty scene.)
  if (result.timeToFirstFrameMs !== null) {
    const vctx = await browser.newContext({
      viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1,
      recordVideo: { dir: path.join(out, 'video-tmp'), size: { width: 1280, height: 720 } },
    });
    const vpage = await vctx.newPage();
    watch(vpage, 'clip');
    await vpage.goto(url + '?demo=duel', { waitUntil: 'load' });
    await waitReady(vpage);
    const start = Date.now();
    let ended = false;
    try {
      await vpage.waitForFunction(() => !!document.querySelector('.bs-result.on'), null, { timeout: CLIP_MAX_MS, polling: 100 });
      ended = true;
      await vpage.waitForTimeout(2000);
    } catch { /* cap reached: keep the clip, fail below */ }
    const clipState = await vpage.evaluate(() => ({ ...document.getElementById('stage').dataset }));
    const strokes = Number(clipState.strokes || 0);
    if (!ended || clipState.winner !== 'player' || !(Number(clipState.playerParries) >= 1)) {
      failures.push(`clip duel: ended ${ended}, winner ${clipState.winner}, parries ${clipState.playerParries}`);
    }
    const clipMs = Date.now() - start;
    const video = vpage.video();
    await vctx.close();
    const src = await video.path();
    const dest = path.join(out, 'clip-1280x720.webm');
    fs.renameSync(src, dest);
    result.clip = { file: 'clip-1280x720.webm', seconds: Math.round(clipMs / 100) / 10, strokes, score: clipState.score, winner: clipState.winner, playerParries: Number(clipState.playerParries || 0), duelSeconds: Number(clipState.duelSeconds || 0), bytes: fs.statSync(dest).size };
    log('clip', result.clip);
  }
} catch (e) {
  failures.push('smoke script error: ' + (e && e.message || e));
} finally {
  await browser.close().catch(() => {});
  server.close();
  fs.rmSync(path.join(out, 'video-tmp'), { recursive: true, force: true });
}

if (consoleErrors.length) failures.push(`${consoleErrors.length} console or page error(s)`);
result.failures = failures;
result.ok = failures.length === 0;
fs.writeFileSync(path.join(out, 'fps.json'), JSON.stringify(result, null, 2));
log('fps.json written');
for (const e of consoleErrors) console.log('  error:', e.where, e.type, e.text.slice(0, 300));
if (failures.length) { console.error('FAIL: ' + failures.join('; ')); process.exit(1); }
log('PASS');
