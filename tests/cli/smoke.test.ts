import type { TestPlugin } from './fixtures';
import { equal, ok } from './assert';
import { openFixture } from './fixtures';

export function smokeTests(plugin: TestPlugin) {
  return [
    { name: 'smoke/no-selection', run: async () => {
      const view = await openFixture(plugin.app, '前缀 软件 后缀');
      view.editor.setCursor({ line: 0, ch: 3 });
      equal(await plugin.convertDefault(), { changed: false, code: 'NO_SELECTION' });
      equal(view.editor.getValue(), '前缀 软件 后缀');
    } },
    { name: 'smoke/unsupported-view', run: async () => {
      const view = await openFixture(plugin.app, '阅读模式 软件');
      await view.setState({ ...view.getState(), mode: 'preview' }, { history: false });
      equal(await plugin.convertDefault(), { changed: false, code: 'UNSUPPORTED_VIEW' });
      equal(await plugin.app.vault.read(view.file!), '阅读模式 软件');
    } },
    { name: 'smoke/selected-without-scheme', run: async () => {
      const view = await openFixture(plugin.app, '前缀 软件 后缀');
      view.editor.setSelection({ line: 0, ch: 3 }, { line: 0, ch: 5 });
      equal(await plugin.convertDefault(), { changed: false, code: 'NO_SCHEME' });
      equal(view.editor.getValue(), '前缀 软件 后缀');
    } },
    { name: 'smoke/multiple-selections', run: async () => {
      const view = await openFixture(plugin.app, '前缀 软件 后缀');
      view.editor.setSelections([
        { anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 2 } },
        { anchor: { line: 0, ch: 3 }, head: { line: 0, ch: 5 } },
      ]);
      equal(await plugin.convertDefault(), { changed: false, code: 'MULTIPLE_SELECTIONS' });
      equal(view.editor.getValue(), '前缀 软件 后缀');
    } },
    { name: 'smoke/default-command', run: async () => {
      const commands = (plugin.app as unknown as { commands: { commands: Record<string, unknown> } }).commands.commands;
      ok(commands['opencc-selection-converter:convert-default'], 'Plugin did not register its conversion command');
    } },
  ];
}
