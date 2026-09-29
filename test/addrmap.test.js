import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as a from '../js/protocol/addrmap.js';

test('layout constants', () => {
  assert.equal(a.REG_COUNT, 1679);
  assert.equal(a.DUMP_END, 1612);
  assert.equal(a.MODE_END, 1226);
  assert.equal(a.CH_BASE + a.CH_COUNT * a.CH_STRIDE, a.MODE_END);
});

test('channel filter addresses', () => {
  assert.equal(a.channelBase(1), 138);
  assert.equal(a.channelBase(8), 1090);
  assert.equal(a.eqAddr(1, 3, 'G'), 156);
  assert.equal(a.eqAddr(8, 32, 'Q'), 1225);
  assert.equal(a.xoverAddr(1, 1, 'TYPE'), 138);
  assert.equal(a.xoverAddr(8, 2, 'Q'), 1097);
  assert.throws(() => a.eqAddr(0, 1, 'G'), RangeError);
  assert.throws(() => a.eqAddr(1, 33, 'G'), RangeError);
  assert.throws(() => a.eqAddr(1, 1, 'X'), RangeError);
});

test('isTypeAddr flags every TYPE field and nothing else in the channel region', () => {
  assert.equal(a.isTypeAddr(138), true);   // CH1 xover1 TYPE
  assert.equal(a.isTypeAddr(142), true);   // CH1 xover2 TYPE
  assert.equal(a.isTypeAddr(146), true);   // CH1 EQ1 TYPE
  assert.equal(a.isTypeAddr(156), false);  // CH1 EQ3 G
  assert.equal(a.isTypeAddr(1222), true);  // CH8 EQ32 TYPE
  assert.equal(a.isTypeAddr(59), false);
  assert.equal(a.isTypeAddr(1252), false); // IIR100 layer is not guarded here
});

test('isWritableAddr allows only EQ F/G/Q and the listed sound registers', () => {
  for (const ch of [1, 8]) for (const band of [1, 32]) for (const f of ['F', 'G', 'Q']) assert.equal(a.isWritableAddr(a.eqAddr(ch, band, f)), true, `eq ${ch} ${band} ${f}`);
  assert.equal(a.isWritableAddr(a.eqAddr(1, 1, 'TYPE')), false);
  assert.equal(a.isWritableAddr(a.xoverAddr(1, 1, 'F')), false);
  assert.equal(a.isWritableAddr(a.xoverAddr(8, 2, 'Q')), false);
  for (let ch = 1; ch <= 8; ch++) {
    assert.equal(a.isWritableAddr(a.ADDR.muteOfChannel(ch)), true);
    assert.equal(a.isWritableAddr(a.ADDR.mix11(ch)), true);
    assert.equal(a.isWritableAddr(a.ADDR.mix41(ch, 1)), true);
    assert.equal(a.isWritableAddr(a.ADDR.delay(ch)), true);
  }
  assert.equal(a.isWritableAddr(a.ADDR.M0_INPUT_SET), true);
  for (const f of ['F', 'G', 'Q']) assert.equal(a.isWritableAddr(a.ADDR.iir100(1, 1, f)), true, `app layer ${f}`);
  assert.equal(a.isWritableAddr(a.ADDR.iir100(8, 10, 'Q')), true);
  assert.equal(a.isWritableAddr(a.ADDR.iir100(8, 10, 'TYPE')), false);
  for (const bad of [0, a.ADDR.mute(1), a.ADDR.mute(10), a.ADDR.mix11(9), a.ADDR.mix41(1, 2), a.ADDR.switch21(2), a.ADDR.delay(9), a.ADDR.compressor(3, 0), a.MODE_END, a.ADDR.M0_MODE, a.ADDR.M0_INPUT_CUR, a.ADDR.iir100(1, 1, 'TYPE'), 1572, a.ADDR.USB_L_VOL, a.ADDR.APP_END, 1613, 5000, -1]) {
    assert.equal(a.isWritableAddr(bad), false, `addr ${bad} should be refused`);
  }
});

test('named registers', () => {
  assert.equal(a.ADDR.mute(2), 2);
  assert.equal(a.ADDR.muteOfChannel(1), 2);
  assert.equal(a.ADDR.mix11(1), 12);
  assert.equal(a.ADDR.mix11(8), 19);
  assert.equal(a.ADDR.mix41(1, 1), 26);
  assert.equal(a.ADDR.mix41(8, 4), 57);
  assert.equal(a.ADDR.switch21(2), 59);
  assert.equal(a.ADDR.EQ_BYPASS_SWITCH, 59);
  assert.equal(a.ADDR.delay(1), 73);
  assert.equal(a.ADDR.delay(9), 81);
  assert.equal(a.ADDR.compressor(3, 0), 82);
  assert.equal(a.ADDR.compressor(10, 6), 137);
  assert.equal(a.ADDR.m0(8), 1234);
  assert.equal(a.ADDR.M0_INPUT_SET, 1234);
  assert.equal(a.ADDR.M0_MODE, 1242);
  assert.equal(a.ADDR.M0_INPUT_CUR, 1248);
  assert.equal(a.ADDR.iir100(1, 1, a.FIELD.G), 1254);
  assert.equal(a.ADDR.iir100(8, 10, a.FIELD.Q), 1571);
  assert.equal(a.ADDR.USB_L_VOL, 1588);
  assert.equal(a.ADDR.APP_END, 1612);
  assert.deepEqual(a.HEARTBEAT_ADDRS, [1248, 1242, 1588]);
});

test('describeAddr names every region', () => {
  assert.equal(a.describeAddr(0), 'MACHINE_TYPE');
  assert.equal(a.describeAddr(2), 'MUTE_2');
  assert.equal(a.describeAddr(12), 'MIX11_1');
  assert.equal(a.describeAddr(30), 'MIX41_2_1');
  assert.equal(a.describeAddr(59), 'SWITCH21_2');
  assert.equal(a.describeAddr(73), 'DELAY_1');
  assert.equal(a.describeAddr(83), 'COMP3_RATIO');
  assert.equal(a.describeAddr(138), 'CH1 XOVER1 TYPE');
  assert.equal(a.describeAddr(156), 'CH1 EQ3 G');
  assert.equal(a.describeAddr(1225), 'CH8 EQ32 Q');
  assert.equal(a.describeAddr(1226), 'MODE_END');
  assert.equal(a.describeAddr(1242), 'M0_16');
  assert.equal(a.describeAddr(1251), 'M0_END');
  assert.equal(a.describeAddr(1254), 'APPEQ CH1 B1 G');
  assert.equal(a.describeAddr(1572), 'STRAIGHT_L_VOL');
  assert.equal(a.describeAddr(1588), 'USB_L_VOL');
  assert.equal(a.describeAddr(1603), 'OPT_COX_CH8_VOL');
  assert.equal(a.describeAddr(1604), 'APP_VAR_1');
  assert.equal(a.describeAddr(1612), 'APP_END');
  assert.equal(a.describeAddr(1614), 'CONTROL1_1');
  assert.equal(a.describeAddr(1678), 'ALL_END');
  assert.equal(a.describeAddr(5000), 'ADDR_5000');
});
