import { LAYERS, effectiveQScale, bandAddrs } from '../../eq/model.js';
import { ADDR, CH_COUNT } from '../../protocol/addrmap.js';
import { QRATE, encodeFreq, encodeGain } from '../../protocol/codec.js';
import { TUNE_F, BandAverager, powerAverage, formatBands, fmtHz } from '../../tune/bands.js';
import { THIRD_NOMINAL, THIRD_EXACT, OCTAVE_NOMINAL, weightBands, toOctaves, totalDb, iecEdges, randomErrorDb } from '../../tune/iec.js';
import { micCheck, micLimitHz } from '../../tune/mic-check.js';
import { parseMicCal, calAtBands } from '../../tune/mic-cal.js';
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
const RTA_SPAN_DB = 70;
const TIME_LETTER = { fast: 'F', slow: 'S', leq: 'eq' };
const RTA_HINT = {
  fast: '快（F）：時間常數 125 毫秒，反應快，適合看聲音的變化。',
  slow: '慢（S）：時間常數 1 秒，數字比較穩。',
};
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
    manualMutes: null, q: null, qMode: 'auto', lastApply: null, latest: null, shown: null,
    view: { time: 'slow', weight: 'Z', fraction: 3, hold: false, paused: false },
    live: { leq: new BandAverager(31), sec: 0, hold: null },
    cal: { splOffset: null, mic: null }, check: null, micWarn: '', axisMax: null,
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
    <div class="card"><h3>1. 麥克風與即時頻譜（RTA）</h3>
      <div class="row"><button id="tu-mic" class="primary">開啟麥克風</button><button id="tu-mic-off">關閉</button></div>
      <p id="tu-mic-status" class="muted" style="margin:8px 0 0"></p>
      <p id="tu-mic-warn" class="warn" style="margin:6px 0 0" hidden></p>
      <div class="meter"><div id="tu-meter"></div></div>
      <p id="tu-level" class="mono muted" style="margin:4px 0 8px"></p>
      <canvas id="tu-rta" class="eq-canvas" style="height:210px"></canvas>
      <p id="tu-rta-info" class="muted" style="margin:6px 0 8px"></p>
      <div class="row seg" id="tu-time"><span class="muted">速度</span><button data-time="fast">快 F</button><button data-time="slow">慢 S</button><button data-time="leq">平均 Leq</button></div>
      <div class="row seg" id="tu-weight"><span class="muted">計權</span><button data-weight="Z">Z 不計權</button><button data-weight="A">A</button><button data-weight="C">C</button></div>
      <div class="row seg" id="tu-frac"><span class="muted">頻寬</span><button data-frac="3">1/3 倍頻</button><button data-frac="1">1/1 倍頻</button></div>
      <div class="row seg"><button id="tu-hold">峰值保持</button><button id="tu-pause">暫停</button><button id="tu-rta-reset">重設</button><button id="tu-rta-log">寫入日誌</button></div>
      <details id="tu-cal"><summary>校正（進階，可以不做）</summary>
        <p class="muted" style="margin:0 0 8px">沒校正時，數字是 dBFS（相對值）。看頻譜的形狀、比較調整前後、自動調音，都不受影響。</p>
        <div class="row"><label>音壓計現在的讀數 <input id="tu-spl" type="number" inputmode="decimal" step="0.1" style="width:84px"> dB</label><button id="tu-spl-set">校正音量</button><button id="tu-spl-clear">取消</button></div>
        <p id="tu-spl-status" class="muted" style="margin:6px 0 10px"></p>
        <div class="row"><button id="tu-calfile-pick">載入麥克風校正檔</button><button id="tu-cal-clear">移除</button><input id="tu-calfile" type="file" accept=".txt,.cal,.frd,.csv,text/plain" hidden></div>
        <p id="tu-cal-status" class="muted" style="margin:6px 0 10px"></p>
      </details>
      <details><summary>這個頻譜分析儀依據的標準</summary>
        <ul class="plain">
          <li><b>頻段與濾波器</b>：IEC 61260-1:2014（同 ANSI S1.11）的 1/3 倍頻濾波器，中心頻率 20 Hz 到 20 kHz 共 31 段。每段是 6 階 Butterworth 帶通，設計值通過 class 1 的容差檢驗。1/1 倍頻由三個 1/3 倍頻相加。</li>
          <li><b>時間計權</b>：IEC 61672-1 的 F（125 毫秒）、S（1 秒），以及等效位準 Leq。</li>
          <li><b>頻率計權</b>：IEC 61672-1 的 A、C、Z，依各頻段的中心頻率套用。</li>
          <li><b>dBFS</b>：依 AES17，滿刻度的正弦波是 0 dBFS。</li>
          <li><b>限制</b>：手機內建的麥克風沒有經過校正，整套系統不是檢定過的音壓計。看頻譜形狀、比較調整前後是可靠的；要看絕對音壓，需要外接量測麥克風並做上面的校正。</li>
        </ul>
      </details>
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
  /** Subtract the microphone's own response (a loaded calibration file) from every level of a frame. */
  function calibrated(frame) {
    const corr = st.cal.mic?.corr;
    if (!corr) return frame;
    const fix = (a) => Float64Array.from(a, (v, i) => (v > -199 ? v - corr[i] : v));
    return { ...frame, bands: fix(frame.bands), fast: fix(frame.fast), slow: fix(frame.slow) };
  }
  function onFrame(raw) {
    const frame = calibrated(raw);
    st.latest = frame;
    runCheck(frame);
    if (!st.view.paused) {
      st.shown = frame;
      st.live.leq.add(frame.bands); st.live.sec += frame.sec;
      if (st.view.hold) { const v = rtaView(); st.live.hold = st.live.hold && st.live.hold.length === v.values.length ? st.live.hold.map((h, i) => Math.max(h, v.values[i])) : Float64Array.from(v.values); }
    }
    st.collector?.(frame);
    scheduleLive();
  }
  /** The first seconds of a freshly opened microphone: is there any sound at all, and how far up does it go. */
  function runCheck(frame) {
    const c = st.check;
    if (!c) return;
    c.avg.add(frame.bands); c.sec += frame.sec; c.peak = Math.max(c.peak, frame.peakDb);
    if (c.sec < 2.5) return;
    st.check = null;
    const bands = c.avg.mean();
    const r = micCheck({ peakDb: c.peak, bands });
    if (r.silent) {
      st.micWarn = '麥克風有開，但收到的全是靜音。這是 iPhone 上 Bluefy 這類瀏覽器的已知限制。請改用下方「麥克風在這個瀏覽器不能用時」的方法，用 Safari 量。';
      logger.error('麥克風檢查：2.5 秒內的取樣全部是 0。瀏覽器給了權限，但沒有把聲音送進 Web Audio（WKWebView 的已知問題，WebKit bug 196293）');
    } else {
      logger.info(`麥克風檢查：峰值 ${c.peak.toFixed(1)} dBFS；1/3 倍頻 Leq（dBFS）${formatBands(bands, THIRD_NOMINAL)}`);
      if (r.limitHz) {
        st.micWarn = `這個瀏覽器把 ${fmtHz(r.limitHz)}Hz 以上的聲音濾掉了，這些頻段量不到，自動調音不會修正它們。`;
        logger.warn(`麥克風檢查：${fmtHz(r.limitHz)}Hz 以上沒有訊號，可能是瀏覽器的語音處理或擷取取樣率造成`);
      }
    }
    renderMic();
  }

  // ---- analyser display
  /** What the display shows now: band levels with the chosen time weighting, frequency weighting and bandwidth. */
  function rtaView() {
    if (!st.shown) return null;
    const v = st.view, off = st.cal.splOffset ?? 0;
    const shape = (thirds) => { const w = weightBands(thirds, v.weight); return (v.fraction === 1 ? toOctaves(w) : w).map((x) => x + off); };
    const thirds = v.time === 'leq' ? st.live.leq.mean() : st.shown[v.time];
    return {
      values: shape(thirds), floor: st.ambient ? shape(st.ambient) : null,
      freqs: v.fraction === 1 ? OCTAVE_NOMINAL : THIRD_NOMINAL,
      total: totalDb(weightBands(thirds, v.weight)) + off,
      label: `L${v.weight}${TIME_LETTER[v.time]}`, unit: st.cal.splOffset === null ? 'dBFS' : 'dB',
      dim: v.fraction === 3 && st.info?.bandOk ? st.info.bandOk.map((ok) => !ok) : null,
    };
  }
  function resetRta() { st.live = { leq: new BandAverager(31), sec: 0, hold: null }; st.axisMax = null; }
  function setView(patch) {
    Object.assign(st.view, patch);
    if ('weight' in patch || 'fraction' in patch || 'time' in patch || 'hold' in patch) st.live.hold = null;
    if ('weight' in patch || 'fraction' in patch) st.axisMax = null;
    const { time, weight, fraction, hold } = st.view;
    storage.put('settings', 'tuneView', { time, weight, fraction, hold }).catch(() => {});
    renderRta(); renderLive();
  }
  function logRta() {
    const v = rtaView();
    if (!v) { toast('先開啟麥克風'); return false; }
    logger.info(`RTA ${v.label}（${st.view.fraction === 1 ? '1/1' : '1/3'} 倍頻，${v.unit}）總和 ${v.total.toFixed(1)}：${formatBands(v.values, v.freqs)}`);
    toast('目前的頻譜已寫入日誌');
    return true;
  }

  // ---- calibration: an overall offset to sound pressure level, and a microphone response file
  const saveCal = () => storage.put('settings', 'tuneCal', { splOffset: st.cal.splOffset, mic: st.cal.mic ? { name: st.cal.mic.name, points: st.cal.mic.points } : null }).catch(() => {});
  /** The display should read `reading` dB right now (what a sound level meter next to the phone shows). */
  function setSplOffset(reading) {
    if (reading === null) { st.cal.splOffset = null; logger.info('RTA：取消音量校正'); }
    else {
      const v = rtaView();
      if (!v) { toast('先開啟麥克風'); return false; }
      if (!Number.isFinite(reading) || reading < 20 || reading > 140) { toast('請輸入 20 到 140 之間的數字'); return false; }
      st.cal.splOffset = reading - (v.total - (st.cal.splOffset ?? 0));
      logger.info(`RTA：音量校正，${v.label} 現在是 ${reading} dB，0 dBFS = ${st.cal.splOffset.toFixed(1)} dB`);
    }
    st.axisMax = null; st.live.hold = null;
    saveCal(); renderRta(); renderLive();
    return true;
  }
  function loadCalText(name, text) {
    let points;
    try { points = parseMicCal(text); } catch (err) { toast(errText(err), 4000); return false; }
    setMicCal({ name, points });
    logger.info(`RTA：載入麥克風校正檔 ${name}（${points.length} 點，${fmtHz(points[0].f)}–${fmtHz(points[points.length - 1].f)} Hz）`);
    saveCal();
    return true;
  }
  /** A different microphone response makes earlier measurements incomparable, so they are dropped. */
  function setMicCal(cal) {
    st.cal.mic = cal ? { name: cal.name, points: cal.points, corr: calAtBands(cal.points) } : null;
    if (st.runs.front.length || st.runs.rear.length || st.runs.all.length || st.ambient) toast('校正檔變了，之前的量測已清除');
    st.runs = { front: [], rear: [], all: [] }; st.ambient = null;
    resetRta(); renderAll();
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
      st.source = src; st.info = info; st.micError = ''; st.micWarn = '';
      resetRta();
      src.start(onFrame);
      if (info.kind === 'sim') logger.info('自動調音：使用模擬車廂（?sim=1）');
      else {
        const s = info.settings;
        st.check = { avg: new BandAverager(31), sec: 0, peak: -200 };
        src.onState = (state) => logger.info(`音訊狀態：${state}`);
        logger.info(`麥克風已開啟：取樣率 ${info.sampleRate} Hz，擷取 ${info.capture}${info.captureNote ? `（${info.captureNote}）` : ''}，IEC 61260-1 1/3 倍頻濾波器 ${info.bandOk.filter(Boolean).length}/31 段，echoCancellation=${s.echoCancellation} noiseSuppression=${s.noiseSuppression} autoGainControl=${s.autoGainControl} 軌道取樣率=${s.sampleRate}${info.label ? `，裝置 ${info.label}` : ''}`);
        if (s.echoCancellation || s.noiseSuppression || s.autoGainControl) logger.warn('麥克風的語音處理沒有完全關閉，量測會偏');
        setTimeout(() => {
          if (st.source !== src || st.latest) return;
          st.micWarn = '麥克風開了，但沒有收到任何聲音資料。請關閉後再開一次；還是不行就改用下方「麥克風在這個瀏覽器不能用時」的方法。';
          logger.error('麥克風檢查：開啟 3 秒後仍然沒有收到任何音訊資料');
          renderMic();
        }, 3000);
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
    const s = st.source; st.source = null; st.info = null; st.latest = null; st.shown = null; st.check = null; st.micWarn = '';
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
    const maxHz = micLimitHz(measured);
    const plan = planCorrection({ measured, eqOld: eqOldFor(g), target: targetCurve(st.target), group: g, strength: strength(), ambient: st.ambient, frontMid, maxHz });
    plan.measured = measured; plan.runs = runs.length; plan.maxHz = maxHz;
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
      text = `麥克風已開啟，取樣率 ${st.info.sampleRate} Hz。${off ? '語音處理已關閉。' : '瀏覽器沒有確認已關閉語音處理，結果可能偏。'}${st.info.bandOk.every(Boolean) ? '' : '取樣率不夠高，最高的頻段（灰色）量不準。'}`;
    } else if (st.micError) text = `麥克風無法開啟：${st.micError}。請改用下方「麥克風在這個瀏覽器不能用時」的方法。`;
    else if (!useSim && !sup.getUserMedia) text = '這個瀏覽器不提供麥克風。請改用下方「麥克風在這個瀏覽器不能用時」的方法。';
    else text = '按「開啟麥克風」後，瀏覽器會詢問是否允許使用麥克風。';
    $('#tu-mic-status').textContent = text;
    $('#tu-mic-warn').textContent = st.micWarn; $('#tu-mic-warn').hidden = !st.micWarn;
  }
  function renderLive() {
    const f = st.shown, v = rtaView();
    const bar = $('#tu-meter');
    if (f && v) {
      const lv = f.levelDb, over = f.peakDb > -1, quiet = lv < -55;
      bar.style.width = `${Math.max(0, Math.min(100, ((lv + 80) / 80) * 100))}%`;
      bar.style.background = over ? 'var(--err)' : quiet ? 'var(--warn)' : 'var(--ok)';
      $('#tu-level').textContent = `${v.label} ${v.total.toFixed(1)} ${v.unit}　峰值 ${f.peakDb.toFixed(0)} dBFS${over ? '　過載：太大聲，數字不準' : quiet ? '　太小聲' : ''}`;
      const peak = Math.max(...Array.from(v.values).filter((x) => x > -199), ...(st.live.hold ?? []), -200);
      const top = Math.ceil((peak + 8) / 10) * 10;
      if (st.axisMax === null || top > st.axisMax || top < st.axisMax - 20) st.axisMax = top;
    } else { bar.style.width = '0'; $('#tu-level').textContent = ''; }
    const yMax = st.axisMax ?? 0;
    drawBars($('#tu-rta'), {
      freqs: v?.freqs ?? THIRD_NOMINAL, values: v?.values ?? null, yMin: yMax - RTA_SPAN_DB, yMax, yStep: 10, signed: false,
      hold: st.view.hold ? st.live.hold : null, floor: v?.floor ?? null, dim: v?.dim ?? null, empty: '開啟麥克風後這裡會顯示即時頻譜',
    });
    let info = RTA_HINT[st.view.time] ?? '';
    if (st.view.time === 'leq') {
      const err = (i) => { const [lo, hi] = iecEdges(THIRD_EXACT[i]); return randomErrorDb(hi - lo, st.live.sec); };
      info = st.live.sec >= 1 ? `平均（Leq）：已平均 ${st.live.sec.toFixed(0)} 秒。播放粉紅噪音時，20 Hz 段的統計誤差約 ±${err(0).toFixed(1)} dB、100 Hz 段約 ±${err(7).toFixed(1)} dB，平均越久越準。` : '平均（Leq）：從按下「重設」開始一直平均。';
    }
    if (st.ambient && v) info += '虛線是量到的背景噪音。';
    if (st.view.paused) info += '（已暫停）';
    $('#tu-rta-info').textContent = info;
  }
  function renderRta() {
    const v = st.view;
    el.querySelectorAll('[data-time]').forEach((b) => b.classList.toggle('active', b.dataset.time === v.time));
    el.querySelectorAll('[data-weight]').forEach((b) => b.classList.toggle('active', b.dataset.weight === v.weight));
    el.querySelectorAll('[data-frac]').forEach((b) => b.classList.toggle('active', Number(b.dataset.frac) === v.fraction));
    $('#tu-hold').classList.toggle('active', v.hold);
    $('#tu-pause').classList.toggle('active', v.paused);
    $('#tu-pause').textContent = v.paused ? '繼續' : '暫停';
    const off = st.cal.splOffset;
    $('#tu-spl-status').textContent = off === null ? '音量：未校正（顯示 dBFS）。把音壓計放在手機旁邊，輸入它的讀數後按「校正音量」。' : `音量：已校正，0 dBFS = ${off.toFixed(1)} dB。`;
    $('#tu-spl-clear').disabled = off === null;
    $('#tu-cal-status').textContent = st.cal.mic ? `麥克風校正檔：${st.cal.mic.name}（${st.cal.mic.points.length} 點）。` : '麥克風校正檔：沒有。外接量測麥克風（例如 miniDSP UMIK、Dayton iMM-6C）附的校正檔可以在這裡載入。';
    $('#tu-cal-clear').disabled = !st.cal.mic;
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
      if (plan.maxHz) parts.push(`麥克風在 ${fmtHz(plan.maxHz)}Hz 以上收不到聲音，這些頻段不修正。`);
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
    renderButtons(); renderTask(); renderMic(); renderRta(); renderLive(); renderQ(); renderMeasure(); renderPlan();
    $('#tu-bass').value = String(st.target.bassDb); $('#tu-treble').value = String(st.target.trebleDb);
  }

  // ---- events
  $('#tu-mic').addEventListener('click', openMic);
  $('#tu-mic-off').addEventListener('click', closeMic);
  $('#tu-wav').addEventListener('click', downloadWav);
  el.querySelectorAll('[data-time]').forEach((b) => b.addEventListener('click', () => setView({ time: b.dataset.time })));
  el.querySelectorAll('[data-weight]').forEach((b) => b.addEventListener('click', () => setView({ weight: b.dataset.weight })));
  el.querySelectorAll('[data-frac]').forEach((b) => b.addEventListener('click', () => setView({ fraction: Number(b.dataset.frac) })));
  $('#tu-hold').addEventListener('click', () => setView({ hold: !st.view.hold }));
  $('#tu-pause').addEventListener('click', () => setView({ paused: !st.view.paused }));
  $('#tu-rta-reset').addEventListener('click', () => { resetRta(); renderLive(); });
  $('#tu-rta-log').addEventListener('click', logRta);
  $('#tu-spl-set').addEventListener('click', () => { if (setSplOffset($('#tu-spl').value === '' ? NaN : Number($('#tu-spl').value))) toast('已校正'); });
  $('#tu-spl-clear').addEventListener('click', () => setSplOffset(null));
  $('#tu-calfile-pick').addEventListener('click', () => $('#tu-calfile').click());
  $('#tu-calfile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try { if (loadCalText(file.name, await file.text())) toast('校正檔已載入'); } catch (err) { toast(`讀不到檔案：${errText(err)}`); }
  });
  $('#tu-cal-clear').addEventListener('click', () => { setMicCal(null); saveCal(); logger.info('RTA：移除麥克風校正檔'); });
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
      const v = await storage.get('settings', 'tuneView');
      if (v && v.time in TIME_LETTER && ['Z', 'A', 'C'].includes(v.weight) && [1, 3].includes(v.fraction)) Object.assign(st.view, { time: v.time, weight: v.weight, fraction: v.fraction, hold: Boolean(v.hold) });
      const c = await storage.get('settings', 'tuneCal');
      if (Number.isFinite(c?.splOffset)) st.cal.splOffset = c.splOffset;
      if (c?.mic?.points?.length >= 5) st.cal.mic = { name: String(c.mic.name), points: c.mic.points, corr: calAtBands(c.mic.points) };
    } catch { /* defaults */ }
    renderAll();
  })();

  ctx.tune = { state: st, openMic, closeMic, measure, qTest, apply, undo, planFor, exportText, pasteText, rtaView, setView, resetRta, logRta, setSplOffset, loadCalText, select: (g) => { st.group = g; renderAll(); } };
  renderAll();
}
