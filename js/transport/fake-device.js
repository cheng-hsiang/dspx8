import { TransportError } from './transport.js';
import { FrameAssembler, buildFrame } from '../protocol/frame.js';
import { CMD, parseResponse } from '../protocol/commands.js';
import { hi, lo, encodeFreq, encodeGain, encodeQ } from '../protocol/codec.js';
import { REG_COUNT, MODE_END, CH_COUNT, EQ_SLOTS, ADDR, eqAddr, xoverAddr } from '../protocol/addrmap.js';
import { INPUT } from '../protocol/tables.js';

const ISO31 = [20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600,
  2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** In-memory DSP-X8s stand-in implementing the Transport interface. */
export class FakeDevice {
  constructor({ latencyMs = 2, chunkSize = 20, customerId = 4006, failSect = false, dropNext = 0, name = 'DSP-X8s-SIM' } = {}) {
    Object.assign(this, { latencyMs, chunkSize, customerId, failSect, dropNext, name });
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
    for (let ch = 1; ch <= CH_COUNT; ch++) {
      r[xoverAddr(ch, 1, 'TYPE')] = 1; r[xoverAddr(ch, 1, 'F')] = encodeFreq(20); r[xoverAddr(ch, 1, 'G')] = 500; r[xoverAddr(ch, 1, 'Q')] = 71;
      r[xoverAddr(ch, 2, 'TYPE')] = 2; r[xoverAddr(ch, 2, 'F')] = encodeFreq(20000); r[xoverAddr(ch, 2, 'G')] = 500; r[xoverAddr(ch, 2, 'Q')] = 71;
      for (let b = 1; b <= EQ_SLOTS; b++) {
        if (b <= ISO31.length) {
          r[eqAddr(ch, b, 'TYPE')] = 1; r[eqAddr(ch, b, 'F')] = encodeFreq(ISO31[b - 1]);
          r[eqAddr(ch, b, 'G')] = encodeGain(0); r[eqAddr(ch, b, 'Q')] = encodeQ(4.32);
        }
      }
      r[ADDR.mix11(ch)] = 570;
      r[ADDR.mix41(ch, 1)] = 0;
    }
    r[ADDR.EQ_BYPASS_SWITCH] = 1;
    r[ADDR.M0_MODE] = 1;
    r[ADDR.M0_INPUT_SET] = INPUT.BT;
    r[ADDR.M0_INPUT_CUR] = INPUT.BT;
    r[ADDR.USB_L_VOL] = 530;
    for (const slot of this.slots) slot.set(r.subarray(0, MODE_END));
    this.currentMode = 1;
  }

  setRegister(addr, val) { this.regs[addr] = val & 0xFFFF; }
  pokeMode(n) { this.regs.set(this.slots[n - 1], 0); this.regs[ADDR.M0_MODE] = n; this.currentMode = n; }

  async connect() { this.connected = true; this.asm.reset(); return { name: this.name }; }
  async disconnect() { if (!this.connected) return; this.connected = false; for (const cb of this.disconnectCbs) cb(); }
  onData(cb) { this.dataCbs.push(cb); }
  onDisconnect(cb) { this.disconnectCbs.push(cb); }

  async write(bytes) {
    if (!this.connected) throw new TransportError('not connected', 'NOT_CONNECTED');
    for (const frame of this.asm.push(bytes)) {
      this.sent.push(frame);
      if (this.failSect && frame[2] === CMD.UPLOAD_SECT) continue; // simulated dead segment reads, not counted as drops
      if (this.dropNext > 0) { this.dropNext--; continue; }
      const resp = this.#handle(frame);
      if (resp) this.#emit(resp); // not awaited: responses arrive asynchronously like BLE notifications
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
        for (let i = 0; i + 1 < data.length; i += 2) { const a = (data[i] << 8) | data[i + 1]; out.push(data[i], data[i + 1], hi(this.regs[a] ?? 0), lo(this.regs[a] ?? 0)); }
        return buildFrame(cmd, out);
      }
      case CMD.WRITE:
        for (const { addr, val } of parsed.pairs) if (addr < REG_COUNT) this.regs[addr] = val;
        return frame.slice();
      case CMD.UPLOAD_SECT: {
        if (this.failSect) return null;
        const start = (data[0] << 8) | data[1];
        const out = [data[0], data[1]];
        for (let a = start; a < Math.min(start + 100, REG_COUNT); a++) out.push(hi(this.regs[a]), lo(this.regs[a]));
        return buildFrame(cmd, out);
      }
      case CMD.CALL_MODE: { const n = data[0]; if (n >= 1 && n <= 8) this.pokeMode(n); return buildFrame(cmd, [n]); }
      case CMD.SAVE_MODE: { const n = data[0]; if (n >= 1 && n <= 8) this.slots[n - 1].set(this.regs.subarray(0, MODE_END)); return buildFrame(cmd, [n]); }
      default: return null;
    }
  }

  async #emit(resp) {
    for (let i = 0; i < resp.length; i += this.chunkSize) {
      // latency 0 → microtask hop only; setTimeout granularity on Windows (~15 ms) would otherwise dominate
      if (this.latencyMs > 0) await sleep(this.latencyMs); else await Promise.resolve();
      if (!this.connected) return;
      const chunk = resp.slice(i, i + this.chunkSize);
      for (const cb of this.dataCbs) cb(chunk);
    }
  }
}
