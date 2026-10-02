import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const clean = await mkdtemp(join(tmpdir(), 'opencc-clean-build-'));
try {
  // Include pending additions, but never ignored local build outputs or SDKs.
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' });
  for (const file of new Set(files.split('\0').filter(Boolean))) {
    await mkdir(dirname(join(clean, file)), { recursive: true });
    await copyFile(join(root, file), join(clean, file));
  }
  execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: clean, stdio: 'inherit' });
  execFileSync('npm', ['run', 'build'], { cwd: clean, stdio: 'inherit' });
  const bundle = await readFile(join(clean, 'dist/main.js'), 'utf8');
  assert(bundle.length > 0);
  assert.equal(await readFile(join(clean, 'dist/styles.css'), 'utf8'), await readFile(join(clean, 'styles.css'), 'utf8'), 'Ship the dialog layout styles');
  assert(!/\bimport\s*\(/u.test(bundle), 'Release must not dynamically import executable code');
  console.log('PASS clean source build without local native outputs');
} finally {
  await rm(clean, { recursive: true, force: true });
}
