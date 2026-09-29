# DSP-X8s 網頁調音器 第一階段 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做出可在手機瀏覽器透過 Web Bluetooth 連上 DSP-X8s、整機讀回全部暫存器、匯出備份、做單一頻段寫入測試，並把所有過程記錄在網頁日誌分頁供複製回報的 PWA。

**Architecture:** 四層純 ES modules：protocol（純函式：CRC、封包、編碼、位址表）→ transport（Web Bluetooth 與 FakeDevice 兩個實作）→ core（Queue、RegisterStore、Device、Logger、Report、Storage）→ ui（五個分頁）。所有機器資料只經 RegisterStore 流向 UI。FakeDevice 讓 protocol 與 core 在 Node 內可完整測試，也讓 UI 在瀏覽器以 `?sim=1` 離線示範。

**Tech Stack:** 純 HTML/CSS/JavaScript（ES2022 modules），Node 22 內建 `node:test`，無任何執行期相依，無建置工具。Service Worker 做離線快取。靜態主機用 GitHub Pages 或 Netlify。

**Spec:** `docs/superpowers/specs/2026-09-29-dsp-x8s-web-tuner-design.md`

## Global Constraints

- 不用框架、不用打包工具、不引用任何外部 CDN；所有資源在專案內，路徑一律相對（`./js/...`），因為 GitHub Pages 會放在子路徑下。
- 所有程式碼依規格重新實作，不得複製反編譯的原廠程式碼；機器內建的頻率表與 Q 值表屬於數據，可由 `tools/gen-tables.mjs` 從反編譯結果轉出。
- UI 文字一律繁體中文。
- 封包格式：`[0x80][LEN][CMD][DATA...][CRC_HI][CRC_LO]`，LEN = 總長 − 2，上限 250，CRC-16/MODBUS（初始 0xFFFF、多項式 0xA001、無最終異或），高位元組在前。
- BLE：Service `0000ae00-0000-1000-8000-00805f9b34fb`，寫入 `0000ae01-...`，通知 `0000ae02-...`。寫入以 20 位元組分段，逐段 `await`。
- 客戶代碇必須為 4006；不符時 Device 進入 `readonly`，所有寫入拒絕。
- 整機讀取範圍 0 到 1612（含），區段讀取每次 100 個位址，回應數量以實際長度計算。
- 只允許寫入 F、G、Q 欄位與規格列出的聲音、模式暫存器；任何 TYPE 欄位（聲道區 base+0、base+4、base+8+4b）一律拒絕寫入。
- 儲存模式與呼叫模式在第一階段的 UI 不開放；Device 提供方法但 UI 不呼叫。
- 逾時 1700 ms，重送 3 次；心跳每 1000 ms 讀 M0_22、M0_16、USB_L_VOL。
- 日誌最多 20000 行，超過丟最舊並標示；每 50 行或 2 秒批次寫入 IndexedDB。
- 每個 Task 完成即 `git commit`；repo 根目錄為 `C:\Users\User\Documents\workspaces\dsp\web`。

## Review Focus

1. 通知分段把 CRC 兩個位元組切在不同 chunk，且 DATA 內含 0x80：重組器必須先等長度足夠再驗 CRC，不能把 DATA 內的 0x80 當成新標頭。測試在 Task 2。
2. 最後一個區段 1600 只回 13 個值：解析必須以實際長度算數量，不能假設 100。測試在 Task 5。
3. 滑桿拖曳時同一位址連續送出 100 次：佇列只能送出在途的那一筆與最後一筆，中間的全部合併。測試在 Task 9。
4. 客戶代碼不符：Device 進入 readonly，`writeRegs` 必須拒絕且不送出任何封包。測試在 Task 10。
5. 區段讀取連續三次無回應：Device 必須改用一般讀取補齊該區段，dumpInfo 記錄 method 為 mixed。測試在 Task 10。

---

## 檔案結構與介面總表

```
web/
  package.json                 type=module；scripts: test / serve / icons / tables
  .gitignore
  README.md
  index.html
  manifest.webmanifest
  sw.js
  icons/icon-192.png  icons/icon-512.png
  css/app.css
  js/protocol/crc16.js         crc16(bytes, length?) → number
  js/protocol/frame.js         buildFrame, parseFrame, FrameAssembler, FRAME_HEAD, MAX_LEN
  js/protocol/codec.js         hi, lo, u16, encode/decode Gain Freq Q Vol MasterVol Delay, clamp
  js/protocol/tables.js        TAB_FREQ, TAB_Q, CUSTOMER_ID, INPUT, INPUT_NAMES（由 tools/gen-tables.mjs 產生）
  js/protocol/addrmap.js       ADDR, FIELD, eqAddr, xoverAddr, channelBase, isTypeAddr, describeAddr, HEARTBEAT_ADDRS, DUMP_END, MODE_END, REG_COUNT
  js/protocol/commands.js      CMD, CMD_NAMES, *Packet builders, readPackets, writePackets, sectPlan, parseResponse, matchesRequest
  js/protocol/summary.js       summarizeFrame(bytes, direction) → string
  js/transport/transport.js    JSDoc Transport 介面、TransportError
  js/transport/fake-device.js  FakeDevice implements Transport
  js/transport/ble.js          BleTransport implements Transport、chunk、detectEnvironment、UUID 常數
  js/core/logger.js            Logger、LEVELS、toHex
  js/core/store.js             RegisterStore、STATUS
  js/core/queue.js             Queue、TimeoutError
  js/core/device.js            Device、STATE
  js/core/report.js            buildReport
  js/core/storage.js           Storage（IndexedDB 或記憶體）、LogPersister
  js/ui/app.js                 開機、分頁切換、SW 註冊、ctx 組裝
  js/ui/statusbar.js           init(ctx, el)
  js/ui/components/dialog.js   confirmDialog(msg) → Promise<boolean>、toast(msg)
  js/ui/components/regtable.js renderRegTable(ctx, el)
  js/ui/pages/bluetooth.js     init(ctx, el)
  js/ui/pages/log.js           init(ctx, el)
  js/ui/pages/sound.js         init(ctx, el)
  js/ui/pages/modes.js         init(ctx, el)
  js/ui/pages/eq.js            init(ctx, el)（第一階段為說明文字）
  tools/serve.mjs              localhost 靜態伺服器
  tools/gen-tables.mjs         產生 tables.js
  tools/make-icons.mjs         產生 PNG 圖示
  test/*.test.js               node:test
```

`ctx`（UI 共用物件）：`{ device, store, logger, storage, env, events }`。`events` 是一個 `EventTarget`，app.js 用它廣播 `sw-cached`（detail: `{version}`）與 `sw-update`。

---

### Task 1: 專案骨架、靜態伺服器、git 初始化

**Files:**
- Create: `package.json`, `.gitignore`, `README.md`, `tools/serve.mjs`

**Interfaces:**
- Produces: `npm test` 執行 `node --test test/`；`npm run serve` 在 http://localhost:8080 提供 web/ 目錄。

- [ ] **Step 1: 建立 package.json 與 .gitignore**

`package.json`：

```json
{
  "name": "dsp-x8s-web-tuner",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "DSP-X8s 車用 DSP 網頁調音器（Web Bluetooth PWA）",
  "scripts": {
    "test": "node --test test/",
    "serve": "node tools/serve.mjs",
    "icons": "node tools/make-icons.mjs",
    "tables": "node tools/gen-tables.mjs"
  },
  "engines": { "node": ">=22" }
}
```

`.gitignore`：

```
node_modules/
.DS_Store
Thumbs.db
*.log
```

- [ ] **Step 2: 寫靜態伺服器 tools/serve.mjs**

```js
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    if (path === '' || path.endsWith('/') || path.endsWith('\\')) path += 'index.html';
    const file = join(ROOT, path);
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    const s = await stat(file);
    if (s.isDirectory()) { res.writeHead(301, { Location: url.pathname + '/' }); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Service-Worker-Allowed': '/',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(err.code === 'ENOENT' ? 'Not found' : String(err));
  }
}).listen(PORT, () => console.log(`serving ${ROOT} at http://localhost:${PORT}/  (sim: http://localhost:${PORT}/?sim=1)`));
```

- [ ] **Step 3: README 骨架**

```markdown
# DSP-X8s 網頁調音器

Yiye lang DSP-X8s 車用 DSP 的 Web Bluetooth 調音網頁（PWA）。規格見 `docs/superpowers/specs/`。

## 開發

- `npm test`：執行單元測試（Node 22）。
- `npm run serve`：在 http://localhost:8080 啟動，`?sim=1` 使用模擬機器。

## 第一階段真機測試

見規格第 13 節。
```

- [ ] **Step 4: 驗證 npm test 與 serve 可執行**

Run: `cd C:/Users/User/Documents/workspaces/dsp/web && mkdir -p test && npm test`
Expected: 輸出 `# tests 0`、`# pass 0`，exit code 0。

Run: `node tools/serve.mjs & sleep 1; curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/README.md; kill %1`
Expected: `200`

- [ ] **Step 5: git init 與第一次 commit**

```bash
cd C:/Users/User/Documents/workspaces/dsp/web
git init -b main
git add .
git commit -m "chore: project scaffold, static dev server, spec"
```

---

### Task 2: CRC-16 與封包（frame.js）

**Files:**
- Create: `js/protocol/crc16.js`, `js/protocol/frame.js`
- Test: `test/crc16.test.js`, `test/frame.test.js`

**Interfaces:**
- Produces: `crc16(bytes: Uint8Array|number[], length = bytes.length): number`
- Produces: `buildFrame(cmd: number, data: Uint8Array|number[] = []): Uint8Array`
- Produces: `parseFrame(bytes: Uint8Array): { cmd: number, data: Uint8Array }`（CRC 或長度錯誤時 throw）
- Produces: `class FrameAssembler { push(chunk: Uint8Array): Uint8Array[]; droppedBytes: number; crcErrors: number; reset(): void }`
- Produces: 常數 `FRAME_HEAD = 0x80`, `MAX_LEN = 250`

- [ ] **Step 1: 寫 CRC 測試**

`test/crc16.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc16 } from '../js/protocol/crc16.js';

test('crc16 matches CRC-16/MODBUS check value for "123456789"', () => {
  assert.equal(crc16(new TextEncoder().encode('123456789')), 0x4B37);
});

test('crc16 of check-id frame body is 0x1225', () => {
  assert.equal(crc16([0x80, 0x05, 0x00, 0x00, 0x00]), 0x1225);
});

test('crc16 honours explicit length', () => {
  assert.equal(crc16([0x80, 0x05, 0x00, 0x00, 0x00, 0xFF, 0xFF], 5), 0x1225);
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `npm test -- test/crc16.test.js`（或 `node --test test/crc16.test.js`）
Expected: FAIL，`Cannot find module` crc16.js。

- [ ] **Step 3: 實作 crc16.js**

```js
/** CRC-16/MODBUS: init 0xFFFF, reflected poly 0xA001, no final xor. */
export function crc16(bytes, length = bytes.length) {
  let crc = 0xFFFF;
  for (let i = 0; i < length; i++) {
    crc ^= bytes[i] & 0xFF;
    for (let b = 0; b < 8; b++) {
      const lsb = crc & 1;
      crc >>>= 1;
      if (lsb) crc ^= 0xA001;
    }
  }
  return crc & 0xFFFF;
}
```

- [ ] **Step 4: 執行確認通過**

Run: `node --test test/crc16.test.js`
Expected: 3 pass。

- [ ] **Step 5: 寫封包測試**

`test/frame.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFrame, parseFrame, FrameAssembler, FRAME_HEAD, MAX_LEN } from '../js/protocol/frame.js';

const hex = (a) => Array.from(a, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

test('buildFrame produces the check-id frame 80 05 00 00 00 12 25', () => {
  assert.equal(hex(buildFrame(0x00, [0, 0])), '80 05 00 00 00 12 25');
});

test('buildFrame produces a write frame for CH1 EQ3 G=560', () => {
  assert.equal(hex(buildFrame(0x03, [0x00, 0x9C, 0x02, 0x30])), '80 07 03 00 9C 02 30 25 1E');
});

test('buildFrame rejects payloads that exceed MAX_LEN', () => {
  assert.throws(() => buildFrame(0x06, new Uint8Array(MAX_LEN)), RangeError);
});

test('parseFrame returns cmd and data view', () => {
  const f = parseFrame(Uint8Array.from([0x80, 0x07, 0x03, 0x00, 0x9C, 0x02, 0x30, 0x25, 0x1E]));
  assert.equal(f.cmd, 0x03);
  assert.deepEqual(Array.from(f.data), [0x00, 0x9C, 0x02, 0x30]);
});

test('parseFrame throws on bad crc and on length mismatch', () => {
  assert.throws(() => parseFrame(Uint8Array.from([0x80, 0x05, 0x00, 0x00, 0x00, 0x12, 0x26])), /crc/);
  assert.throws(() => parseFrame(Uint8Array.from([0x80, 0x06, 0x00, 0x00, 0x00, 0x12, 0x25])), /length/);
});

test('FrameAssembler reassembles a frame split across chunks, CRC split too', () => {
  const full = buildFrame(0x06, [0x04, 0xE0, 0x00, 0x02, 0x04, 0xDA, 0x00, 0x01, 0x06, 0x34, 0x02, 0x1E]);
  const asm = new FrameAssembler();
  assert.deepEqual(asm.push(full.subarray(0, 4)), []);
  assert.deepEqual(asm.push(full.subarray(4, full.length - 1)), []);
  const frames = asm.push(full.subarray(full.length - 1));
  assert.equal(frames.length, 1);
  assert.equal(hex(frames[0]), hex(full));
});

test('FrameAssembler skips garbage before a frame and counts dropped bytes', () => {
  const full = buildFrame(0x00, [0, 0]);
  const asm = new FrameAssembler();
  const frames = asm.push(Uint8Array.from([0x11, 0x22, ...full]));
  assert.equal(frames.length, 1);
  assert.equal(asm.droppedBytes, 2);
});

test('FrameAssembler does not resync on a 0x80 inside data', () => {
  // data contains 0x80 at a position where a fake LEN would look plausible
  const full = buildFrame(0x03, [0x80, 0x05, 0x00, 0x00, 0x00, 0x12, 0x25, 0x00]);
  const asm = new FrameAssembler();
  const frames = asm.push(full);
  assert.equal(frames.length, 1);
  assert.equal(hex(frames[0]), hex(full));
  assert.equal(asm.droppedBytes, 0);
});

test('FrameAssembler recovers after a corrupted frame', () => {
  const bad = buildFrame(0x00, [0, 0]); bad[3] ^= 0xFF; // corrupt data → crc fails
  const good = buildFrame(0x01, [3]);
  const asm = new FrameAssembler();
  const frames = asm.push(Uint8Array.from([...bad, ...good]));
  assert.equal(frames.length, 1);
  assert.equal(frames[0][2], 0x01);
  assert.equal(asm.crcErrors, 1);
});

test('FrameAssembler returns two frames from one chunk', () => {
  const a = buildFrame(0x00, [0, 0]);
  const b = buildFrame(0x01, [3]);
  const asm = new FrameAssembler();
  assert.equal(asm.push(Uint8Array.from([...a, ...b])).length, 2);
});

test('constants', () => {
  assert.equal(FRAME_HEAD, 0x80);
  assert.equal(MAX_LEN, 250);
});
```

- [ ] **Step 6: 執行確認失敗**

Run: `node --test test/frame.test.js`
Expected: FAIL，找不到 frame.js。

- [ ] **Step 7: 實作 frame.js**

```js
import { crc16 } from './crc16.js';

export const FRAME_HEAD = 0x80;
export const MAX_LEN = 250;
const MIN_TOTAL = 5; // head, len, cmd, crc×2

/** Build [0x80][LEN][CMD][DATA][CRC_HI][CRC_LO]. LEN = total − 2. */
export function buildFrame(cmd, data = []) {
  const total = data.length + MIN_TOTAL;
  if (total - 2 > MAX_LEN) throw new RangeError(`frame too long: ${total - 2} > ${MAX_LEN}`);
  const f = new Uint8Array(total);
  f[0] = FRAME_HEAD;
  f[1] = total - 2;
  f[2] = cmd & 0xFF;
  f.set(data, 3);
  const c = crc16(f, total - 2);
  f[total - 2] = c >> 8;
  f[total - 1] = c & 0xFF;
  return f;
}

/** Validate a complete frame and return { cmd, data }. Throws on error. */
export function parseFrame(bytes) {
  if (bytes.length < MIN_TOTAL) throw new Error('frame too short');
  if (bytes[0] !== FRAME_HEAD) throw new Error('bad head');
  if (bytes[1] + 2 !== bytes.length) throw new Error('length mismatch');
  const want = crc16(bytes, bytes.length - 2);
  const got = (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
  if (want !== got) throw new Error(`bad crc: want ${want.toString(16)} got ${got.toString(16)}`);
  return { cmd: bytes[2], data: bytes.subarray(3, bytes.length - 2) };
}

/** Stream reassembler: feed BLE notification chunks, get complete valid frames. */
export class FrameAssembler {
  constructor() { this.buf = new Uint8Array(0); this.droppedBytes = 0; this.crcErrors = 0; }

  push(chunk) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
    const frames = [];
    for (;;) {
      let i = 0;
      while (i < this.buf.length && this.buf[i] !== FRAME_HEAD) i++;
      if (i > 0) this.#drop(i);
      if (this.buf.length < 2) break;
      const len = this.buf[1];
      if (len > MAX_LEN || len < MIN_TOTAL - 2) { this.#drop(1); continue; }
      const total = len + 2;
      if (this.buf.length < total) break; // wait for more bytes before judging
      const cand = this.buf.subarray(0, total);
      const want = crc16(cand, total - 2);
      const got = (cand[total - 2] << 8) | cand[total - 1];
      if (want === got) {
        frames.push(cand.slice());
        this.buf = this.buf.subarray(total);
      } else {
        this.crcErrors++;
        this.#drop(1);
      }
    }
    return frames;
  }

  reset() { this.buf = new Uint8Array(0); }

  #drop(n) { this.droppedBytes += n; this.buf = this.buf.subarray(n); }
}
```

- [ ] **Step 8: 執行確認通過**

Run: `node --test test/frame.test.js test/crc16.test.js`
Expected: 全部 pass。

- [ ] **Step 9: Commit**

```bash
git add js/protocol/crc16.js js/protocol/frame.js test/crc16.test.js test/frame.test.js
git commit -m "feat(protocol): crc16, frame build/parse, stream reassembler"
```

---
### Task 3: 數值編碼（codec.js）

**Files:**
- Create: `js/protocol/codec.js`
- Test: `test/codec.test.js`

**Interfaces:**
- Produces: `hi(v)`, `lo(v)`, `u16(hi, lo)`, `clamp(v, min, max)`
- Produces: `encodeGain(db)→raw`, `decodeGain(raw)→db`, `encodeFreq(hz)`, `decodeFreq(raw)`, `encodeQ(q)`, `decodeQ(raw)`
- Produces: `encodeVol(vol, flag)`, `decodeVol(raw)→{vol, flag}`, `encodeMasterVol(knob 0..60)`, `decodeMasterVol(raw)→knob`
- Produces: `msToDelayRaw(ms)`, `delayRawToMs(raw)`, `delayRawToCm(raw)`, `samplesToDelayRaw(n)`, `delayRawToSamples(raw)`
- Produces: 常數 `MASTER_VOL_OFFSET = 40`, `MASTER_VOL_MAX = 60`, `DELAY_MAX_US = 20000`, `SAMPLE_RATE = 48000`, `GAIN_MIN_DB = -12`, `GAIN_MAX_DB = 12`

- [ ] **Step 1: 寫測試**

`test/codec.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../js/protocol/codec.js';

test('byte helpers', () => {
  assert.equal(c.hi(0x1234), 0x12);
  assert.equal(c.lo(0x1234), 0x34);
  assert.equal(c.u16(0x12, 0x34), 0x1234);
  assert.equal(c.clamp(5, 0, 3), 3);
  assert.equal(c.clamp(-1, 0, 3), 0);
});

test('gain: 0 dB is 500, +6.0 dB is 560, -12 dB is 380', () => {
  assert.equal(c.encodeGain(0), 500);
  assert.equal(c.encodeGain(6), 560);
  assert.equal(c.encodeGain(-12), 380);
  assert.equal(c.decodeGain(560), 6);
  assert.equal(c.decodeGain(387), -11.3);
});

test('frequency: below 100 Hz uses 0.1 Hz units with bit 15 set', () => {
  assert.equal(c.encodeFreq(60), 0x8000 | 600);
  assert.equal(c.encodeFreq(99.9), 0x8000 | 999);
  assert.equal(c.encodeFreq(100), 100);
  assert.equal(c.encodeFreq(20600), 20600);
  assert.equal(c.decodeFreq(0x8258), 60);
  assert.equal(c.decodeFreq(1000), 1000);
  assert.equal(c.decodeFreq(c.encodeFreq(31.5)), 31.5);
});

test('Q: hundredths', () => {
  assert.equal(c.encodeQ(0.4), 40);
  assert.equal(c.encodeQ(4.32), 432);
  assert.equal(c.decodeQ(100), 1);
});

test('volume flag is a +500 offset', () => {
  assert.equal(c.encodeVol(70, true), 570);
  assert.equal(c.encodeVol(70, false), 70);
  assert.deepEqual(c.decodeVol(570), { vol: 70, flag: true });
  assert.deepEqual(c.decodeVol(70), { vol: 70, flag: false });
});

test('master volume knob 0..60 maps to 540..600 with flag set', () => {
  assert.equal(c.encodeMasterVol(0), 540);
  assert.equal(c.encodeMasterVol(30), 570);
  assert.equal(c.encodeMasterVol(60), 600);
  assert.equal(c.decodeMasterVol(570), 30);
  assert.equal(c.decodeMasterVol(520), 0); // below offset clamps to 0
  assert.equal(c.encodeMasterVol(99), 600); // clamps to max
});

test('delay: raw is microseconds, 48 kHz samples, 346 m/s', () => {
  assert.equal(c.msToDelayRaw(20), 20000);
  assert.equal(c.msToDelayRaw(25), 20000);
  assert.equal(c.delayRawToMs(1500), 1.5);
  assert.equal(c.delayRawToCm(20000), 692);
  assert.equal(c.samplesToDelayRaw(48), 1000);
  assert.equal(c.samplesToDelayRaw(960), 20000);
  assert.equal(c.delayRawToSamples(1000), 48);
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `node --test test/codec.test.js`
Expected: FAIL，找不到 codec.js。

- [ ] **Step 3: 實作 codec.js**

```js
export const hi = (v) => (v >> 8) & 0xFF;
export const lo = (v) => v & 0xFF;
export const u16 = (h, l) => (((h & 0xFF) << 8) | (l & 0xFF)) >>> 0;
export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export const GAIN_MIN_DB = -12;
export const GAIN_MAX_DB = 12;
export const MASTER_VOL_OFFSET = 40;
export const MASTER_VOL_MAX = 60;
export const DELAY_MAX_US = 20000;
export const SAMPLE_RATE = 48000;
const SOUND_CM_PER_US = 0.0346; // 346 m/s

export const encodeGain = (db) => Math.round(db * 10) + 500;
export const decodeGain = (raw) => Math.round(raw - 500) / 10;

export const encodeFreq = (hz) => (hz < 100 ? (Math.round(hz * 10) | 0x8000) : Math.round(hz));
export const decodeFreq = (raw) => ((raw & 0x8000) ? (raw & 0x7FFF) / 10 : raw);

export const encodeQ = (q) => Math.round(q * 100);
export const decodeQ = (raw) => raw / 100;

export const encodeVol = (vol, flag) => vol + (flag ? 500 : 0);
export const decodeVol = (raw) => (raw >= 500 ? { vol: raw - 500, flag: true } : { vol: raw, flag: false });

export const encodeMasterVol = (knob) => encodeVol(clamp(Math.round(knob), 0, MASTER_VOL_MAX) + MASTER_VOL_OFFSET, true);
export const decodeMasterVol = (raw) => clamp(decodeVol(raw).vol - MASTER_VOL_OFFSET, 0, MASTER_VOL_MAX);

export const msToDelayRaw = (ms) => clamp(Math.round(ms * 1000), 0, DELAY_MAX_US);
export const delayRawToMs = (raw) => raw / 1000;
export const delayRawToCm = (raw) => Math.round(raw * SOUND_CM_PER_US * 100) / 100;
export const samplesToDelayRaw = (n) => clamp(Math.round((n * 1e6) / SAMPLE_RATE), 0, DELAY_MAX_US);
export const delayRawToSamples = (raw) => Math.round((raw * SAMPLE_RATE) / 1e6);
```

- [ ] **Step 4: 執行確認通過**

Run: `node --test test/codec.test.js`
Expected: 全部 pass。

- [ ] **Step 5: Commit**

```bash
git add js/protocol/codec.js test/codec.test.js
git commit -m "feat(protocol): value codecs for gain, freq, Q, volume, delay"
```

---

### Task 4: 表格產生與位址表（tables.js、addrmap.js）

**Files:**
- Create: `tools/gen-tables.mjs`, `js/protocol/tables.js`（產生物）, `js/protocol/addrmap.js`
- Test: `test/tables.test.js`, `test/addrmap.test.js`

**Interfaces:**
- Produces（tables.js）: `TAB_FREQ: number[]`（364 個，19.7 到 20600）、`TAB_Q: number[]`（101 個，0.4 到 128）、`CUSTOMER_ID = 4006`、`INPUT = { BT: 2, HIGH_LEVEL: 3, AUX: 4, USB: 7 }`、`INPUT_NAMES = { 2: '藍牙', 3: '高電平', 4: 'AUX', 7: 'USB' }`、`DEFAULT_CHANNEL_NAMES = ['前左', '前右', '後左', '後右', '超低 1', '超低 2', '超低 3', '超低 4']`
- Produces（addrmap.js）: `REG_COUNT = 1679`, `DUMP_END = 1612`, `MODE_END = 1226`, `CH_COUNT = 8`, `CH_BASE = 138`, `CH_STRIDE = 136`, `EQ_SLOTS = 32`, `FIELD = { TYPE: 0, F: 1, G: 2, Q: 3 }`
- Produces: `ADDR` 物件：`MACHINE_TYPE`, `mute(n)`, `muteOfChannel(ch)`, `mix11(n)`, `mix41(k, i)`, `switch21(n)`, `delay(n)`, `compressor(n, p)`, `m0(n)`, `M0_INPUT_SET`, `M0_MODE`, `M0_INPUT_CUR`, `EQ_BYPASS_SWITCH`, `iir100(ch, band, field)`, `USB_L_VOL`, `APP_END`
- Produces: `channelBase(ch)`, `xoverAddr(ch, n, field)`, `eqAddr(ch, band, field)`, `isTypeAddr(addr)`, `describeAddr(addr)→string`, `HEARTBEAT_ADDRS`

- [ ] **Step 1: 寫產生器 tools/gen-tables.mjs**

從反編譯結果讀出兩個表，寫成 ES module。反編譯來源路徑寫死為相對於本 repo 的 `../src/data/utils/TabMainUtil.js`。

```js
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const src = fileURLToPath(new URL('../../src/data/utils/TabMainUtil.js', import.meta.url));
const t = require(src);
if (!Array.isArray(t.TAB_FREQ) || !Array.isArray(t.TAB_Q)) throw new Error('unexpected TabMainUtil shape');

const out = `// 由 tools/gen-tables.mjs 產生，勿手改。來源：機器內建頻率表與 Q 值表。
export const TAB_FREQ = ${JSON.stringify(t.TAB_FREQ)};
export const TAB_Q = ${JSON.stringify(t.TAB_Q)};
export const CUSTOMER_ID = 4006;
export const INPUT = { BT: 2, HIGH_LEVEL: 3, AUX: 4, USB: 7 };
export const INPUT_NAMES = { 2: '藍牙', 3: '高電平', 4: 'AUX', 7: 'USB' };
export const DEFAULT_CHANNEL_NAMES = ['前左', '前右', '後左', '後右', '超低 1', '超低 2', '超低 3', '超低 4'];
`;
const dest = fileURLToPath(new URL('../js/protocol/tables.js', import.meta.url));
await writeFile(dest, out, 'utf8');
console.log(`wrote ${dest}: ${t.TAB_FREQ.length} freqs, ${t.TAB_Q.length} Q values`);
```

- [ ] **Step 2: 執行產生器**

Run: `npm run tables`
Expected: `wrote ...tables.js: 364 freqs, 101 Q values`

- [ ] **Step 3: 寫 tables 測試**

`test/tables.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TAB_FREQ, TAB_Q, CUSTOMER_ID, INPUT, INPUT_NAMES, DEFAULT_CHANNEL_NAMES } from '../js/protocol/tables.js';

test('frequency table spans 19.7 Hz to 20.6 kHz, non-decreasing', () => {
  assert.equal(TAB_FREQ.length, 364);
  assert.equal(TAB_FREQ[0], 19.7);
  assert.equal(TAB_FREQ.at(-1), 20600);
  for (let i = 1; i < TAB_FREQ.length; i++) assert.ok(TAB_FREQ[i] >= TAB_FREQ[i - 1]);
});

test('Q table spans 0.4 to 128, strictly increasing', () => {
  assert.equal(TAB_Q.length, 101);
  assert.equal(TAB_Q[0], 0.4);
  assert.equal(TAB_Q.at(-1), 128);
  for (let i = 1; i < TAB_Q.length; i++) assert.ok(TAB_Q[i] > TAB_Q[i - 1]);
});

test('constants', () => {
  assert.equal(CUSTOMER_ID, 4006);
  assert.equal(INPUT.USB, 7);
  assert.equal(INPUT_NAMES[INPUT.BT], '藍牙');
  assert.equal(DEFAULT_CHANNEL_NAMES.length, 8);
});
```

- [ ] **Step 4: 執行 tables 測試**

Run: `node --test test/tables.test.js`
Expected: pass。

- [ ] **Step 5: 寫 addrmap 測試**

`test/addrmap.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as a from '../js/protocol/addrmap.js';

test('layout constants', () => {
  assert.equal(a.REG_COUNT, 1679);
  assert.equal(a.DUMP_END, 1612);
  assert.equal(a.MODE_END, 1226);
  assert.equal(a.CH_BASE + a.CH_COUNT * a.CH_STRIDE, a.MODE_END);
});

test('channel filter addresses', () => {
  assert.equal(a.channelBase(1), 138);
  assert.equal(a.channelBase(8), 1090);
  assert.equal(a.eqAddr(1, 3, 'G'), 156);
  assert.equal(a.eqAddr(8, 32, 'Q'), 1225);
  assert.equal(a.xoverAddr(1, 1, 'TYPE'), 138);
  assert.equal(a.xoverAddr(8, 2, 'Q'), 1097);
  assert.throws(() => a.eqAddr(0, 1, 'G'), RangeError);
  assert.throws(() => a.eqAddr(1, 33, 'G'), RangeError);
  assert.throws(() => a.eqAddr(1, 1, 'X'), RangeError);
});

test('isTypeAddr flags every TYPE field and nothing else in the channel region', () => {
  assert.equal(a.isTypeAddr(138), true);   // CH1 xover1 TYPE
  assert.equal(a.isTypeAddr(142), true);   // CH1 xover2 TYPE
  assert.equal(a.isTypeAddr(146), true);   // CH1 EQ1 TYPE
  assert.equal(a.isTypeAddr(156), false);  // CH1 EQ3 G
  assert.equal(a.isTypeAddr(1222), true);  // CH8 EQ32 TYPE
  assert.equal(a.isTypeAddr(59), false);
  assert.equal(a.isTypeAddr(1252), false); // IIR100 layer is not guarded here
});

test('named registers', () => {
  assert.equal(a.ADDR.mute(2), 2);
  assert.equal(a.ADDR.muteOfChannel(1), 2);
  assert.equal(a.ADDR.mix11(1), 12);
  assert.equal(a.ADDR.mix11(8), 19);
  assert.equal(a.ADDR.mix41(1, 1), 26);
  assert.equal(a.ADDR.mix41(8, 4), 57);
  assert.equal(a.ADDR.switch21(2), 59);
  assert.equal(a.ADDR.EQ_BYPASS_SWITCH, 59);
  assert.equal(a.ADDR.delay(1), 73);
  assert.equal(a.ADDR.delay(9), 81);
  assert.equal(a.ADDR.compressor(3, 0), 82);
  assert.equal(a.ADDR.compressor(10, 6), 137);
  assert.equal(a.ADDR.m0(8), 1234);
  assert.equal(a.ADDR.M0_INPUT_SET, 1234);
  assert.equal(a.ADDR.M0_MODE, 1242);
  assert.equal(a.ADDR.M0_INPUT_CUR, 1248);
  assert.equal(a.ADDR.iir100(1, 1, a.FIELD.G), 1254);
  assert.equal(a.ADDR.iir100(8, 10, a.FIELD.Q), 1571);
  assert.equal(a.ADDR.USB_L_VOL, 1588);
  assert.equal(a.ADDR.APP_END, 1612);
  assert.deepEqual(a.HEARTBEAT_ADDRS, [1248, 1242, 1588]);
});

test('describeAddr names every region', () => {
  assert.equal(a.describeAddr(0), 'MACHINE_TYPE');
  assert.equal(a.describeAddr(2), 'MUTE_2');
  assert.equal(a.describeAddr(12), 'MIX11_1');
  assert.equal(a.describeAddr(30), 'MIX41_2_1');
  assert.equal(a.describeAddr(59), 'SWITCH21_2');
  assert.equal(a.describeAddr(73), 'DELAY_1');
  assert.equal(a.describeAddr(83), 'COMP3_RATIO');
  assert.equal(a.describeAddr(138), 'CH1 XOVER1 TYPE');
  assert.equal(a.describeAddr(156), 'CH1 EQ3 G');
  assert.equal(a.describeAddr(1225), 'CH8 EQ32 Q');
  assert.equal(a.describeAddr(1226), 'MODE_END');
  assert.equal(a.describeAddr(1242), 'M0_16');
  assert.equal(a.describeAddr(1251), 'M0_END');
  assert.equal(a.describeAddr(1254), 'APPEQ CH1 B1 G');
  assert.equal(a.describeAddr(1572), 'STRAIGHT_L_VOL');
  assert.equal(a.describeAddr(1588), 'USB_L_VOL');
  assert.equal(a.describeAddr(1603), 'OPT_COX_CH8_VOL');
  assert.equal(a.describeAddr(1604), 'APP_VAR_1');
  assert.equal(a.describeAddr(1612), 'APP_END');
  assert.equal(a.describeAddr(1614), 'CONTROL1_1');
  assert.equal(a.describeAddr(1678), 'ALL_END');
  assert.equal(a.describeAddr(5000), 'ADDR_5000');
});
```

- [ ] **Step 6: 執行確認失敗**

Run: `node --test test/addrmap.test.js`
Expected: FAIL，找不到 addrmap.js。

- [ ] **Step 7: 實作 addrmap.js**

```js
export const REG_COUNT = 1679;
export const DUMP_END = 1612;   // inclusive; ID_APP_END, equals MP23X length
export const MODE_END = 1226;
export const CH_COUNT = 8;
export const CH_BASE = 138;
export const CH_STRIDE = 136;   // 2 xover filters ×4 + 32 EQ slots ×4
export const EQ_SLOTS = 32;
export const XOVER_SLOTS = 2;
export const FIELD = Object.freeze({ TYPE: 0, F: 1, G: 2, Q: 3 });
export const FIELD_NAMES = ['TYPE', 'F', 'G', 'Q'];
const COMP_PARAMS = ['TYPE', 'RATIO', 'ATTACK', 'DECAY', 'THRESHOLD', 'OUTGAIN', 'KNEE'];
const INPUT_VOL_GROUPS = ['STRAIGHT', 'BT', 'USB', 'OPT_COX'];
const INPUT_VOL_CH = ['L', 'R', 'SL', 'SR', 'CEN', 'SW', 'CH7', 'CH8'];

function check(cond, msg) { if (!cond) throw new RangeError(msg); }

function fieldIndex(field) {
  const f = typeof field === 'number' ? field : FIELD[field];
  check(f !== undefined && f >= 0 && f <= 3, `bad field ${field}`);
  return f;
}

export const ADDR = Object.freeze({
  MACHINE_TYPE: 0,
  mute: (n) => { check(n >= 1 && n <= 11, `mute ${n}`); return n; },
  muteOfChannel: (ch) => { check(ch >= 1 && ch <= CH_COUNT, `ch ${ch}`); return ch + 1; },
  mix11: (n) => { check(n >= 1 && n <= 14, `mix11 ${n}`); return 11 + n; },
  mix41: (k, i) => { check(k >= 1 && k <= 8 && i >= 1 && i <= 4, `mix41 ${k},${i}`); return 26 + (k - 1) * 4 + (i - 1); },
  switch21: (n) => { check(n >= 1 && n <= 15, `switch21 ${n}`); return 57 + n; },
  EQ_BYPASS_SWITCH: 59,
  delay: (n) => { check(n >= 1 && n <= 9, `delay ${n}`); return 72 + n; },
  compressor: (n, p) => { check(n >= 3 && n <= 10 && p >= 0 && p <= 6, `comp ${n},${p}`); return 82 + (n - 3) * 7 + p; },
  m0: (n) => { check(n >= 1 && n <= 24, `m0 ${n}`); return 1226 + n; },
  M0_INPUT_SET: 1234,
  M0_MODE: 1242,
  M0_INPUT_CUR: 1248,
  iir100: (ch, band, field) => {
    check(ch >= 1 && ch <= 8 && band >= 1 && band <= 10, `iir100 ${ch},${band}`);
    return 1252 + (ch - 1) * 40 + (band - 1) * 4 + fieldIndex(field);
  },
  USB_L_VOL: 1588,
  APP_END: 1612,
});

export const HEARTBEAT_ADDRS = [ADDR.M0_INPUT_CUR, ADDR.M0_MODE, ADDR.USB_L_VOL];

export function channelBase(ch) {
  check(Number.isInteger(ch) && ch >= 1 && ch <= CH_COUNT, `channel ${ch}`);
  return CH_BASE + (ch - 1) * CH_STRIDE;
}

export function xoverAddr(ch, n, field) {
  check(n >= 1 && n <= XOVER_SLOTS, `xover ${n}`);
  return channelBase(ch) + (n - 1) * 4 + fieldIndex(field);
}

export function eqAddr(ch, band, field) {
  check(Number.isInteger(band) && band >= 1 && band <= EQ_SLOTS, `band ${band}`);
  return channelBase(ch) + XOVER_SLOTS * 4 + (band - 1) * 4 + fieldIndex(field);
}

/** True for any TYPE field inside the 8-channel filter region. */
export function isTypeAddr(addr) {
  if (addr < CH_BASE || addr >= MODE_END) return false;
  return (addr - CH_BASE) % 4 === 0;
}

export function describeAddr(addr) {
  if (addr === 0) return 'MACHINE_TYPE';
  if (addr <= 11) return `MUTE_${addr}`;
  if (addr <= 25) return `MIX11_${addr - 11}`;
  if (addr <= 57) return `MIX41_${Math.floor((addr - 26) / 4) + 1}_${((addr - 26) % 4) + 1}`;
  if (addr <= 72) return `SWITCH21_${addr - 57}`;
  if (addr <= 81) return `DELAY_${addr - 72}`;
  if (addr <= 137) return `COMP${Math.floor((addr - 82) / 7) + 3}_${COMP_PARAMS[(addr - 82) % 7]}`;
  if (addr < MODE_END) {
    const rel = addr - CH_BASE;
    const ch = Math.floor(rel / CH_STRIDE) + 1;
    const off = rel % CH_STRIDE;
    const field = FIELD_NAMES[off % 4];
    if (off < XOVER_SLOTS * 4) return `CH${ch} XOVER${Math.floor(off / 4) + 1} ${field}`;
    return `CH${ch} EQ${Math.floor((off - XOVER_SLOTS * 4) / 4) + 1} ${field}`;
  }
  if (addr === MODE_END) return 'MODE_END';
  if (addr <= 1250) return `M0_${addr - 1226}`;
  if (addr === 1251) return 'M0_END';
  if (addr <= 1571) {
    const rel = addr - 1252;
    return `APPEQ CH${Math.floor(rel / 40) + 1} B${Math.floor((rel % 40) / 4) + 1} ${FIELD_NAMES[rel % 4]}`;
  }
  if (addr <= 1603) {
    const rel = addr - 1572;
    return `${INPUT_VOL_GROUPS[Math.floor(rel / 8)]}_${INPUT_VOL_CH[rel % 8]}_VOL`;
  }
  if (addr <= 1611) return `APP_VAR_${addr - 1603}`;
  if (addr === 1612) return 'APP_END';
  if (addr === 1613) return 'OTHER_1';
  if (addr <= 1677) return `CONTROL${Math.floor((addr - 1614) / 8) + 1}_${((addr - 1614) % 8) + 1}`;
  if (addr === 1678) return 'ALL_END';
  return `ADDR_${addr}`;
}
```

- [ ] **Step 8: 執行確認通過**

Run: `node --test test/addrmap.test.js test/tables.test.js`
Expected: 全部 pass。

- [ ] **Step 9: Commit**

```bash
git add tools/gen-tables.mjs js/protocol/tables.js js/protocol/addrmap.js test/tables.test.js test/addrmap.test.js
git commit -m "feat(protocol): device tables generator and register address map"
```

---

### Task 5: 指令封包與摘要（commands.js、summary.js）

**Files:**
- Create: `js/protocol/commands.js`, `js/protocol/summary.js`
- Test: `test/commands.test.js`, `test/summary.test.js`

**Interfaces:**
- Produces: `CMD = { CHECK_ID: 0x00, CALL_MODE: 0x01, WRITE: 0x03, READ_MODE_NAME: 0x04, READ: 0x06, WRITE_MODE_NAME: 0x10, SAVE_MODE: 0x11, DOWNLOAD_SECT: 0x31, UPLOAD_SECT: 0x61, BT_READ: 0x71, BT_WRITE: 0x72, UPLOAD_MODE: 0xF0 }`、`CMD_NAMES`
- Produces: `WRITE_PAIRS_PER_PACKET = 3`, `READ_ADDRS_PER_PACKET = 14`, `SECT_SIZE = 100`
- Produces: `checkIdPacket()`, `callModePacket(n)`, `saveModePacket(n)`, `writePacket(pairs)`, `writePackets(pairs)→Uint8Array[]`, `readPacket(addrs)`, `readPackets(addrs)→Uint8Array[]`, `uploadSectPacket(start)`, `sectPlan(end = DUMP_END)→number[]`
- Produces: `parseResponse({cmd, data})` → `{type:'id', id}` | `{type:'regs', cmd, pairs:[{addr,val}]}` | `{type:'sect', start, values:number[]}` | `{type:'mode', cmd, mode}` | `{type:'other', cmd, data}`
- Produces: `matchesRequest(reqFrame: Uint8Array, respFrame: Uint8Array): boolean`
- Produces: `coalesceKey(frame: Uint8Array): string | null`（WRITE 與 READ 回傳 `${cmd}:${firstAddr}:${len}`，其他回傳 null）
- Produces（summary.js）: `summarizeFrame(frame: Uint8Array, direction: 'tx'|'rx'): string`

- [ ] **Step 1: 寫 commands 測試**

`test/commands.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cmd from '../js/protocol/commands.js';
import { buildFrame, parseFrame } from '../js/protocol/frame.js';

const hex = (a) => Array.from(a, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

test('fixed packets match known vectors', () => {
  assert.equal(hex(cmd.checkIdPacket()), '80 05 00 00 00 12 25');
  assert.equal(hex(cmd.callModePacket(3)), '80 04 01 03 B4 29');
  assert.equal(hex(cmd.saveModePacket(3)), '80 04 11 03 74 24');
  assert.equal(hex(cmd.uploadSectPacket(0)), '80 05 61 00 00 CC 74');
  assert.throws(() => cmd.callModePacket(9), RangeError);
});

test('read/write packets', () => {
  assert.equal(hex(cmd.readPacket([1248, 1242, 1588])), '80 09 06 04 E0 04 DA 06 34 B2 6F');
  assert.equal(hex(cmd.writePacket([{ addr: 156, val: 560 }])), '80 07 03 00 9C 02 30 25 1E');
  assert.throws(() => cmd.writePacket([]), RangeError);
  assert.throws(() => cmd.writePacket(new Array(4).fill({ addr: 1, val: 1 })), RangeError);
  assert.throws(() => cmd.readPacket(new Array(15).fill(1)), RangeError);
});

test('writePackets / readPackets chunk by 3 and 14', () => {
  const pairs = Array.from({ length: 7 }, (_, i) => ({ addr: 100 + i, val: i }));
  const wp = cmd.writePackets(pairs);
  assert.equal(wp.length, 3);
  assert.equal(parseFrame(wp[2]).data.length, 4); // last packet has 1 pair
  const rp = cmd.readPackets(Array.from({ length: 30 }, (_, i) => i));
  assert.deepEqual(rp.map((f) => parseFrame(f).data.length / 2), [14, 14, 2]);
});

test('sectPlan covers 0..1612 in 17 requests of 100', () => {
  const plan = cmd.sectPlan();
  assert.equal(plan.length, 17);
  assert.equal(plan[0], 0);
  assert.equal(plan.at(-1), 1600);
});

test('parseResponse: id, regs, sect with 13 values, mode, other', () => {
  assert.deepEqual(cmd.parseResponse(parseFrame(buildFrame(0x00, [0x0F, 0xA6]))), { type: 'id', id: 4006 });
  const regs = cmd.parseResponse(parseFrame(buildFrame(0x06, [0x04, 0xE0, 0x00, 0x02, 0x04, 0xDA, 0x00, 0x01])));
  assert.deepEqual(regs, { type: 'regs', cmd: 0x06, pairs: [{ addr: 1248, val: 2 }, { addr: 1242, val: 1 }] });
  const body = [0x06, 0x40]; for (let i = 1; i <= 13; i++) body.push(0, i);
  const sect = cmd.parseResponse(parseFrame(buildFrame(0x61, body)));
  assert.equal(sect.type, 'sect');
  assert.equal(sect.start, 1600);
  assert.equal(sect.values.length, 13);
  assert.equal(sect.values[12], 13);
  assert.deepEqual(cmd.parseResponse(parseFrame(buildFrame(0x01, [3]))), { type: 'mode', cmd: 0x01, mode: 3 });
  assert.equal(cmd.parseResponse(parseFrame(buildFrame(0x71, [1, 2, 3]))).type, 'other');
});

test('matchesRequest: write needs exact echo, read/sect match first address, mode matches cmd', () => {
  const w = cmd.writePacket([{ addr: 156, val: 560 }]);
  assert.equal(cmd.matchesRequest(w, w.slice()), true);
  const wOther = cmd.writePacket([{ addr: 156, val: 561 }]);
  assert.equal(cmd.matchesRequest(w, wOther), false);
  const r = cmd.readPacket([1248, 1242]);
  const rResp = buildFrame(0x06, [0x04, 0xE0, 0x00, 0x02, 0x04, 0xDA, 0x00, 0x01]);
  assert.equal(cmd.matchesRequest(r, rResp), true);
  assert.equal(cmd.matchesRequest(cmd.readPacket([1242]), rResp), false);
  assert.equal(cmd.matchesRequest(cmd.uploadSectPacket(1600), buildFrame(0x61, [0x06, 0x40, 0, 1])), true);
  assert.equal(cmd.matchesRequest(cmd.callModePacket(2), buildFrame(0x01, [2])), true);
  assert.equal(cmd.matchesRequest(cmd.callModePacket(2), buildFrame(0x11, [2])), false);
});

test('coalesceKey identifies same-address writes and reads, null for others', () => {
  assert.equal(cmd.coalesceKey(cmd.writePacket([{ addr: 156, val: 1 }])), '3:156:7');
  assert.equal(cmd.coalesceKey(cmd.writePacket([{ addr: 156, val: 2 }])), '3:156:7');
  assert.equal(cmd.coalesceKey(cmd.readPacket([1248, 1242, 1588])), '6:1248:9');
  assert.equal(cmd.coalesceKey(cmd.checkIdPacket()), null);
  assert.equal(cmd.coalesceKey(cmd.uploadSectPacket(0)), null);
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `node --test test/commands.test.js`
Expected: FAIL，找不到 commands.js。

- [ ] **Step 3: 實作 commands.js**

```js
import { buildFrame } from './frame.js';
import { hi, lo, u16 } from './codec.js';
import { DUMP_END } from './addrmap.js';

export const CMD = Object.freeze({
  CHECK_ID: 0x00, CALL_MODE: 0x01, WRITE: 0x03, READ_MODE_NAME: 0x04, READ: 0x06,
  WRITE_MODE_NAME: 0x10, SAVE_MODE: 0x11, DOWNLOAD_SECT: 0x31, UPLOAD_SECT: 0x61,
  BT_READ: 0x71, BT_WRITE: 0x72, UPLOAD_MODE: 0xF0,
});
export const CMD_NAMES = Object.freeze(Object.fromEntries(Object.entries(CMD).map(([k, v]) => [v, k])));
export const WRITE_PAIRS_PER_PACKET = 3;
export const READ_ADDRS_PER_PACKET = 14;
export const SECT_SIZE = 100;

function assertMode(n) { if (!Number.isInteger(n) || n < 1 || n > 8) throw new RangeError(`mode ${n}`); }
function chunk(arr, size) { const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; }

export const checkIdPacket = () => buildFrame(CMD.CHECK_ID, [0, 0]);
export const callModePacket = (n) => { assertMode(n); return buildFrame(CMD.CALL_MODE, [n]); };
export const saveModePacket = (n) => { assertMode(n); return buildFrame(CMD.SAVE_MODE, [n]); };
export const uploadSectPacket = (start) => buildFrame(CMD.UPLOAD_SECT, [hi(start), lo(start)]);

export function writePacket(pairs) {
  if (pairs.length < 1 || pairs.length > WRITE_PAIRS_PER_PACKET) throw new RangeError(`write pairs ${pairs.length}`);
  const d = [];
  for (const { addr, val } of pairs) d.push(hi(addr), lo(addr), hi(val), lo(val));
  return buildFrame(CMD.WRITE, d);
}
export const writePackets = (pairs) => chunk(pairs, WRITE_PAIRS_PER_PACKET).map(writePacket);

export function readPacket(addrs) {
  if (addrs.length < 1 || addrs.length > READ_ADDRS_PER_PACKET) throw new RangeError(`read addrs ${addrs.length}`);
  return buildFrame(CMD.READ, addrs.flatMap((a) => [hi(a), lo(a)]));
}
export const readPackets = (addrs) => chunk(addrs, READ_ADDRS_PER_PACKET).map(readPacket);

export function sectPlan(end = DUMP_END) {
  const starts = [];
  for (let s = 0; s <= end; s += SECT_SIZE) starts.push(s);
  return starts;
}

export function parseResponse({ cmd, data }) {
  switch (cmd) {
    case CMD.CHECK_ID:
      return { type: 'id', id: u16(data[0], data[1]) };
    case CMD.WRITE:
    case CMD.READ: {
      const pairs = [];
      for (let i = 0; i + 3 < data.length; i += 4) pairs.push({ addr: u16(data[i], data[i + 1]), val: u16(data[i + 2], data[i + 3]) });
      return { type: 'regs', cmd, pairs };
    }
    case CMD.UPLOAD_SECT: {
      const start = u16(data[0], data[1]);
      const values = [];
      for (let i = 2; i + 1 < data.length; i += 2) values.push(u16(data[i], data[i + 1]));
      return { type: 'sect', start, values };
    }
    case CMD.CALL_MODE:
    case CMD.SAVE_MODE:
      return { type: 'mode', cmd, mode: data[0] };
    default:
      return { type: 'other', cmd, data };
  }
}

export function matchesRequest(req, resp) {
  if (req[2] !== resp[2]) return false;
  switch (req[2]) {
    case CMD.WRITE:
      if (req.length !== resp.length) return false;
      for (let i = 0; i < req.length; i++) if (req[i] !== resp[i]) return false;
      return true;
    case CMD.READ:
    case CMD.UPLOAD_SECT:
    case CMD.BT_WRITE:
      return req[3] === resp[3] && req[4] === resp[4];
    default:
      return true;
  }
}

export function coalesceKey(frame) {
  const c = frame[2];
  if (c !== CMD.WRITE && c !== CMD.READ) return null;
  return `${c}:${u16(frame[3], frame[4])}:${frame.length}`;
}
```

- [ ] **Step 4: 執行 commands 測試**

Run: `node --test test/commands.test.js`
Expected: 全部 pass。

- [ ] **Step 5: 寫 summary 測試**

`test/summary.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeFrame } from '../js/protocol/summary.js';
import * as cmd from '../js/protocol/commands.js';
import { buildFrame } from '../js/protocol/frame.js';

test('summaries for requests', () => {
  assert.equal(summarizeFrame(cmd.checkIdPacket(), 'tx'), 'CHECK_ID');
  assert.equal(summarizeFrame(cmd.readPacket([1248, 1242, 1588]), 'tx'), 'READ M0_22, M0_16, USB_L_VOL');
  assert.equal(summarizeFrame(cmd.writePacket([{ addr: 156, val: 560 }]), 'tx'), 'WRITE CH1 EQ3 G=560 (+6.0 dB)');
  assert.equal(summarizeFrame(cmd.uploadSectPacket(1600), 'tx'), 'UPLOAD_SECT start=1600');
  assert.equal(summarizeFrame(cmd.callModePacket(3), 'tx'), 'CALL_MODE 3');
});

test('summaries for responses decode values by field', () => {
  assert.equal(summarizeFrame(buildFrame(0x00, [0x0F, 0xA6]), 'rx'), 'CHECK_ID id=4006');
  assert.equal(summarizeFrame(buildFrame(0x06, [0x04, 0xE0, 0x00, 0x02, 0x04, 0xDA, 0x00, 0x01]), 'rx'), 'READ M0_22=2, M0_16=1');
  assert.equal(summarizeFrame(buildFrame(0x03, [0x00, 0x9D, 0x82, 0x58]), 'rx'), 'WRITE CH1 EQ3 F=33368 (60 Hz)');
  assert.equal(summarizeFrame(buildFrame(0x03, [0x00, 0x9F, 0x01, 0xB0]), 'rx'), 'WRITE CH1 EQ3 Q=432 (Q 4.32)');
  assert.equal(summarizeFrame(buildFrame(0x03, [0x00, 0x0C, 0x02, 0x3A]), 'rx'), 'WRITE MIX11_1=570 (vol 70, flag)');
  assert.equal(summarizeFrame(buildFrame(0x03, [0x00, 0x49, 0x03, 0xE8]), 'rx'), 'WRITE DELAY_1=1000 (1.000 ms)');
  assert.equal(summarizeFrame(buildFrame(0x03, [0x00, 0x02, 0x00, 0x01]), 'rx'), 'WRITE MUTE_2=1 (靜音)');
  const body = [0x06, 0x40]; for (let i = 1; i <= 13; i++) body.push(0, i);
  assert.equal(summarizeFrame(buildFrame(0x61, body), 'rx'), 'UPLOAD_SECT start=1600 n=13');
  assert.equal(summarizeFrame(buildFrame(0x71, [1, 2, 3]), 'rx'), 'BT_READ 3 bytes (忽略)');
  assert.equal(summarizeFrame(buildFrame(0x11, [2]), 'rx'), 'SAVE_MODE 2');
});

test('summary never throws on a truncated or unknown frame', () => {
  assert.equal(typeof summarizeFrame(Uint8Array.from([0x80, 0x03, 0x99]), 'rx'), 'string');
  assert.equal(typeof summarizeFrame(new Uint8Array(0), 'tx'), 'string');
});
```

- [ ] **Step 6: 執行確認失敗**

Run: `node --test test/summary.test.js`
Expected: FAIL，找不到 summary.js。

- [ ] **Step 7: 實作 summary.js**

```js
import { CMD, CMD_NAMES } from './commands.js';
import { u16, decodeGain, decodeFreq, decodeQ, decodeVol, delayRawToMs } from './codec.js';
import { describeAddr } from './addrmap.js';

function fmtValue(name, val) {
  if (/ G$/.test(name)) { const db = decodeGain(val); return `${val} (${db >= 0 ? '+' : ''}${db.toFixed(1)} dB)`; }
  if (/ F$/.test(name)) return `${val} (${decodeFreq(val)} Hz)`;
  if (/ Q$/.test(name)) return `${val} (Q ${decodeQ(val)})`;
  if (/^MIX/.test(name) || /_VOL$/.test(name)) { const { vol, flag } = decodeVol(val); return `${val} (vol ${vol}${flag ? ', flag' : ''})`; }
  if (/^DELAY_/.test(name)) return `${val} (${delayRawToMs(val).toFixed(3)} ms)`;
  if (/^MUTE_/.test(name)) return `${val} (${val ? '靜音' : '開'})`;
  return String(val);
}

function pairsText(data, withValues) {
  const parts = [];
  if (withValues) {
    for (let i = 0; i + 3 < data.length; i += 4) {
      const name = describeAddr(u16(data[i], data[i + 1]));
      parts.push(`${name}=${fmtValue(name, u16(data[i + 2], data[i + 3]))}`);
    }
  } else {
    for (let i = 0; i + 1 < data.length; i += 2) parts.push(describeAddr(u16(data[i], data[i + 1])));
  }
  return parts.join(', ');
}

/** One-line human summary of a frame. Never throws. */
export function summarizeFrame(frame, direction) {
  try {
    if (!frame || frame.length < 3) return `(${frame ? frame.length : 0} bytes)`;
    const cmd = frame[2];
    const name = CMD_NAMES[cmd] ?? `CMD_0x${cmd.toString(16).padStart(2, '0')}`;
    const data = frame.subarray(3, Math.max(3, frame.length - 2));
    switch (cmd) {
      case CMD.CHECK_ID:
        return direction === 'rx' && data.length >= 2 ? `${name} id=${u16(data[0], data[1])}` : name;
      case CMD.READ:
        return `${name} ${pairsText(data, direction === 'rx')}`;
      case CMD.WRITE:
        return `${name} ${pairsText(data, true)}`;
      case CMD.UPLOAD_SECT: {
        const start = data.length >= 2 ? u16(data[0], data[1]) : '?';
        return direction === 'rx' ? `${name} start=${start} n=${Math.max(0, Math.floor((data.length - 2) / 2))}` : `${name} start=${start}`;
      }
      case CMD.CALL_MODE:
      case CMD.SAVE_MODE:
        return `${name} ${data[0]}`;
      case CMD.BT_READ:
      case CMD.BT_WRITE:
        return `${name} ${data.length} bytes (忽略)`;
      default:
        return `${name} ${data.length} bytes`;
    }
  } catch (err) {
    return `(summary error: ${err.message})`;
  }
}
```

- [ ] **Step 8: 執行確認通過**

Run: `node --test test/`
Expected: 全部 pass。

- [ ] **Step 9: Commit**

```bash
git add js/protocol/commands.js js/protocol/summary.js test/commands.test.js test/summary.test.js
git commit -m "feat(protocol): command packets, response parsing, ack matching, frame summaries"
```

---
### Task 6: 日誌（logger.js）

**Files:**
- Create: `js/core/logger.js`
- Test: `test/logger.test.js`

**Interfaces:**
- Produces: `LEVELS = ['INFO', 'WARN', 'ERR', 'TX', 'RX', 'REPORT']`, `toHex(bytes)→'80 05 ...'`
- Produces: `class Logger { constructor({ max = 20000, now = () => Date.now() }); entries: Entry[]; truncated: boolean; info(text); warn(text); error(text); tx(frame); rx(frame); report(text); subscribe(fn)→unsubscribe; clear(); toText(filter = 'all'|'important'|'packets'); lastReport()→string|null; restore(entries) }`
- Entry: `{ i: number（流水號）, t: number（相對開始毫秒）, level: string, text: string, hex?: string }`
- Logger 內部用 `summarizeFrame` 產生 TX/RX 的 text。

- [ ] **Step 1: 寫測試**

`test/logger.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Logger, LEVELS, toHex } from '../js/core/logger.js';
import { checkIdPacket } from '../js/protocol/commands.js';

function makeLogger(opts) {
  let t = 1000;
  return new Logger({ now: () => (t += 10), ...opts });
}

test('levels and hex helper', () => {
  assert.deepEqual(LEVELS, ['INFO', 'WARN', 'ERR', 'TX', 'RX', 'REPORT']);
  assert.equal(toHex(Uint8Array.from([0x80, 0x05, 0x00])), '80 05 00');
});

test('entries get sequence numbers and relative time', () => {
  const log = makeLogger();
  log.info('a');
  log.warn('b');
  assert.equal(log.entries.length, 2);
  assert.equal(log.entries[0].i, 1);
  assert.equal(log.entries[0].t, 0);
  assert.equal(log.entries[1].t, 10);
  assert.equal(log.entries[1].level, 'WARN');
});

test('tx/rx store hex and a summary', () => {
  const log = makeLogger();
  log.tx(checkIdPacket());
  assert.equal(log.entries[0].level, 'TX');
  assert.equal(log.entries[0].hex, '80 05 00 00 00 12 25');
  assert.equal(log.entries[0].text, 'CHECK_ID');
});

test('subscribe receives each new entry; unsubscribe stops it', () => {
  const log = makeLogger();
  const seen = [];
  const off = log.subscribe((e) => seen.push(e.text));
  log.info('x');
  off();
  log.info('y');
  assert.deepEqual(seen, ['x']);
});

test('cap drops the oldest 10% and marks truncated', () => {
  const log = makeLogger({ max: 100 });
  for (let i = 0; i < 101; i++) log.info(`m${i}`);
  assert.ok(log.entries.length <= 100);
  assert.equal(log.truncated, true);
  assert.equal(log.entries[0].text, 'm10');
});

test('toText filters', () => {
  const log = makeLogger();
  log.info('i'); log.tx(checkIdPacket()); log.warn('w'); log.report('R');
  const all = log.toText('all').split('\n');
  assert.equal(all.length, 4);
  assert.match(all[1], /^\s*\d+\s+TX\s+CHECK_ID\s+\| 80 05/);
  assert.deepEqual(log.toText('important').split('\n').map((l) => l.split(/\s+/)[1]), ['INFO', 'WARN', 'REPORT']);
  assert.deepEqual(log.toText('packets').split('\n').map((l) => l.split(/\s+/)[1]), ['TX']);
  assert.equal(log.lastReport(), 'R');
});

test('clear and restore', () => {
  const log = makeLogger();
  log.info('a');
  const saved = log.entries.slice();
  log.clear();
  assert.equal(log.entries.length, 0);
  assert.equal(log.lastReport(), null);
  log.restore(saved);
  assert.equal(log.entries.length, 1);
  log.info('b');
  assert.equal(log.entries[1].i, 2);
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `node --test test/logger.test.js`
Expected: FAIL。

- [ ] **Step 3: 實作 logger.js**

```js
import { summarizeFrame } from '../protocol/summary.js';

export const LEVELS = ['INFO', 'WARN', 'ERR', 'TX', 'RX', 'REPORT'];
const IMPORTANT = new Set(['INFO', 'WARN', 'ERR', 'REPORT']);
const PACKETS = new Set(['TX', 'RX']);

export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

export class Logger {
  constructor({ max = 20000, now = () => Date.now() } = {}) {
    this.max = max;
    this.now = now;
    this.entries = [];
    this.truncated = false;
    this.listeners = new Set();
    this.seq = 0;
    this.t0 = null;
  }

  #add(level, text, hex) {
    if (this.t0 === null) this.t0 = this.now();
    const entry = { i: ++this.seq, t: Math.round(this.now() - this.t0), level, text };
    if (hex) entry.hex = hex;
    this.entries.push(entry);
    if (this.entries.length > this.max) {
      this.entries.splice(0, Math.ceil(this.max / 10));
      this.truncated = true;
    }
    for (const fn of this.listeners) { try { fn(entry); } catch { /* listener errors never break logging */ } }
    return entry;
  }

  info(text) { return this.#add('INFO', String(text)); }
  warn(text) { return this.#add('WARN', String(text)); }
  error(text) { return this.#add('ERR', String(text)); }
  report(text) { return this.#add('REPORT', String(text)); }
  tx(frame) { return this.#add('TX', summarizeFrame(frame, 'tx'), toHex(frame)); }
  rx(frame) { return this.#add('RX', summarizeFrame(frame, 'rx'), toHex(frame)); }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  clear() { this.entries = []; this.truncated = false; }

  restore(entries) {
    this.entries = entries.map((e) => ({ ...e }));
    this.seq = this.entries.reduce((m, e) => Math.max(m, e.i), 0);
  }

  lastReport() {
    for (let i = this.entries.length - 1; i >= 0; i--) if (this.entries[i].level === 'REPORT') return this.entries[i].text;
    return null;
  }

  static formatEntry(e) {
    const base = `${String(e.t).padStart(7)} ${e.level.padEnd(6)} ${e.text}`;
    return e.hex ? `${base} | ${e.hex}` : base;
  }

  toText(filter = 'all') {
    const keep = filter === 'important' ? (e) => IMPORTANT.has(e.level)
      : filter === 'packets' ? (e) => PACKETS.has(e.level)
        : () => true;
    const lines = this.entries.filter(keep).map(Logger.formatEntry);
    if (this.truncated) lines.unshift('（較舊的日誌已因超過上限被丟棄）');
    return lines.join('\n');
  }
}
```

- [ ] **Step 4: 執行確認通過**

Run: `node --test test/logger.test.js`
Expected: 全部 pass。

- [ ] **Step 5: Commit**

```bash
git add js/core/logger.js test/logger.test.js
git commit -m "feat(core): logger with levels, packet summaries, cap and text export"
```

---

### Task 7: 暫存器快取（store.js）

**Files:**
- Create: `js/core/store.js`
- Test: `test/store.test.js`

**Interfaces:**
- Produces: `STATUS = { UNKNOWN: 0, CONFIRMED: 1, PENDING: 2, MISMATCH: 3 }`
- Produces: `class RegisterStore { constructor(size = DUMP_END + 1); size; values: Uint16Array; status: Uint8Array; deviceValues: Map<number, number>; get(addr); getStatus(addr); set(addr, val, status = CONFIRMED); setMany(pairs, status = CONFIRMED); markPending(addrs); markMismatch(addr, deviceVal); acceptDevice(addr); subscribe(fn)→unsub（fn(changedAddrs: number[])）; snapshot()→{ ts, values: number[], status: number[] }; loadSnapshot(snap); reset(); confirmedCount() }`

- [ ] **Step 1: 寫測試**

`test/store.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RegisterStore, STATUS } from '../js/core/store.js';

test('defaults to unknown zeros sized to the dump range', () => {
  const s = new RegisterStore();
  assert.equal(s.size, 1613);
  assert.equal(s.get(156), 0);
  assert.equal(s.getStatus(156), STATUS.UNKNOWN);
  assert.equal(s.confirmedCount(), 0);
});

test('set/setMany notify subscribers with changed addresses', () => {
  const s = new RegisterStore();
  const seen = [];
  s.subscribe((addrs) => seen.push(addrs));
  s.set(156, 560);
  s.setMany([{ addr: 1, val: 1 }, { addr: 2, val: 0 }]);
  assert.deepEqual(seen, [[156], [1, 2]]);
  assert.equal(s.get(156), 560);
  assert.equal(s.getStatus(156), STATUS.CONFIRMED);
  assert.equal(s.confirmedCount(), 3);
});

test('pending, mismatch and acceptDevice', () => {
  const s = new RegisterStore();
  s.set(156, 560, STATUS.PENDING);
  assert.equal(s.getStatus(156), STATUS.PENDING);
  s.markMismatch(156, 500);
  assert.equal(s.getStatus(156), STATUS.MISMATCH);
  assert.equal(s.deviceValues.get(156), 500);
  assert.equal(s.get(156), 560);
  s.acceptDevice(156);
  assert.equal(s.get(156), 500);
  assert.equal(s.getStatus(156), STATUS.CONFIRMED);
  assert.equal(s.deviceValues.has(156), false);
});

test('out-of-range addresses are ignored, not thrown', () => {
  const s = new RegisterStore();
  s.set(5000, 1);
  assert.equal(s.get(5000), 0);
});

test('snapshot round-trip', () => {
  const s = new RegisterStore();
  s.set(12, 570);
  const snap = s.snapshot();
  assert.ok(snap.ts > 0);
  assert.equal(snap.values[12], 570);
  const s2 = new RegisterStore();
  s2.loadSnapshot(snap);
  assert.equal(s2.get(12), 570);
  assert.equal(s2.getStatus(12), STATUS.CONFIRMED);
  s2.reset();
  assert.equal(s2.get(12), 0);
  assert.equal(s2.getStatus(12), STATUS.UNKNOWN);
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `node --test test/store.test.js`
Expected: FAIL。

- [ ] **Step 3: 實作 store.js**

```js
import { DUMP_END } from '../protocol/addrmap.js';

export const STATUS = Object.freeze({ UNKNOWN: 0, CONFIRMED: 1, PENDING: 2, MISMATCH: 3 });

export class RegisterStore {
  constructor(size = DUMP_END + 1) {
    this.size = size;
    this.values = new Uint16Array(size);
    this.status = new Uint8Array(size);
    this.deviceValues = new Map();
    this.listeners = new Set();
  }

  #inRange(addr) { return Number.isInteger(addr) && addr >= 0 && addr < this.size; }

  #notify(addrs) {
    if (addrs.length === 0) return;
    for (const fn of this.listeners) { try { fn(addrs); } catch { /* ignore */ } }
  }

  get(addr) { return this.#inRange(addr) ? this.values[addr] : 0; }
  getStatus(addr) { return this.#inRange(addr) ? this.status[addr] : STATUS.UNKNOWN; }

  set(addr, val, status = STATUS.CONFIRMED) {
    if (!this.#inRange(addr)) return;
    this.values[addr] = val & 0xFFFF;
    this.status[addr] = status;
    if (status !== STATUS.MISMATCH) this.deviceValues.delete(addr);
    this.#notify([addr]);
  }

  setMany(pairs, status = STATUS.CONFIRMED) {
    const changed = [];
    for (const { addr, val } of pairs) {
      if (!this.#inRange(addr)) continue;
      this.values[addr] = val & 0xFFFF;
      this.status[addr] = status;
      if (status !== STATUS.MISMATCH) this.deviceValues.delete(addr);
      changed.push(addr);
    }
    this.#notify(changed);
  }

  markPending(addrs) {
    const changed = [];
    for (const a of addrs) if (this.#inRange(a)) { this.status[a] = STATUS.PENDING; changed.push(a); }
    this.#notify(changed);
  }

  markMismatch(addr, deviceVal) {
    if (!this.#inRange(addr)) return;
    this.status[addr] = STATUS.MISMATCH;
    this.deviceValues.set(addr, deviceVal & 0xFFFF);
    this.#notify([addr]);
  }

  acceptDevice(addr) {
    if (!this.deviceValues.has(addr)) return;
    this.set(addr, this.deviceValues.get(addr), STATUS.CONFIRMED);
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  confirmedCount() { let n = 0; for (const s of this.status) if (s === STATUS.CONFIRMED) n++; return n; }

  snapshot() { return { ts: Date.now(), values: Array.from(this.values), status: Array.from(this.status) }; }

  loadSnapshot(snap) {
    const n = Math.min(this.size, snap.values.length);
    for (let i = 0; i < n; i++) { this.values[i] = snap.values[i]; this.status[i] = STATUS.CONFIRMED; }
    this.deviceValues.clear();
    this.#notify(Array.from({ length: n }, (_, i) => i));
  }

  reset() {
    this.values.fill(0);
    this.status.fill(STATUS.UNKNOWN);
    this.deviceValues.clear();
    this.#notify(Array.from({ length: this.size }, (_, i) => i));
  }
}
```

- [ ] **Step 4: 執行確認通過**

Run: `node --test test/store.test.js`
Expected: 全部 pass。

- [ ] **Step 5: Commit**

```bash
git add js/core/store.js test/store.test.js
git commit -m "feat(core): register store with status tracking and snapshots"
```

---

### Task 8: Transport 介面與模擬機器（transport.js、fake-device.js）

**Files:**
- Create: `js/transport/transport.js`, `js/transport/fake-device.js`
- Test: `test/fake-device.test.js`

**Interfaces:**
- Produces（transport.js）: `class TransportError extends Error { constructor(message, code) }`。JSDoc `@typedef Transport`：`connect(): Promise<{ name: string }>`、`disconnect(): Promise<void>`、`write(bytes: Uint8Array): Promise<void>`、`onData(cb: (chunk: Uint8Array) => void): void`、`onDisconnect(cb: () => void): void`、`readonly connected: boolean`、`readonly name: string`
- Produces（fake-device.js）: `class FakeDevice`（實作 Transport），`constructor({ latencyMs = 2, chunkSize = 20, customerId = 4006, failSect = false, dropNext = 0, name = 'DSP-X8s-SIM' })`；額外測試用：`regs: Uint16Array(REG_COUNT)`、`slots: Uint16Array[8]`、`currentMode`、`setRegister(addr, val)`、`pokeMode(n)`（模擬實體按鍵切模式）、`sent: Uint8Array[]`（收到的每個完整封包）、`seedDefaults()`
- FakeDevice 行為：CHECK_ID 回代碼；READ 回位址值對；WRITE 套用後原封回傳；UPLOAD_SECT 回 start 起最多 100 個值（不超過 REG_COUNT）；CALL_MODE n 把 slots[n-1] 複製到 regs[0..1225]、M0_MODE = n、回傳；SAVE_MODE n 把 regs[0..1225] 複製到 slots[n-1]、回傳；BT_READ/BT_WRITE 與未知指令不回應。`failSect` 為 true 時 UPLOAD_SECT 不回應。`dropNext > 0` 時每收到一個封包扣 1 且不回應。回應以 `chunkSize` 分段、每段間隔 `latencyMs` 送出。

- [ ] **Step 1: 寫測試**

`test/fake-device.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDevice } from '../js/transport/fake-device.js';
import { FrameAssembler } from '../js/protocol/frame.js';
import * as cmd from '../js/protocol/commands.js';
import { eqAddr, ADDR, MODE_END } from '../js/protocol/addrmap.js';

async function roundTrip(dev, frame, { expect = 1, timeout = 200 } = {}) {
  const asm = new FrameAssembler();
  const frames = [];
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => (expect === 0 ? resolve(frames) : reject(new Error('no response'))), timeout);
    dev.onData((chunk) => {
      for (const f of asm.push(chunk)) frames.push(f);
      if (frames.length >= expect && expect > 0) { clearTimeout(timer); resolve(frames); }
    });
  });
  await dev.write(frame);
  return done;
}

test('connect/disconnect and name', async () => {
  const dev = new FakeDevice();
  assert.equal(dev.connected, false);
  const info = await dev.connect();
  assert.equal(info.name, 'DSP-X8s-SIM');
  assert.equal(dev.connected, true);
  let disconnected = false;
  dev.onDisconnect(() => { disconnected = true; });
  await dev.disconnect();
  assert.equal(dev.connected, false);
  assert.equal(disconnected, true);
});

test('answers CHECK_ID with the configured customer id', async () => {
  const dev = new FakeDevice({ customerId: 4006 });
  await dev.connect();
  const [resp] = await roundTrip(dev, cmd.checkIdPacket());
  assert.deepEqual(cmd.parseResponse({ cmd: resp[2], data: resp.subarray(3, resp.length - 2) }), { type: 'id', id: 4006 });
});

test('READ returns current values; WRITE applies and echoes exactly', async () => {
  const dev = new FakeDevice();
  await dev.connect();
  const addr = eqAddr(1, 3, 'G');
  const w = cmd.writePacket([{ addr, val: 560 }]);
  const [echo] = await roundTrip(dev, w);
  assert.deepEqual(Array.from(echo), Array.from(w));
  assert.equal(dev.regs[addr], 560);
  const [r] = await roundTrip(dev, cmd.readPacket([addr]));
  const parsed = cmd.parseResponse({ cmd: r[2], data: r.subarray(3, r.length - 2) });
  assert.deepEqual(parsed.pairs, [{ addr, val: 560 }]);
});

test('UPLOAD_SECT returns 100 values, and 13 for the last segment; responses arrive in 20-byte chunks', async () => {
  const dev = new FakeDevice({ chunkSize: 20 });
  await dev.connect();
  let chunks = 0;
  dev.onData(() => chunks++);
  const [full] = await roundTrip(dev, cmd.uploadSectPacket(0));
  const parsed = cmd.parseResponse({ cmd: full[2], data: full.subarray(3, full.length - 2) });
  assert.equal(parsed.values.length, 100);
  assert.ok(chunks >= 10, `expected chunked notifications, got ${chunks}`);
  const [last] = await roundTrip(dev, cmd.uploadSectPacket(1600));
  assert.equal(cmd.parseResponse({ cmd: last[2], data: last.subarray(3, last.length - 2) }).values.length, 79);
});

test('CALL_MODE loads a slot, SAVE_MODE stores one', async () => {
  const dev = new FakeDevice();
  await dev.connect();
  const addr = eqAddr(2, 1, 'G');
  dev.setRegister(addr, 530);
  await roundTrip(dev, cmd.saveModePacket(2));
  assert.equal(dev.slots[1][addr], 530);
  dev.setRegister(addr, 500);
  await roundTrip(dev, cmd.callModePacket(2));
  assert.equal(dev.regs[addr], 530);
  assert.equal(dev.regs[ADDR.M0_MODE], 2);
  assert.equal(dev.currentMode, 2);
});

test('pokeMode changes M0_MODE without a request', async () => {
  const dev = new FakeDevice();
  await dev.connect();
  dev.pokeMode(5);
  assert.equal(dev.regs[ADDR.M0_MODE], 5);
});

test('failSect suppresses sect responses; dropNext swallows the next N frames', async () => {
  const dev = new FakeDevice({ failSect: true, dropNext: 1 });
  await dev.connect();
  assert.equal((await roundTrip(dev, cmd.uploadSectPacket(0), { expect: 0, timeout: 50 })).length, 0);
  assert.equal((await roundTrip(dev, cmd.checkIdPacket(), { expect: 0, timeout: 50 })).length, 0); // dropped
  assert.equal((await roundTrip(dev, cmd.checkIdPacket())).length, 1);
});

test('seedDefaults gives plausible EQ values and records sent frames', async () => {
  const dev = new FakeDevice();
  assert.equal(dev.regs[eqAddr(1, 1, 'G')], 500);
  assert.equal(dev.regs[eqAddr(1, 32, 'F')], 0);
  assert.equal(dev.regs[ADDR.M0_MODE], 1);
  assert.equal(dev.regs[ADDR.EQ_BYPASS_SWITCH], 1);
  assert.equal(dev.regs[ADDR.mix11(1)], 570);
  assert.ok(dev.regs[MODE_END] === 0);
  await dev.connect();
  await dev.write(cmd.checkIdPacket());
  assert.equal(dev.sent.length, 1);
});

test('write before connect rejects', async () => {
  const dev = new FakeDevice();
  await assert.rejects(dev.write(cmd.checkIdPacket()), /not connected/);
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `node --test test/fake-device.test.js`
Expected: FAIL。

- [ ] **Step 3: 實作 transport.js**

```js
/**
 * @typedef {object} Transport
 * @property {() => Promise<{ name: string }>} connect
 * @property {() => Promise<void>} disconnect
 * @property {(bytes: Uint8Array) => Promise<void>} write   send one complete frame (transport chunks it)
 * @property {(cb: (chunk: Uint8Array) => void) => void} onData   raw notification chunks, may be fragments
 * @property {(cb: () => void) => void} onDisconnect
 * @property {boolean} connected
 * @property {string} name
 */

export class TransportError extends Error {
  constructor(message, code = 'TRANSPORT') { super(message); this.name = 'TransportError'; this.code = code; }
}
```

- [ ] **Step 4: 實作 fake-device.js**

```js
import { TransportError } from './transport.js';
import { FrameAssembler, buildFrame } from '../protocol/frame.js';
import { CMD, parseResponse } from '../protocol/commands.js';
import { hi, lo, encodeFreq, encodeGain, encodeQ } from '../protocol/codec.js';
import { REG_COUNT, MODE_END, CH_COUNT, EQ_SLOTS, ADDR, eqAddr, xoverAddr } from '../protocol/addrmap.js';
import { INPUT } from '../protocol/tables.js';

const ISO31 = [20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600,
  2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** In-memory DSP-X8s stand-in implementing the Transport interface. */
export class FakeDevice {
  constructor({ latencyMs = 2, chunkSize = 20, customerId = 4006, failSect = false, dropNext = 0, name = 'DSP-X8s-SIM' } = {}) {
    Object.assign(this, { latencyMs, chunkSize, customerId, failSect, dropNext, name });
    this.connected = false;
    this.regs = new Uint16Array(REG_COUNT);
    this.slots = Array.from({ length: 8 }, () => new Uint16Array(MODE_END));
    this.currentMode = 1;
    this.sent = [];
    this.dataCbs = [];
    this.disconnectCbs = [];
    this.asm = new FrameAssembler();
    this.seedDefaults();
  }

  seedDefaults() {
    const r = this.regs;
    r.fill(0);
    for (let ch = 1; ch <= CH_COUNT; ch++) {
      r[xoverAddr(ch, 1, 'TYPE')] = 1; r[xoverAddr(ch, 1, 'F')] = encodeFreq(20); r[xoverAddr(ch, 1, 'G')] = 500; r[xoverAddr(ch, 1, 'Q')] = 71;
      r[xoverAddr(ch, 2, 'TYPE')] = 2; r[xoverAddr(ch, 2, 'F')] = encodeFreq(20000); r[xoverAddr(ch, 2, 'G')] = 500; r[xoverAddr(ch, 2, 'Q')] = 71;
      for (let b = 1; b <= EQ_SLOTS; b++) {
        if (b <= ISO31.length) {
          r[eqAddr(ch, b, 'TYPE')] = 1; r[eqAddr(ch, b, 'F')] = encodeFreq(ISO31[b - 1]);
          r[eqAddr(ch, b, 'G')] = encodeGain(0); r[eqAddr(ch, b, 'Q')] = encodeQ(4.32);
        }
      }
      r[ADDR.mix11(ch)] = 570;
      r[ADDR.mix41(ch, 1)] = 0;
    }
    r[ADDR.EQ_BYPASS_SWITCH] = 1;
    r[ADDR.M0_MODE] = 1;
    r[ADDR.M0_INPUT_SET] = INPUT.BT;
    r[ADDR.M0_INPUT_CUR] = INPUT.BT;
    r[ADDR.USB_L_VOL] = 530;
    for (const slot of this.slots) slot.set(r.subarray(0, MODE_END));
    this.currentMode = 1;
  }

  setRegister(addr, val) { this.regs[addr] = val & 0xFFFF; }
  pokeMode(n) { this.regs.set(this.slots[n - 1], 0); this.regs[ADDR.M0_MODE] = n; this.currentMode = n; }

  async connect() { this.connected = true; this.asm.reset(); return { name: this.name }; }
  async disconnect() { if (!this.connected) return; this.connected = false; for (const cb of this.disconnectCbs) cb(); }
  onData(cb) { this.dataCbs.push(cb); }
  onDisconnect(cb) { this.disconnectCbs.push(cb); }

  async write(bytes) {
    if (!this.connected) throw new TransportError('not connected', 'NOT_CONNECTED');
    for (const frame of this.asm.push(bytes)) {
      this.sent.push(frame);
      if (this.dropNext > 0) { this.dropNext--; continue; }
      const resp = this.#handle(frame);
      if (resp) this.#emit(resp); // not awaited: responses arrive asynchronously like BLE notifications
    }
  }

  #handle(frame) {
    const cmd = frame[2];
    const data = frame.subarray(3, frame.length - 2);
    const parsed = parseResponse({ cmd, data });
    switch (cmd) {
      case CMD.CHECK_ID: return buildFrame(cmd, [hi(this.customerId), lo(this.customerId)]);
      case CMD.READ: {
        const out = [];
        for (let i = 0; i + 1 < data.length; i += 2) { const a = (data[i] << 8) | data[i + 1]; out.push(data[i], data[i + 1], hi(this.regs[a] ?? 0), lo(this.regs[a] ?? 0)); }
        return buildFrame(cmd, out);
      }
      case CMD.WRITE:
        for (const { addr, val } of parsed.pairs) if (addr < REG_COUNT) this.regs[addr] = val;
        return frame.slice();
      case CMD.UPLOAD_SECT: {
        if (this.failSect) return null;
        const start = (data[0] << 8) | data[1];
        const out = [data[0], data[1]];
        for (let a = start; a < Math.min(start + 100, REG_COUNT); a++) out.push(hi(this.regs[a]), lo(this.regs[a]));
        return buildFrame(cmd, out);
      }
      case CMD.CALL_MODE: { const n = data[0]; if (n >= 1 && n <= 8) this.pokeMode(n); return buildFrame(cmd, [n]); }
      case CMD.SAVE_MODE: { const n = data[0]; if (n >= 1 && n <= 8) this.slots[n - 1].set(this.regs.subarray(0, MODE_END)); return buildFrame(cmd, [n]); }
      default: return null;
    }
  }

  async #emit(resp) {
    for (let i = 0; i < resp.length; i += this.chunkSize) {
      await sleep(this.latencyMs);
      if (!this.connected) return;
      const chunk = resp.slice(i, i + this.chunkSize);
      for (const cb of this.dataCbs) cb(chunk);
    }
  }
}
```

- [ ] **Step 5: 執行確認通過**

Run: `node --test test/fake-device.test.js`
Expected: 全部 pass。注意最後一段 1600 起應回 79 個值（1600 到 1678），測試已如此寫。

- [ ] **Step 6: Commit**

```bash
git add js/transport/transport.js js/transport/fake-device.js test/fake-device.test.js
git commit -m "feat(transport): transport interface and in-memory fake DSP device"
```

---

### Task 9: 送收佇列（queue.js）

**Files:**
- Create: `js/core/queue.js`
- Test: `test/queue.test.js`

**Interfaces:**
- Consumes: Transport（Task 8）、`FrameAssembler`、`matchesRequest`、`coalesceKey`、`parseResponse`、Logger
- Produces: `class TimeoutError extends Error`
- Produces: `class Queue { constructor(transport, logger, { timeoutMs = 1700, retries = 3, deadAfter = 3 } = {}); send(frame: Uint8Array): Promise<{ raw: Uint8Array, cmd: number, data: Uint8Array, parsed: object }>; onUnsolicited(cb(frame)); onDead(cb()); get pendingCount(); get inFlight(): boolean; clear(reason?: Error); stats: { sent, acked, resent, timeouts, unsolicited } }`
- 行為：一次只有一個在途封包。`send` 加入待送清單；若有相同 `coalesceKey` 的待送（非在途）項目，用新封包取代，兩個 promise 共用結果。在途封包逾時 `timeoutMs` 重送，最多 `retries` 次，之後以 TimeoutError 拒絕；連續 `deadAfter` 個封包失敗觸發 `onDead`。收到不對應在途封包的完整封包時觸發 `onUnsolicited`。每個 TX/RX 都記錄到 logger。

- [ ] **Step 1: 寫測試**

`test/queue.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Queue, TimeoutError } from '../js/core/queue.js';
import { Logger } from '../js/core/logger.js';
import { FakeDevice } from '../js/transport/fake-device.js';
import * as cmd from '../js/protocol/commands.js';
import { eqAddr } from '../js/protocol/addrmap.js';

async function setup(devOpts = {}, qOpts = {}) {
  const dev = new FakeDevice(devOpts);
  await dev.connect();
  const log = new Logger();
  const q = new Queue(dev, log, { timeoutMs: 40, retries: 2, deadAfter: 2, ...qOpts });
  return { dev, log, q };
}

test('send resolves with parsed response and logs TX/RX', async () => {
  const { q, log } = await setup();
  const res = await q.send(cmd.checkIdPacket());
  assert.equal(res.parsed.type, 'id');
  assert.equal(res.parsed.id, 4006);
  assert.deepEqual(log.entries.map((e) => e.level), ['TX', 'RX']);
  assert.equal(q.stats.sent, 1);
  assert.equal(q.stats.acked, 1);
});

test('requests are serialised: second is not written until first is acked', async () => {
  const { q, dev } = await setup({ latencyMs: 5 });
  const p1 = q.send(cmd.readPacket([1242]));
  const p2 = q.send(cmd.uploadSectPacket(0));
  await new Promise((r) => setTimeout(r, 1));
  assert.equal(dev.sent.length, 1);
  await p1;
  await p2;
  assert.equal(dev.sent.length, 2);
});

test('coalescing: 100 rapid writes to one address send the in-flight one and the last one only', async () => {
  const { q, dev } = await setup({ latencyMs: 5 });
  const addr = eqAddr(1, 3, 'G');
  const promises = [];
  for (let v = 500; v < 600; v++) promises.push(q.send(cmd.writePacket([{ addr, val: v }])));
  const results = await Promise.all(promises);
  assert.equal(dev.sent.length, 2);
  assert.equal(dev.regs[addr], 599);
  assert.equal(results[50].parsed.pairs[0].val, 599); // superseded callers get the final result
  assert.equal(q.pendingCount, 0);
});

test('writes to different addresses are not coalesced', async () => {
  const { q, dev } = await setup();
  await Promise.all([q.send(cmd.writePacket([{ addr: 156, val: 1 }])), q.send(cmd.writePacket([{ addr: 160, val: 1 }]))]);
  assert.equal(dev.sent.length, 2);
});

test('timeout resends up to retries then rejects with TimeoutError; onDead after consecutive failures', async () => {
  const { q, dev } = await setup({ failSect: true });
  let dead = 0;
  q.onDead(() => dead++);
  await assert.rejects(q.send(cmd.uploadSectPacket(0)), TimeoutError);
  assert.equal(dev.sent.length, 3); // 1 + 2 retries
  assert.equal(q.stats.resent, 2);
  assert.equal(q.stats.timeouts, 1);
  assert.equal(dead, 0);
  await assert.rejects(q.send(cmd.uploadSectPacket(100)), TimeoutError);
  assert.equal(dead, 1);
  await q.send(cmd.checkIdPacket()); // a success resets the streak
  await assert.rejects(q.send(cmd.uploadSectPacket(200)), TimeoutError);
  assert.equal(dead, 1);
});

test('a dropped first attempt is recovered by the resend', async () => {
  const { q, dev } = await setup({ dropNext: 1 });
  const res = await q.send(cmd.checkIdPacket());
  assert.equal(res.parsed.id, 4006);
  assert.equal(dev.sent.length, 2);
});

test('unsolicited frames are reported and do not ack the in-flight request', async () => {
  const { q, dev } = await setup({ latencyMs: 5 });
  const seen = [];
  q.onUnsolicited((f) => seen.push(f[2]));
  const p = q.send(cmd.readPacket([1242]));
  // inject a BT_READ notification while the read is in flight
  const { buildFrame } = await import('../js/protocol/frame.js');
  for (const cb of dev.dataCbs) cb(buildFrame(0x71, [1, 2, 3]));
  const res = await p;
  assert.equal(res.parsed.type, 'regs');
  assert.deepEqual(seen, [0x71]);
  assert.equal(q.stats.unsolicited, 1);
});

test('clear rejects everything pending and in flight', async () => {
  const { q } = await setup({ failSect: true });
  const p1 = q.send(cmd.uploadSectPacket(0));
  const p2 = q.send(cmd.uploadSectPacket(100));
  q.clear(new Error('disconnected'));
  await assert.rejects(p1, /disconnected/);
  await assert.rejects(p2, /disconnected/);
  assert.equal(q.pendingCount, 0);
  assert.equal(q.inFlight, false);
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `node --test test/queue.test.js`
Expected: FAIL。

- [ ] **Step 3: 實作 queue.js**

```js
import { FrameAssembler } from '../protocol/frame.js';
import { matchesRequest, coalesceKey, parseResponse } from '../protocol/commands.js';

export class TimeoutError extends Error {
  constructor(message) { super(message); this.name = 'TimeoutError'; }
}

/** One-in-flight request queue with ack matching, coalescing, resend and dead detection. */
export class Queue {
  constructor(transport, logger, { timeoutMs = 1700, retries = 3, deadAfter = 3 } = {}) {
    this.transport = transport;
    this.log = logger;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.deadAfter = deadAfter;
    this.pending = [];        // [{ frame, key, waiters: [{resolve, reject}] }]
    this.current = null;      // in-flight item + { attempts, timer }
    this.consecutiveFailures = 0;
    this.stats = { sent: 0, acked: 0, resent: 0, timeouts: 0, unsolicited: 0 };
    this.unsolicitedCbs = [];
    this.deadCbs = [];
    this.asm = new FrameAssembler();
    transport.onData((chunk) => { for (const f of this.asm.push(chunk)) this.#onFrame(f); });
  }

  get pendingCount() { return this.pending.length; }
  get inFlight() { return this.current !== null; }
  onUnsolicited(cb) { this.unsolicitedCbs.push(cb); }
  onDead(cb) { this.deadCbs.push(cb); }

  send(frame) {
    return new Promise((resolve, reject) => {
      const key = coalesceKey(frame);
      const existing = key ? this.pending.find((p) => p.key === key) : null;
      if (existing) {
        existing.frame = frame;
        existing.waiters.push({ resolve, reject });
      } else {
        this.pending.push({ frame, key, waiters: [{ resolve, reject }] });
      }
      this.#pump();
    });
  }

  clear(reason = new Error('queue cleared')) {
    if (this.current) { clearTimeout(this.current.timer); this.#settle(this.current, null, reason); this.current = null; }
    for (const p of this.pending) this.#settle(p, null, reason);
    this.pending = [];
    this.asm.reset();
  }

  #settle(item, value, error) {
    for (const w of item.waiters) (error ? w.reject(error) : w.resolve(value));
  }

  #pump() {
    if (this.current || this.pending.length === 0) return;
    const item = this.pending.shift();
    this.current = { ...item, attempts: 0, timer: null };
    this.#transmit();
  }

  async #transmit() {
    const cur = this.current;
    if (!cur) return;
    cur.attempts++;
    if (cur.attempts > 1) { this.stats.resent++; this.log.warn(`逾時重送 (${cur.attempts - 1}/${this.retries})`); } else this.stats.sent++;
    this.log.tx(cur.frame);
    cur.timer = setTimeout(() => this.#onTimeout(), this.timeoutMs);
    try {
      await this.transport.write(cur.frame);
    } catch (err) {
      if (this.current !== cur) return;
      clearTimeout(cur.timer);
      this.current = null;
      this.log.error(`寫入失敗：${err.message}`);
      this.#settle(cur, null, err);
      this.#pump();
    }
  }

  #onTimeout() {
    const cur = this.current;
    if (!cur) return;
    if (cur.attempts <= this.retries) { this.#transmit(); return; }
    this.stats.timeouts++;
    this.consecutiveFailures++;
    this.current = null;
    this.log.error(`無回應，放棄（${cur.attempts} 次）`);
    this.#settle(cur, null, new TimeoutError('device did not respond'));
    if (this.consecutiveFailures >= this.deadAfter) { this.consecutiveFailures = 0; for (const cb of this.deadCbs) cb(); }
    this.#pump();
  }

  #onFrame(frame) {
    this.log.rx(frame);
    const cur = this.current;
    if (cur && matchesRequest(cur.frame, frame)) {
      clearTimeout(cur.timer);
      this.current = null;
      this.stats.acked++;
      this.consecutiveFailures = 0;
      const data = frame.subarray(3, frame.length - 2);
      this.#settle(cur, { raw: frame, cmd: frame[2], data, parsed: parseResponse({ cmd: frame[2], data }) }, null);
      this.#pump();
      return;
    }
    this.stats.unsolicited++;
    for (const cb of this.unsolicitedCbs) cb(frame);
  }
}
```

- [ ] **Step 4: 執行確認通過**

Run: `node --test test/queue.test.js`
Expected: 全部 pass。若 coalescing 測試偶爾送出 3 個封包，把 FakeDevice latencyMs 提高到 10 再跑；測試的目的在於「中間值全部被合併」，`dev.sent.length` 必須遠小於 100。

- [ ] **Step 5: Commit**

```bash
git add js/core/queue.js test/queue.test.js
git commit -m "feat(core): request queue with ack matching, coalescing, resend and dead detection"
```

---
### Task 10: 裝置流程（device.js）

**Files:**
- Create: `js/core/device.js`
- Test: `test/device.test.js`

**Interfaces:**
- Consumes: Transport、Queue、RegisterStore、Logger、commands、addrmap、codec、tables
- Produces: `STATE = { DISCONNECTED: 'disconnected', CONNECTING: 'connecting', CONNECTED: 'connected', READONLY: 'readonly' }`
- Produces: `class Device { constructor({ transport, store, logger, queueOptions = {}, heartbeatMs = 1000, modeReloadDelayMs = 1200 }); state; info: { name, customerId, connectedAt }; dumpInfo: { complete, ms, failedSegments: number[], method: 'sect'|'mixed'|'none' }; on(event, cb)→unsub; connect(): Promise<void>; disconnect(): Promise<void>; checkId(): Promise<number>; dump(): Promise<dumpInfo>; readRegs(addrs): Promise<pairs>; writeRegs(pairs): Promise<void>; verify(addrs): Promise<[{addr, expected, actual}]>; writeAndVerify(pairs): Promise<{ mismatches, ms }>; writeTest(ch, band, db): Promise<{ addr, name, before, sent, readBack, ok, ms }>; callMode(n): Promise<void>; saveMode(n): Promise<void>; startHeartbeat(); stopHeartbeat(); get canWrite(): boolean }`
- 事件：`state`（新狀態字串）、`progress`（`{ done, total }`）、`dump`（dumpInfo）、`snapshot`（store.snapshot()）、`mode`（新模式號）、`error`（Error）
- `writeRegs` 規則：state 不是 CONNECTED 時 throw `Error('readonly')`（不送任何封包）；任何 `isTypeAddr(addr)` 為真或 `addr > DUMP_END` 的位址 throw `RangeError`；先 `store.markPending`，每個封包回應後 `store.setMany(pairs, CONFIRMED)`。
- `dump` 規則：依 `sectPlan()` 逐段 UPLOAD_SECT；某段 TimeoutError 時改用 `readPackets` 讀該段的每個位址（只讀到 DUMP_END），成功則 method = 'mixed'，仍失敗則加入 failedSegments、complete = false。結束後 emit `dump`，若 complete 則 emit `snapshot`。
- 心跳：每 `heartbeatMs` 送 `readPacket(HEARTBEAT_ADDRS)`；回應寫入 store；若 M0_MODE 與上次不同則 emit `mode` 並重新 `dump()`。`callMode(n)` 送出後等待 `modeReloadDelayMs` 再 `dump()`。Queue 的 `onDead` 觸發 `disconnect()`。

- [ ] **Step 1: 寫測試**

`test/device.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Device, STATE } from '../js/core/device.js';
import { RegisterStore, STATUS } from '../js/core/store.js';
import { Logger } from '../js/core/logger.js';
import { FakeDevice } from '../js/transport/fake-device.js';
import { ADDR, eqAddr, xoverAddr, DUMP_END } from '../js/protocol/addrmap.js';

function make(devOpts = {}, opts = {}) {
  const transport = new FakeDevice({ latencyMs: 0, ...devOpts });
  const store = new RegisterStore();
  const logger = new Logger();
  const device = new Device({ transport, store, logger, queueOptions: { timeoutMs: 30, retries: 1, deadAfter: 3 }, heartbeatMs: 20, modeReloadDelayMs: 5, ...opts });
  return { transport, store, logger, device };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('connect: id check, full dump, snapshot, state connected', async () => {
  const { device, store } = make();
  const states = []; device.on('state', (s) => states.push(s));
  let progress = 0; device.on('progress', (p) => { progress = p.done; assert.equal(p.total, 17); });
  let snap = null; device.on('snapshot', (s) => { snap = s; });
  await device.connect();
  assert.deepEqual(states, [STATE.CONNECTING, STATE.CONNECTED]);
  assert.equal(device.info.customerId, 4006);
  assert.equal(device.info.name, 'DSP-X8s-SIM');
  assert.equal(progress, 17);
  assert.equal(device.dumpInfo.complete, true);
  assert.equal(device.dumpInfo.method, 'sect');
  assert.equal(store.get(eqAddr(1, 1, 'G')), 500);
  assert.equal(store.getStatus(DUMP_END), STATUS.CONFIRMED);
  assert.equal(store.confirmedCount(), DUMP_END + 1);
  assert.ok(snap && snap.values.length === DUMP_END + 1);
  await device.disconnect();
  assert.equal(device.state, STATE.DISCONNECTED);
});

test('wrong customer id → readonly, writes refused without sending', async () => {
  const { device, transport } = make({ customerId: 1234 });
  await device.connect();
  assert.equal(device.state, STATE.READONLY);
  assert.equal(device.canWrite, false);
  const sentBefore = transport.sent.length;
  await assert.rejects(device.writeRegs([{ addr: eqAddr(1, 1, 'G'), val: 510 }]), /readonly/);
  assert.equal(transport.sent.length, sentBefore);
  await device.disconnect();
});

test('TYPE fields and out-of-range addresses are refused', async () => {
  const { device } = make();
  await device.connect();
  await assert.rejects(device.writeRegs([{ addr: eqAddr(1, 1, 'TYPE'), val: 1 }]), RangeError);
  await assert.rejects(device.writeRegs([{ addr: xoverAddr(1, 2, 'TYPE'), val: 1 }]), RangeError);
  await assert.rejects(device.writeRegs([{ addr: DUMP_END + 1, val: 1 }]), RangeError);
  await device.disconnect();
});

test('writeRegs marks pending then confirmed; verify detects a mismatch', async () => {
  const { device, store, transport } = make();
  await device.connect();
  const addr = eqAddr(1, 3, 'G');
  await device.writeRegs([{ addr, val: 560 }]);
  assert.equal(store.get(addr), 560);
  assert.equal(store.getStatus(addr), STATUS.CONFIRMED);
  transport.setRegister(addr, 500); // device silently changed
  const mism = await device.verify([addr]);
  assert.deepEqual(mism, [{ addr, expected: 560, actual: 500 }]);
  assert.equal(store.getStatus(addr), STATUS.MISMATCH);
  await device.disconnect();
});

test('writeTest reports before/sent/readBack and ok', async () => {
  const { device } = make();
  await device.connect();
  const r = await device.writeTest(1, 3, 6);
  assert.equal(r.addr, eqAddr(1, 3, 'G'));
  assert.equal(r.name, 'CH1 EQ3 G');
  assert.equal(r.before, 500);
  assert.equal(r.sent, 560);
  assert.equal(r.readBack, 560);
  assert.equal(r.ok, true);
  assert.ok(r.ms >= 0);
  await device.disconnect();
});

test('sect failure falls back to plain reads; dumpInfo.method is mixed', async () => {
  const { device, store } = make({ failSect: true });
  await device.connect();
  assert.equal(device.dumpInfo.complete, true);
  assert.equal(device.dumpInfo.method, 'mixed');
  assert.equal(store.confirmedCount(), DUMP_END + 1);
  await device.disconnect();
});

test('heartbeat notices a mode change and re-dumps', async () => {
  const { device, transport, store } = make();
  await device.connect();
  const modes = []; device.on('mode', (m) => modes.push(m));
  let dumps = 0; device.on('dump', () => dumps++);
  transport.slots[4][eqAddr(1, 1, 'G')] = 530;
  transport.pokeMode(5);
  await wait(150);
  assert.deepEqual(modes, [5]);
  assert.ok(dumps >= 1);
  assert.equal(store.get(ADDR.M0_MODE), 5);
  assert.equal(store.get(eqAddr(1, 1, 'G')), 530);
  await device.disconnect();
});

test('callMode reloads registers from the slot', async () => {
  const { device, transport, store } = make();
  await device.connect();
  transport.slots[2][eqAddr(2, 2, 'G')] = 470;
  await device.callMode(3);
  assert.equal(store.get(ADDR.M0_MODE), 3);
  assert.equal(store.get(eqAddr(2, 2, 'G')), 470);
  await device.disconnect();
});

test('transport disconnect moves state to disconnected and stops heartbeat', async () => {
  const { device, transport } = make();
  await device.connect();
  await transport.disconnect();
  await wait(10);
  assert.equal(device.state, STATE.DISCONNECTED);
  const n = transport.sent.length;
  await wait(60);
  assert.equal(transport.sent.length, n);
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `node --test test/device.test.js`
Expected: FAIL。

- [ ] **Step 3: 實作 device.js**

```js
import { Queue, TimeoutError } from './queue.js';
import { STATUS } from './store.js';
import * as cmd from '../protocol/commands.js';
import { ADDR, DUMP_END, HEARTBEAT_ADDRS, isTypeAddr, eqAddr, describeAddr } from '../protocol/addrmap.js';
import { encodeGain } from '../protocol/codec.js';
import { CUSTOMER_ID } from '../protocol/tables.js';

export const STATE = Object.freeze({ DISCONNECTED: 'disconnected', CONNECTING: 'connecting', CONNECTED: 'connected', READONLY: 'readonly' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Device {
  constructor({ transport, store, logger, queueOptions = {}, heartbeatMs = 1000, modeReloadDelayMs = 1200 }) {
    this.transport = transport;
    this.store = store;
    this.log = logger;
    this.queueOptions = queueOptions;
    this.heartbeatMs = heartbeatMs;
    this.modeReloadDelayMs = modeReloadDelayMs;
    this.state = STATE.DISCONNECTED;
    this.info = { name: '', customerId: null, connectedAt: null };
    this.dumpInfo = { complete: false, ms: 0, failedSegments: [], method: 'none' };
    this.queue = null;
    this.heartbeatTimer = null;
    this.heartbeatBusy = false;
    this.lastMode = null;
    this.listeners = new Map();
    transport.onDisconnect(() => this.#onTransportLost());
  }

  on(event, cb) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(cb);
    return () => this.listeners.get(event).delete(cb);
  }
  #emit(event, payload) { for (const cb of this.listeners.get(event) ?? []) { try { cb(payload); } catch (e) { this.log.error(`listener ${event}: ${e.message}`); } } }
  #setState(s) { if (this.state !== s) { this.state = s; this.#emit('state', s); } }

  get canWrite() { return this.state === STATE.CONNECTED; }

  async connect() {
    if (this.state !== STATE.DISCONNECTED) return;
    this.#setState(STATE.CONNECTING);
    try {
      const { name } = await this.transport.connect();
      this.info = { name, customerId: null, connectedAt: Date.now() };
      this.log.info(`已連線：${name}`);
      this.queue = new Queue(this.transport, this.log, this.queueOptions);
      this.queue.onUnsolicited((f) => { if (f[2] !== cmd.CMD.BT_READ) this.log.warn(`未預期的回應 cmd=0x${f[2].toString(16)}`); });
      this.queue.onDead(() => { this.log.error('連續無回應，判定斷線'); this.disconnect(); });
      const id = await this.checkId();
      if (id === CUSTOMER_ID) { this.#setState(STATE.CONNECTED); this.log.info(`客戶代碼 ${id} 正確`); }
      else { this.#setState(STATE.READONLY); this.log.warn(`客戶代碼 ${id} 不符（預期 ${CUSTOMER_ID}），進入唯讀模式`); }
      await this.dump();
      this.startHeartbeat();
    } catch (err) {
      this.log.error(`連線失敗：${err.message}`);
      this.#emit('error', err);
      await this.disconnect();
      throw err;
    }
  }

  async disconnect() {
    this.stopHeartbeat();
    if (this.queue) { this.queue.clear(new Error('disconnected')); this.queue = null; }
    if (this.transport.connected) { try { await this.transport.disconnect(); } catch { /* ignore */ } }
    if (this.state !== STATE.DISCONNECTED) { this.log.info('已斷線'); this.#setState(STATE.DISCONNECTED); }
  }

  #onTransportLost() {
    if (this.state === STATE.DISCONNECTED) return;
    this.log.warn('藍牙連線中斷');
    this.disconnect();
  }

  #requireQueue() { if (!this.queue) throw new Error('not connected'); return this.queue; }

  async checkId() {
    const res = await this.#requireQueue().send(cmd.checkIdPacket());
    this.info.customerId = res.parsed.id;
    return res.parsed.id;
  }

  async dump() {
    const q = this.#requireQueue();
    const t0 = Date.now();
    const plan = cmd.sectPlan();
    const info = { complete: true, ms: 0, failedSegments: [], method: 'sect' };
    let done = 0;
    this.#emit('progress', { done, total: plan.length });
    for (const start of plan) {
      const end = Math.min(start + cmd.SECT_SIZE - 1, DUMP_END);
      try {
        const res = await q.send(cmd.uploadSectPacket(start));
        const pairs = res.parsed.values.slice(0, end - start + 1).map((val, i) => ({ addr: start + i, val }));
        this.store.setMany(pairs, STATUS.CONFIRMED);
      } catch (err) {
        if (!(err instanceof TimeoutError)) throw err;
        this.log.warn(`區段 ${start} 無回應，改用一般讀取`);
        const ok = await this.#readRange(start, end);
        if (ok) info.method = 'mixed'; else { info.complete = false; info.failedSegments.push(start); }
      }
      done++;
      this.#emit('progress', { done, total: plan.length });
    }
    info.ms = Date.now() - t0;
    this.dumpInfo = info;
    this.lastMode = this.store.get(ADDR.M0_MODE);
    this.log.info(`整機讀取${info.complete ? '完成' : '不完整'}：${info.ms} ms，方式 ${info.method}${info.failedSegments.length ? '，失敗區段 ' + info.failedSegments.join(',') : ''}`);
    this.#emit('dump', info);
    if (info.complete) this.#emit('snapshot', this.store.snapshot());
    return info;
  }

  async #readRange(start, end) {
    const addrs = []; for (let a = start; a <= end; a++) addrs.push(a);
    try { await this.readRegs(addrs); return true; } catch (err) { if (err instanceof TimeoutError) return false; throw err; }
  }

  async readRegs(addrs) {
    const q = this.#requireQueue();
    const all = [];
    for (const pkt of cmd.readPackets(addrs)) {
      const res = await q.send(pkt);
      this.store.setMany(res.parsed.pairs, STATUS.CONFIRMED);
      all.push(...res.parsed.pairs);
    }
    return all;
  }

  async writeRegs(pairs) {
    if (!this.canWrite) throw new Error('readonly: writes are disabled');
    for (const { addr, val } of pairs) {
      if (!Number.isInteger(addr) || addr < 0 || addr > DUMP_END) throw new RangeError(`address out of range: ${addr}`);
      if (isTypeAddr(addr)) throw new RangeError(`refusing to write TYPE field ${describeAddr(addr)}`);
      if (!Number.isInteger(val) || val < 0 || val > 0xFFFF) throw new RangeError(`value out of range: ${val}`);
    }
    const q = this.#requireQueue();
    this.store.markPending(pairs.map((p) => p.addr));
    for (const pkt of cmd.writePackets(pairs)) {
      const res = await q.send(pkt);
      this.store.setMany(res.parsed.pairs, STATUS.CONFIRMED);
    }
  }

  async verify(addrs) {
    const expected = new Map(addrs.map((a) => [a, this.store.get(a)]));
    const q = this.#requireQueue();
    const mismatches = [];
    for (const pkt of cmd.readPackets(addrs)) {
      const res = await q.send(pkt);
      for (const { addr, val } of res.parsed.pairs) {
        if (val === expected.get(addr)) this.store.set(addr, val, STATUS.CONFIRMED);
        else { mismatches.push({ addr, expected: expected.get(addr), actual: val }); this.store.markMismatch(addr, val); }
      }
    }
    if (mismatches.length) this.log.warn(`讀回不符 ${mismatches.length} 筆：` + mismatches.map((m) => `${describeAddr(m.addr)} 期望 ${m.expected} 實際 ${m.actual}`).join('；'));
    return mismatches;
  }

  async writeAndVerify(pairs) {
    const t0 = Date.now();
    await this.writeRegs(pairs);
    const mismatches = await this.verify(pairs.map((p) => p.addr));
    return { mismatches, ms: Date.now() - t0 };
  }

  async writeTest(ch, band, db) {
    const addr = eqAddr(ch, band, 'G');
    const name = describeAddr(addr);
    const [{ val: before }] = await this.readRegs([addr]);
    const sent = encodeGain(db);
    this.log.info(`寫入測試：${name} ${before} → ${sent} (${db >= 0 ? '+' : ''}${db} dB)`);
    const { mismatches, ms } = await this.writeAndVerify([{ addr, val: sent }]);
    const readBack = mismatches.length ? mismatches[0].actual : sent;
    const ok = mismatches.length === 0;
    this.log[ok ? 'info' : 'warn'](`寫入測試${ok ? '成功' : '失敗'}：讀回 ${readBack}，${ms} ms`);
    return { addr, name, before, sent, readBack, ok, ms };
  }

  async callMode(n) {
    if (!this.canWrite) throw new Error('readonly: writes are disabled');
    await this.#requireQueue().send(cmd.callModePacket(n));
    this.log.info(`已呼叫模式 ${n}，${this.modeReloadDelayMs} ms 後重新讀取`);
    await sleep(this.modeReloadDelayMs);
    await this.dump();
  }

  async saveMode(n) {
    if (!this.canWrite) throw new Error('readonly: writes are disabled');
    await this.#requireQueue().send(cmd.saveModePacket(n));
    this.log.info(`已儲存到模式 ${n}`);
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.#heartbeat(), this.heartbeatMs);
  }
  stopHeartbeat() { if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; } }

  async #heartbeat() {
    if (!this.queue || this.heartbeatBusy || this.queue.pendingCount > 0) return;
    this.heartbeatBusy = true;
    try {
      await this.readRegs(HEARTBEAT_ADDRS);
      const mode = this.store.get(ADDR.M0_MODE);
      if (this.lastMode !== null && mode !== this.lastMode) {
        this.log.info(`偵測到模式改變 ${this.lastMode} → ${mode}，重新讀取`);
        this.lastMode = mode;
        this.#emit('mode', mode);
        await this.dump();
      }
      this.lastMode = mode;
    } catch (err) {
      if (!(err instanceof TimeoutError)) this.log.error(`心跳錯誤：${err.message}`);
    } finally {
      this.heartbeatBusy = false;
    }
  }
}
```

- [ ] **Step 4: 執行確認通過**

Run: `node --test test/device.test.js`
Expected: 全部 pass。

- [ ] **Step 5: Commit**

```bash
git add js/core/device.js test/device.test.js
git commit -m "feat(core): device connect flow, dump with fallback, guarded writes, verify, heartbeat"
```

---

### Task 11: 報告摘要（report.js）

**Files:**
- Create: `js/core/report.js`
- Test: `test/report.test.js`

**Interfaces:**
- Consumes: RegisterStore、addrmap、codec
- Produces: `buildReport({ env, info, dumpInfo, store, writeTest = null }) → string`，以 `===== 報告摘要 =====` 開頭、`===== 報告結束 =====` 結尾
- Produces: `inferQScale(store) → { qRaw: number[], verdict: 'no-qrate' | 'qrate' | 'unclear' }`（取 8 聲道第 1 段 Q 原始值：全部在 80 到 130 → no-qrate；全部在 25 到 40 → qrate；否則 unclear）
- `env` 形狀：`{ userAgent, webBluetooth, bluefy, standalone, secure }`（Task 13 的 detectEnvironment 產生）

- [ ] **Step 1: 寫測試**

`test/report.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, inferQScale } from '../js/core/report.js';
import { RegisterStore } from '../js/core/store.js';
import { FakeDevice } from '../js/transport/fake-device.js';
import { eqAddr, xoverAddr, ADDR } from '../js/protocol/addrmap.js';

function seededStore() {
  const dev = new FakeDevice();
  const store = new RegisterStore();
  store.setMany(Array.from({ length: store.size }, (_, addr) => ({ addr, val: dev.regs[addr] })));
  return store;
}
const env = { userAgent: 'TestUA/1.0', webBluetooth: true, bluefy: false, standalone: false, secure: true };
const info = { name: 'DSP-X8s-SIM', customerId: 4006, connectedAt: 0 };
const dumpInfo = { complete: true, ms: 1234, failedSegments: [], method: 'sect' };

test('inferQScale', () => {
  const store = seededStore();
  for (let ch = 1; ch <= 8; ch++) store.set(eqAddr(ch, 1, 'Q'), 100);
  assert.equal(inferQScale(store).verdict, 'no-qrate');
  for (let ch = 1; ch <= 8; ch++) store.set(eqAddr(ch, 1, 'Q'), 32);
  assert.equal(inferQScale(store).verdict, 'qrate');
  store.set(eqAddr(3, 1, 'Q'), 900);
  assert.equal(inferQScale(store).verdict, 'unclear');
});

test('report contains every mandated section', () => {
  const store = seededStore();
  const text = buildReport({ env, info, dumpInfo, store, writeTest: { addr: 156, name: 'CH1 EQ3 G', before: 500, sent: 560, readBack: 560, ok: true, ms: 88 } });
  assert.ok(text.startsWith('===== 報告摘要 ====='));
  assert.ok(text.trimEnd().endsWith('===== 報告結束 ====='));
  for (const needle of ['TestUA/1.0', 'DSP-X8s-SIM', '客戶代碼: 4006', '整機讀取: 完整', '1234 ms', 'CH1 XOVER', 'CH1 EQ1', 'CH1 EQ2', 'CH1 EQ3', 'CH1 EQ32', 'Q 推斷', 'MUTE_1', 'MIX11_1', 'MIX41_1_1', 'SWITCH21_1', 'DELAY_1', 'M0_1', '寫入測試', '送出 560', 'ok']) {
    assert.ok(text.includes(needle), `missing ${needle}`);
  }
});

test('report without writeTest says so and lists failed segments', () => {
  const store = seededStore();
  const text = buildReport({ env, info, dumpInfo: { complete: false, ms: 5, failedSegments: [300, 400], method: 'mixed' }, store });
  assert.ok(text.includes('整機讀取: 不完整'));
  assert.ok(text.includes('失敗區段: 300, 400'));
  assert.ok(text.includes('寫入測試: 未執行'));
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `node --test test/report.test.js`
Expected: FAIL。

- [ ] **Step 3: 實作 report.js**

```js
import { ADDR, eqAddr, xoverAddr, describeAddr, CH_COUNT } from '../protocol/addrmap.js';
import { decodeGain, decodeFreq, decodeQ, decodeVol } from '../protocol/codec.js';

export function inferQScale(store) {
  const qRaw = [];
  for (let ch = 1; ch <= CH_COUNT; ch++) qRaw.push(store.get(eqAddr(ch, 1, 'Q')));
  const all = (lo, hi) => qRaw.every((v) => v >= lo && v <= hi);
  const verdict = all(80, 130) ? 'no-qrate' : all(25, 40) ? 'qrate' : 'unclear';
  return { qRaw, verdict };
}

function filterLine(store, label, typeAddr) {
  const t = store.get(typeAddr), f = store.get(typeAddr + 1), g = store.get(typeAddr + 2), q = store.get(typeAddr + 3);
  return `${label}: TYPE=${t} F=${f} (${decodeFreq(f)} Hz) G=${g} (${decodeGain(g).toFixed(1)} dB) Q=${q} (Q ${decodeQ(q)})`;
}

function rawList(store, addrs) {
  return addrs.map((a) => `${describeAddr(a)}=${store.get(a)}`).join(' ');
}

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

export function buildReport({ env, info, dumpInfo, store, writeTest = null }) {
  const L = [];
  L.push('===== 報告摘要 =====');
  L.push(`時間: ${new Date().toISOString()}`);
  L.push(`瀏覽器: ${env.userAgent}`);
  L.push(`WebBluetooth: ${env.webBluetooth} Bluefy: ${env.bluefy} 安裝模式: ${env.standalone} HTTPS: ${env.secure}`);
  L.push(`裝置: ${info.name || '-'}  客戶代碼: ${info.customerId ?? '-'}`);
  L.push(`整機讀取: ${dumpInfo.complete ? '完整' : '不完整'}  ${dumpInfo.ms} ms  方式: ${dumpInfo.method}`);
  if (dumpInfo.failedSegments?.length) L.push(`失敗區段: ${dumpInfo.failedSegments.join(', ')}`);
  L.push('');
  L.push('[CH1 濾波器區 base+0..7 原始值]');
  L.push(range(xoverAddr(1, 1, 'TYPE'), xoverAddr(1, 2, 'Q')).map((a) => store.get(a)).join(' '));
  L.push(filterLine(store, 'CH1 XOVER1', xoverAddr(1, 1, 'TYPE')));
  L.push(filterLine(store, 'CH1 XOVER2', xoverAddr(1, 2, 'TYPE')));
  for (const b of [1, 2, 3, 32]) L.push(filterLine(store, `CH1 EQ${b}`, eqAddr(1, b, 'TYPE')));
  L.push('');
  const qs = inferQScale(store);
  L.push(`[Q 推斷] 各聲道 EQ1 Q 原始值: ${qs.qRaw.join(' ')} → ${qs.verdict === 'no-qrate' ? '不套用 QRate（Q = raw/100）' : qs.verdict === 'qrate' ? '疑似套用 QRate' : '無法判定'}`);
  L.push('');
  L.push('[MUTE 1..11] ' + rawList(store, range(ADDR.mute(1), ADDR.mute(11))));
  L.push('[MIX11 1..8] ' + rawList(store, range(ADDR.mix11(1), ADDR.mix11(8))) + '  解碼: ' + range(ADDR.mix11(1), ADDR.mix11(8)).map((a) => { const { vol, flag } = decodeVol(store.get(a)); return `${vol}${flag ? '+flag' : ''}`; }).join(' '));
  L.push('[MIX41 k,1] ' + rawList(store, range(1, 8).map((k) => ADDR.mix41(k, 1))));
  L.push('[SWITCH21 1..15] ' + rawList(store, range(ADDR.switch21(1), ADDR.switch21(15))));
  L.push('[DELAY 1..9] ' + rawList(store, range(ADDR.delay(1), ADDR.delay(9))));
  L.push('[M0 1..24] ' + rawList(store, range(ADDR.m0(1), ADDR.m0(24))));
  L.push('');
  if (writeTest) {
    L.push(`[寫入測試] ${writeTest.name} (addr ${writeTest.addr}) 之前 ${writeTest.before} → 送出 ${writeTest.sent} → 讀回 ${writeTest.readBack}  結果 ${writeTest.ok ? 'ok' : 'MISMATCH'}  ${writeTest.ms} ms`);
  } else {
    L.push('寫入測試: 未執行');
  }
  L.push('===== 報告結束 =====');
  return L.join('\n');
}
```

- [ ] **Step 4: 執行確認通過**

Run: `node --test test/report.test.js`
Expected: 全部 pass。

- [ ] **Step 5: Commit**

```bash
git add js/core/report.js test/report.test.js
git commit -m "feat(core): report summary builder with Q-scale inference"
```

---

### Task 12: 本地保存（storage.js）

**Files:**
- Create: `js/core/storage.js`
- Test: `test/storage.test.js`

**Interfaces:**
- Produces: `class Storage { static async open({ name = 'dspx8s', version = 1, indexedDB = globalThis.indexedDB } = {}) → Storage; backend: 'idb' | 'memory'; async put(storeName, key, value); async get(storeName, key); async getAll(storeName) → [{ key, value }]; async delete(storeName, key); async clear(storeName) }`，store 名稱固定為 `'snapshots'`, `'logs'`, `'settings'`
- Produces: `class LogPersister { constructor(logger, storage, { batch = 50, intervalMs = 2000 } = {}); start(); stop(); flush(): Promise<void>; static async loadLast(storage) → entries[] | null }`。日誌以 key `'last'` 存整包 entries 陣列（每次 flush 覆寫），另存 `'meta'` `{ savedAt, count }`。

- [ ] **Step 1: 寫測試**

`test/storage.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Storage, LogPersister } from '../js/core/storage.js';
import { Logger } from '../js/core/logger.js';

test('memory backend when indexedDB is unavailable', async () => {
  const s = await Storage.open({ indexedDB: undefined });
  assert.equal(s.backend, 'memory');
  await s.put('snapshots', 'a', { ts: 1 });
  await s.put('snapshots', 'b', { ts: 2 });
  assert.deepEqual(await s.get('snapshots', 'a'), { ts: 1 });
  assert.equal((await s.getAll('snapshots')).length, 2);
  await s.delete('snapshots', 'a');
  assert.equal(await s.get('snapshots', 'a'), undefined);
  await s.clear('snapshots');
  assert.equal((await s.getAll('snapshots')).length, 0);
  await assert.rejects(s.put('nope', 'k', 1), /unknown store/);
});

test('LogPersister flushes on batch size, on interval, and on stop; loadLast restores', async () => {
  const s = await Storage.open({ indexedDB: undefined });
  const log = new Logger();
  const p = new LogPersister(log, s, { batch: 3, intervalMs: 20 });
  p.start();
  log.info('1'); log.info('2');
  assert.equal(await LogPersister.loadLast(s), null);
  log.info('3');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal((await LogPersister.loadLast(s)).length, 3);
  log.info('4');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal((await LogPersister.loadLast(s)).length, 4);
  log.info('5');
  await p.stop();
  assert.equal((await LogPersister.loadLast(s)).length, 5);
  const meta = await s.get('logs', 'meta');
  assert.equal(meta.count, 5);
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `node --test test/storage.test.js`
Expected: FAIL。

- [ ] **Step 3: 實作 storage.js**

```js
const STORES = ['snapshots', 'logs', 'settings'];

export class Storage {
  static async open({ name = 'dspx8s', version = 1, indexedDB = globalThis.indexedDB } = {}) {
    const s = new Storage();
    if (!indexedDB) { s.backend = 'memory'; s.mem = new Map(STORES.map((n) => [n, new Map()])); return s; }
    try {
      s.db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(name, version);
        req.onupgradeneeded = () => { for (const n of STORES) if (!req.result.objectStoreNames.contains(n)) req.result.createObjectStore(n); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('indexedDB blocked'));
      });
      s.backend = 'idb';
    } catch {
      s.backend = 'memory'; s.mem = new Map(STORES.map((n) => [n, new Map()]));
    }
    return s;
  }

  #check(store) { if (!STORES.includes(store)) throw new Error(`unknown store ${store}`); }

  #tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async put(store, key, value) { this.#check(store); if (this.mem) { this.mem.get(store).set(key, structuredClone(value)); return; } await this.#tx(store, 'readwrite', (os) => os.put(value, key)); }
  async get(store, key) { this.#check(store); if (this.mem) { const v = this.mem.get(store).get(key); return v === undefined ? undefined : structuredClone(v); } return this.#tx(store, 'readonly', (os) => os.get(key)); }
  async delete(store, key) { this.#check(store); if (this.mem) { this.mem.get(store).delete(key); return; } await this.#tx(store, 'readwrite', (os) => os.delete(key)); }
  async clear(store) { this.#check(store); if (this.mem) { this.mem.get(store).clear(); return; } await this.#tx(store, 'readwrite', (os) => os.clear()); }
  async getAll(store) {
    this.#check(store);
    if (this.mem) return Array.from(this.mem.get(store), ([key, value]) => ({ key, value: structuredClone(value) }));
    const [keys, values] = await Promise.all([this.#tx(store, 'readonly', (os) => os.getAllKeys()), this.#tx(store, 'readonly', (os) => os.getAll())]);
    return keys.map((key, i) => ({ key, value: values[i] }));
  }
}

export class LogPersister {
  constructor(logger, storage, { batch = 50, intervalMs = 2000 } = {}) {
    this.logger = logger; this.storage = storage; this.batch = batch; this.intervalMs = intervalMs;
    this.unsent = 0; this.timer = null; this.unsub = null; this.flushing = null;
  }
  start() {
    this.unsub = this.logger.subscribe(() => { this.unsent++; if (this.unsent >= this.batch) this.flush(); });
    this.timer = setInterval(() => { if (this.unsent > 0) this.flush(); }, this.intervalMs);
  }
  async stop() { if (this.unsub) this.unsub(); if (this.timer) clearInterval(this.timer); this.unsub = null; this.timer = null; await this.flush(); }
  flush() {
    if (this.flushing) return this.flushing;
    this.unsent = 0;
    const entries = this.logger.entries.slice();
    this.flushing = (async () => {
      try {
        await this.storage.put('logs', 'last', entries);
        await this.storage.put('logs', 'meta', { savedAt: Date.now(), count: entries.length });
      } catch { /* persistence is best-effort */ } finally { this.flushing = null; }
    })();
    return this.flushing;
  }
  static async loadLast(storage) { const e = await storage.get('logs', 'last'); return Array.isArray(e) && e.length ? e : null; }
}
```

- [ ] **Step 4: 執行確認通過**

Run: `node --test test/storage.test.js`
Expected: 全部 pass。

- [ ] **Step 5: Commit**

```bash
git add js/core/storage.js test/storage.test.js
git commit -m "feat(core): IndexedDB storage with memory fallback and batched log persistence"
```

---
### Task 13: Web Bluetooth 傳輸與環境偵測（ble.js）

**Files:**
- Create: `js/transport/ble.js`
- Test: `test/ble.test.js`（只測純函式：`chunk`、`detectEnvironment`、`uuid16`）

**Interfaces:**
- Produces: `SERVICE_UUID = '0000ae00-0000-1000-8000-00805f9b34fb'`, `WRITE_UUID = '0000ae01-...'`, `NOTIFY_UUID = '0000ae02-...'`, `uuid16(n)→string`
- Produces: `chunk(bytes, size = 20) → Uint8Array[]`
- Produces: `detectEnvironment(nav = globalThis.navigator, win = globalThis) → { userAgent, webBluetooth, bluefy, standalone, secure }`
- Produces: `class BleTransport { constructor({ bluetooth = navigator.bluetooth, logger, chunkSize = 20 }); connect({ acceptAll = false } = {}) → { name }; disconnect(); write(bytes); onData(cb); onDisconnect(cb); connected; name; static async knownDevices(bluetooth) → BluetoothDevice[] }`
- 行為：`connect` 先 `requestDevice({ filters: [{ services: [SERVICE_UUID] }], optionalServices: [SERVICE_UUID] })`；`acceptAll` 為 true 時改用 `{ acceptAllDevices: true, optionalServices: [SERVICE_UUID] }`。取得 service 與兩個 characteristic，`startNotifications`，`characteristicvaluechanged` → `onData(new Uint8Array(ev.target.value.buffer, byteOffset, byteLength))`。`gattserverdisconnected` → 觸發 onDisconnect。`write` 依 chunk 逐段 `await`：characteristic.properties.write 為真用 `writeValueWithResponse`（不存在則 `writeValue`），否則 `writeValueWithoutResponse`。

- [ ] **Step 1: 寫測試**

`test/ble.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunk, detectEnvironment, uuid16, SERVICE_UUID, WRITE_UUID, NOTIFY_UUID } from '../js/transport/ble.js';

test('uuid constants', () => {
  assert.equal(uuid16(0xae00), '0000ae00-0000-1000-8000-00805f9b34fb');
  assert.equal(SERVICE_UUID, uuid16(0xae00));
  assert.equal(WRITE_UUID, uuid16(0xae01));
  assert.equal(NOTIFY_UUID, uuid16(0xae02));
});

test('chunk splits into ≤20-byte pieces preserving order', () => {
  const bytes = Uint8Array.from({ length: 45 }, (_, i) => i);
  const parts = chunk(bytes);
  assert.deepEqual(parts.map((p) => p.length), [20, 20, 5]);
  assert.equal(parts[2][4], 44);
  assert.deepEqual(chunk(new Uint8Array(0)), []);
});

test('detectEnvironment reads navigator and window safely', () => {
  const env = detectEnvironment(
    { userAgent: 'Mozilla/5.0 (iPhone) Bluefy/3.9', bluetooth: {} },
    { isSecureContext: true, matchMedia: () => ({ matches: true }) },
  );
  assert.deepEqual(env, { userAgent: 'Mozilla/5.0 (iPhone) Bluefy/3.9', webBluetooth: true, bluefy: true, standalone: true, secure: true });
  const none = detectEnvironment({ userAgent: 'x' }, {});
  assert.deepEqual(none, { userAgent: 'x', webBluetooth: false, bluefy: false, standalone: false, secure: false });
  assert.equal(detectEnvironment(undefined, undefined).userAgent, 'unknown');
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `node --test test/ble.test.js`
Expected: FAIL。

- [ ] **Step 3: 實作 ble.js**

```js
import { TransportError } from './transport.js';

export const uuid16 = (n) => `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
export const SERVICE_UUID = uuid16(0xae00);
export const WRITE_UUID = uuid16(0xae01);
export const NOTIFY_UUID = uuid16(0xae02);

export function chunk(bytes, size = 20) {
  const out = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
  return out;
}

export function detectEnvironment(nav = globalThis.navigator, win = globalThis) {
  const userAgent = nav?.userAgent ?? 'unknown';
  let standalone = false;
  try { standalone = Boolean(nav?.standalone) || Boolean(win?.matchMedia?.('(display-mode: standalone)')?.matches); } catch { standalone = false; }
  return {
    userAgent,
    webBluetooth: Boolean(nav?.bluetooth),
    bluefy: /bluefy/i.test(userAgent),
    standalone,
    secure: Boolean(win?.isSecureContext),
  };
}

export class BleTransport {
  constructor({ bluetooth = globalThis.navigator?.bluetooth, logger, chunkSize = 20 } = {}) {
    this.bluetooth = bluetooth;
    this.log = logger;
    this.chunkSize = chunkSize;
    this.device = null;
    this.writeChar = null;
    this.notifyChar = null;
    this.connected = false;
    this.name = '';
    this.dataCbs = [];
    this.disconnectCbs = [];
    this.onValue = (ev) => {
      const v = ev.target.value;
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();
      for (const cb of this.dataCbs) cb(bytes);
    };
    this.onGattLost = () => { this.connected = false; this.log?.warn('GATT 斷線事件'); for (const cb of this.disconnectCbs) cb(); };
  }

  static async knownDevices(bluetooth = globalThis.navigator?.bluetooth) {
    if (!bluetooth?.getDevices) return [];
    try { return await bluetooth.getDevices(); } catch { return []; }
  }

  onData(cb) { this.dataCbs.push(cb); }
  onDisconnect(cb) { this.disconnectCbs.push(cb); }

  async connect({ acceptAll = false, device = null } = {}) {
    if (!this.bluetooth) throw new TransportError('此瀏覽器不支援 Web Bluetooth', 'UNSUPPORTED');
    const options = acceptAll
      ? { acceptAllDevices: true, optionalServices: [SERVICE_UUID] }
      : { filters: [{ services: [SERVICE_UUID] }], optionalServices: [SERVICE_UUID] };
    this.log?.info(`requestDevice ${acceptAll ? '（接受所有裝置）' : '（過濾 service ae00）'}`);
    this.device = device ?? await this.bluetooth.requestDevice(options);
    this.name = this.device.name || this.device.id || '(未命名)';
    this.log?.info(`選擇裝置：${this.name}`);
    this.device.addEventListener('gattserverdisconnected', this.onGattLost);
    const server = await this.device.gatt.connect();
    this.log?.info('GATT 已連線，尋找 service ae00');
    const service = await server.getPrimaryService(SERVICE_UUID);
    this.writeChar = await service.getCharacteristic(WRITE_UUID);
    this.notifyChar = await service.getCharacteristic(NOTIFY_UUID);
    const p = this.writeChar.properties;
    this.log?.info(`characteristic ae01 write=${p.write} writeWithoutResponse=${p.writeWithoutResponse}；ae02 notify=${this.notifyChar.properties.notify}`);
    await this.notifyChar.startNotifications();
    this.notifyChar.addEventListener('characteristicvaluechanged', this.onValue);
    this.connected = true;
    return { name: this.name };
  }

  async disconnect() {
    const dev = this.device;
    this.connected = false;
    if (this.notifyChar) { try { this.notifyChar.removeEventListener('characteristicvaluechanged', this.onValue); } catch { /* ignore */ } }
    if (dev) {
      dev.removeEventListener('gattserverdisconnected', this.onGattLost);
      if (dev.gatt?.connected) { try { dev.gatt.disconnect(); } catch { /* ignore */ } }
    }
    this.device = null; this.writeChar = null; this.notifyChar = null;
  }

  async write(bytes) {
    if (!this.connected || !this.writeChar) throw new TransportError('not connected', 'NOT_CONNECTED');
    const c = this.writeChar;
    const useResponse = c.properties.write || !c.properties.writeWithoutResponse;
    for (const part of chunk(bytes, this.chunkSize)) {
      if (useResponse) { if (c.writeValueWithResponse) await c.writeValueWithResponse(part); else await c.writeValue(part); }
      else await c.writeValueWithoutResponse(part);
    }
  }
}
```

- [ ] **Step 4: 執行確認通過**

Run: `node --test test/ble.test.js`
Expected: 全部 pass。

- [ ] **Step 5: Commit**

```bash
git add js/transport/ble.js test/ble.test.js
git commit -m "feat(transport): Web Bluetooth transport with chunked writes and environment detection"
```

---

### Task 14: UI 外殼（index.html、app.css、app.js、statusbar.js、dialog.js）

**Files:**
- Create: `index.html`, `css/app.css`, `js/ui/app.js`, `js/ui/statusbar.js`, `js/ui/components/dialog.js`, 以及五個分頁的最小 `init` 骨架 `js/ui/pages/{bluetooth,sound,eq,modes,log}.js`（每個先只渲染標題，後續 Task 填內容）

**Interfaces:**
- Produces: `ctx = { device, store, logger, storage, env, events: EventTarget, transportKind: 'sim'|'ble' }`
- Produces: 每個 page module `export function init(ctx, rootEl)`
- Produces（dialog.js）: `confirmDialog(message, { okText = '確定', cancelText = '取消' } = {}) → Promise<boolean>`、`toast(message, ms = 2500)`
- Produces（statusbar.js）: `init(ctx, el)` 顯示連線狀態、模式、輸入源
- app.js 行為：解析 `location.search`，`sim=1` 時 transport 為 `FakeDevice({ latencyMs: 5 })`，否則 `BleTransport({ logger })`；建立 Logger、RegisterStore、Storage、Device；啟動 LogPersister；`logger.info` 記錄環境資訊；分頁切換用 `data-page` 屬性與 `hidden`；註冊 `./sw.js`（若 `navigator.serviceWorker` 存在），監聽 SW 的 `message` 事件把 `{type:'cached', version}` 轉成 `events` 的 `sw-cached`，`updatefound` 轉成 `sw-update`；呼叫 `navigator.storage?.persist?.()`；`device.on('snapshot')` → `storage.put('snapshots', String(ts), snapshot)`。

- [ ] **Step 1: index.html**

```html
<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#101418">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <title>DSP-X8s 調音</title>
  <link rel="manifest" href="./manifest.webmanifest">
  <link rel="icon" href="./icons/icon-192.png">
  <link rel="apple-touch-icon" href="./icons/icon-192.png">
  <link rel="stylesheet" href="./css/app.css">
</head>
<body>
  <header id="statusbar" class="statusbar"></header>
  <main id="pages">
    <section id="page-bluetooth" data-page="bluetooth" class="page"></section>
    <section id="page-sound" data-page="sound" class="page" hidden></section>
    <section id="page-eq" data-page="eq" class="page" hidden></section>
    <section id="page-modes" data-page="modes" class="page" hidden></section>
    <section id="page-log" data-page="log" class="page" hidden></section>
  </main>
  <nav id="tabs" class="tabs">
    <button data-tab="bluetooth" class="active">藍牙</button>
    <button data-tab="sound">聲音</button>
    <button data-tab="eq">EQ</button>
    <button data-tab="modes">模式</button>
    <button data-tab="log">日誌</button>
  </nav>
  <div id="toast" class="toast" hidden></div>
  <dialog id="confirm">
    <form method="dialog">
      <p id="confirm-text"></p>
      <menu><button value="cancel" id="confirm-cancel">取消</button><button value="ok" id="confirm-ok" class="primary">確定</button></menu>
    </form>
  </dialog>
  <script type="module" src="./js/ui/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: css/app.css**

```css
:root { --bg: #101418; --panel: #1a2027; --line: #2b343e; --fg: #e6edf3; --muted: #8b98a5; --accent: #29b6f6; --ok: #4caf50; --warn: #ffb300; --err: #ef5350; --font: system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans TC", sans-serif; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); font: 15px/1.45 var(--font); }
body { display: flex; flex-direction: column; min-height: 100dvh; }
.statusbar { position: sticky; top: 0; z-index: 2; display: flex; gap: 12px; align-items: center; padding: 10px 16px; background: var(--panel); border-bottom: 1px solid var(--line); font-size: 13px; padding-top: calc(10px + env(safe-area-inset-top)); }
.statusbar .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--muted); }
.statusbar .dot.connected { background: var(--ok); } .statusbar .dot.readonly { background: var(--warn); } .statusbar .dot.connecting { background: var(--accent); }
main { flex: 1; padding: 16px; padding-bottom: 96px; max-width: 900px; width: 100%; margin: 0 auto; }
.page h2 { margin: 0 0 12px; font-size: 18px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px; margin-bottom: 14px; }
.card h3 { margin: 0 0 10px; font-size: 15px; color: var(--muted); font-weight: 600; }
.row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.row.between { justify-content: space-between; }
button, select, input[type="number"] { font: inherit; color: var(--fg); background: #232c36; border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; min-height: 44px; }
button { cursor: pointer; } button:disabled { opacity: .45; cursor: default; }
button.primary { background: var(--accent); color: #04121a; border-color: transparent; font-weight: 600; }
button.danger { background: var(--err); color: #fff; border-color: transparent; }
input[type="range"] { width: 100%; min-height: 44px; }
.muted { color: var(--muted); } .ok { color: var(--ok); } .warn { color: var(--warn); } .err { color: var(--err); }
.mono { font-family: ui-monospace, Consolas, Menlo, monospace; font-size: 12.5px; }
progress { width: 100%; height: 10px; }
.tabs { position: fixed; bottom: 0; left: 0; right: 0; display: grid; grid-template-columns: repeat(5, 1fr); background: var(--panel); border-top: 1px solid var(--line); padding-bottom: env(safe-area-inset-bottom); }
.tabs button { border: 0; border-radius: 0; background: transparent; color: var(--muted); padding: 12px 0; min-height: 56px; }
.tabs button.active { color: var(--accent); font-weight: 600; }
.toast { position: fixed; left: 50%; bottom: 80px; transform: translateX(-50%); background: #000c; color: #fff; padding: 10px 16px; border-radius: 10px; z-index: 5; max-width: 90vw; }
dialog { background: var(--panel); color: var(--fg); border: 1px solid var(--line); border-radius: 12px; max-width: 90vw; }
dialog::backdrop { background: #0009; } dialog menu { display: flex; gap: 10px; justify-content: flex-end; padding: 0; margin: 12px 0 0; }
table.regs { width: 100%; border-collapse: collapse; } table.regs td, table.regs th { padding: 4px 6px; border-bottom: 1px solid var(--line); text-align: left; }
tr.status-2 td { color: var(--accent); } tr.status-3 td { color: var(--err); } tr.status-0 td { color: var(--muted); }
.log { height: 60vh; overflow: auto; background: #0b0f13; border: 1px solid var(--line); border-radius: 10px; padding: 8px; white-space: pre; }
.log .l-WARN { color: var(--warn); } .log .l-ERR { color: var(--err); } .log .l-TX { color: #7fd1ff; } .log .l-RX { color: #b5f5a8; } .log .l-REPORT { color: #ffd54f; }
.banner { background: #263238; border: 1px solid var(--accent); border-radius: 10px; padding: 10px 14px; margin-bottom: 14px; }
.modes { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; } .modes button.active { outline: 2px solid var(--accent); }
textarea.copyfallback { width: 100%; height: 40vh; font-family: ui-monospace, monospace; font-size: 12px; background: #0b0f13; color: var(--fg); border: 1px solid var(--line); border-radius: 8px; }
```

- [ ] **Step 3: dialog.js**

```js
export function toast(message, ms = 2500) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message; el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, ms);
}

export function confirmDialog(message, { okText = '確定', cancelText = '取消' } = {}) {
  const dlg = document.getElementById('confirm');
  if (!dlg?.showModal) return Promise.resolve(window.confirm(message));
  document.getElementById('confirm-text').textContent = message;
  document.getElementById('confirm-ok').textContent = okText;
  document.getElementById('confirm-cancel').textContent = cancelText;
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.showModal();
  });
}
```

- [ ] **Step 4: statusbar.js**

```js
import { STATE } from '../../core/device.js';
import { ADDR } from '../../protocol/addrmap.js';
import { INPUT_NAMES } from '../../protocol/tables.js';

const STATE_TEXT = { [STATE.DISCONNECTED]: '未連線', [STATE.CONNECTING]: '連線中', [STATE.CONNECTED]: '已連線', [STATE.READONLY]: '唯讀（代碼不符）' };

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
```

- [ ] **Step 5: 五個分頁骨架**

每個檔案內容相同形狀，例如 `js/ui/pages/eq.js`：

```js
export function init(ctx, el) {
  el.innerHTML = `<h2>EQ</h2><div class="card"><p class="muted">第二階段實作：8 聲道各 31 段參數 EQ。第一階段請先在「藍牙」分頁完成整機讀取與寫入測試，並把「日誌」分頁的報告摘要回報。</p></div>`;
}
```

`bluetooth.js`、`sound.js`、`modes.js`、`log.js` 先各放 `<h2>` 標題（藍牙、聲音、模式、日誌）與一個空的 `<div class="card" id="…-body"></div>`，Task 15 到 17 會覆寫這些檔案。

- [ ] **Step 6: app.js**

```js
import { FakeDevice } from '../transport/fake-device.js';
import { BleTransport, detectEnvironment } from '../transport/ble.js';
import { Logger } from '../core/logger.js';
import { RegisterStore } from '../core/store.js';
import { Storage, LogPersister } from '../core/storage.js';
import { Device } from '../core/device.js';
import * as statusbar from './statusbar.js';
import * as bluetoothPage from './pages/bluetooth.js';
import * as soundPage from './pages/sound.js';
import * as eqPage from './pages/eq.js';
import * as modesPage from './pages/modes.js';
import * as logPage from './pages/log.js';

const PAGES = { bluetooth: bluetoothPage, sound: soundPage, eq: eqPage, modes: modesPage, log: logPage };

async function boot() {
  const params = new URLSearchParams(location.search);
  const transportKind = params.get('sim') === '1' ? 'sim' : 'ble';
  const logger = new Logger();
  const env = detectEnvironment();
  const transport = transportKind === 'sim' ? new FakeDevice({ latencyMs: 5 }) : new BleTransport({ logger });
  const store = new RegisterStore();
  const storage = await Storage.open();
  const device = new Device({ transport, store, logger });
  const events = new EventTarget();
  const ctx = { device, store, logger, storage, env, events, transportKind };

  logger.info(`啟動 ${transportKind === 'sim' ? '（模擬機器）' : ''} 版本 ${document.documentElement.dataset.version ?? 'dev'}`);
  logger.info(`瀏覽器: ${env.userAgent}`);
  logger.info(`WebBluetooth=${env.webBluetooth} Bluefy=${env.bluefy} 安裝模式=${env.standalone} HTTPS=${env.secure} 儲存=${storage.backend}`);

  const persister = new LogPersister(logger, storage);
  persister.start();
  window.addEventListener('pagehide', () => persister.flush());

  device.on('snapshot', (snap) => { storage.put('snapshots', String(snap.ts), snap).catch(() => {}); });
  device.on('error', (err) => logger.error(`裝置錯誤：${err.message}`));

  statusbar.init(ctx, document.getElementById('statusbar'));
  for (const [name, mod] of Object.entries(PAGES)) mod.init(ctx, document.getElementById(`page-${name}`));

  const tabs = document.querySelectorAll('#tabs button');
  const show = (name) => {
    document.querySelectorAll('.page').forEach((p) => { p.hidden = p.dataset.page !== name; });
    tabs.forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    try { localStorage.setItem('tab', name); } catch { /* ignore */ }
    ctx.events.dispatchEvent(new CustomEvent('tab', { detail: name }));
  };
  tabs.forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
  let initial = 'bluetooth';
  try { initial = localStorage.getItem('tab') || initial; } catch { /* ignore */ }
  show(PAGES[initial] ? initial : 'bluetooth');

  try { const persisted = await navigator.storage?.persist?.(); if (persisted !== undefined) logger.info(`持久儲存: ${persisted}`); } catch { /* ignore */ }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (ev) => {
      if (ev.data?.type === 'cached') { logger.info(`離線快取完成，版本 ${ev.data.version}`); events.dispatchEvent(new CustomEvent('sw-cached', { detail: ev.data })); }
    });
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) events.dispatchEvent(new CustomEvent('sw-update', { detail: reg })); });
      });
      if (reg.active && !reg.installing) events.dispatchEvent(new CustomEvent('sw-cached', { detail: { version: 'active', fromRegistration: true } }));
    } catch (err) { logger.warn(`Service Worker 註冊失敗：${err.message}`); }
  } else {
    logger.warn('此環境沒有 Service Worker，無法離線使用');
  }
  window.dspx = ctx; // 供開發者在 console 檢查
}

boot().catch((err) => { console.error(err); document.body.insertAdjacentHTML('afterbegin', `<pre class="err" style="padding:16px">啟動失敗：${err.message}</pre>`); });
```

- [ ] **Step 7: 手動驗證**

Run: `npm run serve`，用 Chrome 開 `http://localhost:8080/?sim=1`。
Expected: 看到狀態列、五個分頁可切換、日誌分頁有標題；console 無紅字（SW 檔案還不存在會出現 404 警告，Task 18 補上）。

無頭檢查（可選）：
```bash
"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --disable-gpu --virtual-time-budget=3000 --dump-dom "http://localhost:8080/?sim=1" | grep -c "data-page"
```
Expected: `5`

- [ ] **Step 8: Commit**

```bash
git add index.html css/app.css js/ui
git commit -m "feat(ui): app shell, tabs, statusbar, dialogs, page skeletons"
```

---

### Task 15: 藍牙分頁與暫存器表（bluetooth.js、regtable.js）

**Files:**
- Create: `js/ui/components/regtable.js`
- Modify: `js/ui/pages/bluetooth.js`（覆寫骨架）

**Interfaces:**
- Consumes: `ctx`、`Device` 的 `connect/disconnect/dump/writeTest`、事件 `state/progress/dump/snapshot`、`buildReport`、`STATUS`、`describeAddr`
- Produces（regtable.js）: `renderRegTable(ctx, el)`：範圍輸入（起、迄）、名稱搜尋框、表格欄位「位址、名稱、十進位、十六進位、狀態」，訂閱 store 更新。
- 藍牙分頁區塊：
  1. 離線指示 `#offline-status`：預設「尚未可離線使用」；收到 `sw-cached` 改為「已可離線使用，版本 N」（綠）；收到 `sw-update` 顯示「有新版本，重新載入」按鈕（`reg.waiting?.postMessage({type:'skipWaiting'})` 後 `location.reload()`）。
  2. 連線卡：狀態文字、「連線」「斷線」按鈕、勾選框「找不到裝置時接受所有裝置」（傳給 `transport.connect({ acceptAll })`，FakeDevice 忽略）、裝置名稱、客戶代碼。`connect` 失敗顯示 toast 與 logger.error。
  3. 整機讀取卡：`<progress>`、文字「n / 17」、「重新讀取」按鈕（呼叫 `device.dump()` 並鎖按鈕）。
  4. 備份卡：「匯出目前暫存器 JSON」（`{ exportedAt, device: info, dumpInfo, mode: store.get(M0_MODE), values }` 以 Blob 下載，檔名 `dspx8s-<ISO時間>.json`）；快照列表：由 `storage.getAll('snapshots')` 列出時間，每筆有「匯出」「刪除」；`device.on('snapshot')` 後重新列出。
  5. 寫入測試卡：選聲道 1..8（預設 1）、頻段 1..32（預設 3）、增益選項 +6 / +3 / 0 / −3 / −6（預設 +6），「執行寫入測試」按鈕；只在 `device.canWrite` 時可按；結果顯示一行文字並呼叫 `logger.report(buildReport({ env: ctx.env, info: device.info, dumpInfo: device.dumpInfo, store: ctx.store, writeTest: result }))`，之後 toast「已產生報告摘要，請到日誌分頁複製」。另有「還原為 0 dB」按鈕把同一段寫回 500。
  6. `device.on('dump')` 完成時也自動 `logger.report(buildReport({...}))`（無 writeTest）。
  7. 進階卡：`<details>` 內放 regtable。

- [ ] **Step 1: regtable.js**

```js
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
  ctx.store.subscribe(() => { if (!scheduled) { scheduled = true; requestAnimationFrame(() => { scheduled = false; if (!el.closest('details') || el.closest('details').open) render(); }); } });
  render();
}
```

- [ ] **Step 2: bluetooth.js**

```js
import { STATE } from '../../core/device.js';
import { buildReport } from '../../core/report.js';
import { ADDR } from '../../protocol/addrmap.js';
import { toast, confirmDialog } from '../components/dialog.js';
import { renderRegTable } from '../components/regtable.js';

function download(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function init(ctx, el) {
  const { device, store, logger, storage, env } = ctx;
  el.innerHTML = `
    <h2>藍牙</h2>
    <div class="banner" id="offline-status">尚未可離線使用（等待快取完成）</div>
    ${env.webBluetooth || ctx.transportKind === 'sim' ? '' : '<div class="banner warn">此瀏覽器不支援 Web Bluetooth。Android 請用 Chrome 或 Edge，iPhone 請安裝 Bluefy 瀏覽器開啟本頁。</div>'}
    <div class="card"><h3>連線</h3>
      <div class="row"><button id="bt-connect" class="primary">連線</button><button id="bt-disconnect" disabled>斷線</button>
        <label><input type="checkbox" id="bt-acceptall"> 找不到裝置時接受所有裝置</label></div>
      <p id="bt-status" class="muted">未連線</p></div>
    <div class="card"><h3>整機讀取</h3>
      <progress id="bt-progress" max="17" value="0"></progress>
      <div class="row between"><span id="bt-progress-text" class="muted">尚未讀取</span><button id="bt-redump" disabled>重新讀取</button></div></div>
    <div class="card"><h3>備份</h3>
      <div class="row"><button id="bt-export" disabled>匯出目前暫存器 JSON</button></div>
      <h3 style="margin-top:12px">還原點（自動快照）</h3><div id="bt-snaps" class="muted">沒有快照</div></div>
    <div class="card"><h3>寫入測試（第一階段）</h3>
      <p class="muted">音量先調低。對單一頻段寫入增益後讀回比對，結果會產生報告摘要到日誌分頁。</p>
      <div class="row">
        <label>聲道 <select id="wt-ch">${Array.from({ length: 8 }, (_, i) => `<option value="${i + 1}"${i === 0 ? ' selected' : ''}>CH${i + 1}</option>`).join('')}</select></label>
        <label>頻段 <select id="wt-band">${Array.from({ length: 32 }, (_, i) => `<option value="${i + 1}"${i === 2 ? ' selected' : ''}>${i + 1}</option>`).join('')}</select></label>
        <label>增益 <select id="wt-db"><option value="6" selected>+6 dB</option><option value="3">+3 dB</option><option value="0">0 dB</option><option value="-3">−3 dB</option><option value="-6">−6 dB</option></select></label>
      </div>
      <div class="row" style="margin-top:8px"><button id="wt-run" class="primary" disabled>執行寫入測試</button><button id="wt-reset" disabled>還原為 0 dB</button></div>
      <p id="wt-result" class="mono"></p></div>
    <div class="card"><details><summary>進階：原始暫存器</summary><div id="bt-regtable" style="margin-top:10px"></div></details></div>`;

  const $ = (id) => el.querySelector(id);
  const offline = $('#offline-status');
  ctx.events.addEventListener('sw-cached', (ev) => { offline.textContent = `已可離線使用，版本 ${ev.detail.version}`; offline.classList.add('ok'); });
  ctx.events.addEventListener('sw-update', (ev) => {
    offline.innerHTML = '有新版本 <button id="sw-reload" class="primary" style="margin-left:8px">重新載入</button>';
    offline.querySelector('#sw-reload').addEventListener('click', () => { ev.detail.waiting?.postMessage({ type: 'skipWaiting' }); setTimeout(() => location.reload(), 300); });
  });

  const renderState = () => {
    const s = device.state;
    $('#bt-connect').disabled = s !== STATE.DISCONNECTED;
    $('#bt-disconnect').disabled = s === STATE.DISCONNECTED;
    const live = s === STATE.CONNECTED || s === STATE.READONLY;
    $('#bt-redump').disabled = !live; $('#bt-export').disabled = store.confirmedCount() === 0;
    $('#wt-run').disabled = !device.canWrite; $('#wt-reset').disabled = !device.canWrite;
    $('#bt-status').textContent = s === STATE.DISCONNECTED ? '未連線' : s === STATE.CONNECTING ? '連線中…' : `${s === STATE.READONLY ? '唯讀模式（客戶代碼不符）' : '已連線'}：${device.info.name}，客戶代碼 ${device.info.customerId ?? '-'}`;
    $('#bt-status').className = s === STATE.READONLY ? 'warn' : s === STATE.CONNECTED ? 'ok' : 'muted';
  };
  device.on('state', renderState);
  device.on('progress', ({ done, total }) => { $('#bt-progress').max = total; $('#bt-progress').value = done; $('#bt-progress-text').textContent = `${done} / ${total}`; });
  device.on('dump', (info) => {
    $('#bt-progress-text').textContent = `${info.complete ? '完成' : '不完整'}，${info.ms} ms，${info.method}${info.failedSegments.length ? '，失敗區段 ' + info.failedSegments.join(',') : ''}`;
    renderState();
    logger.report(buildReport({ env, info: device.info, dumpInfo: info, store }));
  });

  $('#bt-connect').addEventListener('click', async () => {
    try {
      const origConnect = device.transport.connect.bind(device.transport);
      device.transport.connect = () => origConnect({ acceptAll: $('#bt-acceptall').checked });
      await device.connect();
      device.transport.connect = origConnect;
    } catch (err) { toast(`連線失敗：${err.message}`); }
  });
  $('#bt-disconnect').addEventListener('click', () => device.disconnect());
  $('#bt-redump').addEventListener('click', async (e) => { e.target.disabled = true; try { await device.dump(); } catch (err) { toast(err.message); } finally { renderState(); } });

  $('#bt-export').addEventListener('click', () => {
    const payload = { exportedAt: new Date().toISOString(), device: device.info, dumpInfo: device.dumpInfo, mode: store.get(ADDR.M0_MODE), values: Array.from(store.values) };
    download(`dspx8s-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, JSON.stringify(payload, null, 1));
  });

  const renderSnaps = async () => {
    const list = (await storage.getAll('snapshots')).sort((a, b) => b.value.ts - a.value.ts).slice(0, 20);
    $('#bt-snaps').innerHTML = list.length ? list.map(({ key, value }) => `<div class="row between" style="padding:6px 0;border-bottom:1px solid var(--line)"><span>${new Date(value.ts).toLocaleString()}</span><span><button data-exp="${key}">匯出</button> <button data-del="${key}" class="danger">刪除</button></span></div>`).join('') : '沒有快照';
    $('#bt-snaps').querySelectorAll('[data-exp]').forEach((b) => b.addEventListener('click', async () => { const v = await storage.get('snapshots', b.dataset.exp); download(`dspx8s-snapshot-${b.dataset.exp}.json`, JSON.stringify(v)); }));
    $('#bt-snaps').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => { if (await confirmDialog('刪除這個快照？')) { await storage.delete('snapshots', b.dataset.del); renderSnaps(); } }));
  };
  device.on('snapshot', () => setTimeout(renderSnaps, 100));
  renderSnaps();

  const runTest = async (dbOverride) => {
    const ch = Number($('#wt-ch').value), band = Number($('#wt-band').value), db = dbOverride ?? Number($('#wt-db').value);
    $('#wt-run').disabled = true; $('#wt-reset').disabled = true;
    try {
      const r = await device.writeTest(ch, band, db);
      $('#wt-result').textContent = `${r.name}: ${r.before} → ${r.sent} → 讀回 ${r.readBack} ${r.ok ? '一致' : '不符'} (${r.ms} ms)`;
      $('#wt-result').className = `mono ${r.ok ? 'ok' : 'err'}`;
      logger.report(buildReport({ env, info: device.info, dumpInfo: device.dumpInfo, store, writeTest: r }));
      toast('已產生報告摘要，請到日誌分頁複製');
    } catch (err) { $('#wt-result').textContent = `失敗：${err.message}`; $('#wt-result').className = 'mono err'; }
    finally { renderState(); }
  };
  $('#wt-run').addEventListener('click', () => runTest());
  $('#wt-reset').addEventListener('click', () => runTest(0));

  renderRegTable(ctx, $('#bt-regtable'));
  store.subscribe(() => { $('#bt-export').disabled = store.confirmedCount() === 0; });
  renderState();
}
```

註：連線時的 `acceptAll` 以暫時包裝 `transport.connect` 傳入，因為 `Device.connect()` 不帶參數。

- [ ] **Step 3: 手動驗證**

Run: `npm run serve`，開 `http://localhost:8080/?sim=1`。
Expected：按「連線」→ 進度條跑到 17/17 → 狀態「已連線：DSP-X8s-SIM，客戶代碼 4006」→ 快照列表出現一筆 → 「執行寫入測試」顯示 `CH1 EQ3 G: 500 → 560 → 讀回 560 一致` → 進階表格 138 到 177 顯示 CH1 值。

- [ ] **Step 4: Commit**

```bash
git add js/ui/pages/bluetooth.js js/ui/components/regtable.js
git commit -m "feat(ui): bluetooth page with dump progress, backups, write test and register table"
```

---

### Task 16: 日誌分頁（log.js）

**Files:**
- Modify: `js/ui/pages/log.js`

**Interfaces:**
- Consumes: `ctx.logger`（entries、subscribe、toText、lastReport、clear、restore）、`LogPersister.loadLast(ctx.storage)`
- 行為：工具列按鈕「複製全部」「複製報告摘要」「分享」「匯出 .txt」「清除」「載入上次日誌」、篩選 select（全部 / 重點 / 只看封包）、勾選「自動捲動」。日誌區 `<div class="log">`，每行一個 `<div class="l-LEVEL">`，DOM 最多保留最後 2000 行。複製：`navigator.clipboard.writeText` 成功 toast「已複製」；失敗則顯示 `<textarea class="copyfallback">` 並全選，提示長按複製。分享：`navigator.share` 可用時先嘗試 `files: [new File([text], 'dspx8s-log.txt', {type:'text/plain'})]`（若 `navigator.canShare` 支援），否則 `share({ text })`。

- [ ] **Step 1: log.js**

```js
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
```

- [ ] **Step 2: 手動驗證**

Run: `npm run serve`，開 `?sim=1`，連線並執行寫入測試後切到日誌分頁。
Expected：看到 TX/RX 行（藍、綠）、報告摘要（黃）；「複製報告摘要」在 localhost 的 Chrome 可成功；篩選「只看封包」只剩 TX/RX；「匯出 .txt」下載檔案。

- [ ] **Step 3: Commit**

```bash
git add js/ui/pages/log.js
git commit -m "feat(ui): log page with filters, copy, share, export and restore"
```

---

### Task 17: 聲音分頁（主音量、聲道辨識）與模式分頁（顯示）

**Files:**
- Modify: `js/ui/pages/sound.js`, `js/ui/pages/modes.js`

**Interfaces:**
- Consumes: `device.writeRegs`、`device.canWrite`、`store`、`ADDR`、`encodeMasterVol/decodeMasterVol`、`DEFAULT_CHANNEL_NAMES`
- sound.js 行為：主音量滑桿 0..60，`input` 事件節流 50 ms 呼叫 `device.writeRegs(8 × { addr: ADDR.mix11(k), val: encodeMasterVol(v) })`；store 更新時若非拖曳中則把滑桿設為 `decodeMasterVol(store.get(ADDR.mix11(1)))`。聲道辨識區：8 列，每列名稱（DEFAULT_CHANNEL_NAMES，可編輯並存 `storage.put('settings','channelNames',[...])`）與「靜音」切換按鈕，寫 `ADDR.muteOfChannel(k)` 為 1/0；按鈕狀態依 store。第一階段的其他聲音功能（相位、延時、輸入源）留在第二階段，頁面上註明。
- modes.js 行為：8 個按鈕，`store.get(ADDR.M0_MODE)` 對應者加 `active`；點擊顯示 toast「模式切換與儲存在第二階段開放」；下方顯示「目前模式 N」。

- [ ] **Step 1: sound.js**

```js
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
  storage.get('settings', 'channelNames').then((n) => { if (Array.isArray(n) && n.length === CH_COUNT) { names = n; renderChannels(); } });
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
```

- [ ] **Step 2: modes.js**

```js
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
```

- [ ] **Step 3: 手動驗證**

Run: `?sim=1` 連線後到「聲音」分頁。
Expected：主音量顯示 30（模擬機預設 570），拖到 45 後在進階表格看到 MIX11_1..8 = 585；按 CH1 靜音變紅色「已靜音」，MUTE_2 = 1；「模式」分頁模式 1 高亮。

- [ ] **Step 4: Commit**

```bash
git add js/ui/pages/sound.js js/ui/pages/modes.js
git commit -m "feat(ui): master volume, channel mute identification, mode display"
```

---

### Task 18: PWA（manifest、Service Worker、圖示）

**Files:**
- Create: `manifest.webmanifest`, `sw.js`, `tools/make-icons.mjs`, `icons/icon-192.png`, `icons/icon-512.png`
- Modify: `index.html`（`<html data-version="…">`）

**Interfaces:**
- sw.js：`VERSION` 字串常數（例如 `'0.1.0'`），`PRECACHE` 為所有靜態檔案的相對路徑清單；install → `cache.addAll` → 對所有 clients `postMessage({ type: 'cached', version: VERSION })`；activate → 刪除非本版快取並 `clients.claim()`；fetch → 同源 GET 用快取優先、無快取則網路並寫入快取；`message` `{type:'skipWaiting'}` → `self.skipWaiting()`。
- make-icons.mjs：不依賴任何套件，用 `node:zlib` 的 `deflateSync` 自行寫 PNG（IHDR、IDAT、IEND，CRC32 自行計算），畫深色圓角方塊與五條白色 EQ 長條。

- [ ] **Step 1: manifest.webmanifest**

```json
{
  "name": "DSP-X8s 調音",
  "short_name": "DSP 調音",
  "description": "Yiye lang DSP-X8s 車用 DSP 的藍牙調音工具",
  "start_url": "./",
  "scope": "./",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#101418",
  "theme_color": "#101418",
  "lang": "zh-Hant",
  "icons": [
    { "src": "./icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any maskable" },
    { "src": "./icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
  ]
}
```

- [ ] **Step 2: tools/make-icons.mjs**

```js
import { deflateSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xFFFFFFFF; for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function png(size, paint) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = paint(x / size, y / size);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const BARS = [0.35, 0.6, 0.85, 0.5, 0.7]; // relative heights
function paint(u, v) {
  // rounded dark square background
  const cx = Math.max(Math.abs(u - 0.5) - 0.38, 0), cy = Math.max(Math.abs(v - 0.5) - 0.38, 0);
  if (Math.hypot(cx, cy) > 0.12) return [0, 0, 0, 0];
  let color = [16, 20, 24, 255];
  const i = Math.floor((u - 0.2) / 0.6 * BARS.length);
  if (i >= 0 && i < BARS.length) {
    const bx = 0.2 + (i + 0.5) * (0.6 / BARS.length);
    if (Math.abs(u - bx) < 0.045 && v > 0.8 - BARS[i] * 0.6 && v < 0.8) color = [41, 182, 246, 255];
  }
  return color;
}

const dir = fileURLToPath(new URL('../icons/', import.meta.url));
await mkdir(dir, { recursive: true });
for (const size of [192, 512]) await writeFile(`${dir}icon-${size}.png`, png(size, paint));
console.log('icons written');
```

- [ ] **Step 3: sw.js**

```js
const VERSION = '0.1.0';
const CACHE = `dspx8s-${VERSION}`;
const PRECACHE = [
  './', './index.html', './manifest.webmanifest', './css/app.css',
  './icons/icon-192.png', './icons/icon-512.png',
  './js/ui/app.js', './js/ui/statusbar.js', './js/ui/components/dialog.js', './js/ui/components/regtable.js',
  './js/ui/pages/bluetooth.js', './js/ui/pages/sound.js', './js/ui/pages/eq.js', './js/ui/pages/modes.js', './js/ui/pages/log.js',
  './js/core/logger.js', './js/core/store.js', './js/core/queue.js', './js/core/device.js', './js/core/report.js', './js/core/storage.js',
  './js/transport/transport.js', './js/transport/ble.js', './js/transport/fake-device.js',
  './js/protocol/crc16.js', './js/protocol/frame.js', './js/protocol/codec.js', './js/protocol/tables.js', './js/protocol/addrmap.js', './js/protocol/commands.js', './js/protocol/summary.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(PRECACHE);
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    for (const c of clients) c.postMessage({ type: 'cached', version: VERSION });
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
    const clients = await self.clients.matchAll();
    for (const c of clients) c.postMessage({ type: 'cached', version: VERSION });
  })());
});

self.addEventListener('message', (event) => { if (event.data?.type === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const fallback = await cache.match('./index.html');
      if (fallback && req.mode === 'navigate') return fallback;
      throw err;
    }
  })());
});
```

- [ ] **Step 4: 產生圖示、標記版本**

Run: `npm run icons`
Expected: `icons written`，`icons/` 有兩個 PNG，用圖片檢視器打開是深色方塊加五條藍色長條。

把 `index.html` 的 `<html lang="zh-Hant">` 改成 `<html lang="zh-Hant" data-version="0.1.0">`。

- [ ] **Step 5: 手動驗證離線**

Run: `npm run serve`，Chrome 開 `http://localhost:8080/?sim=1`，DevTools → Application → Service Workers 顯示 activated；藍牙分頁橫幅變成「已可離線使用，版本 0.1.0」。勾選 DevTools Network 的 Offline 後重新整理，頁面仍可載入且可連線模擬機。
Expected：以上皆成立。

- [ ] **Step 6: Commit**

```bash
git add manifest.webmanifest sw.js tools/make-icons.mjs icons index.html
git commit -m "feat(pwa): manifest, precaching service worker, generated icons"
```

---

### Task 19: README、部署說明、全套驗證

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README 內容**

```markdown
# DSP-X8s 網頁調音器

Yiye lang DSP-X8s 車用 DSP 的 Web Bluetooth 調音網頁（PWA）。規格：`docs/superpowers/specs/2026-09-29-dsp-x8s-web-tuner-design.md`。

## 需求

- Android：Chrome 或 Edge。iPhone：安裝 Bluefy 瀏覽器後用它開啟網址。
- 網址必須是 HTTPS（GitHub Pages、Netlify 皆可）。開發時 `http://localhost:8080` 可用。

## 開發

- `npm test`：Node 22 單元測試（協定、佇列、裝置流程全部用模擬機器測）。
- `npm run serve`：啟動本機伺服器。`http://localhost:8080/?sim=1` 用模擬機器，不需藍牙。
- `npm run tables`：從反編譯結果重新產生 `js/protocol/tables.js`。
- `npm run icons`：重新產生 PWA 圖示。
- 改版時把 `sw.js` 的 `VERSION` 與 `index.html` 的 `data-version` 一起改。

## 部署

GitHub Pages：把本目錄推到 repo 的 `main`，Settings → Pages → Source 選 `main` / root。網址為 `https://<帳號>.github.io/<repo>/`。

Netlify：到 app.netlify.com 的 Drop 頁把整個 `web` 資料夾拖進去，取得 `https://<名稱>.netlify.app`。

## 第一階段真機測試（回報用）

1. 有網路時開網址，等藍牙分頁顯示「已可離線使用」，Chrome 選單「安裝應用程式」。
2. 車上音量調低。按「連線」選擇 DSP 裝置，等整機讀取 17/17。
3. 寫入測試：CH1、頻段 3、+6 dB，按「執行寫入測試」，聽是否有變化，然後按「還原為 0 dB」。
4. 切到「日誌」分頁，按「複製報告摘要」，貼給開發者。複製失敗改用「分享」或「匯出 .txt」。
5. 若在 iPhone Bluefy：關閉網路後重開網頁，回報能否開啟。

## 安全

- 客戶代碼不是 4006 時自動唯讀。
- 只寫 F、G、Q 與規格列出的聲音暫存器，不寫濾波器 TYPE。
- 連線即自動快照，可在藍牙分頁匯出。第一階段沒有任何「儲存到模式」的操作。
```

- [ ] **Step 2: 全套測試與語法檢查**

Run: `npm test`
Expected: 全部 pass，0 fail。

Run: `for f in $(git ls-files 'js/**/*.js' 'sw.js' 'tools/*.mjs'); do node --check "$f" || echo "SYNTAX $f"; done`
Expected: 沒有任何 `SYNTAX` 輸出。

Run: `node -e "import('./sw.js').catch(()=>0)" 2>/dev/null; grep -o "'\./js/[^']*'" sw.js | tr -d "'" | while read p; do [ -f "$p" ] || echo "MISSING $p"; done`
Expected: 沒有 `MISSING`（PRECACHE 清單裡每個檔案都存在）。

- [ ] **Step 3: 無頭瀏覽器冒煙測試**

Run（伺服器需在跑）:
```bash
"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --disable-gpu --enable-logging=stderr --v=0 --virtual-time-budget=5000 --dump-dom "http://localhost:8080/?sim=1" 2>chrome.err | grep -c 'data-page'; grep -i -E "uncaught|error" chrome.err | grep -v "favicon" | head
```
Expected: 第一行 `5`；第二段沒有 Uncaught 錯誤。

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: usage, deployment and phase-1 device test instructions"
```

---

## 自我檢查紀錄

- 規格覆蓋：§5 協定 → Task 2 到 5；§6 連線流程 → Task 10、15；§7.1 藍牙分頁 → Task 15；§7.2 聲音分頁第一階段部分 → Task 17；§7.4 模式顯示 → Task 17；§7.5 日誌 → Task 6、11、12、16；§8 Store 與 Logger → Task 6、7；§9 錯誤處理 → Task 9、10、15；§10 PWA → Task 18；§11 測試 → 每個 Task；§13 第一階段交付 → 全部。§7.3 EQ 與 §7.2 其餘為第二階段，不在本計畫。
- 型別一致性：`Device.writeTest` 回傳 `{ addr, name, before, sent, readBack, ok, ms }` 與 `buildReport` 的 `writeTest` 參數一致；`Logger.formatEntry` 為 static，log.js 以 `Logger.formatEntry` 呼叫；`detectEnvironment` 回傳形狀與 `buildReport` 的 `env` 一致；`STATE` 由 device.js 匯出並在 statusbar.js、bluetooth.js 使用。
- Review Focus 五項各有測試：Task 2（0x80 在 DATA 內、CRC 跨 chunk）、Task 5（13 個值的區段）、Task 9（100 次合併）、Task 10（唯讀拒寫、區段失敗改一般讀取）。
