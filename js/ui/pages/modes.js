import { ADDR, CH_COUNT } from '../../protocol/addrmap.js';
import { STATE } from '../../core/device.js';
import { toast, confirmDialog } from '../components/dialog.js';
import { errText } from '../../util/errors.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function init(ctx, el) {
  const { device, store, storage } = ctx;
  let names = Array(8).fill('');
  el.innerHTML = `<h2>模式</h2>
    <div class="card">
      <div class="modes" id="modes"></div>
      <p id="mode-cur" style="margin:12px 0 0">目前模式 -</p>
      <p id="mode-unsaved" class="muted" style="margin:6px 0 0"></p>
      <div class="row" style="margin-top:10px"><button id="mode-save" class="primary">儲存到目前模式</button><button id="mode-rename">命名這個模式</button></div>
    </div>
    <div class="card"><p class="muted" style="margin:0">8 組都是使用者的儲存槽。點其他模式會叫機器載入那一槽並重新讀取（約 5 秒），沒儲存的調整會被丟掉。建議模式 1 保持原廠平直當備援，調好的音色存到 2 到 5：先切到那個模式，載入預設或調整，再按「儲存到目前模式」。名稱只存在此瀏覽器。</p></div>`;
  const $ = (id) => el.querySelector(id);
  const grid = $('#modes');
  const current = () => store.get(ADDR.M0_MODE);
  const known = (m) => m >= 1 && m <= 8;
  const label = (m) => `模式 ${m}${names[m - 1] ? `：${names[m - 1]}` : ''}`;

  grid.innerHTML = Array.from({ length: 8 }, (_, i) => `<button data-mode="${i + 1}">模式 ${i + 1}<br><small class="muted" data-name></small></button>`).join('');
  grid.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => call(Number(b.dataset.mode))));

  const render = () => {
    const m = current();
    const switching = device.state === STATE.SWITCHING;
    grid.querySelectorAll('button').forEach((b) => {
      const n = Number(b.dataset.mode);
      b.classList.toggle('active', n === m);
      b.disabled = !device.canWrite;
      b.querySelector('[data-name]').textContent = names[n - 1] || '';
    });
    $('#mode-cur').textContent = switching ? '切換中，重新讀取機器設定…' : `目前${known(m) ? label(m) : '模式 -'}`;
    $('#mode-save').disabled = !device.canWrite || !known(m);
    $('#mode-save').textContent = known(m) ? `儲存到模式 ${m}` : '儲存到目前模式';
    $('#mode-rename').disabled = !known(m);
    const unsaved = device.canWrite && device.modeBaseline ? device.unsavedChanges().length : 0;
    const p = $('#mode-unsaved');
    if (!device.canWrite || !device.modeBaseline) { p.textContent = ''; p.className = 'muted'; }
    else if (unsaved) { p.textContent = `有 ${unsaved} 筆設定還沒儲存到模式 ${m}，機器斷電後可能會消失。`; p.className = 'warn'; }
    else { p.textContent = `目前設定已與模式 ${m} 儲存的內容一致。`; p.className = 'ok'; }
  };

  async function call(n, { confirm = true } = {}) {
    if (!device.canWrite) { toast('未連線或唯讀'); return false; }
    if (n === current()) { toast(`已經在模式 ${n}`); return false; }
    const unsaved = device.unsavedChanges().length;
    const msg = unsaved ? `切換到模式 ${n}？目前有 ${unsaved} 筆還沒儲存的設定會被丟掉。` : `切換到模式 ${n}？機器會載入該槽的設定並重新讀取，約 5 秒。`;
    if (confirm && !(await confirmDialog(msg, { okText: '切換' }))) return false;
    try { await device.callMode(n); toast(`已切換到模式 ${n}`); return true; }
    catch (err) { toast(`切換失敗：${errText(err)}`); return false; }
    finally { render(); }
  }

  async function save({ confirm = true } = {}) {
    const m = current();
    if (!device.canWrite || !known(m)) { toast('未連線或唯讀'); return false; }
    const muted = Array.from({ length: CH_COUNT }, (_, i) => store.get(ADDR.muteOfChannel(i + 1)) === 1).filter(Boolean).length;
    const msg = `把目前運作中的全部設定寫進模式 ${m}？會覆寫該槽原本的內容。${muted ? `目前有 ${muted} 個聲道靜音中，會一起存進模式。` : ''}`;
    if (confirm && !(await confirmDialog(msg, { okText: '儲存' }))) return false;
    try { await device.saveMode(m); toast(`已儲存到模式 ${m}`); return true; }
    catch (err) { toast(`儲存失敗：${errText(err)}`); return false; }
    finally { render(); }
  }

  $('#mode-save').addEventListener('click', () => save());
  $('#mode-rename').addEventListener('click', async () => {
    const m = current(); if (!known(m)) return;
    const v = prompt(`模式 ${m} 的名稱（留空清除）`, names[m - 1]);
    if (v === null) return;
    names[m - 1] = v.trim().slice(0, 20);
    await storage.put('settings', 'modeNames', names).catch(() => {});
    render();
  });

  storage.get('settings', 'modeNames').then((n) => { if (Array.isArray(n) && n.length === 8) { names = n.map((s) => String(s ?? '')); render(); } }).catch(() => {});
  device.on('state', render); device.on('dump', render); device.on('saved', render); device.on('mode', render);
  store.subscribe(() => { if (!el.hidden) render(); });
  ctx.events.addEventListener('tab', (ev) => { if (ev.detail === 'modes') render(); });
  render();
  ctx.modes = { call, save, current, label: (m) => esc(label(m)) };
}
