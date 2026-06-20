import type { FileProtocolWorkerDiagnostics } from 'virtual:file-protocol-standalone/worker/file-protocol-compatible-standalone-worker-hub'

type WorkerFactory = ({ name }: { name: string | undefined }) => Promise<Worker>

let workerFactory: WorkerFactory = async () => {
  throw new Error('Test worker factory is not configured.')
}
let diagnostics: FileProtocolWorkerDiagnostics = {
  workerId: 'file-protocol-compatible-standalone-worker-hub',
  registryScriptLoads: 0,
  registryScriptLoadFailures: 0,
  blobRegistrations: 0,
  objectUrlsCreated: 0,
  workersCreated: 0,
  workersTerminated: 0,
  activeWorkers: 0,
  runtimeDigestCalls: 0,
  sourceStoredAsGlobalString: false,
  objectUrlLifetime: 'page',
  registryEntryReleased: false,
  registryEntryPresent: false,
  blobUrlReady: false,
  timingsMs: {},
}
let warmCallCount = 0

export function configureFileProtocolStandaloneWorkerMock({
  factory,
  nextDiagnostics,
}: {
  factory: WorkerFactory
  nextDiagnostics: FileProtocolWorkerDiagnostics
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

export async function createFileProtocolWorker({ name }: {
  name: string | undefined
}): Promise<Worker> {
  return workerFactory({ name })
}

export function getFileProtocolWorkerDiagnostics(): FileProtocolWorkerDiagnostics {
  return diagnostics
}

export function warmFileProtocolWorkerAssetAtIdle(): void {
  warmCallCount += 1
}
