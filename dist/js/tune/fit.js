import { peakingCoeffs } from '../eq/biquad.js';
import { bandAddrs, LAYERS } from '../eq/model.js';
import { decodeFreq, decodeGain, decodeQ, clamp } from '../protocol/codec.js';
import { TUNE_F } from './bands.js';

export const FS = 48000; // the DSP runs at 48 kHz
const POINTS = 9;
const grids = new Map();

/** Frequencies spread evenly (in log) across each band, with the trig terms precomputed. */
function grid(centers, points, fs) {
  const key = `${fs}|${points}|${centers.join(',')}`;
  let g = grids.get(key);
  if (!g) {
    const n = centers.length * points;
    g = { c1: new Float64Array(n), s1: new Float64Array(n), c2: new Float64Array(n), s2: new Float64Array(n) };
    centers.forEach((fc, b) => {
      for (let k = 0; k < points; k++) {
        const f = fc * 2 ** (-1 / 6 + (k + 0.5) / (3 * points));
        const w = (2 * Math.PI * f) / fs, p = b * points + k;
        g.c1[p] = Math.cos(w); g.s1[p] = Math.sin(w); g.c2[p] = Math.cos(2 * w); g.s2[p] = Math.sin(2 * w);
      }
    });
    grids.set(key, g);
  }
  return g;
}

const valid = (x) => x && x.f > 0 && x.q > 0 && x.g !== 0 && Number.isFinite(x.g) && Number.isFinite(x.q);

/**
 * Composite response of peaking filters, power-averaged over each 1/3-octave band — what an RTA band would show
 * if the room were flat. Point-sampling at the centre would overstate narrow filters.
 */
export function bandAvgResponse(filters, centers = TUNE_F, { fs = FS, points = POINTS } = {}) {
  const g = grid(centers, points, fs);
  const coefs = filters.filter(valid).map((x) => peakingCoeffs(x.f, x.g, x.q, fs));
  const out = new Float64Array(centers.length);
  if (!coefs.length) return out;
  for (let b = 0; b < centers.length; b++) {
    let acc = 0;
    for (let k = 0; k < points; k++) {
      const p = b * points + k;
      let db = 0;
      for (const c of coefs) {
        const nr = c.b0 + c.b1 * g.c1[p] + c.b2 * g.c2[p], ni = -(c.b1 * g.s1[p] + c.b2 * g.s2[p]);
        const dr = c.a0 + c.a1 * g.c1[p] + c.a2 * g.c2[p], di = -(c.a1 * g.s1[p] + c.a2 * g.s2[p]);
        db += 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
      }
      acc += 10 ** (db / 10);
    }
    out[b] = 10 * Math.log10(acc / points);
  }
  return out;
}

/**
 * Peaking filters currently active on one channel: all 32 mode-region slots plus the 10-band OEM layer
 * (both run in series). Only TYPE 7 is known to be a peaking filter; other types with a gain are counted.
 * `store` only needs get(addr), so the simulated car can pass the fake device's registers.
 */
export function filtersFromStore(store, ch, qScale) {
  const filters = [];
  let unknown = 0;
  const take = (layer, band) => {
    const a = bandAddrs(layer, ch, band);
    const type = store.get(a.TYPE), F = store.get(a.F), G = store.get(a.G), Q = store.get(a.Q);
    if (type === 0 || F === 0 || G === 500) return;
    if (type !== 7) { unknown++; return; }
    filters.push({ f: decodeFreq(F), g: decodeGain(G), q: decodeQ(Q) * qScale });
  };
  for (let b = 1; b <= 32; b++) take(LAYERS.MODE, b);
  for (let b = 1; b <= 10; b++) take(LAYERS.APP, b);
  return { filters, unknown };
}

const at = (v, i) => (typeof v === 'number' ? v : v[i]);

/**
 * Gains for peaking filters at `centers` (fixed Q) whose band-averaged response matches `desired`.
 * Jacobi iteration: each band nudges its own gain by the error in its own band. Bands that are not free,
 * or whose desired value is NaN, stay at 0. Result rounded to the device's 0.1 dB step.
 */
export function fitGains({ desired, centers = TUNE_F, q, free, lo = -12, hi = 12, iterations = 80, step = 0.6, fs = FS } = {}) {
  const n = centers.length;
  const active = Array.from({ length: n }, (_, i) => (free ? free[i] : true) && Number.isFinite(desired[i]));
  const g = new Float64Array(n);
  for (let i = 0; i < n; i++) if (active[i]) g[i] = clamp(desired[i], at(lo, i), at(hi, i));
  const filt = () => centers.map((f, i) => ({ f, g: g[i], q }));
  for (let it = 0; it < iterations; it++) {
    const resp = bandAvgResponse(filt(), centers, { fs });
    let moved = 0;
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      const next = clamp(g[i] + step * (desired[i] - resp[i]), at(lo, i), at(hi, i));
      moved = Math.max(moved, Math.abs(next - g[i]));
      g[i] = next;
    }
    if (moved < 0.005) break;
  }
  return Float64Array.from(g, (v) => Math.round(v * 10) / 10 || 0);
}
