import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Storage, LogPersister } from '../js/core/storage.js';
import { Logger } from '../js/core/logger.js';

test('memory backend when indexedDB is unavailable', async () => {
  const s = await Storage.open({ indexedDB: undefined });
  assert.equal(s.backend, 'memory');
  await s.put('snapshots', 'a', { ts: 1 });
  await s.put('snapshots', 'b', { ts: 2 });
  assert.deepEqual(await s.get('snapshots', 'a'), { ts: 1 });
  assert.equal((await s.getAll('snapshots')).length, 2);
  await s.delete('snapshots', 'a');
  assert.equal(await s.get('snapshots', 'a'), undefined);
  await s.clear('snapshots');
  assert.equal((await s.getAll('snapshots')).length, 0);
  await assert.rejects(s.put('nope', 'k', 1), /unknown store/);
});

test('LogPersister flushes on batch size, on interval, and on stop; loadLast restores', async () => {
  const s = await Storage.open({ indexedDB: undefined });
  const log = new Logger();
  const p = new LogPersister(log, s, { batch: 3, intervalMs: 20 });
  p.start();
  log.info('1'); log.info('2');
  assert.equal(await LogPersister.loadLast(s), null);
  log.info('3');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal((await LogPersister.loadLast(s)).length, 3);
  log.info('4');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal((await LogPersister.loadLast(s)).length, 4);
  log.info('5');
  await p.stop();
  assert.equal((await LogPersister.loadLast(s)).length, 5);
  const meta = await s.get('logs', 'meta');
  assert.equal(meta.count, 5);
});
