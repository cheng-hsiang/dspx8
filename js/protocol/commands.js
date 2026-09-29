import { buildFrame } from './frame.js';
import { hi, lo, u16 } from './codec.js';
import { DUMP_END } from './addrmap.js';

export const CMD = Object.freeze({
  CHECK_ID: 0x00, CALL_MODE: 0x01, WRITE: 0x03, READ_MODE_NAME: 0x04, READ: 0x06,
  WRITE_MODE_NAME: 0x10, SAVE_MODE: 0x11, DOWNLOAD_SECT: 0x31, UPLOAD_SECT: 0x61,
  BT_READ: 0x71, BT_WRITE: 0x72, UPLOAD_MODE: 0xF0,
});
export const CMD_NAMES = Object.freeze(Object.fromEntries(Object.entries(CMD).map(([k, v]) => [v, k])));
export const WRITE_PAIRS_PER_PACKET = 3;
export const READ_ADDRS_PER_PACKET = 14;
export const SECT_SIZE = 100;

function assertMode(n) { if (!Number.isInteger(n) || n < 1 || n > 8) throw new RangeError(`mode ${n}`); }
function chunk(arr, size) { const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; }

export const checkIdPacket = () => buildFrame(CMD.CHECK_ID, [0, 0]);
export const callModePacket = (n) => { assertMode(n); return buildFrame(CMD.CALL_MODE, [n]); };
export const saveModePacket = (n) => { assertMode(n); return buildFrame(CMD.SAVE_MODE, [n]); };
export const uploadSectPacket = (start) => buildFrame(CMD.UPLOAD_SECT, [hi(start), lo(start)]);

export function writePacket(pairs) {
  if (pairs.length < 1 || pairs.length > WRITE_PAIRS_PER_PACKET) throw new RangeError(`write pairs ${pairs.length}`);
  const d = [];
  for (const { addr, val } of pairs) d.push(hi(addr), lo(addr), hi(val), lo(val));
  return buildFrame(CMD.WRITE, d);
}
export const writePackets = (pairs) => chunk(pairs, WRITE_PAIRS_PER_PACKET).map(writePacket);

export function readPacket(addrs) {
  if (addrs.length < 1 || addrs.length > READ_ADDRS_PER_PACKET) throw new RangeError(`read addrs ${addrs.length}`);
  return buildFrame(CMD.READ, addrs.flatMap((a) => [hi(a), lo(a)]));
}
export const readPackets = (addrs) => chunk(addrs, READ_ADDRS_PER_PACKET).map(readPacket);

export function sectPlan(end = DUMP_END) {
  const starts = [];
  for (let s = 0; s <= end; s += SECT_SIZE) starts.push(s);
  return starts;
}

export function parseResponse({ cmd, data }) {
  switch (cmd) {
    case CMD.CHECK_ID:
      return { type: 'id', id: u16(data[0], data[1]) };
    case CMD.WRITE:
    case CMD.READ: {
      const pairs = [];
      for (let i = 0; i + 3 < data.length; i += 4) pairs.push({ addr: u16(data[i], data[i + 1]), val: u16(data[i + 2], data[i + 3]) });
      return { type: 'regs', cmd, pairs };
    }
    case CMD.UPLOAD_SECT: {
      const start = u16(data[0], data[1]);
      const values = [];
      for (let i = 2; i + 1 < data.length; i += 2) values.push(u16(data[i], data[i + 1]));
      return { type: 'sect', start, values };
    }
    case CMD.CALL_MODE:
    case CMD.SAVE_MODE:
      return { type: 'mode', cmd, mode: data[0] };
    default:
      return { type: 'other', cmd, data };
  }
}

export function matchesRequest(req, resp) {
  if (req[2] !== resp[2]) return false;
  switch (req[2]) {
    case CMD.WRITE:
      if (req.length !== resp.length) return false;
      for (let i = 0; i < req.length; i++) if (req[i] !== resp[i]) return false;
      return true;
    case CMD.READ:
    case CMD.UPLOAD_SECT:
    case CMD.BT_WRITE:
      return req[3] === resp[3] && req[4] === resp[4];
    default:
      return true;
  }
}

export function coalesceKey(frame) {
  const c = frame[2];
  if (c !== CMD.WRITE && c !== CMD.READ) return null;
  return `${c}:${u16(frame[3], frame[4])}:${frame.length}`;
}
