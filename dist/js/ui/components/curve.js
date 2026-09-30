import { responseDb, logFreqAxis } from '../../eq/biquad.js';

const GRID_F = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const fmtF = (f) => (f >= 1000 ? `${Math.round(f / 100) / 10}k` : String(Math.round(f)));
const AXIS_DEADZONE_PX = 8;

/**
 * Draggable EQ response curve on a canvas.
 * bands: [{ band, f, g, q, enabled }]. A drag locks to one axis once the pointer has moved
 * AXIS_DEADZONE_PX: vertical → gain only, horizontal → frequency only (passed through snapF).
 * onDrag(bandIndex, { g }) or onDrag(bandIndex, { f }); tapping a point calls onSelect(bandIndex).
 */
export function createCurve(canvas, { onDrag, onSelect, snapF = (f) => f, fMin = 20, fMax = 20000, dbRange = 15, gainLimit = 12 } = {}) {
  const ctx = canvas.getContext('2d');
  let bands = [], selected = -1;
  let drag = null; // { i, x0, y0, f0, g0, axis: null | 'g' | 'f' }
  const PAD = { l: 34, r: 10, t: 10, b: 22 };
  let W = 0, H = 0;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const xOf = (f) => PAD.l + ((Math.log(clamp(f, fMin, fMax) / fMin) / Math.log(fMax / fMin)) * (W - PAD.l - PAD.r));
  const fOf = (x) => fMin * Math.exp(((clamp(x, PAD.l, W - PAD.r) - PAD.l) / (W - PAD.l - PAD.r)) * Math.log(fMax / fMin));
  const yOf = (db) => PAD.t + ((dbRange - clamp(db, -dbRange, dbRange)) / (2 * dbRange)) * (H - PAD.t - PAD.b);
  const dbOf = (y) => dbRange - ((y - PAD.t) / (H - PAD.t - PAD.b)) * 2 * dbRange;

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
    resp.forEach((db, i) => { const x = xOf(freqs[i]), y = yOf(db); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
    bands.forEach((b, i) => {
      if (!b.enabled || !(b.f > 0)) return;
      const x = xOf(b.f), y = yOf(b.g);
      ctx.beginPath(); ctx.arc(x, y, i === selected ? 8 : 5, 0, Math.PI * 2);
      ctx.fillStyle = i === selected ? accent : fg; ctx.fill();
    });
    const s = bands[selected];
    if (s && s.enabled) {
      // label drawn last, above the plot top, so it never sits on neighbouring points
      ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(`第 ${s.band} 段  ${fmtF(s.f)} Hz  ${s.g >= 0 ? '+' : ''}${s.g.toFixed(1)} dB  Q ${s.q.toFixed(2)}`, W / 2, PAD.t + 9);
    }
  }

  function hit(px, py) {
    let best = -1, bestD = 24;
    bands.forEach((b, i) => {
      if (!b.enabled || !(b.f > 0)) return;
      const d = Math.hypot(xOf(b.f) - px, yOf(b.g) - py);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  const pos = (ev) => { const r = canvas.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
  const onDown = (ev) => {
    const [x, y] = pos(ev);
    const i = hit(x, y);
    if (i < 0) return;
    drag = { i, x0: x, y0: y, f0: bands[i].f, g0: bands[i].g, axis: null };
    selected = i;
    try { canvas.setPointerCapture?.(ev.pointerId); } catch { /* synthetic or already-captured pointer */ }
    onSelect?.(i); draw(); ev.preventDefault();
  };
  const onMove = (ev) => {
    if (!drag) return;
    const [x, y] = pos(ev);
    if (!drag.axis) {
      const dx = Math.abs(x - drag.x0), dy = Math.abs(y - drag.y0);
      if (Math.max(dx, dy) < AXIS_DEADZONE_PX) return;
      drag.axis = dx > dy ? 'f' : 'g';
    }
    const b = bands[drag.i];
    if (drag.axis === 'g') {
      const g = Math.round(clamp(dbOf(y), -gainLimit, gainLimit) * 10) / 10;
      if (g !== b.g) { bands[drag.i] = { ...b, g }; draw(); onDrag?.(drag.i, { g }); }
    } else {
      const f = snapF(clamp(fOf(x), fMin, fMax));
      if (f !== b.f) { bands[drag.i] = { ...b, f }; draw(); onDrag?.(drag.i, { f }); }
    }
    ev.preventDefault();
  };
  const onUp = () => { drag = null; };
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
    /** Canvas-relative position of a band's point (for tests and tooltips). */
    pointOf(i) { const b = bands[i]; return b ? { x: xOf(b.f), y: yOf(b.g) } : null; },
    get selected() { return selected; },
    get dragging() { return drag !== null; },
    destroy() { ro?.disconnect(); canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointermove', onMove); canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointercancel', onUp); },
  };
}
