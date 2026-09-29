# DSP-X8s 網頁調音器

Yiye lang DSP-X8s 車用 DSP 的 Web Bluetooth 調音網頁（PWA）。規格：`docs/superpowers/specs/2026-09-29-dsp-x8s-web-tuner-design.md`，第一階段計畫：`docs/superpowers/plans/2026-09-30-dsp-x8s-phase1-implementation.md`。

## 需求

- Android：Chrome 或 Edge。iPhone：安裝 Bluefy 瀏覽器後用它開啟網址。
- 網址必須是 HTTPS（GitHub Pages、Netlify 皆可）。開發時 `http://localhost:8080` 可用。

## 開發

- `npm test`：Node 22 單元測試（協定、佇列、裝置流程全部用模擬機器測）。
- `npm run smoke`：用無頭 Chrome 開啟模擬機器版本，自動連線、整機讀取、寫入測試、主音量與靜音，檢查報告摘要與 console 錯誤。
- `npm run serve`：啟動本機伺服器。`http://localhost:8080/?sim=1` 用模擬機器，不需藍牙。
- `npm run tables`：從反編譯結果（`../src/data/utils/TabMainUtil.js`）重新產生 `js/protocol/tables.js`。
- `npm run icons`：重新產生 PWA 圖示。
- 改版時把 `sw.js` 的 `VERSION` 與 `index.html` 的 `data-version` 一起改，否則已安裝的手機不會更新快取。

## 部署

GitHub Pages：把本目錄推到 repo 的 `main`，Settings → Pages → Source 選 `main` / root。網址為 `https://<帳號>.github.io/<repo>/`。所有路徑都是相對的，放在子路徑下可正常運作。

Netlify：到 app.netlify.com 的 Drop 頁把整個 `web` 資料夾拖進去，取得 `https://<名稱>.netlify.app`。

## 第一階段真機測試（回報用）

1. 有網路時開網址，等藍牙分頁顯示「已可離線使用」，Chrome 選單「安裝應用程式」加到主畫面。
2. 車上音量調低。按「連線」選擇 DSP 裝置，等整機讀取 17 / 17。找不到裝置時勾「找不到裝置時接受所有裝置」再按一次。
3. 寫入測試：CH1、頻段 3、+6 dB，按「執行寫入測試」，聽是否有變化，然後按「還原為 0 dB」。
4. 切到「日誌」分頁，按「複製報告摘要」，貼給開發者。複製失敗改用「分享」或「匯出 .txt」。
5. 「聲音」分頁可逐一靜音 CH1 到 CH8，找出每個 CH 實際接到哪顆喇叭。
6. 若在 iPhone Bluefy：關閉網路後重開網頁，回報能否開啟。

## EQ 頁（0.2.0）

- 預設依車主配置分「前 CH1+CH2」「後 CH3+CH4」兩組連動；「進階」可切到單一聲道或全部 8 聲道。
- 兩層可選：「31 段（模式區）」是完整參數 EQ；「10 段（原廠層）」是原廠 App 用的那層，原廠已證明可透過藍牙寫入，當 31 段寫不進去時的備援。
- Q 換算：機器的 Q 原始值可能除以 3.17（原廠層確定如此，31 段層未確認）。「自動」依整機讀取結果推斷，推不出來時暫用 1 並以黃字提示，可手動指定。
- 曲線上的點可拖曳（上下改增益、左右改頻率）；下方可精確選頻率、Q、增益。每次變更 50 ms 內合併送出，停 300 ms 後讀回比對，不符標紅。
- 內建四組預設在 `presets/`，載入會覆寫前後兩組全部增益（先確認）。可存本地預設、匯出、匯入 JSON。
- 頻段顯示「未啟用」代表機器上該段 TYPE 或頻率為 0，程式不會寫它。

## 安全

- 客戶代碼不是 4006 時自動唯讀。
- 只寫 F、G、Q 與規格列出的聲音暫存器，程式層拒絕寫入任何濾波器 TYPE 欄位。
- 連線即自動快照，可在藍牙分頁匯出。第一階段沒有任何「儲存到模式」的操作。

## 目錄

```
js/protocol/   CRC、封包、編碼、位址表、指令（純函式，無瀏覽器相依）
js/transport/  Transport 介面、Web Bluetooth 實作、模擬機器
js/core/       佇列、暫存器快取、裝置流程、日誌、報告、本地保存
js/ui/         五個分頁與共用元件
tools/         開發伺服器、表格產生器、圖示產生器、無頭冒煙測試
test/          node:test 單元測試
```
