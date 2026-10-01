import { THIRD_NOMINAL } from './iec.js';
import { MID_LO, MID_HI } from './bands.js';

/** With pink noise playing: bands this far below the mid level, all the way to the top, never reached the page. */
const DROP_DB = 40;
/** With only background sound (just after opening): be stricter, a quiet cabin has little treble anyway. */
const DROP_IDLE_DB = 60;

/**
 * The nominal frequency from which the spectrum is missing, or null. A phone browser may low-pass the
 * microphone (voice processing, a low capture rate); a loudspeaker or a real microphone rolls off far more
 * gently than this. Only an unbroken run of dead bands at the top counts.
 */
export function micLimitHz(bands, dropDb = DROP_DB, nominal = THIRD_NOMINAL) {
  const mid = [];
  nominal.forEach((f, i) => { if (f >= MID_LO && f <= MID_HI) mid.push(bands[i]); });
  mid.sort((a, b) => a - b);
  const ref = mid[mid.length >> 1];
  if (!(ref > -190)) return null;
  let i = nominal.length;
  while (i > 0 && bands[i - 1] < ref - dropDb) i--;
  return i < nominal.length ? nominal[i] : null;
}

/** First look at a freshly opened microphone: peak and band levels (dBFS) over a couple of seconds. */
export function micCheck({ peakDb, bands }) {
  const silent = !(peakDb > -200);
  return { silent, limitHz: silent ? null : micLimitHz(bands, DROP_IDLE_DB) };
}
