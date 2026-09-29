import { responseDb, logFreqAxis } from '../../eq/biquad.js';

const GRID_F = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const fmtF = (f) => (f >= 1000 ? `${Math.round(f / 100) / 10}k` : String(Math.round(f)));

/**
 * Draggable EQ response curve on a canvas.
 * bands: [{ band, f, g, q, enabled }]. Dragging a point calls onDrag(bandIndex, { f, g }) with values
 * clamped to [fMin, fMax] and ±gainLimit; tapping a point calls onSelect(bandIndex).
 */
export function createCurve(canvas, { onDrag, onSelect, fMin = 20, fMax = 20000, dbRange = 15, gainLimit = 12 } = {}) {
  const ctx = canvas.getContext('2d');
  let bands = [], selected = -1, dragging = -1;
  const PAD = { l: 34, r: 10, t: 10, b: 22 };
  let W = 0, H = 0;

  const xOf = (f) => PAD.l + ((Math.log(f / fMin) / Math.log(fMax / fMin)) * (W - PAD.l - PAD.r));
  const fOf = (x) => fMin * Math.exp(((x - PAD.l) / (W - PAD.l - PAD.r)) * Math.log(fMax / fMin));
  const yOf = (db) => PAD.t + ((dbRange - db) / (2 * dbRange)) * (H - PAD.t - PAD.b);
  const dbOf = (y) => dbRange - ((y - PAD.t) / (H - PAD.t - PAD.b)) * 2 * dbRange;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    W = canvas.clientWidth || 320; H = canvas.clientHeight || 220;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function draw() {
    const css = getComputedStyle(canvas);
    const line = css.getPropertyValue('--line').trim() || '#2b343e';
    const fg = css.getPropertyValue('--fg').trim() || '#e6edf3';
    const muted = css.getPropertyValue('--muted').trim() || '#8b98a5';
    const accent = css.getPropertyValue('--accent').trim() || '#29b6f6';
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0b0f13'; ctx.fillRect(0, 0, W, H);
    ctx.lineWidth = 1; ctx.font = '10px system-ui, sans-serif'; ctx.fillStyle = muted; ctx.textAlign = 'center';
    for (const f of GRID_F) { const x = xOf(f); ctx.strokeStyle = line; ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, H - PAD.b); ctx.stroke(); ctx.fillText(fmtF(f), x, H - 8); }
    ctx.textAlign = 'right';
    for (let db = -dbRange; db <= dbRange; db += 5) { const y = yOf(db); ctx.strokeStyle = db === 0 ? muted : line; ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W - PAD.r, y); ctx.stroke(); ctx.fillText(`${db > 0 ? '+' : ''}${db}`, PAD.l - 4, y + 3); }
    const freqs = logFreqAxis(240, fMin, fMax);
    const resp = responseDb(bands, freqs);
    ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.beginPath();
    resp.forEach((db, i) => { const x = xOf(freqs[i]), y = yOf(clamp(db, -dbRange, dbRange)); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
    bands.forEach((b, i) => {
      if (!b.enabled || !(b.f > 0)) return;
      const x = xOf(clamp(b.f, fMin, fMax)), y = yOf(clamp(b.g, -dbRange, dbRange));
      ctx.beginPath(); ctx.arc(x, y, i === selected ? 8 : 5, 0, Math.PI * 2);
      ctx.fillStyle = i === selected ? accent : fg; ctx.fill();
      if (i === selected) { ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.fillText(`${b.band}: ${fmtF(b.f)} ${b.g >= 0 ? '+' : ''}${b.g.toFixed(1)} dB`, clamp(x, 60, W - 60), Math.max(12, y - 14)); }
    });
  }

  function hit(px, py) {
    let best = -1, bestD = 24;
    bands.forEach((b, i) => {
      if (!b.enabled || !(b.f > 0)) return;
      const d = Math.hypot(xOf(clamp(b.f, fMin, fMax)) - px, yOf(clamp(b.g, -dbRange, dbRange)) - py);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  const pos = (ev) => { const r = canvas.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
  const onDown = (ev) => {
    const [x, y] = pos(ev);
    const i = hit(x, y);
    if (i < 0) return;
    dragging = i; selected = i; canvas.setPointerCapture?.(ev.pointerId); onSelect?.(i); draw(); ev.preventDefault();
  };
  const onMove = (ev) => {
    if (dragging < 0) return;
    const [x, y] = pos(ev);
    const f = clamp(fOf(clamp(x, PAD.l, W - PAD.r)), fMin, fMax);
    const g = Math.round(clamp(dbOf(y), -gainLimit, gainLimit) * 10) / 10;
    bands[dragging] = { ...bands[dragging], f, g };
    draw();
    onDrag?.(dragging, { f, g });
    ev.preventDefault();
  };
  const onUp = () => { dragging = -1; };
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  ro?.observe(canvas);
  resize();

  return {
    setBands(next) { bands = next.map((b) => ({ ...b })); draw(); },
    setSelected(i) { selected = i; draw(); },
    get selected() { return selected; },
    destroy() { ro?.disconnect(); canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointermove', onMove); canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointercancel', onUp); },
  };
}
