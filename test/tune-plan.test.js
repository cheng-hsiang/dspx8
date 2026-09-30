import { test } from 'node:test';
import assert from 'node:assert/strict';
import { targetCurve, planCorrection, tuneWritePairs, judgeQ, eqSignature, qRawFor, rmsToTarget, TUNE_Q } from '../js/tune/plan.js';
import { bandAvgResponse, filtersFromStore } from '../js/tune/fit.js';
import { simBands, SIM_ROOM } from '../js/tune/sim-room.js';
import { TUNE_F, midLevel } from '../js/tune/bands.js';
import { RegisterStore } from '../js/core/store.js';
import { FakeDevice } from '../js/transport/fake-device.js';
import { eqAddr, ADDR } from '../js/protocol/addrmap.js';
import { QRATE, encodeGain } from '../js/protocol/codec.js';

const T = targetCurve({ bassDb: 6, trebleDb: -2 });
const flat = () => new Float64Array(31);
function rig() {
  const dev = new FakeDevice();
  const store = new RegisterStore();
  store.setMany(Array.from({ length: store.size }, (_, addr) => ({ addr, val: dev.regs[addr] })));
  const set = (addr, val) => { dev.regs[addr] = val; store.set(addr, val); };
  const solo = (group) => { for (const ch of [1, 2, 3, 4]) set(ADDR.muteOfChannel(ch), (group === 'front') === (ch <= 2) ? 0 : 1); };
  const physics = { get: (a) => dev.regs[a] };
  return { dev, store, set, solo, physics };
}
const eqOldOf = (store, ch, scale = QRATE) => bandAvgResponse(filtersFromStore(store, ch, scale).filters);

test('targetCurve: bass shelf below ~90 Hz, flat mids, treble tilt reaching trebleDb at 16 kHz', () => {
  assert.ok(Math.abs(T[17]) < 0.1, `1 kHz ${T[17]}`);
  assert.ok(Math.abs(T[13]) < 0.25, `405 Hz ${T[13]}`);
  assert.ok(T[3] > 4.5 && T[3] <= 6, `40 Hz ${T[3]}`);
  assert.ok(Math.abs(T[29] + 2) < 0.01 && Math.abs(T[30] + 2) < 0.01);
  for (let i = 1; i < 12; i++) assert.ok(T[i] <= T[i - 1] + 1e-9, 'bass shelf falls monotonically');
  assert.ok(targetCurve({ bassDb: 0, trebleDb: 0 }).every((v) => v === 0));
});

test('planCorrection on a flat car with flat EQ: gains follow the target shape inside the allowed range', () => {
  const p = planCorrection({ measured: flat(), eqOld: flat(), target: T, group: 'front' });
  for (const i of [0, 1, 2, 30]) { assert.equal(p.gains[i], 0, `band ${i} is excluded`); assert.ok(p.notes[i]); }
  for (const i of [3, 4, 5]) { assert.ok(p.gains[i] <= 0, 'cut-only up to the 63 Hz band'); assert.equal(p.notes[i], 'low-cut'); }
  // from 80 Hz up the predicted result follows the target shape
  const pn = Array.from(p.predicted.slice(6, 30)), tn = Array.from(T.slice(6, 30));
  const off = pn.reduce((a, v, i) => a + v - tn[i], 0) / pn.length;
  pn.forEach((v, i) => assert.ok(Math.abs(v - off - tn[i]) < 1, `band ${i + 6}: ${(v - off).toFixed(2)} vs ${tn[i].toFixed(2)}`));
  assert.ok(p.gains[29] < -1, `16 kHz ${p.gains[29]}`);
  assert.equal(p.strength, 1);
});

test('planCorrection cuts a room peak, keeps the mid level and never boosts into a narrow dip', () => {
  const m = flat(); m[8] = 6; m[15] = -9;
  const p = planCorrection({ measured: m, eqOld: flat(), target: targetCurve({ bassDb: 0, trebleDb: 0 }), group: 'front' });
  assert.ok(p.gains[8] < -4, `125 Hz ${p.gains[8]}`);
  assert.ok(p.gains[15] <= 0, `630 Hz dip ${p.gains[15]}`);
  assert.equal(p.notes[15], 'dip');
  assert.ok(Math.abs(midLevel(Array.from(p.gains))) < 1.2, 'shape, not level');
});

test('planCorrection accounts for the EQ already in place (the measurement includes it)', () => {
  const room = SIM_ROOM.front;
  const old = bandAvgResponse([{ f: 50, g: 3, q: 1.2 }, { f: 160, g: -3, q: 1.49 }, { f: 2500, g: 1.5, q: 1.49 }]);
  const a = planCorrection({ measured: Float64Array.from(room), eqOld: flat(), target: T, group: 'front' });
  const b = planCorrection({ measured: Float64Array.from(room, (r, i) => r + old[i]), eqOld: old, target: T, group: 'front' });
  for (let i = 0; i < 31; i++) assert.ok(Math.abs(a.gains[i] - b.gains[i]) < 0.25, `band ${i}: ${a.gains[i]} vs ${b.gains[i]}`);
});

test('half strength (Q not verified yet) moves about halfway from the current EQ', () => {
  const m = flat(); m[11] = 6;
  const full = planCorrection({ measured: m, eqOld: flat(), target: targetCurve({ bassDb: 0, trebleDb: 0 }), group: 'front' });
  const half = planCorrection({ measured: m, eqOld: flat(), target: targetCurve({ bassDb: 0, trebleDb: 0 }), group: 'front', strength: 0.5 });
  assert.equal(half.strength, 0.5);
  assert.ok(Math.abs(half.gains[11] - full.gains[11] / 2) < 0.6, `${half.gains[11]} vs ${full.gains[11]}`);
});

test('rear group: cut-only above 5 kHz, trimmed to 3 dB under the front, low-SNR bands left alone', () => {
  const rear = Float64Array.from(SIM_ROOM.rear);
  const ambient = new Float64Array(31).fill(-60); ambient[26] = rear[26] - 4;
  const p = planCorrection({ measured: rear, eqOld: flat(), target: T, group: 'rear', frontMid: 0, ambient });
  for (let i = 0; i < 31; i++) if (TUNE_F[i] > 5000) assert.ok(p.gains[i] <= 0, `band ${i} ${p.gains[i]}`);
  assert.ok(p.trimDb < -2.5, `trim ${p.trimDb}`);
  assert.ok(midLevel(Array.from(p.gains)) < -1.5, 'the trim shows up as an overall cut');
  assert.equal(p.gains[26], 0); assert.equal(p.notes[26], 'snr');
  const noFront = planCorrection({ measured: rear, eqOld: flat(), target: T, group: 'rear' });
  assert.equal(noFront.trimDb, 0);
});

test('tuneWritePairs: factory F, fixed Q raw, gains; only changed fields; flattens the 10-band layer; skips disabled bands', () => {
  const { store, set } = rig();
  const gains = new Float64Array(31); gains[8] = -6;
  const q = qRawFor(TUNE_Q, QRATE);
  assert.equal(q, 136);
  let r = tuneWritePairs({ gains, channels: [1, 2], store, qRaw: q });
  assert.equal(r.pairs.length, 64, 'Q on 62 bands (factory 240 → 136) + G on band 9 of both channels');
  assert.ok(r.pairs.some((p) => p.addr === eqAddr(1, 9, 'G') && p.val === encodeGain(-6)));
  assert.equal(r.appFlattened, 0);
  set(eqAddr(1, 3, 'F'), 33083); set(ADDR.iir100(2, 1, 2), 530); set(eqAddr(2, 4, 'TYPE'), 0);
  r = tuneWritePairs({ gains, channels: [1, 2], store, qRaw: q });
  assert.ok(r.pairs.some((p) => p.addr === eqAddr(1, 3, 'F') && p.val === 33093), 'F back to the factory 32.5 Hz');
  assert.ok(r.pairs.some((p) => p.addr === ADDR.iir100(2, 1, 2) && p.val === 500));
  assert.equal(r.appFlattened, 1);
  assert.deepEqual(r.skipped, [{ ch: 2, band: 4 }]);
  assert.ok(!r.pairs.some((p) => p.addr >= eqAddr(2, 4, 'TYPE') && p.addr <= eqAddr(2, 4, 'Q')));
});

test('eqSignature changes when the EQ of that channel changes, not when another channel does', () => {
  const { store, set } = rig();
  const s1 = eqSignature(store, 1);
  set(eqAddr(2, 5, 'G'), 520);
  assert.equal(eqSignature(store, 1), s1);
  set(eqAddr(1, 5, 'G'), 520);
  assert.notEqual(eqSignature(store, 1), s1);
});

function qTrial(physicsScale, boost = 9) {
  const { store, set, solo, physics } = rig();
  solo('front');
  const before = { qrate: filtersFromStore(store, 1, QRATE).filters, one: filtersFromStore(store, 1, 1).filters };
  const baseline = simBands({ store: physics, qScale: physicsScale });
  for (const ch of [1, 2]) { set(eqAddr(ch, 18, 'G'), encodeGain(boost)); set(eqAddr(ch, 18, 'Q'), 136); }
  const after = { qrate: filtersFromStore(store, 1, QRATE).filters, one: filtersFromStore(store, 1, 1).filters };
  const boosted = simBands({ store: physics, qScale: physicsScale });
  return judgeQ({ baseline, boosted, before, after });
}

test('judgeQ picks the Q convention that matches what the car actually did', () => {
  const a = qTrial(QRATE);
  assert.equal(a.verdict, 'qrate', JSON.stringify(a.err));
  assert.ok(a.centreDelta > 6);
  assert.equal(qTrial(1).verdict, 'one');
  assert.equal(qTrial(QRATE, 0).verdict, 'unclear', 'no change at 1 kHz → no verdict');
});

test('closed loop in the simulated car: measure → apply → measure brings the front close to the target', () => {
  const { store, set, solo, physics } = rig();
  // leftovers of a bundled preset, like the real unit
  set(eqAddr(1, 5, 'F'), 33268); set(eqAddr(1, 5, 'G'), 530); set(eqAddr(1, 5, 'Q'), 38);
  set(eqAddr(2, 5, 'F'), 33268); set(eqAddr(2, 5, 'G'), 530); set(eqAddr(2, 5, 'Q'), 38);
  solo('front');
  const m1 = simBands({ store: physics, qScale: QRATE });
  const plan = planCorrection({ measured: m1, eqOld: eqOldOf(store, 1), target: T, group: 'front' });
  const { pairs } = tuneWritePairs({ gains: plan.gains, channels: [1, 2], store, qRaw: qRawFor(TUNE_Q, QRATE) });
  for (const p of pairs) set(p.addr, p.val);
  const m2 = simBands({ store: physics, qScale: QRATE });
  const r1 = rmsToTarget(m1, T), r2 = rmsToTarget(m2, T);
  assert.ok(r2 < 0.4 * r1 && r2 < 1.5, `before ${r1.toFixed(2)} after ${r2.toFixed(2)}`);
  assert.ok(Math.abs(plan.after - r2) < 0.5, `predicted ${plan.after.toFixed(2)} measured ${r2.toFixed(2)}`);
  // second pass from the corrected state stays put (no oscillation)
  const plan2 = planCorrection({ measured: m2, eqOld: eqOldOf(store, 1), target: T, group: 'front' });
  const diff = Array.from(plan2.gains, (g, i) => Math.abs(g - plan.gains[i]));
  assert.ok(Math.max(...diff.slice(3, 30)) < 1.0, diff.map((d) => d.toFixed(1)).join(' '));
});

test('rmsToTarget ignores level and only looks at 63 Hz – 10 kHz', () => {
  assert.ok(rmsToTarget(Float64Array.from(T, (v) => v + 5), T) < 1e-9);
  const off = Float64Array.from(T); off[0] += 20; off[30] += 20;
  assert.ok(rmsToTarget(off, T) < 1e-9);
});
