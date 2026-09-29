import { STATE } from '../../core/device.js';
import { buildReport } from '../../core/report.js';
import { ADDR } from '../../protocol/addrmap.js';
import { toast, confirmDialog } from '../components/dialog.js';
import { renderRegTable } from '../components/regtable.js';

function download(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function init(ctx, el) {
  const { device, store, logger, storage, env } = ctx;
  el.innerHTML = `
    <h2>藍牙</h2>
    <div class="banner" id="offline-status">尚未可離線使用（等待快取完成）</div>
    ${env.webBluetooth || ctx.transportKind === 'sim' ? '' : '<div class="banner warn">此瀏覽器不支援 Web Bluetooth。Android 請用 Chrome 或 Edge，iPhone 請安裝 Bluefy 瀏覽器開啟本頁。</div>'}
    <div class="card"><h3>連線</h3>
      <div class="row"><button id="bt-connect" class="primary">連線</button><button id="bt-disconnect" disabled>斷線</button>
        <label><input type="checkbox" id="bt-acceptall"> 找不到裝置時接受所有裝置</label></div>
      <p id="bt-status" class="muted">未連線</p></div>
    <div class="card"><h3>整機讀取</h3>
      <progress id="bt-progress" max="17" value="0"></progress>
      <div class="row between"><span id="bt-progress-text" class="muted">尚未讀取</span><button id="bt-redump" disabled>重新讀取</button></div></div>
    <div class="card"><h3>備份</h3>
      <div class="row"><button id="bt-export" disabled>匯出目前暫存器 JSON</button></div>
      <h3 style="margin-top:12px">還原點（自動快照）</h3><div id="bt-snaps" class="muted">沒有快照</div></div>
    <div class="card"><h3>寫入測試（第一階段）</h3>
      <p class="muted">音量先調低。對單一頻段寫入增益後讀回比對，結果會產生報告摘要到日誌分頁。</p>
      <div class="row">
        <label>聲道 <select id="wt-ch">${Array.from({ length: 8 }, (_, i) => `<option value="${i + 1}"${i === 0 ? ' selected' : ''}>CH${i + 1}</option>`).join('')}</select></label>
        <label>頻段 <select id="wt-band">${Array.from({ length: 32 }, (_, i) => `<option value="${i + 1}"${i === 2 ? ' selected' : ''}>${i + 1}</option>`).join('')}</select></label>
        <label>增益 <select id="wt-db"><option value="6" selected>+6 dB</option><option value="3">+3 dB</option><option value="0">0 dB</option><option value="-3">−3 dB</option><option value="-6">−6 dB</option></select></label>
      </div>
      <div class="row" style="margin-top:8px"><button id="wt-run" class="primary" disabled>執行寫入測試</button><button id="wt-reset" disabled>還原為 0 dB</button></div>
      <p id="wt-result" class="mono"></p></div>
    <div class="card"><details><summary>進階：原始暫存器</summary><div id="bt-regtable" style="margin-top:10px"></div></details></div>`;

  const $ = (id) => el.querySelector(id);
  const offline = $('#offline-status');
  ctx.events.addEventListener('sw-cached', (ev) => { offline.textContent = `已可離線使用，版本 ${ev.detail.version}`; offline.classList.add('ok'); });
  ctx.events.addEventListener('sw-update', (ev) => {
    offline.innerHTML = '有新版本 <button id="sw-reload" class="primary" style="margin-left:8px">重新載入</button>';
    offline.querySelector('#sw-reload').addEventListener('click', () => { ev.detail.waiting?.postMessage({ type: 'skipWaiting' }); setTimeout(() => location.reload(), 300); });
  });

  const renderState = () => {
    const s = device.state;
    $('#bt-connect').disabled = s !== STATE.DISCONNECTED;
    $('#bt-disconnect').disabled = s === STATE.DISCONNECTED;
    const live = s === STATE.CONNECTED || s === STATE.READONLY;
    $('#bt-redump').disabled = !live; $('#bt-export').disabled = store.confirmedCount() === 0;
    $('#wt-run').disabled = !device.canWrite; $('#wt-reset').disabled = !device.canWrite;
    $('#bt-status').textContent = s === STATE.DISCONNECTED ? '未連線' : s === STATE.CONNECTING ? '連線中…' : `${s === STATE.READONLY ? '唯讀模式（客戶代碼不符）' : '已連線'}：${device.info.name}，客戶代碼 ${device.info.customerId ?? '-'}`;
    $('#bt-status').className = s === STATE.READONLY ? 'warn' : s === STATE.CONNECTED ? 'ok' : 'muted';
  };
  device.on('state', renderState);
  device.on('progress', ({ done, total }) => { $('#bt-progress').max = total; $('#bt-progress').value = done; $('#bt-progress-text').textContent = `${done} / ${total}`; });
  device.on('dump', (info) => {
    $('#bt-progress-text').textContent = `${info.complete ? '完成' : '不完整'}，${info.ms} ms，${info.method}${info.failedSegments.length ? '，失敗區段 ' + info.failedSegments.join(',') : ''}`;
    renderState();
    logger.report(buildReport({ env, info: device.info, dumpInfo: info, store }));
  });

  $('#bt-connect').addEventListener('click', async () => {
    const origConnect = device.transport.connect.bind(device.transport);
    device.transport.connect = () => origConnect({ acceptAll: $('#bt-acceptall').checked });
    try { await device.connect(); } catch (err) { toast(`連線失敗：${err.message}`); } finally { device.transport.connect = origConnect; }
  });
  $('#bt-disconnect').addEventListener('click', () => device.disconnect());
  $('#bt-redump').addEventListener('click', async (e) => { e.target.disabled = true; try { await device.dump(); } catch (err) { toast(err.message); } finally { renderState(); } });

  $('#bt-export').addEventListener('click', () => {
    const payload = { exportedAt: new Date().toISOString(), device: device.info, dumpInfo: device.dumpInfo, mode: store.get(ADDR.M0_MODE), values: Array.from(store.values), status: Array.from(store.status) };
    download(`dspx8s-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, JSON.stringify(payload, null, 1));
  });

  const renderSnaps = async () => {
    const list = (await storage.getAll('snapshots')).sort((a, b) => b.value.ts - a.value.ts).slice(0, 20);
    $('#bt-snaps').innerHTML = list.length ? list.map(({ key, value }) => `<div class="row between" style="padding:6px 0;border-bottom:1px solid var(--line)"><span>${new Date(value.ts).toLocaleString()}</span><span><button data-exp="${key}">匯出</button> <button data-del="${key}" class="danger">刪除</button></span></div>`).join('') : '沒有快照';
    $('#bt-snaps').querySelectorAll('[data-exp]').forEach((b) => b.addEventListener('click', async () => { const v = await storage.get('snapshots', b.dataset.exp); download(`dspx8s-snapshot-${b.dataset.exp}.json`, JSON.stringify(v)); }));
    $('#bt-snaps').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => { if (await confirmDialog('刪除這個快照？')) { await storage.delete('snapshots', b.dataset.del); renderSnaps(); } }));
  };
  device.on('snapshot', () => setTimeout(renderSnaps, 100));
  renderSnaps();

  const runTest = async (dbOverride) => {
    const ch = Number($('#wt-ch').value), band = Number($('#wt-band').value), db = dbOverride ?? Number($('#wt-db').value);
    $('#wt-run').disabled = true; $('#wt-reset').disabled = true;
    try {
      const r = await device.writeTest(ch, band, db);
      $('#wt-result').textContent = `${r.name}: ${r.before} → ${r.sent} → 讀回 ${r.readBack} ${r.ok ? '一致' : '不符'} (${r.ms} ms)`;
      $('#wt-result').className = `mono ${r.ok ? 'ok' : 'err'}`;
      logger.report(buildReport({ env, info: device.info, dumpInfo: device.dumpInfo, store, writeTest: r }));
      toast('已產生報告摘要，請到日誌分頁複製');
    } catch (err) { $('#wt-result').textContent = `失敗：${err.message}`; $('#wt-result').className = 'mono err'; }
    finally { renderState(); }
  };
  $('#wt-run').addEventListener('click', () => runTest());
  $('#wt-reset').addEventListener('click', () => runTest(0));

  renderRegTable(ctx, $('#bt-regtable'));
  store.subscribe(() => { $('#bt-export').disabled = store.confirmedCount() === 0; });
  renderState();
}
