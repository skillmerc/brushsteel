// Stage looks: every master's stage has a look, values stay in range,
// looks are deterministic from the seed, and the eight stages differ.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MASTERS } from './masters.js';
import { ACCENTS, BAND_TOP, LANDSCAPE_GROUND, MAX_TONE, MOTIFS, STAGE_LOOK_IDS, landscapePaintKey, lookCodes, stageLook } from './stages.js';

test('every stage id in MASTERS has its own look, plus title and path-map', () => {
  for (const m of MASTERS) {
    assert.ok(STAGE_LOOK_IDS.includes(m.stageId), m.stageId);
    assert.equal(stageLook(m.stageId).id, m.stageId);
  }
  assert.ok(STAGE_LOOK_IDS.includes('title'));
  assert.ok(STAGE_LOOK_IDS.includes('path-map'));
  assert.equal(STAGE_LOOK_IDS.length, MASTERS.length + 2);
});

test('values are in range for many seeds', () => {
  for (const id of STAGE_LOOK_IDS) {
    for (let seed = 0; seed < 50; seed++) {
      const l = stageLook(id, seed);
      assert.equal(l.ridges.length, 3);
      for (const r of l.ridges) {
        assert.ok(r.base >= -1.2 && r.base <= 1.2, `${id} base ${r.base}`);
        assert.ok(r.amp >= 0.2 && r.amp <= 3.2, `${id} amp ${r.amp}`);
        assert.ok(r.freq >= 0.1 && r.freq <= 1.2, `${id} freq ${r.freq}`);
        assert.ok(r.tone >= 0 && r.tone <= MAX_TONE, `${id} tone ${r.tone}`);
      }
      assert.ok(l.rain >= 0 && l.rain <= 1);
      assert.ok(l.sky >= 0 && l.sky <= 0.5);
      assert.ok(l.bandCap > 0 && l.bandCap < MAX_TONE);
      assert.ok(l.seed >= 0 && l.seed < 1);
      const c = lookCodes(l);
      assert.ok(c.motif >= 0 && c.motif < MOTIFS.length);
      assert.ok(c.accent >= 0 && c.accent < ACCENTS.length);
      if (l.accent !== 'none') assert.ok(l.accentAt[2] > 0 && l.accentAt[2] < 1);
    }
  }
});

test('deterministic from the seed, and the seed changes the ridges', () => {
  const a = JSON.stringify(stageLook('storm-cliff', 7));
  const b = JSON.stringify(stageLook('storm-cliff', 7));
  assert.equal(a, b);
  assert.notEqual(JSON.stringify(stageLook('storm-cliff', 8).ridges), JSON.stringify(stageLook('storm-cliff', 7).ridges));
});

test('the eight stages are clearly different: each has its own motif', () => {
  const motifs = MASTERS.map((m) => stageLook(m.stageId).motif);
  assert.equal(new Set(motifs).size, MASTERS.length);
  assert.ok(!motifs.includes('none'));
});

test('at most one red accent kind per look, and unknown ids fall back to the first stage', () => {
  for (const id of STAGE_LOOK_IDS) assert.ok(ACCENTS.includes(stageLook(id).accent));
  assert.equal(stageLook('no-such-stage').id, MASTERS[0].stageId);
});

test('fighters stay readable: far ridges paler than near, red mark out of the band centre', () => {
  for (const m of MASTERS) {
    const l = stageLook(m.stageId);
    const t = l.ridges.map((r) => r.tone);
    assert.ok(t[0] <= t[1] && t[1] <= t[2], `${l.id} tones ${t.join(',')}`);
    if (l.accent === 'none') continue;
    const [x, y, size] = l.accentAt;
    const clear = Math.abs(x) - size >= 3.5 || y - size >= BAND_TOP || y + size <= LANDSCAPE_GROUND;
    assert.ok(clear, `${l.id} accent at ${x},${y}`);
  }
});

test('landscape paints only when the stage or size changes', () => {
  const a = landscapePaintKey('pine-mist', 8, 4.5, 1600, 900);
  // A resize event that lands on the same view and size: same key, so no repaint.
  assert.equal(landscapePaintKey('pine-mist', 8, 4.5, 1600, 900), a);
  assert.notEqual(landscapePaintKey('stone-bridge', 8, 4.5, 1600, 900), a);
  assert.notEqual(landscapePaintKey('pine-mist', 8, 4.5, 1366, 768), a);
  assert.notEqual(landscapePaintKey('pine-mist', 9.6, 4.5, 1600, 900), a);
});
