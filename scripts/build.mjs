import { build } from 'esbuild';
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const engineDir = new URL('../engine/generated/', import.meta.url);
let nativeLoader;
let wasm;
try {
  [nativeLoader, wasm] = await Promise.all([
    readFile(new URL('opencc.mjs', engineDir), 'utf8'),
    readFile(new URL('opencc.wasm', engineDir)),
  ]);
} catch (cause) {
  throw new Error('Bundled native engine assets are missing; restore engine/generated or run npm run build:engine.', { cause });
}
const licenseDir = new URL('../engine/licenses/', import.meta.url);
const notices = await Promise.all(['LICENSE', 'THIRD_PARTY_NOTICES.md'].map(name => readFile(new URL(`../${name}`, import.meta.url), 'utf8')));
for (const name of (await readdir(licenseDir)).sort()) {
  notices.push(`\n=== ${name} ===\n${await readFile(new URL(name, licenseDir), 'utf8')}`);
}
// Line comments preserve license text, including musl's literal block-comment delimiters.
const licenseBanner = notices.join('\n').split(/\r\n|[\n\r\u2028\u2029]/u).map(line => `// ${line}`).join('\n');
const commonDefines = {
  __ENGINE_ID__: JSON.stringify(`opencc-wasm:${createHash('sha256').update(wasm).update(nativeLoader).digest('hex')}`),
  __WASM_BASE64__: JSON.stringify(wasm.toString('base64')),
};
const workerBuild = await build({
  absWorkingDir: root,
  entryPoints: ['src/engine/worker.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  define: commonDefines,
  write: false,
  minifySyntax: true,
  logLevel: 'warning',
});
const workerSource = workerBuild.outputFiles[0]?.text;
if (!workerSource) throw new Error('Worker build produced no JavaScript.');
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  loader: { '.ocd': 'binary', '.ocd2': 'binary' },
  banner: { js: licenseBanner },
  external: ['obsidian', '@codemirror/state', '@codemirror/view', '@codemirror/language', '@codemirror/commands', '@lezer/common'],
  define: {
    ...commonDefines,
    __WORKER_SOURCE__: JSON.stringify(workerSource),
    __TEST__: String(process.argv.includes('--test')),
  },
  treeShaking: true,
  minifySyntax: true,
  sourcemap: false,
  logLevel: 'warning',
});
for (const name of ['manifest.json', 'versions.json']) {
  await copyFile(new URL(`../${name}`, import.meta.url), new URL(`../dist/${name}`, import.meta.url));
}
