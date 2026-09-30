import { ADDR, CH_COUNT } from '../../protocol/addrmap.js';
import { MASTER_VOL_MAX } from '../../protocol/codec.js';
import { DEFAULT_CHANNEL_NAMES, INPUT, INPUT_NAMES } from '../../protocol/tables.js';
import { readChannel, phasePair, levelPair, masterKnob, masterPairs, delayPairFromCm, delayPairFromSamples, inputPair, currentInput, LEVEL_MAX, DELAY_MAX_CM } from '../../sound/model.js';
import { toast } from '../components/dialog.js';
import { errText } from '../../util/errors.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// registers the sound page shows: mutes, per-channel levels, phase carriers, delays, input source
const soundAddr = (a) => (a >= 1 && a <= 33) || (a >= 73 && a <= 80) || a === ADDR.M0_INPUT_SET || a === ADDR.M0_INPUT_CUR;

export function init(ctx, el) {
  const { device, store, storage } = ctx;
  el.innerHTML = `
    <h2>聲音</h2>
    <div class="card"><h3>輸入源</h3>
      <div class="row" id="inputs"></div>
      <p class="muted" style="margin:8px 0 0">高亮的是機器回報的目前輸入，切換後約 1 秒更新。</p></div>
    <div class="card"><h3>主音量</h3>
      <div class="row between"><span id="vol-text" class="mono">0</span><span class="muted">寫入 MIX11_1..8，各聲道之間的差距不變</span></div>
      <input type="range" id="vol" min="0" max="${MASTER_VOL_MAX}" step="1" value="0" disabled></div>
    <div class="card">
      <div class="row between"><h3 style="margin:0">各聲道</h3><label class="muted"><input type="checkbox" id="show-all"> 顯示 CH5–CH8</label></div>
      <p class="muted" style="margin:6px 0 4px">名稱可點擊修改，只存在此瀏覽器。相位 180° 把該聲道反相。延時可直接輸入公分，或用 − / + 以 1 個取樣點（0.72 cm）微調；最遠的喇叭填 0，其餘填「最遠距離 − 自己的距離」。</p>
      <div id="ch-list"></div></div>`;
  const $ = (id) => el.querySelector(id);
  const send = (pairs) => device.writeRegs(pairs).catch((err) => toast(`寫入失敗：${errText(err)}`));

  // ---- input source
  const inputs = $('#inputs');
  inputs.innerHTML = Object.values(INPUT).map((v) => `<button data-input="${v}">${INPUT_NAMES[v]}</button>`).join('');
  inputs.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => send([inputPair(Number(b.dataset.input))])));
  const renderInputs = () => {
    const cur = currentInput(store);
    inputs.querySelectorAll('button').forEach((b) => { b.classList.toggle('active', Number(b.dataset.input) === cur); b.disabled = !device.canWrite; });
  };

  // ---- master volume
  const vol = $('#vol');
  let dragging = false, volTimer = null, lastKnob = null;
  const sendVol = (knob) => { if (knob === lastKnob) return; lastKnob = knob; send(masterPairs(store, knob)); };
  vol.addEventListener('input', () => { dragging = true; $('#vol-text').textContent = vol.value; if (!volTimer) volTimer = setTimeout(() => { volTimer = null; sendVol(Number(vol.value)); }, 50); });
  vol.addEventListener('change', () => { dragging = false; sendVol(Number(vol.value)); });
  const renderVol = () => { if (dragging) return; const v = masterKnob(store); vol.value = v; $('#vol-text').textContent = String(v); vol.disabled = !device.canWrite; lastKnob = null; };

  // ---- channels
  let names = DEFAULT_CHANNEL_NAMES.slice();
  let showAll = false;
  const list = $('#ch-list');
  list.innerHTML = Array.from({ length: CH_COUNT }, (_, i) => {
    const ch = i + 1;
    return `<div class="chrow" data-ch="${ch}" style="padding:8px 0;border-bottom:1px solid var(--line)">
      <div class="row between">
        <span>CH${ch} <button data-rename style="min-height:32px;padding:4px 10px"></button></span>
        <span class="row" style="gap:6px"><button data-mute="${ch}">靜音</button><button data-phase="${ch}">0°</button></span>
      </div>
      <div class="row" style="margin-top:4px"><span class="muted" style="width:44px">音量</span><input type="range" data-level min="0" max="${LEVEL_MAX}" step="1" style="flex:1;min-width:120px"><span class="mono" data-level-text style="width:36px;text-align:right"></span></div>
      <div class="row" style="margin-top:4px"><span class="muted" style="width:44px">延時</span><button data-dsub style="min-height:36px;padding:4px 12px">−</button><input type="number" data-cm min="0" max="${DELAY_MAX_CM}" step="0.1" inputmode="decimal" style="width:90px;min-height:36px;padding:4px 8px"><span class="muted">cm</span><button data-dadd style="min-height:36px;padding:4px 12px">+</button><span class="mono muted" data-delay-text></span></div>
    </div>`;
  }).join('');
  const levelTimers = new Map();
  const draggingLevels = new Set(); // touch range inputs do not reliably take focus, so track drags explicitly (no snap-back from echoes)
  list.querySelectorAll('.chrow').forEach((row) => {
    const ch = Number(row.dataset.ch);
    const q = (sel) => row.querySelector(sel);
    q('[data-rename]').addEventListener('click', () => {
      const v = prompt(`CH${ch} 名稱`, names[ch - 1]);
      if (v && v.trim()) { names[ch - 1] = v.trim(); storage.put('settings', 'channelNames', names).catch(() => {}); renderChannels(); }
    });
    q('[data-mute]').addEventListener('click', () => send([{ addr: ADDR.muteOfChannel(ch), val: readChannel(store, ch).muted ? 0 : 1 }]));
    q('[data-phase]').addEventListener('click', () => send([phasePair(store, ch, !readChannel(store, ch).inverted)]));
    const level = q('[data-level]');
    level.addEventListener('input', () => {
      draggingLevels.add(ch);
      q('[data-level-text]').textContent = level.value;
      if (!levelTimers.has(ch)) levelTimers.set(ch, setTimeout(() => { levelTimers.delete(ch); send([levelPair(store, ch, Number(level.value))]); }, 50));
    });
    level.addEventListener('change', () => { draggingLevels.delete(ch); send([levelPair(store, ch, Number(level.value))]); });
    q('[data-cm]').addEventListener('change', (e) => { const cm = Number(e.target.value); if (Number.isFinite(cm)) send([delayPairFromCm(ch, cm)]); else renderChannels(); });
    q('[data-dsub]').addEventListener('click', () => send([delayPairFromSamples(ch, readChannel(store, ch).samples - 1)]));
    q('[data-dadd]').addEventListener('click', () => send([delayPairFromSamples(ch, readChannel(store, ch).samples + 1)]));
  });
  const renderChannels = () => {
    const can = device.canWrite;
    list.querySelectorAll('.chrow').forEach((row) => {
      const ch = Number(row.dataset.ch);
      row.hidden = ch > 4 && !showAll;
      const c = readChannel(store, ch);
      const q = (sel) => row.querySelector(sel);
      q('[data-rename]').textContent = names[ch - 1];
      const mute = q('[data-mute]'); mute.textContent = c.muted ? '已靜音' : '靜音'; mute.className = c.muted ? 'danger' : ''; mute.disabled = !can;
      const phase = q('[data-phase]'); phase.textContent = c.inverted ? '180°' : '0°'; phase.className = c.inverted ? 'warn' : ''; phase.disabled = !can;
      const level = q('[data-level]'); if (!draggingLevels.has(ch)) { level.value = c.level; q('[data-level-text]').textContent = String(c.level); } level.disabled = !can;
      const cm = q('[data-cm]'); if (document.activeElement !== cm) cm.value = c.delayCm.toFixed(1); cm.disabled = !can;
      q('[data-dsub]').disabled = !can || c.samples <= 0; q('[data-dadd]').disabled = !can;
      q('[data-delay-text]').textContent = `${c.delayMs.toFixed(3)} ms · ${c.samples} 點`;
    });
  };
  $('#show-all').addEventListener('change', (e) => { showAll = e.target.checked; storage.put('settings', 'soundShowAll', showAll).catch(() => {}); renderChannels(); });

  const renderAll = () => { renderInputs(); renderVol(); renderChannels(); };
  storage.get('settings', 'channelNames').then((n) => { if (Array.isArray(n) && n.length === CH_COUNT) { names = n; renderChannels(); } }).catch(() => {});
  storage.get('settings', 'soundShowAll').then((v) => { if (typeof v === 'boolean') { showAll = v; $('#show-all').checked = v; renderChannels(); } }).catch(() => {});
  device.on('state', renderAll);
  store.subscribe((addrs) => { if (addrs.some(soundAddr) || addrs.length > 100) renderAll(); });
  ctx.events.addEventListener('tab', (ev) => { if (ev.detail === 'sound') renderAll(); });
  renderAll();
}
