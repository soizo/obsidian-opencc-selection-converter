import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFileSync(join(root, path), 'utf8');
const bundle = read('dist/main.js');
const loader = read('build/engine/opencc.mjs');
const wasm = readFileSync(join(root, 'build/engine/opencc.wasm'));
for (const marker of ['runCliSuite', 'smoke/no-selection', 'trace/trace-budget', '.opencc-test-results']) {
  assert(!bundle.includes(marker), `Test-only marker bundled: ${marker}`);
}
for (const file of readdirSync(join(root, 'tests/fixtures/opencc'), { recursive: true })) {
  if (!/\.ocd2?$/.test(file)) continue;
  const encoded = readFileSync(join(root, 'tests/fixtures/opencc', file)).toString('base64');
  assert(!bundle.includes(encoded), `Test dictionary bundled: ${file}`);
}
const notices = ['THIRD_PARTY_NOTICES.md', ...readdirSync(join(root, 'engine/licenses')).map(file => `engine/licenses/${file}`)];
for (const file of notices) {
  const commented = read(file).split(/\r\n|[\n\r\u2028\u2029]/u).map(line => `// ${line}`).join('\n');
  assert(bundle.includes(commented), `Incomplete embedded license: ${file}`);
}
for (const source of [bundle, loader]) {
  assert(!/\brequire\s*\(\s*\\?["'](?:node:[^"'\\]*|fs|path|module)\\?["']/.test(source), 'Node filesystem/runtime dependency');
  assert(!/\bprocess\.(?:versions|env)\b/.test(source), 'Node environment dependency');
}
for (const name of ['occ_open', 'occ_convert', 'occ_trace', 'occ_check_lengths', 'occ_close']) {
  assert(loader.includes(`_${name}`), `Missing native ABI: ${name}`);
}
assert(!wasm.includes(Buffer.from('DEBUG_TRACE_ALLOC')), 'Temporary allocation probe still present');
const hash = createHash('sha256').update(wasm).digest('hex');
const wat = `build/engine/verified-${hash.slice(0, 12)}.wat`;
const sdk = process.env.EMSDK ?? join(homedir(), 'Local/Cloned/emsdk');
execFileSync(join(sdk, 'upstream/bin/wasm-dis'), [join(root, 'build/engine/opencc.wasm'), '-o', join(root, wat)]);
assert(/^\s*\(memory \S+ 512 4096\)\s*$/m.test(read(wat)), 'Expected 32 MiB initial / 256 MiB maximum WASM memory');
console.log(`Production artifact verified: ${Buffer.byteLength(bundle)} bytes; licenses complete; tests/fixtures/Node dependencies excluded; WASM memory 32/256 MiB.`);
