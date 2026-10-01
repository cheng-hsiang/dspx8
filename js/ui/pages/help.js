import { browserAdvice, shareUrl, BLUEFY_URL } from '../../help/advice.js';
import { buildIssueReport, CONTACT } from '../../help/issue-report.js';
import { shareText } from './log.js';
import { toast } from '../components/dialog.js';

export function init(ctx, el) {
  const { env, transportKind, logger, device } = ctx;
  const advice = browserAdvice(env, { sim: transportKind === 'sim' });
  const url = shareUrl();
  const open = (p) => (advice.platform === p ? ' open' : '');

  el.innerHTML = `
    <h2>使用說明</h2>
    <div class="banner ${advice.ok ? '' : 'warn'}" id="help-advice">
      <b>${advice.ok ? '✓' : '✗'}</b> ${advice.text}
      ${advice.platform === 'ios' && !advice.ok ? `<div style="margin-top:8px"><a class="btn" href="${BLUEFY_URL}" target="_blank" rel="noopener">到 App Store 安裝 Bluefy</a></div>` : ''}
    </div>

    <div class="card">
      <p style="margin:0 0 6px">這是用手機藍牙調 <b>DSP-X8s</b> 的網頁，不用安裝 App，功能比原廠小程序多：31 段 EQ、延時、相位、8 組模式。</p>
      <p class="muted" style="margin:0 0 10px">非官方工具，免費使用，風險自負。每次使用都需要網路。</p>
      <img id="help-photo" class="photo" src="./images/dsp-x8s.jpg" width="1200" height="911" loading="lazy" alt="Yiye lang DSP-X8s 機器外觀：黑色機身，正面有 8 個 CH-OUT 接孔和 PC USB 孔">
      <p class="muted" style="margin:6px 0 0">你的機器長這樣，就可以用這個網頁。</p>
    </div>

    <div class="card"><h3>三步開始</h3>
      <ol class="steps big">
        <li><b>音響先轉小聲。</b>車子通電，原廠的微信小程序要關掉。機器一次只能連一支手機。</li>
        <li><b>點上面的「藍牙」，按「連線」。</b>清單裡選 <b>Mango3.0</b>。不用先到手機的藍牙設定裡配對。</li>
        <li><b>等它讀完機器的設定</b>（約 5 秒，顯示「完成」）。之後到「EQ」或「聲音」就可以調了，一動就會生效。</li>
      </ol>
    </div>

    <div class="card"><h3>不會調？照這樣做</h3>
      <ol class="steps">
        <li>到「EQ」分頁，下面的「預設」選一個風格。內建十多組：流行、搖滾、電音、爵士、古典、人聲、重低音等。</li>
        <li>按「載入預設」，聽聽看。不喜歡就換一個。</li>
        <li>想自己改：在曲線上按住圓點上下拖，往上是加強，往下是減少。</li>
        <li>滿意後到「模式」分頁按「儲存」，留一份備份。</li>
      </ol>
      <p class="muted" style="margin:8px 0 0">調壞了也不用怕：預設選「平直（全部歸零）」再載入，就回到沒有 EQ 的狀態。</p>
    </div>

    <div class="card">
      <details${open('ios')}><summary>iPhone 怎麼用、有什麼限制</summary>
        <ul class="plain">
          <li>iPhone 上的 Safari、Chrome 都<b>不能</b>連藍牙，這是蘋果的限制。</li>
          <li>請到 App Store 安裝免費的 <a href="${BLUEFY_URL}" target="_blank" rel="noopener">Bluefy</a>，用 Bluefy 開這個網址。</li>
          <li>從 LINE 點連結會開在 LINE 裡面，不能用。請複製網址貼到 Bluefy。</li>
          <li>每次都要自己按「連線」再選機器，不會自動連。</li>
          <li>切到別的 App 或螢幕關掉，藍牙可能會斷。回來再按一次「連線」就好，設定不會不見。</li>
          <li>「自動調音」要用麥克風，Bluefy 不一定支援。不行的話那一頁最下面有替代做法。</li>
        </ul>
      </details>
      <details${open('android')}><summary>Android 怎麼用</summary>
        <ul class="plain">
          <li>用 <b>Chrome</b> 開這個網址就可以，不用另外安裝東西。</li>
          <li>從 LINE 或 Facebook 點連結會開在它們裡面，不能用。請點右上角選單，選「用其他瀏覽器開啟」。</li>
          <li>第一次按「連線」會問權限，「附近的裝置」和「位置」都要允許。</li>
          <li>清單是空的：把手機的<b>定位（GPS）</b>打開再試。舊一點的 Android 沒開定位就掃不到藍牙。</li>
        </ul>
      </details>
      <details${open('desktop')}><summary>用電腦</summary>
        <ul class="plain">
          <li>Windows 或 Mac 用 Chrome 或 Edge 開這個網址，電腦要有藍牙，而且要離車子夠近。</li>
        </ul>
      </details>
    </div>

    <div class="card">
      <details><summary>每個分頁是做什麼的</summary>
        <ul class="plain">
          <li><b>藍牙</b>：連線、斷線。</li>
          <li><b>聲音</b>：切換輸入來源、主音量，每個聲道的靜音、相位、延時。</li>
          <li><b>EQ</b>：調音色。可以拉曲線，也可以直接載入預設。</li>
          <li><b>自動調音（未測試）</b>：用手機麥克風量車內的聲音，自動算出 EQ。這個功能還沒在真車上測試過，結果不一定正確，建議先用 EQ 分頁的預設。</li>
          <li><b>模式</b>：8 個儲存槽，可以存不同的音色再切換。</li>
          <li><b>日誌</b>：記錄送給機器的每一筆指令。出問題時複製下來傳給開發者。</li>
        </ul>
      </details>
      <details><summary>調好的設定會不會不見</summary>
        <ul class="plain">
          <li>不會。機器自己會記住，熄火再發動也還在，不用每次按儲存。</li>
          <li>「儲存到模式」是另外留一份備份。之後亂調了，可以切回那個模式。</li>
          <li>注意：切到別的模式時，還沒存過的設定會被蓋掉。</li>
          <li>各聲道音量的「個別差距」熄火後會被機器拉成一樣，這是機器的行為。</li>
        </ul>
      </details>
      <details><summary>我的喇叭接法不一樣</summary>
        <ul class="plain">
          <li>網頁預設把 CH1、CH2 當「前」，CH3、CH4 當「後」，一起調。</li>
          <li>不確定哪個 CH 接哪顆喇叭：到「聲音」分頁一個一個按「靜音」，聽哪顆沒聲音。</li>
          <li>接法不同：到「EQ」分頁按「進階」再按「編輯群組」，改成你的接法。按「進階」也可以單獨調某一個 CH。</li>
          <li>內建的預設是照作者的車調的，當作起點就好，再依自己的車微調。</li>
        </ul>
      </details>
      <details><summary>調音小提醒</summary>
        <ul class="plain">
          <li>多減少、少加強。覺得悶，先把太多的地方拉低，不要一直往上加。</li>
          <li>加強太多再開大聲會破音，也可能傷喇叭。</li>
          <li>延時：量每顆喇叭到耳朵的距離，最遠的填 0，其他填「最遠的距離 − 自己的距離」。</li>
          <li>請停好車再調，開車時不要操作。</li>
        </ul>
      </details>
    </div>

    <div class="card" id="help-report"><h3>遇到問題怎麼辦</h3>
      <p style="margin:0 0 6px">連不上、調了沒反應、畫面怪怪的，都請把<b>日誌</b>傳給開發者。日誌記錄了網頁和機器之間的每一步，開發者看了才知道哪裡出錯。</p>
      <ol class="steps">
        <li>出問題後<b>先不要重新整理網頁</b>。</li>
        <li>按下面的「複製問題回報」。</li>
        <li>貼給開發者（把這個網頁分享給你的人），並在「問題描述」那一行寫上你做了什麼、發生什麼事。</li>
      </ol>
      <div class="row" style="margin-top:8px"><button id="help-copy-log" class="primary">複製問題回報</button><button id="help-share-log">用分享傳送</button></div>
      <textarea id="help-report-text" class="copyfallback" hidden readonly style="height:120px;margin-top:8px"></textarea>
      <p class="muted" style="margin:8px 0 0">日誌只有連線紀錄和調整的數值，沒有個人資料。已經重新整理了也沒關係：到「日誌」分頁按「載入上次日誌」再按「複製全部」。會用 GitHub 的人也可以直接<a href="${CONTACT.issuesUrl}" target="_blank" rel="noopener">開一個 Issue</a>貼上。${CONTACT.note}</p>
    </div>

    <div class="card"><h3>常見問題</h3>
      <details><summary>清單裡找不到 Mango3.0</summary>
        <ul class="plain">
          <li>確認音響有通電。</li>
          <li>原廠小程序或別支手機正連著的話，要先斷開。</li>
          <li>Android 把定位打開。手機離機器近一點。</li>
          <li>名稱不一定叫 Mango3.0，清單裡沒看過的名字可以試試看，連錯了不會怎樣。</li>
        </ul>
      </details>
      <details><summary>連上了但顯示「唯讀」</summary>
        <ul class="plain"><li>你的機器型號和這個網頁支援的不同。為了不把機器寫壞，只能看、不能改。</li></ul>
      </details>
      <details><summary>調了 EQ 聲音沒變</summary>
        <ul class="plain">
          <li>EQ 分頁上方如果寫「EQ 旁通中」，代表機器把 EQ 關掉了。</li>
          <li>看看是不是調到沒在出聲的聲道，或那個聲道被靜音了。</li>
        </ul>
      </details>
      <details><summary>用到一半斷線</summary>
        <ul class="plain"><li>通常是手機切到別的 App 或螢幕關了。回到「藍牙」再按一次「連線」。</li></ul>
      </details>
      <details><summary>聲音變得很怪，想回到原本</summary>
        <ul class="plain">
          <li>EQ 分頁的「預設」選最後一個「平直（全部歸零）」再按「載入預設」，就回到沒有 EQ 的狀態。</li>
          <li>有存過模式的話，到「模式」分頁切回去。</li>
        </ul>
      </details>
      <p class="muted" style="margin:10px 0 0">這裡找不到答案：請照上面「遇到問題怎麼辦」把日誌傳給開發者。</p>
    </div>

    <div class="card"><h3>分享給車友</h3>
      <p class="mono" id="help-url" style="word-break:break-all;margin:0 0 8px">${url}</p>
      <div class="row"><button id="help-share" class="primary">分享</button><button id="help-copy">複製網址</button></div>
      <p class="muted" style="margin:8px 0 0">適用機型：Yiye lang DSP-X8s（原廠微信小程序叫 ONE-APP 的那一款）。</p>
    </div>`;

  const $ = (id) => el.querySelector(id);
  async function copy() {
    try { await navigator.clipboard.writeText(url); toast('網址已複製'); }
    catch { toast('無法自動複製，請長按上面的網址選「複製」', 4000); }
  }
  const reportText = () => buildIssueReport({
    version: document.documentElement.dataset.version, userAgent: env.userAgent,
    deviceName: device.info?.name, logText: logger.toText('normal'),
  });
  $('#help-copy-log').addEventListener('click', async () => {
    const text = reportText();
    try { await navigator.clipboard.writeText(text); toast('已複製。到 LINE 或訊息裡貼上，傳給開發者', 4000); }
    catch { const ta = $('#help-report-text'); ta.hidden = false; ta.value = text; ta.focus(); ta.select(); toast('無法自動複製，請長按下面的文字框選「全選」再「複製」', 5000); }
  });
  $('#help-share-log').addEventListener('click', () => shareText(reportText()));
  ctx.help = { reportText };
  $('#help-copy').addEventListener('click', copy);
  $('#help-share').addEventListener('click', async () => {
    if (!navigator.share) { copy(); return; }
    try { await navigator.share({ title: 'DSP-X8s 調音', text: '用手機藍牙調 DSP-X8s 的網頁（iPhone 請用 Bluefy 開，Android 用 Chrome）', url }); }
    catch (err) { if (err?.name !== 'AbortError') copy(); }
  });
}
