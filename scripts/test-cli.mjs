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
    cwd: root, timeout: 240000, maxBuffer: 1024 * 1024,
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

async function runProduction(pluginId) {
  const name = `Production A ${randomUUID()}`;
  const secondName = `Production B ${randomUUID()}`;
  const chainName = `Production chain ${randomUUID()}`;
  const folder = '__opencc_production__';
  const configPath = `${folder}/config-${randomUUID()}.json`;
  const secondConfigPath = `${folder}/config-${randomUUID()}.json`;
  const notePath = `${folder}/note-${randomUUID()}.md`;
  const result = await evaluate(`(async()=>{
    const wait=async(test,label)=>{const end=Date.now()+20000;while(!test()&&Date.now()<end)await new Promise(r=>setTimeout(r,50));if(!test())throw new Error(label)};
    let uiDoc=document;
    const labels={
      add:['Add scheme','添加方案'], name:['Scheme name','方案名称'], source:['Config source','配置来源'],
      location:['Config location','配置位置'],
      load:['Save','保存'], default:['Default scheme','默认方案'],
      title:['Add scheme','添加方案']
    };
    const matches=(key,text)=>labels[key].includes(text);
    const button=key=>{const el=[...uiDoc.querySelectorAll('button')].filter(x=>matches(key,x.textContent)&&!x.disabled).at(-1);if(!el)throw new Error('Missing button: '+key);el.click()};
    const field=(key,value)=>{const el=[...uiDoc.querySelectorAll('[aria-label]')].filter(x=>matches(key,x.getAttribute('aria-label'))).at(-1);if(!el)throw new Error('Missing field: '+key);el.value=value;el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}))};
    const p=app.plugins.plugins[${JSON.stringify(pluginId)}];
    if(!p||p.runCliSuite!==undefined)throw new Error('Not a production plugin');
    let folder=app.vault.getAbstractFileByPath(${JSON.stringify(folder)});if(!folder)await app.vault.createFolder(${JSON.stringify(folder)});
    const config=JSON.stringify({conversion_chain:[{dict:{type:'inline',entries:{'软件':'軟件'}}}]});
    const secondConfig=JSON.stringify({conversion_chain:[{dict:{type:'inline',entries:{'軟件':'軟體'}}}]});
    let configFile=app.vault.getAbstractFileByPath(${JSON.stringify(configPath)});configFile?await app.vault.modify(configFile,config):configFile=await app.vault.create(${JSON.stringify(configPath)},config);
    let secondConfigFile=app.vault.getAbstractFileByPath(${JSON.stringify(secondConfigPath)});secondConfigFile?await app.vault.modify(secondConfigFile,secondConfig):secondConfigFile=await app.vault.create(${JSON.stringify(secondConfigPath)},secondConfig);
    let note=app.vault.getAbstractFileByPath(${JSON.stringify(notePath)});note?await app.vault.modify(note,'前软件后'):note=await app.vault.create(${JSON.stringify(notePath)},'前软件后');
    app.setting.open();await new Promise(r=>setTimeout(r,500));app.setting.openTabById(${JSON.stringify(pluginId)});
    await wait(()=>app.setting.activeTab?.id===${JSON.stringify(pluginId)},'settings tab');uiDoc=app.setting.tabContentContainer.ownerDocument;
    await wait(()=>[...uiDoc.querySelectorAll('button')].some(x=>matches('add',x.textContent)),'settings');
    button('add');field('source','vault');field('name',${JSON.stringify(name)});field('location',${JSON.stringify(configPath)});button('load');
    await wait(()=>uiDoc.body.textContent.includes(${JSON.stringify(name)})&&![...uiDoc.querySelectorAll('.modal-title')].some(x=>matches('title',x.textContent)),'first activation');
    button('add');field('source','vault');field('name',${JSON.stringify(secondName)});field('location',${JSON.stringify(secondConfigPath)});button('load');
    await wait(()=>uiDoc.body.textContent.includes(${JSON.stringify(secondName)})&&![...uiDoc.querySelectorAll('.modal-title')].some(x=>matches('title',x.textContent)),'second activation');
    button('add');field('source','chain');field('name',${JSON.stringify(chainName)});
    const addStep=()=>{const el=uiDoc.querySelector('[data-opencc-add-step]');if(!el)throw new Error('Missing add step');el.click()};
    addStep();await wait(()=>uiDoc.querySelectorAll('[data-opencc-chain-step]').length===1,'first chain step');
    addStep();await wait(()=>uiDoc.querySelectorAll('[data-opencc-chain-step]').length===2,'second chain step');
    const stepSelects=[...uiDoc.querySelectorAll('[data-opencc-chain-step]')];const secondOption=[...stepSelects[1].options].find(x=>x.textContent===${JSON.stringify(secondName)});if(!secondOption)throw new Error('Missing second chain option');stepSelects[1].value=secondOption.value;stepSelects[1].dispatchEvent(new Event('change',{bubbles:true}));
    await wait(()=>[...uiDoc.querySelectorAll('[data-opencc-chain-step]')][1]?.dataset.openccResolved===secondOption.value,'resolve second chain step');button('load');
    await wait(()=>uiDoc.body.textContent.includes(${JSON.stringify(chainName)})&&![...uiDoc.querySelectorAll('.modal-title')].some(x=>matches('title',x.textContent)),'chain activation');
    const select=[...app.setting.tabContentContainer.querySelectorAll('select[aria-label]')].find(x=>matches('default',x.getAttribute('aria-label')));const option=[...select.options].find(x=>x.textContent?.startsWith(${JSON.stringify(chainName)}));if(!option)throw new Error('Missing default chain option');select.value=option.value;select.dispatchEvent(new Event('change',{bubbles:true}));
    await new Promise(r=>setTimeout(r,300));app.setting.close();
    const leaf=app.workspace.getLeaf(false);await leaf.openFile(note,{state:{mode:'source',source:true}});const view=leaf.view;await view.setState({...view.getState(),mode:'source',source:true},{history:false});
    await wait(()=>view.editor.getValue()==='前软件后','note open');view.editor.setSelection({line:0,ch:1},{line:0,ch:3});await app.commands.executeCommandById(${JSON.stringify(`${pluginId}:convert-default`)});await wait(()=>view.editor.getValue()==='前軟體后','conversion');view.editor.undo();await wait(()=>view.editor.getValue()==='前软件后','undo');
    return JSON.stringify({production:true,testHook:false,commands:['convert-default','convert-with-scheme'],conversion:true,undo:true});
  })()`);
  if (!result.includes('"production":true') || !result.includes('"undo":true')) throw new Error(`Production workflow failed: ${result}`);
  console.log(`PASS production/install-and-workflow ${result.replace(/^=> /, '')}`);
}

async function main() {
  await waitForWorkspace();
  const vault = await guardVault(expectedVault);
  let rejected = false;
  try { await guardVault(`${expectedVault}-not-the-approved-vault`); }
  catch (error) { if (!String(error).includes('VAULT_GUARD')) throw error; rejected = true; }
  if (!rejected) throw new Error('smoke/wrong-vault: guard allowed a different vault');
  console.log('PASS smoke/wrong-vault (read-only CLI check; no deployment writes yet)');

  const productionOnly = suites.length === 1 && suites[0] === 'production';
  await exec(process.execPath, [path.join(root, 'scripts/build.mjs'), ...(productionOnly ? [] : ['--test'])], { cwd: root, timeout: 60000 });
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
  for (const name of ['main.js', 'manifest.json', 'versions.json', 'styles.css']) {
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
    pluginLoaded = await evaluate(`Boolean(app.plugins.plugins['${pluginId}']${productionOnly ? '' : '?.runCliSuite'})`) === '=> true';
    if (!pluginLoaded) await delay(1000);
  }
  if (!pluginLoaded) throw new Error('Plugin did not remain loaded after vault reload');
  if (productionOnly) { await runProduction(pluginId); return; }

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
