import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validatePreset, loadBundledPresets, localPresets } from '../js/eq/presets.js';
import { Storage } from '../js/core/storage.js';
import { presetWritePairs, LAYERS, QRATE } from '../js/eq/model.js';
import { RegisterStore } from '../js/core/store.js';
import { FakeDevice } from '../js/transport/fake-device.js';

const BASE = fileURLToPath(new URL('../presets/', import.meta.url));
const fileFetch = async (url) => {
  try { const text = await readFile(url.replace('./presets/', BASE), 'utf8'); return { ok: true, json: async () => JSON.parse(text) }; } catch { return { ok: false, json: async () => { throw new Error('404'); } }; }
};

test('validatePreset accepts the bundled files and rejects bad ones', async () => {
  const index = JSON.parse(await readFile(BASE + 'index.json', 'utf8'));
  assert.equal(index.length, 14);
  for (const name of index) {
    const p = JSON.parse(await readFile(BASE + name, 'utf8'));
    const v = validatePreset(p);
    assert.deepEqual(v, { ok: true, errors: [] }, `${name}: ${v.errors.join('; ')}`);
  }
  assert.equal(validatePreset({ schema: 'other', name: 'x', eq: {} }).ok, false);
  assert.equal(validatePreset({ schema: 'dspx8s-preset/1', name: 'x', eq: { front: [{ f: 5, g: 1, q: 1 }] } }).ok, false);
  assert.equal(validatePreset({ schema: 'dspx8s-preset/1', name: 'x', eq: { front: [{ f: 100, g: 20, q: 1 }] } }).ok, false);
  assert.equal(validatePreset({ schema: 'dspx8s-preset/1', name: 'x', eq: { front: [{ f: 100, g: 1, q: 0.1 }] } }).ok, false);
  assert.equal(validatePreset({ schema: 'dspx8s-preset/1', eq: {} }).ok, false);
});

test('loadBundledPresets reads index.json then each file, skipping broken entries', async () => {
  const presets = await loadBundledPresets(fileFetch, './presets/');
  assert.equal(presets.length, 14);
  assert.equal(presets[0].name, '01 基準', 'the default selection stays the reference curve');
  assert.equal(presets[presets.length - 1].name, '平直（全部歸零）');
  const broken = async (url) => (url.endsWith('index.json') ? { ok: true, json: async () => ['01-reference.json', 'missing.json'] } : fileFetch(url));
  const warnings = [];
  const orig = console.warn; console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const p2 = await loadBundledPresets(broken, './presets/');
    assert.equal(p2.length, 1);
    assert.equal(warnings.length, 1);
  } finally { console.warn = orig; }
});

test('localPresets stores under settings.eqPresets', async () => {
  const storage = await Storage.open({ indexedDB: undefined });
  const lp = localPresets(storage);
  assert.deepEqual(await lp.list(), []);
  const preset = { schema: 'dspx8s-preset/1', name: '我的', eq: { front: [{ f: 100, g: 1, q: 1 }] } };
  await lp.save('我的', preset);
  assert.deepEqual((await lp.list()).map((p) => p.name), ['我的']);
  await assert.rejects(lp.save('bad', { schema: 'x' }), /invalid/);
  await lp.remove('我的');
  assert.deepEqual(await lp.list(), []);
});

test('every bundled preset is safe to share: named, described, moderate, and fits both EQ layers without dropping a filter', async () => {
  const presets = await loadBundledPresets(fileFetch, './presets/');
  assert.equal(new Set(presets.map((p) => p.name)).size, presets.length, 'names are unique');
  const dev = new FakeDevice();
  const groups = { front: [1, 2], rear: [3, 4] };
  for (const p of presets) {
    assert.ok(typeof p.description === 'string' && p.description.length >= 8, `${p.name}: description`);
    assert.deepEqual(Object.keys(p.eq).sort(), ['front', 'rear'], `${p.name}: groups`);
    for (const [g, filters] of Object.entries(p.eq)) {
      assert.ok(filters.length <= 10, `${p.name}.${g}: at most 10 filters so the 10-band layer can hold them`);
      assert.equal(new Set(filters.map((x) => x.f)).size, filters.length, `${p.name}.${g}: one filter per frequency`);
      for (const x of filters) {
        assert.ok(Math.abs(x.g) <= 4, `${p.name}.${g} ${x.f} Hz: gain ${x.g} beyond ±4 dB`);
        assert.ok(x.q >= 0.7 && x.q <= 3, `${p.name}.${g} ${x.f} Hz: Q ${x.q}`);
      }
    }
    assert.ok(p.eq.rear.every((x) => x.f < 6000 || x.g <= 0), `${p.name}: rear doors have no tweeters, never boost their treble`);
    for (const layer of [LAYERS.MODE, LAYERS.APP]) {
      const store = new RegisterStore();
      store.setMany(Array.from({ length: store.size }, (_, addr) => ({ addr, val: dev.regs[addr] })));
      const { dropped, skipped } = presetWritePairs(p, layer, groups, store, QRATE);
      assert.deepEqual(dropped, [], `${p.name} on ${layer}: dropped ${JSON.stringify(dropped)}`);
      assert.deepEqual(skipped, []);
    }
  }
});

test('the flat preset only zeroes gains', async () => {
  const flat = (await loadBundledPresets(fileFetch, './presets/')).find((p) => p.name === '平直（全部歸零）');
  assert.deepEqual(flat.eq, { front: [], rear: [] });
  const dev = new FakeDevice();
  const store = new RegisterStore();
  store.setMany(Array.from({ length: store.size }, (_, addr) => ({ addr, val: dev.regs[addr] })));
  const { pairs } = presetWritePairs(flat, LAYERS.MODE, { front: [1, 2], rear: [3, 4] }, store, QRATE);
  assert.equal(pairs.length, 4 * 31);
  assert.ok(pairs.every((x) => x.val === 500));
});
