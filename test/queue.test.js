import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Queue, TimeoutError } from '../js/core/queue.js';
import { Logger } from '../js/core/logger.js';
import { FakeDevice } from '../js/transport/fake-device.js';
import { buildFrame } from '../js/protocol/frame.js';
import * as cmd from '../js/protocol/commands.js';
import { eqAddr } from '../js/protocol/addrmap.js';

async function setup(devOpts = {}, qOpts = {}) {
  const dev = new FakeDevice(devOpts);
  await dev.connect();
  const log = new Logger();
  const q = new Queue(dev, log, { timeoutMs: 40, retries: 2, deadAfter: 2, ...qOpts });
  return { dev, log, q };
}

test('send resolves with parsed response and logs TX/RX', async () => {
  const { q, log } = await setup();
  const res = await q.send(cmd.checkIdPacket());
  assert.equal(res.parsed.type, 'id');
  assert.equal(res.parsed.id, 4006);
  assert.deepEqual(log.entries.map((e) => e.level), ['TX', 'RX']);
  assert.equal(q.stats.sent, 1);
  assert.equal(q.stats.acked, 1);
});

test('requests are serialised: second is not written until first is acked', async () => {
  const { q, dev } = await setup({ latencyMs: 5 });
  const p1 = q.send(cmd.readPacket([1242]));
  const p2 = q.send(cmd.readPacket([1588]));
  await new Promise((r) => setTimeout(r, 1));
  assert.equal(dev.sent.length, 1);
  await p1;
  await p2;
  assert.equal(dev.sent.length, 2);
});

test('coalescing: 100 rapid writes to one address send the in-flight one and the last one only', async () => {
  const { q, dev } = await setup({ latencyMs: 5 });
  const addr = eqAddr(1, 3, 'G');
  const promises = [];
  for (let v = 500; v < 600; v++) promises.push(q.send(cmd.writePacket([{ addr, val: v }])));
  const results = await Promise.all(promises);
  assert.equal(dev.sent.length, 2);
  assert.equal(dev.regs[addr], 599);
  assert.equal(results[50].parsed.pairs[0].val, 599); // superseded callers get the final result
  assert.equal(q.pendingCount, 0);
});

test('writes to different addresses are not coalesced', async () => {
  const { q, dev } = await setup();
  await Promise.all([q.send(cmd.writePacket([{ addr: 156, val: 1 }])), q.send(cmd.writePacket([{ addr: 160, val: 1 }]))]);
  assert.equal(dev.sent.length, 2);
});

test('timeout resends up to retries then rejects with TimeoutError; onDead after consecutive failures', async () => {
  const { q, dev } = await setup({ failSect: true });
  let dead = 0;
  q.onDead(() => dead++);
  await assert.rejects(q.send(cmd.uploadSectPacket(0)), TimeoutError);
  assert.equal(dev.sent.length, 3); // 1 + 2 retries
  assert.equal(q.stats.resent, 2);
  assert.equal(q.stats.timeouts, 1);
  assert.equal(dead, 0);
  await assert.rejects(q.send(cmd.uploadSectPacket(100)), TimeoutError);
  assert.equal(dead, 1);
  await q.send(cmd.checkIdPacket()); // a success resets the streak
  await assert.rejects(q.send(cmd.uploadSectPacket(200)), TimeoutError);
  assert.equal(dead, 1);
});

test('a dropped first attempt is recovered by the resend', async () => {
  const { q, dev } = await setup({ dropNext: 1 });
  const res = await q.send(cmd.checkIdPacket());
  assert.equal(res.parsed.id, 4006);
  assert.equal(dev.sent.length, 2);
});

test('unsolicited frames are reported and do not ack the in-flight request; BT status frames are only counted', async () => {
  const { q, dev } = await setup({ latencyMs: 5, dupReads: false });
  const seen = [];
  q.onUnsolicited((f) => seen.push(f[2]));
  const p = q.send(cmd.readPacket([1242]));
  // inject a BT status broadcast and a stray mode-name reply while the read is in flight
  for (const cb of dev.dataCbs) { cb(buildFrame(0x71, [1, 2, 3])); cb(buildFrame(0x04, [1, 65, 66])); }
  const res = await p;
  assert.equal(res.parsed.type, 'regs');
  assert.deepEqual(seen, [0x04]);
  assert.equal(q.stats.unsolicited, 1);
  assert.equal(q.stats.btStatus, 1);
});

function slowTransport({ writeMs, failWrites = 0 }) {
  const t = { connected: true, name: 'slow', writeCalls: 0, inFlightWrites: 0, maxOverlap: 0, dataCbs: [] };
  t.onData = (cb) => t.dataCbs.push(cb);
  t.onDisconnect = () => {};
  t.connect = async () => ({ name: 'slow' });
  t.disconnect = async () => {};
  t.write = () => new Promise((resolve, reject) => {
    t.writeCalls++; t.inFlightWrites++; t.maxOverlap = Math.max(t.maxOverlap, t.inFlightWrites);
    setTimeout(() => { t.inFlightWrites--; if (failWrites > 0) { failWrites--; reject(new Error('GATT operation already in progress')); } else resolve(); }, writeMs);
  });
  return t;
}

test('a timeout while the write is still pending does not start an overlapping write', async () => {
  const t = slowTransport({ writeMs: 70 });
  const q = new Queue(t, new Logger(), { timeoutMs: 30, retries: 1, deadAfter: 5 });
  await assert.rejects(q.send(cmd.checkIdPacket()), TimeoutError);
  assert.equal(t.maxOverlap, 1, 'writes overlapped');
  assert.equal(t.writeCalls, 2, 'expected one resend after the slow write settled');
});

test('a response that arrives after the timer but before the write settles is accepted', async () => {
  const t = slowTransport({ writeMs: 60 });
  const q = new Queue(t, new Logger(), { timeoutMs: 20, retries: 1, deadAfter: 5 });
  const p = q.send(cmd.checkIdPacket());
  setTimeout(() => { for (const cb of t.dataCbs) cb(buildFrame(0x00, [0x0F, 0xA6])); }, 40);
  const res = await p;
  assert.equal(res.parsed.id, 4006);
  assert.equal(t.writeCalls, 1);
});

test('write errors count toward dead detection', async () => {
  const t = slowTransport({ writeMs: 1, failWrites: 3 });
  const q = new Queue(t, new Logger(), { timeoutMs: 30, retries: 0, deadAfter: 2 });
  let dead = 0; q.onDead(() => dead++);
  await assert.rejects(q.send(cmd.checkIdPacket()), /GATT/);
  await assert.rejects(q.send(cmd.checkIdPacket()), /GATT/);
  assert.equal(dead, 1);
});

test('a byte-identical duplicate of the last reply is dropped silently, not reported as unsolicited', async () => {
  const { q, dev, log } = await setup({ latencyMs: 2 }); // FakeDevice duplicates READ replies by default
  const seen = [];
  q.onUnsolicited((f) => seen.push(f[2]));
  await q.send(cmd.readPacket([1242]));
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(seen, []);
  assert.equal(q.stats.duplicates, 1);
  assert.equal(q.stats.unsolicited, 0);
  assert.ok(!log.entries.some((e) => e.level === 'WARN'));
});

test('quiet requests and BT status frames are logged at DEBUG', async () => {
  const { q, log } = await setup({ latencyMs: 0, dupReads: false });
  await q.send(cmd.readPacket([1242]), { quiet: true });
  for (const cb of q.transport.dataCbs) cb(buildFrame(0x71, [1, 2, 3]));
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(log.entries.length >= 3);
  assert.ok(log.entries.every((e) => e.level === 'DEBUG'), log.entries.map((e) => e.level).join(','));
});

test('clear rejects everything pending and in flight', async () => {
  const { q } = await setup({ failSect: true });
  const p1 = q.send(cmd.uploadSectPacket(0));
  const p2 = q.send(cmd.uploadSectPacket(100));
  q.clear(new Error('disconnected'));
  await assert.rejects(p1, /disconnected/);
  await assert.rejects(p2, /disconnected/);
  assert.equal(q.pendingCount, 0);
  assert.equal(q.inFlight, false);
});

test('a resend of a quiet request is logged at DEBUG, a resend of a normal request at WARN', async () => {
  const a = await setup({ dropNext: 1, dupReads: false });
  await a.q.send(cmd.readPacket([1242]), { quiet: true });
  assert.ok(a.log.entries.some((e) => e.text.includes('逾時重送')));
  assert.ok(a.log.entries.every((e) => e.level === 'DEBUG'), a.log.entries.map((e) => `${e.level}:${e.text}`).join('\n'));
  const b = await setup({ dropNext: 1, dupReads: false });
  await b.q.send(cmd.readPacket([1242]));
  assert.ok(b.log.entries.some((e) => e.level === 'WARN' && e.text.includes('逾時重送')));
});
