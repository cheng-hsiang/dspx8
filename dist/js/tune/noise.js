/** Small seeded PRNG so the downloadable file is the same every time. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pink noise (equal power per octave) via Paul Kellet's refined filter on white noise, scaled to rmsDb dBFS,
 * with short fades so a player looping the file does not click.
 */
export function pinkNoise(n, { seed = 1, sampleRate = 44100, rmsDb = -16, fadeMs = 50 } = {}) {
  const rng = mulberry32(seed);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  const step = () => {
    const w = rng() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    const y = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
    return y;
  };
  for (let i = 0; i < 4096; i++) step(); // settle the slow poles so the file does not start quiet
  const out = new Float32Array(n);
  let sq = 0;
  for (let i = 0; i < n; i++) { const y = step(); out[i] = y; sq += y * y; }
  const gain = n && sq ? 10 ** (rmsDb / 20) / Math.sqrt(sq / n) : 0;
  const fade = Math.min(Math.floor(n / 2), Math.round((fadeMs / 1000) * sampleRate));
  for (let i = 0; i < n; i++) {
    let v = out[i] * gain;
    if (fade > 0) { if (i < fade) v *= i / fade; else if (i >= n - fade) v *= (n - 1 - i) / fade; }
    out[i] = Math.max(-1, Math.min(1, v));
  }
  return out;
}

/** 16-bit mono PCM WAV. */
export function wavBytes(samples, sampleRate) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf), u8 = new Uint8Array(buf);
  const text = (o, s) => { for (let i = 0; i < s.length; i++) u8[o + i] = s.charCodeAt(i); };
  text(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); text(8, 'WAVE');
  text(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  text(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
  return u8;
}
