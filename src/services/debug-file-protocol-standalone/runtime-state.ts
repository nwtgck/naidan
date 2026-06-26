import {
  DEBUG_FILE_PROTOCOL_STANDALONE_DIAGNOSTICS_FORMAT,
  DEBUG_FILE_PROTOCOL_STANDALONE_STARTUP_FORMAT,
} from '@/file-protocol-standalone-protocol';

export type DebugFileProtocolStandaloneStartupCheckpointName =
  | 'importing-entry'
  | 'entry-imported'
  | 'entry-import-failed'
  | 'entry-evaluated'
  | 'waiting-dom'
  | 'bootstrapping'
  | 'waiting-router'
  | 'initializing-settings'
  | 'loading-chats'
  | 'mounting-vue'
  | 'mounted'
  | 'bootstrap-failed';

export type DebugFileProtocolStandaloneStartupCheckpointSource = 'entry-loader' | 'naidan-app';

export type DebugFileProtocolStandaloneStartupError = Readonly<{
  name: string,
  message: string,
  stack: string | undefined,
}>;

export type DebugFileProtocolStandaloneStartupCheckpoint = Readonly<{
  source: DebugFileProtocolStandaloneStartupCheckpointSource,
  name: DebugFileProtocolStandaloneStartupCheckpointName,
  at: number,
  documentReadyState: DocumentReadyState,
  details: Readonly<Record<string, string | number | boolean>> | undefined,
}>;

export type DebugFileProtocolStandaloneSlowStartupNotice = Readonly<{
  delayMs: number,
  delayElapsedAt: number,
  stalledCheckpoint: DebugFileProtocolStandaloneStartupCheckpointName,
  panelShownAt: number | undefined,
}>;

export type DebugFileProtocolStandaloneStartupState = {
  format: typeof DEBUG_FILE_PROTOCOL_STANDALONE_STARTUP_FORMAT,
  checkpoint: DebugFileProtocolStandaloneStartupCheckpointName,
  startedAt: number,
  updatedAt: number,
  documentReadyState: DocumentReadyState,
  entryFileName: string,
  checkpointHistory: DebugFileProtocolStandaloneStartupCheckpoint[],
  error: DebugFileProtocolStandaloneStartupError | undefined,
  slowStartupNotice: DebugFileProtocolStandaloneSlowStartupNotice | undefined,
};

export type DebugFileProtocolStandaloneSystemJsPatchDiagnostics = Readonly<{
  installed: true,
  patchedScripts: readonly Readonly<{
    url: string,
    crossOriginProperty: string | null,
    crossoriginAttribute: string | null,
  }>[],
}>;

export type DebugFileProtocolStandaloneSystemJsRetryDiagnostics = Readonly<{
  installed: true,
  physicalScriptLoadFailureUrls: readonly string[],
  deletedModuleUrls: readonly string[],
  retryableErrorCount: number,
  nonRetryableErrorCount: number,
}>;

export type DebugFileProtocolStandaloneWorkerRuntimeDiagnostics = Readonly<Record<string, unknown>>;

export type DebugFileProtocolStandaloneGlobalDiagnostics = Readonly<{
  format: typeof DEBUG_FILE_PROTOCOL_STANDALONE_DIAGNOSTICS_FORMAT,
  protocol: string | undefined,
  documentReadyState: DocumentReadyState,
  systemJsAvailable: boolean,
  systemJsPatch: DebugFileProtocolStandaloneSystemJsPatchDiagnostics | undefined,
  systemJsRetry: DebugFileProtocolStandaloneSystemJsRetryDiagnostics | undefined,
  workerRuntime: DebugFileProtocolStandaloneWorkerRuntimeDiagnostics | undefined,
  startup: DebugFileProtocolStandaloneStartupState | undefined,
}>;

export type FileProtocolStandaloneCoreInternalState = {
  workerBlobRegistry?: Record<string, unknown>,
};

export type DebugFileProtocolStandaloneInternalState = {
  startup?: DebugFileProtocolStandaloneStartupState,
  systemJsPatch?: DebugFileProtocolStandaloneSystemJsPatchDiagnostics,
  systemJsRetry?: DebugFileProtocolStandaloneSystemJsRetryDiagnostics,
  workerRuntime?: Record<string, unknown>,
};

export type FileProtocolStandaloneInternalState = {
  core?: FileProtocolStandaloneCoreInternalState,
  debug?: DebugFileProtocolStandaloneInternalState,
};

type FileProtocolStandaloneMutableNamespace = {
  getDiagnostics?: () => DebugFileProtocolStandaloneGlobalDiagnostics,
  internal?: FileProtocolStandaloneInternalState,
};

export function debugReadFileProtocolStandaloneInternalState(): DebugFileProtocolStandaloneInternalState | undefined {
  const namespace = globalThis.__FILE_PROTOCOL_STANDALONE__ as unknown as FileProtocolStandaloneMutableNamespace | undefined;
  return namespace?.internal?.debug;
}

export function debugReadFileProtocolStandaloneStartupState(): DebugFileProtocolStandaloneStartupState | undefined {
  return debugReadFileProtocolStandaloneInternalState()?.startup;
}
