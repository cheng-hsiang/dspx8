import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUNE_F, BandAverager, BandWeighter, powerAverage, midLevel, formatBands } from '../js/tune/bands.js';
import { DEVICE_EQ_F } from '../js/protocol/factory.js';

test('tune bands are the DSP factory 31-band centres', () => {
  assert.equal(TUNE_F.length, 31);
  assert.deepEqual(TUNE_F, DEVICE_EQ_F);
});

test('BandAverager averages power, not decibels', () => {
  const avg = new BandAverager(2);
  avg.add([0, -10]); avg.add([10, -10]);
  assert.equal(avg.count, 2);
  const m = avg.mean();
  assert.ok(Math.abs(m[0] - 10 * Math.log10(5.5)) < 1e-9);
  assert.ok(Math.abs(m[1] + 10) < 1e-9);
  const p = powerAverage([[0, 0], [10, 0]]);
  assert.ok(Math.abs(p[0] - m[0]) < 1e-9);
});

test('BandWeighter: frame-rate F and S weightings start at the first frame and decay at the IEC rates', () => {
  const w = new BandWeighter(2, 0.1);
  let out = w.push([-20, -40]);
  assert.ok(Math.abs(out.fast[0] + 20) < 1e-9 && Math.abs(out.slow[1] + 40) < 1e-9);
  for (let i = 0; i < 50; i++) out = w.push([-20, -40]);
  assert.ok(Math.abs(out.fast[0] + 20) < 1e-6);
  const before = out;
  for (let i = 0; i < 5; i++) out = w.push([-200, -200]); // 0.5 s of silence
  assert.ok(Math.abs((before.fast[0] - out.fast[0]) / 0.5 - 34.7) < 0.5, 'F: 34.7 dB/s');
  assert.ok(Math.abs((before.slow[0] - out.slow[0]) / 0.5 - 4.34) < 0.1, 'S: 4.34 dB/s');
});

test('midLevel averages the 405 Hz – 2.52 kHz bands; formatBands is compact and labelled', () => {
  const v = TUNE_F.map((_, i) => i);
  assert.equal(midLevel(v), (13 + 14 + 15 + 16 + 17 + 18 + 19 + 20 + 21) / 9);
  const s = formatBands(TUNE_F.map(() => -1.23));
  assert.ok(s.startsWith('20:-1.2 25:-1.2 33:-1.2'), s);
  assert.ok(s.includes('1k:-1.2 1.26k:-1.2'), s);
  assert.ok(s.endsWith('20.2k:-1.2'), s);
});
