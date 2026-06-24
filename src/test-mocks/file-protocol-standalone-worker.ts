import type { DebugFileProtocolStandaloneWorkerDiagnostics } from 'virtual:file-protocol-standalone/worker/file-protocol-standalone-worker-hub'

type WorkerFactory = ({ name }: { name: string | undefined }) => Promise<Worker>

let workerFactory: WorkerFactory = async () => {
  throw new Error('Test worker factory is not configured.')
}
let diagnostics: DebugFileProtocolStandaloneWorkerDiagnostics = {
  workerId: 'file-protocol-standalone-worker-hub',
  registryScriptLoads: 0,
  registryScriptLoadFailures: 0,
  blobRegistrations: 0,
  objectUrlsCreated: 0,
  workersCreated: 0,
  workersTerminated: 0,
  activeWorkers: 0,
  terminateInstrumentationFailures: 0,
  runtimeDigestCalls: 0,
  sourceStoredAsGlobalString: false,
  objectUrlLifetime: 'page',
  registryEntryReleased: false,
  registryEntryPresent: false,
  blobUrlStatus: 'idle',
  timingsMs: {},
}
let warmCallCount = 0

export function configureFileProtocolStandaloneWorkerMock({
  factory,
  nextDiagnostics,
}: {
  factory: WorkerFactory
  nextDiagnostics: DebugFileProtocolStandaloneWorkerDiagnostics
}): void {
  workerFactory = factory
  diagnostics = nextDiagnostics
  warmCallCount = 0
}

export function getFileProtocolStandaloneWorkerMockState(): Readonly<{
  warmCallCount: number
}> {
  return { warmCallCount }
}

export async function createFileProtocolStandaloneWorker({ name }: {
  name: string | undefined
}): Promise<Worker> {
  return workerFactory({ name })
}

export function debugGetFileProtocolStandaloneWorkerDiagnostics(): DebugFileProtocolStandaloneWorkerDiagnostics {
  return diagnostics
}

export function scheduleFileProtocolStandaloneWorkerAssetWarmup(): void {
  warmCallCount += 1
}
