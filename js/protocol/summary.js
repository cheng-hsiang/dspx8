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
