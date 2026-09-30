export const hi = (v) => (v >> 8) & 0xFF;
export const lo = (v) => v & 0xFF;
export const u16 = (h, l) => (((h & 0xFF) << 8) | (l & 0xFF)) >>> 0;
export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export const GAIN_MIN_DB = -12;
export const GAIN_MAX_DB = 12;
export const MASTER_VOL_OFFSET = 40;
export const MASTER_VOL_MAX = 60;
export const DELAY_MAX_US = 20000;
export const SAMPLE_RATE = 48000;
const SOUND_CM_PER_US = 0.0346; // 346 m/s

export const encodeGain = (db) => Math.round(db * 10) + 500;
export const decodeGain = (raw) => Math.round(raw - 500) / 10;

export const encodeFreq = (hz) => (hz < 100 ? (Math.round(hz * 10) | 0x8000) : Math.round(hz));
export const decodeFreq = (raw) => ((raw & 0x8000) ? (raw & 0x7FFF) / 10 : raw);

export const encodeQ = (q) => Math.round(q * 100);
export const decodeQ = (raw) => raw / 100;
/** OEM Q scaling: register = 100·Q / QRATE, so the factory raw 240 is Q 7.6 and a preset Q 1.0 is raw 32. */
export const QRATE = 7.6 / 2.4;
export const rawToQ = (raw) => (raw * QRATE) / 100;
export const qToRaw = (q) => Math.round((q * 100) / QRATE);
export const describeQ = (raw) => String(Math.round(rawToQ(raw) * 100) / 100);

export const encodeVol = (vol, flag) => vol + (flag ? 500 : 0);
export const decodeVol = (raw) => (raw >= 500 ? { vol: raw - 500, flag: true } : { vol: raw, flag: false });

export const encodeMasterVol = (knob) => encodeVol(clamp(Math.round(knob), 0, MASTER_VOL_MAX) + MASTER_VOL_OFFSET, true);
export const decodeMasterVol = (raw) => clamp(decodeVol(raw).vol - MASTER_VOL_OFFSET, 0, MASTER_VOL_MAX);

export const msToDelayRaw = (ms) => clamp(Math.round(ms * 1000), 0, DELAY_MAX_US);
export const delayRawToMs = (raw) => raw / 1000;
export const delayRawToCm = (raw) => Math.round(raw * SOUND_CM_PER_US * 100) / 100;
export const cmToDelayRaw = (cm) => clamp(Math.round(cm / SOUND_CM_PER_US), 0, DELAY_MAX_US);
export const samplesToDelayRaw = (n) => clamp(Math.round((n * 1e6) / SAMPLE_RATE), 0, DELAY_MAX_US);
export const delayRawToSamples = (raw) => Math.round((raw * SAMPLE_RATE) / 1e6);
