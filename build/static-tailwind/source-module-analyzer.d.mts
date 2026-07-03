export type SourceCandidateGroupBase = {
  id: string,
  filename: string,
  sourceKind: string,
  sourceAttributes?: string[],
  candidates: string[],
  line: number,
  column: number,
};

export type SourceCandidateGroup = SourceCandidateGroupBase & {
  owners: string[],
};

export type SourceCssOwner = {
  name: string,
  root: string,
};

export type SourceModuleAnalysisCache = Map<string, {
  source: string,
  groups: SourceCandidateGroupBase[],
}>;

export type SourceModuleAnalysis = {
  projectRoot: string,
  sourceRoot: string,
  files: string[],
  cssOwners: SourceCssOwner[],
  candidateGroups: SourceCandidateGroup[],
  candidateOwners: Map<string, Set<string>>,
};

export type SerializedSourceModuleAnalysis = {
  projectRoot: string,
  sourceRoot: string,
  files: string[],
  cssOwners: SourceCssOwner[],
  candidateOwners: Record<string, string[]>,
  candidateGroups: SourceCandidateGroup[],
};

export function isStaticTailwindSourceFile(options: {
  filename: string,
  sourceRoot: string,
}): boolean;

export function createSourceModuleAnalysisCache(): SourceModuleAnalysisCache;

export function analyzeSourceModules(options: {
  projectRoot: string,
  sourceRoot: string,
  ownershipMode: 'single-css' | 'source-module',
  cache: SourceModuleAnalysisCache,
}): SourceModuleAnalysis;

export function serializeSourceAnalysis(options: {
  analysis: SourceModuleAnalysis,
}): SerializedSourceModuleAnalysis;
