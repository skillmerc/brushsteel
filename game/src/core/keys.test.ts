import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_KEYS, KEYS_KEY, actionForKey, bindableKey, controlsLine, keyLabel, loadKeys, pressRebind, saveKeys, type KeyBindings,
} from './keys.js';
import type { KeyValueStore } from './save.js';
import { memoryStore } from './session.js';

const throwing: KeyValueStore = {
  getItem() { throw new DOMException('denied', 'SecurityError'); },
  setItem() { throw new DOMException('denied', 'SecurityError'); },
  removeItem() { throw new DOMException('denied', 'SecurityError'); },
};

test('keys: letters, digits, Space and Shift can be bound; menu keys and other modifiers cannot', () => {
  assert.equal(bindableKey({ key: 'J' }), 'j');
  assert.equal(bindableKey({ key: 'j' }), 'j');
  assert.equal(bindableKey({ key: '!', code: 'Digit1' }), '1');
  assert.equal(bindableKey({ key: '7' }), '7');
  assert.equal(bindableKey({ key: ' ' }), 'Space');
  assert.equal(bindableKey({ key: 'Shift' }), 'Shift');
  for (const key of ['Escape', 'Enter', 'Tab', 'Backspace', 'ArrowUp', 'Control', 'Alt', 'Meta', 'F5', ',', '/']) {
    assert.equal(bindableKey({ key }), null, key);
  }
});

test('keys: the defaults drive the game as before, and the arrows always work', () => {
  assert.equal(actionForKey(DEFAULT_KEYS, { key: 'a' }), 'left');
  assert.equal(actionForKey(DEFAULT_KEYS, { key: 'D' }), 'right');
  assert.equal(actionForKey(DEFAULT_KEYS, { key: 's' }), 'dip');
  assert.equal(actionForKey(DEFAULT_KEYS, { key: 'Shift' }), 'dash');
  assert.equal(actionForKey(DEFAULT_KEYS, { key: 'r' }), 'restart');
  assert.equal(actionForKey(DEFAULT_KEYS, { key: 'q' }), null);
  const moved: KeyBindings = { left: 'j', right: 'l', dip: 'k', dash: 'Space', restart: '1' };
  assert.equal(actionForKey(moved, { key: 'a' }), null);
  assert.equal(actionForKey(moved, { key: 'j' }), 'left');
  assert.equal(actionForKey(moved, { key: ' ' }), 'dash');
  assert.equal(actionForKey(moved, { key: '!', code: 'Digit1' }), 'restart');
  assert.equal(actionForKey(moved, { key: 'ArrowLeft' }), 'left');
  assert.equal(actionForKey(moved, { key: 'ArrowRight' }), 'right');
  assert.equal(actionForKey(moved, { key: 'ArrowDown' }), 'dip');
});

test('keys: rebind sets a free key, refuses a used one by name, refuses menu keys, Esc cancels', () => {
  const set = pressRebind(DEFAULT_KEYS, 'left', { key: 'J' });
  assert.equal(set.kind, 'set');
  if (set.kind === 'set') {
    assert.equal(set.keys.left, 'j');
    assert.equal(set.keys.right, 'd');
    assert.equal(DEFAULT_KEYS.left, 'a', 'defaults not changed');
  }
  const taken = pressRebind(DEFAULT_KEYS, 'left', { key: 'd' });
  assert.equal(taken.kind, 'refused');
  if (taken.kind === 'refused') {
    assert.equal(taken.by, 'right');
    assert.equal(taken.message, 'D already steps right.');
  }
  const same = pressRebind(DEFAULT_KEYS, 'dash', { key: 'Shift' });
  assert.equal(same.kind, 'set', 'its own key again is fine');
  for (const [action, key, by] of [['right', 'a', 'left'], ['dip', 'Shift', 'dash'], ['dash', 'r', 'restart'], ['restart', 's', 'dip'], ['left', 'd', 'right']] as const) {
    const r = pressRebind(DEFAULT_KEYS, action, { key });
    assert.equal(r.kind === 'refused' ? r.by : r.kind, by, `${action} on ${key}`);
  }
  assert.equal(pressRebind(DEFAULT_KEYS, 'left', { key: 'Escape' }).kind, 'cancel');
  const reserved = pressRebind(DEFAULT_KEYS, 'left', { key: 'Enter' });
  assert.equal(reserved.kind, 'refused');
  if (reserved.kind === 'refused') assert.equal(reserved.message, 'Enter is kept for menus and Pause.');
  const arrow = pressRebind(DEFAULT_KEYS, 'dash', { key: 'ArrowUp' });
  if (arrow.kind === 'refused') assert.equal(arrow.message, 'Up arrow is kept for menus and Pause.');
  else assert.fail('arrow must be refused');
  const ctrl = pressRebind(DEFAULT_KEYS, 'dash', { key: 'Control' });
  if (ctrl.kind === 'refused') assert.equal(ctrl.message, 'Pick a letter, a digit, Space or Shift.');
  else assert.fail('Control must be refused');
});

test('keys: saved with a version and read back; bad stored values give the defaults', () => {
  const s = memoryStore();
  assert.deepEqual(loadKeys(s), DEFAULT_KEYS);
  const mine: KeyBindings = { left: 'j', right: 'l', dip: 'k', dash: 'Space', restart: '1' };
  assert.equal(saveKeys(s, mine), true);
  assert.deepEqual(JSON.parse(s.getItem(KEYS_KEY) ?? ''), { v: 1, keys: mine });
  assert.deepEqual(loadKeys(s), mine);
  const bad = [
    'not json', '[]', 'null', '{"v":2,"keys":{"left":"j","right":"l","dip":"k","dash":"Space","restart":"1"}}',
    '{"keys":{"left":"j","right":"l","dip":"k","dash":"Space","restart":"1"}}',
    '{"v":1,"keys":{"left":"j","right":"j","dip":"k","dash":"Space","restart":"1"}}',
    '{"v":1,"keys":{"left":"J","right":"l","dip":"k","dash":"Space","restart":"1"}}',
    '{"v":1,"keys":{"left":"Escape","right":"l","dip":"k","dash":"Space","restart":"1"}}',
    '{"v":1,"keys":{"left":"j","right":"l","dip":"k","dash":"Space"}}',
    '{"v":1,"keys":{"left":7,"right":"l","dip":"k","dash":"Space","restart":"1"}}',
    `{"v":1,"pad":"${'x'.repeat(600)}"}`,
  ];
  for (const text of bad) {
    s.setItem(KEYS_KEY, text);
    assert.deepEqual(loadKeys(s), DEFAULT_KEYS, text.slice(0, 60));
  }
  assert.deepEqual(loadKeys(throwing), DEFAULT_KEYS);
  assert.equal(saveKeys(throwing, mine), false);
});

test('keys: labels and the controls line follow the bindings', () => {
  assert.equal(keyLabel('a'), 'A');
  assert.equal(keyLabel('Space'), 'Space');
  assert.equal(keyLabel('ArrowLeft'), 'Left arrow');
  assert.equal(controlsLine(DEFAULT_KEYS), 'A / D step, Shift dash, hold S to dip.');
  assert.equal(controlsLine({ left: 'j', right: 'l', dip: 'k', dash: 'Space', restart: '1' }), 'J / L step, Space dash, hold K to dip.');
});
