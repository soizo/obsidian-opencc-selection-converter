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
};
