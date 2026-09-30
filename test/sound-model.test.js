import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as s from '../js/sound/model.js';
import { RegisterStore } from '../js/core/store.js';
import { FakeDevice } from '../js/transport/fake-device.js';
import { ADDR } from '../js/protocol/addrmap.js';
import { INPUT } from '../js/protocol/tables.js';

function seeded() {
  const d = new FakeDevice();
  const store = new RegisterStore();
  store.setMany(Array.from({ length: store.size }, (_, addr) => ({ addr, val: d.regs[addr] })));
  return store;
}

test('readChannel decodes mute, phase (flag set = 0°), level and delay for one output', () => {
  const store = seeded();
  assert.deepEqual(s.readChannel(store, 1), { ch: 1, muted: false, inverted: false, level: 100, delayRaw: 0, delayMs: 0, delayCm: 0, samples: 0 });
  store.set(ADDR.muteOfChannel(3), 1);
  store.set(ADDR.phaseOfChannel(3), 100); // OEM VolToNum(inverted=true, 100): no +500 flag
  store.set(ADDR.mix11(3), 594);
  store.set(ADDR.delay(3), 1000);
  assert.deepEqual(s.readChannel(store, 3), { ch: 3, muted: true, inverted: true, level: 94, delayRaw: 1000, delayMs: 1, delayCm: 34.6, samples: 48 });
});

test('phasePair flips only the flag and keeps the routing gain', () => {
  const store = seeded();
  assert.deepEqual(s.phasePair(store, 2, true), { addr: ADDR.phaseOfChannel(2), val: 100 });
  store.set(ADDR.phaseOfChannel(2), 100);
  assert.deepEqual(s.phasePair(store, 2, false), { addr: ADDR.phaseOfChannel(2), val: 600 });
});

test('levelPair writes MIX11_k with the flag preserved and the level clamped to 0..100', () => {
  const store = seeded();
  assert.deepEqual(s.levelPair(store, 4, 94), { addr: ADDR.mix11(4), val: 594 });
  assert.deepEqual(s.levelPair(store, 4, 250), { addr: ADDR.mix11(4), val: 600 });
  store.set(ADDR.mix11(4), 80); // flag-less value: keep it flag-less
  assert.deepEqual(s.levelPair(store, 4, 50), { addr: ADDR.mix11(4), val: 50 });
});

test('master knob is the loudest channel; moving it shifts every channel by the same amount, keeping offsets', () => {
  const store = seeded();
  assert.equal(s.masterKnob(store), 60);
  store.set(ADDR.mix11(3), 594); store.set(ADDR.mix11(4), 594); // rear 6 below front
  assert.equal(s.masterKnob(store), 60);
  const pairs = s.masterPairs(store, 50);
  assert.equal(pairs.length, 8);
  assert.equal(pairs.find((p) => p.addr === ADDR.mix11(1)).val, 590);
  assert.equal(pairs.find((p) => p.addr === ADDR.mix11(3)).val, 584);
  // never below the flag floor: an offset channel saturates at level 0 instead of losing its flag
  const low = s.masterPairs(store, 0);
  assert.equal(low.find((p) => p.addr === ADDR.mix11(1)).val, 540);
  assert.equal(low.find((p) => p.addr === ADDR.mix11(3)).val, 534);
});

test('delay pairs: from centimetres and from 48 kHz samples, clamped to 0..20 ms', () => {
  assert.deepEqual(s.delayPairFromCm(1, 34.6), { addr: ADDR.delay(1), val: 1000 });
  assert.deepEqual(s.delayPairFromSamples(2, 48), { addr: ADDR.delay(2), val: 1000 });
  assert.deepEqual(s.delayPairFromSamples(2, 5000), { addr: ADDR.delay(2), val: 20000 });
  assert.deepEqual(s.delayPairFromCm(2, -5), { addr: ADDR.delay(2), val: 0 });
  assert.equal(s.DELAY_MAX_CM, 692);
  assert.equal(s.DELAY_MAX_SAMPLES, 960);
});

test('inputPair writes M0_8 and currentInput reads the low nibble of M0_22', () => {
  const store = seeded();
  assert.deepEqual(s.inputPair(INPUT.AUX), { addr: ADDR.M0_INPUT_SET, val: 4 });
  assert.throws(() => s.inputPair(9), RangeError);
  assert.equal(s.currentInput(store), INPUT.HIGH_LEVEL); // seeded 0x13
});
