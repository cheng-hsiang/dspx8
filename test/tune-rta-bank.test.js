import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BandBank } from '../js/tune/rta-worklet.js';
import { designBank, THIRD_EXACT } from '../js/tune/iec.js';
import { dbfs } from '../js/tune/bands.js';
import { pinkNoise, mulberry32 } from '../js/tune/noise.js';
import { frameFromSnapshot, micSupport } from '../js/tune/source.js';

const FS = 48000;
const makeBank = (fs = FS) => new BandBank({ sampleRate: fs, sos: designBank(fs).bands.map((b) => b.sos) });
const sine = (f, sec, amp = 0.5, fs = FS) => Float32Array.from({ length: Math.round(sec * fs) }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / fs));
/** Feed in audio-callback sized blocks; returns the snapshot taken at the end. */
function feed(bank, x, block = 128, each = null) {
  for (let i = 0; i < x.length; i += block) { bank.process(x.subarray(i, Math.min(x.length, i + block))); each?.(bank); }
  return bank.snapshot();
}

test('dBFS follows AES17: a full-scale sine reads 0 dBFS', () => {
  assert.ok(Math.abs(dbfs(0.5)) < 1e-12);
  assert.ok(Math.abs(dbfs(0.125) + 6.0206) < 1e-3);
  assert.equal(dbfs(0), -200);
});

test('a sine at a band centre reads its level in that band and is rejected by the others', () => {
  for (const idx of [0, 5, 17, 24, 30]) {
    const bank = makeBank();
    const settle = idx < 6 ? 4 : 0.5, measure = idx < 6 ? 4 : 1;
    feed(bank, sine(THIRD_EXACT[idx], settle));
    const s = feed(bank, sine(THIRD_EXACT[idx], measure)); // phase restarts: a click the settle of the next bands ignores
    const level = dbfs(s.leq[idx]);
    assert.ok(Math.abs(level - 20 * Math.log10(0.5)) < 0.1, `band ${idx}: ${level.toFixed(3)} dBFS`);
    for (const other of [idx - 3, idx + 3]) {
      if (other < 0 || other > 30) continue;
      assert.ok(level - dbfs(s.leq[other]) > 16.6, `band ${other} one octave from ${idx}: only ${(level - dbfs(s.leq[other])).toFixed(1)} dB down`);
    }
    assert.equal(s.n, Math.round(measure * FS));
    assert.ok(Math.abs(s.peak - 0.5) < 1e-3 && Math.abs(dbfs(s.ms) + 6.02) < 0.05);
  }
});

test('pink noise reads flat and white noise rises 1 dB per band', () => {
  const pink = feed(makeBank(), pinkNoise(FS * 20, { seed: 3, sampleRate: FS, rmsDb: -20, fadeMs: 0 }), 4096);
  const pv = Array.from(pink.leq, dbfs).slice(4, 29); // 50 Hz .. 12.5 kHz
  const mean = pv.reduce((a, b) => a + b, 0) / pv.length;
  pv.forEach((v, i) => assert.ok(Math.abs(v - mean) < 1.0, `pink band ${i + 4}: ${(v - mean).toFixed(2)} dB`));

  const rng = mulberry32(11);
  const white = feed(makeBank(), Float32Array.from({ length: FS * 10 }, () => (rng() * 2 - 1) * 0.3), 4096);
  const wv = Array.from(white.leq, dbfs);
  const slope = (wv[27] - wv[9]) / 18; // 160 Hz .. 10 kHz
  assert.ok(Math.abs(slope - 1) < 0.05, `white noise slope ${slope.toFixed(3)} dB per band`);
});

test('time weighting F and S follow IEC 61672-1: toneburst responses and decay rates', () => {
  const idx = 23, f = THIRD_EXACT[idx]; // 4 kHz, the toneburst test frequency of the standard
  const steady = 20 * Math.log10(0.5);
  const burstMax = (ms, key) => {
    const bank = makeBank();
    let max = 0;
    const x = new Float32Array(FS * 1.5);
    x.set(sine(f, ms / 1000), 4800);
    feed(bank, x, 64, (b) => { max = Math.max(max, b[key][idx]); });
    return dbfs(max) - steady;
  };
  // reference toneburst responses, IEC 61672-1 table 4 (= 10·lg(1 − e^(−T/τ)))
  assert.ok(Math.abs(burstMax(200, 'fast') + 1.0) < 0.3, `F 200 ms: ${burstMax(200, 'fast').toFixed(2)}`);
  assert.ok(Math.abs(burstMax(50, 'fast') + 4.8) < 0.3, `F 50 ms: ${burstMax(50, 'fast').toFixed(2)}`);
  assert.ok(Math.abs(burstMax(500, 'slow') + 4.1) < 0.3, `S 500 ms: ${burstMax(500, 'slow').toFixed(2)}`);
  assert.ok(Math.abs(burstMax(200, 'slow') + 7.4) < 0.3, `S 200 ms: ${burstMax(200, 'slow').toFixed(2)}`);

  const bank = makeBank();
  feed(bank, sine(f, 3));
  const at = (sec) => { feed(bank, new Float32Array(Math.round(sec * FS))); return { fast: dbfs(bank.fast[idx]), slow: dbfs(bank.slow[idx]) }; };
  const a = at(0.1), b = at(0.2), c = at(0.7);
  assert.ok(Math.abs((a.fast - b.fast) / 0.2 - 34.7) < 1, `F decays ${((a.fast - b.fast) / 0.2).toFixed(1)} dB/s`);
  assert.ok(Math.abs((a.slow - c.slow) / 0.9 - 4.34) < 0.2, `S decays ${((a.slow - c.slow) / 0.9).toFixed(2)} dB/s`);
});

test('the result does not depend on the block size; a snapshot restarts the Leq but not F and S', () => {
  const x = pinkNoise(FS, { seed: 5, sampleRate: FS, fadeMs: 0 });
  const a = feed(makeBank(), x, 128), b = feed(makeBank(), x, 4096);
  a.leq.forEach((v, i) => assert.ok(Math.abs(v / b.leq[i] - 1) < 1e-9, `band ${i}`));
  const bank = makeBank();
  feed(bank, x);
  const slow = bank.slow[17];
  const s = bank.snapshot();
  assert.equal(s.n, 0);
  assert.ok(Array.from(s.leq).every((v) => v === 0) && s.peak === 0 && s.ms === 0);
  assert.equal(bank.slow[17], slow);
});

test('frameFromSnapshot turns one filter-bank message into levels in dBFS', () => {
  const bank = makeBank();
  feed(bank, sine(1000, 5)); // 1000 Hz for a whole number of seconds: the next block continues in phase
  const f = frameFromSnapshot(feed(bank, sine(1000, 0.1)), FS);
  assert.ok(Math.abs(f.bands[17] + 6.02) < 0.1 && Math.abs(f.slow[17] - f.bands[17]) < 0.1 && Math.abs(f.fast[17] - f.bands[17]) < 0.1 && f.fast.length === 31);
  assert.ok(Math.abs(f.levelDb + 6.02) < 0.05 && Math.abs(f.peakDb + 6.02) < 0.05 && Math.abs(f.sec - 0.1) < 1e-9);
  const silent = frameFromSnapshot(new BandBank({ sampleRate: FS, sos: [null] }).snapshot(), FS);
  assert.equal(silent.peakDb, -200);
  assert.equal(silent.bands[0], -200);
  assert.deepEqual(micSupport({}, {}), { mediaDevices: false, getUserMedia: false, audioContext: false, audioWorklet: false, secure: false });
});

test('digital silence gives exact zeros, never NaN; bands without a filter stay at zero', () => {
  const bank = makeBank();
  feed(bank, sine(1000, 0.2));
  const s = feed(bank, new Float32Array(FS * 30), 4096);
  assert.ok(Array.from(s.leq).every(Number.isFinite) && Array.from(bank.fast).every(Number.isFinite));
  assert.equal(s.peak, 0);
  const small = new BandBank({ sampleRate: 16000, sos: designBank(16000).bands.map((b) => b.sos) });
  const t = feed(small, sine(1000, 0.5, 0.5, 16000));
  assert.equal(t.leq[30], 0);
  assert.ok(dbfs(t.leq[17]) > -7);
});
