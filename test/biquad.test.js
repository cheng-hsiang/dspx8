import { test } from 'node:test';
import assert from 'node:assert/strict';
import { peakingCoeffs, magnitudeDb, responseDb, logFreqAxis } from '../js/eq/biquad.js';

test('peaking filter reaches its gain at f0 and ~0 dB far away', () => {
  const c = peakingCoeffs(1000, 6, 1.4);
  assert.ok(Math.abs(magnitudeDb(c, 1000) - 6) < 0.05);
  assert.ok(Math.abs(magnitudeDb(c, 20)) < 0.1);
  assert.ok(Math.abs(magnitudeDb(c, 15000)) < 0.2);
  const cut = peakingCoeffs(250, -4, 1.0);
  assert.ok(Math.abs(magnitudeDb(cut, 250) + 4) < 0.05);
});

test('higher Q is narrower: one octave away, Q 4 is closer to 0 dB than Q 1', () => {
  const wide = magnitudeDb(peakingCoeffs(1000, 6, 1), 2000);
  const narrow = magnitudeDb(peakingCoeffs(1000, 6, 4), 2000);
  assert.ok(narrow < wide);
  assert.ok(wide > 1.5);
});

test('responseDb sums bands and skips disabled or flat ones', () => {
  const freqs = [100, 1000, 10000];
  const r = responseDb([{ f: 1000, g: 3, q: 1.4, enabled: true }, { f: 1000, g: 3, q: 1.4, enabled: false }, { f: 10000, g: 0, q: 1, enabled: true }], freqs);
  assert.ok(Math.abs(r[1] - 3) < 0.05);
  assert.ok(Math.abs(r[2]) < 0.2);
  assert.deepEqual(responseDb([], freqs), [0, 0, 0]);
});

test('logFreqAxis is log-spaced from 20 to 20000', () => {
  const a = logFreqAxis(5);
  assert.equal(a.length, 5);
  assert.ok(Math.abs(a[0] - 20) < 1e-9 && Math.abs(a[4] - 20000) < 1e-6);
  assert.ok(Math.abs(a[2] - Math.sqrt(20 * 20000)) < 1e-6);
});
