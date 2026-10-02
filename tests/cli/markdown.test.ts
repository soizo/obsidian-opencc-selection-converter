import { ensureSyntaxTree } from '@codemirror/language';
import { captureTarget } from '../../src/selection/editor';
import { projectMarkdown } from '../../src/selection/markdown';
import { DEFAULT_RULES, type RuleSettings, type Span } from '../../src/selection/types';
import { equal, ok, rejectsCode } from './assert';
import { openFixture, type TestPlugin } from './fixtures';

export function markdownTests(plugin: TestPlugin) {
  async function editor(text: string, live: boolean, selection: Span) {
    const view = await openFixture(plugin.app, text);
    await view.setState({ ...view.getState(), mode: 'source', source: !live }, { history: false });
    // Mode switches and vault.modify can finish before the editor receives its file update.
    for (let attempt = 0; view.editor.getValue() !== text && attempt < 60; attempt++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    equal(view.editor.getValue(), text);
    view.editor.setSelection(view.editor.offsetToPos(selection.from), view.editor.offsetToPos(selection.to));
    const state = captureTarget(view).cm.state;
    equal(state.doc.length, text.length);
    return state;
  }
  async function project(text: string, live: boolean, selection: Span = { from: 0, to: text.length }, rules: RuleSettings = DEFAULT_RULES) {
    return projectMarkdown(await editor(text, live, selection), selection, rules);
  }
  const textOf = (projection: ReturnType<typeof projectMarkdown>) => projection.runs.map(run => run.units.map(unit => unit.text).join(''));
  return [
    { name: 'markdown/host-tree-probe', run: async () => {
      const text = '---\nname: 隐藏\n---\n# 标题\n软**件** 与 *文字* ~~删除~~ ==高亮==\n[说明](https://example.com/软件 "标题") [[目标|别名]] [[目标]] ![[嵌入]] ![图片](image.png)\n\\[说明\\] &amp; &#x4E2D;\n> [!note] 标题\n> 正文 `代码`\n\n```js\n软件\n```\n\n    缩进代码\n\n| 左 | 右 |\n| -- | -- |\n| 软件 | 文字 |\n\n%% 隐藏 %% <!-- 隐藏 -->\n正文[^注] https://example.com/软件\n[^注]: 脚注正文\n$x$ <span>HTML</span>\n\n[说明][id]\n\n[id]: https://example.com/软件 "标题"\n甲<https://example.com/软件>乙';
      for (const live of [false, true]) for (const sample of [text, '    软件\n    文字']) {
        const state = await editor(sample, live, { from: 0, to: sample.length });
        const tree = ensureSyntaxTree(state, state.doc.length, 200);
        ok(tree, 'Host syntax tree unavailable');
        const nodes: {name: string; from: number; to: number; text: string}[] = [];
        tree.iterate({ enter(node) { nodes.push({ name: node.name, from: node.from, to: node.to, text: sample.slice(node.from, node.to) }); } });
        const folder = '.opencc-test-results';
        if (!await plugin.app.vault.adapter.exists(folder)) await plugin.app.vault.adapter.mkdir(folder);
        await plugin.app.vault.adapter.write(`${folder}/markdown-tree-${live ? 'live' : 'source'}${sample === text ? '' : '-indented'}.json`, JSON.stringify(nodes, null, 2));
      }
    } },
    ...[false, true].flatMap(live => {
      const mode = live ? 'live' : 'source';
      return [
        { name: `markdown/visible-runs/${mode}`, run: async () => {
          equal(textOf(await project('软**件**', live)), ['软件']);
          equal(textOf(await project('[说明](https://example.com/软件)', live)), ['说明']);
          equal(textOf(await project('甲\n乙', live)), ['甲', '乙']);
        } },
        { name: `markdown/inside-rule/${mode}`, run: async () => {
          equal(textOf(await project('正文\n`代码`', live)), ['正文']);
          equal(textOf(await project('`代码`', live, { from: 1, to: 3 })), ['代码']);
          equal(textOf(await project('`甲`与`乙`', live)), ['与']);
          const text = '> 正文 `代码`';
          equal(textOf(await project(text, live, { from: 2, to: text.length })), ['正文 ']);
          const rules = structuredClone(DEFAULT_RULES);
          rules.regions.quote = 'never';
          rules.regions.inlineCode = 'always';
          equal(textOf(await project(text, live, { from: 6, to: 8 }, rules)), []);
        } },
        { name: `markdown/entities-aliases/${mode}`, run: async () => {
          const entity = await project('&#x4E2D;&amp;', live);
          equal(textOf(entity), ['中&']);
          equal(entity.runs[0]!.units[0]!.source, { from: 0, to: 8 });
          equal(entity.runs[0]!.units[0]!.encoding, 'entity');
          equal((await project('&amp;', live, { from: 2, to: 4 })).runs[0]!.units[0]!.partial, true);
          equal(textOf(await project('[[目标|别名]]', live)), ['别名']);
          const wiki = await project('[[软件]]', live);
          equal(textOf(wiki), ['软件']);
          equal(wiki.runs[0]!.units[0]!.encoding, 'wikiAlias');
          equal((await project('[[软件]]', live, { from: 2, to: 4 })).runs[0]!.units[0]!.partial, true);
        } },
        { name: `markdown/protected-structures/${mode}`, run: async () => {
          equal(textOf(await project('甲%%隐藏%%乙<!--注释-->丙', live)), ['甲', '乙', '丙']);
          equal(textOf(await project('甲![[嵌入]]乙![图片](image.png)丙', live)), ['甲', '乙', '丙']);
          equal(textOf(await project('---\nx: 隐藏\n---\n正文', live)), ['正文']);
          equal(textOf(await project('甲https://example.com/软件', live)), ['甲']);
          equal(textOf(await project('正文[^注]\n[^注]: 脚注正文', live)), ['正文', ' 脚注正文']);
          await rejectsCode(project('<span>软件</span>', live), 'UNSUPPORTED_MARKDOWN');
          await rejectsCode(project('$软件$', live), 'UNSUPPORTED_MATH');
          equal(textOf(await project('正文 $软件$', live)), ['正文 ']);
        } },
        { name: `markdown/blocks-unicode/${mode}`, run: async () => {
          equal(textOf(await project('# 软件\n- 文字', live)), ['软件', '文字']);
          const table = await project('| 甲 | 乙 |\n| -- | -- |\n| 丙 | 丁 |', live);
          equal(textOf(table), [' 甲 ', ' 乙 ', ' 丙 ', ' 丁 ']);
          ok(table.runs.every(run => run.units.every(unit => unit.context === 'table')));
          const code = '```js\n// 软件\n```';
          equal(textOf(await project(code, live, { from: 6, to: 11 })), ['// 软件']);
          equal(textOf(await project('``软`件``', live)), ['软`件']);
          const unicode = await project('𠀀é', live);
          equal(unicode.runs[0]!.units[0]!.source, { from: 0, to: 2 });
          equal(textOf(unicode), ['𠀀é']);
          await rejectsCode(project('𠀀甲', live, { from: 1, to: 3 }), 'INVALID_SELECTION');
        } },
        { name: `markdown/recursive-matrix/${mode}`, run: async () => {
          const text = '前\n> 外 `内`\n\n后';
          for (const quote of ['always', 'inside', 'never'] as const) for (const code of ['always', 'inside', 'never'] as const) {
            const rules = structuredClone(DEFAULT_RULES);
            rules.regions.quote = quote;
            rules.regions.inlineCode = code;
            equal(textOf(await project(text, live, { from: 0, to: text.length }, rules)), quote === 'always' ? ['前', '外 ', ...(code === 'always' ? ['内'] : []), '后'] : ['前', '后']);
            equal(textOf(await project(text, live, { from: 7, to: 8 }, rules)), quote !== 'never' && code !== 'never' ? ['内'] : []);
          }
          equal(textOf(await project('> 甲\n> 乙', live)), ['甲', '乙']);
          equal(textOf(await project('> 甲\n\n> 乙', live)), []);
          equal(textOf(await project('> 外\n>> 内\n> 后', live)), ['外', '后']);
          equal(textOf(await project('    软件\n    文字', live)), ['软件', '文字']);
        } },
        { name: `markdown/reference-links/${mode}`, run: async () => {
          const text = '[说明][id]\n\n[id]: https://example.com/软件 "标题"';
          equal(textOf(await project(text, live)), ['说明']);
          equal(textOf(await project('甲<https://example.com/软件>乙', live)), ['甲', '乙']);
        } },
        { name: `markdown/selection-limit/${mode}`, run: async () => {
          await rejectsCode(project('甲'.repeat(200001), live), 'SELECTION_LIMIT');
        } },
        { name: `markdown/partial-unit/${mode}`, run: async () => {
          const full = await project('\\[', live);
          equal(full.runs[0]!.units[0]!.text, '[');
          equal(full.runs[0]!.units[0]!.source, { from: 0, to: 2 });
          const partial = await project('\\[', live, { from: 1, to: 2 });
          equal(partial.runs[0]!.units[0]!.partial, true);
        } },
      ];
    }),
  ];
}
