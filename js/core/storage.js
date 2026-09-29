const STORES = ['snapshots', 'logs', 'settings'];

export class Storage {
  static async open({ name = 'dspx8s', version = 1, indexedDB = globalThis.indexedDB } = {}) {
    const s = new Storage();
    if (!indexedDB) { s.backend = 'memory'; s.mem = new Map(STORES.map((n) => [n, new Map()])); return s; }
    try {
      s.db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(name, version);
        req.onupgradeneeded = () => { for (const n of STORES) if (!req.result.objectStoreNames.contains(n)) req.result.createObjectStore(n); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('indexedDB blocked'));
      });
      s.backend = 'idb';
    } catch {
      s.backend = 'memory'; s.mem = new Map(STORES.map((n) => [n, new Map()]));
    }
    return s;
  }

  #check(store) { if (!STORES.includes(store)) throw new Error(`unknown store ${store}`); }

  #tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async put(store, key, value) { this.#check(store); if (this.mem) { this.mem.get(store).set(key, structuredClone(value)); return; } await this.#tx(store, 'readwrite', (os) => os.put(value, key)); }
  async get(store, key) { this.#check(store); if (this.mem) { const v = this.mem.get(store).get(key); return v === undefined ? undefined : structuredClone(v); } return this.#tx(store, 'readonly', (os) => os.get(key)); }
  async delete(store, key) { this.#check(store); if (this.mem) { this.mem.get(store).delete(key); return; } await this.#tx(store, 'readwrite', (os) => os.delete(key)); }
  async clear(store) { this.#check(store); if (this.mem) { this.mem.get(store).clear(); return; } await this.#tx(store, 'readwrite', (os) => os.clear()); }
  async getAll(store) {
    this.#check(store);
    if (this.mem) return Array.from(this.mem.get(store), ([key, value]) => ({ key, value: structuredClone(value) }));
    const [keys, values] = await Promise.all([this.#tx(store, 'readonly', (os) => os.getAllKeys()), this.#tx(store, 'readonly', (os) => os.getAll())]);
    return keys.map((key, i) => ({ key, value: values[i] }));
  }
}

export class LogPersister {
  constructor(logger, storage, { batch = 50, intervalMs = 2000 } = {}) {
    this.logger = logger; this.storage = storage; this.batch = batch; this.intervalMs = intervalMs;
    this.unsent = 0; this.timer = null; this.unsub = null; this.flushing = null;
  }
  start() {
    this.unsub = this.logger.subscribe(() => { this.unsent++; if (this.unsent >= this.batch) this.flush(); });
    this.timer = setInterval(() => { if (this.unsent > 0) this.flush(); }, this.intervalMs);
  }
  async stop() { if (this.unsub) this.unsub(); if (this.timer) clearInterval(this.timer); this.unsub = null; this.timer = null; await this.flush(); }
  flush() {
    if (this.flushing) return this.flushing;
    this.unsent = 0;
    const entries = this.logger.entries.slice();
    this.flushing = (async () => {
      try {
        await this.storage.put('logs', 'last', entries);
        await this.storage.put('logs', 'meta', { savedAt: Date.now(), count: entries.length });
      } catch { /* persistence is best-effort */ } finally { this.flushing = null; }
    })();
    return this.flushing;
  }
  static async loadLast(storage) { const e = await storage.get('logs', 'last'); return Array.isArray(e) && e.length ? e : null; }
}
