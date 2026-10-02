import type { Span } from './selection/types';

export class PluginError extends Error {
  readonly source?: string;
  readonly configPath?: string;
  readonly sourceSpan?: Span;

  constructor(
    readonly code: string,
    message: string,
    context: {source?: string; configPath?: string; sourceSpan?: Span} = {},
  ) {
    super(message);
    this.name = 'PluginError';
    Object.assign(this, context);
  }
}
