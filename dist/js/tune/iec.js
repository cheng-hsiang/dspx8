// Fractional-octave analysis per IEC 61260-1:2014 (= ANSI/ASA S1.11-2014 part 1) and the frequency weightings
// of IEC 61672-1:2013. Everything here is pure maths: the tests check the filters against the class 1
// acceptance limits of the standard.

/** Octave ratio, base 10 (IEC 61260-1, 5.2.1). */
export const G = 10 ** 0.3;
export const FILTER_ORDER = 6;

/** Nominal 1/3-octave mid-band frequencies, 20 Hz – 20 kHz (ISO 266). Used as labels only. */
export const THIRD_NOMINAL = Object.freeze([20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800,
  1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000]);
/** Exact mid-band frequencies fm = 1000 · G^(k/3), k = −17 … 13. */
export const THIRD_EXACT = Object.freeze(THIRD_NOMINAL.map((_, i) => (i === 17 ? 1000 : 1000 * G ** ((i - 17) / 3))));
/** Octave bands that have all three of their 1/3-octave bands in the range above. */
export const OCTAVE_NOMINAL = Object.freeze([31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]);

/** Band-edge frequencies of a 1/b-octave band. */
export const iecEdges = (fm, b = 3) => [fm * G ** (-1 / (2 * b)), fm * G ** (1 / (2 * b))];

/**
 * Butterworth band-pass between f1 and f2 (the −3 dB points), bilinear transform with pre-warped edges:
 * the same design as scipy.signal.butter(order, [f1, f2], 'bandpass'). Returns `order` biquads as a flat
 * Float64Array of [b0, b1, b2, a1, a2] (a0 = 1), normalised to unity gain at the centre of the band.
 */
export function designBandpass(f1, f2, fs, order = FILTER_ORDER) {
  const k = 2 * fs;
  const w1 = k * Math.tan((Math.PI * f1) / fs), w2 = k * Math.tan((Math.PI * f2) / fs);
  const bw = w2 - w1, w0sq = w1 * w2;
  const sos = new Float64Array(order * 5);
  let s = 0;
  // upper-half-plane poles of the low-pass prototype; each becomes two band-pass poles, one above and one
  // below the real axis, and each of those stands for a conjugate pair = one biquad
  for (let i = 0; i < order / 2; i++) {
    const th = (Math.PI * (2 * i + order + 1)) / (2 * order);
    const pr = (Math.cos(th) * bw) / 2, pi = (Math.sin(th) * bw) / 2;
    // root = sqrt(p² − w0²), complex
    const re = pr * pr - pi * pi - w0sq, im = 2 * pr * pi;
    const mag = Math.hypot(re, im);
    const rr = Math.sqrt((mag + re) / 2), ri = Math.sign(im || 1) * Math.sqrt((mag - re) / 2);
    for (const sign of [1, -1]) {
      const sr = pr + sign * rr, si = pi + sign * ri;
      // z = (k + s) / (k − s)
      const dr = k - sr, di = -si, den = dr * dr + di * di;
      const zr = ((k + sr) * dr + si * di) / den, zi = (si * dr - (k + sr) * di) / den;
      sos.set([1, 0, -1, -2 * zr, zr * zr + zi * zi], s * 5);
      s++;
    }
  }
  // unity gain where the analogue centre lands; spread over the sections so none of them is extreme
  const f0 = (fs / Math.PI) * Math.atan(Math.sqrt(w0sq) / k);
  const gain = sosPower(sos, f0, fs) ** (-1 / (2 * order));
  for (let i = 0; i < order; i++) { sos[i * 5] *= gain; sos[i * 5 + 2] *= gain; }
  return sos;
}

/** |H(f)|² of a biquad cascade. */
export function sosPower(sos, f, fs) {
  const w = (2 * Math.PI * f) / fs, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  let p = 1;
  for (let i = 0; i < sos.length; i += 5) {
    const nr = sos[i] + sos[i + 1] * c1 + sos[i + 2] * c2, ni = -(sos[i + 1] * s1 + sos[i + 2] * s2);
    const dr = 1 + sos[i + 3] * c1 + sos[i + 4] * c2, di = -(sos[i + 3] * s1 + sos[i + 4] * s2);
    p *= (nr * nr + ni * ni) / (dr * dr + di * di);
  }
  return p;
}

/**
 * The 31-band 1/3-octave filter bank for one sample rate.
 * ok = the band fits under Nyquist and its filter is the class 1 design. A band whose upper edge does not fit
 * (20 kHz at 44.1 kHz) gets a filter up to just under Nyquist and ok = false; a band entirely above Nyquist
 * has no filter (sos = null).
 */
export function designBank(fs) {
  const top = 0.49 * fs;
  const bands = THIRD_EXACT.map((fm, i) => {
    const [f1, f2] = iecEdges(fm);
    const fits = f2 < top;
    const sos = f1 < 0.9 * top ? designBandpass(f1, fits ? f2 : top, fs) : null;
    return { fm, nominal: THIRD_NOMINAL[i], f1, f2, ok: fits, sos };
  });
  return { fs, order: FILTER_ORDER, bands };
}

// IEC 61672-1:2013 annex E: pole frequencies of the A and C weightings
const F1 = 20.598997, F2 = 107.65265, F3 = 737.86223, F4 = 12194.217;
const rC = (f) => (F4 * F4 * f * f) / ((f * f + F1 * F1) * (f * f + F4 * F4));
const rA = (f) => (rC(f) * f * f) / Math.sqrt((f * f + F2 * F2) * (f * f + F3 * F3));
const A1000 = 20 * Math.log10(rA(1000)), C1000 = 20 * Math.log10(rC(1000));

/** Frequency weighting in dB at f: 'A', 'C' or 'Z' (zero = flat). */
export function weightingDb(type, f) {
  if (type === 'Z') return 0;
  if (type === 'A') return 20 * Math.log10(rA(f)) - A1000;
  if (type === 'C') return 20 * Math.log10(rC(f)) - C1000;
  throw new Error(`未知的頻率計權：${type}`);
}

/** 1/3-octave band levels with a frequency weighting applied at the exact band centres. */
export const weightBands = (bands, type) => Float64Array.from(bands, (v, i) => v + weightingDb(type, THIRD_EXACT[i]));

/** Octave-band levels: the power sum of the three 1/3-octave bands in each octave (31.5 Hz – 16 kHz). */
export function toOctaves(thirds) {
  return Float64Array.from(OCTAVE_NOMINAL, (_, o) => {
    let p = 0;
    for (let i = 1 + 3 * o; i < 4 + 3 * o; i++) p += 10 ** (thirds[i] / 10);
    return p > 0 ? 10 * Math.log10(p) : -200;
  });
}

/** Overall level of a set of band levels (power sum). */
export function totalDb(bands) {
  let p = 0;
  for (const v of bands) if (Number.isFinite(v)) p += 10 ** (v / 10);
  return p > 0 ? 10 * Math.log10(p) : -200;
}

/**
 * Standard deviation (dB) of the level of a band of random noise averaged for `seconds`:
 * normalised random error 1/sqrt(B·T) (Bendat & Piersol, Random Data), times 10·log10(e).
 */
export const randomErrorDb = (bandwidthHz, seconds) => (bandwidthHz > 0 && seconds > 0 ? 4.342944819 / Math.sqrt(bandwidthHz * seconds) : Infinity);
