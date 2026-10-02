import { MarkdownView, Notice, Plugin, type Command, type Modal } from 'obsidian';
import { PluginError } from './errors';
import { assertTargetCurrent, captureTarget, commitPatch, editorExtension, type CapturedTarget } from './selection/editor';
import { projectMarkdown } from './selection/markdown';
import { convertProjection } from './selection/convert';
import { validatePatch } from './selection/serialize';
import { EngineClient } from './engine/client';
import { SchemeStore } from './schemes/store';
import type { LengthReport } from './engine/types';
import { ConverterSettingsTab } from './settings';
import { SchemePicker, safeError, safeLocation } from './scheme-modal';

declare const __TEST__: boolean;
export type ConversionOutcome = { changed: boolean; code: string; error?: PluginError };

export default class OpenCCSelectionConverter extends Plugin {
  readonly engine = new EngineClient();
  readonly store = new SchemeStore(this.app, this.engine);
  readonly lengthReports = new Map<string, LengthReport>();
  readonly uiModals = new Set<Modal>();
  readonly schemeCommands = new Map<string, Command>();
  private readonly conversions = new Map<CapturedTarget['cm'], AbortController>();

  async onload(): Promise<void> {
    await this.store.load();
    this.registerEditorExtension(editorExtension);
    this.addCommand({
      id: 'convert-default',
      name: '转换选区（默认方案）',
      callback: () => this.convertDefault(),
    });
    this.addSettingTab(new ConverterSettingsTab(this.app, this));
    this.addCommand({ id: 'convert-with-scheme', name: '选择方案转换选区', callback: () => this.pickScheme() });
    this.syncSchemeCommands();
    this.registerEvent(this.app.workspace.on('editor-menu', (menu, _editor, info) => {
      if (!(info instanceof MarkdownView)) return;
      let target: CapturedTarget;
      try { target = captureTarget(info); } catch { return; }
      menu.addItem(item => item.setTitle('OpenCC：使用默认方案转换选区').onClick(() => { void this.convertDefault(target); }));
      menu.addItem(item => item.setTitle('OpenCC：选择方案转换选区').onClick(() => this.pickScheme(target)));
    }));
    if (__TEST__) {
      const { attachCliTests } = await import('../tests/cli/run');
      attachCliTests(this);
    }
  }

  onunload(): void {
    for (const controller of this.conversions.values()) controller.abort();
    this.conversions.clear();
    for (const modal of [...this.uiModals]) modal.close();
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

  syncSchemeCommands(): void {
    for (const command of this.schemeCommands.values()) this.removeCommand(command.id);
    this.schemeCommands.clear();
    for (const definition of this.store.getDefinitions()) {
      const command = this.addCommand({
        id: `convert:${definition.id}`,
        name: `转换选区：${definition.name} — ${safeLocation(definition.source.location)}`,
        callback: async () => {
          try { await this.runCaptured(this.activeTarget(), definition.id); }
          catch (error) { new Notice(safeError(error)); }
        },
      });
      this.schemeCommands.set(definition.id, command);
    }
  }

  private activeTarget(): CapturedTarget {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) throw new PluginError('UNSUPPORTED_VIEW', '请在 Markdown 编辑器中转换选区。');
    return captureTarget(view);
  }

  pickScheme(target?: CapturedTarget): void {
    try {
      const captured = target ?? this.activeTarget();
      if (!this.store.getDefinitions().length) throw new PluginError('NO_SCHEME', '请先在设置中添加并加载方案。');
      new SchemePicker(this, definition => { void this.runCaptured(captured, definition.id); }).open();
    } catch (error) { new Notice(safeError(error)); }
  }

  private async runCaptured(target: CapturedTarget, id: string): Promise<ConversionOutcome> {
    const outcome = await this.convertSelection(target, id, new AbortController().signal);
    if (outcome.error) new Notice(safeError(outcome.error));
    else if (outcome.code === 'NO_CHANGE') new Notice('选区文字无需转换。');
    else if (outcome.code === 'SKIPPED') new Notice('选区被当前区域策略跳过。');
    return outcome;
  }

  async convertDefault(captured?: CapturedTarget): Promise<ConversionOutcome> {
    try {
      const target = captured ?? this.activeTarget();
      const schemeId = this.store.getDefaultId();
      if (!schemeId) throw new PluginError('NO_SCHEME', '请先添加 OpenCC 方案。');
      return await this.runCaptured(target, schemeId);
    } catch (error) {
      const failure = error instanceof PluginError ? error : new PluginError('UNEXPECTED_ERROR', '转换未执行，请重试。');
      new Notice(safeError(failure));
      return { changed: false, code: failure.code };
    }
  }
}
