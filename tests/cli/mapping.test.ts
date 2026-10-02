import { captureTarget } from '../../src/selection/editor';
import { projectMarkdown } from '../../src/selection/markdown';
import { convertProjection } from '../../src/selection/convert';
import { validatePatch } from '../../src/selection/serialize';
import { DEFAULT_RULES, type Span } from '../../src/selection/types';
import { engine, snapshot } from './engine.test';
import { equal, rejectsCode } from './assert';
import { openFixture, type TestPlugin } from './fixtures';

export function mappingTests(plugin: TestPlugin) {
  async function convert(text: string, stages: Record<string, string>[], force = false, selection: Span = { from: 0, to: text.length }, live = false) {
    const view = await openFixture(plugin.app, text);
    await view.setState({ ...view.getState(), mode: 'source', source: !live }, { history: false });
    for (let attempt = 0; view.editor.getValue() !== text && attempt < 60; attempt++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    equal(view.editor.getValue(), text);
    view.editor.setSelection(view.editor.offsetToPos(selection.from), view.editor.offsetToPos(selection.to));
    const state = captureTarget(view).cm.state;
    const rules = { ...structuredClone(DEFAULT_RULES), force };
    const projection = projectMarkdown(state, selection, rules);
    const prepared = await snapshot({ conversion_chain: stages.map(entries => ({ dict: { type: 'inline', entries } })) });
    try {
      const patch = await convertProjection(projection, prepared, rules, engine(plugin), new AbortController().signal);
      validatePatch(state, projection, patch);
      return { source: state.update({ changes: patch.changes }).state.doc.toString(), patch };
    } catch (error) {
      if (error instanceof Error) error.message += ` (synthetic fixture: ${JSON.stringify(text)})`;
      throw error;
    } finally { equal(view.editor.getValue(), text); } // Success and failure must both leave the real editor unchanged.
  }
  return [
    { name: 'mapping/phrase', run: async () => {
      equal((await convert('软**件**', [{ 软件: '軟體' }])).source, '軟**體**');
      equal((await convert('软[件](https://example.com/软件)', [{ 软件: '軟體' }])).source, '軟[體](https://example.com/软件)');
    } },
    { name: 'mapping/strict-per-match', run: async () => {
      await rejectsCode(convert('甲**丙丁**', [{ 甲: '乙乙', 丙丁: '戊' }]), 'LENGTH_CHANGED');
      await rejectsCode(convert('甲', [{ 甲: '乙乙' }, { 乙乙: '丙' }]), 'LENGTH_CHANGED');
    } },
    { name: 'mapping/no-op-roundtrip', run: async () => {
      const result = await convert('甲**乙**', [{ 甲乙: '丙' }, { 丙: '甲乙' }], true);
      equal(result.patch.changes, []);
      equal(result.source, '甲**乙**');
    } },
    { name: 'mapping/force', run: async () => {
      equal((await convert('甲**乙**', [{ 甲乙: '丙' }], true)).source, '丙');
      equal((await convert('**甲**乙', [{ 甲乙: '丙丁戊' }], true)).source, '**丙丁戊**');
    } },
    ...[false, true].map(live => ({ name: `mapping/contexts/${live ? 'live' : 'source'}`, run: async () => {
      equal((await convert('𠀀**é**😀', [{ '𠀀é😀': '𠀁á😃' }], false, undefined, live)).source, '𠀁**á**😃');
      equal((await convert('[[软件]]', [{ 软件: '軟體' }], false, undefined, live)).source, '[[软件|軟體]]');
      await rejectsCode(convert('[[软件]]', [{ 软件: '軟體' }], false, { from: 2, to: 4 }, live), 'PARTIAL_UNIT');
      equal((await convert('&#x7532;', [{ 甲: '乙' }], false, undefined, live)).source, '乙');
      await rejectsCode(convert('&#x7532;', [{ 甲: '乙' }], false, { from: 2, to: 6 }, live), 'PARTIAL_UNIT');
      equal((await convert('$甲$', [{ 甲: '{' }], false, undefined, live)).source, '$\\{$');
      equal((await convert('$甲x$', [{ 甲: 'α' }], false, undefined, live)).source, '$\\alpha x$');
      equal((await convert('$\\times$', [{ '×': '÷' }], false, undefined, live)).source, '$\\div$');
      await rejectsCode(convert('甲**乙**', [{ 甲乙: '丙' }], true, { from: 0, to: 4 }, live), 'UNSAFE_MAPPING');
      await rejectsCode(convert('甲\n乙', [{ 甲: '丙', 乙: '丁丁' }], false, undefined, live), 'LENGTH_CHANGED');
      await rejectsCode(convert('甲', [{ 甲: '\n' }], false, undefined, live), 'UNSAFE_MAPPING');
      equal((await convert('外甲外', [{ 甲: '乙' }], false, { from: 1, to: 2 }, live)).source, '外乙外');
    } })),
    { name: 'mapping/neighboring-math-command', run: async () => {
      equal((await convert('$\\alpha甲$', [{ 甲: 'x' }], false, { from: 7, to: 8 })).source, '$\\alpha x$');
      equal((await convert('$\\text甲$', [{ 甲: 'x' }], false, { from: 6, to: 7 })).source, '$\\text{x}$');
    } },
    { name: 'mapping/table-and-fence', run: async () => {
      const table = '| 甲 | 乙 |\n| -- | -- |';
      equal((await convert(table, [{ 甲: '|' }])).source, '| \\| | 乙 |\n| -- | -- |');
      await rejectsCode(convert('```\n甲\n```', [{ 甲: '```' }], true, { from: 4, to: 5 }), 'UNSAFE_MAPPING');
      equal((await convert('甲\n乙', [{ 甲: '丙', 乙: '丁' }])).source, '丙\n丁');
    } },
    { name: 'mapping/syntax', run: async () => {
      equal((await convert('\\[说明\\]', [{ '[说明]': '【說明】' }])).source, '【說明】');
      equal((await convert('甲', [{ 甲: '[' }])).source, '\\[');
      await rejectsCode(convert('\\[', [{ '[': '【' }], false, { from: 1, to: 2 }), 'PARTIAL_UNIT');
      await rejectsCode(convert('`甲`', [{ 甲: '`' }]), 'UNSAFE_MAPPING');
      equal((await convert('未变化', [{ 甲: '乙' }])).patch.changes, []);
    } },
  ];
}
