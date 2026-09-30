import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUNE_F, bandEdges, spectrumToBands, BandAverager, powerAverage, midLevel, formatBands } from '../js/tune/bands.js';
import { DEVICE_EQ_F } from '../js/protocol/factory.js';

function spectrum(fn, sampleRate = 48000, fftSize = 32768) {
  const n = fftSize / 2, out = new Float32Array(n);
  for (let k = 0; k < n; k++) out[k] = k === 0 ? -Infinity : fn((k * sampleRate) / fftSize);
  return out;
}

test('tune bands are the DSP factory 31-band centres with 1/3-octave edges', () => {
  assert.equal(TUNE_F.length, 31);
  assert.deepEqual(TUNE_F, DEVICE_EQ_F);
  const [lo, hi] = bandEdges(1000);
  assert.ok(Math.abs(hi / lo - 2 ** (1 / 3)) < 1e-9);
  assert.ok(Math.abs(Math.sqrt(lo * hi) - 1000) < 1e-9);
});

test('pink noise (−10 dB/decade per FFT bin) reads flat per 1/3-octave band from 125 Hz up', () => {
  const pink = spectrumToBands(spectrum((f) => -10 * Math.log10(f)), 48000, 32768);
  const upper = Array.from(pink.slice(8, 31)); // 125 Hz .. 20.2 kHz
  assert.ok(Math.max(...upper) - Math.min(...upper) < 0.6, upper.map((v) => v.toFixed(2)).join(' '));
});

test('white noise band power grows with band width (∝ centre frequency)', () => {
  const white = spectrumToBands(spectrum(() => 0), 48000, 32768);
  for (let i = 12; i < 30; i++) {
    const expected = 10 * Math.log10(TUNE_F[i + 1] / TUNE_F[i]);
    assert.ok(Math.abs(white[i + 1] - white[i] - expected) < 0.25, `band ${i}: ${(white[i + 1] - white[i]).toFixed(2)} vs ${expected.toFixed(2)}`);
  }
});

test('works at 44.1 kHz and a smaller FFT, and never returns NaN for the lowest bands', () => {
  const b = spectrumToBands(spectrum((f) => -10 * Math.log10(f), 44100, 8192), 44100, 8192);
  assert.equal(b.length, 31);
  assert.ok(Array.from(b).every(Number.isFinite));
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

test('midLevel averages the 405 Hz – 2.52 kHz bands; formatBands is compact and labelled', () => {
  const v = TUNE_F.map((_, i) => i);
  assert.equal(midLevel(v), (13 + 14 + 15 + 16 + 17 + 18 + 19 + 20 + 21) / 9);
  const s = formatBands(TUNE_F.map(() => -1.23));
  assert.ok(s.startsWith('20:-1.2 25:-1.2 33:-1.2'), s);
  assert.ok(s.includes('1k:-1.2 1.26k:-1.2'), s);
  assert.ok(s.endsWith('20.2k:-1.2'), s);
});
