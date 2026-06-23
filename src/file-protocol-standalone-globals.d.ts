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

type FileProtocolStandaloneGlobalDiagnostics = Readonly<{
  format: 'file-protocol-standalone-diagnostics-v1'
  protocol: string | undefined
  documentReadyState: DocumentReadyState
  systemJsAvailable: boolean
  systemJsPatch: FileProtocolStandaloneSystemJsPatchDiagnostics | undefined
  systemJsRetry: FileProtocolStandaloneSystemJsRetryDiagnostics | undefined
  workerRuntime: Readonly<Record<string, unknown>> | undefined
  startup: import('./services/app-startup').FileProtocolStandaloneStartupState
}>

declare global {
  var __FILE_PROTOCOL_STANDALONE__: Readonly<{
    getDiagnostics(): FileProtocolStandaloneGlobalDiagnostics
  }> | undefined
  var __FILE_PROTOCOL_STANDALONE_SYSTEMJS_PATCH__: FileProtocolStandaloneSystemJsPatchDiagnostics | undefined
  var __FILE_PROTOCOL_STANDALONE_SYSTEMJS_RETRY__: FileProtocolStandaloneSystemJsRetryDiagnostics | undefined
  var __FILE_PROTOCOL_STANDALONE_WORKER_RUNTIME__: Readonly<Record<string, unknown>> | undefined
}

export {}
