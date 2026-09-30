// Headless-browser smoke test: boots the app with the simulated device, connects,
// runs the write test and checks the report summary. Requires Chrome or Edge.
// Usage: node tools/smoke.mjs   (starts its own static server on port 8089)
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8089;
const CDP_PORT = 9333;
const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const browser = process.env.BROWSER || BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chrome/Edge found; set BROWSER=path'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, [join(ROOT, 'tools/serve.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
const profile = mkdtempSync(join(tmpdir(), 'dspx8s-smoke-'));
const chrome = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });

function cleanup(code) {
  try { chrome.kill(); } catch { /* ignore */ }
  try { server.kill(); } catch { /* ignore */ }
  setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } process.exit(code); }, 300);
}

async function waitForCdp() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) return; } catch { /* retry */ }
    await sleep(200);
  }
  throw new Error('CDP not reachable');
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.events = []; ws.onmessage = (m) => this.#onMessage(JSON.parse(m.data)); }
  static async open(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }); return new Cdp(ws); }
  #onMessage(msg) {
    if (msg.id && this.waiting.has(msg.id)) { const { resolve, reject } = this.waiting.get(msg.id); this.waiting.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); }
    else if (msg.method) this.events.push(msg);
  }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject })); }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed');
    return r.result.value;
  }
}

const SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(50); } return false; };
  const out = { tabs: document.querySelectorAll('#tabs button').length, pages: document.querySelectorAll('[data-page]').length };
  out.booted = await until(() => window.dspx && document.querySelector('#bt-connect'));
  document.querySelector('#bt-connect').click();
  out.connected = await until(() => (document.querySelector('#bt-status').textContent || '').includes('客戶代碼 4006'));
  out.dumpDone = await until(() => (document.querySelector('#bt-progress-text').textContent || '').startsWith('完成'));
  out.confirmed = window.dspx.store.confirmedCount();
  document.querySelector('#wt-run').click();
  out.writeTest = await until(() => (document.querySelector('#wt-result').textContent || '').includes('一致'));
  out.writeResult = document.querySelector('#wt-result').textContent;
  const report = window.dspx.logger.lastReport() || '';
  out.reportOk = report.includes('===== 報告摘要 =====') && report.includes('[寫入測試]') && report.includes('送出 560');
  document.querySelector('[data-tab="log"]').click();
  await sleep(100);
  out.logLines = document.querySelectorAll('#log-view > div').length;
  document.querySelector('[data-tab="sound"]').click();
  const vol = document.querySelector('#vol');
  out.volInitial = vol.value;
  vol.value = '45'; vol.dispatchEvent(new Event('input')); vol.dispatchEvent(new Event('change'));
  out.volWritten = await until(() => window.dspx.store.get(12) === 585 && window.dspx.store.getStatus(12) === 1);
  document.querySelector('[data-mute="1"]').click();
  out.muteWritten = await until(() => window.dspx.store.get(2) === 1);
  // phase flag, per-channel level, delay in cm and per sample, input source
  document.querySelector('[data-ch="1"] [data-phase]').click();
  out.phaseInverted = await until(() => window.dspx.store.get(26) === 100);
  document.querySelector('[data-ch="1"] [data-phase]').click();
  out.phaseRestored = await until(() => window.dspx.store.get(26) === 600);
  const lvl = document.querySelector('[data-ch="3"] [data-level]'); lvl.value = '94'; lvl.dispatchEvent(new Event('change'));
  out.levelWritten = await until(() => window.dspx.store.get(14) === 594);
  const cmIn = document.querySelector('[data-ch="1"] [data-cm]'); cmIn.value = '34.6'; cmIn.dispatchEvent(new Event('change'));
  out.delayWritten = await until(() => window.dspx.store.get(73) === 1000);
  document.querySelector('[data-ch="1"] [data-dadd]').click();
  out.delayStepped = await until(() => window.dspx.store.get(73) === 1021);
  document.querySelector('#inputs [data-input="4"]').click();
  out.inputWritten = await until(() => window.dspx.store.get(1248) === 0x14 && document.querySelector('#inputs [data-input="4"]').classList.contains('active'));
  out.tabsOnTop = document.querySelector('header.top #tabs') !== null && getComputedStyle(document.querySelector('#tabs')).position !== 'fixed';
  document.querySelector('[data-tab="modes"]').click();
  out.modeActive = document.querySelector('.modes button.active')?.dataset.mode;
  out.snapshots = (await window.dspx.storage.getAll('snapshots')).length;
  out.storage = window.dspx.storage.backend;
  // EQ page: bundled presets load, preset apply writes both front channels, nudge writes through the throttle, verify leaves no mismatch
  document.querySelector('[data-tab="eq"]').click();
  out.eqCanvas = Boolean(document.querySelector('#eq-curve'));
  out.eqPresetsLoaded = await until(() => window.dspx.eq && window.dspx.eq.state.bundled.length === 4, 8000);
  out.eqPresetApplied = await window.dspx.eq.loadPreset('02 K-pop / J-pop', { confirm: false });
  const { eqAddr } = await import('./js/protocol/addrmap.js');
  out.eqBandCh1 = window.dspx.store.get(eqAddr(1, 5, 'G'));
  out.eqBandCh2 = window.dspx.store.get(eqAddr(2, 5, 'G'));
  out.eqBandCh3Zero = window.dspx.store.get(eqAddr(3, 5, 'G'));
  window.dspx.eq.nudge(9, { g: -4 });
  out.eqNudged = await until(() => window.dspx.store.get(eqAddr(1, 10, 'G')) === 460 && window.dspx.store.get(eqAddr(2, 10, 'G')) === 460 && window.dspx.store.getStatus(eqAddr(1, 10, 'G')) === 1, 4000);
  let mism = 0; for (let a = 138; a < 1226; a++) if (window.dspx.store.getStatus(a) === 3) mism++;
  out.eqMismatches = mism;
  // the layer not being edited still runs: a curve left on the 10-band layer must be flagged and zeroable
  await window.dspx.device.writeRegs([{ addr: 1254, val: 530 }]);
  out.otherLayerWarned = await until(() => !document.querySelector('#eq-other').hidden && document.querySelector('#eq-other-text').textContent.includes('1 個'));
  out.presetZeroesOther = (await window.dspx.eq.loadPreset('03 華語抒情', { confirm: false })) && window.dspx.store.get(1254) === 500;
  await window.dspx.device.writeRegs([{ addr: 1254, val: 530 }]);
  await until(() => !document.querySelector('#eq-other').hidden);
  out.otherLayerZeroed = (await window.dspx.eq.zeroOtherLayer({ confirm: false })) && window.dspx.store.get(1254) === 500 && (await until(() => document.querySelector('#eq-other').hidden));
  // modes: switch to slot 2 (factory flat), edit, save; the unsaved counter must return to zero and the slot must hold the edit
  out.modeSwitched = await window.dspx.modes.call(2, { confirm: false });
  out.modeActive2 = document.querySelector('.modes button.active')?.dataset.mode === '2' && window.dspx.store.get(1242) === 2 && window.dspx.device.state === 'connected';
  out.modeEqFlat = window.dspx.store.get(eqAddr(1, 5, 'G')) === 500;
  window.dspx.eq.nudge(4, { g: 2 });
  await until(() => window.dspx.eq.idle() && window.dspx.store.get(eqAddr(1, 5, 'G')) === 520, 4000);
  out.unsavedBefore = window.dspx.device.unsavedChanges().length;
  out.modeSaved = await window.dspx.modes.save({ confirm: false });
  out.unsavedAfter = window.dspx.device.unsavedChanges().length;
  out.slotSaved = window.dspx.device.transport.slots[1][eqAddr(1, 5, 'G')] === 520;
  out.modeUnsavedText = document.querySelector('#mode-unsaved').textContent;
  return out;
})()`;

const SCRIPT_B = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(50); } return false; };
  const out = {};
  document.querySelector('[data-tab="bluetooth"]').click();
  document.querySelector('#bt-disconnect').click();
  await until(() => window.dspx.device.state === 'disconnected', 4000);
  document.querySelector('[data-tab="eq"]').click();
  await sleep(100);
  out.eqDisabledWhenOffline = document.querySelector('#eq-gain').disabled && document.querySelector('#eq-load').disabled;
  out.versionLine = (document.querySelector('#bt-version')?.textContent || '').includes('線上版本');
  return out;
})()`;

const SCRIPT_C = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(50); } return false; };
  const out = {};
  out.slowBooted = await until(() => window.dspx && document.querySelector('#bt-connect'));
  document.querySelector('#bt-connect').click();
  out.slowDump = await until(() => (document.querySelector('#bt-progress-text').textContent || '').startsWith('完成'), 60000);
  document.querySelector('[data-tab="eq"]').click();
  await until(() => window.dspx.eq && window.dspx.eq.state.bundled.length === 4, 8000);
  const { eqAddr } = await import('./js/protocol/addrmap.js');
  const canvas = document.querySelector('#eq-curve');
  const r = canvas.getBoundingClientRect();
  const pt = window.dspx.eq.pointOf(9); // band 10 (160 Hz)
  const ev = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, pointerId: 7, isPrimary: true, bubbles: true, cancelable: true }));
  ev('pointerdown', pt.x, pt.y);
  for (let i = 1; i <= 12; i++) { ev('pointermove', pt.x + (i % 3), pt.y + i * 5); await sleep(30); } // mostly vertical → gain only
  ev('pointerup', pt.x, pt.y + 60);
  out.slowIdle = await until(() => window.dspx.eq.idle() && window.dspx.store.getStatus(eqAddr(1, 10, 'G')) === 1, 20000);
  const gFinal = window.dspx.store.get(eqAddr(1, 10, 'G'));
  const fFinal = window.dspx.store.get(eqAddr(1, 10, 'F'));
  out.slowGainLowered = gFinal < 480 && gFinal === window.dspx.store.get(eqAddr(2, 10, 'G'));
  out.slowFreqUnchanged = fFinal === 161; // device band 10 centre
  let mism = 0; for (let a = 138; a < 1226; a++) if (window.dspx.store.getStatus(a) === 3) mism++;
  out.slowMismatches = mism;
  out.slowUiMatchesStore = Math.abs(Number(document.querySelector('#eq-gain').value) - (gFinal - 500) / 10) < 0.05;
  // master volume: rapid steps on a slow link must not pull the channel groups apart (baseline captured once per drag)
  document.querySelector('[data-tab="sound"]').click();
  await sleep(100);
  const mv = document.querySelector('#vol');
  for (const v of ['55', '50', '45', '40']) { mv.value = v; mv.dispatchEvent(new Event('input')); await sleep(30); }
  mv.dispatchEvent(new Event('change'));
  out.slowMasterAligned = await until(() => [12, 13, 14, 15, 16, 17, 18, 19].every((a) => window.dspx.store.get(a) === 580 && window.dspx.store.getStatus(a) === 1), 15000);
  out.slowMasterValues = [12, 13, 14, 15, 16, 17, 18, 19].map((a) => window.dspx.store.get(a) + '/' + window.dspx.store.getStatus(a)).join(' ');
  // delay: typing 30 cm then tapping + right away must step from the typed value, not from the stale store
  const cmIn = document.querySelector('[data-ch="1"] [data-cm]'); cmIn.value = '30'; cmIn.dispatchEvent(new Event('change'));
  document.querySelector('[data-ch="1"] [data-dadd]').click();
  out.slowDelayStep = await until(() => window.dspx.store.get(73) === 896 && window.dspx.store.getStatus(73) === 1, 15000);
  return out;
})()`;

try {
  await sleep(500);
  await waitForCdp();
  const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?http://localhost:${PORT}/?sim=1`, { method: 'PUT' })).json();
  const cdp = await Cdp.open(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 1100, deviceScaleFactor: 2, mobile: true });
  await sleep(1500);
  const resultA = await cdp.evaluate(SCRIPT);
  // phone-sized screenshot of the EQ page for a visual check (written next to this script's output dir)
  try {
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(ROOT, '.smoke'), { recursive: true });
    for (const tab of ['eq', 'sound', 'modes']) {
      await cdp.evaluate(`document.querySelector('[data-tab="${tab}"]').click(); window.scrollTo(0, 0); true`);
      await sleep(300);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(ROOT, '.smoke', `${tab}.png`), Buffer.from(shot.data, 'base64'));
    }
  } catch (err) { console.warn('screenshot failed', err.message); }
  const resultB = await cdp.evaluate(SCRIPT_B);
  // slow-link scenario: real pointer drag on the curve with 60 ms per BLE chunk (21 sect replies + BT status frames must still beat the 1.7 s timeout); no false mismatch, final value = last drag
  await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/?sim=1&lat=60` });
  await sleep(1500);
  const resultC = await cdp.evaluate(SCRIPT_C);
  const result = { ...resultA, ...resultB, ...resultC };
  const errors = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'))
    .map((e) => e.method === 'Runtime.exceptionThrown' ? e.params.exceptionDetails.exception?.description ?? e.params.exceptionDetails.text : e.params.args.map((a) => a.value ?? a.description).join(' '));
  const checks = {
    tabs5: result.tabs === 5, pages5: result.pages === 5, booted: result.booted, connected: result.connected, dumpDone: result.dumpDone,
    allConfirmed: result.confirmed === 1613, writeTest: result.writeTest, reportOk: result.reportOk, logHasLines: result.logLines > 10,
    volInitial60: result.volInitial === '60', volWritten: result.volWritten, muteWritten: result.muteWritten, modeActive1: result.modeActive === '1',
    snapshotSaved: result.snapshots >= 1, noConsoleErrors: errors.length === 0,
    versionLine: result.versionLine,
    eqCanvas: result.eqCanvas, eqPresetsLoaded: result.eqPresetsLoaded, eqPresetApplied: result.eqPresetApplied,
    eqFrontWritten: result.eqBandCh1 === 530 && result.eqBandCh2 === 530, eqRearUntouched: result.eqBandCh3Zero === 500,
    eqNudged: result.eqNudged, eqNoMismatch: result.eqMismatches === 0, eqDisabledWhenOffline: result.eqDisabledWhenOffline,
    slowDump: result.slowDump, slowIdle: result.slowIdle, slowGainLowered: result.slowGainLowered, slowFreqUnchanged: result.slowFreqUnchanged,
    slowNoMismatch: result.slowMismatches === 0, slowUiMatchesStore: result.slowUiMatchesStore,
    phaseInverted: result.phaseInverted, phaseRestored: result.phaseRestored, levelWritten: result.levelWritten, delayWritten: result.delayWritten,
    delayStepped: result.delayStepped, inputWritten: result.inputWritten, tabsOnTop: result.tabsOnTop,
    otherLayerWarned: result.otherLayerWarned, otherLayerZeroed: result.otherLayerZeroed, presetZeroesOther: result.presetZeroesOther,
    slowMasterAligned: result.slowMasterAligned, slowDelayStep: result.slowDelayStep,
    modeSwitched: result.modeSwitched, modeActive2: result.modeActive2, modeEqFlat: result.modeEqFlat,
    modeUnsavedTracked: result.unsavedBefore > 0 && result.unsavedAfter === 0, modeSaved: result.modeSaved, slotSaved: result.slotSaved,
  };
  console.log(JSON.stringify({ result, errors, checks }, null, 1));
  const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  console.log(failed.length ? `SMOKE FAIL: ${failed.join(', ')}` : 'SMOKE OK');
  cleanup(failed.length ? 1 : 0);
} catch (err) {
  console.error('SMOKE ERROR', err);
  cleanup(1);
}
