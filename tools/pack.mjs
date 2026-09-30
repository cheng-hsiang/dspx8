// Copy only the runtime files into dist/ for drag-and-drop hosting (Netlify Drop, etc.).
import { cp, rm, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = `${ROOT}dist/`;
const ITEMS = ['index.html', 'manifest.webmanifest', 'css', 'js', 'icons', 'presets'];

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });
for (const item of ITEMS) await cp(`${ROOT}${item}`, `${DIST}${item}`, { recursive: true });

const version = /data-version="([^"]+)"/.exec(await readFile(`${DIST}index.html`, 'utf8'))?.[1];
console.log(`dist/ ready (version ${version}). Drag the dist folder to Netlify Drop, or push it to GitHub Pages.`);
