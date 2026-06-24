declare module 'virtual:file-protocol-standalone/worker/file-protocol-standalone-worker-hub' {
  export type DebugFileProtocolStandaloneWorkerDiagnostics = Readonly<{
    workerId: string
    registryScriptLoads: number
    registryScriptLoadFailures: number
    blobRegistrations: number
    objectUrlsCreated: number
    workersCreated: number
    workersTerminated: number
    activeWorkers: number
    terminateInstrumentationFailures: number
    runtimeDigestCalls: number
    sourceStoredAsGlobalString: false
    objectUrlLifetime: 'page'
    registryEntryReleased: boolean
    registryEntryPresent: boolean
    blobUrlStatus: 'idle' | 'warmup-scheduled' | 'loading' | 'ready' | 'failed'
    blobBytes?: number
    sourcePartCount?: number
    sha256?: string
    timingsMs: Readonly<Record<string, number>>
  }>

  export function createFileProtocolStandaloneWorker({ name }: {
    name: string | undefined
  }): Promise<Worker>

  export function debugGetFileProtocolStandaloneWorkerDiagnostics(): DebugFileProtocolStandaloneWorkerDiagnostics
  export function scheduleFileProtocolStandaloneWorkerAssetWarmup(): void
}
