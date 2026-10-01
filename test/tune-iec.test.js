import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  G, THIRD_NOMINAL, THIRD_EXACT, OCTAVE_NOMINAL, iecEdges, designBandpass, sosPower, designBank,
  weightingDb, weightBands, toOctaves, randomErrorDb, FILTER_ORDER,
} from '../js/tune/iec.js';
import { DEVICE_EQ_F } from '../js/protocol/factory.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/iec-bank-scipy.json', import.meta.url), 'utf8'));
const db = (p) => 10 * Math.log10(p);

// ---- IEC 61260-1 acceptance limits on relative attenuation, class 1, as octave-band exponents x of G^x.
// 2014 edition: Table 1 as transcribed in the open-source phonometry library (MIT) from BS EN 61260-1:2014.
// 1995 edition (= ANSI S1.11-2004): stricter everywhere, so passing it implies passing 2014.
const LIMITS = {
  2014: { passMin: -0.4, pass: [[0, 0.4], [1 / 8, 0.5], [1 / 4, 0.7], [3 / 8, 1.4], [1 / 2, 5.3]], stop: [[1 / 2, 1.2], [1, 16.6], [2, 40.5], [3, 60], [4, 70]], bandwidth: 0.4 },
  1995: { passMin: -0.3, pass: [[0, 0.3], [1 / 8, 0.4], [1 / 4, 0.6], [3 / 8, 1.3], [1 / 2, 5.0]], stop: [[1 / 2, 2.0], [1, 17.5], [2, 42], [3, 61], [4, 70]], bandwidth: 0.3 },
};
/** Octave-band breakpoint G^x mapped to a 1/b-octave filter (IEC 61260-1:2014 formula 9). */
const mapBreak = (x, b) => 1 + ((G ** (1 / (2 * b)) - 1) / (G ** 0.5 - 1)) * (G ** x - 1);
function interp(points, b, omega) {
  const xs = points.map(([x]) => Math.log10(mapBreak(x, b))), ys = points.map(([, y]) => y), lx = Math.log10(omega);
  if (lx >= xs[xs.length - 1]) return ys[ys.length - 1];
  for (let i = 1; i < xs.length; i++) if (lx <= xs[i]) return ys[i - 1] + ((ys[i] - ys[i - 1]) * (lx - xs[i - 1])) / (xs[i] - xs[i - 1]);
  return ys[0];
}
/** [min, max] relative attenuation allowed at normalised frequency omega = f / fm. */
function limits(edition, b, omega) {
  const L = LIMITS[edition], oh = omega < 1 ? 1 / omega : omega;
  return oh <= mapBreak(1 / 2, b) ? [L.passMin, interp(L.pass, b, oh)] : [interp(L.stop, b, oh), Infinity];
}
/** Worst margin (dB, positive = inside the corridor) of one band filter over the IEC 61260-2 test grid. */
function maskMargin(band, fs, edition, b = 3, S = 24) {
  const ref = db(sosPower(band.sos, band.fm, fs));
  let worst = Infinity;
  for (let i = -3 * b * S; i <= 3 * b * S; i++) {
    const omega = G ** (i / (b * S)), f = omega * band.fm;
    if (f >= fs / 2) continue; // nothing exists above Nyquist
    const att = ref - db(sosPower(band.sos, f, fs));
    const [lo, hi] = limits(edition, b, omega);
    worst = Math.min(worst, att - lo, hi - att);
  }
  return worst;
}

test('1/3-octave centres follow IEC 61260-1 (base 10) and carry the ISO 266 nominal labels', () => {
  assert.ok(Math.abs(G - 10 ** 0.3) < 1e-15);
  assert.equal(THIRD_EXACT.length, 31);
  assert.deepEqual(THIRD_NOMINAL, [20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000]);
  assert.equal(THIRD_EXACT[17], 1000);
  assert.ok(Math.abs(THIRD_EXACT[0] - 19.9526) < 1e-3 && Math.abs(THIRD_EXACT[30] - 19952.6) < 0.1);
  assert.ok(Math.abs(THIRD_EXACT[14] - 501.187) < 1e-3, 'the "500 Hz" band is really 501.19 Hz');
  THIRD_EXACT.forEach((f, i) => assert.ok(Math.abs(f / THIRD_NOMINAL[i] - 1) < 0.02, `band ${i}`));
  const [lo, hi] = iecEdges(1000);
  assert.ok(Math.abs(hi / lo - G ** (1 / 3)) < 1e-12 && Math.abs(Math.sqrt(lo * hi) - 1000) < 1e-9);
  assert.ok(Math.abs(lo - 891.251) < 1e-3 && Math.abs(hi - 1122.018) < 1e-3);
});

test('every DSP factory band sits inside the IEC band of the same index (measurement maps 1:1 onto the EQ)', () => {
  assert.equal(DEVICE_EQ_F.length, THIRD_EXACT.length);
  DEVICE_EQ_F.forEach((f, i) => {
    const [lo, hi] = iecEdges(THIRD_EXACT[i]);
    assert.ok(f > lo && f < hi && Math.abs(f / THIRD_EXACT[i] - 1) < 0.03, `band ${i}: ${f} vs ${THIRD_EXACT[i].toFixed(1)}`);
  });
});

test('band filters match scipy.signal.butter(6, bandpass) to 1e-6 dB', () => {
  assert.equal(FILTER_ORDER, 6);
  for (const ref of fixture) {
    const sos = designBandpass(ref.f1, ref.f2, ref.fs);
    assert.equal(sos.length, 6 * 5, 'six biquads');
    ref.freqs.forEach((f, i) => {
      const got = db(sosPower(sos, f, ref.fs));
      assert.ok(Math.abs(got - ref.db[i]) < 1e-6 * Math.max(1, Math.abs(ref.db[i])), `fs ${ref.fs} fm ${ref.fm.toFixed(1)} at ${f.toFixed(1)} Hz: ${got} vs ${ref.db[i]}`);
    });
  }
});

test('all 31 bands at 48 kHz are inside the IEC 61260-1 class 1 corridor (2014 and the stricter 1995 edition)', () => {
  const bank = designBank(48000);
  assert.equal(bank.bands.length, 31);
  assert.ok(bank.bands.every((b) => b.ok));
  for (const band of bank.bands) {
    const m14 = maskMargin(band, 48000, 2014), m95 = maskMargin(band, 48000, 1995);
    assert.ok(m14 > 0.05, `${band.nominal} Hz: 2014 margin ${m14.toFixed(3)} dB`);
    assert.ok(m95 > 0.05, `${band.nominal} Hz: 1995 margin ${m95.toFixed(3)} dB`);
  }
});

test('at 44.1 kHz the first 30 bands are class 1; the 20 kHz band does not fit under Nyquist and is flagged', () => {
  const bank = designBank(44100);
  assert.equal(bank.bands.length, 31);
  bank.bands.slice(0, 30).forEach((band) => { assert.ok(band.ok); assert.ok(maskMargin(band, 44100, 2014) > 0.05, `${band.nominal} Hz`); });
  const top = bank.bands[30];
  assert.equal(top.ok, false);
  assert.ok(Number.isFinite(db(sosPower(top.sos, 19000, 44100))), 'still measures what is there');
  const low = designBank(16000);
  assert.equal(low.bands.filter((b) => b.sos).length < 31, true, 'bands above Nyquist have no filter at all');
  assert.ok(low.bands.every((b) => (b.sos ? true : !b.ok)));
});

test('effective (noise) bandwidth of every band is within the class 1 limit of ±0.4 dB', () => {
  const fs = 48000, bank = designBank(fs);
  for (const band of bank.bands) {
    // integrate |H|² on a log grid from far below to Nyquist
    const n = 6000, a = Math.log(band.fm / 30), bnd = Math.log(Math.min(fs / 2 * 0.99999, band.fm * 30));
    let be = 0, prevF = 0, prevP = 0;
    for (let i = 0; i <= n; i++) {
      const f = Math.exp(a + ((bnd - a) * i) / n), p = sosPower(band.sos, f, fs);
      if (i) be += 0.5 * (p + prevP) * (f - prevF);
      prevF = f; prevP = p;
    }
    const dB = db(be / (band.f2 - band.f1));
    assert.ok(Math.abs(dB) < 0.1, `${band.nominal} Hz: ΔB ${dB.toFixed(3)} dB`); // class 1 allows 0.4, 1995 allowed 0.3
  }
});

test('summation: adjacent bands add up flat (class 1: +0.8 / −1.8 dB) anywhere from 25 Hz to 16 kHz', () => {
  const fs = 48000, bank = designBank(fs);
  let lo = Infinity, hi = -Infinity, midLo = Infinity, midHi = -Infinity;
  for (let i = 0; i <= 2000; i++) {
    const f = 25 * (16000 / 25) ** (i / 2000);
    const sum = db(bank.bands.reduce((s, b) => s + sosPower(b.sos, f, fs), 0));
    lo = Math.min(lo, sum); hi = Math.max(hi, sum);
    if (f <= 5000) { midLo = Math.min(midLo, sum); midHi = Math.max(midHi, sum); }
  }
  assert.ok(hi < 0.8 && lo > -1.8, `${lo.toFixed(3)} .. ${hi.toFixed(3)} dB`);
  // the bilinear transform bends the top bands a little; below 5 kHz the bank is much flatter than required
  assert.ok(midHi < 0.25 && midLo > -0.25, `${midLo.toFixed(3)} .. ${midHi.toFixed(3)} dB up to 5 kHz`);
});

test('A and C weighting reproduce IEC 61672-1 table values at the exact band centres; Z is flat', () => {
  const A = { 20: -50.5, 31.5: -39.4, 63: -26.2, 125: -16.1, 250: -8.6, 500: -3.2, 1000: 0, 2000: 1.2, 4000: 1.0, 8000: -1.1, 10000: -2.5, 16000: -6.6, 20000: -9.3 };
  const C = { 20: -6.2, 31.5: -3.0, 63: -0.8, 125: -0.2, 250: 0, 500: 0, 1000: 0, 2000: -0.2, 4000: -0.8, 8000: -3.0, 10000: -4.4, 16000: -8.5, 20000: -11.2 };
  THIRD_NOMINAL.forEach((nom, i) => {
    if (nom in A) assert.ok(Math.abs(weightingDb('A', THIRD_EXACT[i]) - A[nom]) < 0.051, `A ${nom}: ${weightingDb('A', THIRD_EXACT[i]).toFixed(2)}`);
    if (nom in C) assert.ok(Math.abs(weightingDb('C', THIRD_EXACT[i]) - C[nom]) < 0.051, `C ${nom}: ${weightingDb('C', THIRD_EXACT[i]).toFixed(2)}`);
    assert.equal(weightingDb('Z', THIRD_EXACT[i]), 0);
  });
  const w = weightBands(new Float64Array(31).fill(-30), 'A');
  assert.ok(Math.abs(w[17] + 30) < 1e-9 && Math.abs(w[0] + 80.5) < 0.06);
  assert.throws(() => weightingDb('B', 1000));
});

test('octave bands are the power sum of their three 1/3-octave bands; the lone 20 Hz band is dropped', () => {
  assert.deepEqual(OCTAVE_NOMINAL, [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]);
  const thirds = Float64Array.from({ length: 31 }, () => -20);
  thirds[16] = -10; // 800 Hz
  const oct = toOctaves(thirds);
  assert.equal(oct.length, 10);
  assert.ok(Math.abs(oct[0] - (-20 + 10 * Math.log10(3))) < 1e-9);
  assert.ok(Math.abs(oct[5] - 10 * Math.log10(0.1 + 0.01 + 0.01)) < 1e-9);
});

test('random error of a noise band level: 4.34 / sqrt(B·T) dB (Bendat & Piersol)', () => {
  assert.ok(Math.abs(randomErrorDb(100, 1) - 0.4343) < 1e-3);
  const [lo, hi] = iecEdges(THIRD_EXACT[0]);
  assert.ok(Math.abs(randomErrorDb(hi - lo, 10) - 0.64) < 0.01, 'the 20 Hz band needs a long average');
  assert.equal(randomErrorDb(100, 0), Infinity);
});
