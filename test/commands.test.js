import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cmd from '../js/protocol/commands.js';
import { buildFrame, parseFrame } from '../js/protocol/frame.js';

const hex = (a) => Array.from(a, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

test('fixed packets match known vectors', () => {
  assert.equal(hex(cmd.checkIdPacket()), '80 05 00 00 00 12 25');
  assert.equal(hex(cmd.callModePacket(3)), '80 04 01 03 B4 29');
  assert.equal(hex(cmd.saveModePacket(3)), '80 04 11 03 74 24');
  assert.equal(hex(cmd.uploadSectPacket(0)), '80 05 61 00 00 CC 74');
  assert.throws(() => cmd.callModePacket(9), RangeError);
});

test('read/write packets', () => {
  assert.equal(hex(cmd.readPacket([1248, 1242, 1588])), '80 09 06 04 E0 04 DA 06 34 B2 6F');
  assert.equal(hex(cmd.writePacket([{ addr: 156, val: 560 }])), '80 07 03 00 9C 02 30 25 1E');
  assert.throws(() => cmd.writePacket([]), RangeError);
  assert.throws(() => cmd.writePacket(new Array(4).fill({ addr: 1, val: 1 })), RangeError);
  assert.throws(() => cmd.readPacket(new Array(15).fill(1)), RangeError);
});

test('writePackets / readPackets chunk by 3 and 14', () => {
  const pairs = Array.from({ length: 7 }, (_, i) => ({ addr: 100 + i, val: i }));
  const wp = cmd.writePackets(pairs);
  assert.equal(wp.length, 3);
  assert.equal(parseFrame(wp[2]).data.length, 4); // last packet has 1 pair
  const rp = cmd.readPackets(Array.from({ length: 30 }, (_, i) => i));
  assert.deepEqual(rp.map((f) => parseFrame(f).data.length / 2), [14, 14, 2]);
});

test('sectPlan covers 0..1612 in 17 requests of 100', () => {
  const plan = cmd.sectPlan();
  assert.equal(plan.length, 17);
  assert.equal(plan[0], 0);
  assert.equal(plan.at(-1), 1600);
});

test('parseResponse: id, regs, sect with 13 values, mode, other', () => {
  assert.deepEqual(cmd.parseResponse(parseFrame(buildFrame(0x00, [0x0F, 0xA6]))), { type: 'id', id: 4006 });
  const regs = cmd.parseResponse(parseFrame(buildFrame(0x06, [0x04, 0xE0, 0x00, 0x02, 0x04, 0xDA, 0x00, 0x01])));
  assert.deepEqual(regs, { type: 'regs', cmd: 0x06, pairs: [{ addr: 1248, val: 2 }, { addr: 1242, val: 1 }] });
  const body = [0x06, 0x40]; for (let i = 1; i <= 13; i++) body.push(0, i);
  const sect = cmd.parseResponse(parseFrame(buildFrame(0x61, body)));
  assert.equal(sect.type, 'sect');
  assert.equal(sect.start, 1600);
  assert.equal(sect.values.length, 13);
  assert.equal(sect.values[12], 13);
  assert.deepEqual(cmd.parseResponse(parseFrame(buildFrame(0x01, [3]))), { type: 'mode', cmd: 0x01, mode: 3 });
  assert.equal(cmd.parseResponse(parseFrame(buildFrame(0x71, [1, 2, 3]))).type, 'other');
});

test('matchesRequest: write needs exact echo, read/sect match first address, mode matches cmd', () => {
  const w = cmd.writePacket([{ addr: 156, val: 560 }]);
  assert.equal(cmd.matchesRequest(w, w.slice()), true);
  const wOther = cmd.writePacket([{ addr: 156, val: 561 }]);
  assert.equal(cmd.matchesRequest(w, wOther), false);
  const r = cmd.readPacket([1248, 1242]);
  const rResp = buildFrame(0x06, [0x04, 0xE0, 0x00, 0x02, 0x04, 0xDA, 0x00, 0x01]);
  assert.equal(cmd.matchesRequest(r, rResp), true);
  assert.equal(cmd.matchesRequest(cmd.readPacket([1242]), rResp), false);
  assert.equal(cmd.matchesRequest(cmd.uploadSectPacket(1600), buildFrame(0x61, [0x06, 0x40, 0, 1])), true);
  assert.equal(cmd.matchesRequest(cmd.callModePacket(2), buildFrame(0x01, [2])), true);
  assert.equal(cmd.matchesRequest(cmd.callModePacket(2), buildFrame(0x11, [2])), false);
});

test('coalesceKey identifies same-address writes and reads, null for others', () => {
  assert.equal(cmd.coalesceKey(cmd.writePacket([{ addr: 156, val: 1 }])), '3:156:9');
  assert.equal(cmd.coalesceKey(cmd.writePacket([{ addr: 156, val: 2 }])), '3:156:9');
  assert.equal(cmd.coalesceKey(cmd.readPacket([1248, 1242, 1588])), '6:1248:11');
  assert.equal(cmd.coalesceKey(cmd.checkIdPacket()), null);
  assert.equal(cmd.coalesceKey(cmd.uploadSectPacket(0)), null);
});
