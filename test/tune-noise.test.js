import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinkNoise, wavBytes } from '../js/tune/noise.js';

function fftPower(x) {
  const n = x.length, re = Float64Array.from(x), im = new Float64Array(n);
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len / 2;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  return Array.from({ length: n / 2 }, (_, k) => re[k] * re[k] + im[k] * im[k]);
}

test('wavBytes writes a valid 16-bit mono PCM file', () => {
  const b = wavBytes(Float32Array.from([0, 1, -1, 0.5]), 44100);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const str = (o, n) => String.fromCharCode(...b.slice(o, o + n));
  assert.equal(str(0, 4), 'RIFF'); assert.equal(str(8, 4), 'WAVE'); assert.equal(str(12, 4), 'fmt '); assert.equal(str(36, 4), 'data');
  assert.equal(dv.getUint32(4, true), b.length - 8);
  assert.equal(dv.getUint16(20, true), 1); assert.equal(dv.getUint16(22, true), 1);
  assert.equal(dv.getUint32(24, true), 44100); assert.equal(dv.getUint32(28, true), 88200);
  assert.equal(dv.getUint16(32, true), 2); assert.equal(dv.getUint16(34, true), 16);
  assert.equal(dv.getUint32(40, true), 8); assert.equal(b.length, 44 + 8);
  assert.deepEqual([dv.getInt16(44, true), dv.getInt16(46, true), dv.getInt16(48, true), dv.getInt16(50, true)], [0, 32767, -32767, 16384]);
});

test('pinkNoise is deterministic, never clips, has the requested RMS and equal power per octave', () => {
  const n = 8192 * 16, sr = 44100;
  const x = pinkNoise(n, { seed: 3, sampleRate: sr, rmsDb: -16, fadeMs: 0 });
  assert.deepEqual(Array.from(pinkNoise(4096, { seed: 3 })), Array.from(pinkNoise(4096, { seed: 3 })), 'same seed, same file');
  assert.notDeepEqual(Array.from(pinkNoise(4096, { seed: 3 })), Array.from(pinkNoise(4096, { seed: 4 })));
  assert.ok(x.every((v) => v >= -1 && v <= 1));
  const rms = Math.sqrt(x.reduce((s, v) => s + v * v, 0) / n);
  assert.ok(Math.abs(20 * Math.log10(rms) + 16) < 0.5, `rms ${20 * Math.log10(rms)}`);
  const N = 8192, acc = new Float64Array(N / 2);
  for (let s = 0; s < 16; s++) {
    const seg = Array.from({ length: N }, (_, i) => x[s * N + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1))));
    fftPower(seg).forEach((p, k) => { acc[k] += p; });
  }
  const octave = [125, 250, 500, 1000, 2000, 4000, 8000].map((fc) => {
    let sum = 0;
    for (let k = 1; k < N / 2; k++) { const f = (k * sr) / N; if (f >= fc / Math.SQRT2 && f < fc * Math.SQRT2) sum += acc[k]; }
    return 10 * Math.log10(sum);
  });
  const mean = octave.reduce((a, b) => a + b, 0) / octave.length;
  assert.ok(octave.every((v) => Math.abs(v - mean) < 1.5), octave.map((v) => (v - mean).toFixed(2)).join(' '));
});

test('pinkNoise fades in and out so a looping player does not click', () => {
  const x = pinkNoise(44100, { seed: 1, sampleRate: 44100, fadeMs: 50 });
  assert.equal(x[0], 0);
  assert.equal(x[x.length - 1], 0);
  assert.ok(Math.abs(x[22050]) > 0 || Math.abs(x[22051]) > 0);
});
