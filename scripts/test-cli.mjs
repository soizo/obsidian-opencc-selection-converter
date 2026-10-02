import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const vaultName = 'OpenCC-Selection-Converter-Test';
const expectedVault = path.join(homedir(), 'Desktop/PlayGround', vaultName);
const pluginId = 'opencc-selection-converter';
const suites = process.argv.slice(2).length ? process.argv.slice(2) : ['all'];

async function exists(file) {
  try { await stat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function cli(...args) {
  const { stdout, stderr } = await exec('obsidian', [`vault=${vaultName}`, ...args], {
    cwd: root, timeout: 60000, maxBuffer: 1024 * 1024,
  });
  if (stderr.trim()) process.stderr.write(stderr);
  return stdout.trim();
}

async function evaluate(code) {
  const encoded = Buffer.from(code).toString('base64');
  return cli('eval', `code=eval(Buffer.from('${encoded}','base64').toString('utf8'))`);
}

async function waitForWorkspace() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await evaluate('new Promise(resolve=>app.workspace.onLayoutReady(()=>resolve("opencc-cli-ready")))');
    if (result === '=> opencc-cli-ready') return;
    if (!result.includes('Command "eval" not found')) throw new Error(`Unexpected CLI readiness result: ${result}`);
    await delay(100);
  }
  throw new Error('Obsidian CLI did not become ready after vault reload');
}

async function guardVault(expected) {
  const observed = await cli('vault', 'info=path');
  if (path.resolve(observed) !== path.resolve(expected)) throw new Error('VAULT_GUARD: unexpected vault path; refusing all writes');
  const actual = await realpath(observed);
  if (actual !== await realpath(expected)) throw new Error('VAULT_GUARD: vault identity mismatch');
  return actual;
}

async function ensureInside(vault, directory) {
  const resolved = await realpath(directory);
  const relative = path.relative(vault, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('VAULT_GUARD: deployment path escapes test vault');
}

async function main() {
  await waitForWorkspace();
  const vault = await guardVault(expectedVault);
  let rejected = false;
  try { await guardVault(`${expectedVault}-not-the-approved-vault`); }
  catch (error) { if (!String(error).includes('VAULT_GUARD')) throw error; rejected = true; }
  if (!rejected) throw new Error('smoke/wrong-vault: guard allowed a different vault');
  console.log('PASS smoke/wrong-vault (read-only CLI check; no deployment writes yet)');

  await exec(process.execPath, [path.join(root, 'scripts/build.mjs'), '--test'], { cwd: root, timeout: 60000 });
  const configDir = path.join(vault, '.obsidian');
  await ensureInside(vault, configDir);
  const parent = path.join(configDir, 'plugins');
  if (!await exists(parent)) await mkdir(parent);
  await ensureInside(vault, parent);
  const pluginDir = path.join(parent, pluginId);
  const ownership = path.join(pluginDir, '.opencc-cli-owned');
  if (await exists(pluginDir)) {
    await ensureInside(vault, pluginDir);
    if (!await exists(ownership)) throw new Error('Refusing to overwrite a plugin not owned by this test driver');
  } else {
    await mkdir(pluginDir);
    await writeFile(ownership, 'Dedicated OpenCC CLI test deployment\n');
  }
  for (const name of ['main.js', 'manifest.json', 'versions.json']) {
    const destination = path.join(pluginDir, name);
    if (await exists(destination)) await ensureInside(vault, destination);
    await copyFile(path.join(root, 'dist', name), destination);
  }
  await cli('plugins:restrict', 'off');
  await waitForWorkspace();
  await guardVault(expectedVault);
  for (const folder of ['.opencc-test-results', '__opencc_tests__']) {
    const directory = path.join(vault, folder);
    if (await exists(directory)) await ensureInside(vault, directory);
  }
  await cli('plugin:enable', `id=${pluginId}`, 'filter=community');
  await cli('plugin:reload', `id=${pluginId}`);

  let passed = 1;
  let failed = 0;
  for (const suite of suites) {
    const runId = randomUUID();
    const output = await evaluate(`(async()=>{const p=app.plugins.plugins['${pluginId}']; if(!p?.runCliSuite) throw new Error('Test plugin not loaded'); await p.runCliSuite(${JSON.stringify(suite)},${JSON.stringify(runId)}); return 'report:'+${JSON.stringify(runId)}})()`);
    const reportPath = path.join(vault, '.opencc-test-results', `${runId}.json`);
    if (!await exists(reportPath)) throw new Error(`Missing fresh CLI report: ${output}`);
    await ensureInside(vault, reportPath);
    let report;
    try { report = JSON.parse(await readFile(reportPath, 'utf8')); }
    catch (cause) { throw new Error('Invalid CLI report', { cause }); }
    if (report.runId !== runId || report.suite !== suite || !Array.isArray(report.checks) || !report.checks.length) throw new Error('Stale or empty CLI report');
    for (const check of report.checks) {
      if (check.pass === true) { passed++; console.log(`PASS ${check.name}`); }
      else { failed++; console.error(`FAIL ${check.name}: ${check.error ?? 'unknown failure'}`); }
    }
  }
  console.log(`Obsidian CLI: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

try { await main(); }
catch (error) { console.error(String(error)); process.exitCode = 1; }
