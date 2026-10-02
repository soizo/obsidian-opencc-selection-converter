import type { TestPlugin } from './fixtures';
import { engine } from './engine.test';
import { equal, ok, rejectsCode } from './assert';
import { SchemeStore } from '../../src/schemes/store';
import { loadPrepared, prepareScheme } from '../../src/schemes/resources';
import type { SchemeDefinition } from '../../src/schemes/model';
import { DEFAULT_RULES } from '../../src/selection/types';

export function cacheTests(plugin: TestPlugin) {
  const app = plugin.app;
  const signal = new AbortController().signal;
  async function fixture() {
    if (!app.vault.getAbstractFileByPath('__opencc_tests__')) await app.vault.createFolder('__opencc_tests__');
    const id = crypto.randomUUID();
    const file = await app.vault.create(`__opencc_tests__/cache-${id}.json`, JSON.stringify({ conversion_chain: [{ dict: { type: 'inline', entries: { 软件: '軟體' } } }] }));
    const definition: SchemeDefinition = { id, name: 'Cache fixture', source: { kind: 'vault', location: file.path } };
    const snapshot = await loadPrepared(app, await prepareScheme(app, definition, signal), engine(plugin), signal);
    const store = new SchemeStore(app, engine(plugin));
    await store.load();
    await store.activate(definition, snapshot);
    return { definition, snapshot, store, file };
  }
  return [
    { name: 'cache/refresh-fallback', run: async () => {
      const { definition, snapshot, file } = await fixture();
      await app.vault.modify(file, '{invalid');
      await rejectsCode(prepareScheme(app, definition, signal), 'INVALID_CONFIG');
      const recovered = new SchemeStore(app, engine(plugin));
      await recovered.load();
      const active = await recovered.getActive(definition.id);
      equal(active.id, snapshot.id);
      equal(await engine(plugin).convertPlain(active, '软件', signal), '軟體');
    } },
    { name: 'cache/interrupted-commit', run: async () => {
      const { definition, snapshot, store, file } = await fixture();
      await app.vault.modify(file, JSON.stringify({ conversion_chain: [{ dict: { type: 'inline', entries: { 软件: '軟件' } } }] }));
      const next = await loadPrepared(app, await prepareScheme(app, definition, signal), engine(plugin), signal);
      const adapter = app.vault.adapter;
      const original = adapter.write;
      let interrupted = false;
      adapter.write = async function(path, data, options) {
        if (/\/cache\/state-[01]\.json$/.test(path)) {
          interrupted = true;
          await original.call(this, path, data.slice(0, Math.floor(data.length / 2)), options);
          throw new Error('Injected interrupted metadata write');
        }
        return original.call(this, path, data, options);
      };
      try { await rejectsCode(store.activate(definition, next), 'CACHE_WRITE'); }
      finally { adapter.write = original; }
      ok(interrupted, 'Did not exercise metadata interruption');
      equal((await store.getActive(definition.id)).id, snapshot.id);
      const recovered = new SchemeStore(app, engine(plugin));
      await recovered.load();
      equal((await recovered.getActive(definition.id)).id, snapshot.id);
    } },
    { name: 'cache/draft-rules-default-removal', run: async () => {
      const { definition, snapshot, store, file } = await fixture();
      const draft = { ...definition, source: { kind: 'vault' as const, location: `${file.path}.missing` } };
      await store.saveDraft(draft);
      const rules = { ...structuredClone(DEFAULT_RULES), force: true };
      rules.regions.inlineCode = 'never';
      await store.saveRules(rules);
      await store.setDefault(definition.id);
      const recovered = new SchemeStore(app, engine(plugin));
      await recovered.load();
      equal(recovered.getDraft(definition.id), draft);
      equal(recovered.getRules(), rules);
      equal(recovered.getDefaultId(), definition.id);
      equal((await recovered.getActive(definition.id)).id, snapshot.id);
      equal(recovered.getDefinitions().find(item => item.id === definition.id), definition);
      await rejectsCode(recovered.setDefault('missing-scheme'), 'NO_SCHEME');
      await recovered.remove(definition.id);
      const after = new SchemeStore(app, engine(plugin));
      await after.load();
      equal(after.getDefaultId(), null);
      equal(after.getDraft(definition.id), null);
      ok(!after.getDefinitions().some(item => item.id === definition.id));
      ok(app.vault.getAbstractFileByPath(file.path), 'Removal deleted a source file');
    } },
    { name: 'cache/corrupt-marker-fallback', run: async () => {
      const { definition, snapshot, store, file } = await fixture();
      await app.vault.modify(file, JSON.stringify({ conversion_chain: [{ dict: { type: 'inline', entries: { 软件: '軟件' } } }] }));
      const next = await loadPrepared(app, await prepareScheme(app, definition, signal), engine(plugin), signal);
      await store.activate(definition, next);
      await app.vault.adapter.write(`${app.vault.configDir}/plugins/opencc-selection-converter/cache/${next.id}/complete.json`, '{truncated');
      const recovered = new SchemeStore(app, engine(plugin));
      await recovered.load();
      equal((await recovered.getActive(definition.id)).id, snapshot.id);
    } },
    { name: 'cache/name-only-reuse', run: async () => {
      const { definition, snapshot, store } = await fixture();
      await store.saveDraft({ ...definition, name: 'Renamed' });
      await store.activate({ ...definition, name: 'Renamed' }, snapshot);
      equal(store.getDraft(definition.id), null);
      equal(store.getDefinitions().find(item => item.id === definition.id)?.name, 'Renamed');
      equal((await store.getActive(definition.id)).id, snapshot.id);
    } },
    { name: 'cache/vault-dirty', run: async () => {
      const { definition, snapshot, store, file } = await fixture();
      equal(store.getStatus(definition.id).kind, 'ready');
      await store.setStatus(definition.id, { kind: 'loading', warnings: [] });
      equal(store.getStatus(definition.id).kind, 'loading');
      await store.setStatus(definition.id, { kind: 'ready', warnings: [] });
      await app.vault.modify(file, JSON.stringify({ name: 'changed', conversion_chain: [{ dict: { type: 'inline', entries: { 软件: '軟件' } } }] }));
      equal(store.getStatus(definition.id).kind, 'dirty');
      equal((await store.getActive(definition.id)).id, snapshot.id);
      const next = await loadPrepared(app, await prepareScheme(app, definition, signal), engine(plugin), signal);
      await store.activate(definition, next);
      equal(store.getStatus(definition.id).kind, 'ready');
      await app.vault.rename(file, `${file.path}.renamed`);
      equal(store.getStatus(definition.id).kind, 'dirty');
      await app.vault.delete(file);
      equal(store.getStatus(definition.id).kind, 'dirty');
      equal(await engine(plugin).convertPlain(await store.getActive(definition.id), '软件', signal), '軟件');
    } },
    { name: 'cache/corrupt-resource-fallback', run: async () => {
      const { definition, snapshot, store, file } = await fixture();
      const dictionary = await app.vault.create(`${file.path}.txt`, '软件\t軟件\n');
      await app.vault.modify(file, JSON.stringify({ conversion_chain: [{ dict: { type: 'text', file: dictionary.name } }] }));
      const next = await loadPrepared(app, await prepareScheme(app, definition, signal), engine(plugin), signal);
      await store.activate(definition, next);
      await app.vault.adapter.writeBinary(`${app.vault.configDir}/plugins/opencc-selection-converter/cache/${next.id}/0.bin`, new Uint8Array([0]).buffer);
      const recovered = new SchemeStore(app, engine(plugin));
      await recovered.load();
      equal((await recovered.getActive(definition.id)).id, snapshot.id);
    } },
    { name: 'cache/two-version-retention', run: async () => {
      const { definition, snapshot, store } = await fixture();
      const second = await loadPrepared(app, await prepareScheme(app, definition, signal), engine(plugin), signal);
      await store.activate(definition, second);
      const third = await loadPrepared(app, await prepareScheme(app, definition, signal), engine(plugin), signal);
      await store.activate(definition, third);
      const root = `${app.vault.configDir}/plugins/opencc-selection-converter/cache`;
      ok(!await app.vault.adapter.exists(`${root}/${snapshot.id}`), 'Obsolete snapshot retained');
      ok(await app.vault.adapter.exists(`${root}/${second.id}/complete.json`));
      ok(await app.vault.adapter.exists(`${root}/${third.id}/complete.json`));
      await store.remove(definition.id);
      ok(!await app.vault.adapter.exists(`${root}/${second.id}`));
      ok(!await app.vault.adapter.exists(`${root}/${third.id}`));
    } },
    { name: 'cache/all-metadata-invalid', run: async () => {
      await fixture();
      const root = `${app.vault.configDir}/plugins/opencc-selection-converter/cache`;
      const adapter = app.vault.adapter;
      const saved = await Promise.all([0, 1].map(slot => adapter.read(`${root}/state-${slot}.json`)));
      try {
        for (const slot of [0, 1]) await adapter.write(`${root}/state-${slot}.json`, '{truncated');
        const broken = new SchemeStore(app, engine(plugin));
        await rejectsCode(broken.load(), 'CACHE_INVALID');
      } finally {
        for (const slot of [0, 1]) await adapter.write(`${root}/state-${slot}.json`, saved[slot]!);
      }
    } },
    { name: 'cache/source-identity', run: async () => {
      const { definition, snapshot, store } = await fixture();
      const changed = { ...definition, source: { kind: 'vault' as const, location: `${definition.source.location}.missing` } };
      await rejectsCode(store.activate(changed, snapshot), 'SNAPSHOT_IDENTITY');
      equal(store.getDefinitions().find(item => item.id === definition.id)?.source.location, definition.source.location);
      equal((await store.getActive(definition.id)).sourceKey, snapshot.sourceKey);
    } },
  ];
}
