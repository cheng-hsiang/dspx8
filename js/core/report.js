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
