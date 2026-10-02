import type { EditorState } from '@codemirror/state';
import type { TraceResult } from '../engine/types';
import type { ExpectedScalar, PatchPlan, Projection, SourceChange, Span, VisibleUnit } from './types';
import { PluginError } from '../errors';
import { MATH_ENCODINGS } from './latex';
import { projectMarkdown } from './markdown';

function unsafe(message: string): never { throw new PluginError('UNSAFE_MAPPING', message); }
function encode(value: string, unit: VisibleUnit): string {
  if (/[\r\n\0]/.test(value)) unsafe('转换不得生成换行或 NUL。');
  if (unit.context === 'code') return value;
  if (unit.context === 'math') {
    let result = '';
    for (const character of value) {
      if (Object.hasOwn(MATH_ENCODINGS, character)) result += MATH_ENCODINGS[character] + ' ';
      else if ('{}%#$&_'.includes(character) || character === ' ' && !unit.math?.textMode) result += `\\${character}`;
      else if ('\\^~'.includes(character)) unsafe('数学结果无法安全编码。');
      else result += character;
    }
    return result;
  }
  return value.replace(/[\\`*_{}\[\]()<>#+\-.!|~=$%&:]/g, '\\$&');
}
function changedSlice(source: string, from: number, to: number, changes: SourceChange[]): string {
  let result = '', cursor = from;
  for (const change of changes.filter(change => change.from >= from && change.to <= to).sort((a, b) => a.from - b.from)) {
    result += source.slice(cursor, change.from) + change.insert;
    cursor = change.to;
  }
  return result + source.slice(cursor, to);
}
const signature = (text: string, unit: VisibleUnit): ExpectedScalar => ({ text, context: unit.context, formats: [...unit.formats].sort() });

export function serialize(projection: Projection, convertedRuns: TraceResult[]): PatchPlan {
  if (convertedRuns.length !== projection.runs.length) unsafe('转换片段数量不匹配。');
  const changes: SourceChange[] = [];
  const mathChanges = new Set<SourceChange>();
  const expected: ExpectedScalar[][] = [];
  for (const [index, run] of projection.runs.entries()) {
    const converted = convertedRuns[index]!;
    // Force-mode intermediate rewrites must not reformat a run whose final text is unchanged.
    // Strict per-match checks have already run before serialization.
    if (converted.output === run.units.map(unit => unit.text).join('')) {
      expected.push(run.units.flatMap(unit => Array.from(unit.text, character => signature(character, unit))));
      continue;
    }
    const owners = run.units.flatMap((unit, unitIndex) => Array.from(unit.text, () => unitIndex));
    const characters = Array.from(converted.output);
    if (characters.length !== converted.origins.length) unsafe('转换来源数量不匹配。');
    const assigned = run.units.map(() => '');
    const expectedRun: ExpectedScalar[] = [];
    let previous = -1;
    for (const [outputIndex, character] of characters.entries()) {
      const origin = converted.origins[outputIndex]!;
      if (!Number.isInteger(origin) || origin < previous || origin < 0 || origin >= owners.length) unsafe('转换来源无效或顺序不安全。');
      previous = origin;
      const owner = owners[origin]!;
      assigned[owner] += character;
      expectedRun.push(signature(character, run.units[owner]!));
    }
    expected.push(expectedRun);
    const wikis = new Map<number, { span: Span; text: string; original: string; unit: VisibleUnit }>();
    for (const [unitIndex, unit] of run.units.entries()) {
      const value = assigned[unitIndex]!;
      if (value !== unit.text && unit.partial) throw new PluginError('PARTIAL_UNIT', '选区只包含源码单元的一部分，请扩展选区。', { sourceSpan: unit.source });
      if (unit.wiki) {
        const key = unit.wiki.source.from;
        const wiki = wikis.get(key) ?? { span: unit.wiki.source, text: '', original: '', unit };
        wiki.text += value; wiki.original += unit.text; wikis.set(key, wiki);
        continue;
      }
      if (value === unit.text) continue;
      let insert = encode(value, unit);
      // Keep an unbraced argument inside its own source replacement; a separator
      // outside that argument would incorrectly broaden an original inside selection.
      const followsCommand = /\\[A-Za-z]+$/.test(projection.source.slice(Math.max(0, unit.source.from - 64), unit.source.from));
      if (unit.context === 'math' && (Array.from(value).length > 1 || followsCommand) && projection.regions.some(region => region.kind === 'mathGroup' && region.source.from === unit.source.from && region.source.to === unit.source.to && region.content?.from === region.source.from)) insert = `{${insert}}`;
      const change = { ...unit.source, insert };
      changes.push(change);
      if (unit.context === 'math') mathChanges.add(change);
    }
    for (const wiki of wikis.values()) if (wiki.text !== wiki.original) changes.push({ from: wiki.span.to - 2, to: wiki.span.to - 2, insert: `|${encode(wiki.text, wiki.unit)}` });
  }
  // Only remove whole, fully selected wrappers whose contents became empty.
  for (const style of [...projection.styles].sort((a, b) => (a.close.to - a.open.from) - (b.close.to - b.open.from))) {
    if (style.open.from < projection.selection.from || style.close.to > projection.selection.to) continue;
    if (!changes.some(change => change.from >= style.open.to && change.to <= style.close.from)) continue;
    if (changedSlice(projection.source, style.open.to, style.close.from, changes) === '') changes.push({ ...style.open, insert: '' }, { ...style.close, insert: '' });
  }
  const unique = new Map(changes.map(change => [`${change.from}:${change.to}`, change]));
  const ordered = Array.from(unique.values()).sort((a, b) => a.from - b.from || a.to - b.to);
  // A TeX control word needs a separator only before a following ASCII letter.
  // An unnecessary space immediately before $ can disable inline math in the host.
  let nextOffset = projection.source.length;
  let nextCharacter = '';
  for (let index = ordered.length - 1; index >= 0; index--) {
    const change = ordered[index]!;
    const following = change.to < nextOffset ? projection.source[change.to] ?? '' : nextCharacter;
    if (mathChanges.has(change) && /\\[A-Za-z]+ $/.test(change.insert) && !/[A-Za-z]/.test(following)) change.insert = change.insert.slice(0, -1);
    nextCharacter = change.insert[0] ?? following;
    nextOffset = change.from;
  }
  let cursor = 0;
  let tail = '';
  for (const change of ordered) {
    const gap = projection.source.slice(Math.max(cursor, change.from - 64), change.from);
    tail = (tail + gap).slice(-64);
    if (mathChanges.has(change) && /^[A-Za-z]/.test(change.insert) && /\\[A-Za-z]+$/.test(tail)) change.insert = ` ${change.insert}`;
    tail = (tail + change.insert).slice(-64);
    cursor = change.to;
  }
  return { changes: ordered, outputs: convertedRuns.map(run => run.output), expected };
}

export function validatePatch(state: EditorState, projection: Projection, patch: PatchPlan): void {
  if (state.doc.toString() !== projection.source) unsafe('捕获文档与投影不匹配。');
  const units = projection.runs.flatMap(run => run.units);
  const editable = units.filter(unit => !unit.partial && !unit.wiki).map(unit => unit.source);
  const emptyMarkers: Span[] = [];
  for (const style of projection.styles) {
    if (style.open.from < projection.selection.from || style.close.to > projection.selection.to) continue;
    if (changedSlice(projection.source, style.open.to, style.close.from, patch.changes) !== '') continue;
    const removed = (span: Span) => patch.changes.some(change => change.from === span.from && change.to === span.to && change.insert === '');
    if (removed(style.open) && removed(style.close)) emptyMarkers.push(style.open, style.close);
  }
  let previous = projection.selection.from;
  for (const change of patch.changes) {
    if (!Number.isInteger(change.from) || !Number.isInteger(change.to) || change.from < previous || change.to < change.from || change.to > projection.selection.to || /[\r\n\0]/.test(change.insert)) unsafe('补丁越界、重叠或改变换行。');
    previous = change.to;
    const ordinary = editable.some(span => span.from === change.from && span.to === change.to);
    const emptyStyle = change.insert === '' && emptyMarkers.some(span => span.from === change.from && span.to === change.to);
    const alias = change.from === change.to && change.insert.startsWith('|') && units.some(unit => !unit.partial && unit.wiki?.source.to === change.from + 2);
    if (!ordinary && !emptyStyle && !alias) unsafe('补丁试图改动受保护的源码。');
  }
  if (!patch.changes.length) return;
  const transaction = state.update({ changes: patch.changes });
  const candidate = transaction.state;
  const from = transaction.changes.mapPos(projection.selection.from, -1);
  const to = transaction.changes.mapPos(projection.selection.to, 1);
  const text = candidate.doc.toString();
  if (text.slice(0, from) !== projection.source.slice(0, projection.selection.from) || text.slice(to) !== projection.source.slice(projection.selection.to)) unsafe('补丁改变了选区外源码。');
  if (text.match(/\r\n|\r|\n/g)?.join('') !== projection.source.match(/\r\n|\r|\n/g)?.join('')) unsafe('补丁改变了物理换行。');
  if (from === to) {
    if (patch.expected.some(run => run.length)) unsafe('补丁意外清空选区。');
    return;
  }
  let actual: Projection;
  try { actual = projectMarkdown(candidate, { from, to }, projection.rules); }
  catch { return unsafe('候选源码无法安全重新投影。'); }
  const actualRuns = actual.runs.map(run => run.units.flatMap(unit => Array.from(unit.text, character => signature(character, unit))));
  const expectedRuns = patch.expected.filter(run => run.length);
  if (JSON.stringify(actualRuns) !== JSON.stringify(expectedRuns)) unsafe('候选源码改变了可见文字、格式或结构边界。');
}
