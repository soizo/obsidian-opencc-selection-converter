import { PluginError } from '../errors';
import { LIMITS } from '../limits';
import type { Snapshot } from '../schemes/model';
import type { EngineOutput, EngineReply, EngineRequest, LengthReport, TraceResult } from './types';

declare const __WORKER_SOURCE__: string;

type Job = {
  request: EngineRequest;
  signal: AbortSignal;
  resolve: (output: EngineOutput) => void;
  reject: (error: PluginError) => void;
  abort: () => void;
};

export class EngineClient {
  private worker?: Worker;
  private workerUrl?: string;
  private generation = 0;
  private nextId = 0;
  private queue: Job[] = [];
  private active?: Job;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  async validate(snapshot: Snapshot, signal: AbortSignal): Promise<void> {
    await this.request({ operation: 'validate', snapshot }, signal);
  }

  async convertPlain(snapshot: Snapshot, input: string, signal: AbortSignal): Promise<string> {
    const output = await this.request({ operation: 'convertPlain', snapshot, input }, signal);
    if (typeof output !== 'string') throw new PluginError('ENGINE_PROTOCOL', '引擎没有返回有效文字。');
    return output;
  }

  async convert(snapshot: Snapshot, input: string, signal: AbortSignal): Promise<TraceResult> {
    const output = await this.request({ operation: 'convert', snapshot, input }, signal);
    if (!output || typeof output !== 'object' || !('output' in output)) throw new PluginError('ENGINE_PROTOCOL', '引擎没有返回有效追踪。');
    return output;
  }

  async checkLengths(snapshot: Snapshot, signal: AbortSignal): Promise<LengthReport> {
    try {
      const output = await this.request({ operation: 'checkLengths', snapshot }, signal);
      if (!output || typeof output !== 'object' || !('status' in output) || output.snapshotId !== snapshot.id) {
        throw new PluginError('ENGINE_PROTOCOL', '引擎没有返回有效的等长性报告。');
      }
      return output;
    } catch (error) {
      if (!(error instanceof PluginError) || error.code === 'CANCELLED' || error.code === 'ENGINE_DISPOSED') throw error;
      return { snapshotId: snapshot.id, status: 'incomplete', checkedEntries: 0, risks: [], reasons: [`${error.code}: ${error.message}`] };
    }
  }

  private request(request: Omit<EngineRequest, 'id'>, signal: AbortSignal): Promise<EngineOutput> {
    if (this.disposed) return Promise.reject(new PluginError('ENGINE_DISPOSED', '引擎已关闭。'));
    if (signal.aborted) return Promise.reject(new PluginError('CANCELLED', '操作已取消。'));
    return new Promise((resolve, reject) => {
      const job: Job = {
        request: { ...request, id: ++this.nextId }, signal, resolve, reject,
        abort: () => {
          if (this.active === job) this.finish(new PluginError('CANCELLED', '操作已取消。'));
          else {
            this.queue = this.queue.filter(item => item !== job);
            signal.removeEventListener('abort', job.abort);
            reject(new PluginError('CANCELLED', '操作已取消。'));
          }
        },
      };
      signal.addEventListener('abort', job.abort, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }

  private pump(): void {
    if (this.active || this.disposed) return;
    const job = this.queue.shift();
    if (!job) return;
    this.active = job;
    try {
      if (!this.worker) {
        this.workerUrl = URL.createObjectURL(new Blob([__WORKER_SOURCE__], { type: 'text/javascript' }));
        this.worker = new Worker(this.workerUrl, { type: 'module' });
        const generation = ++this.generation;
        this.worker.onmessage = (event: MessageEvent<EngineReply>) => {
          if (generation !== this.generation || !this.active || event.data?.id !== this.active.request.id) return;
          const reply = event.data;
          if (reply.ok === true) this.finish(undefined, reply.output);
          else this.finish(new PluginError(reply.error?.code ?? 'ENGINE_ERROR', reply.error?.message ?? '引擎执行失败。'));
        };
        this.worker.onerror = event => {
          event.preventDefault();
          if (generation === this.generation) this.finish(new PluginError('ENGINE_CRASH', '引擎异常终止，请重试。'));
        };
        this.worker.onmessageerror = () => {
          if (generation === this.generation) this.finish(new PluginError('ENGINE_PROTOCOL', '引擎消息无法读取。'));
        };
      }
      this.timer = setTimeout(() => this.finish(new PluginError('ENGINE_TIMEOUT', '引擎工作超时，已停止。')), LIMITS.workerJobMs);
      // Structured clone, deliberately no transfer list: snapshots must remain reusable.
      this.worker.postMessage(job.request);
    } catch {
      this.finish(new PluginError('ENGINE_START', '无法启动离线引擎。'));
    }
  }

  private finish(error?: PluginError, output?: EngineOutput): void {
    const job = this.active;
    if (!job) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.active = undefined;
    job.signal.removeEventListener('abort', job.abort);
    if (error) { this.stopWorker(); job.reject(error); }
    else job.resolve(output);
    this.pump();
  }

  private stopWorker(): void {
    ++this.generation;
    this.worker?.terminate();
    this.worker = undefined;
    if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
    this.workerUrl = undefined;
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.stopWorker();
    for (const job of [...(this.active ? [this.active] : []), ...this.queue]) {
      job.signal.removeEventListener('abort', job.abort);
      job.reject(new PluginError('ENGINE_DISPOSED', '引擎已关闭。'));
    }
    this.active = undefined;
    this.queue = [];
  }
}
