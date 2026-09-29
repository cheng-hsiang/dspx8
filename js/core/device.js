import { Queue, TimeoutError } from './queue.js';
import { STATUS } from './store.js';
import * as cmd from '../protocol/commands.js';
import { ADDR, DUMP_END, HEARTBEAT_ADDRS, isTypeAddr, isWritableAddr, eqAddr, describeAddr } from '../protocol/addrmap.js';
import { encodeGain } from '../protocol/codec.js';
import { CUSTOMER_ID } from '../protocol/tables.js';

export const STATE = Object.freeze({ DISCONNECTED: 'disconnected', CONNECTING: 'connecting', CONNECTED: 'connected', READONLY: 'readonly' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Device {
  constructor({ transport, store, logger, queueOptions = {}, heartbeatMs = 1000, modeReloadDelayMs = 1200 }) {
    this.transport = transport;
    this.store = store;
    this.log = logger;
    this.queueOptions = queueOptions;
    this.heartbeatMs = heartbeatMs;
    this.modeReloadDelayMs = modeReloadDelayMs;
    this.state = STATE.DISCONNECTED;
    this.info = { name: '', customerId: null, connectedAt: null };
    this.dumpInfo = { complete: false, ms: 0, failedSegments: [], method: 'none' };
    this.queue = null;
    this.heartbeatTimer = null;
    this.heartbeatBusy = false;
    this.lastMode = null;
    this.listeners = new Map();
    transport.onDisconnect(() => this.#onTransportLost());
  }

  on(event, cb) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(cb);
    return () => this.listeners.get(event).delete(cb);
  }
  #emit(event, payload) { for (const cb of this.listeners.get(event) ?? []) { try { cb(payload); } catch (e) { this.log.error(`listener ${event}: ${e.message}`); } } }
  #setState(s) { if (this.state !== s) { this.state = s; this.#emit('state', s); } }

  get canWrite() { return this.state === STATE.CONNECTED; }

  async connect() {
    if (this.state !== STATE.DISCONNECTED) return;
    this.#setState(STATE.CONNECTING);
    try {
      const { name } = await this.transport.connect();
      this.info = { name, customerId: null, connectedAt: Date.now() };
      this.log.info(`已連線：${name}`);
      this.queue = new Queue(this.transport, this.log, this.queueOptions);
      this.queue.onUnsolicited((f) => { if (f[2] !== cmd.CMD.BT_READ) this.log.warn(`未預期的回應 cmd=0x${f[2].toString(16)}`); });
      this.queue.onDead(() => { this.log.error('連續無回應，判定斷線'); this.disconnect(); });
      const id = await this.checkId();
      if (id === CUSTOMER_ID) { this.#setState(STATE.CONNECTED); this.log.info(`客戶代碼 ${id} 正確`); }
      else { this.#setState(STATE.READONLY); this.log.warn(`客戶代碼 ${id} 不符（預期 ${CUSTOMER_ID}），進入唯讀模式`); }
      await this.dump();
      this.startHeartbeat();
    } catch (err) {
      this.log.error(`連線失敗：${err.message}`);
      this.#emit('error', err);
      await this.disconnect();
      throw err;
    }
  }

  async disconnect() {
    this.stopHeartbeat();
    if (this.queue) { this.queue.clear(new Error('disconnected')); this.queue = null; }
    try { await this.transport.disconnect(); } catch { /* transports are idempotent; a half-open GATT link must still be released */ }
    if (this.state !== STATE.DISCONNECTED) { this.log.info('已斷線'); this.#setState(STATE.DISCONNECTED); }
  }

  #onTransportLost() {
    if (this.state === STATE.DISCONNECTED) return;
    this.log.warn('藍牙連線中斷');
    this.disconnect();
  }

  #requireQueue() { if (!this.queue) throw new Error('not connected'); return this.queue; }

  async checkId() {
    const res = await this.#requireQueue().send(cmd.checkIdPacket());
    this.info.customerId = res.parsed.id;
    return res.parsed.id;
  }

  async dump() {
    const q = this.#requireQueue();
    const t0 = Date.now();
    const plan = cmd.sectPlan();
    const info = { complete: true, ms: 0, failedSegments: [], method: 'sect' };
    let done = 0;
    this.#emit('progress', { done, total: plan.length });
    for (const start of plan) {
      const end = Math.min(start + cmd.SECT_SIZE - 1, DUMP_END);
      try {
        const res = await q.send(cmd.uploadSectPacket(start));
        const pairs = res.parsed.values.slice(0, end - start + 1).map((val, i) => ({ addr: start + i, val }));
        this.store.setMany(pairs, STATUS.CONFIRMED);
        if (pairs.length < end - start + 1) {
          // short response: never call the dump complete on registers we did not receive
          this.log.warn(`區段 ${start} 只回 ${pairs.length} 個值，補讀 ${start + pairs.length}..${end}`);
          const ok = await this.#readRange(start + pairs.length, end);
          if (ok) info.method = 'mixed'; else { info.complete = false; info.failedSegments.push(start); }
        }
      } catch (err) {
        if (!(err instanceof TimeoutError)) throw err;
        this.log.warn(`區段 ${start} 無回應，改用一般讀取`);
        const ok = await this.#readRange(start, end);
        if (ok) info.method = 'mixed'; else { info.complete = false; info.failedSegments.push(start); }
      }
      done++;
      this.#emit('progress', { done, total: plan.length });
    }
    info.ms = Date.now() - t0;
    this.dumpInfo = info;
    this.lastMode = this.store.get(ADDR.M0_MODE);
    this.log.info(`整機讀取${info.complete ? '完成' : '不完整'}：${info.ms} ms，方式 ${info.method}${info.failedSegments.length ? '，失敗區段 ' + info.failedSegments.join(',') : ''}`);
    this.#emit('dump', info);
    if (info.complete) this.#emit('snapshot', this.store.snapshot());
    return info;
  }

  async #readRange(start, end) {
    const addrs = []; for (let a = start; a <= end; a++) addrs.push(a);
    try { await this.readRegs(addrs); return true; } catch (err) { if (err instanceof TimeoutError) return false; throw err; }
  }

  async readRegs(addrs) {
    const q = this.#requireQueue();
    const all = [];
    for (const pkt of cmd.readPackets(addrs)) {
      const res = await q.send(pkt);
      this.store.setMany(res.parsed.pairs, STATUS.CONFIRMED);
      all.push(...res.parsed.pairs);
    }
    return all;
  }

  async writeRegs(pairs) {
    if (!this.canWrite) throw new Error('readonly: writes are disabled');
    for (const { addr, val } of pairs) {
      if (!Number.isInteger(addr) || addr < 0 || addr > DUMP_END) throw new RangeError(`address out of range: ${addr}`);
      if (isTypeAddr(addr)) throw new RangeError(`refusing to write TYPE field ${describeAddr(addr)}`);
      if (!isWritableAddr(addr)) throw new RangeError(`refusing to write non-allow-listed register ${describeAddr(addr)}`);
      if (!Number.isInteger(val) || val < 0 || val > 0xFFFF) throw new RangeError(`value out of range: ${val}`);
    }
    const q = this.#requireQueue();
    this.store.markPending(pairs.map((p) => p.addr));
    for (const pkt of cmd.writePackets(pairs)) {
      const res = await q.send(pkt);
      this.store.setMany(res.parsed.pairs, STATUS.CONFIRMED);
    }
  }

  async verify(addrs) {
    const expected = new Map(addrs.map((a) => [a, this.store.get(a)]));
    const q = this.#requireQueue();
    const mismatches = [];
    const seen = new Set();
    for (const pkt of cmd.readPackets(addrs)) {
      const res = await q.send(pkt);
      for (const { addr, val } of res.parsed.pairs) {
        if (!expected.has(addr)) continue;
        seen.add(addr);
        if (val === expected.get(addr)) this.store.set(addr, val, STATUS.CONFIRMED);
        else { mismatches.push({ addr, expected: expected.get(addr), actual: val }); this.store.markMismatch(addr, val); }
      }
    }
    for (const addr of addrs) {
      if (seen.has(addr)) continue;
      // the device answered but left this address out: that is not a confirmation
      mismatches.push({ addr, expected: expected.get(addr), actual: null });
      this.store.markMismatch(addr, null);
    }
    if (mismatches.length) this.log.warn(`讀回不符 ${mismatches.length} 筆：` + mismatches.map((m) => `${describeAddr(m.addr)} 期望 ${m.expected} 實際 ${m.actual ?? '無回應'}`).join('；'));
    return mismatches;
  }

  async writeAndVerify(pairs) {
    const t0 = Date.now();
    await this.writeRegs(pairs);
    const mismatches = await this.verify(pairs.map((p) => p.addr));
    return { mismatches, ms: Date.now() - t0 };
  }

  async writeTest(ch, band, db) {
    const addr = eqAddr(ch, band, 'G');
    const name = describeAddr(addr);
    const [{ val: before }] = await this.readRegs([addr]);
    const sent = encodeGain(db);
    this.log.info(`寫入測試：${name} ${before} → ${sent} (${db >= 0 ? '+' : ''}${db} dB)`);
    const { mismatches, ms } = await this.writeAndVerify([{ addr, val: sent }]);
    const readBack = mismatches.length ? mismatches[0].actual : sent;
    const ok = mismatches.length === 0;
    this.log[ok ? 'info' : 'warn'](`寫入測試${ok ? '成功' : '失敗'}：讀回 ${readBack ?? '無回應'}，${ms} ms`);
    return { addr, name, before, sent, readBack, ok, ms };
  }

  async callMode(n) {
    if (!this.canWrite) throw new Error('readonly: writes are disabled');
    await this.#requireQueue().send(cmd.callModePacket(n));
    this.log.info(`已呼叫模式 ${n}，${this.modeReloadDelayMs} ms 後重新讀取`);
    await sleep(this.modeReloadDelayMs);
    await this.dump();
  }

  async saveMode(n) {
    if (!this.canWrite) throw new Error('readonly: writes are disabled');
    await this.#requireQueue().send(cmd.saveModePacket(n));
    this.log.info(`已儲存到模式 ${n}`);
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.#heartbeat(), this.heartbeatMs);
  }
  stopHeartbeat() { if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; } }

  async #heartbeat() {
    if (!this.queue || this.heartbeatBusy || this.queue.pendingCount > 0) return;
    this.heartbeatBusy = true;
    try {
      await this.readRegs(HEARTBEAT_ADDRS);
      const mode = this.store.get(ADDR.M0_MODE);
      if (this.lastMode !== null && mode !== this.lastMode) {
        this.log.info(`偵測到模式改變 ${this.lastMode} → ${mode}，重新讀取`);
        this.lastMode = mode;
        this.#emit('mode', mode);
        await this.dump();
      }
      this.lastMode = mode;
    } catch (err) {
      if (!(err instanceof TimeoutError)) this.log.error(`心跳錯誤：${err.message}`);
    } finally {
      this.heartbeatBusy = false;
    }
  }
}
