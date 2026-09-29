import { FakeDevice } from '../transport/fake-device.js';
import { BleTransport, detectEnvironment } from '../transport/ble.js';
import { Logger } from '../core/logger.js';
import { RegisterStore } from '../core/store.js';
import { Storage, LogPersister } from '../core/storage.js';
import { Device } from '../core/device.js';
import * as statusbar from './statusbar.js';
import * as bluetoothPage from './pages/bluetooth.js';
import * as soundPage from './pages/sound.js';
import * as eqPage from './pages/eq.js';
import * as modesPage from './pages/modes.js';
import * as logPage from './pages/log.js';

const PAGES = { bluetooth: bluetoothPage, sound: soundPage, eq: eqPage, modes: modesPage, log: logPage };

async function boot() {
  const params = new URLSearchParams(location.search);
  const transportKind = params.get('sim') === '1' ? 'sim' : 'ble';
  const logger = new Logger();
  const env = detectEnvironment();
  const transport = transportKind === 'sim' ? new FakeDevice({ latencyMs: 5 }) : new BleTransport({ logger });
  const store = new RegisterStore();
  const storage = await Storage.open();
  const device = new Device({ transport, store, logger });
  const events = new EventTarget();
  const ctx = { device, store, logger, storage, env, events, transportKind };

  logger.info(`啟動${transportKind === 'sim' ? '（模擬機器）' : ''} 版本 ${document.documentElement.dataset.version ?? 'dev'}`);
  logger.info(`瀏覽器: ${env.userAgent}`);
  logger.info(`WebBluetooth=${env.webBluetooth} Bluefy=${env.bluefy} 安裝模式=${env.standalone} HTTPS=${env.secure} 儲存=${storage.backend}`);

  const persister = new LogPersister(logger, storage);
  persister.start();
  window.addEventListener('pagehide', () => persister.flush());

  device.on('snapshot', (snap) => { storage.put('snapshots', String(snap.ts), snap).catch(() => {}); });
  device.on('error', (err) => logger.error(`裝置錯誤：${err.message}`));

  statusbar.init(ctx, document.getElementById('statusbar'));
  for (const [name, mod] of Object.entries(PAGES)) mod.init(ctx, document.getElementById(`page-${name}`));

  const tabs = document.querySelectorAll('#tabs button');
  const show = (name) => {
    document.querySelectorAll('.page').forEach((p) => { p.hidden = p.dataset.page !== name; });
    tabs.forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    try { localStorage.setItem('tab', name); } catch { /* ignore */ }
    ctx.events.dispatchEvent(new CustomEvent('tab', { detail: name }));
  };
  tabs.forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
  let initial = 'bluetooth';
  try { initial = localStorage.getItem('tab') || initial; } catch { /* ignore */ }
  show(PAGES[initial] ? initial : 'bluetooth');

  try { const persisted = await navigator.storage?.persist?.(); if (persisted !== undefined) logger.info(`持久儲存: ${persisted}`); } catch { /* ignore */ }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (ev) => {
      if (ev.data?.type === 'cached') { logger.info(`離線快取完成，版本 ${ev.data.version}`); events.dispatchEvent(new CustomEvent('sw-cached', { detail: ev.data })); }
    });
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) events.dispatchEvent(new CustomEvent('sw-update', { detail: reg })); });
      });
      if (reg.active && !reg.installing) events.dispatchEvent(new CustomEvent('sw-cached', { detail: { version: document.documentElement.dataset.version ?? 'active', fromRegistration: true } }));
    } catch (err) { logger.warn(`Service Worker 註冊失敗：${err.message}`); }
  } else {
    logger.warn('此環境沒有 Service Worker，無法離線使用');
  }
  window.dspx = ctx; // 供開發者在 console 檢查
}

boot().catch((err) => { console.error(err); document.body.insertAdjacentHTML('afterbegin', `<pre class="err" style="padding:16px">啟動失敗：${err.message}</pre>`); });
