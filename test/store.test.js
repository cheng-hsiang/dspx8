import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RegisterStore, STATUS } from '../js/core/store.js';

test('defaults to unknown zeros sized to the dump range', () => {
  const s = new RegisterStore();
  assert.equal(s.size, 1613);
  assert.equal(s.get(156), 0);
  assert.equal(s.getStatus(156), STATUS.UNKNOWN);
  assert.equal(s.confirmedCount(), 0);
});

test('set/setMany notify subscribers with changed addresses', () => {
  const s = new RegisterStore();
  const seen = [];
  s.subscribe((addrs) => seen.push(addrs));
  s.set(156, 560);
  s.setMany([{ addr: 1, val: 1 }, { addr: 2, val: 0 }]);
  assert.deepEqual(seen, [[156], [1, 2]]);
  assert.equal(s.get(156), 560);
  assert.equal(s.getStatus(156), STATUS.CONFIRMED);
  assert.equal(s.confirmedCount(), 3);
});

test('pending, mismatch and acceptDevice', () => {
  const s = new RegisterStore();
  s.set(156, 560, STATUS.PENDING);
  assert.equal(s.getStatus(156), STATUS.PENDING);
  s.markMismatch(156, 500);
  assert.equal(s.getStatus(156), STATUS.MISMATCH);
  assert.equal(s.deviceValues.get(156), 500);
  assert.equal(s.get(156), 560);
  s.acceptDevice(156);
  assert.equal(s.get(156), 500);
  assert.equal(s.getStatus(156), STATUS.CONFIRMED);
  assert.equal(s.deviceValues.has(156), false);
});

test('out-of-range addresses are ignored, not thrown', () => {
  const s = new RegisterStore();
  s.set(5000, 1);
  assert.equal(s.get(5000), 0);
});

test('snapshot round-trip', () => {
  const s = new RegisterStore();
  s.set(12, 570);
  const snap = s.snapshot();
  assert.ok(snap.ts > 0);
  assert.equal(snap.values[12], 570);
  const s2 = new RegisterStore();
  s2.loadSnapshot(snap);
  assert.equal(s2.get(12), 570);
  assert.equal(s2.getStatus(12), STATUS.CONFIRMED);
  s2.reset();
  assert.equal(s2.get(12), 0);
  assert.equal(s2.getStatus(12), STATUS.UNKNOWN);
});
