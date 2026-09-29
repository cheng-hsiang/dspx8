import { eqAddr, ADDR, EQ_SLOTS } from '../protocol/addrmap.js';
import { encodeFreq, decodeFreq, encodeGain, decodeGain, decodeQ, clamp, GAIN_MIN_DB, GAIN_MAX_DB } from '../protocol/codec.js';
import { TAB_FREQ, TAB_Q } from '../protocol/tables.js';
import { inferQScale as reportInfer } from '../core/report.js';

export const LAYERS = Object.freeze({ MODE: 'mode', APP: 'app' });
/** Q divisor the OEM app applies on the 10-band layer (raw = 100·Q / QRATE). Unknown for the 31-band layer until measured. */
export const QRATE = 7.6 / 2.4;

export function layerInfo(layer) {
  return layer === LAYERS.APP
    ? { bands: 10, maxSlots: 10, label: '10 段（原廠層）' }
    : { bands: 31, maxSlots: EQ_SLOTS, label: '31 段（模式區）' };
}

export function bandAddrs(layer, ch, band) {
  const TYPE = layer === LAYERS.APP ? ADDR.iir100(ch, band, 0) : eqAddr(ch, band, 'TYPE');
  return { TYPE, F: TYPE + 1, G: TYPE + 2, Q: TYPE + 3 };
}

/** 1 = raw is hundredths of Q; QRATE = OEM scaling; null = could not be inferred from the dump. */
export function inferQScale(store) {
  const { verdict } = reportInfer(store);
  return verdict === 'no-qrate' ? 1 : verdict === 'qrate' ? QRATE : null;
}

export function nearest(table, v) {
  let best = table[0];
  for (const t of table) if (Math.abs(t - v) < Math.abs(best - v)) best = t;
  return best;
}

export function readBands(store, { layer, ch, qScale = 1, slots } = {}) {
  const n = slots ?? layerInfo(layer).bands;
  const out = [];
  for (let band = 1; band <= n; band++) {
    const addrs = bandAddrs(layer, ch, band);
    const raw = { TYPE: store.get(addrs.TYPE), F: store.get(addrs.F), G: store.get(addrs.G), Q: store.get(addrs.Q) };
    out.push({
      band, addrs, raw, type: raw.TYPE,
      f: decodeFreq(raw.F), g: decodeGain(raw.G), q: decodeQ(raw.Q) * (qScale ?? 1),
      enabled: raw.TYPE !== 0 && raw.F !== 0,
      status: Math.max(store.getStatus(addrs.F), store.getStatus(addrs.G), store.getStatus(addrs.Q)),
    });
  }
  return out;
}

/** Snap a (f, g, q) request to what the device accepts and encode it. Missing fields are left out. */
export function encodeBand({ f, g, q } = {}, qScale = 1) {
  const out = {};
  if (f !== undefined) out.F = encodeFreq(nearest(TAB_FREQ, f));
  if (g !== undefined) out.G = encodeGain(clamp(g, GAIN_MIN_DB, GAIN_MAX_DB));
  if (q !== undefined) out.Q = Math.round((100 * nearest(TAB_Q, q)) / (qScale ?? 1));
  return out;
}

function bandEnabled(store, addrs) { return store.get(addrs.TYPE) !== 0 && store.get(addrs.F) !== 0; }

/** Pairs to write one band on every channel of a group; disabled channels are skipped, unchanged fields omitted. */
export function bandWritePairs(layer, channels, band, values, qScale, store) {
  const enc = encodeBand(values, qScale);
  const pairs = [], skipped = [];
  for (const ch of channels) {
    const addrs = bandAddrs(layer, ch, band);
    if (!bandEnabled(store, addrs)) { skipped.push(ch); continue; }
    for (const field of ['F', 'G', 'Q']) {
      if (enc[field] === undefined) continue;
      if (store.get(addrs[field]) !== enc[field]) pairs.push({ addr: addrs[field], val: enc[field] });
    }
  }
  return { pairs, skipped };
}

/** Assign each preset filter to the nearest (log-distance) enabled band not already taken. */
export function mapPresetToBands(filters, bands) {
  const free = bands.filter((b) => b.enabled && b.f > 0);
  const mapped = [], dropped = [];
  for (const flt of filters) {
    let best = null, bestD = Infinity;
    for (const b of free) { const d = Math.abs(Math.log(flt.f / b.f)); if (d < bestD) { bestD = d; best = b; } }
    if (!best) { dropped.push(flt); continue; }
    free.splice(free.indexOf(best), 1);
    mapped.push({ band: best.band, f: flt.f, g: flt.g, q: flt.q });
  }
  return { mapped, dropped };
}

/** Full preset application: zero every enabled band's gain, then write the mapped filters. One pair per address. */
export function presetWritePairs(preset, layer, groups, store, qScale) {
  const target = new Map();
  const dropped = [], skipped = [];
  for (const [groupName, filters] of Object.entries(preset.eq ?? {})) {
    const channels = groups?.[groupName] ?? preset.channelGroups?.[groupName] ?? [];
    for (const ch of channels) {
      const bands = readBands(store, { layer, ch, qScale });
      const enabled = bands.filter((b) => b.enabled);
      if (enabled.length === 0) { skipped.push(ch); continue; }
      for (const b of enabled) target.set(b.addrs.G, 500);
      const { mapped, dropped: d } = mapPresetToBands(filters, bands);
      for (const x of d) dropped.push({ group: groupName, ch, f: x.f });
      for (const x of mapped) {
        const addrs = bandAddrs(layer, ch, x.band);
        const enc = encodeBand({ f: x.f, g: x.g, q: x.q }, qScale);
        target.set(addrs.F, enc.F); target.set(addrs.G, enc.G); target.set(addrs.Q, enc.Q);
      }
    }
  }
  const pairs = Array.from(target, ([addr, val]) => ({ addr, val }));
  return { pairs, dropped, skipped };
}

export function resetChannelPairs(layer, ch, store) {
  return readBands(store, { layer, ch }).filter((b) => b.enabled).map((b) => ({ addr: b.addrs.G, val: 500 }));
}

export function copyChannelPairs(layer, from, to, store) {
  const src = readBands(store, { layer, ch: from }).filter((b) => b.enabled);
  const pairs = [];
  for (const ch of to) {
    if (ch === from) continue;
    for (const b of src) {
      const addrs = bandAddrs(layer, ch, b.band);
      if (!bandEnabled(store, addrs)) continue;
      pairs.push({ addr: addrs.F, val: b.raw.F }, { addr: addrs.G, val: b.raw.G }, { addr: addrs.Q, val: b.raw.Q });
    }
  }
  return pairs;
}
