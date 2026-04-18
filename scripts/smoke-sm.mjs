// Smoke test for get_sm_mappings — load the wasm module and print the decoded
// mappings for a given fink test file. Intended for ad-hoc verification.
//
// Usage:
//   node scripts/smoke-sm.mjs <path-to-fink-test-file>

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/smoke-sm.mjs <fink-test-file>');
  process.exit(1);
}

const wasmJsPath = resolve(repoRoot, 'build/pkg/wasm/fink_wasm.js');
const wasmBinPath = resolve(repoRoot, 'build/pkg/wasm/fink_wasm_bg.wasm');

const wasmModule = await import(wasmJsPath);
const wasmBytes = readFileSync(wasmBinPath);
await wasmModule.default(wasmBytes);

const src = readFileSync(target, 'utf8');

// Warm-up + timing.
for (let i = 0; i < 3; i++) wasmModule.get_sm_mappings(src);
const iters = 50;
const t0 = performance.now();
for (let i = 0; i < iters; i++) wasmModule.get_sm_mappings(src);
const elapsed = performance.now() - t0;
console.log(`size=${src.length}B, avg=${(elapsed / iters).toFixed(2)}ms over ${iters} iters`);

const json = wasmModule.get_sm_mappings(src);
const groups = JSON.parse(json);

console.log(`found ${groups.length} sm group(s)`);
const showAll = process.argv.includes('--all');
for (const [i, g] of groups.entries()) {
  console.log(`  group ${i}: ${g.mappings.length} mapping(s)`);
  const limit = showAll ? g.mappings.length : 5;
  for (const m of g.mappings.slice(0, limit)) {
    const outStr = `out=${m.out.line}:${m.out.col}-${m.out.endLine}:${m.out.endCol}`;
    const srcStr = m.src
      ? `src=${m.src.line}:${m.src.col}-${m.src.endLine}:${m.src.endCol}`
      : 'src=<none>';
    console.log(`    ${outStr}  ${srcStr}`);
  }
  if (!showAll && g.mappings.length > 5) console.log(`    ... ${g.mappings.length - 5} more`);
}
