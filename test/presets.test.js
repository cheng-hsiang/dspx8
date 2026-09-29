import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validatePreset, loadBundledPresets, localPresets } from '../js/eq/presets.js';
import { Storage } from '../js/core/storage.js';

const BASE = fileURLToPath(new URL('../presets/', import.meta.url));
const fileFetch = async (url) => {
  try { const text = await readFile(url.replace('./presets/', BASE), 'utf8'); return { ok: true, json: async () => JSON.parse(text) }; } catch { return { ok: false, json: async () => { throw new Error('404'); } }; }
};

test('validatePreset accepts the bundled files and rejects bad ones', async () => {
  for (const name of ['01-reference.json', '02-kpop-jpop.json', '03-mandarin-vocal.json', '04-chill-rnb.json']) {
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
  assert.equal(presets.length, 4);
  assert.equal(presets[0].name, '01 基準');
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
