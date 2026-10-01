/** Where a user sends a problem report. The site owner can add a personal channel in `note`. */
export const CONTACT = Object.freeze({
  issuesUrl: 'https://github.com/cheng-hsiang/dspx8/issues/new',
  note: '',
});

/**
 * Text a non-technical user can paste into any chat: a short header they complete, then the log.
 * The log holds only connection events and the values sent to the DSP, no personal data.
 */
export function buildIssueReport({ version, userAgent, deviceName, logText }) {
  return [
    '【DSP-X8s 調音網頁 問題回報】',
    `版本：${version || '未知'}`,
    `瀏覽器：${userAgent || '未知'}`,
    `機器：${deviceName || '（未連線）'}`,
    '問題描述：（請在這裡寫：你做了什麼、結果發生什麼事）',
    '',
    '----- 日誌 -----',
    logText && logText.trim() ? logText.replace(/\s+$/, '') : '（沒有日誌）',
    '----- 日誌結束 -----',
  ].join('\n');
}
