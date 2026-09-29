import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Device, STATE } from '../js/core/device.js';
import { RegisterStore, STATUS } from '../js/core/store.js';
import { Logger } from '../js/core/logger.js';
import { FakeDevice } from '../js/transport/fake-device.js';
import { ADDR, eqAddr, xoverAddr, DUMP_END } from '../js/protocol/addrmap.js';

function make(devOpts = {}, opts = {}) {
  const transport = new FakeDevice({ latencyMs: 0, ...devOpts });
  const store = new RegisterStore();
  const logger = new Logger();
  const device = new Device({ transport, store, logger, queueOptions: { timeoutMs: 30, retries: 1, deadAfter: 3 }, heartbeatMs: 20, modeReloadDelayMs: 5, ...opts });
  return { transport, store, logger, device };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('connect: id check, full dump, snapshot, state connected', async () => {
  const { device, store } = make();
  const states = []; device.on('state', (s) => states.push(s));
  let progress = 0; device.on('progress', (p) => { progress = p.done; assert.equal(p.total, 17); });
  let snap = null; device.on('snapshot', (s) => { snap = s; });
  await device.connect();
  assert.deepEqual(states, [STATE.CONNECTING, STATE.CONNECTED]);
  assert.equal(device.info.customerId, 4006);
  assert.equal(device.info.name, 'DSP-X8s-SIM');
  assert.equal(progress, 17);
  assert.equal(device.dumpInfo.complete, true);
  assert.equal(device.dumpInfo.method, 'sect');
  assert.equal(store.get(eqAddr(1, 1, 'G')), 500);
  assert.equal(store.getStatus(DUMP_END), STATUS.CONFIRMED);
  assert.equal(store.confirmedCount(), DUMP_END + 1);
  assert.ok(snap && snap.values.length === DUMP_END + 1);
  await device.disconnect();
  assert.equal(device.state, STATE.DISCONNECTED);
});

test('wrong customer id → readonly, writes refused without sending', async () => {
  const { device, transport } = make({ customerId: 1234 });
  await device.connect();
  assert.equal(device.state, STATE.READONLY);
  assert.equal(device.canWrite, false);
  const sentBefore = transport.sent.length;
  await assert.rejects(device.writeRegs([{ addr: eqAddr(1, 1, 'G'), val: 510 }]), /readonly/);
  assert.equal(transport.sent.length, sentBefore);
  await device.disconnect();
});

test('TYPE fields and out-of-range addresses are refused', async () => {
  const { device } = make();
  await device.connect();
  await assert.rejects(device.writeRegs([{ addr: eqAddr(1, 1, 'TYPE'), val: 1 }]), RangeError);
  await assert.rejects(device.writeRegs([{ addr: xoverAddr(1, 2, 'TYPE'), val: 1 }]), RangeError);
  await assert.rejects(device.writeRegs([{ addr: DUMP_END + 1, val: 1 }]), RangeError);
  await device.disconnect();
});

test('writeRegs marks pending then confirmed; verify detects a mismatch', async () => {
  const { device, store, transport } = make();
  await device.connect();
  const addr = eqAddr(1, 3, 'G');
  await device.writeRegs([{ addr, val: 560 }]);
  assert.equal(store.get(addr), 560);
  assert.equal(store.getStatus(addr), STATUS.CONFIRMED);
  transport.setRegister(addr, 500); // device silently changed
  const mism = await device.verify([addr]);
  assert.deepEqual(mism, [{ addr, expected: 560, actual: 500 }]);
  assert.equal(store.getStatus(addr), STATUS.MISMATCH);
  await device.disconnect();
});

test('writeTest reports before/sent/readBack and ok', async () => {
  const { device } = make();
  await device.connect();
  const r = await device.writeTest(1, 3, 6);
  assert.equal(r.addr, eqAddr(1, 3, 'G'));
  assert.equal(r.name, 'CH1 EQ3 G');
  assert.equal(r.before, 500);
  assert.equal(r.sent, 560);
  assert.equal(r.readBack, 560);
  assert.equal(r.ok, true);
  assert.ok(r.ms >= 0);
  await device.disconnect();
});

test('sect failure falls back to plain reads; dumpInfo.method is mixed', async () => {
  const { device, store } = make({ failSect: true });
  await device.connect();
  assert.equal(device.dumpInfo.complete, true);
  assert.equal(device.dumpInfo.method, 'mixed');
  assert.equal(store.confirmedCount(), DUMP_END + 1);
  await device.disconnect();
});

test('heartbeat notices a mode change and re-dumps', async () => {
  const { device, transport, store } = make();
  await device.connect();
  const modes = []; device.on('mode', (m) => modes.push(m));
  let dumps = 0; device.on('dump', () => dumps++);
  transport.slots[4][eqAddr(1, 1, 'G')] = 530;
  transport.pokeMode(5);
  await wait(150);
  assert.deepEqual(modes, [5]);
  assert.ok(dumps >= 1);
  assert.equal(store.get(ADDR.M0_MODE), 5);
  assert.equal(store.get(eqAddr(1, 1, 'G')), 530);
  await device.disconnect();
});

test('callMode reloads registers from the slot', async () => {
  const { device, transport, store } = make();
  await device.connect();
  transport.slots[2][eqAddr(2, 2, 'G')] = 470;
  await device.callMode(3);
  assert.equal(store.get(ADDR.M0_MODE), 3);
  assert.equal(store.get(eqAddr(2, 2, 'G')), 470);
  await device.disconnect();
});

test('transport disconnect moves state to disconnected and stops heartbeat', async () => {
  const { device, transport } = make();
  await device.connect();
  await transport.disconnect();
  await wait(10);
  assert.equal(device.state, STATE.DISCONNECTED);
  const n = transport.sent.length;
  await wait(60);
  assert.equal(transport.sent.length, n);
});
