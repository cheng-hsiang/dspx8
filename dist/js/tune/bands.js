import { DEVICE_EQ_F } from '../protocol/factory.js';

/**
 * The DSP's own 31 band centres: what the fitter models and what is written back to the device.
 * The analyser measures the IEC 61260-1 1/3-octave bands (iec.js); each DSP centre lies inside the IEC band
 * of the same index, so a measured band maps 1:1 onto an EQ band.
 */
export const TUNE_F = DEVICE_EQ_F;
export const MID_LO = 400;
export const MID_HI = 2600;

/** Mean square of sample values → dBFS as AES17 defines it: a full-scale sine reads 0 dBFS. */
export const dbfs = (meanSquare) => (meanSquare > 0 ? 10 * Math.log10(2 * meanSquare) : -200);

/** Running power average of band frames of equal duration: the equivalent level (Leq) of the whole run. */
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

/**
 * Time weightings F (125 ms) and S (1 s) applied to band levels that arrive one frame at a time. The real
 * analyser weights every sample (rta-worklet.js); this is for sources that only have frames (the simulated car).
 */
export class BandWeighter {
  constructor(n, frameSec) {
    this.fastP = new Float64Array(n); this.slowP = new Float64Array(n);
    this.aF = 1 - Math.exp(-frameSec / 0.125); this.aS = 1 - Math.exp(-frameSec / 1);
    this.started = false;
  }

  /** Returns { fast, slow } in dB after taking in one frame of band levels (dB). */
  push(bands) {
    for (let i = 0; i < this.fastP.length; i++) {
      const p = 10 ** (bands[i] / 10);
      if (!this.started) { this.fastP[i] = p; this.slowP[i] = p; continue; }
      this.fastP[i] += this.aF * (p - this.fastP[i]);
      this.slowP[i] += this.aS * (p - this.slowP[i]);
    }
    this.started = true;
    const toDb = (p) => (p > 0 ? 10 * Math.log10(p) : -200);
    return { fast: Float64Array.from(this.fastP, toDb), slow: Float64Array.from(this.slowP, toDb) };
  }
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
