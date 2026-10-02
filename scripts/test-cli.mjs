import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startFixtureServer } from '../tests/fixture-server.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const vaultName = 'OpenCC-Selection-Converter-Test';
const expectedVault = path.join(homedir(), 'Desktop/PlayGround', vaultName);
const pluginId = 'opencc-selection-converter';
const suites = process.argv.slice(2).length ? process.argv.slice(2) : ['all'];
let fixture;

async function exists(file) {
  try { await stat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function cli(...args) {
  const { stdout, stderr } = await exec('obsidian', [`vault=${vaultName}`, ...args], {
    cwd: root, timeout: 120000, maxBuffer: 1024 * 1024,
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
  await cli('plugins:restrict', 'off');
  await cli('plugin:disable', `id=${pluginId}`);
  // Every top-level CLI invocation starts from an empty plugin cache in the dedicated synthetic vault.
  // Reloads within this invocation retain it, so restart/offline recovery tests remain real.
  const cacheDir = path.join(pluginDir, 'cache');
  if (await exists(cacheDir)) { await ensureInside(vault, cacheDir); await rm(cacheDir, { recursive: true, force: true }); }
  for (const name of ['main.js', 'manifest.json', 'versions.json']) {
    const destination = path.join(pluginDir, name);
    if (await exists(destination)) await ensureInside(vault, destination);
    await copyFile(path.join(root, 'dist', name), destination);
  }
  const reloadMarker = randomUUID();
  await evaluate(`window.__openccCliReloadMarker=${JSON.stringify(reloadMarker)}`);
  await cli('reload');
  const reloadDeadline = Date.now() + 30000;
  while (Date.now() < reloadDeadline) {
    try {
      if (await evaluate(`window.__openccCliReloadMarker ?? 'reloaded'`) === '=> reloaded') break;
    } catch { /* Renderer is between contexts. */ }
    await delay(250);
  }
  if (await evaluate(`window.__openccCliReloadMarker ?? 'reloaded'`) !== '=> reloaded') throw new Error('Vault reload did not replace the renderer context');
  await waitForWorkspace();
  await guardVault(expectedVault);
  for (const folder of ['.opencc-test-results', '__opencc_tests__']) {
    const directory = path.join(vault, folder);
    if (await exists(directory)) await ensureInside(vault, directory);
  }
  let pluginLoaded = false;
  for (let attempt = 0; attempt < 3 && !pluginLoaded; attempt++) {
    await cli('plugin:enable', `id=${pluginId}`, 'filter=community');
    await cli('plugin:reload', `id=${pluginId}`);
    await delay(500);
    pluginLoaded = await evaluate(`Boolean(app.plugins.plugins['${pluginId}']?.runCliSuite)`) === '=> true';
    if (!pluginLoaded) await delay(1000);
  }
  if (!pluginLoaded) throw new Error('Test plugin did not remain loaded after vault reload');

  if (suites.some(suite => ['all', 'resources', 'cache', 'settings'].includes(suite))) fixture = await startFixtureServer();
  let passed = 1;
  let failed = 0;
  const context = { fixtureOrigin: fixture?.origin, restartTicket: randomUUID() };
  const allSuites = ['smoke', 'engine', 'trace', 'config', 'resources', 'cache', 'markdown', 'latex', 'mapping', 'editor', 'settings'];
  const execution = [
    ...suites.flatMap(suite => suite === 'all' ? allSuites : [suite]),
    ...(suites.some(suite => ['all', 'cache'].includes(suite)) ? ['cache-restart-prepare', 'cache-restart'] : []),
  ];
  for (const suite of execution) {
    if (suite === 'cache-restart') {
      await fixture.close();
      fixture = undefined;
      await cli('plugin:reload', `id=${pluginId}`);
    }
    const runId = randomUUID();
    const output = await evaluate(`(async()=>{const p=app.plugins.plugins['${pluginId}']; if(!p?.runCliSuite) throw new Error('Test plugin not loaded'); await p.runCliSuite(${JSON.stringify(suite)},${JSON.stringify(runId)},${JSON.stringify(context)}); return 'report:'+${JSON.stringify(runId)}})()`);
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
finally { if (fixture) await fixture.close(); }
