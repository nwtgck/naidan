declare global {
  type FileProtocolStandaloneSystemJsPatchDiagnostics = Readonly<{
    installed: true
    patchedScripts: readonly Readonly<{
      url: string
      crossOriginProperty: string | null
      crossoriginAttribute: string | null
    }>[]
  }>

  type FileProtocolStandaloneSystemJsRetryDiagnostics = Readonly<{
    installed: true
    physicalScriptLoadFailureUrls: readonly string[]
    deletedModuleUrls: readonly string[]
    retryableErrorCount: number
    nonRetryableErrorCount: number
  }>

  type FileProtocolStandaloneWorkerRuntimeDiagnostics = Readonly<Record<string, unknown>>

  type FileProtocolStandaloneGlobalDiagnostics = Readonly<{
    format: 'file-protocol-standalone-diagnostics-v1'
    protocol: string | undefined
    documentReadyState: DocumentReadyState
    systemJsAvailable: boolean
    systemJsPatch: FileProtocolStandaloneSystemJsPatchDiagnostics | undefined
    systemJsRetry: FileProtocolStandaloneSystemJsRetryDiagnostics | undefined
    workerRuntime: FileProtocolStandaloneWorkerRuntimeDiagnostics | undefined
    startup: import('./services/app-startup').FileProtocolStandaloneStartupState | undefined
  }>

  type FileProtocolStandaloneInternalState = {
    startup?: import('./services/app-startup').FileProtocolStandaloneStartupState
    systemJsPatch?: FileProtocolStandaloneSystemJsPatchDiagnostics
    systemJsRetry?: FileProtocolStandaloneSystemJsRetryDiagnostics
    workerRuntime?: Record<string, unknown>
    workerBlobRegistry?: Record<string, unknown>
  }

  var __FILE_PROTOCOL_STANDALONE__: Readonly<{
    getDiagnostics(): FileProtocolStandaloneGlobalDiagnostics
    /** @internal Plugin-generated scripts and Naidan startup share this state. */
    internal: FileProtocolStandaloneInternalState
  }> | undefined
}

export {}
