import type { TestPlugin } from './fixtures';
import type { Snapshot } from '../../src/schemes/model';
import type { LengthReport, TraceResult } from '../../src/engine/types';
import { engine, officialSnapshot, snapshot } from './engine.test';
import { equal, ok, rejectsCode } from './assert';
import ocd from '../fixtures/opencc/formats.ocd';
import ocd2 from '../fixtures/opencc/formats.ocd2';
import riskOcd from '../fixtures/opencc/length-risk.ocd';
import riskOcd2 from '../fixtures/opencc/length-risk.ocd2';

type TraceEndpoint = {
  convert(snapshot: Snapshot, input: string, signal: AbortSignal): Promise<TraceResult>;
  checkLengths(snapshot: Snapshot, signal: AbortSignal): Promise<LengthReport>;
};

function tracer(plugin: TestPlugin): TraceEndpoint {
  const endpoint = engine(plugin) as Partial<TraceEndpoint>;
  ok(typeof endpoint.convert === 'function' && typeof endpoint.checkLengths === 'function', 'Native trace/enumeration endpoints not implemented');
  return endpoint as TraceEndpoint;
}

const inline = (entries: Record<string, string>) => ({ type: 'inline', entries });

async function differential(plugin: TestPlugin, prepared: Snapshot, input: string): Promise<TraceResult> {
  const signal = new AbortController().signal;
  const traced = await tracer(plugin).convert(prepared, input, signal);
  equal(traced.output, await engine(plugin).convertPlain(prepared, input, signal));
  return traced;
}

export function traceTests(plugin: TestPlugin) {
  return [
    { name: 'trace/cancelled-lengths', run: async () => {
      const prepared = await snapshot({ conversion_chain: [{ dict: inline({ 甲: '甲乙', 丙丁: '丙' }) }] });
      const result = await differential(plugin, prepared, '甲丙丁');
      equal(result.output, '甲乙丙');
      equal(result.origins, [0, 0, 1]);
      equal(result.matches.map(match => [match.inputScalar, match.outputScalar, match.inputLength, match.outputLength, match.selected]), [
        [{ from: 0, to: 1 }, { from: 0, to: 2 }, 1, 2, '甲乙'],
        [{ from: 1, to: 3 }, { from: 2, to: 3 }, 2, 1, '丙'],
      ]);
    } },
    { name: 'trace/normalization-origins', run: async () => {
      const prepared = await snapshot({
        normalization: [{ dict: inline({ 甲: '甲乙' }) }],
        segmentation: { type: 'mmseg', dict: inline({ 甲乙: '分词候选不输出' }) },
        conversion_chain: [{ dict: inline({ 甲乙: '丙' }) }, { dict: inline({ 丙: '丁' }) }],
      });
      const result = await differential(plugin, prepared, '甲戊');
      equal(result.output, '丁戊');
      equal(result.origins, [0, 1]);
      equal(result.matches.map(match => match.stagePath), ['$.normalization[0]', '$.conversion_chain[0]', '$.conversion_chain[1]']);
    } },
    { name: 'trace/group-policy', run: async () => {
      for (const [policy, output, origins] of [['short_circuit', '乙丙', [0, 1]], ['union', '丁', [0]]] as const) {
        const prepared = await snapshot({ conversion_chain: [{ dict: {
          type: 'group', match_policy: policy,
          dicts: [inline({ 甲: '乙' }), { type: 'group', dicts: [inline({ 甲丙: '丁' })] }],
        } }] });
        const result = await differential(plugin, prepared, '甲丙');
        equal(result.output, output);
        equal(result.origins, [...origins]);
        equal(result.matches[0]!.dictPath, '$.conversion_chain[0].dict');
      }
    } },
    { name: 'trace/unicode', run: async () => {
      const prepared = await snapshot({ conversion_chain: [{ dict: inline({ '𠀀': '𠀁', a: 'á' }) }] });
      const result = await differential(plugin, prepared, 'a\u0301𠀀');
      equal(result.output, 'á\u0301𠀁');
      equal(result.origins, [0, 1, 2]);
      equal(result.matches.map(match => match.inputScalar), [{ from: 0, to: 1 }, { from: 2, to: 3 }]);
    } },
    { name: 'trace/enumeration', run: async () => {
      const client = tracer(plugin);
      const signal = new AbortController().signal;
      const prepared = await snapshot({
        segmentation: { type: 'mmseg', dict: inline({ 戊: '不属于转换输出' }) },
        conversion_chain: [{ dict: { type: 'group', dicts: [inline({ 甲: '乙' }), inline({ 甲: '甲乙' })] } }],
      });
      const report = await client.checkLengths(prepared, signal);
      equal(report.snapshotId, prepared.id);
      equal(report.status, 'risk');
      equal(report.checkedEntries, 2);
      equal(report.risks.map(risk => [risk.key, risk.defaultValue, risk.inputLength, risk.outputLength, risk.dictPath]), [
        ['甲', '甲乙', 1, 2, '$.conversion_chain[0].dict.dicts[1]'],
      ]);
      const segmentationOnly = await snapshot({
        segmentation: { type: 'mmseg', dict: inline({ 甲: '仅用于分词' }) },
        conversion_chain: [{ dict: inline({ 甲: '乙' }) }],
      });
      equal((await client.checkLengths(segmentationOnly, signal)).status, 'equal');
      const normalization = await snapshot({ normalization: [{ dict: inline({ 甲: '甲乙' }) }], conversion_chain: [{ dict: inline({ 甲乙: '丙' }) }] });
      equal((await client.checkLengths(normalization, signal)).risks.length, 2);
    } },
    { name: 'trace/binary-enumeration', run: async () => {
      for (const [type, bytes] of [['ocd', ocd], ['ocd2', ocd2]] as const) {
        const file = `formats.${type}`;
        const prepared = await snapshot({ conversion_chain: [{ dict: { type, file } }] });
        prepared.resources.push({
          source: { kind: 'vault', location: `fixtures/${file}` }, originalRef: file, virtualPath: file,
          configPaths: [], dictType: type, bytes: bytes.slice(), sha256: 'verified-fixture',
        });
        const report = await tracer(plugin).checkLengths(prepared, new AbortController().signal);
        equal(report.status, 'equal');
        equal(report.checkedEntries, 2);
        equal((await differential(plugin, prepared, '服务器软件')).origins, [0, 1, 2, 3, 4]);
      }
    } },
    { name: 'trace/default-candidates', run: async () => {
      const text = new TextEncoder().encode('乙\t丙 丙丁\n甲\t甲乙 甲\n');
      for (const [type, bytes] of [['text', text], ['ocd', riskOcd], ['ocd2', riskOcd2]] as const) {
        const file = `length-risk.${type}`;
        const prepared = await snapshot({ conversion_chain: [{ dict: { type, file } }] });
        prepared.resources.push({
          source: { kind: 'vault', location: `fixtures/${file}` }, originalRef: file, virtualPath: file,
          configPaths: [], dictType: type, bytes: bytes.slice(), sha256: 'verified-fixture',
        });
        const report = await tracer(plugin).checkLengths(prepared, new AbortController().signal);
        equal(report.status, 'risk');
        equal(report.checkedEntries, 2);
        equal(report.risks.map(risk => [risk.key, risk.defaultValue, risk.inputLength, risk.outputLength]), [['甲', '甲乙', 1, 2]]);
        const result = await differential(plugin, prepared, '甲乙');
        equal(result.output, '甲乙丙');
        equal(result.origins, [0, 0, 1]);
        equal(result.matches.map(match => match.selected), ['甲乙', '丙']);
      }
    } },
    { name: 'trace/official-s2twp', run: async () => {
      const prepared = await officialSnapshot();
      for (const input of ['服务器软件', '后台鼠标，程序开发。\r\nＡ𠀀🙂', '软件'.repeat(25000)]) {
        const result = await differential(plugin, prepared, input);
        equal(result.origins.length, [...result.output].length);
      }
    } },
    { name: 'trace/segment-boundaries', run: async () => {
      const prepared = await snapshot({
        segmentation: { type: 'mmseg', dict: inline({ 甲: '甲', 乙: '乙' }) },
        conversion_chain: [{ dict: inline({ 甲: '丙', 乙: '丁' }) }, { dict: inline({ 丙丁: '戊' }) }],
      });
      const result = await differential(plugin, prepared, '甲乙');
      equal(result.output, '丙丁');
      equal(result.origins, [0, 1]);
      equal(result.matches.length, 2);
    } },
    { name: 'trace/empty-group-paths', run: async () => {
      const prepared = await snapshot({ conversion_chain: [
        { dict: { type: 'group', dicts: [] } },
        { dict: { type: 'group', dicts: [{ type: 'group', dicts: [] }, inline({ 甲: '甲乙' })] } },
      ] });
      const result = await differential(plugin, prepared, '甲丙');
      equal(result.output, '甲乙丙');
      equal(result.origins, [0, 0, 1]);
      equal(await differential(plugin, prepared, ''), { output: '', origins: [], matches: [] });
      equal(result.matches[0]!.stagePath, '$.conversion_chain[1]');
      const report = await tracer(plugin).checkLengths(prepared, new AbortController().signal);
      equal(report.status, 'risk');
      equal(report.risks[0]!.dictPath, '$.conversion_chain[1].dict.dicts[1]');
    } },
    { name: 'trace/incomplete-load', run: async () => {
      const prepared = await snapshot({ conversion_chain: [{ dict: { type: 'ocd2', file: 'broken.ocd2' } }] });
      prepared.resources.push({
        source: { kind: 'vault', location: 'broken.ocd2' }, originalRef: 'broken.ocd2', virtualPath: 'broken.ocd2',
        configPaths: [], dictType: 'ocd2', bytes: new Uint8Array([1, 2, 3]), sha256: 'invalid-fixture',
      });
      const report = await tracer(plugin).checkLengths(prepared, new AbortController().signal);
      equal(report.status, 'incomplete');
      equal(report.snapshotId, prepared.id);
      equal(report.checkedEntries, 0);
      ok(report.reasons.length > 0);
    } },
    { name: 'trace/incomplete-budget-and-cancel', run: async () => {
      const client = tracer(plugin);
      const file = 'risk.txt';
      const text = Array.from({ length: 64 }, (_, index) => `k${index}\t${'x'.repeat(4096)}\n`).join('');
      const prepared = await snapshot({ conversion_chain: Array.from({ length: 300 }, () => ({ dict: { type: 'text', file } })) }, { [file]: text });
      const report = await client.checkLengths(prepared, new AbortController().signal);
      equal(report.status, 'incomplete');
      ok(report.checkedEntries > 0 && report.checkedEntries < 19200, 'Must expose incomplete native enumeration, not an assumed pass');
      ok(report.reasons.length > 0);
      const equalLength = await snapshot({ conversion_chain: [{ dict: inline({ '𠀀': '甲' }) }] });
      equal((await client.checkLengths(equalLength, new AbortController().signal)).status, 'equal');
      const cancelled = new AbortController();
      cancelled.abort();
      await rejectsCode(client.checkLengths(equalLength, cancelled.signal), 'CANCELLED');
    } },
    { name: 'trace/trace-budget', run: async () => {
      const prepared = await snapshot({ conversion_chain: [{ dict: inline({ 甲: '乙'.repeat(13) }) }] });
      const input = '甲'.repeat(200000);
      equal((await engine(plugin).convertPlain(prepared, input, new AbortController().signal)).length, 2600000);
      let failure: { code?: string; message?: string } | undefined;
      try { await tracer(plugin).convert(prepared, input, new AbortController().signal); }
      catch (error) { failure = error as typeof failure; }
      ok(failure?.code === 'TRACE_LIMIT', `Trace budget error: ${failure?.code}: ${failure?.message}`);
      equal((await differential(plugin, await snapshot({ conversion_chain: [{ dict: inline({ 甲: '乙' }) }] }), '甲')).output, '乙');
    } },
    { name: 'trace/generation-budget', run: async () => {
      // 312.5 MiB expansion: a post-conversion limit hits WASM OOM instead of OUTPUT_LIMIT.
      const prepared = await snapshot({ conversion_chain: [{ dict: inline({ 甲: 'x'.repeat(16384) }) }] });
      await rejectsCode(engine(plugin).convertPlain(prepared, '甲'.repeat(20000), new AbortController().signal), 'OUTPUT_LIMIT');
      equal(await engine(plugin).convertPlain(await snapshot({ conversion_chain: [{ dict: inline({ 甲: '乙' }) }] }), '甲', new AbortController().signal), '乙');
    } },
  ];
}
