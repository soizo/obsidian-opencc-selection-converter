import type { App } from 'obsidian';
import { DEFAULT_RULES, type RuleSettings } from '../selection/types';
import type { EngineClient } from '../engine/client';
import type { ChainSnapshot, SchemeDefinition, SchemeStatus, SingleSnapshot, Snapshot, SourceVersion } from './model';
import { parseConfig } from './config';
import { PluginError } from '../errors';
import { LIMITS } from '../limits';
import { isChainDefinition, schemeSourceKey, sha256, sourcesChanged } from './resources';

type Revision = { definition: SchemeDefinition; snapshotId: string; sourceKey: string; sourceVersions?: SourceVersion[]; lastSuccess?: number; warnings?: string[] };
type Entry = { current: Revision; previous?: Revision };
type State = { generation: number; entries: Entry[]; drafts?: SchemeDefinition[]; rules?: RuleSettings; defaultId?: string | null };
function validateRules(rules: RuleSettings): void {
  if (!rules || typeof rules.force !== 'boolean' || !rules.regions || Object.keys(rules.regions).length !== Object.keys(DEFAULT_RULES.regions).length || Object.keys(DEFAULT_RULES.regions).some(key => !['always', 'inside', 'never'].includes(rules.regions[key as keyof RuleSettings['regions']]))) throw new PluginError('INVALID_RULES', '区域规则无效。');
}
function validSingleDefinition(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const definition = value as SchemeDefinition;
  return !isChainDefinition(definition) && typeof definition.id === 'string' && typeof definition.name === 'string' && ['url', 'vault'].includes(definition.source?.kind) && typeof definition.source.location === 'string';
}
function validDraftDefinition(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const definition = value as SchemeDefinition;
  if (!isChainDefinition(definition)) return validSingleDefinition(definition);
  return typeof definition.id === 'string' && typeof definition.name === 'string' && Array.isArray(definition.source.steps) && definition.source.steps.length <= LIMITS.chainSteps && definition.source.steps.every(validSingleDefinition);
}
type StoredResources = Omit<Snapshot['resources'][number], 'bytes'>[];
type StoredSnapshot = (Omit<SingleSnapshot, 'resources'> | Omit<ChainSnapshot, 'resources'>) & { resources: StoredResources };
function snapshotWarnings(snapshot: Snapshot): string[] {
  return 'steps' in snapshot ? snapshot.steps.flatMap(step => parseConfig(step.configText).warnings) : parseConfig(snapshot.configText).warnings;
}
const encoder = new TextEncoder();
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const metadataLimit = 16 * 1024 * 1024;

export class SchemeStore {
  private state: State = { generation: 0, entries: [] };
  private pending: Promise<unknown> = Promise.resolve();
  private loaded = false;
  private cleanupWarning = false;
  private readonly statuses = new Map<string, SchemeStatus>();
  private readonly root: string;
  constructor(private readonly app: App, private readonly engine: EngineClient) {
    this.root = `${app.vault.configDir}/plugins/opencc-selection-converter/cache`;
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }
  private directory(id: string): string {
    if (!uuid.test(id)) throw new PluginError('CACHE_INVALID', '快照标识无效。');
    return `${this.root}/${id}`;
  }
  private async envelope(value: unknown): Promise<string> {
    const body = JSON.stringify(value);
    if (encoder.encode(body).byteLength > metadataLimit) throw new PluginError('CACHE_LIMIT', '缓存元数据超过上限。');
    return JSON.stringify({ body, sha256: await sha256(encoder.encode(body)) });
  }
  private async readEnvelope(path: string): Promise<unknown> {
    const adapter = this.app.vault.adapter;
    const stat = await adapter.stat(path);
    if (!stat || stat.size > metadataLimit * 2) throw new PluginError('CACHE_INVALID', '缓存元数据缺失或过大。');
    const text = await adapter.read(path);
    if (text.length > metadataLimit * 2) throw new PluginError('CACHE_INVALID', '缓存元数据过大。');
    try {
      const envelope: unknown = JSON.parse(text);
      if (!envelope || typeof envelope !== 'object' || !('body' in envelope) || typeof envelope.body !== 'string' ||
          !('sha256' in envelope) || typeof envelope.sha256 !== 'string' || await sha256(encoder.encode(envelope.body)) !== envelope.sha256) throw new Error('Checksum mismatch');
      return JSON.parse(envelope.body);
    } catch { throw new PluginError('CACHE_INVALID', '缓存元数据格式或校验无效。'); }
  }
  async load(): Promise<void> {
    return this.serial(async () => {
      this.loaded = false;
      const candidates: State[] = [];
      let present = false;
      for (const slot of [0, 1]) {
        present ||= await this.app.vault.adapter.exists(`${this.root}/state-${slot}.json`);
        try {
          const state = await this.readEnvelope(`${this.root}/state-${slot}.json`) as State;
          if (!Number.isSafeInteger(state.generation) || state.generation < 1 || !Array.isArray(state.entries)) continue;
          const ids = new Set<string>();
          for (const entry of state.entries) {
            for (const revision of [entry.current, entry.previous].filter((item): item is Revision => !!item)) {
              if (!uuid.test(revision.snapshotId) || !digest.test(revision.sourceKey) || typeof revision.definition.id !== 'string' || await schemeSourceKey(revision.definition) !== revision.sourceKey) throw new Error('Invalid revision');
            }
            if (ids.has(entry.current.definition.id)) throw new Error('Duplicate scheme');
            ids.add(entry.current.definition.id);
          }
          if (state.rules) validateRules(state.rules);
          if (state.defaultId != null && !ids.has(state.defaultId)) throw new Error('Invalid default');
          if (state.drafts !== undefined && (!Array.isArray(state.drafts) || state.drafts.some(item => !validDraftDefinition(item)))) throw new Error('Invalid drafts');
          candidates.push(state);
        } catch { /* A torn slot must not hide the other committed version. */ }
      }
      if (present && !candidates.length) throw new PluginError('CACHE_INVALID', '缓存元数据均已损坏；已停止写入，保留文件供恢复。');
      this.state = candidates.sort((a, b) => b.generation - a.generation)[0] ?? { generation: 0, entries: [] };
      this.statuses.clear();
      this.loaded = true;
    });
  }
  private async commit(next: State): Promise<void> {
    if (!this.loaded) throw new PluginError('CACHE_INVALID', '缓存尚未成功恢复，拒绝覆盖。');
    const oldIds = new Set(this.state.entries.flatMap(entry => [entry.current.snapshotId, ...(entry.previous ? [entry.previous.snapshotId] : [])]));
    const retained = new Set(next.entries.flatMap(entry => [entry.current.snapshotId, ...(entry.previous ? [entry.previous.snapshotId] : [])]));
    const adapter = this.app.vault.adapter;
    try {
      if (!await adapter.exists(this.root)) await adapter.mkdir(this.root);
      next.generation = this.state.generation + 1;
      const path = `${this.root}/state-${next.generation % 2}.json`;
      await adapter.write(path, await this.envelope(next));
      const verified = await this.readEnvelope(path);
      if (JSON.stringify(verified) !== JSON.stringify(next)) throw new Error('Metadata verification failed');
      this.state = next;
    } catch { throw new PluginError('CACHE_WRITE', '缓存提交失败，仍保留上次活动方案。'); }
    // Only retire previously published, now unreferenced plugin snapshots.
    // Never scan/delete unknown directories or interrupted-write evidence.
    for (const id of oldIds) if (!retained.has(id)) {
      try {
        const directory = this.directory(id);
        if (!await adapter.exists(directory)) continue;
        const marker = await this.readEnvelope(`${directory}/complete.json`) as StoredSnapshot;
        const contents = await adapter.list(directory);
        if (marker.id !== id || contents.folders.length || contents.files.some(path => !/^(complete\.json|\d+\.bin)$/.test(path.slice(directory.length + 1)) || !path.startsWith(`${directory}/`))) throw new Error('Unrecognized cache contents');
        for (const path of contents.files) await adapter.remove(path);
        // Desktop 1.13 maps non-recursive rmdir to fs.rm, which rejects even empty directories.
        const remaining = await adapter.list(directory);
        if (remaining.files.length || remaining.folders.length) throw new Error('Cache directory changed during retirement');
        await adapter.rmdir(directory, true);
      } catch { this.cleanupWarning = true; }
    }
  }
  async activate(definition: SchemeDefinition, snapshot: Snapshot): Promise<void> {
    const captured = structuredClone({ definition, snapshot });
    return this.serial(async () => {
      const { definition, snapshot } = captured;
      const sourceKey = await schemeSourceKey(definition);
      if (snapshot.schemeId !== definition.id || snapshot.sourceKey !== sourceKey) throw new PluginError('SNAPSHOT_IDENTITY', '快照与方案来源不匹配。');
      const active = this.state.entries.find(entry => entry.current.definition.id === definition.id);
      if (active?.current.snapshotId === snapshot.id) {
        await this.readSnapshot({ definition, snapshotId: snapshot.id, sourceKey });
        const next = structuredClone(this.state);
        next.entries.find(entry => entry.current.definition.id === definition.id)!.current.definition = definition;
        next.drafts = next.drafts?.filter(draft => draft.id !== definition.id);
        await this.commit(next);
        this.statuses.set(definition.id, { kind: 'ready', warnings: snapshotWarnings(snapshot) });
        return;
      }
      await this.engine.validate(snapshot, new AbortController().signal);
      const directory = this.directory(snapshot.id);
      const adapter = this.app.vault.adapter;
      try {
        if (!await adapter.exists(this.root)) await adapter.mkdir(this.root);
        // Snapshot directories are immutable; never overwrite an existing commit.
        if (await adapter.exists(directory)) throw new Error('Snapshot already exists');
        await adapter.mkdir(directory);
        const resources: StoredSnapshot['resources'] = [];
        for (const [index, resource] of snapshot.resources.entries()) {
          const { bytes, ...metadata } = resource;
          if (await sha256(bytes) !== resource.sha256) throw new Error('Resource hash mismatch');
          await adapter.writeBinary(`${directory}/${index}.bin`, bytes.slice().buffer);
          resources.push(metadata);
        }
        await adapter.write(`${directory}/complete.json`, await this.envelope({ ...snapshot, resources }));
        // Verify disk bytes before publishing the reference in the metadata slot.
        const revision: Revision = { definition, snapshotId: snapshot.id, sourceKey, sourceVersions: snapshot.sourceVersions, lastSuccess: Date.now(), warnings: snapshotWarnings(snapshot) };
        await this.readSnapshot(revision);
        const next = structuredClone(this.state);
        const index = next.entries.findIndex(entry => entry.current.definition.id === definition.id);
        const entry: Entry = { current: revision };
        if (index >= 0) { entry.previous = next.entries[index]!.current; next.entries[index] = entry; }
        else next.entries.push(entry);
        next.drafts = next.drafts?.filter(draft => draft.id !== definition.id);
        await this.commit(next);
        this.statuses.set(definition.id, { kind: 'ready', warnings: revision.warnings ?? [] });
      } catch (error) {
        if (error instanceof PluginError && error.code === 'CACHE_WRITE') throw error;
        throw new PluginError('CACHE_WRITE', '快照未提交，仍保留上次活动方案。');
      }
    });
  }
  private async readSnapshot(revision: Revision): Promise<Snapshot> {
    const directory = this.directory(revision.snapshotId);
    const stored = await this.readEnvelope(`${directory}/complete.json`) as StoredSnapshot;
    const chain = 'steps' in stored;
    const validConfig = chain
      ? Array.isArray(stored.steps) && stored.steps.length >= 2 && stored.steps.length <= LIMITS.chainSteps && stored.steps.every(step => typeof step.configText === 'string' && typeof step.virtualConfigText === 'string')
      : typeof stored.configText === 'string' && typeof stored.virtualConfigText === 'string';
    if (stored.id !== revision.snapshotId || stored.schemeId !== revision.definition.id || stored.sourceKey !== revision.sourceKey || !validConfig || !Array.isArray(stored.resources) || stored.resources.length > LIMITS.resources) throw new PluginError('CACHE_INVALID', '快照身份或结构无效。');
    let total = chain
      ? stored.steps.reduce((sum, step) => sum + encoder.encode(step.configText).byteLength + encoder.encode(step.virtualConfigText).byteLength, 0)
      : encoder.encode(stored.configText).byteLength + encoder.encode(stored.virtualConfigText).byteLength;
    const resources: Snapshot['resources'] = [];
    for (const [index, metadata] of stored.resources.entries()) {
      const path = `${directory}/${index}.bin`;
      const stat = await this.app.vault.adapter.stat(path);
      if (!stat || stat.size > LIMITS.dependencyBytes || total + stat.size > LIMITS.snapshotBytes) throw new PluginError('CACHE_INVALID', '缓存资源大小无效。');
      const bytes = new Uint8Array(await this.app.vault.adapter.readBinary(path));
      total += bytes.byteLength;
      if (bytes.byteLength > LIMITS.dependencyBytes || total > LIMITS.snapshotBytes || await sha256(bytes) !== metadata.sha256) throw new PluginError('CACHE_INVALID', '缓存资源校验失败。');
      resources.push({ ...metadata, bytes });
    }
    const snapshot: Snapshot = chain ? { ...(stored as Omit<ChainSnapshot, 'resources'>), resources } : { ...(stored as Omit<SingleSnapshot, 'resources'>), resources };
    await this.engine.validate(snapshot, new AbortController().signal);
    return snapshot;
  }
  async getActive(id: string): Promise<Snapshot> {
    return this.serial(async () => {
      const index = this.state.entries.findIndex(entry => entry.current.definition.id === id);
      const entry = this.state.entries[index];
      if (!entry) throw new PluginError('NO_SCHEME', '方案没有可用快照。');
      for (const revision of [entry.current, entry.previous]) {
        if (!revision) continue;
        let snapshot: Snapshot;
        try { snapshot = await this.readSnapshot(revision); }
        catch { continue; }
        if (revision !== entry.current) {
          const next = structuredClone(this.state);
          next.entries[index] = { current: revision };
          await this.commit(next);
          this.statuses.set(id, { kind: 'stale', warnings: [...(revision.warnings ?? []), '当前缓存损坏，已恢复上一版。'] });
        } else if (!['loading', 'stale'].includes(this.statuses.get(id)?.kind ?? '')) {
          this.statuses.set(id, { kind: 'ready', warnings: revision.warnings ?? [] });
        }
        return snapshot;
      }
      this.statuses.set(id, { kind: 'unavailable', warnings: [] });
      throw new PluginError('CACHE_INVALID', '没有完整可用的缓存，请重新加载方案。');
    });
  }
  private update(change: (next: State) => void): Promise<void> {
    return this.serial(async () => {
      const next = structuredClone(this.state);
      change(next);
      await this.commit(next);
    });
  }
  async saveDraft(definition: SchemeDefinition): Promise<void> {
    const captured = structuredClone(definition);
    if (!validDraftDefinition(captured)) throw new PluginError('INVALID_CONFIG', '草稿结构无效。');
    return this.update(next => { next.drafts = [...(next.drafts ?? []).filter(draft => draft.id !== captured.id), captured]; });
  }
  getDrafts(): readonly SchemeDefinition[] { return structuredClone(this.state.drafts ?? []); }
  getDraft(id: string): SchemeDefinition | null { return structuredClone(this.state.drafts?.find(draft => draft.id === id) ?? null); }
  async saveRules(rules: RuleSettings): Promise<void> {
    validateRules(rules);
    const captured = structuredClone(rules);
    return this.update(next => { next.rules = captured; });
  }
  getRules(): RuleSettings { return structuredClone(this.state.rules ?? DEFAULT_RULES); }
  async setDefault(id: string | null): Promise<void> {
    return this.update(next => {
      if (id !== null && !next.entries.some(entry => entry.current.definition.id === id)) throw new PluginError('NO_SCHEME', '默认方案没有活动快照。');
      next.defaultId = id;
    });
  }
  getDefaultId(): string | null { return this.state.defaultId ?? null; }
  async remove(id: string): Promise<void> {
    return this.update(next => {
      next.entries = next.entries.filter(entry => entry.current.definition.id !== id);
      next.drafts = next.drafts?.filter(draft => draft.id !== id);
      if (next.defaultId === id) next.defaultId = null;
    });
  }
  getStatus(id: string): SchemeStatus {
    const revision = this.state.entries.find(entry => entry.current.definition.id === id)?.current;
    const stored = this.statuses.get(id);
    const status: SchemeStatus = { kind: 'unloaded', snapshotId: revision?.snapshotId, lastSuccess: revision?.lastSuccess, ...stored, warnings: [...(stored?.warnings ?? revision?.warnings ?? [])] };
    if (this.cleanupWarning) status.warnings.push('部分旧缓存未清理；活动快照不受影响。');
    if (!['loading', 'stale', 'unavailable'].includes(status.kind) && revision && sourcesChanged(this.app, revision.sourceVersions ?? [])) status.kind = 'dirty';
    return status;
  }
  async setStatus(id: string, status: SchemeStatus): Promise<void> {
    this.statuses.set(id, { ...status, warnings: [...status.warnings] });
  }
  getDefinitions(): readonly SchemeDefinition[] { return structuredClone(this.state.entries.map(entry => entry.current.definition)); }
}
