import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunk, detectEnvironment, uuid16, SERVICE_UUID, WRITE_UUID, NOTIFY_UUID, BleTransport } from '../js/transport/ble.js';

function fakeBluetooth({ failAt = null } = {}) {
  const calls = [];
  const listeners = new Map();
  const gatt = {
    connected: false,
    connect: async () => { gatt.connected = true; calls.push('gatt.connect'); return server; },
    disconnect: () => { gatt.connected = false; calls.push('gatt.disconnect'); },
  };
  const server = { getPrimaryService: async () => { calls.push('getPrimaryService'); if (failAt === 'service') throw new Error('no service'); return service; } };
  const service = { getCharacteristic: async (uuid) => { calls.push(`getCharacteristic ${uuid.slice(4, 8)}`); if (failAt === 'char') throw new Error('no char'); return uuid === WRITE_UUID ? writeChar : notifyChar; } };
  const writeChar = { properties: { write: true, writeWithoutResponse: false }, writeValueWithResponse: async () => { calls.push('write'); } };
  const notifyChar = { properties: { notify: true }, startNotifications: async () => { calls.push('startNotifications'); if (failAt === 'notify') throw new Error('notify failed'); }, addEventListener: () => {}, removeEventListener: () => {} };
  const device = {
    name: 'FAKE-DSP', gatt,
    addEventListener: (ev, fn) => listeners.set(ev, fn),
    removeEventListener: (ev) => listeners.delete(ev),
  };
  return { bluetooth: { requestDevice: async () => { calls.push('requestDevice'); return device; } }, calls, gatt, listeners };
}

test('connect cleans up the GATT link and listener when service discovery fails', async () => {
  for (const failAt of ['service', 'char', 'notify']) {
    const f = fakeBluetooth({ failAt });
    const t = new BleTransport({ bluetooth: f.bluetooth });
    await assert.rejects(t.connect(), /no service|no char|notify failed/);
    assert.equal(t.connected, false);
    assert.equal(f.gatt.connected, false, `gatt still connected after ${failAt} failure`);
    assert.equal(f.listeners.has('gattserverdisconnected'), false, `listener leaked after ${failAt} failure`);
    assert.equal(t.device, null);
  }
});

test('connect succeeds and write chunks go through writeValueWithResponse', async () => {
  const f = fakeBluetooth();
  const t = new BleTransport({ bluetooth: f.bluetooth });
  const info = await t.connect();
  assert.equal(info.name, 'FAKE-DSP');
  assert.equal(t.connected, true);
  await t.write(new Uint8Array(45));
  assert.equal(f.calls.filter((c) => c === 'write').length, 3);
  await t.disconnect();
  assert.equal(f.gatt.connected, false);
});

test('uuid constants', () => {
  assert.equal(uuid16(0xae00), '0000ae00-0000-1000-8000-00805f9b34fb');
  assert.equal(SERVICE_UUID, uuid16(0xae00));
  assert.equal(WRITE_UUID, uuid16(0xae01));
  assert.equal(NOTIFY_UUID, uuid16(0xae02));
});

test('chunk splits into ≤20-byte pieces preserving order', () => {
  const bytes = Uint8Array.from({ length: 45 }, (_, i) => i);
  const parts = chunk(bytes);
  assert.deepEqual(parts.map((p) => p.length), [20, 20, 5]);
  assert.equal(parts[2][4], 44);
  assert.deepEqual(chunk(new Uint8Array(0)), []);
});

test('detectEnvironment reads navigator and window safely', () => {
  const env = detectEnvironment(
    { userAgent: 'Mozilla/5.0 (iPhone) Bluefy/3.9', bluetooth: {} },
    { isSecureContext: true, matchMedia: () => ({ matches: true }) },
  );
  assert.deepEqual(env, { userAgent: 'Mozilla/5.0 (iPhone) Bluefy/3.9', webBluetooth: true, bluefy: true, standalone: true, secure: true });
  const none = detectEnvironment({ userAgent: 'x' }, {});
  assert.deepEqual(none, { userAgent: 'x', webBluetooth: false, bluefy: false, standalone: false, secure: false });
  assert.equal(detectEnvironment(null, null).userAgent, 'unknown');
});

test('a rejected or cancelled device chooser becomes a clear NO_DEVICE error, even when the browser gives no message', async () => {
  const t = new BleTransport({ bluetooth: { requestDevice: async () => { throw undefined; } } });
  await assert.rejects(t.connect(), (err) => err.code === 'NO_DEVICE' && /沒有選到裝置/.test(err.message));
  assert.equal(t.connected, false);
});
