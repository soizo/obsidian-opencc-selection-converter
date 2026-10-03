import { requestUrl } from 'obsidian';
import { isChainDefinition, prepareScheme, loadPrepared } from '../../src/schemes/resources';
import { presetDefinition } from '../../src/schemes/presets';
import type { ChainSchemeDefinition, SingleSchemeDefinition } from '../../src/schemes/model';
import type { TestPlugin } from './fixtures';
import { engine } from './engine.test';
import { equal, ok, rejectsCode } from './assert';

export function liveResourcesTests(plugin: TestPlugin) {
  return [{ name: 'resources/mainland-traditional-cdn', run: async () => {
    const signal = new AbortController().signal;
    const t2gov = presetDefinition('t2gov', 'Traditional → Mainland Traditional');
    const t2govSnapshot = await loadPrepared(plugin.app, await prepareScheme(plugin.app, t2gov, signal), engine(plugin), signal);
    equal(await engine(plugin).convertPlain(t2govSnapshot, '啟淨一併只不過', signal), '啓净一并衹不過');
    const s2gov = presetDefinition('s2gov', 'Simplified → Mainland Traditional');
    const s2govSnapshot = await loadPrepared(plugin.app, await prepareScheme(plugin.app, s2gov, signal), engine(plugin), signal);
    equal(await engine(plugin).convertPlain(s2govSnapshot, '启动干净合并只不过', signal), '啓動乾净合并衹不過');
  } }];
}

export function resourcesTests(plugin: TestPlugin, fixtureOrigin?: string) {
  function remote(): SingleSchemeDefinition {
    ok(fixtureOrigin && /^http:\/\/127\.0\.0\.1:\d+$/.test(fixtureOrigin), 'Missing approved loopback fixture');
    return { id: crypto.randomUUID(), name: 'HTTP fixture', source: { kind: 'url', location: `${fixtureOrigin}/config.json` }, approvedHttpUrls: [`${fixtureOrigin}/config.json`, `${fixtureOrigin}/dict.txt`] };
  }
  return [
    { name: 'resources/mainland-traditional-presets', run: async () => {
      ok(fixtureOrigin && /^http:\/\/127\.0\.0\.1:\d+$/.test(fixtureOrigin), 'Missing approved loopback fixture');
      const govUrls = [`${fixtureOrigin}/gov/t2gov.json`, `${fixtureOrigin}/gov/CJK_Compatibility_Ideographs.txt`, `${fixtureOrigin}/gov/TGPhrases.txt`, `${fixtureOrigin}/gov/TGCharacters.txt`];
      const localGov = (definition: SingleSchemeDefinition): SingleSchemeDefinition => ({ ...definition, source: { kind: 'url', location: govUrls[0]! }, approvedHttpUrls: govUrls });
      const t2gov = presetDefinition('t2gov', 'Traditional → Mainland Traditional');
      ok(!isChainDefinition(t2gov));
      const t2govSnapshot = await loadPrepared(plugin.app, await prepareScheme(plugin.app, localGov(t2gov), new AbortController().signal), engine(plugin), new AbortController().signal);
      equal(await engine(plugin).convertPlain(t2govSnapshot, '啟淨一併只不過', new AbortController().signal), '啓净一并衹不過');

      const s2gov = presetDefinition('s2gov', 'Simplified → Mainland Traditional');
      ok(isChainDefinition(s2gov));
      const officialUrls = [
        `${fixtureOrigin}/official/s2t.json`, `${fixtureOrigin}/official/assets/CJK_Compatibility_Ideographs.ocd2`, `${fixtureOrigin}/official/assets/STPhrases.ocd2`,
        `${fixtureOrigin}/official/assets/STPhrases_GeneratedFromRegionalPhrases.ocd2`, `${fixtureOrigin}/official/assets/STCharacters.ocd2`,
      ];
      const first = { ...s2gov.source.steps[0]!, source: { kind: 'url' as const, location: officialUrls[0]! }, dependencyBase: `${fixtureOrigin}/official/assets/`, approvedHttpUrls: officialUrls };
      const second = localGov(s2gov.source.steps[1]!);
      const localChain: ChainSchemeDefinition = { ...s2gov, source: { kind: 'chain', steps: [first, second] } };
      const s2govSnapshot = await loadPrepared(plugin.app, await prepareScheme(plugin.app, localChain, new AbortController().signal), engine(plugin), new AbortController().signal);
      equal(await engine(plugin).convertPlain(s2govSnapshot, '启动干净合并只不过', new AbortController().signal), '啓動乾净合并衹不過');
      const firstSnapshot = await loadPrepared(plugin.app, await prepareScheme(plugin.app, first, new AbortController().signal), engine(plugin), new AbortController().signal);
      equal(await engine(plugin).convertPlain(s2govSnapshot, '启动干净合并只不过', new AbortController().signal), await engine(plugin).convertPlain(t2govSnapshot, await engine(plugin).convertPlain(firstSnapshot, '启动干净合并只不过', new AbortController().signal), new AbortController().signal));
    } },
    { name: 'resources/no-note-upload', run: async () => {
      const definition = remote();
      const signal = new AbortController().signal;
      const plan = await prepareScheme(plugin.app, definition, signal);
      equal(plan.resources.length, 1);
      const client = engine(plugin);
      const snapshot = await loadPrepared(plugin.app, plan, client, signal);
      const before = (await requestUrl(`${fixtureOrigin}/requests`)).json;
      equal(await client.convertPlain(snapshot, '独特正文哨兵软件', signal), '独特正文哨兵軟體');
      equal((await requestUrl(`${fixtureOrigin}/requests`)).json, before);
      ok(before.every((entry: {method: string; path: string}) => entry.method === 'GET' && !entry.path.includes('独特正文哨兵')));
    } },
    { name: 'resources/http-consent', run: async () => {
      const definition = remote();
      await rejectsCode(prepareScheme(plugin.app, { ...definition, approvedHttpUrls: [] }, new AbortController().signal), 'HTTP_CONFIRMATION_REQUIRED');
      const plan = await prepareScheme(plugin.app, { ...definition, approvedHttpUrls: [definition.source.location] }, new AbortController().signal);
      await rejectsCode(loadPrepared(plugin.app, plan, engine(plugin), new AbortController().signal), 'HTTP_CONFIRMATION_REQUIRED');
      const approved = remote();
      const denied = { ...remote(), approvedHttpUrls: [] };
      const chain: ChainSchemeDefinition = { id: crypto.randomUUID(), name: 'HTTP chain', source: { kind: 'chain', steps: [approved, denied] } };
      await rejectsCode(prepareScheme(plugin.app, chain, new AbortController().signal), 'HTTP_CONFIRMATION_REQUIRED');
      equal(approved.approvedHttpUrls, [`${fixtureOrigin}/config.json`, `${fixtureOrigin}/dict.txt`]);
      equal(denied.approvedHttpUrls, []);
    } },
    { name: 'resources/vault-files', run: async () => {
      const app = plugin.app;
      const folder = `__opencc_tests__/资源 ${crypto.randomUUID()}`;
      if (!app.vault.getAbstractFileByPath('__opencc_tests__')) await app.vault.createFolder('__opencc_tests__');
      await app.vault.createFolder(folder);
      await app.vault.create(`${folder}/字典 %.txt`, '软件\t軟體\n');
      await app.vault.create(`${folder}/配置.json`, JSON.stringify({ conversion_chain: [{ dict: { type: 'text', file: './字典 %.txt' } }] }));
      const definition: SingleSchemeDefinition = { id: crypto.randomUUID(), name: 'vault fixture', source: { kind: 'vault', location: `${folder}/配置.json` } };
      const signal = new AbortController().signal;
      const loaded = await loadPrepared(app, await prepareScheme(app, definition, signal), engine(plugin), signal);
      equal(loaded.schemeId, definition.id);
      equal(loaded.resources[0]!.sha256.length, 64);
      equal(await engine(plugin).convertPlain(loaded, '软件', signal), '軟體');
      const renamed = await loadPrepared(app, await prepareScheme(app, { ...definition, name: 'renamed' }, signal), engine(plugin), signal);
      equal(renamed.sourceKey, loaded.sourceKey);
    } },
    { name: 'resources/non-error-rejection', run: async () => {
      const app = plugin.app;
      if (!app.vault.getAbstractFileByPath('__opencc_tests__')) await app.vault.createFolder('__opencc_tests__');
      const file = await app.vault.create(`__opencc_tests__/rejection-${crypto.randomUUID()}.json`, '{"conversion_chain":[]}');
      const original = app.vault.readBinary;
      try {
        app.vault.readBinary = async target => {
          if (target === file) return Promise.reject(undefined);
          return original.call(app.vault, target);
        };
        await rejectsCode(prepareScheme(app, { id: crypto.randomUUID(), name: 'rejection', source: { kind: 'vault', location: file.path } }, new AbortController().signal), 'RESOURCE_READ');
      } finally { app.vault.readBinary = original; }
    } },
    { name: 'resources/cancel-and-failure', run: async () => {
      const definition = remote();
      const cancelled = new AbortController();
      cancelled.abort();
      await rejectsCode(prepareScheme(plugin.app, definition, cancelled.signal), 'CANCELLED');
      const bad = { ...definition, source: { kind: 'url' as const, location: `${fixtureOrigin}/bad-config.json` }, approvedHttpUrls: [`${fixtureOrigin}/bad-config.json`, `${fixtureOrigin}/missing.txt`] };
      const plan = await prepareScheme(plugin.app, bad, new AbortController().signal);
      await rejectsCode(loadPrepared(plugin.app, plan, engine(plugin), new AbortController().signal), 'RESOURCE_HTTP');
    } },
  ];
}
