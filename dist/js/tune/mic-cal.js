import { THIRD_EXACT } from './iec.js';

const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

/**
 * A measurement-microphone calibration file (REW, miniDSP UMIK, Dayton iMM-6 …): text lines of
 * "frequency  dB  [phase]", with header or comment lines that are skipped. Returns [{ f, db }] sorted by
 * frequency: the microphone's own response, to be subtracted from what it measures.
 */
export function parseMicCal(text) {
  const points = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || /^["*#;A-Za-z]/.test(t)) continue;
    const nums = t.match(NUMBER);
    if (!nums || nums.length < 2) continue;
    const f = Number(nums[0]), db = Number(nums[1]);
    if (f > 0 && Number.isFinite(db)) points.push({ f, db });
  }
  if (points.length < 5) throw new Error('這不像麥克風校正檔（需要多行「頻率 dB」）');
  return points.sort((a, b) => a.f - b.f);
}

/** The calibration curve at the analyser's band centres (dB), interpolated on a log-frequency axis. */
export function calAtBands(points, centres = THIRD_EXACT) {
  return Float64Array.from(centres, (f) => {
    if (f <= points[0].f) return points[0].db;
    const last = points[points.length - 1];
    if (f >= last.f) return last.db;
    let i = 1;
    while (points[i].f < f) i++;
    const a = points[i - 1], b = points[i];
    return a.db + ((b.db - a.db) * Math.log(f / a.f)) / Math.log(b.f / a.f);
  });
}
