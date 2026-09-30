import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../js/protocol/codec.js';

test('byte helpers', () => {
  assert.equal(c.hi(0x1234), 0x12);
  assert.equal(c.lo(0x1234), 0x34);
  assert.equal(c.u16(0x12, 0x34), 0x1234);
  assert.equal(c.clamp(5, 0, 3), 3);
  assert.equal(c.clamp(-1, 0, 3), 0);
});

test('gain: 0 dB is 500, +6.0 dB is 560, -12 dB is 380', () => {
  assert.equal(c.encodeGain(0), 500);
  assert.equal(c.encodeGain(6), 560);
  assert.equal(c.encodeGain(-12), 380);
  assert.equal(c.decodeGain(560), 6);
  assert.equal(c.decodeGain(387), -11.3);
});

test('frequency: below 100 Hz uses 0.1 Hz units with bit 15 set', () => {
  assert.equal(c.encodeFreq(60), 0x8000 | 600);
  assert.equal(c.encodeFreq(99.9), 0x8000 | 999);
  assert.equal(c.encodeFreq(100), 100);
  assert.equal(c.encodeFreq(20600), 20600);
  assert.equal(c.decodeFreq(0x8258), 60);
  assert.equal(c.decodeFreq(1000), 1000);
  assert.equal(c.decodeFreq(c.encodeFreq(31.5)), 31.5);
});

test('Q: hundredths', () => {
  assert.equal(c.encodeQ(0.4), 40);
  assert.equal(c.encodeQ(4.32), 432);
  assert.equal(c.decodeQ(100), 1);
});

test('volume flag is a +500 offset', () => {
  assert.equal(c.encodeVol(70, true), 570);
  assert.equal(c.encodeVol(70, false), 70);
  assert.deepEqual(c.decodeVol(570), { vol: 70, flag: true });
  assert.deepEqual(c.decodeVol(70), { vol: 70, flag: false });
});

test('master volume knob 0..60 maps to 540..600 with flag set', () => {
  assert.equal(c.encodeMasterVol(0), 540);
  assert.equal(c.encodeMasterVol(30), 570);
  assert.equal(c.encodeMasterVol(60), 600);
  assert.equal(c.decodeMasterVol(570), 30);
  assert.equal(c.decodeMasterVol(520), 0); // below offset clamps to 0
  assert.equal(c.encodeMasterVol(99), 600); // clamps to max
});

test('delay: raw is microseconds, 48 kHz samples, 346 m/s', () => {
  assert.equal(c.msToDelayRaw(20), 20000);
  assert.equal(c.msToDelayRaw(25), 20000);
  assert.equal(c.delayRawToMs(1500), 1.5);
  assert.equal(c.delayRawToCm(20000), 692);
  assert.equal(c.samplesToDelayRaw(48), 1000);
  assert.equal(c.samplesToDelayRaw(960), 20000);
  assert.equal(c.delayRawToSamples(1000), 48);
});

test('Q display: raw is hundredths of Q divided by the OEM QRATE (factory raw 240 shows as Q 7.6)', () => {
  assert.equal(c.QRATE, 7.6 / 2.4);
  assert.ok(Math.abs(c.rawToQ(240) - 7.6) < 1e-9);
  assert.equal(c.qToRaw(1.0), 32);
  assert.equal(c.qToRaw(7.6), 240);
  assert.equal(c.describeQ(240), '7.6');
  assert.equal(c.describeQ(32), '1.01');
});
