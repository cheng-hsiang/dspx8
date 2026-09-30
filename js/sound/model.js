import { ADDR, CH_COUNT } from '../protocol/addrmap.js';
import { decodeVol, encodeVol, encodeMasterVol, clamp, delayRawToMs, delayRawToCm, delayRawToSamples, samplesToDelayRaw, cmToDelayRaw, MASTER_VOL_OFFSET, MASTER_VOL_MAX } from '../protocol/codec.js';
import { INPUT } from '../protocol/tables.js';

export const LEVEL_MAX = 100;
export const DELAY_MAX_SAMPLES = 960; // 20 ms at 48 kHz, the OEM slider range
export const DELAY_MAX_CM = 692;      // 20000 µs × 0.0346 cm/µs

/**
 * One output channel as the sound page shows it. Phase rides on the +500 flag of input 1's routing gain:
 * the OEM app writes VolToNum(inverted, vol), which adds 500 only when NOT inverted, so flag set = 0°.
 */
export function readChannel(store, ch) {
  const delayRaw = store.get(ADDR.delay(ch));
  return {
    ch,
    muted: store.get(ADDR.muteOfChannel(ch)) === 1,
    inverted: !decodeVol(store.get(ADDR.phaseOfChannel(ch))).flag,
    level: decodeVol(store.get(ADDR.mix11(ch))).vol,
    delayRaw,
    delayMs: delayRawToMs(delayRaw),
    delayCm: delayRawToCm(delayRaw),
    samples: delayRawToSamples(delayRaw),
  };
}

export function phasePair(store, ch, inverted) {
  const { vol } = decodeVol(store.get(ADDR.phaseOfChannel(ch)));
  return { addr: ADDR.phaseOfChannel(ch), val: encodeVol(vol, !inverted) };
}

export function levelPair(store, ch, level) {
  const { flag } = decodeVol(store.get(ADDR.mix11(ch)));
  return { addr: ADDR.mix11(ch), val: encodeVol(clamp(Math.round(level), 0, LEVEL_MAX), flag) };
}

const levels = (store) => Array.from({ length: CH_COUNT }, (_, i) => decodeVol(store.get(ADDR.mix11(i + 1))));

/** The master knob (0..60) is the loudest channel's level minus the OEM offset of 40. */
export function masterKnob(store) {
  return clamp(Math.max(...levels(store).map((v) => v.vol)) - MASTER_VOL_OFFSET, 0, MASTER_VOL_MAX);
}

/** Move every channel by the same amount so per-channel offsets survive a master change; each flag is kept as is. */
export function masterPairs(store, knob) {
  const cur = levels(store);
  const delta = decodeVol(encodeMasterVol(knob)).vol - Math.max(...cur.map((v) => v.vol));
  return cur.map((v, i) => ({ addr: ADDR.mix11(i + 1), val: encodeVol(clamp(v.vol + delta, 0, LEVEL_MAX), v.flag) }));
}

export const delayPairFromCm = (ch, cm) => ({ addr: ADDR.delay(ch), val: cmToDelayRaw(cm) });
export const delayPairFromSamples = (ch, n) => ({ addr: ADDR.delay(ch), val: samplesToDelayRaw(clamp(Math.round(n), 0, DELAY_MAX_SAMPLES)) });

export function inputPair(input) {
  if (!Object.values(INPUT).includes(input)) throw new RangeError(`input ${input}`);
  return { addr: ADDR.M0_INPUT_SET, val: input };
}

/** The device reports the active input in the low nibble of M0_22 (the real unit sets an unknown high bit too). */
export const currentInput = (store) => store.get(ADDR.M0_INPUT_CUR) & 0x0F;
