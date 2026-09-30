import { FakeDevice } from '../transport/fake-device.js';
import { BleTransport, detectEnvironment } from '../transport/ble.js';
import { Logger } from '../core/logger.js';
import { RegisterStore } from '../core/store.js';
import { Storage, LogPersister } from '../core/storage.js';
import { Device } from '../core/device.js';
import { errText } from '../util/errors.js';
import * as statusbar from './statusbar.js';
import * as bluetoothPage from './pages/bluetooth.js';
import * as soundPage from './pages/sound.js';
import * as eqPage from './pages/eq.js';
import * as tunePage from './pages/tune.js';
import { micSupport } from '../tune/source.js';
import * as modesPage from './pages/modes.js';
import * as logPage from './pages/log.js';

const PAGES = { bluetooth: bluetoothPage, sound: soundPage, eq: eqPage, tune: tunePage, modes: modesPage, log: logPage };

async function boot() {
  const params = new URLSearchParams(location.search);
  const transportKind = params.get('sim') === '1' ? 'sim' : 'ble';
  const logger = new Logger();
  const env = detectEnvironment();
  const simLatency = Number(params.get('lat')) || 5; // ?lat=150 simulates a slow BLE link
  const transport = transportKind === 'sim' ? new FakeDevice({ latencyMs: simLatency, btStatusMs: 450 }) : new BleTransport({ logger });
  const store = new RegisterStore();
  const storage = await Storage.open();
  const device = new Device({ transport, store, logger });
  const events = new EventTarget();
  const ctx = { device, store, logger, storage, env, events, transportKind };

  logger.info(`啟動${transportKind === 'sim' ? '（模擬機器）' : ''} 版本 ${document.documentElement.dataset.version ?? 'dev'}`);
  logger.info(`瀏覽器: ${env.userAgent}`);
  logger.info(`WebBluetooth=${env.webBluetooth} Bluefy=${env.bluefy} 安裝模式=${env.standalone} HTTPS=${env.secure} 儲存=${storage.backend}`);
  const mic = micSupport();
  logger.info(`麥克風支援：mediaDevices=${mic.mediaDevices} getUserMedia=${mic.getUserMedia} WebAudio=${mic.audioContext}`);

  await LogPersister.rotate(storage); // keep the previous session's log (and its report) safe before we start writing ours
  const persister = new LogPersister(logger, storage);
  persister.start();
  window.addEventListener('pagehide', () => persister.flush());

  device.on('snapshot', (snap) => { storage.put('snapshots', String(snap.ts), snap).catch(() => {}); });
  device.on('error', (err) => logger.debug(`裝置錯誤事件：${errText(err)}`)); // connect() already logged it

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


  window.dspx = ctx; // 供開發者在 console 檢查
}

boot().catch((err) => { console.error(err); document.body.insertAdjacentHTML('afterbegin', `<pre class="err" style="padding:16px">啟動失敗：${errText(err)}</pre>`); });
