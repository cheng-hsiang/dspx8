import { ADDR, CH_COUNT } from '../../protocol/addrmap.js';
import { encodeMasterVol, decodeMasterVol, MASTER_VOL_MAX } from '../../protocol/codec.js';
import { DEFAULT_CHANNEL_NAMES } from '../../protocol/tables.js';
import { toast } from '../components/dialog.js';

export function init(ctx, el) {
  const { device, store, storage } = ctx;
  el.innerHTML = `
    <h2>聲音</h2>
    <div class="card"><h3>主音量</h3>
      <div class="row between"><span id="vol-text" class="mono">0</span><span class="muted">寫入 MIX11_1..8</span></div>
      <input type="range" id="vol" min="0" max="${MASTER_VOL_MAX}" step="1" value="0" disabled></div>
    <div class="card"><h3>聲道辨識（逐一靜音）</h3>
      <p class="muted">用靜音找出每個 CH 實際接到哪顆喇叭。名稱可點擊修改，只存在此瀏覽器。</p>
      <div id="ch-list"></div></div>
    <div class="card"><p class="muted">相位、延時、各聲道獨立音量、輸入源切換在第二階段開放。</p></div>`;
  const $ = (id) => el.querySelector(id);
  const vol = $('#vol');
  let dragging = false, timer = null, lastSent = null;
  const sendVol = (v) => {
    const raw = encodeMasterVol(v);
    if (raw === lastSent) return; lastSent = raw;
    device.writeRegs(Array.from({ length: CH_COUNT }, (_, i) => ({ addr: ADDR.mix11(i + 1), val: raw }))).catch((err) => toast(err.message));
  };
  vol.addEventListener('input', () => { dragging = true; $('#vol-text').textContent = vol.value; if (!timer) timer = setTimeout(() => { timer = null; sendVol(Number(vol.value)); }, 50); });
  vol.addEventListener('change', () => { dragging = false; sendVol(Number(vol.value)); });
  const renderVol = () => { if (dragging) return; const v = decodeMasterVol(store.get(ADDR.mix11(1))); vol.value = v; $('#vol-text').textContent = String(v); vol.disabled = !device.canWrite; };

  let names = DEFAULT_CHANNEL_NAMES.slice();
  storage.get('settings', 'channelNames').then((n) => { if (Array.isArray(n) && n.length === CH_COUNT) { names = n; renderChannels(); } }).catch(() => {});
  const renderChannels = () => {
    $('#ch-list').innerHTML = Array.from({ length: CH_COUNT }, (_, i) => {
      const ch = i + 1, muted = store.get(ADDR.muteOfChannel(ch)) === 1;
      return `<div class="row between" style="padding:6px 0;border-bottom:1px solid var(--line)"><span>CH${ch} <button data-rename="${ch}" style="min-height:32px;padding:4px 10px">${names[i]}</button></span><button data-mute="${ch}" class="${muted ? 'danger' : ''}" ${device.canWrite ? '' : 'disabled'}>${muted ? '已靜音' : '靜音'}</button></div>`;
    }).join('');
    $('#ch-list').querySelectorAll('[data-mute]').forEach((b) => b.addEventListener('click', () => {
      const ch = Number(b.dataset.mute); const cur = store.get(ADDR.muteOfChannel(ch)) === 1;
      device.writeRegs([{ addr: ADDR.muteOfChannel(ch), val: cur ? 0 : 1 }]).catch((err) => toast(err.message));
    }));
    $('#ch-list').querySelectorAll('[data-rename]').forEach((b) => b.addEventListener('click', () => {
      const ch = Number(b.dataset.rename); const v = prompt(`CH${ch} 名稱`, names[ch - 1]);
      if (v && v.trim()) { names[ch - 1] = v.trim(); storage.put('settings', 'channelNames', names).catch(() => {}); renderChannels(); }
    }));
  };
  device.on('state', () => { renderVol(); renderChannels(); });
  store.subscribe((addrs) => { if (addrs.some((a) => a >= 1 && a <= 25) || addrs.length > 100) { renderVol(); renderChannels(); } });
  renderVol(); renderChannels();
}
