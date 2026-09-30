// Audio EQ Cookbook peaking EQ (RBJ). All maths in the digital domain at the DSP's 48 kHz sample rate.
export function peakingCoeffs(f0, gainDb, q, fs = 48000) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / fs;
  const alpha = Math.sin(w0) / (2 * q);
  const cos = Math.cos(w0);
  return { b0: 1 + alpha * A, b1: -2 * cos, b2: 1 - alpha * A, a0: 1 + alpha / A, a1: -2 * cos, a2: 1 - alpha / A };
}

export function magnitudeDb({ b0, b1, b2, a0, a1, a2 }, f, fs = 48000) {
  const w = (2 * Math.PI * f) / fs;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
  const dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

/** Composite response of enabled, non-flat bands at each frequency. */
export function responseDb(bands, freqs, fs = 48000) {
  const coeffs = bands.filter((b) => b.enabled !== false && b.g !== 0 && b.f > 0 && b.q > 0).map((b) => peakingCoeffs(b.f, b.g, b.q, fs));
  return freqs.map((f) => coeffs.reduce((sum, c) => sum + magnitudeDb(c, f, fs), 0));
}

export function logFreqAxis(n = 200, fMin = 20, fMax = 20000) {
  const r = Math.log(fMax / fMin);
  return Array.from({ length: n }, (_, i) => fMin * Math.exp((r * i) / (n - 1)));
}
