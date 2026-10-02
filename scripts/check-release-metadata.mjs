import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const expected = process.argv[2];
assert(expected && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expected), `Invalid release version: ${expected ?? ''}`);

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (cause) { throw new Error(`Invalid release metadata: ${path}`, { cause }); }
}
const [manifest, packageJson, lock, versions] = await Promise.all([
  readJson('manifest.json'),
  readJson('package.json'),
  readJson('package-lock.json'),
  readJson('versions.json'),
]);

assert.equal(manifest.version, expected, 'manifest.json version must match the release version');
assert.equal(packageJson.version, expected, 'package.json version must match the release version');
assert.equal(lock.version, expected, 'package-lock.json version must match the release version');
assert.equal(lock.packages?.['']?.version, expected, 'package-lock.json root package version must match the release version');
assert.equal(versions[expected], manifest.minAppVersion, 'versions.json must map the release version to minAppVersion');
console.log(`Release metadata matches ${expected}.`);
