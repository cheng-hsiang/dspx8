import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, inferQScale } from '../js/core/report.js';
import { RegisterStore } from '../js/core/store.js';
import { FakeDevice } from '../js/transport/fake-device.js';
import { eqAddr } from '../js/protocol/addrmap.js';

function seededStore() {
  const dev = new FakeDevice();
  const store = new RegisterStore();
  store.setMany(Array.from({ length: store.size }, (_, addr) => ({ addr, val: dev.regs[addr] })));
  return store;
}
const env = { userAgent: 'TestUA/1.0', webBluetooth: true, bluefy: false, standalone: false, secure: true };
const info = { name: 'DSP-X8s-SIM', customerId: 4006, connectedAt: 0 };
const dumpInfo = { complete: true, ms: 1234, failedSegments: [], method: 'sect' };

test('inferQScale', () => {
  const store = seededStore();
  assert.equal(inferQScale(store).verdict, 'device-default'); // seeded raw 240 = the real device's factory value
  for (let ch = 1; ch <= 8; ch++) store.set(eqAddr(ch, 1, 'Q'), 100);
  assert.equal(inferQScale(store).verdict, 'no-qrate');
  for (let ch = 1; ch <= 8; ch++) store.set(eqAddr(ch, 1, 'Q'), 32);
  assert.equal(inferQScale(store).verdict, 'qrate');
  store.set(eqAddr(3, 1, 'Q'), 900);
  assert.equal(inferQScale(store).verdict, 'unclear');
});

test('report contains every mandated section', () => {
  const store = seededStore();
  const text = buildReport({ env, info, dumpInfo, store, writeTest: { addr: 156, name: 'CH1 EQ3 G', before: 500, sent: 560, readBack: 560, ok: true, ms: 88 } });
  assert.ok(text.startsWith('===== 報告摘要 ====='));
  assert.ok(text.trimEnd().endsWith('===== 報告結束 ====='));
  for (const needle of ['TestUA/1.0', 'DSP-X8s-SIM', '客戶代碼: 4006', '整機讀取: 完整', '1234 ms', 'CH1 XOVER', 'CH1 EQ1', 'CH1 EQ2', 'CH1 EQ3', 'CH1 EQ32', 'Q 推斷', 'MUTE_1', 'MIX11_1', 'MIX41 IN1 CH1', 'SWITCH21_1', 'DELAY_1', 'M0_1', '寫入測試', '送出 560', 'ok']) {
    assert.ok(text.includes(needle), `missing ${needle}`);
  }
});

test('report without writeTest says so and lists failed segments', () => {
  const store = seededStore();
  const text = buildReport({ env, info, dumpInfo: { complete: false, ms: 5, failedSegments: [300, 400], method: 'mixed' }, store });
  assert.ok(text.includes('整機讀取: 不完整'));
  assert.ok(text.includes('失敗區段: 300, 400'));
  assert.ok(text.includes('寫入測試: 未執行'));
});
