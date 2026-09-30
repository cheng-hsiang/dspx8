import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errText } from '../js/util/errors.js';

test('errText never yields "undefined": handles Error, empty-message DOMException-like, string and nothing', () => {
  assert.equal(errText(new Error('boom')), 'boom');
  assert.equal(errText({ name: 'NotFoundError', message: '' }), 'NotFoundError');
  assert.equal(errText('plain'), 'plain');
  assert.equal(errText(undefined), '無錯誤訊息');
  assert.equal(errText(null), '無錯誤訊息');
  assert.equal(errText({}), '無錯誤訊息');
});
