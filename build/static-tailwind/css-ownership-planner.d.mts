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

export type CssOwnershipPlan = {
  candidates: string[],
  candidateOwners: Map<string, Set<string>>,
  ownerCandidateGroups: Map<string, string[]>,
  baselineCss: string,
  globalCss: string,
  globalDelta: string,
  cssGroups: Map<string, string>,
  conflicts: unknown[],
  compression: {
    maxLazyCssGroups: number | undefined,
    candidates: CssOwnershipCompression,
    atoms: CssOwnershipCompression,
  },
  metrics: unknown,
  tailwindVersion: string,
};

export function createCssOwnershipPlan(options: {
  projectRoot: string,
  cssEntryPath: string,
  expectedTailwindVersion: string | undefined,
  analysis: CssOwnershipAnalysis,
  maxLazyCssGroups: number | undefined,
}): Promise<CssOwnershipPlan>;

export function serializeCssOwnershipPlan(options: { plan: CssOwnershipPlan }): unknown;
export function writeCssOwnershipDebugFiles(options: { directory: string, plan: CssOwnershipPlan }): void;
