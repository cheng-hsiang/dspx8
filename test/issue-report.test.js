import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIssueReport, CONTACT } from '../js/help/issue-report.js';

test('issue report: a header the owner fills in, then the log, in a form that can be pasted anywhere', () => {
  const text = buildIssueReport({ version: '0.6.0', userAgent: 'TestUA/1.0', deviceName: 'Mango3.0', logText: '      0 INFO   啟動 版本 0.6.0\n   1200 ERR    連線失敗：x' });
  const lines = text.split('\n');
  assert.equal(lines[0], '【DSP-X8s 調音網頁 問題回報】');
  assert.ok(text.includes('版本：0.6.0'));
  assert.ok(text.includes('瀏覽器：TestUA/1.0'));
  assert.ok(text.includes('機器：Mango3.0'));
  assert.ok(text.includes('問題描述：'), 'a place for the owner to say what went wrong');
  assert.ok(text.indexOf('----- 日誌 -----') < text.indexOf('連線失敗：x'));
  assert.ok(text.endsWith('----- 日誌結束 -----'));
});

test('issue report without a connection or log still says so instead of leaving blanks', () => {
  const text = buildIssueReport({ version: '0.6.0', userAgent: 'UA', deviceName: '', logText: '' });
  assert.ok(text.includes('機器：（未連線）'));
  assert.ok(text.includes('（沒有日誌）'));
});

test('contact points at the public issue tracker', () => {
  assert.match(CONTACT.issuesUrl, /^https:\/\/github\.com\/cheng-hsiang\/dspx8\/issues/);
});
