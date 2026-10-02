import { editorInfoField } from 'obsidian';
import type { Editor, MarkdownView, TFile } from 'obsidian';
import { ViewPlugin } from '@codemirror/view';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import type { Text } from '@codemirror/state';
import { PluginError } from '../errors';
import type { Span } from './types';

const editors = new WeakMap<Editor, EditorTracker>();

class EditorTracker {
  revision = 0;
  selectionRevision = 0;
  private editor?: Editor;

  constructor(readonly cm: EditorView) { this.bind(); }

  private bind(): void {
    const editor = this.cm.state.field(editorInfoField, false)?.editor;
    if (editor !== this.editor) this.destroy();
    this.editor = editor;
    if (editor) editors.set(editor, this);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) this.revision++;
    if (update.selectionSet && !update.startState.selection.eq(update.state.selection)) this.selectionRevision++;
    this.bind();
  }

  destroy(): void {
    if (this.editor && editors.get(this.editor) === this) editors.delete(this.editor);
  }
}

export const editorExtension = ViewPlugin.fromClass(EditorTracker);

export type CapturedTarget = {
  view: MarkdownView;
  cm: EditorView;
  file: TFile;
  filePath: string;
  doc: Text;
  revision: number;
  selectionRevision: number;
  selection: Span;
  anchor: number;
  head: number;
};

export function captureTarget(view: MarkdownView): CapturedTarget {
  if (view.getMode() !== 'source' || !view.file) {
    throw new PluginError('UNSUPPORTED_VIEW', '请在 Markdown 源码模式或实时预览中转换选区。');
  }
  if (view.editor.listSelections().length !== 1) {
    throw new PluginError('MULTIPLE_SELECTIONS', '仅支持一个连续选区，请取消其他选区。');
  }
  if (!view.editor.somethingSelected()) {
    throw new PluginError('NO_SELECTION', '请先选中要转换的文字；不会自动转换全文。');
  }
  const tracked = editors.get(view.editor);
  if (!tracked || !tracked.cm.dom.isConnected) {
    throw new PluginError('EDITOR_NOT_READY', '编辑器尚未就绪，请重新选择后重试。');
  }
  const { cm, revision, selectionRevision } = tracked;
  const { from, to, anchor, head } = cm.state.selection.main;
  return {
    view, cm, file: view.file, filePath: view.file.path, doc: cm.state.doc,
    revision, selectionRevision, selection: { from, to }, anchor, head,
  };
}
