import { Logger } from '../../core/logger.js';
import { LogPersister } from '../../core/storage.js';
import { toast, confirmDialog } from '../components/dialog.js';

const MAX_DOM = 2000;
const IMPORTANT = new Set(['INFO', 'WARN', 'ERR', 'REPORT']);
const PACKETS = new Set(['TX', 'RX']);

async function copyText(el, text) {
  try { await navigator.clipboard.writeText(text); toast('已複製'); return; } catch { /* fall through */ }
  const ta = el.querySelector('#log-fallback');
  ta.hidden = false; ta.value = text; ta.focus(); ta.select();
  toast('無法自動複製，請長按文字框選擇「複製」', 4000);
}

async function shareText(text) {
  if (!navigator.share) { toast('此瀏覽器不支援分享'); return; }
  try {
    const file = new File([text], 'dspx8s-log.txt', { type: 'text/plain' });
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: 'DSP-X8s 日誌' });
    else await navigator.share({ text, title: 'DSP-X8s 日誌' });
  } catch (err) { if (err.name !== 'AbortError') toast(`分享失敗：${err.message}`); }
}

export function init(ctx, el) {
  const { logger, storage } = ctx;
  el.innerHTML = `
    <h2>日誌</h2>
    <div class="card">
      <div class="row">
        <button id="log-copy" class="primary">複製全部</button>
        <button id="log-copy-report">複製報告摘要</button>
        <button id="log-share">分享</button>
        <button id="log-export">匯出 .txt</button>
        <button id="log-clear" class="danger">清除</button>
        <button id="log-restore">載入上次日誌</button>
      </div>
      <div class="row" style="margin-top:8px">
        <label>顯示 <select id="log-filter"><option value="all">全部</option><option value="important">重點</option><option value="packets">只看封包</option></select></label>
        <label><input type="checkbox" id="log-auto" checked> 自動捲動</label>
        <span id="log-count" class="muted"></span>
      </div>
      <textarea id="log-fallback" class="copyfallback" hidden readonly style="margin-top:8px"></textarea>
    </div>
    <div id="log-view" class="log mono"></div>`;
  const $ = (id) => el.querySelector(id);
  const view = $('#log-view');
  let filter = 'all';
  const keep = (e) => filter === 'all' || (filter === 'important' ? IMPORTANT.has(e.level) : PACKETS.has(e.level));

  const line = (e) => { const d = document.createElement('div'); d.className = `l-${e.level}`; d.textContent = Logger.formatEntry(e); return d; };
  const renderAll = () => {
    view.replaceChildren(...logger.entries.filter(keep).slice(-MAX_DOM).map(line));
    $('#log-count').textContent = `${logger.entries.length} 行${logger.truncated ? '（已丟棄較舊）' : ''}`;
    if ($('#log-auto').checked) view.scrollTop = view.scrollHeight;
  };
  logger.subscribe((e) => {
    if (!keep(e)) return;
    view.appendChild(line(e));
    while (view.childElementCount > MAX_DOM) view.firstElementChild.remove();
    $('#log-count').textContent = `${logger.entries.length} 行`;
    if ($('#log-auto').checked && !el.hidden) view.scrollTop = view.scrollHeight;
  });
  $('#log-filter').addEventListener('change', (ev) => { filter = ev.target.value; renderAll(); });
  $('#log-copy').addEventListener('click', () => copyText(el, logger.toText(filter)));
  $('#log-copy-report').addEventListener('click', () => { const r = logger.lastReport(); if (!r) toast('尚無報告摘要，請先完成整機讀取或寫入測試'); else copyText(el, r); });
  $('#log-share').addEventListener('click', () => shareText(logger.toText(filter)));
  $('#log-export').addEventListener('click', () => {
    const blob = new Blob([logger.toText('all')], { type: 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `dspx8s-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  $('#log-clear').addEventListener('click', async () => { if (await confirmDialog('清除目前日誌？')) { logger.clear(); renderAll(); } });
  $('#log-restore').addEventListener('click', async () => {
    const last = await LogPersister.loadLast(storage);
    if (!last) { toast('沒有上次日誌'); return; }
    if (await confirmDialog(`載入上次保存的 ${last.length} 行日誌？目前日誌會接在後面。`)) { logger.restore([...last, ...logger.entries]); renderAll(); }
  });
  ctx.events.addEventListener('tab', (ev) => { if (ev.detail === 'log') renderAll(); });
  renderAll();
}
