import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDevice } from '../js/transport/fake-device.js';
import { FrameAssembler } from '../js/protocol/frame.js';
import * as cmd from '../js/protocol/commands.js';
import { eqAddr, ADDR, MODE_END } from '../js/protocol/addrmap.js';

async function roundTrip(dev, frame, { expect = 1, timeout = 200 } = {}) {
  const asm = new FrameAssembler();
  const frames = [];
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => (expect === 0 ? resolve(frames) : reject(new Error('no response'))), timeout);
    dev.onData((chunk) => {
      for (const f of asm.push(chunk)) frames.push(f);
      if (frames.length >= expect && expect > 0) { clearTimeout(timer); resolve(frames); }
    });
  });
  await dev.write(frame);
  return done;
}

test('connect/disconnect and name', async () => {
  const dev = new FakeDevice();
  assert.equal(dev.connected, false);
  const info = await dev.connect();
  assert.equal(info.name, 'Mango3.0-SIM');
  assert.equal(dev.connected, true);
  let disconnected = false;
  dev.onDisconnect(() => { disconnected = true; });
  await dev.disconnect();
  assert.equal(dev.connected, false);
  assert.equal(disconnected, true);
});

test('answers CHECK_ID with the configured customer id', async () => {
  const dev = new FakeDevice({ customerId: 4006 });
  await dev.connect();
  const [resp] = await roundTrip(dev, cmd.checkIdPacket());
  assert.deepEqual(cmd.parseResponse({ cmd: resp[2], data: resp.subarray(3, resp.length - 2) }), { type: 'id', id: 4006 });
});

test('READ returns current values; WRITE applies and echoes exactly', async () => {
  const dev = new FakeDevice();
  await dev.connect();
  const addr = eqAddr(1, 3, 'G');
  const w = cmd.writePacket([{ addr, val: 560 }]);
  const [echo] = await roundTrip(dev, w);
  assert.deepEqual(Array.from(echo), Array.from(w));
  assert.equal(dev.regs[addr], 560);
  const [r] = await roundTrip(dev, cmd.readPacket([addr]));
  const parsed = cmd.parseResponse({ cmd: r[2], data: r.subarray(3, r.length - 2) });
  assert.deepEqual(parsed.pairs, [{ addr, val: 560 }]);
});

test('UPLOAD_SECT returns at most 80 values like the real device, 79 for the last segment; responses arrive in 20-byte chunks', async () => {
  const dev = new FakeDevice({ chunkSize: 20 });
  await dev.connect();
  let chunks = 0;
  dev.onData(() => chunks++);
  const [full] = await roundTrip(dev, cmd.uploadSectPacket(0));
  const parsed = cmd.parseResponse({ cmd: full[2], data: full.subarray(3, full.length - 2) });
  assert.equal(parsed.values.length, 80);
  assert.ok(chunks >= 8, `expected chunked notifications, got ${chunks}`);
  const [last] = await roundTrip(dev, cmd.uploadSectPacket(1600));
  assert.equal(cmd.parseResponse({ cmd: last[2], data: last.subarray(3, last.length - 2) }).values.length, 79);
});

test('CALL_MODE loads a slot, SAVE_MODE stores one', async () => {
  const dev = new FakeDevice();
  await dev.connect();
  const addr = eqAddr(2, 1, 'G');
  dev.setRegister(addr, 530);
  await roundTrip(dev, cmd.saveModePacket(2));
  assert.equal(dev.slots[1][addr], 530);
  dev.setRegister(addr, 500);
  await roundTrip(dev, cmd.callModePacket(2));
  assert.equal(dev.regs[addr], 530);
  assert.equal(dev.regs[ADDR.M0_MODE], 2);
  assert.equal(dev.currentMode, 2);
});

test('pokeMode changes M0_MODE without a request', async () => {
  const dev = new FakeDevice();
  await dev.connect();
  dev.pokeMode(5);
  assert.equal(dev.regs[ADDR.M0_MODE], 5);
});

test('failSect suppresses sect responses; dropNext swallows the next N frames', async () => {
  const dev = new FakeDevice({ failSect: true, dropNext: 1 });
  await dev.connect();
  assert.equal((await roundTrip(dev, cmd.uploadSectPacket(0), { expect: 0, timeout: 50 })).length, 0);
  assert.equal((await roundTrip(dev, cmd.checkIdPacket(), { expect: 0, timeout: 50 })).length, 0); // dropped
  assert.equal((await roundTrip(dev, cmd.checkIdPacket())).length, 1);
});

test('seedDefaults mirrors the real DSP-X8s dump and records sent frames', async () => {
  const dev = new FakeDevice();
  assert.equal(dev.regs[eqAddr(1, 1, 'G')], 500);
  assert.equal(dev.regs[eqAddr(1, 1, 'TYPE')], 7);
  assert.equal(dev.regs[eqAddr(1, 1, 'Q')], 240);
  assert.equal(dev.regs[eqAddr(1, 10, 'F')], 161);
  assert.equal(dev.regs[eqAddr(1, 32, 'F')], 20000);
  assert.equal(dev.regs[eqAddr(1, 32, 'Q')], 400);
  assert.equal(dev.regs[ADDR.M0_MODE], 1);
  assert.equal(dev.regs[ADDR.M0_INPUT_CUR], 19);
  assert.equal(dev.regs[ADDR.EQ_BYPASS_SWITCH], 1);
  assert.equal(dev.regs[ADDR.mix11(1)], 600);
  assert.equal(dev.regs[ADDR.phaseOfChannel(8)], 600);
  assert.equal(dev.regs[ADDR.iir100(1, 1, 1)], 33368);
  assert.equal(dev.regs[ADDR.iir100(1, 5, 1)], 250);
  assert.ok(dev.regs[MODE_END] === 0);
  await dev.connect();
  await dev.write(cmd.checkIdPacket());
  assert.equal(dev.sent.length, 1);
});

test('READ replies are sent twice like the real device; the queue must tolerate it', async () => {
  const dev = new FakeDevice({ latencyMs: 0 });
  await dev.connect();
  const frames = await roundTrip(dev, cmd.readPacket([1242]), { expect: 2, timeout: 300 });
  assert.equal(frames.length, 2);
  assert.deepEqual(Array.from(frames[0]), Array.from(frames[1]));
  const single = new FakeDevice({ latencyMs: 0, dupReads: false });
  await single.connect();
  assert.equal((await roundTrip(single, cmd.readPacket([1242]), { expect: 0, timeout: 60 })).length, 1);
});

test('optional periodic BT status frames (0x71) like the real device', async () => {
  const dev = new FakeDevice({ latencyMs: 0, btStatusMs: 20 });
  await dev.connect();
  const seen = [];
  const asm = new FrameAssembler();
  dev.onData((c) => { for (const f of asm.push(c)) seen.push(f[2]); });
  await new Promise((r) => setTimeout(r, 90));
  await dev.disconnect();
  assert.ok(seen.filter((c) => c === 0x71).length >= 2);
});

test('write before connect rejects', async () => {
  const dev = new FakeDevice();
  await assert.rejects(dev.write(cmd.checkIdPacket()), /not connected/);
});

test('writing the input source (M0_8) is mirrored into the reported input (M0_22), as the OEM app expects of the real unit', async () => {
  const dev = new FakeDevice({ latencyMs: 0 });
  await dev.connect();
  await roundTrip(dev, cmd.writePacket([{ addr: ADDR.M0_INPUT_SET, val: 4 }]));
  assert.equal(dev.regs[ADDR.M0_INPUT_SET], 4);
  assert.equal(dev.regs[ADDR.M0_INPUT_CUR], 0x14);
});
