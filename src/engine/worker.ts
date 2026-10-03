import type { EngineOutput, EngineReply, EngineRequest, LengthReport, MatchRecord, NativeModule, TraceResult } from './types';
import { LIMITS } from '../limits';
import createOpenCC from '../../engine/generated/opencc.mjs';
declare const __WASM_BASE64__: string;

let native: Promise<NativeModule> | undefined;
const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

function decodeBase64(value: string): Uint8Array {
  const raw = atob(value);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

async function module(): Promise<NativeModule> {
  if (!native) native = (async () => {
    // This runs in a dedicated Worker, which has no window or activeWindow.
    Object.defineProperty(self, 'fetch', { value: () => { throw new Error('Network disabled in OpenCC Worker'); } });
    Object.defineProperty(self, 'XMLHttpRequest', { value: class { constructor() { throw new Error('Network disabled in OpenCC Worker'); } } });
    Object.defineProperty(self, 'WebSocket', { value: class { constructor() { throw new Error('Network disabled in OpenCC Worker'); } } });
    return createOpenCC({
      wasmBinary: decodeBase64(__WASM_BASE64__),
      locateFile: () => 'opencc.wasm',
      print: () => {}, printErr: () => {},
    });
  })();
  return native;
}

function safePath(path: string): string {
  if (!path || path.includes('\\') || path.includes('\0') || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw failure('INVALID_RESOURCE_PATH', '方案资源路径无效。');
  }
  return path;
}

function mkdirs(fs: NativeModule['FS'], file: string): void {
  const parts = file.split('/');
  parts.pop();
  let current = '/snapshot';
  for (const part of parts) {
    current += `/${part}`;
    try { fs.mkdir(current); } catch { /* Existing directory in this isolated job. */ }
  }
}

function failure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function nativeBytes(mod: NativeModule, pointer: number, length: number): Uint8Array {
  if (!Number.isInteger(pointer) || !Number.isInteger(length) || pointer < 0 || length < 0 ||
      pointer > mod.HEAPU8.byteLength || length > mod.HEAPU8.byteLength - pointer) {
    throw failure('ENGINE_PROTOCOL', '离线引擎返回了无效内存范围。');
  }
  return mod.HEAPU8.slice(pointer, pointer + length);
}

function nativeError(mod: NativeModule): Error & { code: string } {
  let raw = 'ENGINE_ERROR: 离线引擎执行失败。';
  try {
    const pointer = mod._occ_error_ptr();
    const length = mod._occ_error_len();
    raw = decoder.decode(nativeBytes(mod, pointer, length));
  } catch { /* Return the safe fallback without native payload. */ }
  const separator = raw.indexOf(':');
  const code = separator > 0 && /^[A-Z][A-Z_]+$/.test(raw.slice(0, separator)) ? raw.slice(0, separator) : 'ENGINE_ERROR';
  const message = separator > 0 ? raw.slice(separator + 1).trim() : raw;
  return failure(code, message || '离线引擎执行失败。');
}

function withBytes<T>(mod: NativeModule, bytes: Uint8Array, call: (pointer: number) => T): T {
  const pointer = mod._malloc(Math.max(1, bytes.byteLength));
  if (!pointer) throw failure('WASM_MEMORY', '离线引擎内存不足。');
  try {
    if (bytes.byteLength) mod.HEAPU8.set(bytes, pointer);
    return call(pointer);
  } finally { mod._free(pointer); }
}

function encodeText(value: string): Uint8Array {
  for (const character of value) {
    const scalar = character.codePointAt(0)!;
    if (scalar === 0 || (scalar >= 0xd800 && scalar <= 0xdfff)) {
      throw failure('INVALID_TEXT', '文字包含 NUL 或孤立代理项。');
    }
  }
  return encoder.encode(value);
}

function scalarLength(value: string): number {
  return Array.from(value).length;
}

function parseReport(operation: EngineRequest['operation'], snapshotId: string, input: string, text: string): TraceResult | LengthReport {
  const invalid = () => failure('ENGINE_PROTOCOL', '离线引擎返回了无效的追踪或检查报告。');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw invalid(); }
  if (!value || typeof value !== 'object') throw invalid();
  if (operation === 'convert') {
    const trace = value as TraceResult;
    if (typeof trace.output !== 'string' || !Array.isArray(trace.origins) || !Array.isArray(trace.matches) ||
        trace.origins.length !== scalarLength(trace.output)) throw invalid();
    const inputLength = scalarLength(input);
    let previous = 0;
    for (const origin of trace.origins) {
      if (!Number.isInteger(origin) || origin < previous || origin >= inputLength) throw invalid();
      previous = origin;
    }
    const spanValid = (span: MatchRecord['inputScalar'], length: number) => span &&
      Number.isInteger(span.from) && Number.isInteger(span.to) && span.from >= 0 && span.to >= span.from && span.to - span.from === length;
    for (const match of trace.matches) {
      if (!match || typeof match.stagePath !== 'string' || typeof match.dictPath !== 'string' || typeof match.selected !== 'string' ||
          !Number.isInteger(match.inputLength) || match.inputLength < 1 || !Number.isInteger(match.outputLength) || match.outputLength < 0 ||
          !spanValid(match.inputScalar, match.inputLength) || !spanValid(match.outputScalar, match.outputLength) ||
          scalarLength(match.selected) !== match.outputLength) throw invalid();
    }
    return trace;
  }
  const report = value as LengthReport;
  if (!['equal', 'risk', 'incomplete'].includes(report.status) || !Number.isInteger(report.checkedEntries) || report.checkedEntries < 0 ||
      !Array.isArray(report.risks) || !Array.isArray(report.reasons) || report.reasons.some(reason => typeof reason !== 'string')) throw invalid();
  if ((report.status === 'equal' && (report.risks.length || report.reasons.length)) ||
      (report.status === 'risk' && (!report.risks.length || report.reasons.length)) ||
      (report.status === 'incomplete' && !report.reasons.length)) throw invalid();
  for (const risk of report.risks) {
    if (!risk || typeof risk.stagePath !== 'string' || typeof risk.dictPath !== 'string' || typeof risk.key !== 'string' ||
        typeof risk.defaultValue !== 'string' || scalarLength(risk.key) !== risk.inputLength ||
        scalarLength(risk.defaultValue) !== risk.outputLength || risk.inputLength === risk.outputLength) throw invalid();
  }
  return { ...report, snapshotId };
}

async function execute(request: EngineRequest): Promise<EngineOutput> {
  const steps = 'steps' in request.snapshot ? request.snapshot.steps : [request.snapshot];
  const chain = steps.length > 1;
  if (!steps.length || steps.length > LIMITS.chainSteps || request.snapshot.resources.length > LIMITS.resources) throw failure('RESOURCE_LIMIT', '方案步骤或资源数量超过上限。');
  const configs = steps.map(step => encodeText(step.virtualConfigText));
  const originals = steps.map(step => encodeText(step.configText));
  if (configs.reduce((sum, bytes) => sum + bytes.byteLength, 0) > LIMITS.configBytes || originals.reduce((sum, bytes) => sum + bytes.byteLength, 0) > LIMITS.configBytes) {
    throw failure('CONFIG_LIMIT', '方案配置超过大小上限。');
  }
  let totalBytes = [...configs, ...originals].reduce((sum, bytes) => sum + bytes.byteLength, 0);
  for (const resource of request.snapshot.resources) {
    safePath(resource.virtualPath);
    if (resource.bytes.byteLength > LIMITS.dependencyBytes) throw failure('RESOURCE_LIMIT', '单个方案资源超过大小上限。');
    totalBytes += resource.bytes.byteLength;
    if (totalBytes > LIMITS.snapshotBytes) throw failure('RESOURCE_LIMIT', '方案快照超过大小上限。');
    if (resource.dictType !== 'text') continue;
    let text: string;
    try { text = decoder.decode(resource.bytes); }
    catch { throw failure('INVALID_DICT_ENCODING', '文本词典不是有效的 UTF-8。'); }
    if (text.includes('\0')) throw failure('INVALID_DICT_ENCODING', '文本词典包含 NUL。');
  }
  const mod = await module();
  mod.FS.mkdir('/snapshot');
  const files: string[] = [];
  let output: EngineOutput;
  try {
    mod.FS.chdir('/snapshot');
    for (const resource of request.snapshot.resources) {
      const path = safePath(resource.virtualPath);
      mkdirs(mod.FS, path);
      mod.FS.writeFile(path, resource.bytes);
      files.push(path);
    }
    const run = (index: number, input: string): string | TraceResult | LengthReport | undefined => {
      const config = configs[index]!;
      const handle = withBytes(mod, config, pointer => mod._occ_open(pointer, config.byteLength));
      if (handle < 1) throw nativeError(mod);
      try {
        if (request.operation === 'validate') return undefined;
        let status: number;
        if (request.operation === 'checkLengths') status = mod._occ_check_lengths(handle);
        else {
          const bytes = encodeText(input);
          status = withBytes(mod, bytes, pointer => request.operation === 'convert' ? mod._occ_trace(handle, pointer, bytes.byteLength) : mod._occ_convert(handle, pointer, bytes.byteLength));
        }
        if (status !== 0) throw nativeError(mod);
        const length = mod._occ_result_len();
        const structured = request.operation === 'convert' || request.operation === 'checkLengths';
        if (length > (structured ? LIMITS.traceBytes : LIMITS.outputBytes)) throw failure(structured ? 'TRACE_LIMIT' : 'OUTPUT_LIMIT', '离线引擎输出超过大小上限。');
        const text = decoder.decode(nativeBytes(mod, mod._occ_result_ptr(), length));
        return structured ? parseReport(request.operation, request.snapshot.id, input, text) : text;
      } finally {
        mod._occ_close(handle);
        if (mod._occ_handle_count() !== 0) throw failure('ENGINE_HANDLE_LEAK', '离线引擎未能释放转换器。');
      }
    };
    if (request.operation === 'validate') {
      for (let index = 0; index < steps.length; index++) run(index, '');
    } else if (request.operation === 'convertPlain') {
      let text = request.input ?? '';
      for (let index = 0; index < steps.length; index++) text = run(index, text) as string;
      output = text;
    } else if (request.operation === 'convert') {
      let text = request.input ?? '';
      let origins = Array.from({ length: scalarLength(text) }, (_, index) => index);
      const matches: MatchRecord[] = [];
      for (let index = 0; index < steps.length; index++) {
        const trace = run(index, text) as TraceResult;
        origins = trace.origins.map(origin => origins[origin]!);
        matches.push(...trace.matches.map(match => chain ? { ...match, stagePath: `$.steps[${index}]${match.stagePath.slice(1)}`, dictPath: `$.steps[${index}]${match.dictPath.slice(1)}` } : match));
        text = trace.output;
        if (encoder.encode(JSON.stringify({ output: text, origins, matches })).byteLength > LIMITS.traceBytes) throw failure('TRACE_LIMIT', '离线引擎输出超过大小上限。');
      }
      output = { output: text, origins, matches };
    } else {
      const reports: LengthReport[] = [];
      for (let index = 0; index < steps.length; index++) reports.push(run(index, '') as LengthReport);
      const incomplete = reports.filter(report => report.status === 'incomplete');
      const risks = reports.flatMap((report, index) => report.risks.map(risk => chain ? { ...risk, stagePath: `$.steps[${index}]${risk.stagePath.slice(1)}`, dictPath: `$.steps[${index}]${risk.dictPath.slice(1)}` } : risk));
      output = {
        snapshotId: request.snapshot.id,
        status: incomplete.length ? 'incomplete' : risks.length ? 'risk' : 'equal',
        checkedEntries: reports.reduce((sum, report) => sum + report.checkedEntries, 0), risks,
        reasons: incomplete.flatMap((report, index) => report.reasons.map(reason => `$.steps[${index}]: ${reason}`)),
      };
    }
  } finally {
    mod.FS.chdir('/');
    for (const file of [...files].reverse()) {
      try { mod.FS.unlink(`/snapshot/${file}`); } catch { /* Cleanup after rejected native load. */ }
      const parts = file.split('/');
      parts.pop();
      while (parts.length) {
        try { mod.FS.rmdir(`/snapshot/${parts.join('/')}`); } catch { break; }
        parts.pop();
      }
    }
    try { mod.FS.rmdir('/snapshot'); } catch { /* Empty snapshots or native FS bookkeeping. */ }
  }
  return output;
}

self.onmessage = async (event: MessageEvent<EngineRequest>) => {
  const request = event.data;
  let reply: EngineReply;
  try { reply = { id: request.id, ok: true, output: await execute(request) }; }
  catch (error) {
    const value = error as { code?: string; message?: string };
    reply = { id: request.id, ok: false, error: { code: value.code ?? 'ENGINE_ERROR', message: value.message ?? '离线引擎执行失败。' } };
  }
  self.postMessage(reply);
};
