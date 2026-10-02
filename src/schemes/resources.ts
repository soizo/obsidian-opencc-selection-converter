import { requestUrl, TFile, type App } from 'obsidian';
import type { EngineClient } from '../engine/client';
import { ENGINE_ID } from '../engine/types';
import { PluginError } from '../errors';
import { LIMITS } from '../limits';
import { parseConfig, resolveDependencies } from './config';
import type { LoadedResource, ResourcePlan, SchemeDefinition, Snapshot, SourceVersion } from './model';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer));
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
}
function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new PluginError('CANCELLED', '操作已取消。');
}
function approved(source: LoadedResource['source'], definition: SchemeDefinition): void {
  if (source.kind === 'url' && source.location.startsWith('http:') && !definition.approvedHttpUrls?.includes(source.location)) {
    throw new PluginError('HTTP_CONFIRMATION_REQUIRED', '请先确认此 HTTP 地址的风险。', { source: source.location });
  }
}
function bounded<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  cancelled(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value as T);
    };
    const abort = () => finish(new PluginError('CANCELLED', '操作已取消。'));
    const timer = setTimeout(() => finish(new PluginError('RESOURCE_TIMEOUT', '资源读取超时，迟到结果将被忽略。')), LIMITS.requestMs);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(operation).then(value => finish(undefined, value), error => finish(error));
  });
}
function decode(bytes: Uint8Array, source: string): string {
  try {
    const text = decoder.decode(bytes);
    if (text.includes('\0')) throw new Error('NUL');
    return text;
  } catch { throw new PluginError('INVALID_TEXT', '资源不是有效的 UTF-8 或包含 NUL。', { source }); }
}
export function sourcesChanged(app: App, versions: readonly SourceVersion[]): boolean {
  return versions.some(version => {
    const file = app.vault.getAbstractFileByPath(version.path);
    return !(file instanceof TFile) || file.stat.mtime !== version.mtime || file.stat.size !== version.size;
  });
}
async function readResource(app: App, source: LoadedResource['source'], definition: SchemeDefinition, limit: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; version?: SourceVersion }> {
  cancelled(signal);
  approved(source, definition);
  try {
    return await bounded(async () => {
      cancelled(signal);
      let bytes: Uint8Array;
      let version: SourceVersion | undefined;
      if (source.kind === 'url') {
        // requestUrl buffers its response and does not expose cancellation/final URL.
        const response = await requestUrl({ url: source.location, method: 'GET', throw: false });
        if (response.status < 200 || response.status >= 300) throw new PluginError('RESOURCE_HTTP', `资源请求失败（HTTP ${response.status}）。`, { source: source.location });
        bytes = new Uint8Array(response.arrayBuffer);
      } else {
        const file = app.vault.getAbstractFileByPath(source.location);
        if (!(file instanceof TFile) || file.path !== source.location) throw new PluginError('RESOURCE_MISSING', '资源未被 vault 文件索引识别。', { source: source.location });
        if (file.stat.size > limit) throw new PluginError('RESOURCE_LIMIT', '资源超过大小上限。', { source: source.location });
        version = { path: file.path, mtime: file.stat.mtime, size: file.stat.size };
        bytes = new Uint8Array(await app.vault.readBinary(file));
        if (sourcesChanged(app, [version])) throw new PluginError('RESOURCE_CHANGED', '读取期间源文件发生变化，请重新加载。', { source: source.location });
      }
      cancelled(signal);
      if (bytes.byteLength > limit) throw new PluginError('RESOURCE_LIMIT', '资源超过大小上限。', { source: source.location });
      return { bytes, version };
    }, signal);
  } catch (error) {
    if (error instanceof PluginError) throw error;
    throw new PluginError('RESOURCE_READ', '无法读取方案资源。', { source: source.location });
  }
}

export async function schemeSourceKey(definition: SchemeDefinition): Promise<string> {
  const empty = resolveDependencies(parseConfig('{"conversion_chain":[]}'), definition);
  const overrides = Object.entries(definition.overrides ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return sha256(encoder.encode(JSON.stringify([empty.configSource, definition.dependencyBase ?? null, overrides])));
}

export async function prepareScheme(app: App, definition: SchemeDefinition, signal: AbortSignal): Promise<ResourcePlan> {
  cancelled(signal);
  const captured = structuredClone(definition);
  const source = resolveDependencies(parseConfig('{"conversion_chain":[]}'), captured).configSource;
  const { bytes, version } = await readResource(app, source, captured, LIMITS.configBytes, signal);
  const plan = resolveDependencies(parseConfig(decode(bytes, source.location)), captured);
  plan.sourceVersions = version ? [version] : [];
  cancelled(signal);
  return plan;
}

export async function loadPrepared(app: App, plan: ResourcePlan, engine: EngineClient, signal: AbortSignal): Promise<Snapshot> {
  cancelled(signal);
  // Capture the reviewed plan before any await, so later form edits cannot change it.
  const captured = structuredClone(plan);
  for (const resource of captured.resources) approved(resource.source, captured.definition);
  const versions = [...(captured.sourceVersions ?? [])];
  if (sourcesChanged(app, versions)) throw new PluginError('RESOURCE_CHANGED', '配置已变化，请重新准备方案。');
  const resources: LoadedResource[] = [];
  let total = encoder.encode(captured.config.text).byteLength + encoder.encode(captured.virtualConfigText).byteLength;
  for (const resource of captured.resources) {
    const loaded = await readResource(app, resource.source, captured.definition, LIMITS.dependencyBytes, signal);
    total += loaded.bytes.byteLength;
    if (total > LIMITS.snapshotBytes) throw new PluginError('RESOURCE_LIMIT', '完整快照超过大小上限。');
    if (resource.dictType === 'text') decode(loaded.bytes, resource.source.location);
    resources.push({ ...resource, bytes: loaded.bytes, sha256: await sha256(loaded.bytes) });
    if (loaded.version) versions.push(loaded.version);
  }
  const snapshot: Snapshot = {
    id: crypto.randomUUID(), schemeId: captured.definition.id,
    sourceKey: await schemeSourceKey(captured.definition), engineId: ENGINE_ID,
    configText: captured.config.text, virtualConfigText: captured.virtualConfigText,
    resources, createdAt: Date.now(), sourceVersions: versions,
  };
  cancelled(signal);
  if (sourcesChanged(app, versions)) throw new PluginError('RESOURCE_CHANGED', '加载期间源文件发生变化。');
  await engine.validate(snapshot, signal);
  cancelled(signal);
  if (sourcesChanged(app, versions)) throw new PluginError('RESOURCE_CHANGED', '验证期间源文件发生变化。');
  return snapshot;
}
