import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Logger, LEVELS, toHex } from '../js/core/logger.js';
import { checkIdPacket } from '../js/protocol/commands.js';

function makeLogger(opts) {
  let t = 1000;
  return new Logger({ now: () => (t += 10), ...opts });
}

test('levels and hex helper', () => {
  assert.deepEqual(LEVELS, ['INFO', 'WARN', 'ERR', 'TX', 'RX', 'REPORT']);
  assert.equal(toHex(Uint8Array.from([0x80, 0x05, 0x00])), '80 05 00');
});

test('entries get sequence numbers and relative time', () => {
  const log = makeLogger();
  log.info('a');
  log.warn('b');
  assert.equal(log.entries.length, 2);
  assert.equal(log.entries[0].i, 1);
  assert.equal(log.entries[0].t, 0);
  assert.equal(log.entries[1].t, 10);
  assert.equal(log.entries[1].level, 'WARN');
});

test('tx/rx store hex and a summary', () => {
  const log = makeLogger();
  log.tx(checkIdPacket());
  assert.equal(log.entries[0].level, 'TX');
  assert.equal(log.entries[0].hex, '80 05 00 00 00 12 25');
  assert.equal(log.entries[0].text, 'CHECK_ID');
});

test('subscribe receives each new entry; unsubscribe stops it', () => {
  const log = makeLogger();
  const seen = [];
  const off = log.subscribe((e) => seen.push(e.text));
  log.info('x');
  off();
  log.info('y');
  assert.deepEqual(seen, ['x']);
});

test('cap drops the oldest 10% and marks truncated', () => {
  const log = makeLogger({ max: 100 });
  for (let i = 0; i < 101; i++) log.info(`m${i}`);
  assert.ok(log.entries.length <= 100);
  assert.equal(log.truncated, true);
  assert.equal(log.entries[0].text, 'm10');
});

test('toText filters', () => {
  const log = makeLogger();
  log.info('i'); log.tx(checkIdPacket()); log.warn('w'); log.report('R');
  const all = log.toText('all').split('\n');
  assert.equal(all.length, 4);
  assert.match(all[1], /^\s*\d+\s+TX\s+CHECK_ID\s+\| 80 05/);
  assert.deepEqual(log.toText('important').split('\n').map((l) => l.trim().split(/\s+/)[1]), ['INFO', 'WARN', 'REPORT']);
  assert.deepEqual(log.toText('packets').split('\n').map((l) => l.trim().split(/\s+/)[1]), ['TX']);
  assert.equal(log.lastReport(), 'R');
});

test('clear and restore', () => {
  const log = makeLogger();
  log.info('a');
  const saved = log.entries.slice();
  log.clear();
  assert.equal(log.entries.length, 0);
  assert.equal(log.lastReport(), null);
  log.restore(saved);
  assert.equal(log.entries.length, 1);
  log.info('b');
  assert.equal(log.entries[1].i, 2);
});
