/** Half-open UTF-16 source range; scalar offsets are explicitly named. */
export type Span = { from: number; to: number };

export type RegionKind = 'inlineCode' | 'codeBlock' | 'quote' | 'inlineMath' | 'blockMath' | 'mathGroup';
export type RuleSettings = {
  regions: Record<RegionKind, 'always' | 'inside' | 'never'>;
  force: boolean;
};

export const DEFAULT_RULES: RuleSettings = {
  regions: {
    inlineCode: 'inside', codeBlock: 'inside', quote: 'inside',
    inlineMath: 'inside', blockMath: 'inside', mathGroup: 'inside',
  },
  force: false,
};
