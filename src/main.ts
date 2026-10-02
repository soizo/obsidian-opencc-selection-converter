import { MarkdownView, Notice, Plugin } from 'obsidian';
import { PluginError } from './errors';
import { captureTarget, editorExtension } from './selection/editor';
import { EngineClient } from './engine/client';
import { SchemeStore } from './schemes/store';

declare const __TEST__: boolean;

export default class OpenCCSelectionConverter extends Plugin {
  readonly engine = new EngineClient();
  readonly store = new SchemeStore(this.app, this.engine);

  async onload(): Promise<void> {
    await this.store.load();
    this.registerEditorExtension(editorExtension);
    this.addCommand({
      id: 'convert-default',
      name: '转换选区（默认方案）',
      callback: () => this.convertDefault(),
    });
    if (__TEST__) {
      const { attachCliTests } = await import('../tests/cli/run');
      attachCliTests(this);
    }
  }

  onunload(): void { this.engine.dispose(); }

  async convertDefault(): Promise<{changed: false; code: string}> {
    try {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view) throw new PluginError('UNSUPPORTED_VIEW', '请在 Markdown 编辑器中转换选区。');
      captureTarget(view);
      throw new PluginError('NO_SCHEME', '请先添加 OpenCC 方案。');
    } catch (error) {
      const failure = error instanceof PluginError ? error : new PluginError('UNEXPECTED_ERROR', '转换未执行，请重试。');
      new Notice(failure.message);
      return { changed: false, code: failure.code };
    }
  }
}
