import type { EngineReply, EngineRequest, NativeModule } from './types';
import { LIMITS } from '../limits';

declare const __NATIVE_LOADER_SOURCE__: string;
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
    Object.defineProperty(globalThis, 'fetch', { value: () => { throw new Error('Network disabled in OpenCC Worker'); } });
    Object.defineProperty(globalThis, 'XMLHttpRequest', { value: class { constructor() { throw new Error('Network disabled in OpenCC Worker'); } } });
    Object.defineProperty(globalThis, 'WebSocket', { value: class { constructor() { throw new Error('Network disabled in OpenCC Worker'); } } });
    const url = URL.createObjectURL(new Blob([__NATIVE_LOADER_SOURCE__], { type: 'text/javascript' }));
    try {
      const imported = await import(url) as { default: (options: {
        wasmBinary: Uint8Array; locateFile: () => string; print: () => void; printErr: () => void;
      }) => Promise<NativeModule> };
      return await imported.default({
        wasmBinary: decodeBase64(__WASM_BASE64__),
        locateFile: () => 'opencc.wasm',
        print: () => {}, printErr: () => {},
      });
    } finally { URL.revokeObjectURL(url); }
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
  const code = separator > 0 ? raw.slice(0, separator) : 'ENGINE_ERROR';
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

async function execute(request: EngineRequest): Promise<string | undefined> {
  if (request.snapshot.resources.length > LIMITS.resources) throw failure('RESOURCE_LIMIT', '方案资源数量超过上限。');
  const config = encodeText(request.snapshot.virtualConfigText);
  const original = encodeText(request.snapshot.configText);
  if (config.byteLength > LIMITS.configBytes || original.byteLength > LIMITS.configBytes) {
    throw failure('CONFIG_LIMIT', '方案配置超过大小上限。');
  }
  let totalBytes = config.byteLength + original.byteLength;
  for (const resource of request.snapshot.resources) {
    safePath(resource.virtualPath);
    if (resource.bytes.byteLength > LIMITS.dependencyBytes) throw failure('RESOURCE_LIMIT', '单个方案资源超过大小上限。');
    totalBytes += resource.bytes.byteLength;
    if (totalBytes > LIMITS.snapshotBytes) throw failure('RESOURCE_LIMIT', '方案快照超过大小上限。');
  }
  for (const resource of request.snapshot.resources) {
    if (resource.dictType !== 'text') continue;
    let text: string;
    try { text = decoder.decode(resource.bytes); }
    catch { throw failure('INVALID_DICT_ENCODING', '文本词典不是有效的 UTF-8。'); }
    if (text.includes('\0')) throw failure('INVALID_DICT_ENCODING', '文本词典包含 NUL。');
  }
  const mod = await module();
  mod.FS.mkdir('/snapshot');
  const files: string[] = [];
  let handle = -1;
  try {
    mod.FS.chdir('/snapshot');
    for (const resource of request.snapshot.resources) {
      const path = safePath(resource.virtualPath);
      mkdirs(mod.FS, path);
      mod.FS.writeFile(path, resource.bytes);
      files.push(path);
    }
    handle = withBytes(mod, config, pointer => mod._occ_open(pointer, config.byteLength));
    if (handle < 1) throw nativeError(mod);
    if (request.operation === 'validate') return undefined;
    const input = encodeText(request.input ?? '');
    const status = withBytes(mod, input, pointer => mod._occ_convert(handle, pointer, input.byteLength));
    if (status !== 0) throw nativeError(mod);
    const pointer = mod._occ_result_ptr();
    const length = mod._occ_result_len();
    return decoder.decode(nativeBytes(mod, pointer, length));
  } finally {
    if (handle > 0) {
      mod._occ_close(handle);
      if (mod._occ_handle_count() !== 0) throw failure('ENGINE_HANDLE_LEAK', '离线引擎未能释放转换器。');
    }
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
