export const PRESET_SCHEMA = 'dspx8s-preset/1';

export function validatePreset(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object') return { ok: false, errors: ['not an object'] };
  if (obj.schema !== PRESET_SCHEMA) errors.push(`schema must be ${PRESET_SCHEMA}`);
  if (typeof obj.name !== 'string' || !obj.name.trim()) errors.push('name missing');
  if (!obj.eq || typeof obj.eq !== 'object') errors.push('eq missing');
  else {
    for (const [group, filters] of Object.entries(obj.eq)) {
      if (!Array.isArray(filters)) { errors.push(`eq.${group} must be an array`); continue; }
      filters.forEach((flt, i) => {
        const where = `eq.${group}[${i}]`;
        if (typeof flt.f !== 'number' || flt.f < 19 || flt.f > 21000) errors.push(`${where}.f out of range`);
        if (typeof flt.g !== 'number' || flt.g < -12 || flt.g > 12) errors.push(`${where}.g out of range`);
        if (typeof flt.q !== 'number' || flt.q < 0.4 || flt.q > 128) errors.push(`${where}.q out of range`);
      });
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Read presets/index.json then every listed file. Broken entries are skipped with a console warning. */
export async function loadBundledPresets(fetchFn = globalThis.fetch, base = './presets/') {
  const index = await (await fetchFn(`${base}index.json`)).json();
  const out = [];
  for (const file of index) {
    try {
      const res = await fetchFn(`${base}${file}`);
      if (!res.ok) throw new Error(`HTTP ${res.status ?? '?'}`);
      const preset = await res.json();
      const v = validatePreset(preset);
      if (!v.ok) throw new Error(v.errors.join('; '));
      out.push({ ...preset, source: 'bundled', file });
    } catch (err) {
      console.warn(`preset ${file} skipped: ${err.message}`);
    }
  }
  return out;
}

/** User presets kept in the browser under settings.eqPresets. */
export function localPresets(storage) {
  const KEY = 'eqPresets';
  const read = async () => (await storage.get('settings', KEY)) ?? {};
  return {
    async list() { return Object.values(await read()).map((p) => ({ ...p, source: 'local' })); },
    async save(name, preset) {
      const v = validatePreset({ ...preset, name });
      if (!v.ok) throw new Error(`invalid preset: ${v.errors.join('; ')}`);
      const all = await read();
      all[name] = { ...preset, name, savedAt: Date.now() };
      await storage.put('settings', KEY, all);
    },
    async remove(name) { const all = await read(); delete all[name]; await storage.put('settings', KEY, all); },
  };
}
