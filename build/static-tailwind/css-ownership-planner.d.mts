export type CandidateGroup = {
  id: string,
  filename: string,
  line: number,
  column: number,
  sourceKind: string,
  sourceAttributes?: string[],
  candidates: string[],
};

export type CssOwnershipAnalysis = {
  candidateGroups: CandidateGroup[],
  candidateOwners: Map<string, Set<string>>,
};

export type CssOwnershipCompression = {
  originalLazyGroupCount: number,
  retainedLazyGroupCount: number,
  promotedCandidateCount?: number,
  promotedAtomCount?: number,
  retainedOwnerKeys: string[],
};

export type CssByteMetrics = {
  raw: number,
  gzip: number,
};

export type CssOwnershipMetrics = {
  baseline: CssByteMetrics,
  uniqueDelta: CssByteMetrics,
  ordering: {
    runtimeFragmentCount: number,
    runtimeMetadataRaw: number,
    runtimeMetadataGzip: number,
  },
  placement: {
    globalAtomCount: number,
    sourceOwnedAtomCount: number,
    initialSupportAtomCount: number,
  },
  emitted: {
    groupCount: number,
    raw: number,
    gzip: number,
    duplicateAtomCount: number,
    duplicateRaw: number,
    duplicateRatio: number,
    structuralOverheadRaw: number,
  },
};

export type CssRuntimeFragment = {
  order: number,
  css: string,
};

export type CssOwnershipPlan = {
  outputMode: 'single' | 'split',
  candidates: string[],
  candidateOwners: Map<string, Set<string>>,
  ownerCandidateGroups: Map<string, string[]>,
  baselineCss: string,
  entryCss: string,
  globalCss: string,
  globalDelta: string,
  cssGroups: Map<string, string>,
  runtimeFragmentsByOwner: Map<string, CssRuntimeFragment[]>,
  conflicts: unknown[],
  compression: {
    maxSplitCssGroups: number | undefined,
    candidates: CssOwnershipCompression,
    atoms: CssOwnershipCompression,
  },
  metrics: CssOwnershipMetrics,
  tailwindVersion: string,
};

export function createCssOwnershipPlan(options: {
  projectRoot: string,
  cssEntryPath: string,
  expectedTailwindVersion: string | undefined,
  analysis: CssOwnershipAnalysis,
  outputMode: 'single' | 'split',
  maxSplitCssGroups: number | undefined,
}): Promise<CssOwnershipPlan>;

export function serializeCssOwnershipPlan(options: { plan: CssOwnershipPlan }): unknown;
export function writeCssOwnershipDebugFiles(options: { directory: string, plan: CssOwnershipPlan }): void;
