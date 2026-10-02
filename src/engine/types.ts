import type { Snapshot } from '../schemes/model';
import type { Span } from '../selection/types';

declare const __ENGINE_ID__: string;
export const ENGINE_ID = __ENGINE_ID__;

export type MatchRecord = {
  stagePath: string;
  dictPath: string;
  inputScalar: Span;
  outputScalar: Span;
  inputLength: number;
  outputLength: number;
  selected: string;
};

export type TraceResult = { output: string; origins: number[]; matches: MatchRecord[] };

export type LengthReport = {
  snapshotId: string;
  status: 'equal' | 'risk' | 'incomplete';
  checkedEntries: number;
  risks: {
    stagePath: string; dictPath: string; key: string; defaultValue: string;
    inputLength: number; outputLength: number;
  }[];
  reasons: string[];
};

export type EngineRequest = {
  id: number;
  operation: 'validate' | 'convertPlain' | 'convert' | 'checkLengths';
  snapshot: Snapshot;
  input?: string;
};

export type EngineOutput = string | TraceResult | LengthReport | undefined;

export type EngineReply =
  | { id: number; ok: true; output?: EngineOutput }
  | { id: number; ok: false; error: { code: string; message: string } };

export type NativeModule = {
  HEAPU8: Uint8Array;
  FS: {
    mkdir(path: string): void;
    chdir(path: string): void;
    writeFile(path: string, bytes: Uint8Array): void;
    unlink(path: string): void;
    rmdir(path: string): void;
  };
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  _occ_open(ptr: number, len: number): number;
  _occ_convert(handle: number, ptr: number, len: number): number;
  _occ_trace(handle: number, ptr: number, len: number): number;
  _occ_check_lengths(handle: number): number;
  _occ_result_ptr(): number;
  _occ_result_len(): number;
  _occ_error_ptr(): number;
  _occ_error_len(): number;
  _occ_close(handle: number): void;
  _occ_handle_count(): number;
};
