import { requestUrl } from 'obsidian';
import { prepareScheme, loadPrepared } from '../../src/schemes/resources';
import type { SchemeDefinition } from '../../src/schemes/model';
import type { TestPlugin } from './fixtures';
import { engine } from './engine.test';
import { equal, ok, rejectsCode } from './assert';

export function resourcesTests(plugin: TestPlugin, fixtureOrigin?: string) {
  function remote(): SchemeDefinition {
    ok(fixtureOrigin && /^http:\/\/127\.0\.0\.1:\d+$/.test(fixtureOrigin), 'Missing approved loopback fixture');
    return { id: crypto.randomUUID(), name: 'HTTP fixture', source: { kind: 'url', location: `${fixtureOrigin}/config.json` }, approvedHttpUrls: [`${fixtureOrigin}/config.json`, `${fixtureOrigin}/dict.txt`] };
  }
  return [
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
    } },
    { name: 'resources/vault-files', run: async () => {
      const app = plugin.app;
      const folder = `__opencc_tests__/资源 ${crypto.randomUUID()}`;
      if (!app.vault.getAbstractFileByPath('__opencc_tests__')) await app.vault.createFolder('__opencc_tests__');
      await app.vault.createFolder(folder);
      await app.vault.create(`${folder}/字典 %.txt`, '软件\t軟體\n');
      await app.vault.create(`${folder}/配置.json`, JSON.stringify({ conversion_chain: [{ dict: { type: 'text', file: './字典 %.txt' } }] }));
      const definition: SchemeDefinition = { id: crypto.randomUUID(), name: 'vault fixture', source: { kind: 'vault', location: `${folder}/配置.json` } };
      const signal = new AbortController().signal;
      const loaded = await loadPrepared(app, await prepareScheme(app, definition, signal), engine(plugin), signal);
      equal(loaded.schemeId, definition.id);
      equal(loaded.resources[0]!.sha256.length, 64);
      equal(await engine(plugin).convertPlain(loaded, '软件', signal), '軟體');
      const renamed = await loadPrepared(app, await prepareScheme(app, { ...definition, name: 'renamed' }, signal), engine(plugin), signal);
      equal(renamed.sourceKey, loaded.sourceKey);
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
