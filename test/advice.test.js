import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserAdvice, shareUrl } from '../js/help/advice.js';

const UA = {
  iosSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  iosChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1',
  bluefy: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Version/3.9.3  Bluefy/3.9.3',
  iosLine: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/15.12.1',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  androidLine: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36 Line/15.12.1/IAB',
  androidFacebook: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/480.0.0.0;]',
  androidFirefox: 'Mozilla/5.0 (Android 14; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0',
  wechat: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.50',
  winChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
};
const env = (userAgent, webBluetooth, secure = true) => ({ userAgent, webBluetooth, secure, bluefy: /bluefy/i.test(userAgent) });

test('a browser with Web Bluetooth on HTTPS is ready, whatever the platform', () => {
  for (const ua of [UA.bluefy, UA.androidChrome, UA.winChrome]) {
    const a = browserAdvice(env(ua, true));
    assert.equal(a.ok, true); assert.equal(a.code, 'ok');
  }
  assert.equal(browserAdvice(env(UA.bluefy, true)).platform, 'ios');
  assert.equal(browserAdvice(env(UA.androidChrome, true)).platform, 'android');
  assert.equal(browserAdvice(env(UA.winChrome, true)).platform, 'desktop');
});

test('iPhone and iPad without Bluefy are told to install Bluefy (Safari and Chrome on iOS cannot do Bluetooth)', () => {
  for (const ua of [UA.iosSafari, UA.iosChrome, UA.ipad]) {
    const a = browserAdvice(env(ua, false));
    assert.equal(a.ok, false); assert.equal(a.code, 'ios-bluefy'); assert.equal(a.platform, 'ios');
    assert.match(a.text, /Bluefy/);
  }
});

test('links opened inside LINE, Facebook or WeChat are told to reopen in a real browser', () => {
  assert.equal(browserAdvice(env(UA.androidLine, false)).code, 'in-app');
  assert.equal(browserAdvice(env(UA.androidFacebook, false)).code, 'in-app');
  assert.equal(browserAdvice(env(UA.wechat, false)).code, 'in-app');
  const ios = browserAdvice(env(UA.iosLine, false));
  assert.equal(ios.code, 'in-app'); assert.match(ios.text, /Bluefy/, 'on iOS the real browser must be Bluefy');
  assert.match(browserAdvice(env(UA.androidLine, false)).text, /Chrome/);
});

test('Android and desktop browsers without Web Bluetooth are pointed to Chrome', () => {
  const a = browserAdvice(env(UA.androidFirefox, false));
  assert.equal(a.code, 'android-chrome'); assert.match(a.text, /Chrome/);
  const d = browserAdvice(env(UA.macSafari, false));
  assert.equal(d.code, 'desktop-chrome'); assert.equal(d.platform, 'desktop');
});

test('a plain http page explains that HTTPS is required', () => {
  const a = browserAdvice(env(UA.androidChrome, false, false));
  assert.equal(a.code, 'need-https'); assert.equal(a.ok, false);
});

test('simulator mode is reported as a demo, not as a broken browser', () => {
  const a = browserAdvice(env(UA.macSafari, false), { sim: true });
  assert.equal(a.code, 'sim'); assert.equal(a.ok, true);
});

test('shareUrl drops the query string and hash so friends never get ?sim=1', () => {
  assert.equal(shareUrl({ origin: 'https://cheng-hsiang.github.io', pathname: '/dspx8/', search: '?sim=1&lat=60', hash: '#x' }), 'https://cheng-hsiang.github.io/dspx8/');
  assert.equal(shareUrl({ origin: 'https://a.netlify.app', pathname: '/index.html', search: '', hash: '' }), 'https://a.netlify.app/');
});
