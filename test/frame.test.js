import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFrame, parseFrame, FrameAssembler, FRAME_HEAD, MAX_LEN } from '../js/protocol/frame.js';

const hex = (a) => Array.from(a, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

test('buildFrame produces the check-id frame 80 05 00 00 00 12 25', () => {
  assert.equal(hex(buildFrame(0x00, [0, 0])), '80 05 00 00 00 12 25');
});

test('buildFrame produces a write frame for CH1 EQ3 G=560', () => {
  assert.equal(hex(buildFrame(0x03, [0x00, 0x9C, 0x02, 0x30])), '80 07 03 00 9C 02 30 25 1E');
});

test('buildFrame rejects payloads that exceed MAX_LEN', () => {
  assert.throws(() => buildFrame(0x06, new Uint8Array(MAX_LEN)), RangeError);
});

test('parseFrame returns cmd and data view', () => {
  const f = parseFrame(Uint8Array.from([0x80, 0x07, 0x03, 0x00, 0x9C, 0x02, 0x30, 0x25, 0x1E]));
  assert.equal(f.cmd, 0x03);
  assert.deepEqual(Array.from(f.data), [0x00, 0x9C, 0x02, 0x30]);
});

test('parseFrame throws on bad crc and on length mismatch', () => {
  assert.throws(() => parseFrame(Uint8Array.from([0x80, 0x05, 0x00, 0x00, 0x00, 0x12, 0x26])), /crc/);
  assert.throws(() => parseFrame(Uint8Array.from([0x80, 0x06, 0x00, 0x00, 0x00, 0x12, 0x25])), /length/);
});

test('FrameAssembler reassembles a frame split across chunks, CRC split too', () => {
  const full = buildFrame(0x06, [0x04, 0xE0, 0x00, 0x02, 0x04, 0xDA, 0x00, 0x01, 0x06, 0x34, 0x02, 0x1E]);
  const asm = new FrameAssembler();
  assert.deepEqual(asm.push(full.subarray(0, 4)), []);
  assert.deepEqual(asm.push(full.subarray(4, full.length - 1)), []);
  const frames = asm.push(full.subarray(full.length - 1));
  assert.equal(frames.length, 1);
  assert.equal(hex(frames[0]), hex(full));
});

test('FrameAssembler skips garbage before a frame and counts dropped bytes', () => {
  const full = buildFrame(0x00, [0, 0]);
  const asm = new FrameAssembler();
  const frames = asm.push(Uint8Array.from([0x11, 0x22, ...full]));
  assert.equal(frames.length, 1);
  assert.equal(asm.droppedBytes, 2);
});

test('FrameAssembler does not resync on a 0x80 inside data', () => {
  // data contains 0x80 at a position where a fake LEN would look plausible
  const full = buildFrame(0x03, [0x80, 0x05, 0x00, 0x00, 0x00, 0x12, 0x25, 0x00]);
  const asm = new FrameAssembler();
  const frames = asm.push(full);
  assert.equal(frames.length, 1);
  assert.equal(hex(frames[0]), hex(full));
  assert.equal(asm.droppedBytes, 0);
});

test('FrameAssembler recovers after a corrupted frame', () => {
  const bad = buildFrame(0x00, [0, 0]); bad[3] ^= 0xFF; // corrupt data → crc fails
  const good = buildFrame(0x01, [3]);
  const asm = new FrameAssembler();
  const frames = asm.push(Uint8Array.from([...bad, ...good]));
  assert.equal(frames.length, 1);
  assert.equal(frames[0][2], 0x01);
  assert.equal(asm.crcErrors, 1);
});

test('FrameAssembler returns two frames from one chunk', () => {
  const a = buildFrame(0x00, [0, 0]);
  const b = buildFrame(0x01, [3]);
  const asm = new FrameAssembler();
  assert.equal(asm.push(Uint8Array.from([...a, ...b])).length, 2);
});

test('constants', () => {
  assert.equal(FRAME_HEAD, 0x80);
  assert.equal(MAX_LEN, 250);
});
