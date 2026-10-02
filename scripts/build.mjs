import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: ['obsidian', '@codemirror/state', '@codemirror/view', '@codemirror/language', '@codemirror/commands', '@lezer/common'],
  define: { __TEST__: String(process.argv.includes('--test')) },
  treeShaking: true,
  minifySyntax: true,
  sourcemap: false,
  logLevel: 'warning',
});
for (const name of ['manifest.json', 'versions.json']) {
  await copyFile(new URL(`../${name}`, import.meta.url), new URL(`../dist/${name}`, import.meta.url));
}
