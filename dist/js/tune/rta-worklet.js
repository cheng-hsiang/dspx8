// The real-time part of the analyser. This file is loaded twice: as an ordinary module (tests, and the
// ScriptProcessor fallback on the main thread) and as the AudioWorklet module, where it must stand alone,
// so it imports nothing. The filter coefficients are designed in iec.js and passed in.

const TAU_FAST = 0.125, TAU_SLOW = 1; // IEC 61672-1 time weightings F and S, seconds
const TINY = 1e-30;

/**
 * A bank of band-pass filters (biquad cascades, [b0, b1, b2, a1, a2] per section) followed, per band, by a
 * squarer and three averagers: exponential F and S, and a linear sum for the equivalent level (Leq).
 * All values are mean squares of the sample values; the caller converts to decibels.
 */
export class BandBank {
  constructor({ sampleRate, sos }) {
    const n = sos.length;
    this.sampleRate = sampleRate;
    this.sos = sos;
    this.state = sos.map((c) => (c ? new Float64Array((c.length / 5) * 2) : null));
    this.sum = new Float64Array(n);
    this.fast = new Float64Array(n);
    this.slow = new Float64Array(n);
    this.aF = 1 - Math.exp(-1 / (TAU_FAST * sampleRate));
    this.aS = 1 - Math.exp(-1 / (TAU_SLOW * sampleRate));
    this.count = 0; this.sq = 0; this.peak = 0;
    this.buf = new Float64Array(128);
  }

  /** One block of mono samples (any length). */
  process(x) {
    const len = x.length;
    if (!len) return;
    if (this.buf.length < len) this.buf = new Float64Array(len);
    const buf = this.buf, aF = this.aF, aS = this.aS;
    let sq = 0, peak = this.peak;
    for (let i = 0; i < len; i++) { const v = x[i]; sq += v * v; const a = v < 0 ? -v : v; if (a > peak) peak = a; }
    this.sq += sq; this.peak = peak; this.count += len;
    for (let b = 0; b < this.sos.length; b++) {
      const c = this.sos[b];
      if (!c) continue;
      const st = this.state[b];
      for (let i = 0; i < len; i++) buf[i] = x[i];
      for (let s = 0, k = 0; k < c.length; s += 2, k += 5) {
        const b0 = c[k], b1 = c[k + 1], b2 = c[k + 2], a1 = c[k + 3], a2 = c[k + 4];
        let z1 = st[s], z2 = st[s + 1];
        for (let i = 0; i < len; i++) { // transposed direct form II
          const xi = buf[i], y = b0 * xi + z1;
          z1 = b1 * xi - a1 * y + z2;
          z2 = b2 * xi - a2 * y;
          buf[i] = y;
        }
        // after a long silence the state decays into denormal numbers, which are very slow: flush them
        st[s] = z1 > TINY || z1 < -TINY ? z1 : 0;
        st[s + 1] = z2 > TINY || z2 < -TINY ? z2 : 0;
      }
      let sum = this.sum[b], f = this.fast[b], sl = this.slow[b];
      for (let i = 0; i < len; i++) { const p = buf[i] * buf[i]; sum += p; f += aF * (p - f); sl += aS * (p - sl); }
      this.sum[b] = sum; this.fast[b] = f > TINY ? f : 0; this.slow[b] = sl > TINY ? sl : 0;
    }
  }

  /**
   * Everything since the previous snapshot: leq (mean square per band over those n samples), the current F and
   * S averages, broadband mean square and peak. Restarts the Leq interval; F and S keep running.
   */
  snapshot() {
    const n = this.count, d = n || 1;
    const out = { n, leq: Float64Array.from(this.sum, (v) => v / d), fast: Float64Array.from(this.fast), slow: Float64Array.from(this.slow), ms: this.sq / d, peak: this.peak };
    this.sum.fill(0); this.count = 0; this.sq = 0; this.peak = 0;
    return out;
  }
}

if (typeof registerProcessor === 'function') {
  registerProcessor('rta-bank', class extends AudioWorkletProcessor {
    constructor(options) {
      super();
      const o = options.processorOptions;
      this.bank = new BandBank(o);
      this.frameSamples = o.frameSamples;
      this.stopped = false;
      this.port.onmessage = (e) => { if (e.data === 'stop') this.stopped = true; };
    }

    process(inputs) {
      if (this.stopped) return false;
      const x = inputs[0] && inputs[0][0];
      if (x) {
        this.bank.process(x);
        if (this.bank.count >= this.frameSamples) {
          const s = this.bank.snapshot();
          this.port.postMessage(s, [s.leq.buffer, s.fast.buffer, s.slow.buffer]);
        }
      }
      return true;
    }
  });
}
