import { TransportError } from './transport.js';
import { FrameAssembler, buildFrame } from '../protocol/frame.js';
import { CMD, parseResponse } from '../protocol/commands.js';
import { hi, lo, encodeFreq, encodeGain } from '../protocol/codec.js';
import { REG_COUNT, MODE_END, CH_COUNT, EQ_SLOTS, ADDR, eqAddr, xoverAddr } from '../protocol/addrmap.js';
import { INPUT } from '../protocol/tables.js';

// Band centre frequencies exactly as the real DSP-X8s reports them (dump 2026-09-30)
const DEVICE_EQ_F = [20.1, 25.3, 32.5, 40.1, 50.6, 63.7, 80.3, 101, 125, 161, 202, 250, 315, 405, 500, 630, 809, 1000, 1260, 1620,
  2000, 2520, 3170, 4000, 5040, 6350, 8000, 10100, 12500, 16000, 20200];
const DEVICE_APP_F = [60, 350, 2000, 10100, 250, 809, 3170, 6350, 8000, 20000];
const BT_STATUS_A = [0x00, 0x06, 0x01, 0x1F, 0, 0, 0, 0, 0, 0, 0x02, 0x08];
const BT_STATUS_B = [0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** In-memory DSP-X8s stand-in implementing the Transport interface. */
export class FakeDevice {
  constructor({ latencyMs = 2, chunkSize = 20, customerId = 4006, failSect = false, dropNext = 0, sectLimit = 80, omitReadAddrs = [], dupReads = true, btStatusMs = 0, name = 'Mango3.0-SIM' } = {}) {
    Object.assign(this, { latencyMs, chunkSize, customerId, failSect, dropNext, sectLimit, dupReads, btStatusMs, name });
    this.btTimer = null; this.btToggle = false;
    this.txChain = Promise.resolve(); // outgoing frames are sent one after another, never interleaved
    this.omitReadAddrs = new Set(omitReadAddrs); // addresses silently left out of READ replies (test hook)
    this.connected = false;
    this.regs = new Uint16Array(REG_COUNT);
    this.slots = Array.from({ length: 8 }, () => new Uint16Array(MODE_END));
    this.currentMode = 1;
    this.sent = [];
    this.dataCbs = [];
    this.disconnectCbs = [];
    this.asm = new FrameAssembler();
    this.seedDefaults();
  }

  seedDefaults() {
    const r = this.regs;
    r.fill(0);
    r[ADDR.MACHINE_TYPE] = 13357;
    for (let ch = 1; ch <= CH_COUNT; ch++) {
      // crossovers parked wide open, as on the real unit: TYPE 20 HPF @ 10 Hz, TYPE 21 LPF @ 20.6 kHz, Q raw 40
      r[xoverAddr(ch, 1, 'TYPE')] = 20; r[xoverAddr(ch, 1, 'F')] = encodeFreq(10); r[xoverAddr(ch, 1, 'G')] = 500; r[xoverAddr(ch, 1, 'Q')] = 40;
      r[xoverAddr(ch, 2, 'TYPE')] = 21; r[xoverAddr(ch, 2, 'F')] = 20600; r[xoverAddr(ch, 2, 'G')] = 500; r[xoverAddr(ch, 2, 'Q')] = 40;
      for (let b = 1; b <= EQ_SLOTS; b++) {
        r[eqAddr(ch, b, 'TYPE')] = 7;
        r[eqAddr(ch, b, 'F')] = b <= 31 ? encodeFreq(DEVICE_EQ_F[b - 1]) : 20000;
        r[eqAddr(ch, b, 'G')] = encodeGain(0);
        r[eqAddr(ch, b, 'Q')] = b <= 31 ? 240 : 400;
      }
      r[ADDR.mix11(ch)] = 600;
      r[ADDR.mix41(1, ch)] = 600; // input 1 feeds every output; inputs 2-4 unused
      DEVICE_APP_F.forEach((hz, i) => {
        r[ADDR.iir100(ch, i + 1, 0)] = 7; r[ADDR.iir100(ch, i + 1, 1)] = encodeFreq(hz);
        r[ADDR.iir100(ch, i + 1, 2)] = 500; r[ADDR.iir100(ch, i + 1, 3)] = 119;
      });
      for (let n = 3; n <= 10; n++) { r[ADDR.compressor(n, 1)] = 100; r[ADDR.compressor(n, 2)] = 450; r[ADDR.compressor(n, 3)] = 32; r[ADDR.compressor(n, 4)] = 500; r[ADDR.compressor(n, 6)] = 20; }
    }
    for (let n = 1; n <= 15; n++) r[ADDR.switch21(n)] = 1;
    r[ADDR.M0_MODE] = 1;
    r[ADDR.M0_INPUT_SET] = INPUT.HIGH_LEVEL;
    r[ADDR.M0_INPUT_CUR] = 0x10 | INPUT.HIGH_LEVEL; // real unit reports 19: input 3 plus an unknown high bit
    for (let a = 1572; a <= 1603; a++) r[a] = a >= 1588 && a <= 1595 ? 510 : 600; // per-input volumes; USB at 10
    r[ADDR.USB_L_VOL] = 510;
    for (const slot of this.slots) slot.set(r.subarray(0, MODE_END));
    this.currentMode = 1;
  }

  setRegister(addr, val) { this.regs[addr] = val & 0xFFFF; }
  pokeMode(n) { this.regs.set(this.slots[n - 1], 0); this.regs[ADDR.M0_MODE] = n; this.currentMode = n; }

  async connect() {
    this.connected = true; this.asm.reset();
    if (this.btStatusMs > 0) this.btTimer = setInterval(() => { this.btToggle = !this.btToggle; this.#emit(buildFrame(CMD.BT_READ, this.btToggle ? BT_STATUS_A : BT_STATUS_B)); }, this.btStatusMs);
    return { name: this.name };
  }
  async disconnect() { if (!this.connected) return; this.connected = false; if (this.btTimer) { clearInterval(this.btTimer); this.btTimer = null; } for (const cb of this.disconnectCbs) cb(); }
  onData(cb) { this.dataCbs.push(cb); }
  onDisconnect(cb) { this.disconnectCbs.push(cb); }

  async write(bytes) {
    if (!this.connected) throw new TransportError('not connected', 'NOT_CONNECTED');
    for (const frame of this.asm.push(bytes)) {
      this.sent.push(frame);
      if (this.failSect && frame[2] === CMD.UPLOAD_SECT) continue; // simulated dead segment reads, not counted as drops
      if (this.dropNext > 0) { this.dropNext--; continue; }
      const resp = this.#handle(frame);
      if (resp) {
        this.#emit(resp); // not awaited: responses arrive asynchronously like BLE notifications
        if (this.dupReads && frame[2] === CMD.READ) setTimeout(() => this.#emit(resp), Math.max(1, this.latencyMs) + 25); // the real unit repeats READ replies once
      }
    }
  }

  #handle(frame) {
    const cmd = frame[2];
    const data = frame.subarray(3, frame.length - 2);
    const parsed = parseResponse({ cmd, data });
    switch (cmd) {
      case CMD.CHECK_ID: return buildFrame(cmd, [hi(this.customerId), lo(this.customerId)]);
      case CMD.READ: {
        const out = [];
        for (let i = 0; i + 1 < data.length; i += 2) {
          const a = (data[i] << 8) | data[i + 1];
          if (this.omitReadAddrs.has(a)) continue;
          out.push(data[i], data[i + 1], hi(this.regs[a] ?? 0), lo(this.regs[a] ?? 0));
        }
        return buildFrame(cmd, out);
      }
      case CMD.WRITE:
        for (const { addr, val } of parsed.pairs) {
          if (addr < REG_COUNT) this.regs[addr] = val;
          if (addr === ADDR.M0_INPUT_SET) this.regs[ADDR.M0_INPUT_CUR] = 0x10 | (val & 0x0F); // the unit reports the selected input in M0_22
        }
        return frame.slice();
      case CMD.UPLOAD_SECT: {
        if (this.failSect) return null;
        const start = (data[0] << 8) | data[1];
        const out = [data[0], data[1]];
        for (let a = start; a < Math.min(start + Math.min(100, this.sectLimit), REG_COUNT); a++) out.push(hi(this.regs[a]), lo(this.regs[a]));
        return buildFrame(cmd, out);
      }
      case CMD.CALL_MODE: { const n = data[0]; if (n >= 1 && n <= 8) this.pokeMode(n); return buildFrame(cmd, [n]); }
      case CMD.SAVE_MODE: { const n = data[0]; if (n >= 1 && n <= 8) this.slots[n - 1].set(this.regs.subarray(0, MODE_END)); return buildFrame(cmd, [n]); }
      default: return null;
    }
  }

  #emit(resp) {
    this.txChain = this.txChain.then(() => this.#emitNow(resp)).catch(() => {});
    return this.txChain;
  }

  async #emitNow(resp) {
    for (let i = 0; i < resp.length; i += this.chunkSize) {
      // latency 0 → microtask hop only; setTimeout granularity on Windows (~15 ms) would otherwise dominate
      if (this.latencyMs > 0) await sleep(this.latencyMs); else await Promise.resolve();
      if (!this.connected) return;
      const chunk = resp.slice(i, i + this.chunkSize);
      for (const cb of this.dataCbs) cb(chunk);
    }
  }
}
