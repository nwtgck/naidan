export type StaticTailwindAlias = {
  find: string,
  replacement: string,
};

export type UnresolvedDynamicImport = {
  line: number,
  column: number,
  expression: string,
};

export type SourceModuleImports = {
  staticImports: string[],
  dynamicImports: string[],
  unresolvedDynamicImports: UnresolvedDynamicImport[],
};

export type SourceCandidateGroup = {
  id: string,
  filename: string,
  sourceKind: string,
  sourceAttributes?: string[],
  candidates: string[],
  line: number,
  column: number,
  owners: string[],
};

export type SourceLazyOwner = {
  name: string,
  root: string,
};

export type SourceModuleAnalysis = {
  projectRoot: string,
  sourceRoot: string,
  entryModule: string,
  files: string[],
  graph: Map<string, SourceModuleImports>,
  unresolvedDynamicImports: (UnresolvedDynamicImport & { filename: string })[],
  initialModules: Set<string>,
  lazyOwners: SourceLazyOwner[],
  moduleOwners: Map<string, Set<string>>,
  candidateGroups: SourceCandidateGroup[],
  candidateOwners: Map<string, Set<string>>,
  fallbackInitialModules: Set<string>,
};

export type SerializedSourceModuleAnalysis = {
  projectRoot: string,
  sourceRoot: string,
  entryModule: string,
  files: string[],
  unresolvedDynamicImports: (UnresolvedDynamicImport & { filename: string })[],
  initialModules: string[],
  lazyOwners: SourceLazyOwner[],
  moduleOwners: Record<string, string[]>,
  fallbackInitialModules: string[],
  candidateOwners: Record<string, string[]>,
  candidateGroups: SourceCandidateGroup[],
};

export function analyzeSourceModules(options: {
  projectRoot: string,
  sourceRoot: string,
  entryModule: string,
  aliases: StaticTailwindAlias[],
  additionalLazyRootDirectories: string[],
  ownershipMode: 'single-css' | 'module-graph',
}): SourceModuleAnalysis;

export function serializeSourceAnalysis(options: {
  analysis: SourceModuleAnalysis,
}): SerializedSourceModuleAnalysis;
