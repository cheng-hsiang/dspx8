import { FrameAssembler } from '../protocol/frame.js';
import { matchesRequest, coalesceKey, parseResponse } from '../protocol/commands.js';

export class TimeoutError extends Error {
  constructor(message) { super(message); this.name = 'TimeoutError'; }
}

/** One-in-flight request queue with ack matching, coalescing, resend and dead detection. */
export class Queue {
  constructor(transport, logger, { timeoutMs = 1700, retries = 3, deadAfter = 3 } = {}) {
    this.transport = transport;
    this.log = logger;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.deadAfter = deadAfter;
    this.pending = [];        // [{ frame, key, waiters: [{resolve, reject}] }]
    this.current = null;      // in-flight item + { attempts, timer }
    this.consecutiveFailures = 0;
    this.stats = { sent: 0, acked: 0, resent: 0, timeouts: 0, unsolicited: 0 };
    this.unsolicitedCbs = [];
    this.deadCbs = [];
    this.asm = new FrameAssembler();
    transport.onData((chunk) => { for (const f of this.asm.push(chunk)) this.#onFrame(f); });
  }

  get pendingCount() { return this.pending.length; }
  get inFlight() { return this.current !== null; }
  onUnsolicited(cb) { this.unsolicitedCbs.push(cb); }
  onDead(cb) { this.deadCbs.push(cb); }

  send(frame) {
    return new Promise((resolve, reject) => {
      const key = coalesceKey(frame);
      const existing = key ? this.pending.find((p) => p.key === key) : null;
      if (existing) {
        existing.frame = frame;
        existing.waiters.push({ resolve, reject });
      } else {
        this.pending.push({ frame, key, waiters: [{ resolve, reject }] });
      }
      this.#pump();
    });
  }

  clear(reason = new Error('queue cleared')) {
    if (this.current) { clearTimeout(this.current.timer); this.#settle(this.current, null, reason); this.current = null; }
    for (const p of this.pending) this.#settle(p, null, reason);
    this.pending = [];
    this.asm.reset();
  }

  #settle(item, value, error) {
    for (const w of item.waiters) (error ? w.reject(error) : w.resolve(value));
  }

  #pump() {
    if (this.current || this.pending.length === 0) return;
    const item = this.pending.shift();
    this.current = { ...item, attempts: 0, timer: null };
    this.#transmit();
  }

  async #transmit() {
    const cur = this.current;
    if (!cur) return;
    cur.attempts++;
    cur.timedOut = false;
    if (cur.attempts > 1) { this.stats.resent++; this.log.warn(`逾時重送 (${cur.attempts - 1}/${this.retries})`); } else this.stats.sent++;
    this.log.tx(cur.frame);
    cur.timer = setTimeout(() => this.#onTimeout(), this.timeoutMs);
    cur.writing = true;
    try {
      await this.transport.write(cur.frame);
    } catch (err) {
      cur.writing = false;
      if (this.current !== cur) return;
      clearTimeout(cur.timer);
      this.current = null;
      this.stats.writeErrors = (this.stats.writeErrors ?? 0) + 1;
      this.log.error(`寫入失敗：${err.message}`);
      this.#settle(cur, null, err);
      this.#recordFailure();
      this.#pump();
      return;
    }
    cur.writing = false;
    // the timer fired while the GATT write was still pending: judge it now, never overlap two writes
    if (cur.timedOut && this.current === cur) this.#onTimeout();
  }

  #recordFailure() {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.deadAfter) { this.consecutiveFailures = 0; for (const cb of this.deadCbs) cb(); }
  }

  #onTimeout() {
    const cur = this.current;
    if (!cur) return;
    if (cur.writing) { cur.timedOut = true; return; }
    if (cur.attempts <= this.retries) { this.#transmit(); return; }
    this.stats.timeouts++;
    this.current = null;
    this.log.error(`無回應，放棄（${cur.attempts} 次）`);
    this.#settle(cur, null, new TimeoutError('device did not respond'));
    this.#recordFailure();
    this.#pump();
  }

  #onFrame(frame) {
    this.log.rx(frame);
    const cur = this.current;
    if (cur && matchesRequest(cur.frame, frame)) {
      clearTimeout(cur.timer);
      this.current = null;
      this.stats.acked++;
      this.consecutiveFailures = 0;
      const data = frame.subarray(3, frame.length - 2);
      this.#settle(cur, { raw: frame, cmd: frame[2], data, parsed: parseResponse({ cmd: frame[2], data }) }, null);
      this.#pump();
      return;
    }
    this.stats.unsolicited++;
    for (const cb of this.unsolicitedCbs) cb(frame);
  }
}
