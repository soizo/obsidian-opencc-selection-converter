import { Menu, Modal, requestUrl, type Command } from 'obsidian';
import type { LengthReport } from '../../src/engine/types';
import type { EngineClient } from '../../src/engine/client';
import { ConverterSettingsTab } from '../../src/settings';
import { safeError, safeLocation } from '../../src/scheme-modal';
import { PluginError } from '../../src/errors';
import { DEFAULT_RULES } from '../../src/selection/types';
import { schemeSourceKey } from '../../src/schemes/resources';
import { snapshot } from './engine.test';
import type { SchemeStore } from '../../src/schemes/store';
import { equal, ok } from './assert';
import { openFixture, type TestPlugin } from './fixtures';

type Endpoint = TestPlugin & {
  store: SchemeStore;
  uiModals: Set<Modal>;
  schemeCommands: Map<string, Command>;
  lengthReports: Map<string, LengthReport>;
  engine: EngineClient;
  syncSchemeCommands(): void;
};
export function settingsTests(plugin: TestPlugin, fixtureOrigin?: string) {
  const endpoint = plugin as Endpoint;
  const button = (root: ParentNode, name: string) => {
    const element = Array.from(root.querySelectorAll('button')).filter(item => item.textContent === name && !item.disabled).at(-1);
    ok(element, `Missing button: ${name}`); element.click();
  };
  const field = (name: string, value: string) => {
    const element = Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(`[aria-label="${name}"]`)).at(-1);
    ok(element, `Missing field: ${name}`);
    element.value = value;
    element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  };
  const wait = async (condition: () => boolean, label = 'UI condition') => {
    const start = performance.now();
    while (!condition() && performance.now() - start < 10000) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    ok(condition(), `${label} timed out: ${Array.from(document.querySelectorAll('.modal-content')).at(-1)?.textContent?.slice(-1400)}`);
  };
  async function mounted(run: (root: HTMLElement) => Promise<void>) {
    const existing = new Set(endpoint.uiModals);
    const existingIds = new Set([...endpoint.store.getDefinitions(), ...endpoint.store.getDrafts()].map(item => item.id));
    const previousDefault = endpoint.store.getDefaultId();
    const host = new Modal(plugin.app);
    const tab = new ConverterSettingsTab(plugin.app, plugin);
    host.open(); tab.containerEl = host.contentEl; tab.display();
    try { await run(host.contentEl); }
    finally {
      for (const modal of [...endpoint.uiModals].reverse()) if (!existing.has(modal)) modal.close();
      tab.hide(); host.contentEl.empty(); host.close();
      const createdIds = new Set([...endpoint.store.getDefinitions(), ...endpoint.store.getDrafts()].map(item => item.id).filter(id => !existingIds.has(id)));
      for (const id of createdIds) await endpoint.store.remove(id);
      await endpoint.store.setDefault(previousDefault && endpoint.store.getDefinitions().some(item => item.id === previousDefault) ? previousDefault : null);
      endpoint.syncSchemeCommands();
    }
  }
  async function addPath(root: HTMLElement, name: string, path: string) {
    button(root, '添加方案');
    field('方案名称', name); field('配置来源', 'vault'); field('配置位置', path);
    button(document, '预览依赖');
    await wait(() => Array.from(document.querySelectorAll('button')).some(item => item.textContent === '确认并加载'));
    button(document, '确认并加载');
    await wait(() => endpoint.store.getDefinitions().some(item => item.name === name), 'Activate new UI scheme');
    const definition = endpoint.store.getDefinitions().find(item => item.name === name)!;
    await wait(() => root.textContent?.includes(name) ?? false, 'Refresh scheme row');
    return definition;
  }
  async function add(root: HTMLElement, name: string, entries: Record<string, string>) {
    if (!plugin.app.vault.getAbstractFileByPath('__opencc_tests__')) await plugin.app.vault.createFolder('__opencc_tests__');
    const file = await plugin.app.vault.create(`__opencc_tests__/settings-${crypto.randomUUID()}.json`, JSON.stringify({ conversion_chain: [{ dict: { type: 'inline', entries } }] }));
    return { definition: await addPath(root, name, file.path), file };
  }
  return [
    { name: 'settings/crud-default', run: async () => {
      await mounted(async root => {
        const name = `UI ${crypto.randomUUID()}`;
        const { definition } = await add(root, name, { 软件: '軟體' });
        field('默认方案', definition.id);
        await wait(() => endpoint.store.getDefaultId() === definition.id);
        const row = root.querySelector<HTMLElement>(`[data-scheme-id="${definition.id}"]`);
        ok(row); button(row, '删除');
        button(document, '确认删除');
        await wait(() => !endpoint.store.getDefinitions().some(item => item.id === definition.id));
        equal(endpoint.store.getDefaultId(), null);
      });
    } },
    { name: 'settings/rename-command-id', run: async () => {
      await mounted(async root => {
        const originalName = `Rename ${crypto.randomUUID()}`;
        const { definition } = await add(root, originalName, { 软件: '軟體' });
        const before = endpoint.schemeCommands.get(definition.id);
        ok(before); ok(before.id.endsWith(`:convert:${definition.id}`));
        const row = root.querySelector<HTMLElement>(`[data-scheme-id="${definition.id}"]`); ok(row); button(row, '编辑');
        field('方案名称', `${originalName} 新名`); button(document, '仅保存名称');
        await wait(() => endpoint.store.getDefinitions().some(item => item.id === definition.id && item.name.endsWith('新名')), 'Rename scheme');
        const after = endpoint.schemeCommands.get(definition.id); ok(after);
        equal(after.id, before.id); ok(after.name.includes('新名'));
      });
    } },
    { name: 'settings/independent-command', run: async () => {
      const view = await openFixture(plugin.app, '软件', `settings-command-${crypto.randomUUID()}.md`);
      view.editor.setSelection({ line: 0, ch: 0 }, { line: 0, ch: 2 });
      await mounted(async root => {
        const { definition } = await add(root, `Command ${crypto.randomUUID()}`, { 软件: '軟體' });
        const command = endpoint.schemeCommands.get(definition.id); ok(command?.callback);
        await command.callback();
        await wait(() => view.editor.getValue() === '軟體', 'Independent command conversion');
      });
    } },
    { name: 'settings/context-menu-route', run: async () => {
      const previousDefault = endpoint.store.getDefaultId();
      const definition = { id: crypto.randomUUID(), name: `Menu ${crypto.randomUUID()}`, source: { kind: 'vault' as const, location: '__opencc_tests__/synthetic-menu.json' } };
      const prepared = await snapshot({ conversion_chain: [{ dict: { type: 'inline', entries: { 软件: '軟體' } } }] });
      prepared.schemeId = definition.id; prepared.sourceKey = await schemeSourceKey(definition);
      await endpoint.store.activate(definition, prepared); await endpoint.store.setDefault(definition.id); endpoint.syncSchemeCommands();
      const view = await openFixture(plugin.app, '软件', `settings-menu-${crypto.randomUUID()}.md`);
      view.editor.setSelection({ line: 0, ch: 0 }, { line: 0, ch: 2 });
      const menu = new Menu().setUseNativeMenu(false);
      try {
        plugin.app.workspace.trigger('editor-menu', menu, view.editor, view);
        menu.showAtPosition({ x: 10, y: 10 });
        await wait(() => document.body.textContent?.includes('OpenCC：使用默认方案转换选区') ?? false, 'Context menu item');
        const item = Array.from(document.querySelectorAll<HTMLElement>('.menu-item')).find(element => element.textContent?.includes('OpenCC：使用默认方案转换选区'));
        ok(item); item.click();
        await wait(() => view.editor.getValue() === '軟體', 'Context menu conversion');
      } finally {
        menu.close();
        await endpoint.store.remove(definition.id);
        if (previousDefault && endpoint.store.getDefinitions().some(item => item.id === previousDefault)) await endpoint.store.setDefault(previousDefault);
        endpoint.syncSchemeCommands();
      }
    } },
    { name: 'settings/redaction', run: () => {
      const secret = 'https://user:pass@example.com/config.json?token=secret';
      equal(safeLocation(secret), 'https://example.com/config.json（查询参数已隐藏）');
      equal(safeError(new PluginError('FETCH_FAILED', `无法读取 ${secret}`)), 'FETCH_FAILED：无法读取 https://example.com/config.json（查询参数已隐藏）');
    } },
    { name: 'settings/resource-consent', run: async () => {
      ok(fixtureOrigin, 'Missing loopback fixture');
      const before = (await requestUrl(`${fixtureOrigin}/requests`)).json.length;
      await mounted(async root => {
        button(root, '添加方案');
        field('方案名称', `HTTP ${crypto.randomUUID()}`); field('配置来源', 'url'); field('配置位置', `${fixtureOrigin}/config.json`);
        button(document, '预览依赖');
        await wait(() => document.body.textContent?.includes('允许 HTTP 请求') ?? false);
        equal((await requestUrl(`${fixtureOrigin}/requests`)).json.length, before);
        button(document, '允许 HTTP 请求');
        await wait(() => Array.from(document.querySelectorAll('button')).some(item => item.textContent === '确认并加载'));
        equal((await requestUrl(`${fixtureOrigin}/requests`)).json.length, before + 1);
        button(document, '关闭'); // Real cancel control: no dictionary request.
      });
      equal((await requestUrl(`${fixtureOrigin}/requests`)).json.length, before + 1);
    } },
    { name: 'settings/cancel-load-restores-status', run: async () => {
      await mounted(async root => {
        const name = `Cancel ${crypto.randomUUID()}`;
        const file = await plugin.app.vault.create(`__opencc_tests__/settings-${crypto.randomUUID()}.json`, JSON.stringify({ conversion_chain: [{ dict: { type: 'inline', entries: { 软件: '軟體' } } }] }));
        button(root, '添加方案'); field('方案名称', name); field('配置来源', 'vault'); field('配置位置', file.path); button(document, '预览依赖');
        await wait(() => Array.from(document.querySelectorAll('button')).some(item => item.textContent === '确认并加载' && !item.disabled), 'Cancellation preview');
        const original = endpoint.engine.validate;
        let resume!: () => void; const gate = new Promise<void>(resolve => { resume = resolve; });
        endpoint.engine.validate = async (snapshot, signal) => { await gate; return original.call(endpoint.engine, snapshot, signal); };
        try {
          button(document, '确认并加载');
          const draft = endpoint.store.getDrafts().find(item => item.name === name); ok(draft);
          await wait(() => endpoint.store.getStatus(draft.id).kind === 'loading', 'Loading status');
          [...endpoint.uiModals].at(-1)?.close(); resume();
          await wait(() => endpoint.store.getStatus(draft.id).kind !== 'loading', 'Restore cancelled status');
          equal(endpoint.store.getStatus(draft.id).kind, 'unloaded');
        } finally { resume(); endpoint.engine.validate = original; }
      });
    } },
    { name: 'settings/failed-refresh-and-audit-expiry', run: async () => {
      await mounted(async root => {
        const { definition, file } = await add(root, `Refresh ${crypto.randomUUID()}`, { 软件: '軟體字' });
        const firstSnapshot = endpoint.store.getStatus(definition.id).snapshotId; ok(firstSnapshot);
        let row = root.querySelector<HTMLElement>(`[data-scheme-id="${definition.id}"]`); ok(row); button(row, '等长检查');
        await wait(() => row?.textContent?.includes('存在长度风险') ?? false, 'Initial audit');
        await plugin.app.vault.modify(file, '{ invalid');
        button(row, '刷新');
        await wait(() => endpoint.store.getStatus(definition.id).kind === 'stale', 'Failed refresh fallback');
        await wait(() => root.textContent?.includes('使用旧缓存（刷新失败）') ?? false, 'Render stale status');
        equal((await endpoint.store.getActive(definition.id)).id, firstSnapshot);
        for (const modal of [...endpoint.uiModals]) modal.close();
        await plugin.app.vault.modify(file, JSON.stringify({ conversion_chain: [{ dict: { type: 'inline', entries: { 软件: '軟體' } } }] }));
        row = root.querySelector<HTMLElement>(`[data-scheme-id="${definition.id}"]`); ok(row); button(row, '刷新');
        await wait(() => Array.from(document.querySelectorAll('button')).some(item => item.textContent === '确认并加载' && !item.disabled), 'Refresh preview');
        button(document, '确认并加载');
        await wait(() => endpoint.store.getStatus(definition.id).snapshotId !== firstSnapshot, 'Publish refreshed snapshot');
        await wait(() => root.textContent?.includes('检查已过期') ?? false, 'Expire old audit');
      });
    } },
    { name: 'settings/rules-and-force-warning', run: async () => {
      await endpoint.store.saveRules(structuredClone(DEFAULT_RULES));
      await mounted(async root => {
        field('行内代码', 'never');
        await wait(() => endpoint.store.getRules().regions.inlineCode === 'never', 'Persist region policy');
        const force = root.querySelector<HTMLInputElement>('[aria-label="强制模式"]'); ok(force); force.click();
        await wait(() => document.body.textContent?.includes('开启强制模式？') ?? false, 'Force warning');
        button(document, '取消');
        await wait(() => !force.checked, 'Cancel force mode'); equal(endpoint.store.getRules().force, false);
        force.click(); button(document, '开启强制模式');
        await wait(() => endpoint.store.getRules().force, 'Persist force mode');
      });
      await endpoint.store.saveRules(structuredClone(DEFAULT_RULES));
    } },
    { name: 'settings/incomplete-length-report', run: async () => {
      const definition = { id: crypto.randomUUID(), name: `Incomplete ${crypto.randomUUID()}`, source: { kind: 'vault' as const, location: '__opencc_tests__/synthetic-incomplete.json' } };
      const text = Array.from({ length: 64 }, (_, index) => `k${index}\t${'x'.repeat(4096)}\n`).join('');
      const prepared = await snapshot({ conversion_chain: Array.from({ length: 300 }, () => ({ dict: { type: 'text', file: 'risk.txt' } })) }, { 'risk.txt': text });
      prepared.schemeId = definition.id; prepared.sourceKey = await schemeSourceKey(definition);
      await endpoint.store.activate(definition, prepared);
      try {
        await mounted(async root => {
          const row = root.querySelector<HTMLElement>(`[data-scheme-id="${definition.id}"]`); ok(row); button(row, '等长检查');
          await wait(() => row.textContent?.includes('检查不完整') ?? false, 'Incomplete audit badge');
          ok(row.textContent?.includes(prepared.id));
        });
      } finally { await endpoint.store.remove(definition.id); endpoint.lengthReports.delete(definition.id); endpoint.syncSchemeCommands(); }
    } },
    { name: 'settings/length-report', run: async () => {
      await mounted(async root => {
        const { definition } = await add(root, `Risk ${crypto.randomUUID()}`, { 软件: '軟體字' });
        const row = root.querySelector<HTMLElement>(`[data-scheme-id="${definition.id}"]`);
        ok(row); button(row, '等长检查');
        try { await wait(() => row.textContent?.includes('存在长度风险') ?? false); }
        catch { throw new Error(`Length report UI: ${row.textContent}`); }
        ok(row.textContent?.includes(endpoint.store.getStatus(definition.id).snapshotId ?? 'MISSING_SNAPSHOT'));
      });
    } },
  ];
}
