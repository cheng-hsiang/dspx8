import { ADDR } from '../protocol/addrmap.js';
import { QRATE } from '../protocol/codec.js';
import { filtersFromStore, bandAvgResponse } from './fit.js';

// A made-up car for ?sim=1 and the tests: band levels (dB, 31 bands) at the driver's head with pink noise and
// a flat EQ. Front has cabin gain, a 125 Hz boom, a 405 Hz hole and a 2.5 kHz bump; the rear doors have no
// tweeters, a narrow 630 Hz cancellation and play 3 dB louder than they should.
const FRONT = [4, 7, 9, 10, 10, 9, 8, 7, 9, 6, 3, 2, 0, -4, -1, 0, 1, 0, -1, 0, 2, 4, 3, 1, -1, -3, -2, -3, -5, -8, -14];
const REAR = [-8, -5, -2, 1, 3, 4, 5, 6, 7, 8, 6, 3, 1, 0, -1, -9, 1, 0, -1, -2, -3, -4, -6, -8, -10, -12, -14, -16, -18, -20, -24];
const FLOOR = [-5, -8, -12, -16, -20, -24, -28, -32, -35, -38, -40, -42, -44, ...Array(18).fill(-45)];

export const SIM_ROOM = Object.freeze({
  front: Object.freeze(FRONT),
  rear: Object.freeze(REAR.map((v) => v + 3)),
  floor: Object.freeze(FLOOR),
});

export function gaussian(rng) {
  const u = Math.max(1e-12, rng()), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * What a phone at the driver's head would read, per band. `store` needs get(addr) (the fake device's
 * registers are the "physics"). A group plays when any of its channels is unmuted, through the EQ of its
 * first channel. noise=false simulates the pink noise being stopped (background only).
 */
export function simBands({ store, qScale = QRATE, groups = { front: [1, 2], rear: [3, 4] }, rng = null, jitterDb = 0, noise = true }) {
  const n = SIM_ROOM.front.length;
  const power = Float64Array.from(SIM_ROOM.floor, (v) => 10 ** (v / 10));
  if (noise) {
    for (const [g, chs] of Object.entries(groups)) {
      if (!SIM_ROOM[g] || !chs.some((ch) => store.get(ADDR.muteOfChannel(ch)) === 0)) continue;
      const eq = bandAvgResponse(filtersFromStore(store, chs[0], qScale).filters);
      for (let i = 0; i < n; i++) power[i] += 10 ** ((SIM_ROOM[g][i] + eq[i]) / 10);
    }
  }
  return Float64Array.from(power, (p, i) => 10 * Math.log10(p) + (rng && jitterDb ? gaussian(rng) * jitterDb * (i < 5 ? 3 : 1) : 0));
}
