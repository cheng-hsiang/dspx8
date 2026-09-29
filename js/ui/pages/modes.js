import { ADDR } from '../../protocol/addrmap.js';
import { toast } from '../components/dialog.js';

export function init(ctx, el) {
  const { store } = ctx;
  el.innerHTML = `<h2>模式</h2><div class="card"><div class="modes" id="modes"></div><p id="mode-cur" class="muted" style="margin:12px 0 0">目前模式 -</p><p class="muted">8 組都是使用者預設槽。切換與儲存在第二階段開放，第一階段只顯示目前所在的模式。</p></div>`;
  const grid = el.querySelector('#modes');
  grid.innerHTML = Array.from({ length: 8 }, (_, i) => `<button data-mode="${i + 1}">模式 ${i + 1}</button>`).join('');
  grid.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => toast('模式切換與儲存在第二階段開放')));
  const render = () => {
    const m = store.get(ADDR.M0_MODE);
    grid.querySelectorAll('button').forEach((b) => b.classList.toggle('active', Number(b.dataset.mode) === m));
    el.querySelector('#mode-cur').textContent = `目前模式 ${m >= 1 && m <= 8 ? m : '-'}`;
  };
  store.subscribe((addrs) => { if (addrs.includes(ADDR.M0_MODE) || addrs.length > 100) render(); });
  render();
}
