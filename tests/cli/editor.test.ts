import { Compartment, EditorState, StateEffect, Transaction } from '@codemirror/state';
import { MarkdownView } from 'obsidian';
import { undo, redo, isolateHistory } from '@codemirror/commands';
import type { ConversionOutcome } from '../../src/main';
import { captureTarget, type CapturedTarget } from '../../src/selection/editor';
import { DEFAULT_RULES } from '../../src/selection/types';
import { combineSnapshots, prepareScheme, loadPrepared, schemeSourceKey } from '../../src/schemes/resources';
import type { SchemeStore } from '../../src/schemes/store';
import { engine, snapshot } from './engine.test';
import { equal, ok } from './assert';
import { openFixture, type TestPlugin } from './fixtures';

type Endpoint = TestPlugin & { store: SchemeStore; convertSelection(target: CapturedTarget, id: string, signal: AbortSignal): Promise<ConversionOutcome> };
export function editorTests(plugin: TestPlugin) {
  const endpoint = plugin as Endpoint;
  async function fixture(live = false) {
    const text = '前软**件**后';
    const view = await openFixture(plugin.app, text, `editor-note-${crypto.randomUUID()}.md`);
    await view.setState({ ...view.getState(), mode: 'source', source: !live }, { history: false });
    for (let attempt = 0; view.editor.getValue() !== text && attempt < 60; attempt++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    equal(view.editor.getValue(), text);
    view.editor.setSelection(view.editor.offsetToPos(1), view.editor.offsetToPos(7));
    const id = crypto.randomUUID();
    const file = await plugin.app.vault.create(`__opencc_tests__/editor-${id}.json`, JSON.stringify({ conversion_chain: [{ dict: { type: 'inline', entries: { 软件: '軟體' } } }] }));
    const definition = { id, name: 'Editor fixture', source: { kind: 'vault' as const, location: file.path } };
    const signal = new AbortController().signal;
    await endpoint.store.load();
    await endpoint.store.saveRules(structuredClone(DEFAULT_RULES));
    const snapshot = await loadPrepared(plugin.app, await prepareScheme(plugin.app, definition, signal), engine(plugin), signal);
    await endpoint.store.activate(definition, snapshot);
    return { text, view, id, signal, target: captureTarget(view) };
  }
  async function chainFixture(live = false) {
    const context = await fixture(live);
    const definitions = [
      { id: crypto.randomUUID(), name: 'Chain first', source: { kind: 'vault' as const, location: 'synthetic-first.json' } },
      { id: crypto.randomUUID(), name: 'Chain second', source: { kind: 'vault' as const, location: 'synthetic-second.json' } },
    ];
    const steps = await Promise.all([
      snapshot({ conversion_chain: [{ dict: { type: 'inline', entries: { 软件: '軟件' } } }] }),
      snapshot({ conversion_chain: [{ dict: { type: 'inline', entries: { 軟件: '軟體' } } }] }),
    ]);
    for (const [index, prepared] of steps.entries()) { prepared.schemeId = definitions[index]!.id; prepared.sourceKey = await schemeSourceKey(definitions[index]!); }
    const definition = { id: crypto.randomUUID(), name: 'Editor chain', source: { kind: 'chain' as const, steps: definitions } };
    await endpoint.store.activate(definition, await combineSnapshots(definition, steps));
    return { ...context, id: definition.id, target: captureTarget(context.view) };
  }
  async function paused(action: (context: Awaited<ReturnType<typeof fixture>>, resume: () => void, pending: Promise<ConversionOutcome>, controller: AbortController) => Promise<void>) {
    const context = await fixture();
    let resume!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const original = endpoint.store.getActive;
    let first = true;
    endpoint.store.getActive = async function(id) {
      const hold = first; first = false;
      const result = await original.call(this, id);
      if (hold) { entered(); await gate; }
      return result;
    };
    const controller = new AbortController();
    const pending = endpoint.convertSelection(context.target, context.id, controller.signal);
    try {
      await Promise.race([ready, pending.then(result => { throw new Error(`Conversion ended before gate: ${result.code}`); })]);
      await action(context, resume, pending, controller);
    } finally {
      resume();
      endpoint.store.getActive = original;
      await pending;
    }
  }
  return [
    ...[false, true].map(live => ({ name: `editor/chain-atomic-undo/${live ? 'live' : 'source'}`, run: async () => {
      const { view, id, signal, target, text } = await chainFixture(live);
      equal((await endpoint.convertSelection(target, id, signal)).code, 'CHANGED');
      equal(view.editor.getValue(), '前軟**體**后');
      ok(undo(target.cm)); equal(view.editor.getValue(), text);
    } })),
    ...[false, true].map(live => ({ name: `editor/atomic-undo/${live ? 'live' : 'source'}`, run: async () => {
      const { view, id, signal, target } = await fixture(live);
      const cm = target.cm;
      cm.dispatch({ changes: { from: 0, insert: '先' }, annotations: [Transaction.userEvent.of('input.type'), isolateHistory.of('full')] });
      equal((await endpoint.convertSelection(captureTarget(view), id, signal)).code, 'CHANGED');
      equal(view.editor.getValue(), '先前軟**體**后');
      cm.dispatch({ changes: { from: cm.state.doc.length, insert: '末' }, annotations: Transaction.userEvent.of('input.type') });
      ok(undo(cm));
      equal(view.editor.getValue(), '先前軟**體**后');
      ok(undo(cm));
      equal(view.editor.getValue(), '先前软**件**后');
      ok(undo(cm));
      equal(view.editor.getValue(), '前软**件**后');
      ok(redo(cm));
      equal(view.editor.getValue(), '先前软**件**后');
    } })),
    { name: 'editor/aba', run: async () => {
      const { view, id, signal, target, text } = await fixture();
      target.cm.dispatch({ changes: { from: 0, insert: '临时' }, annotations: isolateHistory.of('full') });
      ok(undo(target.cm));
      equal(view.editor.getValue(), text);
      equal((await endpoint.convertSelection(target, id, signal)).code, 'STALE_SELECTION');
      equal(view.editor.getValue(), text);
    } },
    { name: 'editor/selection-and-cancel', run: async () => {
      const { view, id, target, text } = await fixture();
      view.editor.setCursor({ line: 0, ch: 0 });
      view.editor.setSelection(view.editor.offsetToPos(1), view.editor.offsetToPos(7));
      equal((await endpoint.convertSelection(target, id, new AbortController().signal)).code, 'STALE_SELECTION');
      const controller = new AbortController(); controller.abort();
      equal((await endpoint.convertSelection(captureTarget(view), id, controller.signal)).code, 'CANCELLED');
      equal(view.editor.getValue(), text);
    } },
    ...['edit', 'selection', 'rename', 'remove-scheme', 'cancel', 'close'].map(kind => ({ name: `editor/inflight-${kind}`, run: async () => {
      await paused(async ({ target, view, id, text }, resume, pending, controller) => {
        if (kind === 'edit') target.cm.dispatch({ changes: { from: 0, insert: '同步' } });
        if (kind === 'selection') view.editor.setCursor({ line: 0, ch: 0 });
        if (kind === 'rename') await plugin.app.vault.rename(target.file, target.filePath.replace('.md', '-renamed.md'));
        if (kind === 'remove-scheme') await endpoint.store.remove(id);
        if (kind === 'cancel') controller.abort();
        if (kind === 'close') view.leaf.detach();
        resume();
        equal((await pending).code, kind === 'cancel' ? 'CANCELLED' : kind === 'remove-scheme' ? 'NO_SCHEME' : 'STALE_SELECTION');
        if (kind === 'close') equal(await plugin.app.vault.read(target.file), text);
        else equal(view.editor.getValue(), kind === 'edit' ? `同步${text}` : text);
      });
    } })),
    { name: 'editor/newer-task-wins', run: async () => {
      await paused(async ({ target, id, signal, view }, resume, pending) => {
        const newer = await endpoint.convertSelection(target, id, signal);
        equal(newer.code, 'CHANGED');
        resume();
        equal((await pending).code, 'CANCELLED');
        equal(view.editor.getValue(), '前軟**體**后');
      });
    } },
    { name: 'editor/no-change-history', run: async () => {
      const { view, id, signal, target } = await fixture();
      equal((await endpoint.convertSelection(target, id, signal)).code, 'CHANGED');
      equal((await endpoint.convertSelection(captureTarget(view), id, signal)).code, 'NO_CHANGE');
      ok(undo(target.cm));
      equal(view.editor.getValue(), '前软**件**后');
    } },
    { name: 'editor/inflight-readonly', run: async () => {
      await paused(async ({ target, view, text }, resume, pending) => {
        const readonly = new Compartment();
        target.cm.dispatch({ effects: StateEffect.appendConfig.of(readonly.of(EditorState.readOnly.of(true))) });
        try {
          resume();
          equal((await pending).code, 'READ_ONLY');
          equal(view.editor.getValue(), text);
        } finally { target.cm.dispatch({ effects: readonly.reconfigure([]) }); }
      });
    } },
    { name: 'editor/same-file-two-views', run: async () => {
      const { view, id, target, signal } = await fixture();
      const leaf = plugin.app.workspace.getLeaf('split');
      try {
        await leaf.openFile(target.file, { state: { mode: 'source', source: true } });
        ok(leaf.view instanceof MarkdownView);
        equal((await endpoint.convertSelection(target, id, signal)).code, 'CHANGED');
        equal(view.editor.getValue(), '前軟**體**后');
        await view.save();
        for (let attempt = 0; leaf.view.editor.getValue() !== '前軟**體**后' && attempt < 120; attempt++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        equal(leaf.view.editor.getValue(), '前軟**體**后');
      } finally { leaf.detach(); }
    } },
    { name: 'editor/crlf-disk-observation', run: async () => {
      const { view, id, signal } = await fixture();
      const originalDisk = '前\r\n软件\r\n后\r\n';
      const file = await plugin.app.vault.createBinary(`__opencc_tests__/crlf-${crypto.randomUUID()}.md`, new TextEncoder().encode(originalDisk).buffer);
      equal(new TextDecoder().decode(await plugin.app.vault.readBinary(file)), originalDisk);
      await view.leaf.openFile(file, { state: { mode: 'source', source: true } });
      for (let attempt = 0; view.editor.getValue().replace(/\r\n/g, '\n') !== '前\n软件\n后\n' && attempt < 120; attempt++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const editorBefore = view.editor.getValue();
      equal(editorBefore.replace(/\r\n/g, '\n'), '前\n软件\n后\n');
      view.editor.setSelection({ line: 1, ch: 0 }, { line: 1, ch: 2 });
      equal((await endpoint.convertSelection(captureTarget(view), id, signal)).code, 'CHANGED');
      const editorAfter = view.editor.getValue();
      await view.save();
      const savedDisk = new TextDecoder().decode(await plugin.app.vault.readBinary(file));
      equal(savedDisk.replace(/\r\n/g, '\n'), '前\n軟體\n后\n');
      await plugin.app.vault.adapter.write('.opencc-test-results/editor-crlf.json', JSON.stringify({ originalDisk, editorBefore, editorAfter, savedDisk, preservedCRLF: savedDisk.includes('\r\n') }, null, 2));
    } },
    { name: 'editor/view-identity', run: async () => {
      const { view, id, target, signal } = await fixture();
      const other = await plugin.app.vault.create(`__opencc_tests__/other-${crypto.randomUUID()}.md`, '其他视图哨兵');
      const leaf = plugin.app.workspace.getLeaf('split');
      try {
        await leaf.openFile(other);
        equal((await endpoint.convertSelection(target, id, signal)).code, 'CHANGED');
        equal(view.editor.getValue(), '前軟**體**后');
        equal(await plugin.app.vault.read(other), '其他视图哨兵');
      } finally { leaf.detach(); }
    } },
  ];
}
