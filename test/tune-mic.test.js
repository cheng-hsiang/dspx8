import { test } from 'node:test';
import assert from 'node:assert/strict';
import { micLimitHz, micCheck } from '../js/tune/mic-check.js';
import { parseMicCal, calAtBands } from '../js/tune/mic-cal.js';
import { planCorrection, targetCurve, NOTE_TEXT } from '../js/tune/plan.js';
import { THIRD_EXACT } from '../js/tune/iec.js';

const flat = (v = -40) => new Float64Array(31).fill(v);

test('micLimitHz: finds where a browser or microphone has filtered the top of the spectrum away', () => {
  assert.equal(micLimitHz(flat()), null);
  const cut = flat(); for (let i = 26; i < 31; i++) cut[i] = -200; // nothing from 8 kHz up
  assert.equal(micLimitHz(cut), 8000);
  const steep = flat(); steep[29] = -85; steep[30] = -120;
  assert.equal(micLimitHz(steep), 16000);
  const gentle = Float64Array.from(flat(), (v, i) => v - Math.max(0, i - 20) * 2.4); // a speaker rolling off, −24 dB at 20 kHz
  assert.equal(micLimitHz(gentle), null);
  const dip = flat(); dip[10] = -200; // a hole in the middle is not a band limit
  assert.equal(micLimitHz(dip), null);
  assert.equal(micLimitHz(flat(-200)), null, 'total silence is reported separately');
});

test('micCheck: all-zero samples mean the browser delivers no audio at all', () => {
  assert.deepEqual(micCheck({ peakDb: -200, bands: flat(-200) }), { silent: true, limitHz: null });
  assert.deepEqual(micCheck({ peakDb: -31, bands: flat() }), { silent: false, limitHz: null });
  const cut = flat(); for (let i = 24; i < 31; i++) cut[i] = -190;
  assert.deepEqual(micCheck({ peakDb: -20, bands: cut }), { silent: false, limitHz: 5000 });
});

test('planCorrection leaves the bands the microphone cannot hear alone', () => {
  const m = flat(0); for (let i = 26; i < 31; i++) m[i] = -150;
  const T = targetCurve({ bassDb: 0, trebleDb: 0 });
  const open = planCorrection({ measured: m, eqOld: flat(0), target: T, group: 'front' });
  assert.ok(open.gains[27] > 0, 'without the guard the fitter would boost into the hole');
  const p = planCorrection({ measured: m, eqOld: flat(0), target: T, group: 'front', maxHz: micLimitHz(m) });
  for (let i = 26; i < 31; i++) assert.equal(p.gains[i], 0, `band ${i}`);
  for (let i = 26; i < 30; i++) assert.equal(p.notes[i], 'mic');
  assert.ok(NOTE_TEXT.mic);
  assert.equal(p.gains[20], 0);
});

test('parseMicCal reads REW / miniDSP / Dayton style calibration files', () => {
  const text = [
    '"Sens Factor =-1.858dB, SERNO: 7001234"',
    '* comment line',
    '20.000\t-3.20',
    '100.0  -0.50  12.0',
    '1000,0.0',
    '10000.0\t1.5',
    '20000.0\t4.0',
    '',
  ].join('\r\n');
  const cal = parseMicCal(text);
  assert.equal(cal.length, 5);
  assert.deepEqual(cal[0], { f: 20, db: -3.2 });
  assert.deepEqual(cal[1], { f: 100, db: -0.5 });
  assert.deepEqual(cal[4], { f: 20000, db: 4 });
  assert.throws(() => parseMicCal('hello\nworld'), /校正檔/);
  assert.throws(() => parseMicCal('1000 0\n2000 0'), /校正檔/);
  assert.deepEqual(parseMicCal('2000 1\n1000 0\n500 -1\n250 -2\n125 -3').map((p) => p.f), [125, 250, 500, 1000, 2000], 'sorted');
});

test('calAtBands interpolates on a log-frequency axis and holds the ends', () => {
  const cal = [{ f: 100, db: -2 }, { f: 1000, db: 0 }, { f: 10000, db: 4 }];
  const c = calAtBands(cal);
  assert.equal(c.length, 31);
  assert.ok(Math.abs(c[17]) < 1e-9, '1 kHz');
  assert.ok(Math.abs(c[0] + 2) < 1e-9 && Math.abs(c[30] - 4) < 1e-9, 'ends held');
  const i316 = THIRD_EXACT.findIndex((f) => Math.abs(f - 316.2) < 1);
  assert.ok(Math.abs(c[i316] + 1) < 0.01, 'half-way between 100 Hz and 1 kHz on a log axis');
});
