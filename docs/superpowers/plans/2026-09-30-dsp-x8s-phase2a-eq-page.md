# DSP-X8s 第二階段 A：EQ 頁 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做出可在模擬機器與真機上操作的參數 EQ 頁：兩層可選（模式區 31 段、原廠層 10 段），聲道連動群組依車主配置預設「前 CH1+CH2」「後 CH3+CH4」，響應曲線可拖曳，四組內建預設可一鍵載入，寫入後讀回比對。

**Architecture:** 新增 `js/eq/`（純函式：二階濾波器響應、EQ 資料模型、預設檔對應）與 `js/ui/components/curve.js`、重寫 `js/ui/pages/eq.js`。寫入一律經 `Device.writeRegs`（允許清單擴充到原廠層的 F/G/Q）。Q 值換算比例 `qScale` 由整機讀取結果自動推斷，可手動覆寫。

**Tech Stack:** 同第一階段。canvas 2D 畫曲線，Pointer Events 拖曳。

**Spec:** `docs/superpowers/specs/2026-09-29-dsp-x8s-web-tuner-design.md` §7.3、§8；預設檔格式 `presets/README.md`。

## Global Constraints

- 第一階段的全部限制沿用。允許寫入的位址新增：原廠層 `ADDR.iir100(ch, band, F|G|Q)`（1252 到 1571，排除 TYPE）。TYPE 仍一律拒絕。
- 增益限制 −12 到 +12 dB，0.1 dB 一格；頻率只能取 `TAB_FREQ` 內的值；Q 只能取 `TAB_Q` 內的值。
- 響應曲線以 48 kHz、峰值型二階濾波器（Audio EQ Cookbook peakingEQ）計算。
- 拖曳中每 50 ms 最多送一次；停止 300 ms 後讀回本次觸碰的位址並比對。
- 群組寫入：對群組任何一個聲道的變更同步寫到組內全部聲道的相同頻段索引。
- 頻段 `TYPE === 0` 或 `F === 0` 視為機器未啟用，只顯示不可編輯。
- 版本號改為 0.2.0（`sw.js` VERSION 與 `index.html` data-version）。`presets/` 要進 PRECACHE 與 `tools/pack.mjs`。

## Review Focus

1. 預設檔兩個濾波器對應到同一個最接近頻段：第二個必須落到下一個最近的未使用頻段，不能覆蓋。測試在 Task 2。
2. 群組內某聲道的頻段未啟用（TYPE 0）而其他聲道啟用：寫入只送啟用的聲道，UI 顯示警告，不整組拒絕。測試在 Task 2。
3. qScale 推斷為 unclear 時：預設用 1（不套用），UI 顯示「Q 換算未確認」，寫入 Q 仍允許但標示。測試在 Task 2。
4. 使用者在拖曳期間斷線：UI 停止送出、不拋未處理例外，重連後畫面依 store 重繪。Task 5 手動與 smoke 驗證。
5. 曲線拖曳把頻率拖出表格範圍：夾在 19.7 到 20600 之間並取表格最近值。測試在 Task 1（nearest）與 Task 4（clamp）。

---

### Task 1: 二階濾波器響應（js/eq/biquad.js）

**Files:** Create `js/eq/biquad.js`, Test `test/biquad.test.js`

**Interfaces:**
- `peakingCoeffs(f0, gainDb, q, fs = 48000) → { b0, b1, b2, a0, a1, a2 }`
- `magnitudeDb(coeffs, f, fs = 48000) → number`
- `responseDb(bands: [{ f, g, q, enabled }], freqs: number[], fs = 48000) → number[]`（未啟用或 g 為 0 的頻段跳過）
- `logFreqAxis(n = 200, fMin = 20, fMax = 20000) → number[]`

- [ ] **Step 1: 測試**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { peakingCoeffs, magnitudeDb, responseDb, logFreqAxis } from '../js/eq/biquad.js';

test('peaking filter reaches its gain at f0 and ~0 dB far away', () => {
  const c = peakingCoeffs(1000, 6, 1.4);
  assert.ok(Math.abs(magnitudeDb(c, 1000) - 6) < 0.05);
  assert.ok(Math.abs(magnitudeDb(c, 20)) < 0.1);
  assert.ok(Math.abs(magnitudeDb(c, 15000)) < 0.2);
  const cut = peakingCoeffs(250, -4, 1.0);
  assert.ok(Math.abs(magnitudeDb(cut, 250) + 4) < 0.05);
});

test('higher Q is narrower: one octave away, Q 4 is closer to 0 dB than Q 1', () => {
  const wide = magnitudeDb(peakingCoeffs(1000, 6, 1), 2000);
  const narrow = magnitudeDb(peakingCoeffs(1000, 6, 4), 2000);
  assert.ok(narrow < wide);
  assert.ok(wide > 1.5);
});

test('responseDb sums bands and skips disabled or flat ones', () => {
  const freqs = [100, 1000, 10000];
  const r = responseDb([{ f: 1000, g: 3, q: 1.4, enabled: true }, { f: 1000, g: 3, q: 1.4, enabled: false }, { f: 10000, g: 0, q: 1, enabled: true }], freqs);
  assert.ok(Math.abs(r[1] - 3) < 0.05);
  assert.ok(Math.abs(r[2]) < 0.2);
  assert.deepEqual(responseDb([], freqs), [0, 0, 0]);
});

test('logFreqAxis is log-spaced from 20 to 20000', () => {
  const a = logFreqAxis(5);
  assert.equal(a.length, 5);
  assert.ok(Math.abs(a[0] - 20) < 1e-9 && Math.abs(a[4] - 20000) < 1e-6);
  assert.ok(Math.abs(a[2] - Math.sqrt(20 * 20000)) < 1e-6);
});
```

- [ ] **Step 2: RED**（`node --test test/biquad.test.js` → module not found）

- [ ] **Step 3: 實作**

```js
export function peakingCoeffs(f0, gainDb, q, fs = 48000) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / fs;
  const alpha = Math.sin(w0) / (2 * q);
  const cos = Math.cos(w0);
  return { b0: 1 + alpha * A, b1: -2 * cos, b2: 1 - alpha * A, a0: 1 + alpha / A, a1: -2 * cos, a2: 1 - alpha / A };
}

export function magnitudeDb({ b0, b1, b2, a0, a1, a2 }, f, fs = 48000) {
  const w = (2 * Math.PI * f) / fs;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
  const dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

export function responseDb(bands, freqs, fs = 48000) {
  const coeffs = bands.filter((b) => b.enabled !== false && b.g !== 0 && b.f > 0 && b.q > 0).map((b) => peakingCoeffs(b.f, b.g, b.q, fs));
  return freqs.map((f) => coeffs.reduce((sum, c) => sum + magnitudeDb(c, f, fs), 0));
}

export function logFreqAxis(n = 200, fMin = 20, fMax = 20000) {
  const r = Math.log(fMax / fMin);
  return Array.from({ length: n }, (_, i) => fMin * Math.exp((r * i) / (n - 1)));
}
```

- [ ] **Step 4: GREEN、commit** `feat(eq): peaking biquad response math`

---

### Task 2: EQ 資料模型與允許清單（js/eq/model.js、addrmap.js）

**Files:** Create `js/eq/model.js`, Modify `js/protocol/addrmap.js`（`isWritableAddr` 允許 iir100 F/G/Q）, `js/transport/fake-device.js`（seed 原廠層：每聲道 10 段，F = 60/350/2000/10100 前四段、其餘 0，G 500，Q 12（= 40/QRate 取整））, Test `test/model.test.js`, 修改 `test/addrmap.test.js`（1252 TYPE 拒絕、1253..1255 允許）

**Interfaces:**
- `LAYERS = { MODE: 'mode', APP: 'app' }`；`layerInfo(layer) → { bands: 31|10, label }`（MODE 顯示 31 段，第 32 欄位以 `showSlot32` 進階選項才顯示）
- `bandAddrs(layer, ch, band) → { TYPE, F, G, Q }`
- `QRATE = 7.6 / 2.4`；`inferQScale(store) → 1 | QRATE | null`（用 report.js 的 inferQScale：no-qrate→1，qrate→QRATE，unclear→null）
- `readBands(store, { layer, ch, qScale, slots }) → [{ band, addrs, type, f, g, q, enabled, status }]`（`enabled = type !== 0 && rawF !== 0`；`q = decodeQ(raw) * qScale`）
- `encodeBand({ f, g, q }, qScale) → { F, G, Q }` 原始值（`Q = round(100 * q / qScale)`，G 夾在 ±12，f 取 TAB_FREQ 最近值，q 取 TAB_Q 最近值）
- `bandWritePairs(layer, channels: number[], band, { f?, g?, q? }, qScale, store) → { pairs, skipped: number[] }`（只含有變更的欄位；未啟用的聲道進 skipped）
- `nearest(table, v) → number`
- `mapPresetToBands(filters: [{f,g,q}], bands) → [{ band, f, g, q }]`：每個濾波器對應到「啟用且未被使用」中 F 最接近的頻段；沒有可用頻段時丟棄並回報在 `dropped`
- `presetWritePairs(preset, layer, groups: { front:[..], rear:[..] }, store, qScale) → { pairs, dropped: [{group, f}], skipped: number[] }`：對每組每聲道，先把所有啟用頻段 G 設 0（保留 F/Q），再套用對應結果
- `resetChannelPairs(layer, ch, store) → pairs`（G 全 500）
- `copyChannelPairs(layer, from, to: number[], store) → pairs`（複製 F/G/Q）

- [ ] **Step 1: 測試**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as m from '../js/eq/model.js';
import { RegisterStore } from '../js/core/store.js';
import { FakeDevice } from '../js/transport/fake-device.js';
import { eqAddr, ADDR, isWritableAddr } from '../js/protocol/addrmap.js';
import { encodeFreq } from '../js/protocol/codec.js';

function seeded() { const d = new FakeDevice(); const s = new RegisterStore(); s.setMany(Array.from({ length: s.size }, (_, addr) => ({ addr, val: d.regs[addr] }))); return s; }

test('layers and addresses', () => {
  assert.equal(m.layerInfo(m.LAYERS.MODE).bands, 31);
  assert.equal(m.layerInfo(m.LAYERS.APP).bands, 10);
  assert.deepEqual(m.bandAddrs(m.LAYERS.MODE, 1, 3), { TYPE: 154, F: 155, G: 156, Q: 157 });
  assert.deepEqual(m.bandAddrs(m.LAYERS.APP, 1, 1), { TYPE: 1252, F: 1253, G: 1254, Q: 1255 });
  assert.equal(isWritableAddr(1253), true);
  assert.equal(isWritableAddr(1252), false);
});

test('readBands decodes and flags disabled slots', () => {
  const s = seeded();
  const bands = m.readBands(s, { layer: m.LAYERS.MODE, ch: 1, qScale: 1 });
  assert.equal(bands.length, 31);
  assert.equal(bands[0].f, 20); assert.equal(bands[0].g, 0); assert.equal(bands[0].q, 4.32); assert.equal(bands[0].enabled, true);
  const all = m.readBands(s, { layer: m.LAYERS.MODE, ch: 1, qScale: 1, slots: 32 });
  assert.equal(all[31].enabled, false);
  const app = m.readBands(s, { layer: m.LAYERS.APP, ch: 1, qScale: m.QRATE });
  assert.equal(app.length, 10);
  assert.equal(app[0].f, 60); assert.equal(app[4].enabled, false);
  assert.ok(Math.abs(app[0].q - 0.38) < 0.01);
});

test('inferQScale maps report verdicts', () => {
  const s = seeded();
  assert.equal(m.inferQScale(s), 1);           // seeded Q raw 432 → not in either window → unclear? see below
});

test('encodeBand snaps to tables, clamps gain, applies qScale', () => {
  assert.deepEqual(m.encodeBand({ f: 1001, g: 15, q: 1.35 }, 1), { F: 1000, G: 620, Q: 140 });
  assert.deepEqual(m.encodeBand({ f: 60, g: -3, q: 0.4 }, m.QRATE), { F: encodeFreq(60), G: 470, Q: 13 });
  assert.equal(m.nearest([1, 2, 4, 8], 5), 4);
  assert.equal(m.nearest([1, 2, 4, 8], 100), 8);
});

test('bandWritePairs writes only changed fields to every enabled channel of the group', () => {
  const s = seeded();
  const r = m.bandWritePairs(m.LAYERS.MODE, [1, 2], 3, { g: 6 }, 1, s);
  assert.deepEqual(r.pairs, [{ addr: eqAddr(1, 3, 'G'), val: 560 }, { addr: eqAddr(2, 3, 'G'), val: 560 }]);
  assert.deepEqual(r.skipped, []);
  s.set(eqAddr(2, 3, 'TYPE'), 0);
  const r2 = m.bandWritePairs(m.LAYERS.MODE, [1, 2], 3, { g: 6, f: 1250 }, 1, s);
  assert.deepEqual(r2.skipped, [2]);
  assert.deepEqual(r2.pairs.map((p) => p.addr), [eqAddr(1, 3, 'F'), eqAddr(1, 3, 'G')]);
});

test('mapPresetToBands picks nearest unused enabled band; collisions go to the next nearest', () => {
  const s = seeded();
  const bands = m.readBands(s, { layer: m.LAYERS.MODE, ch: 1, qScale: 1 });
  const r = m.mapPresetToBands([{ f: 1000, g: 1, q: 1 }, { f: 1010, g: 2, q: 1 }, { f: 50, g: 3, q: 1 }], bands);
  assert.deepEqual(r.mapped.map((x) => x.band), [18, 19, 5]);
  assert.deepEqual(r.dropped, []);
  const tiny = bands.slice(0, 1);
  const r2 = m.mapPresetToBands([{ f: 20, g: 1, q: 1 }, { f: 25, g: 1, q: 1 }], tiny);
  assert.equal(r2.mapped.length, 1); assert.deepEqual(r2.dropped.map((d) => d.f), [25]);
});

test('presetWritePairs zeroes gains then applies, per group', () => {
  const s = seeded();
  const preset = { schema: 'dspx8s-preset/1', channelGroups: { front: [1, 2], rear: [3, 4] }, eq: { front: [{ f: 50, g: 3, q: 1.2 }], rear: [] } };
  const r = m.presetWritePairs(preset, m.LAYERS.MODE, { front: [1, 2], rear: [3, 4] }, s, 1);
  const g50 = r.pairs.filter((p) => p.addr === eqAddr(1, 5, 'G'));
  assert.equal(g50.at(-1).val, 530);
  assert.ok(r.pairs.some((p) => p.addr === eqAddr(1, 5, 'F') && p.val === encodeFreq(50)));
  assert.ok(r.pairs.some((p) => p.addr === eqAddr(1, 5, 'Q') && p.val === 120));
  assert.ok(r.pairs.some((p) => p.addr === eqAddr(3, 1, 'G') && p.val === 500));
  assert.equal(r.dropped.length, 0);
});

test('reset and copy helpers', () => {
  const s = seeded();
  s.set(eqAddr(1, 2, 'G'), 530);
  const reset = m.resetChannelPairs(m.LAYERS.MODE, 1, s);
  assert.ok(reset.every((p) => p.val === 500) && reset.some((p) => p.addr === eqAddr(1, 2, 'G')));
  const copy = m.copyChannelPairs(m.LAYERS.MODE, 1, [3], s);
  assert.ok(copy.some((p) => p.addr === eqAddr(3, 2, 'G') && p.val === 530));
  assert.ok(!copy.some((p) => p.addr === eqAddr(3, 2, 'TYPE')));
});
```

`inferQScale` 測試改為：把 8 聲道第 1 段 Q 設 100 → 1；設 32 → `m.QRATE`；設 900 → null。

- [ ] **Step 2: RED**
- [ ] **Step 3: 實作 model.js**（依 Interfaces；`readBands` 的 `slots` 預設為 `layerInfo(layer).bands`；APP 層 band 1..10；`mapPresetToBands` 以 `|log(f/bandF)|` 距離排序）
- [ ] **Step 4: addrmap 允許清單加 `addr >= 1252 && addr <= 1571 && (addr - 1252) % 4 !== 0`；FakeDevice seed APP 層**
- [ ] **Step 5: GREEN（含 addrmap、device、fake-device 既有測試）、commit** `feat(eq): EQ data model, preset mapping, app-layer allow-list`

---

### Task 3: 內建預設檔載入（js/eq/presets.js）

**Files:** Create `js/eq/presets.js`, `presets/index.json`（`["01-reference.json", ...]`）, Test `test/presets.test.js`

**Interfaces:**
- `validatePreset(obj) → { ok, errors: string[] }`（schema 字串、name、eq 物件、每個濾波器 f 在 19 到 21000、g 在 ±12、q 在 0.4 到 128）
- `loadBundledPresets(fetchFn = fetch, base = './presets/') → Promise<preset[]>`（讀 index.json 再逐檔讀取；失敗的檔案略過並回報 `console.warn`）
- `localPresets(storage)`：`list()`, `save(name, preset)`, `remove(name)`；存在 `settings` 的 key `eqPresets`（物件 name → preset）

- [ ] **Step 1: 測試**（node：用 `readFile` 模擬 fetch，驗證四個內建檔都通過 validatePreset；一個壞檔被略過；localPresets 用記憶體 Storage 存取）
- [ ] **Step 2: RED → 實作 → GREEN → commit** `feat(eq): bundled and local preset registry`

---

### Task 4: 曲線元件（js/ui/components/curve.js）

**Files:** Create `js/ui/components/curve.js`

**Interfaces:**
- `createCurve(canvasEl, { onDrag(bandIndex, { f, g }), onSelect(bandIndex), fMin = 20, fMax = 20000, dbRange = 15 })` → `{ setBands(bands), setSelected(i), destroy() }`
- 畫格線（20/50/100/200/500/1k/2k/5k/10k/20k，±15/±10/±5/0 dB）、合成曲線（`responseDb` 取 240 點）、每個啟用頻段一個點（選中的放大）。
- Pointer Events：pointerdown 找 24 px 內最近的點 → 選中；移動時 `f = clamp(x→freq)`、`g = clamp(y→dB, -12, 12)` 四捨五入到 0.1，呼叫 `onDrag`；`touch-action: none`。
- `devicePixelRatio` 縮放；`ResizeObserver` 重畫。

- [ ] **Step 1: 實作**（無單元測試；Task 5 的 smoke 以 `dispatchEvent(new PointerEvent(...))` 驗證拖曳會改 store）
- [ ] **Step 2: commit** `feat(ui): draggable EQ response curve`

---

### Task 5: EQ 頁（js/ui/pages/eq.js）

**Files:** Rewrite `js/ui/pages/eq.js`, Modify `css/app.css`（曲線與頻段列樣式）, Modify `tools/smoke.mjs`（EQ 檢查）

**Interfaces / 行為:**
- 頂部：群組/聲道選擇（chips：`前 CH1+CH2`、`後 CH3+CH4`；「進階」展開 CH1..CH8 各自與「全部」），群組設定存 `settings.eqGroups`，預設 `{ front: [1, 2], rear: [3, 4] }`。
- 層選擇：`31 段（模式區）` 預設、`10 段（原廠層）`；旁邊顯示 `Q 換算：自動（1 / ×3.17 / 未確認）` 與手動覆寫 select（自動、1、QRate）。
- 旁通指示（Switch21_2）。
- 曲線 canvas；下方選中頻段的三個控制：頻率 select（TAB_FREQ）、增益 range −12..12 step 0.1 與數字、Q select（TAB_Q）。
- 頻段列表（可捲動）：每列 `#`、頻率、增益、Q、狀態（待確認/不符/未啟用）；點列 = 選中。
- 按鈕：`重置本組增益`、`複製到…`（選目標聲道）、`載入預設`（內建四組 + 本地）、`存為本地預設`、`刪除本地預設`、`匯出 JSON`、`匯入 JSON`。
- 寫入：所有變更 → `bandWritePairs` → `device.writeRegs`（50 ms 節流，同位址由 Queue 合併）→ 記錄 touched → 300 ms 無變更後 `device.verify(touched)`；`skipped` 非空顯示 toast「CHn 該頻段機器未啟用，已略過」。
- 未連線或唯讀：控制項停用，但曲線與列表仍顯示 store 內容（允許離線檢視上次讀到的曲線）。
- 載入預設：先 `confirmDialog`（會覆寫本組全部增益），呼叫 `presetWritePairs`，`dropped` 非空時 toast 列出。預設的 `levelDb`、`delayCm`、`sub` 只顯示為說明文字，不寫入。
- `device.on('dump')` 與 store 變更 → 重繪。

- [ ] **Step 1: 實作 eq.js 與 css**
- [ ] **Step 2: smoke 增加**：切到 EQ → 選 `前` → 載入預設 02（自動接受 confirm：smoke 以 `window.confirm`? 改為 smoke 先 `ctx.events` 不可行 → 在 eq.js 匯出 `window.dspx.eq = { loadPreset(name) }` 供測試與 console）→ 等待寫入完成 → 檢查 `store.get(eqAddr(1,5,'G')) === 530` 與 `eqAddr(2,5,'G')`，`mismatch` 數 0；對曲線第一個點派發 pointerdown/pointermove/pointerup → 對應 G 改變；斷線後控制項 disabled。
- [ ] **Step 3: `npm test`、`npm run smoke` 全綠，commit** `feat(ui): EQ page with groups, layers, curve, presets`

---

### Task 6: 打包、版本、README

**Files:** Modify `sw.js`（VERSION 0.2.0，PRECACHE 加 `./js/eq/*.js`、`./js/ui/components/curve.js`、`./presets/*.json`）, `index.html`（data-version 0.2.0）, `tools/pack.mjs`（ITEMS 加 `presets`）, `README.md`（EQ 頁說明、Q 換算說明）

- [ ] **Step 1: 修改、`npm run pack`、PRECACHE 存在性檢查、`npm run smoke`（swReady、precacheComplete ≥ 36）**
- [ ] **Step 2: commit** `chore: v0.2.0 with EQ page and bundled presets`

---

## 自我檢查

- 規格 §7.3 每一項：聲道選擇、連動群組、曲線、頻段列表、重置、複製、旁通、本地預設、寫入策略、TYPE 不寫且未啟用停用 → Task 2、4、5。§8 store 事件流 → Task 5。
- Review Focus 1、2、3 → Task 2 測試；5 → Task 1 nearest 與 Task 4 clamp；4 → Task 5 smoke 斷線檢查。
- 名稱一致：`bandWritePairs` 回 `{ pairs, skipped }`；`mapPresetToBands` 回 `{ mapped, dropped }`；`presetWritePairs` 回 `{ pairs, dropped, skipped }`；eq.js 只用這些名稱。
