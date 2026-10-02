export type Region = { id: string; kind: RegionKind; source: Span; parentId: string | null; parent?: Region };
export type VisibleUnit = {
  text: string;
  source: Span;
  encoding: 'plain' | 'escape' | 'entity' | 'wikiAlias';
  context: 'text' | 'code' | 'link' | 'table';
  formats: string[];
  regionIds: string[];
  partial: boolean;
  /** Bare wikilinks must gain an alias; their target is never replaced. */
  wiki?: { source: Span; target: string };
};
export type Projection = {
  selection: Span;
  runs: { units: VisibleUnit[] }[];
  regions: Region[];
  fingerprint: string;
};

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
