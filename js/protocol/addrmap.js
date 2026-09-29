export const REG_COUNT = 1679;
export const DUMP_END = 1612;   // inclusive; ID_APP_END, equals MP23X length
export const MODE_END = 1226;
export const CH_COUNT = 8;
export const CH_BASE = 138;
export const CH_STRIDE = 136;   // 2 xover filters ×4 + 32 EQ slots ×4
export const EQ_SLOTS = 32;
export const XOVER_SLOTS = 2;
export const FIELD = Object.freeze({ TYPE: 0, F: 1, G: 2, Q: 3 });
export const FIELD_NAMES = ['TYPE', 'F', 'G', 'Q'];
const COMP_PARAMS = ['TYPE', 'RATIO', 'ATTACK', 'DECAY', 'THRESHOLD', 'OUTGAIN', 'KNEE'];
const INPUT_VOL_GROUPS = ['STRAIGHT', 'BT', 'USB', 'OPT_COX'];
const INPUT_VOL_CH = ['L', 'R', 'SL', 'SR', 'CEN', 'SW', 'CH7', 'CH8'];

function check(cond, msg) { if (!cond) throw new RangeError(msg); }

function fieldIndex(field) {
  const f = typeof field === 'number' ? field : FIELD[field];
  check(f !== undefined && f >= 0 && f <= 3, `bad field ${field}`);
  return f;
}

export const ADDR = Object.freeze({
  MACHINE_TYPE: 0,
  mute: (n) => { check(n >= 1 && n <= 11, `mute ${n}`); return n; },
  muteOfChannel: (ch) => { check(ch >= 1 && ch <= CH_COUNT, `ch ${ch}`); return ch + 1; },
  mix11: (n) => { check(n >= 1 && n <= 14, `mix11 ${n}`); return 11 + n; },
  mix41: (k, i) => { check(k >= 1 && k <= 8 && i >= 1 && i <= 4, `mix41 ${k},${i}`); return 26 + (k - 1) * 4 + (i - 1); },
  switch21: (n) => { check(n >= 1 && n <= 15, `switch21 ${n}`); return 57 + n; },
  EQ_BYPASS_SWITCH: 59,
  delay: (n) => { check(n >= 1 && n <= 9, `delay ${n}`); return 72 + n; },
  compressor: (n, p) => { check(n >= 3 && n <= 10 && p >= 0 && p <= 6, `comp ${n},${p}`); return 82 + (n - 3) * 7 + p; },
  m0: (n) => { check(n >= 1 && n <= 24, `m0 ${n}`); return 1226 + n; },
  M0_INPUT_SET: 1234,
  M0_MODE: 1242,
  M0_INPUT_CUR: 1248,
  iir100: (ch, band, field) => {
    check(ch >= 1 && ch <= 8 && band >= 1 && band <= 10, `iir100 ${ch},${band}`);
    return 1252 + (ch - 1) * 40 + (band - 1) * 4 + fieldIndex(field);
  },
  USB_L_VOL: 1588,
  APP_END: 1612,
});

export const HEARTBEAT_ADDRS = [ADDR.M0_INPUT_CUR, ADDR.M0_MODE, ADDR.USB_L_VOL];

export function channelBase(ch) {
  check(Number.isInteger(ch) && ch >= 1 && ch <= CH_COUNT, `channel ${ch}`);
  return CH_BASE + (ch - 1) * CH_STRIDE;
}

export function xoverAddr(ch, n, field) {
  check(n >= 1 && n <= XOVER_SLOTS, `xover ${n}`);
  return channelBase(ch) + (n - 1) * 4 + fieldIndex(field);
}

export function eqAddr(ch, band, field) {
  check(Number.isInteger(band) && band >= 1 && band <= EQ_SLOTS, `band ${band}`);
  return channelBase(ch) + XOVER_SLOTS * 4 + (band - 1) * 4 + fieldIndex(field);
}

/** True for any TYPE field inside the 8-channel filter region. */
export function isTypeAddr(addr) {
  if (addr < CH_BASE || addr >= MODE_END) return false;
  return (addr - CH_BASE) % 4 === 0;
}

export function describeAddr(addr) {
  if (addr === 0) return 'MACHINE_TYPE';
  if (addr <= 11) return `MUTE_${addr}`;
  if (addr <= 25) return `MIX11_${addr - 11}`;
  if (addr <= 57) return `MIX41_${Math.floor((addr - 26) / 4) + 1}_${((addr - 26) % 4) + 1}`;
  if (addr <= 72) return `SWITCH21_${addr - 57}`;
  if (addr <= 81) return `DELAY_${addr - 72}`;
  if (addr <= 137) return `COMP${Math.floor((addr - 82) / 7) + 3}_${COMP_PARAMS[(addr - 82) % 7]}`;
  if (addr < MODE_END) {
    const rel = addr - CH_BASE;
    const ch = Math.floor(rel / CH_STRIDE) + 1;
    const off = rel % CH_STRIDE;
    const field = FIELD_NAMES[off % 4];
    if (off < XOVER_SLOTS * 4) return `CH${ch} XOVER${Math.floor(off / 4) + 1} ${field}`;
    return `CH${ch} EQ${Math.floor((off - XOVER_SLOTS * 4) / 4) + 1} ${field}`;
  }
  if (addr === MODE_END) return 'MODE_END';
  if (addr <= 1250) return `M0_${addr - 1226}`;
  if (addr === 1251) return 'M0_END';
  if (addr <= 1571) {
    const rel = addr - 1252;
    return `APPEQ CH${Math.floor(rel / 40) + 1} B${Math.floor((rel % 40) / 4) + 1} ${FIELD_NAMES[rel % 4]}`;
  }
  if (addr <= 1603) {
    const rel = addr - 1572;
    return `${INPUT_VOL_GROUPS[Math.floor(rel / 8)]}_${INPUT_VOL_CH[rel % 8]}_VOL`;
  }
  if (addr <= 1611) return `APP_VAR_${addr - 1603}`;
  if (addr === 1612) return 'APP_END';
  if (addr === 1613) return 'OTHER_1';
  if (addr <= 1677) return `CONTROL${Math.floor((addr - 1614) / 8) + 1}_${((addr - 1614) % 8) + 1}`;
  if (addr === 1678) return 'ALL_END';
  return `ADDR_${addr}`;
}
