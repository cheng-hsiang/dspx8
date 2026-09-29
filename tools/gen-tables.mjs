import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const src = fileURLToPath(new URL('../../src/data/utils/TabMainUtil.js', import.meta.url));
const t = require(src);
if (!Array.isArray(t.TAB_FREQ) || !Array.isArray(t.TAB_Q)) throw new Error('unexpected TabMainUtil shape');

const out = `// 由 tools/gen-tables.mjs 產生，勿手改。來源：機器內建頻率表與 Q 值表。
export const TAB_FREQ = ${JSON.stringify(t.TAB_FREQ)};
export const TAB_Q = ${JSON.stringify(t.TAB_Q)};
export const CUSTOMER_ID = 4006;
export const INPUT = { BT: 2, HIGH_LEVEL: 3, AUX: 4, USB: 7 };
export const INPUT_NAMES = { 2: '藍牙', 3: '高電平', 4: 'AUX', 7: 'USB' };
export const DEFAULT_CHANNEL_NAMES = ['前左', '前右', '後左', '後右', '超低 1', '超低 2', '超低 3', '超低 4'];
`;
const dest = fileURLToPath(new URL('../js/protocol/tables.js', import.meta.url));
await writeFile(dest, out, 'utf8');
console.log(`wrote ${dest}: ${t.TAB_FREQ.length} freqs, ${t.TAB_Q.length} Q values`);
