import type { PluginError } from '../errors';

export type SchemeStatus = {
  kind: 'unloaded' | 'loading' | 'ready' | 'dirty' | 'stale' | 'unavailable';
  error?: PluginError;
  warnings: string[];
  snapshotId?: string;
  lastSuccess?: number;
};

type SchemeIdentity = { id: string; name: string };

export type SingleSchemeDefinition = SchemeIdentity & {
  source: { kind: 'url' | 'vault'; location: string };
  dependencyBase?: string;
  overrides?: Record<string, string>;
  /** Exact HTTP URLs explicitly approved by the user, not an origin-wide grant. */
  approvedHttpUrls?: string[];
};

export type ChainSchemeDefinition = SchemeIdentity & {
  source: { kind: 'chain'; steps: SingleSchemeDefinition[] };
};

export type SchemeDefinition = SingleSchemeDefinition | ChainSchemeDefinition;

export type ParsedConfig = {
  text: string;
  data: Record<string, unknown>;
  references: {
    originalRef: string;
    dictType: 'text' | 'ocd' | 'ocd2';
    configPath: string;
    path: (string | number)[];
  }[];
  warnings: string[];
};

export type SourceVersion = { path: string; mtime: number; size: number };

export type SingleResourcePlan = {
  definition: SingleSchemeDefinition;
  configSource: LoadedResource['source'];
  sourceVersions?: SourceVersion[];
  config: ParsedConfig;
  resources: Omit<LoadedResource, 'bytes' | 'sha256'>[];
  virtualConfigText: string;
  warnings: string[];
  httpUrls: string[];
  requiresHttpConfirmation: boolean;
};

export type ChainResourcePlan = {
  definition: ChainSchemeDefinition;
  steps: SingleResourcePlan[];
  warnings: string[];
  httpUrls: string[];
  requiresHttpConfirmation: boolean;
};

export type ResourcePlan = SingleResourcePlan | ChainResourcePlan;

export type LoadedResource = {
  source: { kind: 'url' | 'vault'; location: string };
  originalRef: string;
  virtualPath: string;
  configPaths: string[];
  dictType: 'text' | 'ocd' | 'ocd2';
  bytes: Uint8Array;
  sha256: string;
};

type SnapshotIdentity = {
  id: string;
  schemeId: string;
  sourceKey: string;
  engineId: string;
  createdAt: number;
  sourceVersions?: SourceVersion[];
};

/** Prepared snapshots are immutable; never transfer/detach their resource buffers. */
export type SingleSnapshot = SnapshotIdentity & {
  configText: string;
  virtualConfigText: string;
  resources: LoadedResource[];
};

export type SnapshotStep = Omit<SingleSnapshot, 'resources'>;

export type ChainSnapshot = SnapshotIdentity & {
  steps: SnapshotStep[];
  resources: LoadedResource[];
};

export type Snapshot = SingleSnapshot | ChainSnapshot;
