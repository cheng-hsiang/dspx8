export const BLUEFY_URL = 'https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055';

const IN_APP = /\bLine\/|FBAN|FBAV|FB_IAB|Instagram|MicroMessenger|Messenger/i;

export function platformOf(userAgent = '') {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'ios';
  if (/Android/i.test(userAgent)) return 'android';
  return 'desktop';
}

/**
 * One plain sentence telling a newcomer whether this browser can talk to the DSP, and what to open instead.
 * env: { userAgent, webBluetooth, secure } from detectEnvironment().
 */
export function browserAdvice(env, { sim = false } = {}) {
  const ua = env?.userAgent ?? '';
  const platform = platformOf(ua);
  if (sim) return { ok: true, code: 'sim', platform, text: '現在是模擬模式：不用機器也能試所有功能，改的設定不會送到真的機器。' };
  if (env?.webBluetooth && env?.secure !== false) return { ok: true, code: 'ok', platform, text: '這個瀏覽器可以用。到「藍牙」分頁按「連線」就能開始。' };
  if (IN_APP.test(ua)) {
    return platform === 'ios'
      ? { ok: false, code: 'in-app', platform, text: '你現在是在 LINE、Facebook 這類 App 裡面開的，這裡不能連藍牙。請複製網址，用 Bluefy 開啟（iPhone 只有 Bluefy 可以）。' }
      : { ok: false, code: 'in-app', platform, text: '你現在是在 LINE、Facebook 這類 App 裡面開的，這裡不能連藍牙。請點右上角選單選「用其他瀏覽器開啟」，改用 Chrome。' };
  }
  if (platform === 'ios') return { ok: false, code: 'ios-bluefy', platform, text: 'iPhone 的 Safari 和 Chrome 都不能連藍牙。請到 App Store 安裝免費的「Bluefy」，再用 Bluefy 開這個網址。' };
  if (env?.secure === false) return { ok: false, code: 'need-https', platform, text: '網址必須是 https 開頭才能連藍牙。' };
  if (platform === 'android') return { ok: false, code: 'android-chrome', platform, text: '這個瀏覽器不能連藍牙。請改用 Chrome 開這個網址。' };
  return { ok: false, code: 'desktop-chrome', platform, text: '這個瀏覽器不能連藍牙。電腦請用 Chrome 或 Edge，而且電腦要有藍牙。' };
}

/** The address to hand to a friend: no query string (never ?sim=1), no hash, no index.html. */
export function shareUrl(loc = globalThis.location) {
  return `${loc.origin}${loc.pathname.replace(/index\.html$/, '')}`;
}
