// Copy only the runtime files into dist/ for drag-and-drop hosting (Netlify Drop, etc.).
import { cp, rm, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = `${ROOT}dist/`;
const ITEMS = ['index.html', 'manifest.webmanifest', 'sw.js', 'css', 'js', 'icons', 'presets'];

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });
for (const item of ITEMS) await cp(`${ROOT}${item}`, `${DIST}${item}`, { recursive: true });

// sanity: every precached path must exist in dist
const sw = await readFile(`${DIST}sw.js`, 'utf8');
const missing = [];
for (const m of sw.matchAll(/'\.\/([^']+)'/g)) {
  const p = m[1];
  if (p === '' || p.endsWith('/')) continue;
  try { await readFile(`${DIST}${p}`); } catch { missing.push(p); }
}
if (missing.length) { console.error('precache entries missing from dist:', missing); process.exit(1); }
const version = /VERSION = '([^']+)'/.exec(sw)?.[1];
console.log(`dist/ ready (version ${version}). Drag the dist folder to Netlify Drop, or push it to GitHub Pages.`);
