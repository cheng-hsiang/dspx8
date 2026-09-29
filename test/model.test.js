import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as m from '../js/eq/model.js';
import { RegisterStore } from '../js/core/store.js';
import { FakeDevice } from '../js/transport/fake-device.js';
import { eqAddr, isWritableAddr } from '../js/protocol/addrmap.js';
import { encodeFreq } from '../js/protocol/codec.js';

function seeded() {
  const d = new FakeDevice();
  const s = new RegisterStore();
  s.setMany(Array.from({ length: s.size }, (_, addr) => ({ addr, val: d.regs[addr] })));
  return s;
}

test('layers and addresses', () => {
  assert.equal(m.layerInfo(m.LAYERS.MODE).bands, 31);
  assert.equal(m.layerInfo(m.LAYERS.APP).bands, 10);
  assert.deepEqual(m.bandAddrs(m.LAYERS.MODE, 1, 3), { TYPE: 154, F: 155, G: 156, Q: 157 });
  assert.deepEqual(m.bandAddrs(m.LAYERS.APP, 1, 1), { TYPE: 1252, F: 1253, G: 1254, Q: 1255 });
  assert.equal(isWritableAddr(1253), true);
  assert.equal(isWritableAddr(1252), false);
  assert.equal(isWritableAddr(1571), true);
});

test('readBands decodes and flags disabled slots', () => {
  const s = seeded();
  const bands = m.readBands(s, { layer: m.LAYERS.MODE, ch: 1, qScale: 1 });
  assert.equal(bands.length, 31);
  assert.equal(bands[0].band, 1);
  assert.equal(bands[0].f, 20); assert.equal(bands[0].g, 0); assert.equal(bands[0].q, 4.32); assert.equal(bands[0].enabled, true);
  const all = m.readBands(s, { layer: m.LAYERS.MODE, ch: 1, qScale: 1, slots: 32 });
  assert.equal(all[31].enabled, false);
  const app = m.readBands(s, { layer: m.LAYERS.APP, ch: 1, qScale: m.QRATE });
  assert.equal(app.length, 10);
  assert.equal(app[0].f, 60); assert.equal(app[4].enabled, false);
  assert.ok(Math.abs(app[0].q - 0.38) < 0.01);
});

test('effectiveQScale: OEM layer is always QRATE unless forced to 1; mode layer follows inference with fallback 1', () => {
  assert.equal(m.effectiveQScale(m.LAYERS.APP, 'auto', null), m.QRATE);
  assert.equal(m.effectiveQScale(m.LAYERS.APP, 'auto', 1), m.QRATE);
  assert.equal(m.effectiveQScale(m.LAYERS.APP, 'qrate', 1), m.QRATE);
  assert.equal(m.effectiveQScale(m.LAYERS.APP, '1', null), 1);
  assert.equal(m.effectiveQScale(m.LAYERS.MODE, 'auto', null), 1);
  assert.equal(m.effectiveQScale(m.LAYERS.MODE, 'auto', m.QRATE), m.QRATE);
  assert.equal(m.effectiveQScale(m.LAYERS.MODE, 'qrate', null), m.QRATE);
  assert.equal(m.effectiveQScale(m.LAYERS.MODE, '1', m.QRATE), 1);
});

test('describeQScale labels the three states', () => {
  assert.equal(m.describeQScale(m.LAYERS.APP, 'auto', null), '原廠層 ×3.17（已知）');
  assert.equal(m.describeQScale(m.LAYERS.MODE, 'auto', null), '自動：未確認，暫用 1');
  assert.equal(m.describeQScale(m.LAYERS.MODE, 'auto', 1), '自動：1');
  assert.equal(m.describeQScale(m.LAYERS.MODE, 'auto', m.QRATE), '自動：×3.17');
  assert.equal(m.describeQScale(m.LAYERS.MODE, 'qrate', null), '手動：×3.17');
});

test('inferQScale maps the report verdicts to a scale or null', () => {
  const s = seeded();
  for (let ch = 1; ch <= 8; ch++) s.set(eqAddr(ch, 1, 'Q'), 100);
  assert.equal(m.inferQScale(s), 1);
  for (let ch = 1; ch <= 8; ch++) s.set(eqAddr(ch, 1, 'Q'), 32);
  assert.equal(m.inferQScale(s), m.QRATE);
  s.set(eqAddr(3, 1, 'Q'), 900);
  assert.equal(m.inferQScale(s), null);
});

test('encodeBand clamps to table range, clamps gain, applies qScale', () => {
  assert.deepEqual(m.encodeBand({ f: 1001, g: 15, q: 1.36 }, 1), { F: 1001, G: 620, Q: 136 });
  assert.deepEqual(m.encodeBand({ f: 60, g: -3, q: 0.4 }, m.QRATE), { F: encodeFreq(60), G: 470, Q: 13 });
  assert.equal(m.nearest([1, 2, 4, 8], 5), 4);
  assert.equal(m.nearest([1, 2, 4, 8], 100), 8);
  assert.equal(m.nearest([1, 2, 4, 8], -3), 1);
});

test('bandWritePairs writes only changed fields to every enabled channel of the group', () => {
  const s = seeded();
  const r = m.bandWritePairs(m.LAYERS.MODE, [1, 2], 3, { g: 6 }, 1, s);
  assert.deepEqual(r.pairs, [{ addr: eqAddr(1, 3, 'G'), val: 560 }, { addr: eqAddr(2, 3, 'G'), val: 560 }]);
  assert.deepEqual(r.skipped, []);
  s.set(eqAddr(2, 3, 'TYPE'), 0);
  const r2 = m.bandWritePairs(m.LAYERS.MODE, [1, 2], 3, { g: 6, f: 1250 }, 1, s);
  assert.deepEqual(r2.skipped, [2]);
  assert.deepEqual(r2.pairs.map((p) => p.addr), [eqAddr(1, 3, 'F'), eqAddr(1, 3, 'G')]);
  const same = m.bandWritePairs(m.LAYERS.MODE, [1], 3, { g: 0 }, 1, s);
  assert.deepEqual(same.pairs, []);
});

test('mapPresetToBands picks nearest unused enabled band; collisions go to the next nearest', () => {
  const s = seeded();
  const bands = m.readBands(s, { layer: m.LAYERS.MODE, ch: 1, qScale: 1 });
  const r = m.mapPresetToBands([{ f: 1000, g: 1, q: 1 }, { f: 1010, g: 2, q: 1 }, { f: 50, g: 3, q: 1 }], bands);
  assert.deepEqual(r.mapped.map((x) => x.band), [18, 19, 5]);
  assert.deepEqual(r.dropped, []);
  const tiny = bands.slice(0, 1);
  const r2 = m.mapPresetToBands([{ f: 20, g: 1, q: 1 }, { f: 25, g: 1, q: 1 }], tiny);
  assert.equal(r2.mapped.length, 1);
  assert.deepEqual(r2.dropped.map((d) => d.f), [25]);
});

test('presetWritePairs zeroes gains then applies, per group', () => {
  const s = seeded();
  const preset = { schema: 'dspx8s-preset/1', name: 't', channelGroups: { front: [1, 2], rear: [3, 4] }, eq: { front: [{ f: 50, g: 3, q: 1.2 }], rear: [] } };
  const r = m.presetWritePairs(preset, m.LAYERS.MODE, { front: [1, 2], rear: [3, 4] }, s, 1);
  const g50 = r.pairs.filter((p) => p.addr === eqAddr(1, 5, 'G'));
  assert.equal(g50.at(-1).val, 530);
  assert.ok(r.pairs.some((p) => p.addr === eqAddr(1, 5, 'F') && p.val === encodeFreq(50)));
  assert.ok(r.pairs.some((p) => p.addr === eqAddr(1, 5, 'Q') && p.val === 120));
  assert.ok(r.pairs.some((p) => p.addr === eqAddr(2, 5, 'G') && p.val === 530));
  assert.ok(r.pairs.some((p) => p.addr === eqAddr(3, 1, 'G') && p.val === 500));
  assert.equal(r.dropped.length, 0);
  assert.deepEqual(r.skipped, []);
});

test('reset and copy helpers', () => {
  const s = seeded();
  s.set(eqAddr(1, 2, 'G'), 530);
  const reset = m.resetChannelPairs(m.LAYERS.MODE, 1, s);
  assert.ok(reset.every((p) => p.val === 500) && reset.some((p) => p.addr === eqAddr(1, 2, 'G')));
  const copy = m.copyChannelPairs(m.LAYERS.MODE, 1, [3], s);
  assert.ok(copy.some((p) => p.addr === eqAddr(3, 2, 'G') && p.val === 530));
  assert.ok(!copy.some((p) => p.addr === eqAddr(3, 2, 'TYPE')));
  assert.ok(!copy.some((p) => p.addr === eqAddr(3, 32, 'G')), 'disabled slot 32 is not copied');
});
