import { summarizeFrame } from '../protocol/summary.js';

export const LEVELS = ['INFO', 'WARN', 'ERR', 'TX', 'RX', 'REPORT'];
const IMPORTANT = new Set(['INFO', 'WARN', 'ERR', 'REPORT']);
const PACKETS = new Set(['TX', 'RX']);

export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

export class Logger {
  constructor({ max = 20000, now = () => Date.now() } = {}) {
    this.max = max;
    this.now = now;
    this.entries = [];
    this.truncated = false;
    this.listeners = new Set();
    this.seq = 0;
    this.t0 = null;
  }

  #add(level, text, hex) {
    const now = this.now();
    if (this.t0 === null) this.t0 = now;
    const entry = { i: ++this.seq, t: Math.round(now - this.t0), level, text };
    if (hex) entry.hex = hex;
    this.entries.push(entry);
    if (this.entries.length > this.max) {
      this.entries.splice(0, Math.ceil(this.max / 10));
      this.truncated = true;
    }
    for (const fn of this.listeners) { try { fn(entry); } catch { /* listener errors never break logging */ } }
    return entry;
  }

  info(text) { return this.#add('INFO', String(text)); }
  warn(text) { return this.#add('WARN', String(text)); }
  error(text) { return this.#add('ERR', String(text)); }
  report(text) { return this.#add('REPORT', String(text)); }
  tx(frame) { return this.#add('TX', summarizeFrame(frame, 'tx'), toHex(frame)); }
  rx(frame) { return this.#add('RX', summarizeFrame(frame, 'rx'), toHex(frame)); }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  clear() { this.entries = []; this.truncated = false; }

  restore(entries) {
    this.entries = entries.map((e) => ({ ...e }));
    this.seq = this.entries.reduce((m, e) => Math.max(m, e.i), 0);
  }

  lastReport() {
    for (let i = this.entries.length - 1; i >= 0; i--) if (this.entries[i].level === 'REPORT') return this.entries[i].text;
    return null;
  }

  static formatEntry(e) {
    const base = `${String(e.t).padStart(7)} ${e.level.padEnd(6)} ${e.text}`;
    return e.hex ? `${base} | ${e.hex}` : base;
  }

  toText(filter = 'all') {
    const keep = filter === 'important' ? (e) => IMPORTANT.has(e.level)
      : filter === 'packets' ? (e) => PACKETS.has(e.level)
        : () => true;
    const lines = this.entries.filter(keep).map(Logger.formatEntry);
    if (this.truncated) lines.unshift('（較舊的日誌已因超過上限被丟棄）');
    return lines.join('\n');
  }
}
