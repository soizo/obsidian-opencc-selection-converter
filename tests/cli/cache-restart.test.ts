import type { TestPlugin } from './fixtures';
import { engine } from './engine.test';
import { equal, ok } from './assert';
import { SchemeStore } from '../../src/schemes/store';
import { prepareScheme, loadPrepared } from '../../src/schemes/resources';

export function cacheRestartTests(plugin: TestPlugin, prepare: boolean, origin?: string, ticket?: string) {
  return [{ name: prepare ? 'cache/restart-prepare' : 'cache/restart-offline', run: async () => {
    ok(ticket && /^[a-f0-9-]{36}$/.test(ticket), 'Invalid restart ticket');
    const path = `.opencc-test-results/restart-${ticket}.json`;
    if (prepare) {
      ok(origin && /^http:\/\/127\.0\.0\.1:\d+$/.test(origin), 'Missing loopback fixture');
      const definition = { id: crypto.randomUUID(), name: 'Restart fixture', source: { kind: 'url' as const, location: `${origin}/config.json` }, approvedHttpUrls: [`${origin}/config.json`, `${origin}/dict.txt`] };
      const signal = new AbortController().signal;
      const snapshot = await loadPrepared(plugin.app, await prepareScheme(plugin.app, definition, signal), engine(plugin), signal);
      const store = new SchemeStore(plugin.app, engine(plugin));
      await store.load();
      await store.activate(definition, snapshot);
      await plugin.app.vault.adapter.write(path, JSON.stringify({ id: definition.id, snapshotId: snapshot.id }));
    } else {
      const store = (plugin as TestPlugin & { store?: SchemeStore }).store;
      ok(store, 'Production plugin did not restore SchemeStore');
      let saved: { id: string; snapshotId: string };
      try { saved = JSON.parse(await plugin.app.vault.adapter.read(path)); }
      catch { throw new Error('Invalid restart ticket contents'); }
      const snapshot = await store.getActive(saved.id);
      equal(snapshot.id, saved.snapshotId);
      equal(await engine(plugin).convertPlain(snapshot, '软件', new AbortController().signal), '軟體');
      await store.remove(saved.id);
    }
  } }];
}
