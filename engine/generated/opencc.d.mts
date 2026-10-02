import type { NativeModule } from '../../src/engine/types';

export default function createOpenCC(options: {
  wasmBinary: Uint8Array;
  locateFile: () => string;
  print: () => void;
  printErr: () => void;
}): Promise<NativeModule>;
