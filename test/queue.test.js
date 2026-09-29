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

test('unsolicited frames are reported and do not ack the in-flight request', async () => {
  const { q, dev } = await setup({ latencyMs: 5 });
  const seen = [];
  q.onUnsolicited((f) => seen.push(f[2]));
  const p = q.send(cmd.readPacket([1242]));
  // inject a BT_READ notification while the read is in flight
  for (const cb of dev.dataCbs) cb(buildFrame(0x71, [1, 2, 3]));
  const res = await p;
  assert.equal(res.parsed.type, 'regs');
  assert.deepEqual(seen, [0x71]);
  assert.equal(q.stats.unsolicited, 1);
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
