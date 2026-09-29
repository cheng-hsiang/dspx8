import { DUMP_END } from '../protocol/addrmap.js';

export const STATUS = Object.freeze({ UNKNOWN: 0, CONFIRMED: 1, PENDING: 2, MISMATCH: 3 });

export class RegisterStore {
  constructor(size = DUMP_END + 1) {
    this.size = size;
    this.values = new Uint16Array(size);
    this.status = new Uint8Array(size);
    this.deviceValues = new Map();
    this.listeners = new Set();
  }

  #inRange(addr) { return Number.isInteger(addr) && addr >= 0 && addr < this.size; }

  #notify(addrs) {
    if (addrs.length === 0) return;
    for (const fn of this.listeners) { try { fn(addrs); } catch { /* ignore */ } }
  }

  get(addr) { return this.#inRange(addr) ? this.values[addr] : 0; }
  getStatus(addr) { return this.#inRange(addr) ? this.status[addr] : STATUS.UNKNOWN; }

  set(addr, val, status = STATUS.CONFIRMED) {
    if (!this.#inRange(addr)) return;
    this.values[addr] = val & 0xFFFF;
    this.status[addr] = status;
    if (status !== STATUS.MISMATCH) this.deviceValues.delete(addr);
    this.#notify([addr]);
  }

  setMany(pairs, status = STATUS.CONFIRMED) {
    const changed = [];
    for (const { addr, val } of pairs) {
      if (!this.#inRange(addr)) continue;
      this.values[addr] = val & 0xFFFF;
      this.status[addr] = status;
      if (status !== STATUS.MISMATCH) this.deviceValues.delete(addr);
      changed.push(addr);
    }
    this.#notify(changed);
  }

  markPending(addrs) {
    const changed = [];
    for (const a of addrs) if (this.#inRange(a)) { this.status[a] = STATUS.PENDING; changed.push(a); }
    this.#notify(changed);
  }

  markMismatch(addr, deviceVal) {
    if (!this.#inRange(addr)) return;
    this.status[addr] = STATUS.MISMATCH;
    this.deviceValues.set(addr, deviceVal & 0xFFFF);
    this.#notify([addr]);
  }

  acceptDevice(addr) {
    if (!this.deviceValues.has(addr)) return;
    this.set(addr, this.deviceValues.get(addr), STATUS.CONFIRMED);
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  confirmedCount() { let n = 0; for (const s of this.status) if (s === STATUS.CONFIRMED) n++; return n; }

  snapshot() { return { ts: Date.now(), values: Array.from(this.values), status: Array.from(this.status) }; }

  loadSnapshot(snap) {
    const n = Math.min(this.size, snap.values.length);
    for (let i = 0; i < n; i++) { this.values[i] = snap.values[i]; this.status[i] = STATUS.CONFIRMED; }
    this.deviceValues.clear();
    this.#notify(Array.from({ length: n }, (_, i) => i));
  }

  reset() {
    this.values.fill(0);
    this.status.fill(STATUS.UNKNOWN);
    this.deviceValues.clear();
    this.#notify(Array.from({ length: this.size }, (_, i) => i));
  }
}
