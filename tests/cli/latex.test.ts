import { captureTarget } from '../../src/selection/editor';
import { projectMarkdown } from '../../src/selection/markdown';
import { DEFAULT_RULES, type RuleSettings, type Span } from '../../src/selection/types';
import { equal, rejectsCode } from './assert';
import { openFixture, type TestPlugin } from './fixtures';

export function latexTests(plugin: TestPlugin) {
  async function project(text: string, live: boolean, selection: Span = { from: 0, to: text.length }, rules: RuleSettings = DEFAULT_RULES) {
    const view = await openFixture(plugin.app, text);
    await view.setState({ ...view.getState(), mode: 'source', source: !live }, { history: false });
    for (let attempt = 0; view.editor.getValue() !== text && attempt < 60; attempt++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    equal(view.editor.getValue(), text);
    view.editor.setSelection(view.editor.offsetToPos(selection.from), view.editor.offsetToPos(selection.to));
    return projectMarkdown(captureTarget(view).cm.state, selection, rules);
  }
  const words = (projection: ReturnType<typeof projectMarkdown>) => projection.runs.map(run => run.units.map(unit => unit.text).join(''));
  return [false, true].flatMap(live => {
    const mode = live ? 'live' : 'source';
    return [
      { name: `latex/symbol-not-command/${mode}`, run: async () => {
        const result = await project('$\\times$', live);
        equal(words(result), ['×']);
        equal(result.runs[0]!.units[0]!.source, { from: 1, to: 7 });
        equal(result.runs[0]!.units[0]!.encoding, 'mathCommand');
        equal(words(await project('$甲+乙$', live)), ['甲+乙']);
        equal(words(await project('$\\alpha+\\vartheta\\leq\\infty$', live)), ['α+ϑ≤∞']);
      } },
      { name: `latex/nested-policy/${mode}`, run: async () => {
        const text = '$\\frac{甲}{乙}$';
        equal(words(await project(text, live)), []);
        const from = text.indexOf('甲');
        equal(words(await project(text, live, { from, to: from + 1 })), ['甲']);
        const rules = structuredClone(DEFAULT_RULES);
        rules.regions.mathGroup = 'always';
        equal(words(await project(text, live, { from: 0, to: text.length }, rules)), ['甲', '乙']);
        equal(words(await project('$x^{甲}_{乙}$', live, undefined, rules)), ['x', '甲', '乙']);
        equal(words(await project('$\\sqrt[甲]{乙}$', live, undefined, rules)), ['甲', '乙']);
        equal(words(await project('$\\text{软\\textbf{件}}$', live, undefined, rules)), ['软', '件']);
        rules.regions.inlineMath = 'never';
        equal(words(await project(text, live, { from, to: from + 1 }, rules)), []);
      } },
      { name: `latex/unsupported/${mode}`, run: async () => {
        await rejectsCode(project('$\\unknown{甲}$', live), 'UNSUPPORTED_MATH');
        await rejectsCode(project('$\\begin{matrix}甲\\end{matrix}$', live), 'UNSUPPORTED_MATH');
        await rejectsCode(project('$甲{乙$', live), 'UNSUPPORTED_MATH');
        equal(words(await project('$甲{\\unknown 乙}$', live)), ['甲']);
        equal(words(await project('正文 $\\unknown$', live)), ['正文 ']);
        equal(words(await project('> $\\unknown$', live)), []);
      } },
      { name: `latex/command-context/${mode}`, run: async () => {
        const unknown = '$\\unknown{甲}$';
        const from = unknown.indexOf('甲');
        await rejectsCode(project(unknown, live, { from, to: from + 1 }), 'UNSUPPORTED_MATH');
        const rules = structuredClone(DEFAULT_RULES);
        rules.regions.mathGroup = 'always';
        await rejectsCode(project('$甲^乙^丙$', live, undefined, rules), 'UNSUPPORTED_MATH');
        for (const command of ['text', 'textrm', 'textbf', 'textit', 'mathrm', 'mathbf', 'mathit', 'mathsf', 'mathtt', 'mathbb', 'mathcal', 'operatorname']) {
          equal(words(await project(`$\\${command}{软件}$`, live, undefined, rules)), ['软件']);
        }
        equal(words(await project('$\\mathbf\\alpha$', live, undefined, rules)), ['α']);
        equal(words(await project('$\\frac{甲_{乙}}{\\sqrt[丙]{丁}}$', live, undefined, rules)), ['甲', '乙', '丙', '丁']);
      } },
      { name: `latex/quoted-display/${mode}`, run: async () => {
        const rules = structuredClone(DEFAULT_RULES);
        rules.regions.quote = 'always';
        rules.regions.blockMath = 'always';
        equal(words(await project('> $$\n> 甲\n> 乙\n> $$', live, undefined, rules)), ['甲', '乙']);
        rules.regions.quote = 'never';
        equal(words(await project('> $$\n> \\unknown\n> $$', live, undefined, rules)), []);
      } },
      { name: `latex/escape-and-partial/${mode}`, run: async () => {
        equal(words(await project('$\\{甲\\}$', live)), ['{甲}']);
        const partial = await project('$\\times$', live, { from: 3, to: 6 });
        equal(words(partial), ['×']);
        equal(partial.runs[0]!.units[0]!.partial, true);
        equal(words(await project('$$\n甲\n乙\n$$', live)), ['甲', '乙']);
      } },
    ];
  });
}
