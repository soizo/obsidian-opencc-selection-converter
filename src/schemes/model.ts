import type { PluginError } from '../errors';

export type SchemeStatus = {
  kind: 'unloaded' | 'loading' | 'ready' | 'dirty' | 'stale' | 'unavailable';
  error?: PluginError;
  warnings: string[];
  snapshotId?: string;
  lastSuccess?: number;
};

export type SchemeDefinition = {
  id: string;
  name: string;
  source: { kind: 'url' | 'vault'; location: string };
  dependencyBase?: string;
  overrides?: Record<string, string>;
  /** Exact HTTP URLs explicitly approved by the user, not an origin-wide grant. */
  approvedHttpUrls?: string[];
};

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

export type ResourcePlan = {
  definition: SchemeDefinition;
  configSource: LoadedResource['source'];
  sourceVersions?: SourceVersion[];
  config: ParsedConfig;
  resources: Omit<LoadedResource, 'bytes' | 'sha256'>[];
  virtualConfigText: string;
  warnings: string[];
  httpUrls: string[];
  requiresHttpConfirmation: boolean;
};

export type LoadedResource = {
  source: { kind: 'url' | 'vault'; location: string };
  originalRef: string;
  virtualPath: string;
  configPaths: string[];
  dictType: 'text' | 'ocd' | 'ocd2';
  bytes: Uint8Array;
  sha256: string;
};

/** Prepared snapshots are immutable; never transfer/detach their resource buffers. */
export type Snapshot = {
  id: string;
  schemeId: string;
  sourceKey: string;
  engineId: string;
  configText: string;
  virtualConfigText: string;
  resources: LoadedResource[];
  createdAt: number;
  sourceVersions?: SourceVersion[];
};
