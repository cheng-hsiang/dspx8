import { DEVICE_EQ_F } from '../protocol/factory.js';

/** Analysis bands = the DSP's own 31 band centres, so a measured band maps 1:1 onto an EQ band. */
export const TUNE_F = DEVICE_EQ_F;
export const SIXTH = 2 ** (1 / 6);
export const MID_LO = 400;
export const MID_HI = 2600;

export const bandEdges = (fc) => [fc / SIXTH, fc * SIXTH];

/**
 * Sum FFT bin power (dB per bin, as AnalyserNode.getFloatFrequencyData returns) inside each 1/3-octave band.
 * A band too narrow to contain a bin centre takes its nearest bin scaled to the band width.
 */
export function spectrumToBands(dbBins, sampleRate, fftSize, centers = TUNE_F) {
  const binHz = sampleRate / fftSize;
  const last = dbBins.length - 1;
  const pw = (k) => { const v = dbBins[k]; return Number.isFinite(v) ? 10 ** (v / 10) : 0; };
  const out = new Float64Array(centers.length);
  centers.forEach((fc, i) => {
    const [lo, hi] = bandEdges(fc);
    const k0 = Math.max(1, Math.ceil(lo / binHz)), k1 = Math.min(last, Math.ceil(hi / binHz) - 1);
    let sum = 0;
    if (k1 >= k0) for (let k = k0; k <= k1; k++) sum += pw(k);
    else { const k = Math.min(last, Math.max(1, Math.round(fc / binHz))); sum = pw(k) * ((hi - lo) / binHz); }
    out[i] = sum > 0 ? 10 * Math.log10(sum) : -200;
  });
  return out;
}

/** Running power average of band frames. */
export class BandAverager {
  constructor(n = TUNE_F.length) { this.acc = new Float64Array(n); this.count = 0; }
  add(bands) { for (let i = 0; i < this.acc.length; i++) this.acc[i] += 10 ** (bands[i] / 10); this.count++; }
  mean() { return Float64Array.from(this.acc, (p) => (p > 0 && this.count ? 10 * Math.log10(p / this.count) : -200)); }
}

export function powerAverage(list) {
  const avg = new BandAverager(list[0]?.length ?? TUNE_F.length);
  for (const b of list) avg.add(b);
  return avg.mean();
}

/** Mean (in dB) of the bands between 400 Hz and 2.6 kHz: the reference that corrections are normalised to. */
export function midLevel(values, centers = TUNE_F) {
  let sum = 0, n = 0;
  centers.forEach((f, i) => { if (f >= MID_LO && f <= MID_HI) { sum += values[i]; n++; } });
  return n ? sum / n : 0;
}

export const fmtHz = (f) => (f >= 1000 ? `${Number((f / 1000).toFixed(f < 10000 ? 2 : 1))}k` : String(Math.round(f)));

/** One-line log form: "20:-1.2 25:-0.8 … 20.2k:-14.0". */
export const formatBands = (values, centers = TUNE_F) => centers.map((f, i) => `${fmtHz(f)}:${values[i].toFixed(1)}`).join(' ');
