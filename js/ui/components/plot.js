// Small canvas plots on a log-frequency axis (20 Hz – 20 kHz) for the auto-tune page.
const GRID_F = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const fmtF = (f) => (f >= 1000 ? `${f / 1000}k` : String(f));
const F_MIN = 20, F_MAX = 20000;
const PAD = { l: 34, r: 10, t: 10, b: 22 };

function frame(canvas, yMin, yMax, yStep) {
  const ctx = canvas.getContext('2d');
  const dpr = globalThis.devicePixelRatio || 1;
  const W = canvas.clientWidth || 320, H = canvas.clientHeight || 200;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = getComputedStyle(canvas);
  const line = css.getPropertyValue('--line').trim() || '#2b343e';
  const muted = css.getPropertyValue('--muted').trim() || '#8b98a5';
  const x = (f) => PAD.l + (Math.log(Math.min(F_MAX, Math.max(F_MIN, f)) / F_MIN) / Math.log(F_MAX / F_MIN)) * (W - PAD.l - PAD.r);
  const y = (db) => PAD.t + ((yMax - Math.min(yMax, Math.max(yMin, db))) / (yMax - yMin)) * (H - PAD.t - PAD.b);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0b0f13'; ctx.fillRect(0, 0, W, H);
  ctx.lineWidth = 1; ctx.font = '10px system-ui, sans-serif'; ctx.fillStyle = muted; ctx.textAlign = 'center';
  for (const f of GRID_F) { ctx.strokeStyle = line; ctx.beginPath(); ctx.moveTo(x(f), PAD.t); ctx.lineTo(x(f), H - PAD.b); ctx.stroke(); ctx.fillText(fmtF(f), x(f), H - 8); }
  ctx.textAlign = 'right';
  for (let db = yMin; db <= yMax; db += yStep) { ctx.strokeStyle = db === 0 ? muted : line; ctx.beginPath(); ctx.moveTo(PAD.l, y(db)); ctx.lineTo(W - PAD.r, y(db)); ctx.stroke(); ctx.fillText(`${db > 0 ? '+' : ''}${db}`, PAD.l - 4, y(db) + 3); }
  return { ctx, x, y, W, H };
}

/** series: [{ values, color, width = 2, dash = [] }] sampled at freqs. */
export function drawLines(canvas, { freqs, series, yMin = -15, yMax = 15, yStep = 5, empty = '' }) {
  const { ctx, x, y, W, H } = frame(canvas, yMin, yMax, yStep);
  let drawn = 0;
  for (const s of series) {
    if (!s?.values) continue;
    ctx.strokeStyle = s.color; ctx.lineWidth = s.width ?? 2; ctx.setLineDash(s.dash ?? []);
    ctx.beginPath();
    let started = false;
    freqs.forEach((f, i) => { const v = s.values[i]; if (!Number.isFinite(v)) { started = false; return; } if (started) ctx.lineTo(x(f), y(v)); else { ctx.moveTo(x(f), y(v)); started = true; } });
    ctx.stroke(); drawn++;
  }
  ctx.setLineDash([]);
  if (!drawn && empty) { ctx.fillStyle = '#8b98a5'; ctx.textAlign = 'center'; ctx.font = '12px system-ui, sans-serif'; ctx.fillText(empty, W / 2, H / 2); }
}

/** One bar per band, centred on the band frequency. */
export function drawBars(canvas, { freqs, values, yMin = -20, yMax = 20, yStep = 10, color = '#29b6f6', empty = '' }) {
  const { ctx, x, y, W, H } = frame(canvas, yMin, yMax, yStep);
  if (!values) { if (empty) { ctx.fillStyle = '#8b98a5'; ctx.textAlign = 'center'; ctx.font = '12px system-ui, sans-serif'; ctx.fillText(empty, W / 2, H / 2); } return; }
  const bw = Math.max(2, (x(freqs[1]) - x(freqs[0])) * 0.7);
  ctx.fillStyle = color;
  freqs.forEach((f, i) => { const v = values[i]; if (!Number.isFinite(v)) return; const top = y(Math.max(v, yMin)), base = y(yMin); ctx.fillRect(x(f) - bw / 2, top, bw, Math.max(1, base - top)); });
}
