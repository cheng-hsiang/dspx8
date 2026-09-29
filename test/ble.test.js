import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunk, detectEnvironment, uuid16, SERVICE_UUID, WRITE_UUID, NOTIFY_UUID } from '../js/transport/ble.js';

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
  assert.equal(detectEnvironment(undefined, undefined).userAgent, 'unknown');
});
