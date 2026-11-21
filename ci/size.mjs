// Size report for the BRUSHSTEEL build. Usage: node size.mjs <distDir> <outDir>
// Writes <outDir>/size.json. Exits 1 if dist/index.html is missing or the build is over 20 MB.
import fs from 'node:fs';
import path from 'node:path';

const dist = path.resolve(process.argv[2] || '../game/dist');
const out = path.resolve(process.argv[3] || 'out');
const LIMIT_MB = 20;
fs.mkdirSync(out, { recursive: true });

const files = [];
const walk = (dir) => {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files.push({ file: path.relative(dist, p), bytes: fs.statSync(p).size });
  }
};
walk(dist);
files.sort((a, b) => b.bytes - a.bytes);
const total = files.reduce((s, f) => s + f.bytes, 0);
const hasIndex = fs.existsSync(path.join(dist, 'index.html'));
const report = {
  dist: path.basename(dist),
  totalBytes: total,
  totalMB: Number((total / 1048576).toFixed(3)),
  fileCount: files.length,
  limitMB: LIMIT_MB,
  hasIndexHtml: hasIndex,
  largest: files.slice(0, 10),
};
const problems = [];
if (!hasIndex) problems.push('dist/index.html is missing');
if (report.totalMB > LIMIT_MB) problems.push(`build is ${report.totalMB} MB, over ${LIMIT_MB} MB`);
report.ok = problems.length === 0;
report.problems = problems;
fs.writeFileSync(path.join(out, 'size.json'), JSON.stringify(report, null, 2));
console.log(`size: ${report.totalMB} MB in ${report.fileCount} files, index.html ${hasIndex ? 'present' : 'MISSING'}`);
for (const f of report.largest) console.log(`  ${(f.bytes / 1024).toFixed(1)} KB  ${f.file}`);
if (problems.length) { console.error('FAIL: ' + problems.join('; ')); process.exit(1); }
