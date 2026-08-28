import type { FileProtocolStandaloneReleaseValidationOptions } from './release-validation.js';

export type NaidanStandaloneWorkerDefinition = Readonly<{
  name: string;
  entry: string;
  virtualId: string;
  defaultWorkerName?: string;
}>;

export type NaidanStandalonePolicies = Readonly<{
  allowExternalWasmAssets?: boolean;
  allowWorkerOnlyCssAssets?: boolean;
  allowRawWorkerConstructor?: (record: unknown) => boolean;
  allowViteWorkerQueryImport?: (record: unknown) => boolean;
  allowWorkerRealmGlobal?: (record: unknown) => boolean;
  uiOnlyGlobals?: readonly string[];
}>;

export type NaidanStandaloneSourceAudit =
  | Readonly<{mode: 'inline'}>
  | Readonly<{mode: 'external'; evidence: string}>;

type NaidanStandaloneReleaseValidationOptions = Omit<
  FileProtocolStandaloneReleaseValidationOptions,
  'workers' | 'runtimeFileNames' | 'sourceAudit'
>;

export type NaidanStandalonePluginOptions = Readonly<{
  workers: readonly NaidanStandaloneWorkerDefinition[];
  systemRuntimePath: string;
  systemRuntimeSourceMapPath?: string;
  diagnostics?: Record<string, unknown>;
  startupSlowNoticeDelayMs?: number;
  policies?: NaidanStandalonePolicies;
  sourceAudit?: NaidanStandaloneSourceAudit;
  releaseValidation?: NaidanStandaloneReleaseValidationOptions;
}>;
