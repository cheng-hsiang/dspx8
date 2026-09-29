import { LAYERS, layerInfo, readBands, bandWritePairs, presetWritePairs, resetChannelPairs, copyChannelPairs, inferQScale, effectiveQScale, describeQScale, nearest, Q_MIN, Q_MAX } from '../../eq/model.js';
import { loadBundledPresets, localPresets, validatePreset, PRESET_SCHEMA } from '../../eq/presets.js';
import { createCurve } from '../components/curve.js';
import { toast, confirmDialog } from '../components/dialog.js';
import { ADDR, CH_COUNT } from '../../protocol/addrmap.js';
import { decodeFreq, decodeGain, decodeQ } from '../../protocol/codec.js';
import { TAB_FREQ, TAB_Q, DEFAULT_CHANNEL_NAMES } from '../../protocol/tables.js';
import { STATUS } from '../../core/store.js';

// 車主配置：前組 = CH1+CH2（門中低音 + 儀表高音 + 中置音圈，被動分音），後組 = CH3+CH4（後門中低音）。
const DEFAULT_GROUPS = {
  front: { name: '前', channels: [1, 2], hint: '含門中低音、儀表高音、中置。重低音 RCA 假設接在 CH2 前級：80 Hz 以下的調整會同時推到重低音（待靜音測試確認）。' },
  rear: { name: '後', channels: [3, 4], hint: '後門中低音，沒有高音單體。' },
};
const STATUS_TEXT = { [STATUS.UNKNOWN]: '未知', [STATUS.CONFIRMED]: '', [STATUS.PENDING]: '待確認', [STATUS.MISMATCH]: '不符' };
const fmtF = (f) => (f >= 1000 ? `${Math.round(f / 10) / 100}k` : `${Math.round(f * 10) / 10}`);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const download = (name, text) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); };
const parseChannels = (text) => { const list = String(text).split(/[,，\s]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= CH_COUNT); return Array.from(new Set(list)); };

export function init(ctx, el) {
  const { device, store, storage, logger } = ctx;
  const st = { layer: LAYERS.MODE, qMode: 'auto', qInferred: null, sel: { kind: 'group', key: 'front' }, band: 0, advanced: false, groups: structuredClone(DEFAULT_GROUPS), names: DEFAULT_CHANNEL_NAMES.slice(), bundled: [], local: [], busy: false };
  const pending = new Map(); const touched = new Set(); const sent = new Map(); const outstanding = new Set();
  let writeTimer = null, verifyTimer = null;
  const skippedWarned = new Set();

  el.innerHTML = `
    <h2>EQ</h2>
    <div class="card">
      <div class="row" id="eq-chips"></div>
      <p id="eq-hint" class="muted" style="margin:8px 0 0"></p>
      <div class="row" style="margin-top:8px">
        <label>層 <select id="eq-layer"><option value="mode">31 段（模式區）</option><option value="app">10 段（原廠層）</option></select></label>
        <label>Q 換算 <select id="eq-qmode"><option value="auto">自動</option><option value="1">1</option><option value="qrate">×3.17（原廠）</option></select></label>
        <span id="eq-qinfo" class="muted"></span>
        <span id="eq-bypass" class="muted"></span>
      </div>
    </div>
    <div class="card">
      <canvas id="eq-curve" class="eq-canvas"></canvas>
      <div class="row" style="margin-top:10px">
        <span id="eq-selname" class="mono" style="min-width:90px">—</span>
        <label>頻率 <select id="eq-freq">${TAB_FREQ.map((f) => `<option value="${f}">${fmtF(f)} Hz</option>`).join('')}</select></label>
        <label>Q <select id="eq-q">${TAB_Q.map((q) => `<option value="${q}">${q}</option>`).join('')}</select></label>
        <label style="flex:1;min-width:200px">增益 <span id="eq-gain-text" class="mono">0.0 dB</span><input type="range" id="eq-gain" min="-12" max="12" step="0.1" value="0"></label>
        <button id="eq-gain-sub">−0.5</button><button id="eq-gain-add">+0.5</button><button id="eq-band-reset">此段歸零</button>
        <button id="eq-accept" class="warn" hidden>以機器為準</button>
      </div>
    </div>
    <div class="card">
      <div class="row">
        <button id="eq-reset">重置本組增益</button>
        <label>複製到 <select id="eq-copy-to">${Array.from({ length: CH_COUNT }, (_, i) => `<option value="${i + 1}">CH${i + 1}</option>`).join('')}</select></label><button id="eq-copy">複製</button>
      </div>
      <div class="row" style="margin-top:8px">
        <label>預設 <select id="eq-preset"></select></label>
        <button id="eq-load" class="primary">載入預設</button>
        <button id="eq-save-local">存為本地預設</button>
        <button id="eq-del-local" class="danger">刪除本地</button>
        <button id="eq-export">匯出</button>
        <label><input type="file" id="eq-import" accept="application/json" hidden><button id="eq-import-btn">匯入</button></label>
      </div>
      <p id="eq-preset-desc" class="muted" style="margin:8px 0 0"></p>
    </div>
    <div class="card"><div class="bands"><table class="regs mono"><thead><tr><th>#</th><th>頻率</th><th>增益</th><th>Q</th><th>狀態</th></tr></thead><tbody id="eq-bands"></tbody></table></div></div>`;
  const $ = (id) => el.querySelector(id);

  const qScale = () => effectiveQScale(st.layer, st.qMode, st.qInferred);
  const channels = () => (st.sel.kind === 'group' ? st.groups[st.sel.key].channels : st.sel.kind === 'all' ? Array.from({ length: CH_COUNT }, (_, i) => i + 1) : [st.sel.ch]);
  const groupsMap = () => Object.fromEntries(Object.entries(st.groups).map(([k, g]) => [k, g.channels]));
  /** Store view with the values we have sent but not yet verified laid on top, so the UI never snaps back to a stale ack. */
  const view = { get: (a) => (sent.has(a) ? sent.get(a) : store.get(a)), getStatus: (a) => store.getStatus(a) };
  const bands = () => readBands(view, { layer: st.layer, ch: channels()[0], qScale: qScale() });
  const canEdit = () => device.canWrite && !st.busy;

  const curve = createCurve($('#eq-curve'), {
    snapF: (f) => nearest(TAB_FREQ, f),
    onSelect: (i) => { st.band = i; renderControls(); renderTable(); },
    onDrag: (i, values) => { queueWrite(i + 1, values); renderControls(); },
  });

  function queueWrite(band, values) {
    if (!canEdit()) return;
    const { pairs, skipped } = bandWritePairs(st.layer, channels(), band, values, qScale(), view);
    for (const ch of skipped) { const key = `${st.layer}:${ch}:${band}`; if (!skippedWarned.has(key)) { skippedWarned.add(key); toast(`CH${ch} 第 ${band} 段機器未啟用，已略過`); } }
    for (const p of pairs) { pending.set(p.addr, p.val); sent.set(p.addr, p.val); touched.add(p.addr); }
    if (!writeTimer) writeTimer = setTimeout(flush, 50);
  }
  function flush() {
    writeTimer = null;
    if (pending.size === 0) return;
    const pairs = Array.from(pending, ([addr, val]) => ({ addr, val })); pending.clear();
    const p = device.writeRegs(pairs).catch((err) => { if (device.canWrite) toast(`寫入失敗：${err.message}`); });
    outstanding.add(p); p.finally(() => outstanding.delete(p));
    clearTimeout(verifyTimer);
    verifyTimer = setTimeout(async () => {
      // never read back while our own writes are still in the queue: verify compares against what we sent
      await Promise.allSettled(Array.from(outstanding));
      if (pending.size > 0 || writeTimer) return; // more edits arrived; the next flush re-arms verify
      const addrs = Array.from(touched); touched.clear();
      if (!device.canWrite || addrs.length === 0) { for (const a of addrs) sent.delete(a); return; }
      try { const m = await device.verify(addrs); if (m.length) toast(`讀回不符 ${m.length} 筆，已標紅`); }
      catch (err) { if (device.canWrite) toast(`讀回失敗：${err.message}`); }
      finally { for (const a of addrs) sent.delete(a); renderAll(); }
    }, 300);
  }
  async function writeNow(pairs, label) {
    if (!canEdit()) { toast('未連線或唯讀'); return false; }
    if (pairs.length === 0) { toast(`${label}：沒有需要寫入的變更`); return true; }
    st.busy = true; renderControls();
    try { await device.writeRegs(pairs); const m = await device.verify(pairs.map((p) => p.addr)); toast(m.length ? `${label}：讀回不符 ${m.length} 筆` : `${label}完成`); return m.length === 0; }
    catch (err) { toast(`${label}失敗：${err.message}`); return false; }
    finally { st.busy = false; renderAll(); }
  }

  function renderChips() {
    const chips = [];
    for (const [k, g] of Object.entries(st.groups)) chips.push(`<button data-sel="group:${k}" class="${st.sel.kind === 'group' && st.sel.key === k ? 'active' : ''}">${esc(g.name)} CH${g.channels.join('+')}</button>`);
    chips.push(`<button data-adv="1" class="${st.advanced ? 'active' : ''}">進階</button>`);
    if (st.advanced) {
      for (let ch = 1; ch <= CH_COUNT; ch++) chips.push(`<button data-sel="channel:${ch}" class="${st.sel.kind === 'channel' && st.sel.ch === ch ? 'active' : ''}">CH${ch} ${esc(st.names[ch - 1])}</button>`);
      chips.push(`<button data-sel="all" class="${st.sel.kind === 'all' ? 'active' : ''}">全部連動</button>`);
      chips.push('<button data-groups="1">編輯群組</button>');
    }
    $('#eq-chips').innerHTML = chips.join('');
    $('#eq-chips').querySelectorAll('[data-sel]').forEach((b) => b.addEventListener('click', () => {
      const [kind, key] = b.dataset.sel.split(':');
      st.sel = kind === 'group' ? { kind, key } : kind === 'channel' ? { kind, ch: Number(key) } : { kind: 'all' };
      st.band = Math.min(st.band, layerInfo(st.layer).bands - 1); renderAll();
    }));
    $('#eq-chips').querySelector('[data-adv]').addEventListener('click', () => { st.advanced = !st.advanced; renderChips(); });
    $('#eq-chips').querySelector('[data-groups]')?.addEventListener('click', editGroups);
    $('#eq-hint').textContent = st.sel.kind === 'group' ? st.groups[st.sel.key].hint : st.sel.kind === 'all' ? '對全部 8 聲道寫入相同的頻段設定。' : `只調 CH${st.sel.ch}。`;
  }

  async function editGroups() {
    const front = parseChannels(prompt('前組聲道（逗號分隔，1 到 8）', st.groups.front.channels.join(',')) ?? '');
    if (!front.length) return;
    const rear = parseChannels(prompt('後組聲道（逗號分隔，1 到 8）', st.groups.rear.channels.join(',')) ?? '');
    if (!rear.length) return;
    st.groups.front.channels = front; st.groups.rear.channels = rear;
    await storage.put('settings', 'eqGroups', { front, rear }).catch(() => {});
    toast('群組已更新'); renderAll();
  }

  function renderControls() {
    const list = bands(); const b = list[st.band];
    const enabled = canEdit() && b && b.enabled;
    for (const id of ['#eq-reset', '#eq-copy', '#eq-load']) $(id).disabled = !canEdit();
    for (const id of ['#eq-freq', '#eq-q', '#eq-gain', '#eq-gain-sub', '#eq-gain-add', '#eq-band-reset']) $(id).disabled = !enabled;
    $('#eq-save-local').disabled = st.busy; // saving what is displayed needs no connection
    const mism = b ? ['F', 'G', 'Q'].filter((f) => store.getStatus(b.addrs[f]) === STATUS.MISMATCH) : [];
    $('#eq-accept').hidden = mism.length === 0;
    if (!b) { $('#eq-selname').textContent = '—'; return; }
    $('#eq-selname').textContent = `第 ${b.band} 段${b.enabled ? '' : '（未啟用）'}`;
    const nearestOpt = (sel, v) => { let best = 0, bd = Infinity; Array.from(sel.options).forEach((o, i) => { const d = Math.abs(Number(o.value) - v); if (d < bd) { bd = d; best = i; } }); if (sel.selectedIndex !== best) sel.selectedIndex = best; };
    nearestOpt($('#eq-freq'), b.f); nearestOpt($('#eq-q'), b.q);
    $('#eq-gain').value = b.g; $('#eq-gain-text').textContent = `${b.g >= 0 ? '+' : ''}${b.g.toFixed(1)} dB`;
    $('#eq-qinfo').textContent = describeQScale(st.layer, st.qMode, st.qInferred);
    $('#eq-qinfo').className = st.layer === LAYERS.MODE && st.qMode === 'auto' && st.qInferred === null ? 'warn' : 'muted';
    const bypassKnown = store.getStatus(ADDR.EQ_BYPASS_SWITCH) !== STATUS.UNKNOWN;
    $('#eq-bypass').textContent = !bypassKnown ? 'EQ 狀態 —' : store.get(ADDR.EQ_BYPASS_SWITCH) === 0 ? 'EQ 旁通中' : 'EQ 啟用';
    $('#eq-bypass').className = !bypassKnown ? 'muted' : store.get(ADDR.EQ_BYPASS_SWITCH) === 0 ? 'warn' : 'ok';
  }

  function renderTable() {
    const list = bands();
    const dev = (b) => ['F', 'G', 'Q'].filter((f) => store.getStatus(b.addrs[f]) === STATUS.MISMATCH).map((f) => { const v = store.deviceValues.get(b.addrs[f]); if (v == null) return `${f} 無回應`; return f === 'F' ? `F ${fmtF(decodeFreq(v))}` : f === 'G' ? `G ${decodeGain(v).toFixed(1)}` : `Q ${(decodeQ(v) * qScale()).toFixed(2)}`; }).join(' ');
    $('#eq-bands').innerHTML = list.map((b, i) => `<tr data-i="${i}" class="status-${b.status}${i === st.band ? ' sel' : ''}${b.enabled ? '' : ' off'}"><td>${b.band}</td><td>${b.enabled ? fmtF(b.f) : '未啟用'}</td><td>${b.enabled ? (b.g >= 0 ? '+' : '') + b.g.toFixed(1) : ''}</td><td>${b.enabled ? b.q.toFixed(2) : ''}</td><td>${STATUS_TEXT[b.status]}${b.status === STATUS.MISMATCH ? `（機器 ${dev(b)}）` : ''}</td></tr>`).join('');
  }
  $('#eq-bands').addEventListener('click', (ev) => { const tr = ev.target.closest('tr[data-i]'); if (!tr) return; st.band = Number(tr.dataset.i); curve.setSelected(st.band); renderControls(); renderTable(); });
  function renderCurve() { curve.setBands(bands()); curve.setSelected(st.band); }
  function renderPresets() {
    const opt = (p, k) => `<option value="${k}:${esc(p.name)}">${esc(p.name)}</option>`;
    $('#eq-preset').innerHTML = `<optgroup label="內建">${st.bundled.map((p) => opt(p, 'b')).join('')}</optgroup><optgroup label="本地">${st.local.map((p) => opt(p, 'l')).join('')}</optgroup>`;
    renderPresetDesc();
  }
  function currentPreset() { const v = $('#eq-preset').value || ''; const [k, name] = [v.slice(0, 1), v.slice(2)]; return (k === 'b' ? st.bundled : st.local).find((p) => p.name === name) ?? null; }
  function renderPresetDesc() { const p = currentPreset(); $('#eq-preset-desc').textContent = p ? `${p.description ?? ''}${p.levelDb ? `　後聲道建議比前聲道 ${p.levelDb.rear} dB（聲音頁手動調）。` : ''}${p.sub ? `　重低音本體：低通 ${p.sub.lpfHz} Hz，增益${p.sub.gain}，相位${p.sub.phase}。` : ''}` : ''; }
  function renderAll() { renderChips(); renderCurve(); renderControls(); renderTable(); }

  $('#eq-layer').addEventListener('change', (e) => { st.layer = e.target.value; st.band = 0; storage.put('settings', 'eqLayer', st.layer).catch(() => {}); renderAll(); });
  $('#eq-qmode').addEventListener('change', (e) => { st.qMode = e.target.value; storage.put('settings', 'eqQMode', st.qMode).catch(() => {}); renderAll(); });
  $('#eq-freq').addEventListener('change', (e) => { queueWrite(st.band + 1, { f: Number(e.target.value) }); renderCurve(); });
  $('#eq-q').addEventListener('change', (e) => { queueWrite(st.band + 1, { q: Number(e.target.value) }); renderCurve(); });
  $('#eq-gain').addEventListener('input', (e) => { const g = Number(e.target.value); $('#eq-gain-text').textContent = `${g >= 0 ? '+' : ''}${g.toFixed(1)} dB`; queueWrite(st.band + 1, { g }); renderCurve(); });
  const step = (d) => { const b = bands()[st.band]; if (!b) return; queueWrite(st.band + 1, { g: Math.round((b.g + d) * 10) / 10 }); renderControls(); renderCurve(); };
  $('#eq-gain-sub').addEventListener('click', () => step(-0.5));
  $('#eq-gain-add').addEventListener('click', () => step(0.5));
  $('#eq-band-reset').addEventListener('click', () => { queueWrite(st.band + 1, { g: 0 }); renderControls(); renderCurve(); });
  $('#eq-accept').addEventListener('click', () => { const b = bands()[st.band]; if (!b) return; for (const f of ['F', 'G', 'Q']) { store.acceptDevice(b.addrs[f]); sent.delete(b.addrs[f]); } renderAll(); });
  $('#eq-reset').addEventListener('click', async () => { if (await confirmDialog('把本組所有頻段的增益歸零？頻率與 Q 不變。')) { const pairs = channels().flatMap((ch) => resetChannelPairs(st.layer, ch, store)); await writeNow(pairs, '重置'); } });
  $('#eq-copy').addEventListener('click', async () => { const to = Number($('#eq-copy-to').value); const from = channels()[0]; if (to === from) { toast('來源與目標相同'); return; } if (await confirmDialog(`把 CH${from} 的頻段複製到 CH${to}？`)) await writeNow(copyChannelPairs(st.layer, from, [to], store), '複製'); });
  $('#eq-preset').addEventListener('change', renderPresetDesc);

  async function loadPreset(preset, { confirm = true } = {}) {
    if (!preset) { toast('沒有選擇預設'); return false; }
    if (!canEdit()) { toast('未連線或唯讀'); return false; }
    // only the owner's own groups are ever written, whatever group names a (possibly imported) preset carries
    const groups = groupsMap();
    const { pairs, dropped, skipped } = presetWritePairs({ ...preset, eq: Object.fromEntries(Object.entries(preset.eq).filter(([k]) => k in groups)) }, st.layer, groups, store, qScale());
    const droppedUnique = Array.from(new Set(dropped.map((d) => `${d.group}:${d.f}`)));
    const ignoredGroups = Object.keys(preset.eq).filter((k) => !(k in groups));
    const detail = [`載入「${preset.name}」會覆寫前後兩組全部頻段的增益（${pairs.length} 筆寫入）。`,
      droppedUnique.length ? `有 ${droppedUnique.length} 個濾波器找不到可用頻段，會被略過：${droppedUnique.map((s) => s.split(':')[1] + ' Hz').join('、')}。` : '',
      skipped.length ? `聲道 CH${skipped.join('、CH')} 沒有啟用的頻段，會被略過。` : '',
      ignoredGroups.length ? `預設裡的群組「${ignoredGroups.join('、')}」不在你的配置中，不會寫入。` : ''].filter(Boolean).join('\n');
    if (confirm && !(await confirmDialog(detail))) return false;
    logger.info(`載入預設 ${preset.name}：${pairs.length} 筆寫入，略過聲道 ${skipped.join(',') || '無'}，丟棄濾波器 ${droppedUnique.length}`);
    return writeNow(pairs, `載入 ${preset.name}`);
  }
  $('#eq-load').addEventListener('click', () => loadPreset(currentPreset()));

  const buildPreset = (name) => {
    const eq = {};
    for (const [k, g] of Object.entries(st.groups)) eq[k] = readBands(store, { layer: st.layer, ch: g.channels[0], qScale: qScale() }).filter((b) => b.enabled && b.g !== 0).map((b) => ({ f: b.f, g: b.g, q: Math.min(Q_MAX, Math.max(Q_MIN, Math.round(b.q * 100) / 100)) }));
    return { schema: PRESET_SCHEMA, name, description: `由網頁在 ${new Date().toLocaleString()} 儲存（${layerInfo(st.layer).label}）`, channelGroups: groupsMap(), eq };
  };
  $('#eq-save-local').addEventListener('click', async () => { const name = prompt('預設名稱'); if (!name?.trim()) return; try { await localPresets(storage).save(name.trim(), buildPreset(name.trim())); st.local = await localPresets(storage).list(); renderPresets(); toast('已儲存'); } catch (err) { toast(err.message); } });
  $('#eq-del-local').addEventListener('click', async () => { const p = currentPreset(); if (!p || p.source !== 'local') { toast('請選一個本地預設'); return; } if (await confirmDialog(`刪除本地預設「${p.name}」？`)) { await localPresets(storage).remove(p.name); st.local = await localPresets(storage).list(); renderPresets(); } });
  $('#eq-export').addEventListener('click', () => { const p = currentPreset() ?? buildPreset('目前設定'); download(`dspx8s-preset-${p.name}.json`, JSON.stringify(p, null, 1)); });
  $('#eq-import-btn').addEventListener('click', () => $('#eq-import').click());
  $('#eq-import').addEventListener('change', async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    try { const p = JSON.parse(await file.text()); const v = validatePreset(p); if (!v.ok) throw new Error(v.errors.join('; ')); await localPresets(storage).save(p.name, p); st.local = await localPresets(storage).list(); renderPresets(); toast(`已匯入 ${p.name}`); }
    catch (err) { toast(`匯入失敗：${err.message}`); } finally { e.target.value = ''; }
  });

  const inBandRange = (a) => (a >= 138 && a < 1226) || (a >= 1252 && a <= 1571) || a === ADDR.EQ_BYPASS_SWITCH;
  let raf = false;
  store.subscribe((addrs) => {
    if (el.hidden || raf) return;
    if (addrs.length < 200 && !addrs.some(inBandRange)) return; // heartbeat reads never touch EQ registers
    raf = true;
    requestAnimationFrame(() => { raf = false; if (curve.dragging) { renderTable(); return; } renderCurve(); renderControls(); renderTable(); });
  });
  device.on('state', () => { if (device.state === 'disconnected') { sent.clear(); pending.clear(); touched.clear(); } renderAll(); });
  device.on('dump', () => { st.qInferred = inferQScale(store); sent.clear(); if (!el.hidden) renderAll(); });
  ctx.events.addEventListener('tab', (ev) => { if (ev.detail === 'eq') renderAll(); });

  (async () => {
    try {
      st.layer = (await storage.get('settings', 'eqLayer')) ?? st.layer; st.qMode = (await storage.get('settings', 'eqQMode')) ?? st.qMode;
      const n = await storage.get('settings', 'channelNames'); if (Array.isArray(n) && n.length === CH_COUNT) st.names = n;
      const g = await storage.get('settings', 'eqGroups'); if (g?.front?.length && g?.rear?.length) { st.groups.front.channels = g.front; st.groups.rear.channels = g.rear; }
    } catch { /* defaults */ }
    $('#eq-layer').value = st.layer; $('#eq-qmode').value = st.qMode;
    if (store.confirmedCount() > 0) st.qInferred = inferQScale(store);
    try { st.bundled = await loadBundledPresets(); } catch (err) { logger.warn(`內建預設載入失敗：${err.message}`); }
    try { st.local = await localPresets(storage).list(); } catch { /* ignore */ }
    renderPresets(); renderAll();
  })();

  ctx.eq = {
    loadPreset: (name, opts) => loadPreset([...st.bundled, ...st.local].find((p) => p.name === name), opts),
    nudge: (bandIndex, values) => { st.band = bandIndex; queueWrite(bandIndex + 1, values); renderControls(); renderCurve(); },
    select: (sel) => { st.sel = sel; renderAll(); },
    pointOf: (i) => curve.pointOf(i),
    idle: () => pending.size === 0 && !writeTimer && outstanding.size === 0 && sent.size === 0,
    state: st,
  };
  renderAll();
}
