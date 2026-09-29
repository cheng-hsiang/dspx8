import { deflateSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xFFFFFFFF; for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function png(size, paint) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = paint(x / size, y / size);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const BARS = [0.35, 0.6, 0.85, 0.5, 0.7]; // relative heights
function paint(u, v) {
  // rounded dark square background
  const cx = Math.max(Math.abs(u - 0.5) - 0.38, 0), cy = Math.max(Math.abs(v - 0.5) - 0.38, 0);
  if (Math.hypot(cx, cy) > 0.12) return [0, 0, 0, 0];
  let color = [16, 20, 24, 255];
  const i = Math.floor((u - 0.2) / 0.6 * BARS.length);
  if (i >= 0 && i < BARS.length) {
    const bx = 0.2 + (i + 0.5) * (0.6 / BARS.length);
    if (Math.abs(u - bx) < 0.045 && v > 0.8 - BARS[i] * 0.6 && v < 0.8) color = [41, 182, 246, 255];
  }
  return color;
}

const dir = fileURLToPath(new URL('../icons/', import.meta.url));
await mkdir(dir, { recursive: true });
for (const size of [192, 512]) await writeFile(`${dir}icon-${size}.png`, png(size, paint));
console.log('icons written');
