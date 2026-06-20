import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { fileProtocolStandalone } from './file-protocol-standalone'

type WorkerDiagnostics = Readonly<{
  registryScriptLoads: number
  registryScriptLoadFailures: number
  blobRegistrations: number
  objectUrlsCreated: number
  workersCreated: number
  workersTerminated: number
  activeWorkers: number
  runtimeDigestCalls: number
  sourceStoredAsGlobalString: boolean
  objectUrlLifetime: string
  registryEntryReleased: boolean
  registryEntryPresent: boolean
  blobUrlReady: boolean
  workerId: string
}>

type WorkerRuntimeApi = Readonly<{
  createFileProtocolWorker: ({ name }: { name: string | undefined }) => Promise<Worker>
  getFileProtocolWorkerDiagnostics: () => WorkerDiagnostics
  warmFileProtocolWorkerAssetAtIdle: () => void
}>

type FakeWorkerRecord = Readonly<{
  url: string
  options: WorkerOptions | undefined
  terminateCallCount: () => number
}>

type WorkerRegistryEntry = {
  sourceBlob: Blob
  sourceBytes: number
  sourcePartCount: number
  sha256: string
}

type RuntimeHarness = Readonly<{
  api: WorkerRuntimeApi
  globalObject: Record<string, unknown>
  objectUrlBlobs: readonly Blob[]
  scheduledCallbacks: readonly (() => void)[]
  scriptLoadCount: () => number
  workerRecords: readonly FakeWorkerRecord[]
}>

const workerId = 'worker-hub'
const registryGlobal = '__FILE_PROTOCOL_STANDALONE_WORKER_BLOBS__'
const manifestScriptId = 'file-protocol-standalone-worker-manifest'

function getWorkerVirtualModuleSource(): string {
  const plugin = fileProtocolStandalone({
    reportFile: 'dist/report.json',
    workers: [{ id: workerId, entry: 'src/worker.ts' }],
    budgets: undefined,
  })
  const resolveId = plugin.resolveId as unknown as ((id: string) => string | undefined)
  const load = plugin.load as unknown as ((id: string) => string | undefined)
  const resolvedId = resolveId(`virtual:file-protocol-standalone/worker/${workerId}`)
  if (resolvedId === undefined) {
    throw new Error('Expected the virtual worker id to resolve.')
  }
  const source = load(resolvedId)
  if (source === undefined) {
    throw new Error('Expected the virtual worker module to load.')
  }
  return source
}

function compileWorkerRuntime({
  source,
  globalObject,
  document,
  urlConstructor,
  workerConstructor,
  scheduledCallbacks,
}: {
  source: string
  globalObject: Record<string, unknown>
  document: Document
  urlConstructor: typeof URL
  workerConstructor: typeof Worker
  scheduledCallbacks: (() => void)[]
}): WorkerRuntimeApi {
  const executableSource = source
    .replace('export async function createFileProtocolWorker', 'async function createFileProtocolWorker')
    .replace('export function getFileProtocolWorkerDiagnostics', 'function getFileProtocolWorkerDiagnostics')
    .replace('export function warmFileProtocolWorkerAssetAtIdle', 'function warmFileProtocolWorkerAssetAtIdle')
  const factory = new Function(
    'globalThis',
    'document',
    'URL',
    'Blob',
    'Worker',
    'performance',
    'setTimeout',
    `\
${executableSource}
return {
  createFileProtocolWorker,
  getFileProtocolWorkerDiagnostics,
  warmFileProtocolWorkerAssetAtIdle
};
`,
  ) as (
    globalObject: Record<string, unknown>,
    document: Document,
    urlConstructor: typeof URL,
    blobConstructor: typeof Blob,
    workerConstructor: typeof Worker,
    performance: Readonly<{ now: () => number }>,
    setTimeout: (callback: () => void) => number,
  ) => WorkerRuntimeApi

  return factory(
    globalObject,
    document,
    urlConstructor,
    Blob,
    workerConstructor,
    { now: () => 0 },
    (callback) => {
      scheduledCallbacks.push(callback)
      return scheduledCallbacks.length
    },
  )
}

function createRuntimeHarness({
  registryScript,
  failLoadCount,
  workerSource,
  blobSource,
  manifestSourceBytes,
  manifestSourcePartCount,
  manifestSha256,
  registrySourceBytes,
  registrySourcePartCount,
  registrySha256,
}: {
  registryScript: string
  failLoadCount: number
  workerSource: string
  blobSource: string
  manifestSourceBytes: number | undefined
  manifestSourcePartCount: number
  manifestSha256: string
  registrySourceBytes: number | undefined
  registrySourcePartCount: number
  registrySha256: string
}): RuntimeHarness {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'file:///tmp/naidan/index.html',
  })
  const { document } = dom.window
  const expectedBlob = new Blob([workerSource], { type: 'text/javascript' })
  const sourceBlob = new Blob([blobSource], { type: 'text/javascript' })
  const manifest = {
    [workerId]: {
      registryScript,
      sourceBytes: manifestSourceBytes ?? expectedBlob.size,
      sourcePartCount: manifestSourcePartCount,
      sha256: manifestSha256,
    },
  }
  const manifestElement = document.createElement('script')
  manifestElement.id = manifestScriptId
  manifestElement.type = 'application/json'
  manifestElement.textContent = JSON.stringify(manifest)
  document.body.appendChild(manifestElement)

  const globalObject = dom.window as unknown as Record<string, unknown>
  const objectUrlBlobs: Blob[] = []
  class RuntimeUrl extends URL {
    static createObjectURL(blob: Blob): string {
      objectUrlBlobs.push(blob)
      return `blob:test-${objectUrlBlobs.length}`
    }
  }

  const workerRecords: FakeWorkerRecord[] = []
  class FakeWorker {
    private terminateCalls = 0

    constructor(url: string | URL, options: WorkerOptions | undefined) {
      const record = {
        url: String(url),
        options,
        terminateCallCount: () => this.terminateCalls,
      }
      workerRecords.push(record)
    }

    terminate(): void {
      this.terminateCalls += 1
    }
  }

  let scriptLoadCount = 0
  const originalAppendChild = document.head.appendChild.bind(document.head)
  document.head.appendChild = ((node: Node) => {
    const result = originalAppendChild(node)
    if (node.nodeName !== 'SCRIPT') {
      return result
    }
    scriptLoadCount += 1
    const script = node as HTMLScriptElement
    queueMicrotask(() => {
      if (scriptLoadCount <= failLoadCount) {
        script.onerror?.(new dom.window.Event('error'))
        return
      }
      const entry: WorkerRegistryEntry = {
        sourceBlob,
        sourceBytes: registrySourceBytes ?? expectedBlob.size,
        sourcePartCount: registrySourcePartCount,
        sha256: registrySha256,
      }
      globalObject[registryGlobal] = { [workerId]: entry }
      script.onload?.(new dom.window.Event('load'))
    })
    return result
  }) as typeof document.head.appendChild

  const scheduledCallbacks: (() => void)[] = []
  const api = compileWorkerRuntime({
    source: getWorkerVirtualModuleSource(),
    globalObject,
    document,
    urlConstructor: RuntimeUrl,
    workerConstructor: FakeWorker as unknown as typeof Worker,
    scheduledCallbacks,
  })

  return {
    api,
    globalObject,
    objectUrlBlobs,
    scheduledCallbacks,
    scriptLoadCount: () => scriptLoadCount,
    workerRecords,
  }
}

function createSuccessfulHarness(): RuntimeHarness {
  const workerSource = `\
self.onmessage = function () {
  self.postMessage('ok');
};
`
  const sourceBytes = new Blob([workerSource], { type: 'text/javascript' }).size
  return createRuntimeHarness({
    registryScript: './assets/worker-source-worker-hub.js',
    failLoadCount: 0,
    workerSource,
    blobSource: workerSource,
    manifestSourceBytes: sourceBytes,
    manifestSourcePartCount: 1,
    manifestSha256: 'fixture-sha256',
    registrySourceBytes: sourceBytes,
    registrySourcePartCount: 1,
    registrySha256: 'fixture-sha256',
  })
}

describe('fileProtocolStandalone generated worker runtime', () => {
  it('loads one registry and reuses one Blob URL for multiple named Worker instances', async () => {
    const harness = createSuccessfulHarness()

    const [first, second] = await Promise.all([
      harness.api.createFileProtocolWorker({ name: 'first-worker' }),
      harness.api.createFileProtocolWorker({ name: undefined }),
    ])

    expect(harness.scriptLoadCount()).toBe(1)
    expect(harness.objectUrlBlobs).toHaveLength(1)
    expect(harness.workerRecords).toHaveLength(2)
    expect(harness.workerRecords.map((record) => record.url)).toEqual(['blob:test-1', 'blob:test-1'])
    expect(harness.workerRecords[0]?.options).toEqual({ name: 'first-worker' })
    expect(harness.workerRecords[1]?.options).toBeUndefined()

    first.terminate()
    first.terminate()
    second.terminate()
    const diagnostics = harness.api.getFileProtocolWorkerDiagnostics()
    expect(diagnostics).toMatchObject({
      registryScriptLoads: 1,
      registryScriptLoadFailures: 0,
      objectUrlsCreated: 1,
      workersCreated: 2,
      workersTerminated: 2,
      activeWorkers: 0,
      runtimeDigestCalls: 0,
      sourceStoredAsGlobalString: false,
      objectUrlLifetime: 'page',
      registryEntryReleased: true,
      registryEntryPresent: false,
      blobUrlReady: true,
      workerId,
    })
    expect(harness.workerRecords[0]?.terminateCallCount()).toBe(2)
    expect(harness.workerRecords[1]?.terminateCallCount()).toBe(1)
    expect(harness.globalObject[registryGlobal]).toEqual({})
  })

  it('clears a rejected load promise so a later call performs a physical retry', async () => {
    const workerSource = 'self.onmessage = function () {};'
    const sourceBytes = new Blob([workerSource]).size
    const harness = createRuntimeHarness({
      registryScript: './assets/worker-source-worker-hub.js',
      failLoadCount: 1,
      workerSource,
      blobSource: workerSource,
      manifestSourceBytes: sourceBytes,
      manifestSourcePartCount: 1,
      manifestSha256: 'retry-sha256',
      registrySourceBytes: sourceBytes,
      registrySourcePartCount: 1,
      registrySha256: 'retry-sha256',
    })

    await expect(harness.api.createFileProtocolWorker({ name: undefined })).rejects.toThrow('Failed to load worker registry')
    await expect(harness.api.createFileProtocolWorker({ name: undefined })).resolves.toBeDefined()

    expect(harness.scriptLoadCount()).toBe(2)
    expect(harness.api.getFileProtocolWorkerDiagnostics()).toMatchObject({
      registryScriptLoads: 1,
      registryScriptLoadFailures: 1,
      objectUrlsCreated: 1,
      workersCreated: 1,
    })
  })

  it('rejects mixed manifest and registry metadata without reading the Blob back', async () => {
    const workerSource = 'self.onmessage = function () {};'
    const sourceBytes = new Blob([workerSource]).size
    const harness = createRuntimeHarness({
      registryScript: './assets/worker-source-worker-hub.js',
      failLoadCount: 0,
      workerSource,
      blobSource: workerSource,
      manifestSourceBytes: sourceBytes,
      manifestSourcePartCount: 1,
      manifestSha256: 'manifest-sha256',
      registrySourceBytes: sourceBytes,
      registrySourcePartCount: 1,
      registrySha256: 'different-sha256',
    })

    await expect(harness.api.createFileProtocolWorker({ name: undefined })).rejects.toThrow('metadata mismatch')
    expect(harness.objectUrlBlobs).toHaveLength(0)
    expect(harness.api.getFileProtocolWorkerDiagnostics()).toMatchObject({
      runtimeDigestCalls: 0,
      objectUrlsCreated: 0,
      workersCreated: 0,
    })
  })

  it('rejects a Blob whose byte length does not match the validated metadata', async () => {
    const workerSource = 'self.onmessage = function () {};'
    const sourceBytes = new Blob([workerSource]).size
    const harness = createRuntimeHarness({
      registryScript: './assets/worker-source-worker-hub.js',
      failLoadCount: 0,
      workerSource,
      blobSource: `${workerSource}extra`,
      manifestSourceBytes: sourceBytes,
      manifestSourcePartCount: 1,
      manifestSha256: 'fixture-sha256',
      registrySourceBytes: sourceBytes,
      registrySourcePartCount: 1,
      registrySha256: 'fixture-sha256',
    })

    await expect(harness.api.createFileProtocolWorker({ name: undefined })).rejects.toThrow('byte length mismatch')
    expect(harness.objectUrlBlobs).toHaveLength(0)
  })

  it('refuses a non-file registry URL before appending a script', async () => {
    const workerSource = 'self.onmessage = function () {};'
    const harness = createRuntimeHarness({
      registryScript: 'https://example.test/worker-source.js',
      failLoadCount: 0,
      workerSource,
      blobSource: workerSource,
      manifestSourceBytes: undefined,
      manifestSourcePartCount: 1,
      manifestSha256: 'fixture-sha256',
      registrySourceBytes: undefined,
      registrySourcePartCount: 1,
      registrySha256: 'fixture-sha256',
    })

    await expect(harness.api.createFileProtocolWorker({ name: undefined })).rejects.toThrow('must be a local file:// URL')
    expect(harness.scriptLoadCount()).toBe(0)
    expect(harness.objectUrlBlobs).toHaveLength(0)
  })

  it('uses the timeout fallback to warm the shared asset without creating a Worker', async () => {
    const harness = createSuccessfulHarness()

    harness.api.warmFileProtocolWorkerAssetAtIdle()
    expect(harness.scheduledCallbacks).toHaveLength(1)
    harness.scheduledCallbacks[0]?.()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(harness.scriptLoadCount()).toBe(1)
    expect(harness.objectUrlBlobs).toHaveLength(1)
    expect(harness.workerRecords).toHaveLength(0)
    expect(harness.api.getFileProtocolWorkerDiagnostics()).toMatchObject({
      blobUrlReady: true,
      objectUrlsCreated: 1,
      workersCreated: 0,
    })
  })
})
