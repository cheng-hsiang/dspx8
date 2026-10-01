import { LAYERS, effectiveQScale, bandAddrs } from '../../eq/model.js';
import { ADDR, CH_COUNT } from '../../protocol/addrmap.js';
import { QRATE, encodeFreq, encodeGain } from '../../protocol/codec.js';
import { TUNE_F, BandAverager, powerAverage, midLevel, formatBands, fmtHz } from '../../tune/bands.js';
import { bandAvgResponse, filtersFromStore } from '../../tune/fit.js';
import { targetCurve, planCorrection, tuneWritePairs, judgeQ, eqSignature, qRawFor, midRef, TUNE_Q, NOTE_TEXT } from '../../tune/plan.js';
import { pinkNoise, wavBytes } from '../../tune/noise.js';
import { MicSource, SimSource, micSupport } from '../../tune/source.js';
import { drawLines, drawBars } from '../components/plot.js';
import { toast, confirmDialog } from '../components/dialog.js';
import { errText } from '../../util/errors.js';

const GROUP_NAME = { front: '前', rear: '後', all: '全部' };
const COLORS = { now: '#29b6f6', target: '#8b98a5', after: '#4caf50' };
const Q_TEST_BAND = 18; // 1 kHz
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const signed = (v, d = 1) => { const t = v.toFixed(d); return Number(t) === 0 ? (0).toFixed(d) : `${v > 0 ? '+' : ''}${t}`; };

export function init(ctx, el) {
  const { device, store, storage, logger, events, transportKind } = ctx;
  const params = new URLSearchParams(location.search);
  const fastSec = Number(params.get('tuneSec')) || 0; // smoke tests shorten every measurement
  const MEASURE_SEC = fastSec || 10, QTEST_SEC = fastSec || 5, AMBIENT_SEC = fastSec || 4;
  const useSim = transportKind === 'sim' && params.get('mic') !== '1';
  const SETTLE_MS = useSim ? 200 : 1200;
  const simQScale = params.get('simQ') === '1' ? 1 : QRATE;

  const st = {
    source: null, info: null, micError: '', busy: false, task: '', progress: 0,
    group: 'front', groups: { front: [1, 2], rear: [3, 4] },
    target: { bassDb: 6, trebleDb: -2 },
    runs: { front: [], rear: [], all: [] }, ambient: null,
    manualMutes: null, q: null, qMode: 'auto', lastApply: null, latest: null, rta: null,
    collector: null, cancel: null,
  };

  el.innerHTML = `
    <h2>自動調音 <span class="tag warn">未測試</span></h2>
    <div class="banner warn" id="tu-untested"><b>未測試：</b>這個功能還沒在真車上測試過，算出來的結果不一定正確。想試的話請先把音量轉小；套用後覺得不對，按「還原上次套用」就能回復。試過的結果歡迎回報給開發者。</div>
    <div class="card">
      <p style="margin:0 0 8px">用手機麥克風量車內的聲音，算出 31 段 EQ 的建議值。結果是合理的起點，最後還是用耳朵微調。</p>
      <ol class="steps">
        <li>車停好、關窗，引擎熄火或怠速。</li>
        <li>手機<b>不要</b>連車上的藍牙音樂。一開麥克風，iPhone 會把車上藍牙切成通話模式，改用車機的麥克風收音。控制 DSP 的藍牙不受影響。</li>
        <li>粉紅噪音用另一支手機、平板或隨身碟播放，音量開到平常聽歌的大小。</li>
        <li>手機放在駕駛座頭部的位置，量測時不要碰它，也不要切到別的 App（切走會中斷量測）。前後聲道都量完之前不要改音量。</li>
      </ol>
    </div>
    <div class="card"><h3>1. 麥克風</h3>
      <div class="row"><button id="tu-mic" class="primary">開啟麥克風</button><button id="tu-mic-off">關閉</button></div>
      <p id="tu-mic-status" class="muted" style="margin:8px 0 0"></p>
      <div class="meter"><div id="tu-meter"></div></div>
      <p id="tu-level" class="mono muted" style="margin:4px 0 8px"></p>
      <canvas id="tu-rta" class="eq-canvas" style="height:150px"></canvas>
    </div>
    <div class="card"><h3>2. 粉紅噪音</h3>
      <p class="muted" style="margin:0 0 8px">粉紅噪音每個八度的能量一樣，量出來的高低就是車子本身的聲音。最方便是用另一支手機或平板連車上藍牙，播放 YouTube 的「pink noise」。也可以在電腦上下載下面的檔案放進隨身碟，插在車機或 DSP 的 USB 重複播放。</p>
      <button id="tu-wav">下載 60 秒粉紅噪音（WAV）</button>
    </div>
    <div class="card"><h3>3. 驗證 Q 值（第一次做一次）</h3>
      <p class="muted" style="margin:0 0 8px">機器的 Q 值換算目前是推測的，算錯的話 EQ 會修過頭。播放粉紅噪音後按「開始驗證」，約 15 秒，中間 1 kHz 會變大聲幾秒再還原。沒驗證前，套用只會做一半的修正。</p>
      <div class="row"><button id="tu-qtest">開始驗證</button><button id="tu-qmode" hidden>EQ 頁也改用這個換算</button></div>
      <p id="tu-q" style="margin:8px 0 0"></p>
    </div>
    <div class="card"><h3>4. 量測</h3>
      <div class="row">
        <label>低頻 <select id="tu-bass"><option value="0">不加強</option><option value="3">+3 dB</option><option value="6">+6 dB（建議）</option><option value="9">+9 dB</option></select></label>
        <label>高頻 <select id="tu-treble"><option value="0">平直</option><option value="-2">−2 dB（建議）</option><option value="-4">−4 dB</option></select></label>
      </div>
      <div class="row" id="tu-groups" style="margin-top:8px"></div>
      <div class="row" style="margin-top:8px"><button id="tu-solo">只讓這組出聲</button><button id="tu-unsolo">恢復靜音設定</button></div>
      <div class="row" style="margin-top:8px"><button id="tu-ambient">量背景噪音（先停掉粉紅噪音）</button><button id="tu-measure" class="primary">開始量測</button><button id="tu-clear">清除這組量測</button></div>
      <div class="row" style="margin-top:8px"><progress id="tu-progress" value="0" max="1" style="flex:1"></progress><span id="tu-task" class="muted"></span></div>
      <p id="tu-runs" class="muted" style="margin:8px 0"></p>
      <canvas id="tu-plot" class="eq-canvas"></canvas>
      <p class="legend muted" style="margin:6px 0 0"><span><i style="background:${COLORS.now}"></i>現在</span><span><i style="background:${COLORS.target}"></i>目標</span><span><i style="background:${COLORS.after}"></i>套用後預估</span></p>
    </div>
    <div class="card"><h3>5. 建議與套用</h3>
      <p id="tu-summary" style="margin:0 0 8px"></p>
      <div class="row"><button id="tu-apply" class="primary">套用</button><button id="tu-undo">還原上次套用</button></div>
      <div class="bands" style="margin-top:8px"><table class="regs mono"><thead><tr><th>頻率</th><th>現在</th><th>建議</th><th>備註</th></tr></thead><tbody id="tu-table"></tbody></table></div>
    </div>
    <div class="card"><h3>麥克風在這個瀏覽器不能用時</h3>
      <p class="muted" style="margin:0 0 8px">Bluefy 可能不給網頁用麥克風。這時先在 Bluefy 按「只讓這組出聲」，再用 Safari 開同一個網址到這一頁量測，按「複製量測結果」，回到 Bluefy 貼在下面。貼上之前不要改 EQ。</p>
      <div class="row"><button id="tu-copy">複製量測結果</button></div>
      <textarea id="tu-paste" class="copyfallback" style="height:80px;margin-top:8px" placeholder="在這裡貼上 Safari 複製的量測結果"></textarea>
      <div class="row" style="margin-top:8px"><button id="tu-paste-go">加入這組量測</button></div>
    </div>`;
  const $ = (id) => el.querySelector(id);

  // ---- groups, Q scale, EQ state
  const channelsOf = (g) => (g === 'all' ? Array.from(new Set([...st.groups.front, ...st.groups.rear])) : st.groups[g]);
  const groupLabel = (g) => `${GROUP_NAME[g]} CH${channelsOf(g).join('+')}`;
  const settingScale = () => effectiveQScale(LAYERS.MODE, st.qMode);
  const scale = () => (st.q?.verdict === 'one' ? 1 : st.q?.verdict === 'qrate' ? QRATE : settingScale());
  const verified = () => st.q?.verdict === 'qrate' || st.q?.verdict === 'one';
  const strength = () => (verified() ? 1 : 0.5);
  const haveState = () => store.confirmedCount() > 0;
  const sigFor = (g) => (g === 'all' || !haveState() ? null : eqSignature(store, channelsOf(g)[0]));
  const eqOldFor = (g) => bandAvgResponse(filtersFromStore(store, channelsOf(g)[0], scale()).filters);
  const current = (g) => { const sig = sigFor(g); return sig ? st.runs[g].filter((r) => r.sig === sig) : []; };

  // ---- mutes (MUTE_2..9 = CH1..8)
  const muteAddr = (ch) => ADDR.muteOfChannel(ch);
  const readMutes = () => Array.from({ length: CH_COUNT }, (_, i) => store.get(muteAddr(i + 1)));
  async function writeMutes(values) {
    const pairs = values.map((val, i) => ({ addr: muteAddr(i + 1), val })).filter((p) => store.get(p.addr) !== p.val);
    if (pairs.length) await device.writeRegs(pairs);
  }
  function mutesFor(g) {
    const on = new Set(channelsOf(g)), used = new Set(channelsOf('all'));
    return readMutes().map((v, i) => (on.has(i + 1) ? 0 : used.has(i + 1) ? 1 : v));
  }

  // ---- measurement engine
  function onFrame(frame) {
    st.latest = frame;
    const p = frame.bands.map((b) => 10 ** (b / 10));
    st.rta = st.rta ? st.rta.map((v, i) => 0.75 * v + 0.25 * p[i]) : p;
    st.collector?.(frame);
    scheduleLive();
  }
  function collect(sec) {
    return new Promise((resolve, reject) => {
      const avg = new BandAverager(TUNE_F.length);
      const t0 = performance.now();
      st.cancel = () => { st.collector = null; st.cancel = null; reject(new Error('量測中斷')); };
      st.collector = (f) => {
        avg.add(f.bands);
        st.progress = Math.min(1, (performance.now() - t0) / (sec * 1000));
        $('#tu-progress').value = st.progress;
        if (st.progress >= 1) { st.collector = null; st.cancel = null; resolve({ bands: avg.mean(), frames: avg.count }); }
      };
    });
  }

  async function openMic() {
    if (st.source || st.busy) return;
    const src = useSim ? new SimSource({ regs: device.transport.regs, qScale: simQScale }) : new MicSource();
    try {
      const info = await src.open(); // MicSource creates its AudioContext before its first await: still inside the tap
      st.source = src; st.info = info; st.micError = '';
      src.start(onFrame);
      if (info.kind === 'sim') logger.info('自動調音：使用模擬車廂（?sim=1）');
      else {
        const s = info.settings;
        logger.info(`麥克風已開啟：取樣率 ${info.sampleRate} Hz，FFT ${info.fftSize}，echoCancellation=${s.echoCancellation} noiseSuppression=${s.noiseSuppression} autoGainControl=${s.autoGainControl}${info.label ? `，裝置 ${info.label}` : ''}`);
        if (s.echoCancellation || s.noiseSuppression || s.autoGainControl) logger.warn('麥克風的語音處理沒有完全關閉，量測會偏');
      }
    } catch (err) {
      st.micError = `${err?.name && err.name !== 'Error' ? `${err.name}：` : ''}${errText(err)}`;
      logger.error(`麥克風無法開啟：${st.micError}`);
      toast(`麥克風無法開啟：${st.micError}`, 5000);
    }
    renderAll();
  }
  async function closeMic() {
    st.cancel?.();
    const s = st.source; st.source = null; st.info = null; st.latest = null; st.rta = null;
    await s?.close();
    renderAll();
  }

  async function measure({ ambient = false } = {}) {
    if (!st.source) { toast('先開啟麥克風'); return; }
    if (st.busy) return;
    const g = st.group;
    st.busy = true; st.task = ambient ? '量背景噪音…' : `量測 ${groupLabel(g)}…`; renderAll();
    let prev = null;
    try {
      if (ambient) { if (st.source.kind === 'sim') st.source.ambient = true; await sleep(SETTLE_MS); }
      else if (device.canWrite) { prev = readMutes(); await writeMutes(mutesFor(g)); await sleep(SETTLE_MS); }
      const { bands, frames } = await collect(ambient ? AMBIENT_SEC : MEASURE_SEC);
      if (ambient) {
        st.ambient = bands;
        logger.info(`背景噪音（${frames} 幀）：${formatBands(bands)}`);
        toast('背景噪音已記錄，現在可以播放粉紅噪音量測');
      } else {
        const run = { bands, frames, at: Date.now(), sig: sigFor(g), raw: null, source: st.source.kind };
        if (haveState() && g !== 'all') { const e = eqOldFor(g); run.raw = Float64Array.from(bands, (v, i) => v - e[i]); }
        st.runs[g].push(run);
        logger.info(`量測 ${groupLabel(g)}（第 ${st.runs[g].length} 次，${frames} 幀，${run.source === 'sim' ? '模擬' : '麥克風'}）：${formatBands(bands)}`);
        if ((st.latest?.levelDb ?? 0) < -60) toast('收到的聲音很小，確認粉紅噪音有在播、音量夠大', 5000);
      }
    } catch (err) {
      if (err.message !== '量測中斷') { toast(`量測失敗：${errText(err)}`); logger.warn(`量測失敗：${errText(err)}`); }
    } finally {
      if (st.source?.kind === 'sim') st.source.ambient = false;
      if (prev) { try { await writeMutes(prev); } catch (err) { toast(`恢復靜音失敗：${errText(err)}`); } }
      st.busy = false; st.task = ''; st.progress = 0; renderAll();
    }
  }

  async function solo() {
    if (!device.canWrite || st.busy) return;
    if (!st.manualMutes) st.manualMutes = readMutes();
    try { await writeMutes(mutesFor(st.group)); toast(`現在只有 ${groupLabel(st.group)} 出聲`); } catch (err) { toast(`靜音失敗：${errText(err)}`); }
    renderAll();
  }
  async function unsolo() {
    if (!st.manualMutes || !device.canWrite) return;
    try { await writeMutes(st.manualMutes); st.manualMutes = null; toast('已恢復原本的靜音設定'); } catch (err) { toast(`恢復失敗：${errText(err)}`); }
    renderAll();
  }

  // ---- Q check: raise 1 kHz on the front by 9 dB with the raw Q the fitter writes, compare neighbours
  async function qTest({ confirm = true } = {}) {
    if (!st.source) { toast('先開啟麥克風'); return null; }
    if (!device.canWrite) { toast('需要先連線'); return null; }
    if (st.busy) return null;
    if (confirm && !(await confirmDialog('驗證 Q 值：前聲道的 1 kHz 會暫時調高 9 dB 約 5 秒，量完馬上還原。請先播放粉紅噪音。', { okText: '開始' }))) return null;
    const chs = st.groups.front;
    const qRaw = qRawFor(TUNE_Q, scale());
    const addrs = chs.flatMap((ch) => { const a = bandAddrs(LAYERS.MODE, ch, Q_TEST_BAND); return [a.F, a.G, a.Q]; });
    const saved = addrs.map((addr) => ({ addr, val: store.get(addr) }));
    const prevMutes = readMutes();
    const filters = () => ({ qrate: filtersFromStore(store, chs[0], QRATE).filters, one: filtersFromStore(store, chs[0], 1).filters });
    st.busy = true; st.task = 'Q 驗證：基準…'; renderAll();
    let result = null, touched = false;
    try {
      await writeMutes(mutesFor('front')); await sleep(SETTLE_MS);
      const before = filters();
      const base = await collect(QTEST_SEC);
      st.task = 'Q 驗證：1 kHz 加大…'; renderTask();
      touched = true;
      await device.writeRegs(chs.flatMap((ch) => {
        const a = bandAddrs(LAYERS.MODE, ch, Q_TEST_BAND);
        return [{ addr: a.F, val: encodeFreq(TUNE_F[Q_TEST_BAND - 1]) }, { addr: a.G, val: encodeGain(9) }, { addr: a.Q, val: qRaw }];
      }));
      await sleep(SETTLE_MS);
      const after = filters();
      const boosted = await collect(QTEST_SEC);
      result = judgeQ({ baseline: base.bands, boosted: boosted.bands, before, after, bandIdx: Q_TEST_BAND - 1 });
      st.q = { verdict: result.verdict, err: result.err, centreDelta: result.centreDelta, qRaw, at: Date.now() };
      const deltas = result.freqs.map((f, i) => `${fmtHz(f)}:${signed(result.measured[i])}`).join(' ');
      logger.info(`Q 驗證（Q 原始值 ${qRaw}）：1 kHz 變化 ${signed(result.centreDelta)} dB；差值 ${deltas}；×3.17 誤差 ${result.err.qrate.toFixed(2)} dB，×1 誤差 ${result.err.one.toFixed(2)} dB → ${result.verdict === 'qrate' ? '×3.17' : result.verdict === 'one' ? '×1' : '無法判斷'}`);
      if (result.verdict !== 'unclear') storage.put('settings', 'tuneQ', st.q).catch(() => {});
    } catch (err) {
      if (err.message !== '量測中斷') { toast(`驗證失敗：${errText(err)}`); logger.warn(`Q 驗證失敗：${errText(err)}`); }
    } finally {
      try {
        if (touched) await device.writeRegs(saved.filter((p) => store.get(p.addr) !== p.val));
        await writeMutes(prevMutes);
      } catch (err) { toast(`還原失敗：${errText(err)}，請到 EQ 頁檢查 1 kHz`, 6000); logger.error(`Q 驗證還原失敗：${errText(err)}`); }
      st.busy = false; st.task = ''; st.progress = 0; renderAll();
    }
    return result;
  }

  // ---- plan
  let memo = { key: '', plan: null };
  function planFor(g) {
    if (g === 'all') return null;
    const runs = current(g);
    if (!runs.length) return null;
    const fronts = st.runs.front.filter((r) => r.raw);
    const key = [g, runs.length, runs[runs.length - 1].at, sigFor(g), st.target.bassDb, st.target.trebleDb, strength(), scale(), st.ambient ? 1 : 0, g === 'rear' ? fronts.length : 0].join('|');
    if (memo.key === key) return memo.plan;
    const measured = powerAverage(runs.map((r) => r.bands));
    const frontMid = g === 'rear' && fronts.length ? midRef(powerAverage(fronts.map((r) => r.raw))) : null;
    const plan = planCorrection({ measured, eqOld: eqOldFor(g), target: targetCurve(st.target), group: g, strength: strength(), ambient: st.ambient, frontMid });
    plan.measured = measured; plan.runs = runs.length;
    memo = { key, plan };
    return plan;
  }

  async function apply({ confirm = true } = {}) {
    const g = st.group;
    const plan = planFor(g);
    if (!plan || !device.canWrite || st.busy) return false;
    const chs = channelsOf(g);
    const qRaw = qRawFor(TUNE_Q, scale());
    const { pairs, skipped, appFlattened } = tuneWritePairs({ gains: plan.gains, channels: chs, store, qRaw });
    if (!pairs.length) { toast('沒有需要寫入的變更'); return false; }
    const msg = [
      `把 ${groupLabel(g)} 的 31 段 EQ 換成自動調音的結果（${pairs.length} 筆寫入）。頻率回到出廠位置，Q 統一 ${TUNE_Q}。`,
      plan.strength < 1 ? 'Q 值還沒驗證，這次只套用一半的修正。' : '',
      appFlattened ? `10 段層有 ${appFlattened} 個頻段不是 0 dB，會一起歸零。` : '',
      skipped.length ? `有 ${skipped.length} 個頻段機器未啟用，會略過。` : '',
      '提醒：自動調音還沒在真車上測試過，請先把音量轉小。套用後可以按「還原上次套用」回復。',
    ].filter(Boolean).join('\n');
    if (confirm && !(await confirmDialog(msg, { okText: '套用' }))) return false;
    const snapshot = pairs.map((p) => ({ addr: p.addr, val: store.get(p.addr) }));
    st.busy = true; st.task = '寫入中…'; renderAll();
    try {
      await device.writeRegs(pairs);
      const m = await device.verify(pairs.map((p) => p.addr));
      st.lastApply = { group: g, snapshot, at: Date.now() };
      logger.info(`自動調音套用 ${groupLabel(g)}：強度 ${plan.strength === 1 ? '全部' : '一半'}，Q 原始值 ${qRaw}，預估偏離 ${plan.before.toFixed(1)} → ${plan.after.toFixed(1)} dB${plan.trimDb ? `，含整體 ${plan.trimDb.toFixed(1)} dB` : ''}；增益 ${formatBands(plan.gains)}`);
      toast(m.length ? `套用完成，但讀回不符 ${m.length} 筆` : '套用完成。再量一次看結果，滿意後到模式頁儲存。', 5000);
      return m.length === 0;
    } catch (err) { toast(`套用失敗：${errText(err)}`); return false; }
    finally { st.busy = false; st.task = ''; renderAll(); }
  }

  async function undo({ confirm = true } = {}) {
    const la = st.lastApply;
    if (!la || !device.canWrite || st.busy) return false;
    if (confirm && !(await confirmDialog(`把 ${groupLabel(la.group)} 的 EQ 還原成上次套用之前的樣子？`, { okText: '還原' }))) return false;
    st.busy = true; st.task = '還原中…'; renderAll();
    try {
      await device.writeRegs(la.snapshot);
      await device.verify(la.snapshot.map((p) => p.addr));
      st.lastApply = null;
      logger.info(`自動調音：已還原 ${groupLabel(la.group)} 上次套用之前的 EQ`);
      toast('已還原');
      return true;
    } catch (err) { toast(`還原失敗：${errText(err)}`); return false; }
    finally { st.busy = false; st.task = ''; renderAll(); }
  }

  // ---- Safari fallback: copy a measurement here, paste it in Bluefy
  /** Measurements still valid for the current EQ; without a device state (Safari) only the latest one can be trusted. */
  function exportText(g = st.group) {
    const runs = haveState() && g !== 'all' ? current(g) : st.runs[g].slice(-1);
    if (!runs.length) return null;
    const r1 = (a) => Array.from(a, (v) => Math.round(v * 10) / 10);
    return JSON.stringify({ t: 'dspx8s-tune/1', group: g, bands: r1(powerAverage(runs.map((r) => r.bands))), runs: runs.length, ambient: st.ambient ? r1(st.ambient) : null, at: new Date().toISOString() });
  }
  async function copyResult() {
    const text = exportText();
    if (!text) { toast('這組還沒有量測'); return; }
    try { await navigator.clipboard.writeText(text); toast('已複製。回到 Bluefy 的自動調音頁貼上', 4000); }
    catch { const ta = $('#tu-paste'); ta.value = text; ta.focus(); ta.select(); toast('無法自動複製，請長按文字框選擇「複製」', 5000); }
  }
  function pasteText(text) {
    let d = null;
    try { d = JSON.parse(String(text).trim()); } catch { d = null; }
    const ok = d && d.t === 'dspx8s-tune/1' && ['front', 'rear', 'all'].includes(d.group) && Array.isArray(d.bands) && d.bands.length === TUNE_F.length && d.bands.every(Number.isFinite);
    if (!ok) { toast('這不是量測結果'); return false; }
    if (!haveState()) { toast('請先連線並完成整機讀取，再貼上'); return false; }
    const bands = Float64Array.from(d.bands);
    const run = { bands, frames: 0, at: Date.now(), sig: sigFor(d.group), raw: null, source: 'paste' };
    if (d.group !== 'all') { const e = eqOldFor(d.group); run.raw = Float64Array.from(bands, (v, i) => v - e[i]); }
    st.runs[d.group].push(run);
    if (Array.isArray(d.ambient) && d.ambient.length === TUNE_F.length && d.ambient.every(Number.isFinite)) st.ambient = Float64Array.from(d.ambient);
    st.group = d.group;
    logger.info(`貼上量測 ${groupLabel(d.group)}：${formatBands(bands)}`);
    renderAll();
    return true;
  }

  function downloadWav() {
    const sr = 44100;
    const blob = new Blob([wavBytes(pinkNoise(sr * 60, { seed: 20260930, sampleRate: sr }), sr)], { type: 'audio/wav' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'pink-noise-60s.wav'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  // ---- rendering
  const norm = (v) => { if (!v) return null; const m = midRef(v); return Array.from(v, (x) => x - m); };
  function renderTask() { $('#tu-task').textContent = st.task; $('#tu-progress').value = st.progress; }
  function renderButtons() {
    const open = Boolean(st.source), can = device.canWrite, idle = !st.busy;
    $('#tu-mic').disabled = open || !idle;
    $('#tu-mic-off').disabled = !open || !idle;
    $('#tu-qtest').disabled = !open || !can || !idle;
    $('#tu-solo').disabled = !can || !idle || st.group === 'all';
    $('#tu-unsolo').disabled = !can || !idle || !st.manualMutes;
    $('#tu-ambient').disabled = !open || !idle;
    $('#tu-measure').disabled = !open || !idle;
    $('#tu-apply').disabled = !can || !idle || !planFor(st.group);
    $('#tu-apply').textContent = st.group === 'all' ? '套用' : `套用到 ${groupLabel(st.group)}`;
    $('#tu-undo').disabled = !can || !idle || !st.lastApply;
    $('#tu-copy').disabled = !st.runs[st.group].length;
    $('#tu-clear').disabled = !idle || !st.runs[st.group].length;
    $('#tu-paste-go').disabled = !idle;
    $('#tu-qmode').hidden = !(st.q?.verdict === 'one' && st.qMode !== '1');
  }
  function renderMic() {
    const sup = micSupport();
    let text;
    if (st.info?.kind === 'sim') text = '模擬車廂：不用真的麥克風，聲音由程式依目前的 EQ 和靜音算出來。';
    else if (st.info) {
      const s = st.info.settings;
      const off = [s.echoCancellation, s.noiseSuppression, s.autoGainControl].every((v) => v === false);
      text = `麥克風已開啟，取樣率 ${st.info.sampleRate} Hz。${off ? '語音處理已關閉。' : '瀏覽器沒有確認已關閉語音處理，結果可能偏。'}`;
    } else if (st.micError) text = `麥克風無法開啟：${st.micError}。請改用下方「麥克風在這個瀏覽器不能用時」的方法。`;
    else if (!useSim && !sup.getUserMedia) text = '這個瀏覽器不提供麥克風。請改用下方「麥克風在這個瀏覽器不能用時」的方法。';
    else text = '按「開啟麥克風」後，瀏覽器會詢問是否允許使用麥克風。';
    $('#tu-mic-status').textContent = text;
  }
  function renderLive() {
    const lv = st.latest?.levelDb;
    const bar = $('#tu-meter');
    if (Number.isFinite(lv)) {
      bar.style.width = `${Math.max(0, Math.min(100, ((lv + 80) / 80) * 100))}%`;
      bar.style.background = lv > -6 ? 'var(--err)' : lv < -55 ? 'var(--warn)' : 'var(--ok)';
      $('#tu-level').textContent = `${lv.toFixed(0)} dBFS${lv < -55 ? '　太小聲' : lv > -6 ? '　太大聲，可能失真' : ''}`;
    } else { bar.style.width = '0'; $('#tu-level').textContent = ''; }
    const rta = st.rta ? st.rta.map((p) => 10 * Math.log10(p)) : null;
    const m = rta ? midLevel(rta) : 0;
    drawBars($('#tu-rta'), { freqs: TUNE_F, values: rta ? rta.map((v) => v - m) : null, empty: '開啟麥克風後這裡會顯示即時頻譜' });
  }
  let liveRaf = false;
  function scheduleLive() {
    if (liveRaf || el.hidden) return;
    liveRaf = true;
    requestAnimationFrame(() => { liveRaf = false; renderLive(); });
  }
  function renderQ() {
    const q = st.q;
    const p = $('#tu-q');
    if (!q) { p.textContent = '還沒驗證。'; p.className = 'muted'; }
    else if (q.verdict === 'qrate') { p.textContent = `已驗證：Q 換算 ×3.17 正確（1 kHz 變化 ${signed(q.centreDelta)} dB，誤差 ${q.err.qrate.toFixed(1)} 對 ${q.err.one.toFixed(1)} dB）。套用會做完整修正。`; p.className = 'ok'; }
    else if (q.verdict === 'one') { p.textContent = `已驗證：機器的 Q 是原始值 ÷100，不是 ×3.17（誤差 ${q.err.one.toFixed(1)} 對 ${q.err.qrate.toFixed(1)} dB）。自動調音已改用這個換算。`; p.className = 'warn'; }
    else { p.textContent = `判斷不出來（1 kHz 只變了 ${signed(q.centreDelta)} dB）。確認粉紅噪音有在播、音量夠大、手機沒被移動，再試一次。`; p.className = 'warn'; }
  }
  function renderMeasure() {
    $('#tu-groups').innerHTML = ['front', 'rear', 'all'].map((g) => `<button data-g="${g}" class="${st.group === g ? 'active' : ''}">${groupLabel(g)}</button>`).join('');
    $('#tu-groups').querySelectorAll('[data-g]').forEach((b) => b.addEventListener('click', () => { st.group = b.dataset.g; renderAll(); }));
    const part = (g) => { const all = st.runs[g].length, ok = g === 'all' ? all : current(g).length; return `${GROUP_NAME[g]} ${all} 次${all && ok < all ? `（${all - ok} 次已過期）` : ''}`; };
    $('#tu-runs').textContent = `已量：${part('front')}、${part('rear')}、${part('all')}。背景噪音：${st.ambient ? '有' : '沒量'}。${st.manualMutes ? '目前有手動靜音。' : ''}`;
    const g = st.group, target = targetCurve(st.target), plan = planFor(g);
    const runs = g === 'all' || !haveState() ? st.runs[g] : current(g);
    const measured = plan?.measured ?? (runs.length ? powerAverage(runs.map((r) => r.bands)) : null);
    drawLines($('#tu-plot'), {
      freqs: TUNE_F,
      series: [
        { values: norm(target), color: COLORS.target, width: 1.5, dash: [5, 4] },
        { values: norm(measured), color: COLORS.now },
        { values: plan ? norm(plan.predicted) : null, color: COLORS.after },
      ],
      empty: '量測後這裡會顯示結果',
    });
  }
  function renderPlan() {
    const g = st.group, plan = planFor(g);
    const s = $('#tu-summary');
    let text = '', cls = '';
    if (g === 'all') text = '「全部」用來看前後一起播的整體結果，不會產生建議。';
    else if (!haveState()) text = st.runs[g].length ? '未連線：量測結果可以用下方「複製量測結果」帶到 Bluefy。' : '連線並完成整機讀取後，這裡會算出建議。';
    else if (!plan) {
      const stale = st.runs[g].length - current(g).length;
      text = stale ? `EQ 改過了，之前的 ${stale} 次量測已不適用，請重新量測。` : `還沒量測 ${groupLabel(g)}。`;
    } else {
      const parts = [`目前偏離目標 ${plan.before.toFixed(1)} dB，套用後預估 ${plan.after.toFixed(1)} dB（63 Hz–10 kHz，數字越小越接近目標）。平均了 ${plan.runs} 次量測。`];
      if (plan.trimDb < -0.2) parts.push(`後聲道比前聲道大聲，整體降 ${(-plan.trimDb).toFixed(1)} dB，讓聲音集中在前面。`);
      if (g === 'rear' && !st.runs.front.some((r) => r.raw)) parts.push('先量前聲道，才能算前後的音量平衡。');
      if (plan.before < 1) parts.push('已經很接近目標，不用再套用。');
      if (plan.strength < 1) { parts.push('Q 值還沒驗證，套用只做一半的修正。'); cls = 'warn'; }
      if (plan.maxBoost > 0.5) parts.push(`有頻段提升到 ${signed(plan.maxBoost)} dB，開很大聲時注意破音。`);
      const chs = channelsOf(g);
      if (chs.length > 1 && chs.some((ch) => eqSignature(store, ch) !== eqSignature(store, chs[0]))) parts.push(`CH${chs.join('、CH')} 目前的 EQ 不一樣，計算以 CH${chs[0]} 為準，套用後會一樣。`);
      text = parts.join('');
    }
    s.textContent = text; s.className = cls;
    const runs = g === 'all' || !haveState() ? st.runs[g] : current(g);
    const measured = plan?.measured ?? (runs.length ? powerAverage(runs.map((r) => r.bands)) : null);
    const nm = norm(measured);
    $('#tu-table').innerHTML = !nm ? '' : TUNE_F.map((f, i) => {
      const gain = plan ? plan.gains[i] : null;
      const note = plan?.notes[i] ? NOTE_TEXT[plan.notes[i]] : '';
      return `<tr${gain && Math.abs(gain) >= 0.1 ? '' : ' class="status-0"'}><td>${fmtHz(f)}</td><td>${signed(nm[i])}</td><td>${gain === null ? '' : signed(gain)}</td><td>${note}</td></tr>`;
    }).join('');
  }
  function renderAll() {
    renderButtons(); renderTask(); renderMic(); renderLive(); renderQ(); renderMeasure(); renderPlan();
    $('#tu-bass').value = String(st.target.bassDb); $('#tu-treble').value = String(st.target.trebleDb);
  }

  // ---- events
  $('#tu-mic').addEventListener('click', openMic);
  $('#tu-mic-off').addEventListener('click', closeMic);
  $('#tu-wav').addEventListener('click', downloadWav);
  $('#tu-qtest').addEventListener('click', () => qTest());
  $('#tu-qmode').addEventListener('click', () => {
    storage.put('settings', 'eqQMode', '1').catch(() => {});
    events.dispatchEvent(new CustomEvent('qmode', { detail: '1' }));
    toast('EQ 頁的 Q 換算已改成 1');
  });
  $('#tu-bass').addEventListener('change', (e) => { st.target.bassDb = Number(e.target.value); storage.put('settings', 'tuneTarget', st.target).catch(() => {}); renderAll(); });
  $('#tu-treble').addEventListener('change', (e) => { st.target.trebleDb = Number(e.target.value); storage.put('settings', 'tuneTarget', st.target).catch(() => {}); renderAll(); });
  $('#tu-solo').addEventListener('click', solo);
  $('#tu-unsolo').addEventListener('click', unsolo);
  $('#tu-ambient').addEventListener('click', () => measure({ ambient: true }));
  $('#tu-measure').addEventListener('click', () => measure());
  $('#tu-apply').addEventListener('click', () => apply());
  $('#tu-undo').addEventListener('click', () => undo());
  $('#tu-copy').addEventListener('click', copyResult);
  $('#tu-clear').addEventListener('click', () => { const g = st.group; if (!st.runs[g].length) return; st.runs[g] = []; logger.info(`自動調音：清除 ${groupLabel(g)} 的量測`); renderAll(); });
  $('#tu-paste-go').addEventListener('click', () => { if (pasteText($('#tu-paste').value)) $('#tu-paste').value = ''; });

  const relevant = (a) => (a >= 2 && a <= 9) || (a >= 138 && a < 1226) || (a >= 1252 && a <= 1571);
  let raf = false;
  store.subscribe((addrs) => {
    if (el.hidden || raf) return;
    if (addrs.length < 200 && !addrs.some(relevant)) return;
    raf = true;
    requestAnimationFrame(() => { raf = false; renderButtons(); renderMeasure(); renderPlan(); });
  });
  device.on('state', () => { if (device.state === 'disconnected') st.manualMutes = null; renderAll(); });
  device.on('dump', () => renderAll());
  events.addEventListener('tab', (ev) => { if (ev.detail === 'tune') renderAll(); });
  events.addEventListener('qmode', (ev) => { st.qMode = ev.detail; renderAll(); });

  (async () => {
    try {
      const g = await storage.get('settings', 'eqGroups'); if (g?.front?.length && g?.rear?.length) st.groups = { front: g.front, rear: g.rear };
      st.qMode = (await storage.get('settings', 'eqQMode')) ?? st.qMode;
      const q = await storage.get('settings', 'tuneQ'); if (q?.verdict === 'qrate' || q?.verdict === 'one') st.q = q;
      const t = await storage.get('settings', 'tuneTarget'); if (Number.isFinite(t?.bassDb) && Number.isFinite(t?.trebleDb)) st.target = t;
    } catch { /* defaults */ }
    renderAll();
  })();

  ctx.tune = { state: st, openMic, closeMic, measure, qTest, apply, undo, planFor, exportText, pasteText, select: (g) => { st.group = g; renderAll(); } };
  renderAll();
}
