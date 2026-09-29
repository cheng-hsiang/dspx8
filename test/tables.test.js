import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TAB_FREQ, TAB_Q, CUSTOMER_ID, INPUT, INPUT_NAMES, DEFAULT_CHANNEL_NAMES } from '../js/protocol/tables.js';

test('frequency table spans 19.7 Hz to 20.6 kHz, non-decreasing', () => {
  assert.equal(TAB_FREQ.length, 364);
  assert.equal(TAB_FREQ[0], 19.7);
  assert.equal(TAB_FREQ.at(-1), 20600);
  for (let i = 1; i < TAB_FREQ.length; i++) assert.ok(TAB_FREQ[i] >= TAB_FREQ[i - 1]);
});

test('Q table spans 0.4 to 128, strictly increasing', () => {
  assert.equal(TAB_Q.length, 101);
  assert.equal(TAB_Q[0], 0.4);
  assert.equal(TAB_Q.at(-1), 128);
  for (let i = 1; i < TAB_Q.length; i++) assert.ok(TAB_Q[i] > TAB_Q[i - 1]);
});

test('constants', () => {
  assert.equal(CUSTOMER_ID, 4006);
  assert.equal(INPUT.USB, 7);
  assert.equal(INPUT_NAMES[INPUT.BT], '藍牙');
  assert.equal(DEFAULT_CHANNEL_NAMES.length, 8);
});
