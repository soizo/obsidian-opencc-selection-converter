import { PluginError } from '../errors';
import { regionAllows, type Projection, type Region, type RuleSettings, type Span, type VisibleUnit } from './types';

export type MathProjection = Pick<Projection, 'runs' | 'regions' | 'fingerprint'> & { protected: Span[] };
export const MATH_SYMBOLS: Readonly<Record<string, string>> = Object.freeze({
  times: '×', cdot: '⋅', pm: '±', mp: '∓', div: '÷', le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', infty: '∞',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'ϕ', chi: 'χ', psi: 'ψ', omega: 'ω',
  varepsilon: 'ε', vartheta: 'ϑ', varkappa: 'ϰ', varpi: 'ϖ', varrho: 'ϱ', varsigma: 'ς', varphi: 'φ', digamma: 'ϝ',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω', varTheta: 'ϴ',
});
export const MATH_ENCODINGS: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(Object.entries(MATH_SYMBOLS).reverse().map(([name, symbol]) => [symbol, `\\${name}`])));
const fonts = new Set(['text', 'textrm', 'textbf', 'textit', 'mathrm', 'mathbf', 'mathit', 'mathsf', 'mathtt', 'mathbb', 'mathcal', 'operatorname']);
const textFonts = new Set(['text', 'textrm', 'textbf', 'textit', 'operatorname']);
const escaped = new Set(['{', '}', '%', '#', '$', '&', '_', ' ']);

export function projectLatex(source: string, root: Region, selection: Span, rules: RuleSettings): MathProjection {
  const result: MathProjection = { runs: [], regions: [], protected: [], fingerprint: '' };
  if (!regionAllows(root, selection, rules)) return result;
  const width = source.startsWith('$$', root.source.from) ? 2 : 1;
  const delimiter = '$'.repeat(width);
  const fail = (from: number, message: string): never => { throw new PluginError('UNSUPPORTED_MATH', message, { sourceSpan: { from, to: Math.min(from + 1, root.source.to) } }); };
  if (!source.startsWith(delimiter, root.source.from) || source.slice(root.source.to - width, root.source.to) !== delimiter || root.source.to - root.source.from < width * 2) fail(root.source.from, '数学定界符不完整。');
  const body = root.content ?? { from: root.source.from + width, to: root.source.to - width };
  const exclusions = new Map((root.excluded ?? []).map(span => [span.from, span.to]));
  result.protected.push(...(root.excluded ?? []));
  const structure: unknown[] = [];
  let units: VisibleUnit[] = [];
  const flush = () => { if (units.length) result.runs.push({ units }); units = []; };
  const protect = (from: number, to: number) => { result.protected.push({ from, to }); };
  const overlaps = (span: Span) => span.from < selection.to && span.to > selection.from;
  function emit(text: string, span: Span, region: Region, textMode: boolean, formats: string[], encoding: VisibleUnit['encoding'], command?: string) {
    if (!overlaps(span) || !regionAllows(region, selection, rules)) { flush(); return; }
    const chain: string[] = [];
    for (let current: Region | undefined = region; current; current = current.parent) chain.unshift(current.id);
    units.push({ text, source: span, context: 'math', encoding, formats, regionIds: chain,
      partial: span.from < selection.from || span.to > selection.to, math: { command, textMode } });
  }
  function commandAt(from: number, end: number): { name: string; to: number } {
    if (from + 1 >= end) return fail(from, '数学转义不完整。');
    const word = /^[A-Za-z]+/.exec(source.slice(from + 1, end))?.[0];
    return { name: word ?? source[from + 1]!, to: from + 1 + (word?.length ?? 1) };
  }
  function closing(from: number, end: number): number {
    const stack = [source[from] === '[' ? ']' : '}'];
    for (let offset = from + 1; offset < end; offset++) {
      const character = source[offset];
      if (character === '\\') { offset = commandAt(offset, end).to - 1; continue; }
      if (character === '%') { const newline = source.indexOf('\n', offset); if (newline < 0 || newline >= end) break; offset = newline; continue; }
      if (character === '{' || character === '[' && stack[stack.length - 1] === ']') stack.push(character === '{' ? '}' : ']');
      else if (character === '}' || character === ']' && stack[stack.length - 1] === ']') {
        if (stack.pop() !== character) return fail(offset, '数学分组重叠。');
        if (!stack.length) return offset;
      }
      if (stack.length > 64) return fail(offset, '数学嵌套超过上限。');
    }
    return fail(from, '数学分组不平衡。');
  }
  function argument(from: number, end: number, parent: Region, textMode: boolean, formats: string[], depth: number, optional = false): number {
    while (from < end && (/\s/.test(source[from]!) || exclusions.has(from))) {
      const to = exclusions.get(from) ?? from + 1;
      protect(from, to); from = to;
    }
    if (from >= end) return fail(from, '数学命令缺少参数。');
    const braced = source[from] === '{' || optional && source[from] === '[';
    const close = braced ? closing(from, end) : source[from] === '\\' ? commandAt(from, end).to : from + (source.codePointAt(from)! > 0xffff ? 2 : 1);
    const to = braced ? close + 1 : close;
    if (!braced && /[}^_$]/.test(source[from]!)) return fail(from, '数学参数结构无效。');
    const group: Region = { id: `${root.id}:group:${from}`, kind: 'mathGroup', source: { from, to }, parentId: parent.id, parent, content: { from: from + (braced ? 1 : 0), to: close } };
    result.regions.push(group);
    structure.push(['group', from, to, parent.id, formats]);
    flush();
    if (braced) { protect(from, from + 1); protect(close, to); }
    if (regionAllows(group, selection, rules) && overlaps(group.source)) parse(group.content!.from, group.content!.to, group, textMode, formats, depth + 1);
    else protect(from, to);
    flush();
    return to;
  }
  function parse(from: number, end: number, region: Region, textMode: boolean, formats: string[], depth: number): void {
    if (depth > 64) fail(from, '数学嵌套超过上限。');
    const scripts = new Set<string>();
    for (let offset = from; offset < end;) {
      const excludedEnd = exclusions.get(offset);
      if (excludedEnd !== undefined) { offset = excludedEnd; continue; }
      const character = source[offset]!;
      if (character === '{') { scripts.clear(); offset = argument(offset, end, region, textMode, formats, depth); continue; }
      if (character === '}' || character === '$') fail(offset, '数学结构不平衡。');
      if (character === '^' || character === '_') {
        if (scripts.has(character)) fail(offset, '同一数学对象有重复上下标。');
        scripts.add(character);
        flush(); protect(offset, offset + 1); structure.push([character, offset]);
        offset = argument(offset + 1, end, region, textMode, formats, depth);
        continue;
      }
      if (character === '%') {
        const newline = source.indexOf('\n', offset);
        const to = newline < 0 ? end : Math.min(end, newline);
        protect(offset, to); flush(); offset = to; continue;
      }
      if (character === '\n' || character === '\r') { protect(offset, offset + 1); flush(); offset++; continue; }
      if (/\s/.test(character) && !textMode) { protect(offset, offset + 1); offset++; continue; }
      if (character === '\\') {
        scripts.clear();
        const command = commandAt(offset, end);
        const span = { from: offset, to: command.to };
        structure.push(['command', command.name, span]);
        if (Object.hasOwn(MATH_SYMBOLS, command.name)) {
          emit(MATH_SYMBOLS[command.name]!, span, region, textMode, formats, 'mathCommand', command.name);
          offset = command.to; continue;
        }
        if (escaped.has(command.name)) {
          emit(command.name, span, region, textMode, formats, 'mathEscape', command.name);
          offset = command.to; continue;
        }
        if (fonts.has(command.name)) {
          protect(offset, command.to);
          offset = argument(command.to, end, region, textMode || textFonts.has(command.name), [...formats, command.name], depth);
          continue;
        }
        if (command.name === 'frac') {
          protect(offset, command.to);
          offset = argument(command.to, end, region, textMode, formats, depth);
          offset = argument(offset, end, region, textMode, formats, depth);
          continue;
        }
        if (command.name === 'sqrt') {
          protect(offset, command.to);
          offset = command.to;
          while (offset < end && /\s/.test(source[offset]!)) { protect(offset, offset + 1); offset++; }
          if (source[offset] === '[') offset = argument(offset, end, region, textMode, formats, depth, true);
          offset = argument(offset, end, region, textMode, formats, depth);
          continue;
        }
        // An unknown macro's arity/rendering is unknown too: never treat its later arguments as ordinary text.
        if (overlaps({ from: offset, to: end })) fail(offset, '选区受不支持的数学命令影响。');
        protect(offset, end); flush(); return;
      }
      if (character === '&' || character === '~' || character === '#') {
        if (overlaps({ from: offset, to: offset + 1 })) fail(offset, '选区包含不支持的数学布局语法。');
        protect(offset, offset + 1); flush(); offset++; continue;
      }
      scripts.clear();
      const to = offset + (source.codePointAt(offset)! > 0xffff ? 2 : 1);
      emit(source.slice(offset, to), { from: offset, to }, region, textMode, formats, 'mathPlain');
      offset = to;
    }
  }
  protect(root.source.from, body.from);
  parse(body.from, body.to, root, false, [], 0);
  protect(body.to, root.source.to);
  flush();
  result.fingerprint = JSON.stringify(structure);
  return result;
}
