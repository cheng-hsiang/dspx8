import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeFrame } from '../js/protocol/summary.js';
import * as cmd from '../js/protocol/commands.js';
import { buildFrame } from '../js/protocol/frame.js';

test('summaries for requests', () => {
  assert.equal(summarizeFrame(cmd.checkIdPacket(), 'tx'), 'CHECK_ID');
  assert.equal(summarizeFrame(cmd.readPacket([1248, 1242, 1588]), 'tx'), 'READ M0_22, M0_16, USB_L_VOL');
  assert.equal(summarizeFrame(cmd.writePacket([{ addr: 156, val: 560 }]), 'tx'), 'WRITE CH1 EQ3 G=560 (+6.0 dB)');
  assert.equal(summarizeFrame(cmd.uploadSectPacket(1600), 'tx'), 'UPLOAD_SECT start=1600');
  assert.equal(summarizeFrame(cmd.callModePacket(3), 'tx'), 'CALL_MODE 3');
});

test('summaries for responses decode values by field', () => {
  assert.equal(summarizeFrame(buildFrame(0x00, [0x0F, 0xA6]), 'rx'), 'CHECK_ID id=4006');
  assert.equal(summarizeFrame(buildFrame(0x06, [0x04, 0xE0, 0x00, 0x02, 0x04, 0xDA, 0x00, 0x01]), 'rx'), 'READ M0_22=2, M0_16=1');
  assert.equal(summarizeFrame(buildFrame(0x03, [0x00, 0x9B, 0x82, 0x58]), 'rx'), 'WRITE CH1 EQ3 F=33368 (60 Hz)');
  assert.equal(summarizeFrame(buildFrame(0x03, [0x00, 0x9D, 0x01, 0xB0]), 'rx'), 'WRITE CH1 EQ3 Q=432 (Q 13.68)');
  assert.equal(summarizeFrame(buildFrame(0x03, [0x00, 0x0C, 0x02, 0x3A]), 'rx'), 'WRITE MIX11_1=570 (vol 70, flag)');
  assert.equal(summarizeFrame(buildFrame(0x03, [0x00, 0x49, 0x03, 0xE8]), 'rx'), 'WRITE DELAY_1=1000 (1.000 ms)');
  assert.equal(summarizeFrame(buildFrame(0x03, [0x00, 0x02, 0x00, 0x01]), 'rx'), 'WRITE MUTE_2=1 (靜音)');
  const body = [0x06, 0x40]; for (let i = 1; i <= 13; i++) body.push(0, i);
  assert.equal(summarizeFrame(buildFrame(0x61, body), 'rx'), 'UPLOAD_SECT start=1600 n=13');
  assert.equal(summarizeFrame(buildFrame(0x71, [1, 2, 3]), 'rx'), 'BT_READ 3 bytes (忽略)');
  assert.equal(summarizeFrame(buildFrame(0x11, [2]), 'rx'), 'SAVE_MODE 2');
});

test('summary never throws on a truncated or unknown frame', () => {
  assert.equal(typeof summarizeFrame(Uint8Array.from([0x80, 0x03, 0x99]), 'rx'), 'string');
  assert.equal(typeof summarizeFrame(new Uint8Array(0), 'tx'), 'string');
});
