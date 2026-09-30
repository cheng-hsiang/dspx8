import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bandAvgResponse, fitGains, filtersFromStore } from '../js/tune/fit.js';
import { TUNE_F } from '../js/tune/bands.js';
import { RegisterStore } from '../js/core/store.js';
import { FakeDevice } from '../js/transport/fake-device.js';
import { eqAddr, ADDR } from '../js/protocol/addrmap.js';
import { QRATE } from '../js/protocol/codec.js';

const filtersFor = (gains, q = 4.3) => TUNE_F.map((f, i) => ({ f, g: gains[i], q }));
function seeded() {
  const d = new FakeDevice();
  const s = new RegisterStore();
  s.setMany(Array.from({ length: s.size }, (_, addr) => ({ addr, val: d.regs[addr] })));
  return s;
}

test('band-averaged response of one peaking filter: close to its gain in its own band, ~0 far away', () => {
  const r = bandAvgResponse([{ f: 1000, g: 6, q: 4.3 }]);
  assert.ok(r[17] > 4 && r[17] < 6, `centre ${r[17]}`);
  assert.ok(r[16] > 0.8 && r[18] > 0.8, 'neighbours pick up part of it');
  assert.ok(Math.abs(r[10]) < 0.1 && Math.abs(r[27]) < 0.1);
  assert.ok(bandAvgResponse([]).every((v) => v === 0));
  assert.ok(bandAvgResponse([{ f: 1000, g: 6, q: 0 }]).every((v) => v === 0), 'invalid Q is ignored, never NaN');
});

test('a wide filter (Q 1.36) spreads much further than Q 4.3 — the basis of the Q check', () => {
  const narrow = bandAvgResponse([{ f: 1000, g: 9, q: 4.3 }]);
  const wide = bandAvgResponse([{ f: 1000, g: 9, q: 1.36 }]);
  assert.ok(wide[18] - narrow[18] > 3, `1.26 kHz: wide ${wide[18].toFixed(2)} narrow ${narrow[18].toFixed(2)}`);
});

test('fitGains reproduces an achievable curve, keeps fixed bands at 0 and respects per-band limits', () => {
  const truth = new Float64Array(31); truth[5] = -4; truth[11] = -6; truth[19] = 3;
  const desired = bandAvgResponse(filtersFor(truth));
  const free = Array(31).fill(true); free[0] = false; free[30] = false;
  const g = fitGains({ desired, q: 4.3, free, lo: -12, hi: 12 });
  const resp = bandAvgResponse(filtersFor(g));
  for (let i = 1; i < 30; i++) assert.ok(Math.abs(resp[i] - desired[i]) < 0.3, `band ${i}: ${resp[i].toFixed(2)} vs ${desired[i].toFixed(2)}`);
  assert.equal(g[0], 0); assert.equal(g[30], 0);
  const hi = Array(31).fill(12); hi[19] = 0;
  const capped = fitGains({ desired, q: 4.3, free, lo: -12, hi });
  assert.ok(capped[19] <= 0);
  assert.ok(Array.from(capped).every((v) => Math.abs(v * 10 - Math.round(v * 10)) < 1e-9), 'rounded to the device 0.1 dB step');
});

test('fitGains leaves bands with no desired value (NaN) at 0', () => {
  const desired = new Float64Array(31).fill(NaN); desired[15] = -5;
  const g = fitGains({ desired, q: 4.3, free: Array(31).fill(true) });
  assert.ok(g[15] < -3);
  assert.equal(g[3], 0);
});

test('filtersFromStore reads both layers, TYPE 7 non-flat bands only, with the given Q scale', () => {
  const s = seeded();
  assert.deepEqual(filtersFromStore(s, 1, QRATE).filters, []);
  s.set(eqAddr(1, 3, 'G'), 530); s.set(eqAddr(1, 3, 'Q'), 136);
  s.set(ADDR.iir100(1, 1, 2), 470);
  const { filters, unknown } = filtersFromStore(s, 1, QRATE);
  assert.equal(unknown, 0);
  assert.equal(filters.length, 2);
  assert.equal(filters[0].f, 32.5); assert.equal(filters[0].g, 3); assert.ok(Math.abs(filters[0].q - 1.36 * QRATE) < 1e-9);
  assert.equal(filters[1].f, 60); assert.equal(filters[1].g, -3); assert.ok(Math.abs(filters[1].q - 1.19 * QRATE) < 1e-9);
  assert.equal(filtersFromStore(s, 1, 1).filters[0].q, 1.36);
  s.set(eqAddr(1, 4, 'TYPE'), 9); s.set(eqAddr(1, 4, 'G'), 520);
  assert.equal(filtersFromStore(s, 1, QRATE).unknown, 1, 'unknown filter types are counted, not modelled as peaking');
  assert.deepEqual(filtersFromStore(s, 2, QRATE).filters, []);
});
