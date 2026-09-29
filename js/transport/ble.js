import { TransportError } from './transport.js';

export const uuid16 = (n) => `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
export const SERVICE_UUID = uuid16(0xae00);
export const WRITE_UUID = uuid16(0xae01);
export const NOTIFY_UUID = uuid16(0xae02);

export function chunk(bytes, size = 20) {
  const out = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
  return out;
}

export function detectEnvironment(nav = globalThis.navigator, win = globalThis) {
  const userAgent = nav?.userAgent ?? 'unknown';
  let standalone = false;
  try { standalone = Boolean(nav?.standalone) || Boolean(win?.matchMedia?.('(display-mode: standalone)')?.matches); } catch { standalone = false; }
  return {
    userAgent,
    webBluetooth: Boolean(nav?.bluetooth),
    bluefy: /bluefy/i.test(userAgent),
    standalone,
    secure: Boolean(win?.isSecureContext),
  };
}

export class BleTransport {
  constructor({ bluetooth = globalThis.navigator?.bluetooth, logger, chunkSize = 20 } = {}) {
    this.bluetooth = bluetooth;
    this.log = logger;
    this.chunkSize = chunkSize;
    this.device = null;
    this.writeChar = null;
    this.notifyChar = null;
    this.connected = false;
    this.name = '';
    this.dataCbs = [];
    this.disconnectCbs = [];
    this.onValue = (ev) => {
      const v = ev.target.value;
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();
      for (const cb of this.dataCbs) cb(bytes);
    };
    this.onGattLost = () => { this.connected = false; this.log?.warn('GATT 斷線事件'); for (const cb of this.disconnectCbs) cb(); };
  }

  static async knownDevices(bluetooth = globalThis.navigator?.bluetooth) {
    if (!bluetooth?.getDevices) return [];
    try { return await bluetooth.getDevices(); } catch { return []; }
  }

  onData(cb) { this.dataCbs.push(cb); }
  onDisconnect(cb) { this.disconnectCbs.push(cb); }

  async connect({ acceptAll = false, device = null } = {}) {
    if (!this.bluetooth) throw new TransportError('此瀏覽器不支援 Web Bluetooth', 'UNSUPPORTED');
    const options = acceptAll
      ? { acceptAllDevices: true, optionalServices: [SERVICE_UUID] }
      : { filters: [{ services: [SERVICE_UUID] }], optionalServices: [SERVICE_UUID] };
    this.log?.info(`requestDevice ${acceptAll ? '（接受所有裝置）' : '（過濾 service ae00）'}`);
    this.device = device ?? await this.bluetooth.requestDevice(options);
    this.name = this.device.name || this.device.id || '(未命名)';
    this.log?.info(`選擇裝置：${this.name}`);
    try {
      this.device.addEventListener('gattserverdisconnected', this.onGattLost);
      const server = await this.device.gatt.connect();
      this.log?.info('GATT 已連線，尋找 service ae00');
      const service = await server.getPrimaryService(SERVICE_UUID);
      this.writeChar = await service.getCharacteristic(WRITE_UUID);
      this.notifyChar = await service.getCharacteristic(NOTIFY_UUID);
      const p = this.writeChar.properties;
      this.log?.info(`characteristic ae01 write=${p.write} writeWithoutResponse=${p.writeWithoutResponse}；ae02 notify=${this.notifyChar.properties.notify}`);
      await this.notifyChar.startNotifications();
      this.notifyChar.addEventListener('characteristicvaluechanged', this.onValue);
      this.connected = true;
      return { name: this.name };
    } catch (err) {
      this.log?.warn(`連線中途失敗，釋放 GATT：${err.message}`);
      await this.disconnect(); // release the single BLE link the DSP offers, remove listeners
      throw err;
    }
  }

  async disconnect() {
    const dev = this.device;
    this.connected = false;
    if (this.notifyChar) { try { this.notifyChar.removeEventListener('characteristicvaluechanged', this.onValue); } catch { /* ignore */ } }
    if (dev) {
      dev.removeEventListener('gattserverdisconnected', this.onGattLost);
      if (dev.gatt?.connected) { try { dev.gatt.disconnect(); } catch { /* ignore */ } }
    }
    this.device = null; this.writeChar = null; this.notifyChar = null;
  }

  async write(bytes) {
    if (!this.connected || !this.writeChar) throw new TransportError('not connected', 'NOT_CONNECTED');
    const c = this.writeChar;
    const useResponse = c.properties.write || !c.properties.writeWithoutResponse;
    for (const part of chunk(bytes, this.chunkSize)) {
      if (useResponse) { if (c.writeValueWithResponse) await c.writeValueWithResponse(part); else await c.writeValue(part); }
      else await c.writeValueWithoutResponse(part);
    }
  }
}
