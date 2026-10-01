import { bandAddrs, LAYERS, nonFlatBands, flattenPairs } from '../eq/model.js';
import { encodeFreq, encodeGain, clamp, GAIN_MIN_DB, GAIN_MAX_DB } from '../protocol/codec.js';
import { TUNE_F, MID_LO, MID_HI } from './bands.js';
import { bandAvgResponse, fitGains, FS } from './fit.js';

/** Q of every auto-tune band: the classic 1/3-octave graphic EQ width. */
export const TUNE_Q = 4.3;
/** The rear doors should play at least this much quieter than the front (keeps the stage in front). */
export const REAR_BELOW_FRONT = 3;
/** A band this far below both neighbours is a narrow dip: usually a cancellation, which EQ cannot fill. */
export const DIP_DB = 6;
const LOW_EXCLUDE = 40;   // below: phone mic and pink-noise SNR are not good enough to act on
const LOW_CUT_ONLY = 70;  // below (the 40/50/63 Hz bands): cut only
const HIGH_EXCLUDE = 17000;
const REAR_CUT_ONLY = 5000;
const BASS_BOOST_LIMIT = 6, BOOST_LIMIT = 4, TREBLE_BOOST_LIMIT = 3;

export const NOTE_TEXT = Object.freeze({
  low: '太低，手機量不準，不修正',
  high: '太高，不修正',
  snr: '噪音蓋過訊號，不修正',
  mic: '幾乎沒有訊號（麥克風或喇叭），不修正',
  'low-cut': '低頻只衰減',
  'rear-hf': '後門沒有高音，只衰減',
  dip: '窄凹陷（聲波抵消），不補',
});

export const qRawFor = (q, scale) => Math.round((100 * q) / scale);

/** Car "house curve": a bass shelf (half its height at 90 Hz) plus a treble tilt from 1 kHz reaching trebleDb at 16 kHz. */
export function targetCurve({ bassDb = 0, trebleDb = 0 } = {}, centers = TUNE_F) {
  return Float64Array.from(centers, (f) => {
    const bass = bassDb / (1 + 2 ** ((Math.log2(f) - Math.log2(90)) * 2.5));
    const treble = f <= 1000 ? 0 : trebleDb * Math.min(1, Math.log2(f / 1000) / 4);
    return bass + treble;
  });
}

/** Median of the mid bands: the level reference. A median ignores a single deep dip that would drag a mean. */
export function midRef(values, centers = TUNE_F) {
  const v = [];
  centers.forEach((f, i) => { if (f >= MID_LO && f <= MID_HI) v.push(values[i]); });
  v.sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length ? (v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2) : 0;
}

/** Shape error against the target (level removed), RMS over 63 Hz – 10 kHz. */
export function rmsToTarget(values, target, centers = TUNE_F, lo = 63, hi = 10000) {
  const d = [];
  centers.forEach((f, i) => { if (f >= lo && f <= hi) d.push(values[i] - target[i]); });
  if (!d.length) return 0;
  const mean = d.reduce((a, b) => a + b, 0) / d.length;
  return Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / d.length);
}

/**
 * The correction for one channel group.
 *   measured: band levels heard now (dB), which already include the EQ in place (eqOld, band-averaged dB).
 *   raw = measured − eqOld is the car without EQ; the new EQ should make raw + eqNew = target + K,
 *   with K chosen so the mid bands stay where they are (shape, not level).
 * Rear only: when a front measurement exists, the rear is also cut so it plays 3 dB under the front.
 * strength < 1 (Q not verified yet) moves only part of the way from the current EQ.
 * maxHz: hardly any signal arrives from this (nominal) frequency up (microphone or speaker), so those bands are left alone.
 */
export function planCorrection({ measured, eqOld, target, group = 'front', strength = 1, ambient = null, frontMid = null, maxHz = null, centers = TUNE_F, q = TUNE_Q, fs = FS }) {
  const n = centers.length;
  const raw = Float64Array.from(measured, (m, i) => m - eqOld[i]);
  const K = midRef(raw, centers) - midRef(target, centers);
  let trimDb = 0;
  if (group === 'rear' && Number.isFinite(frontMid)) trimDb = Math.min(0, frontMid - REAR_BELOW_FRONT - midRef(raw, centers));
  const full = Float64Array.from(target, (t, i) => t + K - raw[i] + trimDb);
  const desired = Float64Array.from(full, (d, i) => eqOld[i] + strength * (d - eqOld[i]));

  const notes = new Array(n).fill(null), free = new Array(n).fill(true);
  const lo = new Array(n).fill(GAIN_MIN_DB), hi = new Array(n).fill(BOOST_LIMIT);
  for (let i = 0; i < n; i++) {
    const f = centers[i];
    if (f < LOW_EXCLUDE) { free[i] = false; notes[i] = 'low'; continue; }
    if (f > HIGH_EXCLUDE) { free[i] = false; notes[i] = 'high'; continue; }
    if (maxHz && f >= maxHz * 0.97) { free[i] = false; notes[i] = 'mic'; continue; }
    if (ambient && measured[i] - ambient[i] < 10) { free[i] = false; notes[i] = 'snr'; continue; }
    hi[i] = f < 125 ? BASS_BOOST_LIMIT : f > 10000 ? TREBLE_BOOST_LIMIT : BOOST_LIMIT;
    if (i > 0 && i < n - 1 && raw[i] + DIP_DB < Math.min(raw[i - 1], raw[i + 1])) { hi[i] = 0; notes[i] = 'dip'; }
    else if (f < LOW_CUT_ONLY) { hi[i] = 0; notes[i] = 'low-cut'; }
    else if (group === 'rear' && f > REAR_CUT_ONLY) { hi[i] = 0; notes[i] = 'rear-hf'; }
  }
  const gains = fitGains({ desired: Float64Array.from(desired, (d, i) => (free[i] ? d : NaN)), centers, q, free, lo, hi, fs });
  const eqNew = bandAvgResponse(Array.from(centers, (f, i) => ({ f, g: gains[i], q })), centers, { fs });
  const predicted = Float64Array.from(raw, (r, i) => r + eqNew[i]);
  return {
    gains, desired, predicted, raw, notes, trimDb, strength,
    before: rmsToTarget(measured, target, centers), after: rmsToTarget(predicted, target, centers),
    maxBoost: Math.max(0, ...gains),
  };
}

/**
 * Register writes for a plan: every enabled 31-band slot of each channel gets the factory centre frequency,
 * the fixed Q (raw) and its gain; the 10-band OEM layer is flattened because it would stack on top.
 * Only fields that differ from the store are written. Slot 32 is left alone.
 */
export function tuneWritePairs({ gains, channels, store, qRaw, centers = TUNE_F }) {
  const pairs = [], skipped = [];
  for (const ch of channels) {
    for (let b = 1; b <= centers.length; b++) {
      const a = bandAddrs(LAYERS.MODE, ch, b);
      if (store.get(a.TYPE) !== 7 || store.get(a.F) === 0) { skipped.push({ ch, band: b }); continue; }
      const want = { F: encodeFreq(centers[b - 1]), G: encodeGain(clamp(gains[b - 1], GAIN_MIN_DB, GAIN_MAX_DB)), Q: qRaw };
      for (const k of ['F', 'G', 'Q']) if (store.get(a[k]) !== want[k]) pairs.push({ addr: a[k], val: want[k] });
    }
  }
  const app = flattenPairs(nonFlatBands(store, LAYERS.APP, channels));
  return { pairs: pairs.concat(app), skipped, appFlattened: app.length };
}

/** Everything that shapes one channel's EQ. Measurements taken under a different signature are stale. */
export function eqSignature(store, ch) {
  const v = [];
  for (let b = 1; b <= 32; b++) { const a = bandAddrs(LAYERS.MODE, ch, b); v.push(store.get(a.TYPE), store.get(a.F), store.get(a.G), store.get(a.Q)); }
  for (let b = 1; b <= 10; b++) { const a = bandAddrs(LAYERS.APP, ch, b); v.push(store.get(a.TYPE), store.get(a.F), store.get(a.G), store.get(a.Q)); }
  return v.join(',');
}

/**
 * Q check: one band was raised between the baseline and the boosted measurement. Compare what the car did in
 * the bands around it with what each Q convention predicts (band-averaged). `before` / `after` hold the
 * channel's filters under each hypothesis: { qrate: [...], one: [...] }. Level drift between the two runs is
 * removed using bands far from the test band.
 */
export function judgeQ({ baseline, boosted, before, after, centers = TUNE_F, bandIdx = 17, span = 3 }) {
  const delta = Float64Array.from(boosted, (v, i) => v - baseline[i]);
  const far = [];
  centers.forEach((f, i) => { if (Math.abs(i - bandIdx) > 7 && f >= 100 && f <= 10000) far.push(delta[i]); });
  const drift = far.length ? far.reduce((a, b) => a + b, 0) / far.length : 0;
  const idx = [];
  for (let i = bandIdx - span; i <= bandIdx + span; i++) idx.push(i);
  const measured = idx.map((i) => delta[i] - drift);
  const predict = (h) => { const a = bandAvgResponse(after[h], centers), b = bandAvgResponse(before[h], centers); return idx.map((i) => a[i] - b[i]); };
  const predicted = { qrate: predict('qrate'), one: predict('one') };
  const rms = (p) => Math.sqrt(measured.reduce((s, m, k) => s + (m - p[k]) ** 2, 0) / measured.length);
  const err = { qrate: rms(predicted.qrate), one: rms(predicted.one) };
  const centreDelta = measured[span];
  let verdict = 'unclear';
  if (centreDelta >= 4 && Math.min(err.qrate, err.one) < 2.5 && Math.abs(err.qrate - err.one) >= 0.7) verdict = err.qrate < err.one ? 'qrate' : 'one';
  return { verdict, err, measured, predicted, centreDelta, drift, freqs: idx.map((i) => centers[i]) };
}
