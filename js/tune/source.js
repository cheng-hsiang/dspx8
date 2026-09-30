import { spectrumToBands, TUNE_F } from './bands.js';
import { simBands } from './sim-room.js';
import { mulberry32 } from './noise.js';

/** What this browser offers for recording. Logged at start-up so every pasted log answers "can Bluefy record?". */
export function micSupport(nav = globalThis.navigator, win = globalThis) {
  return {
    mediaDevices: Boolean(nav?.mediaDevices),
    getUserMedia: typeof nav?.mediaDevices?.getUserMedia === 'function',
    audioContext: Boolean(win?.AudioContext || win?.webkitAudioContext),
    secure: Boolean(win?.isSecureContext),
  };
}

const levelOf = (buf) => { let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]; return s > 0 ? 10 * Math.log10(s / buf.length) : -120; };

/**
 * The phone microphone through an AnalyserNode. Voice processing is switched off (echo cancellation, noise
 * suppression and automatic gain would all bend the response); the browser reports what it actually did.
 * Frames: { bands: 31 × dB, levelDb: dBFS RMS } every frameMs.
 */
export class MicSource {
  constructor({ fftSize = 32768, frameMs = 100 } = {}) { Object.assign(this, { fftSize, frameMs, kind: 'mic', info: null, timer: null }); }

  /** Call from a click handler: the AudioContext is created and resumed before the first await (iOS rule). */
  async open() {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) throw new Error('此瀏覽器沒有 Web Audio');
    if (typeof navigator.mediaDevices?.getUserMedia !== 'function') throw new Error('此瀏覽器不提供麥克風（沒有 getUserMedia）');
    this.ctx = new AC();
    const resumed = this.ctx.resume?.();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
      await resumed; await this.ctx.resume?.();
      const track = this.stream.getAudioTracks()[0];
      const s = track?.getSettings?.() ?? {};
      this.src = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      try { this.analyser.fftSize = this.fftSize; } catch { this.analyser.fftSize = 16384; }
      this.analyser.smoothingTimeConstant = 0;
      // some engines only run an analyser that is pulled by the destination; a zero gain keeps the speaker silent
      this.sink = this.ctx.createGain(); this.sink.gain.value = 0;
      this.src.connect(this.analyser); this.analyser.connect(this.sink); this.sink.connect(this.ctx.destination);
      this.freq = new Float32Array(this.analyser.frequencyBinCount);
      this.time = new Float32Array(Math.min(4096, this.analyser.fftSize));
      this.info = {
        kind: 'mic', sampleRate: this.ctx.sampleRate, fftSize: this.analyser.fftSize, label: track?.label || '',
        settings: { echoCancellation: s.echoCancellation, noiseSuppression: s.noiseSuppression, autoGainControl: s.autoGainControl, sampleRate: s.sampleRate, channelCount: s.channelCount },
      };
      return this.info;
    } catch (err) { await this.close(); throw err; }
  }

  start(onFrame) {
    this.stop();
    this.timer = setInterval(() => {
      if (!this.analyser) return;
      this.analyser.getFloatFrequencyData(this.freq);
      this.analyser.getFloatTimeDomainData(this.time);
      onFrame({ bands: spectrumToBands(this.freq, this.ctx.sampleRate, this.analyser.fftSize, TUNE_F), levelDb: levelOf(this.time) });
    }, this.frameMs);
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  async close() {
    this.stop();
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    try { await this.ctx?.close(); } catch { /* ignore */ }
    this.ctx = null; this.stream = null; this.analyser = null;
  }
}

/** ?sim=1: the made-up car, reading the fake device's registers so EQ and mute changes are "heard". */
export class SimSource {
  constructor({ regs, qScale, frameMs = 100, jitterDb = 0.35, seed = 7 }) {
    Object.assign(this, { regs, qScale, frameMs, jitterDb, kind: 'sim', info: null, timer: null, ambient: false });
    this.rng = mulberry32(seed);
  }

  async open() {
    this.info = { kind: 'sim', sampleRate: 48000, fftSize: 32768, label: '模擬車廂', settings: {} };
    return this.info;
  }

  start(onFrame) {
    this.stop();
    const store = { get: (a) => this.regs[a] };
    this.timer = setInterval(() => {
      const bands = simBands({ store, qScale: this.qScale, rng: this.rng, jitterDb: this.jitterDb, noise: !this.ambient });
      const total = 10 * Math.log10(bands.reduce((s, b) => s + 10 ** (b / 10), 0));
      onFrame({ bands, levelDb: total - 36 });
    }, this.frameMs);
  }

  stop() { clearInterval(this.timer); this.timer = null; }
  async close() { this.stop(); }
}
