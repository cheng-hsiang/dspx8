import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc16 } from '../js/protocol/crc16.js';

test('crc16 matches CRC-16/MODBUS check value for "123456789"', () => {
  assert.equal(crc16(new TextEncoder().encode('123456789')), 0x4B37);
});

test('crc16 of check-id frame body is 0x1225', () => {
  assert.equal(crc16([0x80, 0x05, 0x00, 0x00, 0x00]), 0x1225);
});

test('crc16 honours explicit length', () => {
  assert.equal(crc16([0x80, 0x05, 0x00, 0x00, 0x00, 0xFF, 0xFF], 5), 0x1225);
});
