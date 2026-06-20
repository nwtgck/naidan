declare module 'virtual:file-protocol-standalone/worker/file-protocol-compatible-standalone-worker-hub' {
  export type FileProtocolWorkerDiagnostics = Readonly<{
    workerId: string
    registryScriptLoads: number
    registryScriptLoadFailures: number
    blobRegistrations: number
    objectUrlsCreated: number
    workersCreated: number
    workersTerminated: number
    activeWorkers: number
    runtimeDigestCalls: number
    sourceStoredAsGlobalString: false
    objectUrlLifetime: 'page'
    registryEntryReleased: boolean
    registryEntryPresent: boolean
    blobUrlReady: boolean
    blobBytes?: number
    sourcePartCount?: number
    sha256?: string
    timingsMs: Readonly<Record<string, number>>
  }>

  export function createFileProtocolWorker({ name }: {
    name: string | undefined
  }): Promise<Worker>

  export function getFileProtocolWorkerDiagnostics(): FileProtocolWorkerDiagnostics
  export function warmFileProtocolWorkerAssetAtIdle(): void
}
