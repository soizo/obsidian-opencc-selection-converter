export const LIMITS = {
  configBytes: 2 * 1024 * 1024,
  dependencyBytes: 64 * 1024 * 1024,
  snapshotBytes: 128 * 1024 * 1024,
  resources: 256,
  configDepth: 32,
  selectionScalars: 200_000,
  outputBytes: 8 * 1024 * 1024,
  traceBytes: 64 * 1024 * 1024,
  wasmMemoryBytes: 256 * 1024 * 1024,
  requestMs: 30_000,
  workerJobMs: 30_000,
} as const;
