import type { EngineClient } from '../engine/client';
import type { TraceResult } from '../engine/types';
import type { Snapshot } from '../schemes/model';
import type { PatchPlan, Projection, RuleSettings } from './types';
import { PluginError } from '../errors';
import { LIMITS } from '../limits';
import { serialize } from './serialize';

export async function convertProjection(projection: Projection, snapshot: Snapshot, rules: RuleSettings, engine: EngineClient, signal: AbortSignal): Promise<PatchPlan> {
  const results: TraceResult[] = [];
  let bytes = 0;
  for (const run of projection.runs) {
    if (signal.aborted) throw new PluginError('CANCELLED', '转换已取消。');
    const input = run.units.map(unit => unit.text).join('');
    const converted = await engine.convert(snapshot, input, signal);
    if (!rules.force && (converted.matches.some(match => match.inputLength !== match.outputLength) || Array.from(input).length !== Array.from(converted.output).length)) throw new PluginError('LENGTH_CHANGED', '实际替换改变了 Unicode 字符数量；未修改文档。');
    bytes += new TextEncoder().encode(converted.output).byteLength;
    if (bytes > LIMITS.outputBytes) throw new PluginError('OUTPUT_LIMIT', '转换结果超过总大小上限。');
    results.push(converted);
  }
  if (signal.aborted) throw new PluginError('CANCELLED', '转换已取消。');
  return serialize(projection, results);
}
