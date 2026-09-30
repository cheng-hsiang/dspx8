import { STATE } from '../core/device.js';
import { ADDR } from '../protocol/addrmap.js';
import { INPUT_NAMES } from '../protocol/tables.js';

const STATE_TEXT = { [STATE.DISCONNECTED]: '未連線', [STATE.CONNECTING]: '連線中', [STATE.CONNECTED]: '已連線', [STATE.READONLY]: '唯讀（代碼不符）', [STATE.SWITCHING]: '切換模式中' };

export function init(ctx, el) {
  el.innerHTML = `<span class="dot"></span><span id="sb-state">未連線</span><span class="muted" id="sb-name"></span><span style="flex:1"></span><span id="sb-mode" class="muted">模式 -</span><span id="sb-input" class="muted">輸入 -</span>${ctx.transportKind === 'sim' ? '<span class="warn">模擬</span>' : ''}`;
  const dot = el.querySelector('.dot');
  const render = () => {
    dot.className = `dot ${ctx.device.state}`;
    el.querySelector('#sb-state').textContent = STATE_TEXT[ctx.device.state] ?? ctx.device.state;
    el.querySelector('#sb-name').textContent = ctx.device.state === STATE.DISCONNECTED ? '' : ctx.device.info.name;
    const mode = ctx.store.get(ADDR.M0_MODE);
    el.querySelector('#sb-mode').textContent = `模式 ${mode >= 1 && mode <= 8 ? mode : '-'}`;
    const input = ctx.store.get(ADDR.M0_INPUT_CUR) & 0x0F;
    el.querySelector('#sb-input').textContent = `輸入 ${INPUT_NAMES[input] ?? (input ? input : '-')}`;
  };
  ctx.device.on('state', render);
  ctx.store.subscribe((addrs) => { if (addrs.includes(ADDR.M0_MODE) || addrs.includes(ADDR.M0_INPUT_CUR) || addrs.length > 100) render(); });
  render();
}
