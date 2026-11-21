// BRUSHSTEEL quick smoke (21 Nov 2026, CI minutes cut): the push-time check. Serves dist/ on
// 127.0.0.1, opens the duel (?master=1) at one size (1920x1080) in headless Chromium (SwiftShader),
// waits for the first frame (data-ready="1" within 30 s, data-first-frame set), takes one screenshot,
// checks it is not blank (8 or more distinct colours sampled) and fails on any console or page error.
// The full check (fps at two sizes, live resize, front screens at three sizes, Path screens, gamepad,
// ink presets, scripted duel, heap after 3 duels, clip) stays in smoke.mjs and runs by hand only.
// Usage: node first-frame.mjs <distDir> <outDir>
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const dist = path.resolve(process.argv[2] || '../game/dist');
const out = path.resolve(process.argv[3] || 'out');
const FIRST_FRAME_LIMIT_MS = 30000;
const SIZE = { width: 1920, height: 1080 };
fs.mkdirSync(path.join(out, 'screens'), { recursive: true });
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(dist, path.normalize(p));
  if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const failures = [];
const errors = [];
const result = { size: `${SIZE.width}x${SIZE.height}`, timeToFirstFrameMs: null, firstFrameMs: null, distinctColoursSampled: null };
try {
  const page = await browser.newPage({ viewport: SIZE, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => errors.push('pageerror ' + String(e && e.stack || e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error ' + m.text()); });
  const t0 = Date.now();
  await page.goto(url + '?master=1', { waitUntil: 'load', timeout: FIRST_FRAME_LIMIT_MS });
  try {
    await page.waitForFunction(() => document.getElementById('stage')?.dataset.ready === '1', null, { timeout: FIRST_FRAME_LIMIT_MS, polling: 50 });
    result.timeToFirstFrameMs = Date.now() - t0;
    const ff = Number(await page.evaluate(() => document.getElementById('stage').dataset.firstFrame || ''));
    result.firstFrameMs = Number.isFinite(ff) && ff > 0 ? ff : null;
    if (result.firstFrameMs === null) failures.push('data-ready seen but no data-first-frame');
  } catch { failures.push(`no data-ready="1" within ${FIRST_FRAME_LIMIT_MS / 1000} s`); }
  await page.waitForTimeout(500);
  const png = await page.screenshot({ type: 'png' });
  fs.writeFileSync(path.join(out, 'screens', `quick-scene-${result.size}.png`), png);
  result.distinctColoursSampled = await page.evaluate(async (b64) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data; const seen = new Set();
    const step = Math.max(1, Math.floor(c.width / 160));
    for (let y = 0; y < c.height; y += step) for (let x = 0; x < c.width; x += step) { const i = (y * c.width + x) * 4; seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]); }
    return seen.size;
  }, png.toString('base64'));
  if (result.distinctColoursSampled < 8) failures.push(`canvas looks blank (${result.distinctColoursSampled} distinct colours sampled)`);
} catch (e) {
  failures.push('quick smoke error: ' + (e && e.message || e));
} finally {
  await browser.close().catch(() => {});
  server.close();
}
if (errors.length) failures.push(`${errors.length} console or page error(s)`);
result.errors = errors.map((e) => e.slice(0, 300));
result.failures = failures;
result.ok = failures.length === 0;
fs.writeFileSync(path.join(out, 'quick.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
if (failures.length) { console.error('FAIL: ' + failures.join('; ')); process.exit(1); }
console.log('PASS quick smoke');
