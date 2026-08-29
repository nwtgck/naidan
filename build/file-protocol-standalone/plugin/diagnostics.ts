export type WorkerRealmGlobalReference = Readonly<{name: string; accessKind: string; start: number; end: number; line: number | null; column: number | null}>;
export type ViteWorkerQueryRecord = Readonly<{kind: string; specifier: string; flags: string[]; start: number; end: number; line: number | null; column: number | null}>;

export type WorkerConstructorKind = 'Worker' | 'SharedWorker';
export type RawWorkerConstructorRecord = Readonly<{
  kind: WorkerConstructorKind;
  calleeForm: string;
  argumentKind: string;
  start: number;
  end: number;
  line: number | null;
  column: number | null;
  invocationKind?: 'Reflect.construct';
}>;

export type ClassicScriptAssetDiagnostic = Readonly<{outputFileName: string; sourcePath?: string; kind?: string}>;
export type VirtualModuleDiagnostic = Readonly<{workerName: string; virtualId: string; resolvedVirtualId: string; source: string}>;
export type ChunkDiagnostic = {
  fileName: string;
  name: string;
  isEntry: boolean;
  facadeModuleId: string | null;
  imports: string[];
  dynamicImports: string[];
  moduleIds: string[];
  beforeBytes: number;
  afterBytes?: number;
};
export type HtmlDiagnostic = Readonly<{
  fileName: string;
  moduleEntryUrls: string[];
  systemRuntimeUrl: string;
  uiPreloadedCssFileNames: string[];
  uiPreloadedCssUrls: string[];
  startupScriptElementIds: string[];
}>;
export type RawWorkerSourceCandidateDiagnostic = RawWorkerConstructorRecord & Readonly<{
  stage: 'source';
  moduleId: string;
  expressionSource: string;
}>;
export type RawWorkerOutputDiagnostic = RawWorkerConstructorRecord & Readonly<{
  stage: 'output';
  moduleId: string;
  moduleIds: string[];
  outputFileName: string;
  expressionSource: string;
  generatedBootstrapWorker: boolean;
  allowed: boolean;
}>;
export type ViteWorkerQueryDiagnostic = ViteWorkerQueryRecord & Readonly<{moduleId: string; allowed: boolean}>;
export type WorkerRealmGlobalDiagnostic = WorkerRealmGlobalReference & Readonly<{
  moduleId: string;
  owners: string[];
  workerOwners: string[];
  included: boolean;
  workerReachable: boolean;
  allowed: boolean;
}>;
export type WorkerCssDiagnostic = Readonly<{
  classificationBasis: 'source-module-graph';
  workerEntryModuleIds: string[];
  uiEntryModuleIds: string[];
  workerCss: string[];
  uiCss: string[];
  workerOnlyCss: string[];
  emittedCssAssets: string[];
}>;
export type StandaloneBuildDiagnostics = Record<string, unknown> & {
  chunks: ChunkDiagnostic[];
  classicScriptAssets: ClassicScriptAssetDiagnostic[];
  virtualModules: VirtualModuleDiagnostic[];
  html: HtmlDiagnostic[];
  rawWorkerSourceCandidates: RawWorkerSourceCandidateDiagnostic[];
  rawWorkerConstructors: RawWorkerOutputDiagnostic[];
  viteWorkerQueryImports: ViteWorkerQueryDiagnostic[];
  workerRealmGlobalReferences: WorkerRealmGlobalDiagnostic[];
  workerCss?: WorkerCssDiagnostic;
  commonJsCompatibilityChecked?: boolean;
  modulePreloadDisabled?: boolean;
  cssCodeSplitEnabled?: boolean;
  lazyCssDependencyMetadataEnabled?: boolean;
  vitePreloadHelperRealmNeutral?: boolean;
  vitePreloadHelperSkipsDomOutsideUiRealm?: boolean;
  vitePreloadHelperSkipsFileScriptPreloads?: boolean;
  vitePreloadHelperOmitsFileCrossorigin?: boolean;
};
