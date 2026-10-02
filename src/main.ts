import { MarkdownView, Notice, Plugin } from 'obsidian';
import { PluginError } from './errors';
import { assertTargetCurrent, captureTarget, commitPatch, editorExtension, type CapturedTarget } from './selection/editor';
import { projectMarkdown } from './selection/markdown';
import { convertProjection } from './selection/convert';
import { validatePatch } from './selection/serialize';
import { EngineClient } from './engine/client';
import { SchemeStore } from './schemes/store';

declare const __TEST__: boolean;
export type ConversionOutcome = { changed: boolean; code: string; error?: PluginError };

export default class OpenCCSelectionConverter extends Plugin {
  readonly engine = new EngineClient();
  readonly store = new SchemeStore(this.app, this.engine);
  private readonly conversions = new Map<CapturedTarget['cm'], AbortController>();

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

  onunload(): void {
    for (const controller of this.conversions.values()) controller.abort();
    this.conversions.clear();
    this.engine.dispose();
  }

  async convertSelection(target: CapturedTarget, schemeId: string, signal: AbortSignal): Promise<ConversionOutcome> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    let registered = false;
    const check = () => {
      if (controller.signal.aborted) throw new PluginError('CANCELLED', '转换已取消。');
      assertTargetCurrent(target);
      if (!this.store.getDefinitions().some(definition => definition.id === schemeId)) throw new PluginError('NO_SCHEME', '方案已删除或尚未准备完成。');
    };
    try {
      if (signal.aborted) controller.abort();
      signal.addEventListener('abort', cancel, { once: true });
      check();
      this.conversions.get(target.cm)?.abort();
      this.conversions.set(target.cm, controller);
      registered = true;
      const rules = this.store.getRules();
      const projection = projectMarkdown(target.cm.state, target.selection, rules);
      if (!projection.runs.length) return { changed: false, code: 'SKIPPED' };
      const snapshot = await this.store.getActive(schemeId);
      check();
      const patch = await convertProjection(projection, snapshot, rules, this.engine, controller.signal);
      check();
      validatePatch(target.cm.state, projection, patch);
      check();
      if (!patch.changes.length) return { changed: false, code: 'NO_CHANGE' };
      commitPatch(target, patch);
      return { changed: true, code: 'CHANGED' };
    } catch (error) {
      const failure = error instanceof PluginError ? error : new PluginError('UNEXPECTED_ERROR', '转换失败，未提交结果。');
      return { changed: false, code: failure.code, error: failure };
    } finally {
      signal.removeEventListener('abort', cancel);
      if (registered && this.conversions.get(target.cm) === controller) this.conversions.delete(target.cm);
    }
  }

  async convertDefault(): Promise<ConversionOutcome> {
    try {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view) throw new PluginError('UNSUPPORTED_VIEW', '请在 Markdown 编辑器中转换选区。');
      const target = captureTarget(view);
      const schemeId = this.store.getDefaultId();
      if (!schemeId) throw new PluginError('NO_SCHEME', '请先添加 OpenCC 方案。');
      const outcome = await this.convertSelection(target, schemeId, new AbortController().signal);
      if (outcome.error) new Notice(outcome.error.message);
      return outcome;
    } catch (error) {
      const failure = error instanceof PluginError ? error : new PluginError('UNEXPECTED_ERROR', '转换未执行，请重试。');
      new Notice(failure.message);
      return { changed: false, code: failure.code };
    }
  }
}
