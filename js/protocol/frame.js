import { crc16 } from './crc16.js';

export const FRAME_HEAD = 0x80;
export const MAX_LEN = 250;
const MIN_TOTAL = 5; // head, len, cmd, crc×2

/** Build [0x80][LEN][CMD][DATA][CRC_HI][CRC_LO]. LEN = total − 2. */
export function buildFrame(cmd, data = []) {
  const total = data.length + MIN_TOTAL;
  if (total - 2 > MAX_LEN) throw new RangeError(`frame too long: ${total - 2} > ${MAX_LEN}`);
  const f = new Uint8Array(total);
  f[0] = FRAME_HEAD;
  f[1] = total - 2;
  f[2] = cmd & 0xFF;
  f.set(data, 3);
  const c = crc16(f, total - 2);
  f[total - 2] = c >> 8;
  f[total - 1] = c & 0xFF;
  return f;
}

/** Validate a complete frame and return { cmd, data }. Throws on error. */
export function parseFrame(bytes) {
  if (bytes.length < MIN_TOTAL) throw new Error('frame too short');
  if (bytes[0] !== FRAME_HEAD) throw new Error('bad head');
  if (bytes[1] + 2 !== bytes.length) throw new Error('length mismatch');
  const want = crc16(bytes, bytes.length - 2);
  const got = (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
  if (want !== got) throw new Error(`bad crc: want ${want.toString(16)} got ${got.toString(16)}`);
  return { cmd: bytes[2], data: bytes.subarray(3, bytes.length - 2) };
}

/** Stream reassembler: feed BLE notification chunks, get complete valid frames. */
export class FrameAssembler {
  constructor() { this.buf = new Uint8Array(0); this.droppedBytes = 0; this.crcErrors = 0; }

  push(chunk) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
    const frames = [];
    for (;;) {
      let i = 0;
      while (i < this.buf.length && this.buf[i] !== FRAME_HEAD) i++;
      if (i > 0) this.#drop(i);
      if (this.buf.length < 2) break;
      const len = this.buf[1];
      if (len > MAX_LEN || len < MIN_TOTAL - 2) { this.#drop(1); continue; }
      const total = len + 2;
      if (this.buf.length < total) break; // wait for more bytes before judging
      const cand = this.buf.subarray(0, total);
      const want = crc16(cand, total - 2);
      const got = (cand[total - 2] << 8) | cand[total - 1];
      if (want === got) {
        frames.push(cand.slice());
        this.buf = this.buf.subarray(total);
      } else {
        this.crcErrors++;
        this.#drop(1);
      }
    }
    return frames;
  }

  reset() { this.buf = new Uint8Array(0); }

  #drop(n) { this.droppedBytes += n; this.buf = this.buf.subarray(n); }
}
