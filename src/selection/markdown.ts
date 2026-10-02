import type { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { PluginError } from '../errors';
import { LIMITS } from '../limits';
import { projectLatex } from './latex';
import type { Projection, Region, RegionKind, RuleSettings, Span, VisibleUnit } from './types';

import { regionAllows } from './types';
export { regionAllows } from './types';

type Token = Span & { name: string; tags: string[] };

export function projectMarkdown(state: EditorState, selection: Span, rules: RuleSettings): Projection {
  const text = state.doc.toString();
  if (!Number.isInteger(selection.from) || !Number.isInteger(selection.to) || selection.from < 0 || selection.to > text.length || selection.from >= selection.to) throw new PluginError('INVALID_SELECTION', '选区范围无效。');
  let scalarCount = 0;
  for (let offset = selection.from; offset < selection.to; offset += text.codePointAt(offset)! > 0xffff ? 2 : 1) {
    if (++scalarCount > LIMITS.selectionScalars) throw new PluginError('SELECTION_LIMIT', '选区超过字符数量上限。');
  }
  for (const offset of [selection.from, selection.to]) {
    if (offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset]!)) throw new PluginError('INVALID_SELECTION', '选区切中了 Unicode 字符。');
  }
  const tree = ensureSyntaxTree(state, text.length, 200);
  if (!tree || tree.length < text.length) throw new PluginError('SYNTAX_INCOMPLETE', '语法上下文尚未完整解析，请重试。');
  const tokens: Token[] = [];
  const blocks: Token[] = [];
  tree.iterate({ enter(node) {
    if (node.name === 'Document') return;
    const token = { name: node.name, tags: node.name.split('_'), from: node.from, to: node.to };
    if (token.tags.some(tag => tag.startsWith('HyperMD-'))) blocks.push(token);
    else tokens.push(token);
  } });
  const styles: Projection['styles'] = [];
  const openStyles = new Map<string, Span>();
  for (const token of tokens) for (const kind of ['strong', 'em', 'strikethrough', 'highlight']) {
    if (!token.tags.includes(`formatting-${kind}`) || token.tags.includes('hmd-codeblock')) continue;
    const open = openStyles.get(kind);
    if (open) { styles.push({ kind, open, close: { from: token.from, to: token.to } }); openStyles.delete(kind); }
    else openStyles.set(kind, { from: token.from, to: token.to });
  }
  const regions: Region[] = [];
  function region(kind: RegionKind, from: number, to: number, parent?: Region): Region {
    const result: Region = { id: `${kind}:${from}:${regions.length}`, kind, source: { from, to }, parentId: parent?.id ?? null, parent };
    regions.push(result);
    return result;
  }
  const quoteLines = new Map<number, number>();
  for (const token of [...blocks, ...tokens]) for (const tag of token.tags) {
    const match = /^(?:HyperMD-)?quote-(\d+)$/.exec(tag);
    if (match) {
      const line = state.doc.lineAt(token.from).number;
      quoteLines.set(line, Math.max(quoteLines.get(line) ?? 0, Number(match[1])));
    }
  }
  const quotes: Region[] = [];
  for (let number = 1; number <= state.doc.lines; number++) {
    const line = state.doc.line(number);
    const depth = quoteLines.get(number) ?? 0;
    quotes.length = Math.min(quotes.length, depth);
    for (let level = 0; level < depth; level++) {
      if (!quotes[level]) quotes[level] = region('quote', line.from, line.to, quotes[level - 1]);
      else quotes[level]!.source.to = line.to;
    }
  }
  const quoteAt = (position: number) => regions.filter(item => item.kind === 'quote' && item.source.from <= position && position < item.source.to).at(-1);
  let fenced: Region | undefined;
  for (const block of blocks) {
    if (block.tags.includes('HyperMD-codeblock-begin')) fenced = region('codeBlock', block.from, block.to, quoteAt(block.from));
    else if (fenced && block.tags.includes('HyperMD-codeblock')) fenced.source.to = block.to;
    if (block.tags.includes('HyperMD-codeblock-end')) fenced = undefined;
  }
  let inline: Region | undefined;
  let math: Region | undefined;
  let indented: Region | undefined;
  const escapes = new Map<number, Span>();
  for (const token of tokens) {
    const tags = token.tags;
    if (tags.includes('hmd-indented-code')) {
      const line = state.doc.lineAt(token.from);
      if (indented && (state.doc.lineAt(indented.source.to).number === line.number || text.slice(indented.source.to, line.from).trim() === '')) indented.source.to = line.to;
      else indented = region('codeBlock', line.from, line.to, quoteAt(token.from));
    } else if (tags.includes('inline-code') && tags.includes('formatting-code')) {
      if (inline) { inline.source.to = token.to; inline = undefined; }
      else inline = region('inlineCode', token.from, token.to, quoteAt(token.from));
    }
    if (tags.includes('formatting-math-begin')) math = region(text.slice(token.from, token.to).includes('$$') ? 'blockMath' : 'inlineMath', token.from, token.to, quoteAt(token.from));
    else if (math && tags.some(tag => tag === 'math' || tag.startsWith('math-'))) math.source.to = token.to;
    if (tags.includes('formatting-math-end')) math = undefined;
    if (tags.includes('hmd-escape-backslash')) {
      const width = text.codePointAt(token.to)! > 0xffff ? 2 : 1;
      escapes.set(token.from, { from: token.from, to: token.to + width });
    }
  }
  const entities = new Map<number, { source: Span; text: string }>();
  const entityParser = new DOMParser();
  for (const match of text.matchAll(/&(?:#[xX][0-9a-fA-F]{1,8}|#[0-9]{1,10}|[A-Za-z][A-Za-z0-9]{0,31});/g)) {
    const source = { from: match.index, to: match.index + match[0].length };
    if (source.to <= selection.from || source.from >= selection.to) continue;
    if (entities.size >= 4096) throw new PluginError('PROJECTION_LIMIT', '选区实体数量超过上限。');
    // Input is a single validated reference, never arbitrary markup.
    const decoded = entityParser.parseFromString(match[0], 'text/html').body.textContent ?? '';
    if (decoded !== match[0]) entities.set(source.from, { source, text: decoded });
  }
  const wikis: { source: Span; target: string; aliased: boolean }[] = [];
  let wikiStart: number | undefined;
  let aliased = false;
  for (const token of tokens) {
    if (token.tags.includes('formatting-link-start') && text.slice(token.from, token.to) === '[[') { wikiStart = token.from; aliased = false; }
    if (token.tags.includes('link-has-alias')) aliased = true;
    if (wikiStart !== undefined && token.tags.includes('formatting-link-end')) {
      wikis.push({ source: { from: wikiStart, to: token.to }, target: text.slice(wikiStart + 2, token.from), aliased });
      wikiStart = undefined;
    }
  }
  const tableLines = new Set(blocks.filter(block => block.tags.includes('HyperMD-table-row')).map(block => state.doc.lineAt(block.from).number));
  // Only allocate per-character masks for the selected window, not the entire note.
  let start = selection.from;
  for (const span of [...escapes.values(), ...Array.from(entities.values(), entity => entity.source)]) if (span.from < start && span.to > start) start = span.from;
  const mask = new Uint8Array(selection.to - start);
  const codeIndent = new Uint8Array(mask.length);
  const mark = (span: Span, value: number) => {
    const from = Math.max(start, span.from), to = Math.min(selection.to, span.to);
    for (let offset = from; offset < to; offset++) mask[offset - start] = Math.max(mask[offset - start]!, value);
  };
  // 1: invisible syntax; 2: protected content/run boundary; 3: unsupported mapping.
  let htmlStart: number | undefined;
  for (const token of tokens) {
    const tags = token.tags;
    if (tags.some(tag => ['comment', 'hmd-frontmatter', 'image', 'hmd-embed', 'footref'].includes(tag)) || tags.includes('url') && !tags.includes('string')) mark(token, 2);
    else if (tags.some(tag => tag === 'formatting' || tag.startsWith('formatting-')) || tags.includes('url') || tags.includes('link-has-alias') || tags.includes('link-alias-pipe') || tags.includes('hmd-footnote')) mark(token, 1);
    if (tags.includes('hmd-table-sep')) mark(token, 2);
    if (tags.includes('url') && tags.includes('link') && text[token.from - 1] === '<' && text[token.to] === '>') mark({ from: token.from - 1, to: token.to + 1 }, 2);
    if (tags.includes('hmd-html-begin')) htmlStart = token.from;
    if (tags.includes('hmd-html-end') && htmlStart !== undefined) { mark({ from: htmlStart, to: token.to }, 3); htmlStart = undefined; }
    if (tags.includes('hmd-indented-code')) {
      const line = state.doc.lineAt(token.from);
      const prefix = /^(?: {4}|\t)/.exec(line.text)?.[0].length ?? 0;
      const from = Math.max(start, line.from), to = Math.min(selection.to, line.from + prefix);
      if (from < to) codeIndent.fill(1, from - start, to - start);
    }
  }
  if (htmlStart !== undefined) mark({ from: htmlStart, to: text.length }, 3);
  for (const wiki of wikis) if (!wiki.aliased && /[/#^\\\\]/.test(wiki.target)) mark(wiki.source, 3);
  // Conservatively protect bare addresses even where host highlighting misses a word boundary.
  for (const match of text.matchAll(/(?:https?:\/\/|mailto:)[^\s<>]+/g)) {
    if (!tokens.some(token => token.from <= match.index && match.index < token.to && (token.tags.includes('link') || token.tags.includes('hmd-internal-link')))) mark({ from: match.index, to: match.index + match[0].length }, 2);
  }
  for (const block of blocks) if (block.tags.includes('HyperMD-footnote') && /^\s*\[(?!\^)/.test(text.slice(block.from, block.to))) mark(block, 2);
  for (const block of blocks) if (block.tags.includes('HyperMD-table-row') && /^\s*\|?[\s:|-]+\|?\s*$/.test(text.slice(block.from, block.to))) mark(block, 2);
  const runs: Projection['runs'] = [];
  let units: VisibleUnit[] = [];
  let previousChain = '';
  const flush = () => { if (units.length) runs.push({ units }); units = []; };
  let tokenIndex = 0;
  for (let offset = start; offset < selection.to;) {
    while (tokenIndex < tokens.length && tokens[tokenIndex]!.to <= offset) tokenIndex++;
    const token = tokens[tokenIndex];
    const tags = token && token.from <= offset ? token.tags : [];
    const chain = regions.filter(item => item.source.from <= offset && offset < item.source.to);
    const chainKey = chain.map(item => item.id).join('/');
    if (chainKey !== previousChain) flush();
    previousChain = chainKey;
    if (chain.some(item => !regionAllows(item, selection, rules))) { flush(); offset++; continue; }
    const mathRegion = chain.find(item => item.kind === 'inlineMath' || item.kind === 'blockMath');
    if (mathRegion) {
      flush();
      let quoteDepth = 0;
      for (let parent = mathRegion.parent; parent; parent = parent.parent) if (parent.kind === 'quote') quoteDepth++;
      mathRegion.excluded = [];
      for (let number = state.doc.lineAt(mathRegion.source.from).number; quoteDepth && number <= state.doc.lineAt(mathRegion.source.to).number; number++) {
        const line = state.doc.line(number);
        let prefix = 0;
        for (let level = 0; level < quoteDepth; level++) {
          const match = /^[ \t]{0,3}>[ \t]?/.exec(line.text.slice(prefix));
          if (!match) break;
          prefix += match[0].length;
        }
        if (prefix) mathRegion.excluded.push({ from: line.from, to: line.from + prefix });
      }
      const projected = projectLatex(text, mathRegion, selection, rules);
      runs.push(...projected.runs);
      regions.push(...projected.regions);
      offset = mathRegion.source.to;
      continue;
    }
    if (text[offset] === '\n' || text[offset] === '\r') { flush(); offset++; continue; }
    const code = chain.some(item => item.kind === 'codeBlock' || item.kind === 'inlineCode');
    if (code && codeIndent[offset - start]) { offset++; continue; }
    const escape = code ? undefined : escapes.get(offset);
    if (!escape) {
      if (mask[offset - start] === 3 && !code) throw new PluginError('UNSUPPORTED_MARKDOWN', '选区包含不支持的 HTML 映射。', { sourceSpan: { from: offset, to: offset + 1 } });
      if (mask[offset - start] === 2 && !code) { flush(); offset++; continue; }
      if (mask[offset - start] === 1 && (!code || tags.includes('formatting-code') || tags.includes('formatting-code-block') || tags.includes('formatting-quote') || tags.includes('hmd-indented-code'))) { offset++; continue; }
    }
    const width = text.codePointAt(offset)! > 0xffff ? 2 : 1;
    const entity = code ? undefined : entities.get(offset);
    const wiki = code ? undefined : wikis.find(item => !item.aliased && item.source.from <= offset && offset < item.source.to);
    const source = escape ?? entity?.source ?? { from: offset, to: offset + width };
    units.push({ text: escape ? text.slice(escape.from + 1, escape.to) : entity?.text ?? text.slice(source.from, source.to), source,
      encoding: escape ? 'escape' : entity ? 'entity' : wiki ? 'wikiAlias' : 'plain', context: code ? 'code' : tableLines.has(state.doc.lineAt(offset).number) ? 'table' : tags.some(tag => tag.includes('link')) ? 'link' : 'text',
      wiki: wiki ? { source: wiki.source, target: wiki.target } : undefined,
      formats: tags.filter(tag => ['strong', 'em', 'strikethrough', 'highlight'].includes(tag)),
      regionIds: chain.map(item => item.id), partial: source.from < selection.from || source.to > selection.to || !!wiki && (wiki.source.from < selection.from || wiki.source.to > selection.to) });
    offset = source.to;
  }
  flush();
  return { source: text, styles, rules: structuredClone(rules), selection, runs, regions, fingerprint: JSON.stringify(tokens.map(token => [token.name, token.from, token.to])) };
}
