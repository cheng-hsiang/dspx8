import { describeAddr, DUMP_END } from '../../protocol/addrmap.js';
import { STATUS } from '../../core/store.js';

const STATUS_TEXT = { [STATUS.UNKNOWN]: '未知', [STATUS.CONFIRMED]: '', [STATUS.PENDING]: '待確認', [STATUS.MISMATCH]: '不符' };

export function renderRegTable(ctx, el) {
  el.innerHTML = `
    <div class="row">
      <label>起 <input type="number" id="rt-from" min="0" max="${DUMP_END}" value="138" style="width:90px"></label>
      <label>迄 <input type="number" id="rt-to" min="0" max="${DUMP_END}" value="177" style="width:90px"></label>
      <input type="search" id="rt-q" placeholder="搜尋名稱，例如 CH1 EQ 或 MIX11" style="flex:1;min-width:160px">
    </div>
    <div style="overflow:auto;max-height:50vh;margin-top:8px"><table class="regs mono"><thead><tr><th>位址</th><th>名稱</th><th>十進位</th><th>十六進位</th><th>狀態</th></tr></thead><tbody id="rt-body"></tbody></table></div>`;
  const from = el.querySelector('#rt-from'), to = el.querySelector('#rt-to'), q = el.querySelector('#rt-q'), body = el.querySelector('#rt-body');
  const render = () => {
    const needle = q.value.trim().toLowerCase();
    let a = Math.max(0, Number(from.value) || 0), b = Math.min(DUMP_END, Number(to.value) || 0);
    if (needle) { a = 0; b = DUMP_END; }
    const rows = [];
    for (let addr = a; addr <= b && rows.length < 400; addr++) {
      const name = describeAddr(addr);
      if (needle && !name.toLowerCase().includes(needle)) continue;
      const v = ctx.store.get(addr), st = ctx.store.getStatus(addr);
      const dev = st === STATUS.MISMATCH ? `（機器 ${ctx.store.deviceValues.get(addr)}）` : '';
      rows.push(`<tr class="status-${st}"><td>${addr}</td><td>${name}</td><td>${v}</td><td>0x${v.toString(16).toUpperCase().padStart(4, '0')}</td><td>${STATUS_TEXT[st]}${dev}</td></tr>`);
    }
    body.innerHTML = rows.join('') || '<tr><td colspan="5" class="muted">沒有符合的位址</td></tr>';
  };
  for (const i of [from, to, q]) i.addEventListener('input', render);
  let scheduled = false;
  ctx.store.subscribe(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; const d = el.closest('details'); if (!d || d.open) render(); });
  });
  el.closest('details')?.addEventListener('toggle', (ev) => { if (ev.target.open) render(); });
  render();
}
