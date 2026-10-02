export type Region = { id: string; kind: RegionKind; source: Span; parentId: string | null; parent?: Region; content?: Span; excluded?: Span[] };
export type VisibleUnit = {
  text: string;
  source: Span;
  encoding: 'plain' | 'escape' | 'entity' | 'wikiAlias' | 'mathPlain' | 'mathCommand' | 'mathEscape';
  context: 'text' | 'code' | 'link' | 'table' | 'math';
  formats: string[];
  regionIds: string[];
  partial: boolean;
  /** Bare wikilinks must gain an alias; their target is never replaced. */
  wiki?: { source: Span; target: string };
  math?: { command?: string; textMode: boolean };
};
export type SourceChange = Span & { insert: string };
export type ExpectedScalar = { text: string; context: VisibleUnit['context']; formats: string[] };
export type PatchPlan = { changes: SourceChange[]; outputs: string[]; expected: ExpectedScalar[][] };
export type StyleWrapper = { kind: string; open: Span; close: Span };

export type Projection = {
  source: string;
  styles: StyleWrapper[];
  rules: RuleSettings;
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

export function regionAllows(region: Region, selection: Span, rules: RuleSettings): boolean {
  if (region.parent && !regionAllows(region.parent, selection, rules)) return false;
  const policy = rules.regions[region.kind];
  return policy === 'always' || (policy === 'inside' && region.source.from <= selection.from && selection.to <= region.source.to);
}

export const DEFAULT_RULES: RuleSettings = {
  regions: {
    inlineCode: 'inside', codeBlock: 'inside', quote: 'inside',
    inlineMath: 'inside', blockMath: 'inside', mathGroup: 'inside',
  },
  force: false,
};
