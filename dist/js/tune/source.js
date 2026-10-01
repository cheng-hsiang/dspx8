import { BandWeighter, dbfs } from './bands.js';
import { designBank } from './iec.js';
import { BandBank } from './rta-worklet.js';
import { simBands } from './sim-room.js';
import { mulberry32 } from './noise.js';
import { errText } from '../util/errors.js';

/** What this browser offers for recording. Logged at start-up so every pasted log answers "can Bluefy record?". */
export function micSupport(nav = globalThis.navigator, win = globalThis) {
  return {
    mediaDevices: Boolean(nav?.mediaDevices),
    getUserMedia: typeof nav?.mediaDevices?.getUserMedia === 'function',
    audioContext: Boolean(win?.AudioContext || win?.webkitAudioContext),
    audioWorklet: typeof win?.AudioWorkletNode === 'function',
    secure: Boolean(win?.isSecureContext),
  };
}

/** One message from the filter bank (mean squares) → one frame in dBFS. */
export function frameFromSnapshot(s, sampleRate) {
  return {
    bands: Float64Array.from(s.leq, dbfs), fast: Float64Array.from(s.fast, dbfs), slow: Float64Array.from(s.slow, dbfs),
    levelDb: dbfs(s.ms), peakDb: s.peak > 0 ? 20 * Math.log10(s.peak) : -200, sec: s.n / sampleRate,
  };
}

/**
 * The phone microphone through an IEC 61260-1 class 1 1/3-octave filter bank (iec.js), running sample by
 * sample in an AudioWorklet (or, on browsers without one, a ScriptProcessor). Voice processing is switched
 * off (echo cancellation, noise suppression and automatic gain would all bend the response); the browser
 * reports what it actually did.
 * Frames, every 0.1 s: { bands: Leq of the frame, fast, slow: time-weighted levels, levelDb, peakDb, sec };
 * levels in dBFS (AES17). Power-averaging `bands` over frames gives the Leq of the whole period.
 */
export class MicSource {
  constructor() { Object.assign(this, { kind: 'mic', info: null, onFrame: null, onState: null }); }

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
      const fs = this.ctx.sampleRate;
      const bank = designBank(fs);
      const frameSamples = Math.max(128, Math.round((fs * 0.1) / 128) * 128);
      const options = { sampleRate: fs, sos: bank.bands.map((b) => b.sos), frameSamples };
      const emit = (snap) => this.onFrame?.(frameFromSnapshot(snap, fs));
      let capture = 'AudioWorklet', captureNote = '';
      try {
        if (!this.ctx.audioWorklet || typeof AudioWorkletNode !== 'function') throw new Error('沒有 AudioWorklet');
        await this.ctx.audioWorklet.addModule(new URL('./rta-worklet.js', import.meta.url).href);
        this.node = new AudioWorkletNode(this.ctx, 'rta-bank', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit', processorOptions: options });
        this.node.port.onmessage = (e) => emit(e.data);
      } catch (err) {
        capture = 'ScriptProcessor'; captureNote = errText(err);
        const local = new BandBank(options);
        this.node = this.ctx.createScriptProcessor(4096, 1, 1);
        this.node.onaudioprocess = (e) => { local.process(e.inputBuffer.getChannelData(0)); if (local.count >= frameSamples) emit(local.snapshot()); };
      }
      this.src = this.ctx.createMediaStreamSource(this.stream);
      // the graph only runs when it ends in the destination; a zero gain keeps the speaker silent
      this.sink = this.ctx.createGain(); this.sink.gain.value = 0;
      this.src.connect(this.node); this.node.connect(this.sink); this.sink.connect(this.ctx.destination);
      this.ctx.onstatechange = () => this.onState?.(this.ctx?.state);
      this.info = {
        kind: 'mic', sampleRate: fs, capture, captureNote, label: track?.label || '', bandOk: bank.bands.map((b) => b.ok),
        settings: { echoCancellation: s.echoCancellation, noiseSuppression: s.noiseSuppression, autoGainControl: s.autoGainControl, sampleRate: s.sampleRate, channelCount: s.channelCount },
      };
      return this.info;
    } catch (err) { await this.close(); throw err; }
  }

  start(onFrame) { this.onFrame = onFrame; }
  stop() { this.onFrame = null; }

  async close() {
    this.stop();
    try { this.node?.port?.postMessage('stop'); } catch { /* ignore */ }
    try { if (this.node) this.node.onaudioprocess = null; this.src?.disconnect(); this.node?.disconnect(); } catch { /* ignore */ }
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    try { if (this.ctx) this.ctx.onstatechange = null; await this.ctx?.close(); } catch { /* ignore */ }
    this.ctx = null; this.stream = null; this.node = null; this.src = null;
  }
}

const SIM_DBFS = -40;

/** ?sim=1: the made-up car, reading the fake device's registers so EQ and mute changes are "heard". */
export class SimSource {
  constructor({ regs, qScale, frameMs = 100, jitterDb = 0.35, seed = 7 }) {
    Object.assign(this, { regs, qScale, frameMs, jitterDb, kind: 'sim', info: null, timer: null, ambient: false });
    this.rng = mulberry32(seed);
  }

  async open() {
    this.info = { kind: 'sim', sampleRate: 48000, capture: '模擬', captureNote: '', label: '模擬車廂', bandOk: new Array(31).fill(true), settings: {} };
    return this.info;
  }

  start(onFrame) {
    this.stop();
    const store = { get: (a) => this.regs[a] };
    const weighter = new BandWeighter(31, this.frameMs / 1000);
    this.timer = setInterval(() => {
      // the made-up car works in relative decibels; shift it to where a phone would sit in dBFS
      const bands = simBands({ store, qScale: this.qScale, rng: this.rng, jitterDb: this.jitterDb, noise: !this.ambient }).map((v) => v + SIM_DBFS);
      const total = 10 * Math.log10(bands.reduce((s, b) => s + 10 ** (b / 10), 0));
      const { fast, slow } = weighter.push(bands);
      onFrame({ bands, fast, slow, levelDb: total, peakDb: total + 12, sec: this.frameMs / 1000 });
    }, this.frameMs);
  }

  stop() { clearInterval(this.timer); this.timer = null; }
  async close() { this.stop(); }
}
