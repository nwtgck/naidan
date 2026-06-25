import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { fileProtocolStandalone } from './file-protocol-standalone/index'

type WorkerDiagnostics = Readonly<{
  registryScriptLoads: number
  registryScriptLoadFailures: number
  blobRegistrations: number
  objectUrlsCreated: number
  workersCreated: number
  workersTerminated: number
  activeWorkers: number
  terminateInstrumentationFailures: number
  runtimeDigestCalls: number
  sourceStoredAsGlobalString: boolean
  objectUrlLifetime: string
  registryEntryReleased: boolean
  registryEntryPresent: boolean
  blobUrlStatus: 'idle' | 'warmup-scheduled' | 'loading' | 'ready' | 'failed'
  workerId: string
}>

type WorkerRuntimeApi = Readonly<{
  createFileProtocolStandaloneWorker: ({ name }: { name: string | undefined }) => Promise<Worker>
  debugGetFileProtocolStandaloneWorkerDiagnostics: () => WorkerDiagnostics
  scheduleFileProtocolStandaloneWorkerAssetWarmup: () => void
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
  idleCallbacks: readonly Readonly<{
    callback: IdleRequestCallback
    options: IdleRequestOptions | undefined
  }>[]
  objectUrlBlobs: readonly Blob[]
  revokedObjectUrls: readonly string[]
  scheduledCallbacks: readonly (() => void)[]
  registryScriptElementCount: () => number
  scriptLoadCount: () => number
  workerRecords: readonly FakeWorkerRecord[]
}>

const workerId = 'worker-hub'
const manifestScriptId = 'file-protocol-standalone-worker-manifest'

function getWorkerVirtualModuleSource(): string {
  const plugin = fileProtocolStandalone({
    workerTarget: ['chrome140', 'firefox140'],
    debugBuildReportFile: 'dist/report.json',
    workers: [{ id: workerId, entry: 'src/worker.ts' }],
    budgets: undefined,
    onAdditionalLicenseDependencies: undefined,
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
    .replace('export async function createFileProtocolStandaloneWorker', 'async function createFileProtocolStandaloneWorker')
    .replace('export function debugGetFileProtocolStandaloneWorkerDiagnostics', 'function debugGetFileProtocolStandaloneWorkerDiagnostics')
    .replace('export function scheduleFileProtocolStandaloneWorkerAssetWarmup', 'function scheduleFileProtocolStandaloneWorkerAssetWarmup')
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
  createFileProtocolStandaloneWorker,
  debugGetFileProtocolStandaloneWorkerDiagnostics,
  scheduleFileProtocolStandaloneWorkerAssetWarmup
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
  idleCallbackMode,
  createObjectUrlFailureCount,
  workerConstructorFailureCount,
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
  idleCallbackMode: 'available' | 'unavailable'
  createObjectUrlFailureCount: number
  workerConstructorFailureCount: number
}): RuntimeHarness {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'file:///__nonexistent_file_protocol_test_root__/index.html',
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
  const revokedObjectUrls: string[] = []
  let createObjectUrlCalls = 0
  class RuntimeUrl extends URL {
    static createObjectURL(blob: Blob): string {
      createObjectUrlCalls += 1
      if (createObjectUrlCalls <= createObjectUrlFailureCount) {
        throw new Error('synthetic createObjectURL failure')
      }
      objectUrlBlobs.push(blob)
      return `blob:test-${objectUrlBlobs.length}`
    }

    static revokeObjectURL(url: string): void {
      revokedObjectUrls.push(url)
    }
  }

  const workerRecords: FakeWorkerRecord[] = []
  let workerConstructorCalls = 0
  class FakeWorker {
    private terminateCalls = 0

    constructor(url: string | URL, options: WorkerOptions | undefined) {
      workerConstructorCalls += 1
      if (workerConstructorCalls <= workerConstructorFailureCount) {
        throw new Error('synthetic Worker constructor failure')
      }
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
      const namespace = (globalObject.__FILE_PROTOCOL_STANDALONE__ ??= {}) as {
        internal?: { core?: { workerBlobRegistry?: Record<string, WorkerRegistryEntry> } }
      }
      const internal = namespace.internal ??= {}
      const core = internal.core ??= {}
      const registry = core.workerBlobRegistry ??= {}
      registry[workerId] = entry
      script.onload?.(new dom.window.Event('load'))
    })
    return result
  }) as typeof document.head.appendChild

  const scheduledCallbacks: (() => void)[] = []
  const idleCallbacks: Array<Readonly<{
    callback: IdleRequestCallback
    options: IdleRequestOptions | undefined
  }>> = []
  if (idleCallbackMode === 'available') {
    ;(globalObject as { requestIdleCallback?: typeof requestIdleCallback }).requestIdleCallback = (callback, options) => {
      idleCallbacks.push({ callback, options })
      return idleCallbacks.length
    }
  }
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
    idleCallbacks,
    objectUrlBlobs,
    revokedObjectUrls,
    scheduledCallbacks,
    registryScriptElementCount: () => document.head.querySelectorAll('script').length,
    scriptLoadCount: () => scriptLoadCount,
    workerRecords,
  }
}

function createSuccessfulHarness({ idleCallbackMode }: {
  idleCallbackMode: 'available' | 'unavailable'
}): RuntimeHarness {
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
    idleCallbackMode,
    createObjectUrlFailureCount: 0,
    workerConstructorFailureCount: 0,
  })
}

describe('fileProtocolStandalone generated worker runtime', () => {
  it('loads one registry and reuses one Blob URL for multiple named Worker instances', async () => {
    const harness = createSuccessfulHarness({ idleCallbackMode: 'unavailable' })

    const [first, second] = await Promise.all([
      harness.api.createFileProtocolStandaloneWorker({ name: 'first-worker' }),
      harness.api.createFileProtocolStandaloneWorker({ name: undefined }),
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
    const diagnostics = harness.api.debugGetFileProtocolStandaloneWorkerDiagnostics()
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
      blobUrlStatus: 'ready',
      workerId,
    })
    expect(harness.workerRecords[0]?.terminateCallCount()).toBe(2)
    expect(harness.workerRecords[1]?.terminateCallCount()).toBe(1)
    expect(harness.globalObject).not.toHaveProperty('__FILE_PROTOCOL_STANDALONE_WORKER_RUNTIME__')
    expect(harness.globalObject).toHaveProperty(
      '__FILE_PROTOCOL_STANDALONE__.internal.debug.workerRuntime.worker-hub.objectUrlsCreated',
      1,
    )
    expect(harness.globalObject).not.toHaveProperty('__FILE_PROTOCOL_STANDALONE_WORKER_BLOBS__')
    expect(harness.globalObject).toHaveProperty(
      '__FILE_PROTOCOL_STANDALONE__.internal.core.workerBlobRegistry',
      {},
    )
    expect(harness.registryScriptElementCount()).toBe(0)
    expect(harness.revokedObjectUrls).toEqual([])
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
      idleCallbackMode: 'unavailable',
      createObjectUrlFailureCount: 0,
      workerConstructorFailureCount: 0,
    })

    await expect(harness.api.createFileProtocolStandaloneWorker({ name: undefined })).rejects.toThrow('Failed to load worker registry')
    expect(harness.registryScriptElementCount()).toBe(0)
    await expect(harness.api.createFileProtocolStandaloneWorker({ name: undefined })).resolves.toBeDefined()

    expect(harness.scriptLoadCount()).toBe(2)
    expect(harness.registryScriptElementCount()).toBe(0)
    expect(harness.api.debugGetFileProtocolStandaloneWorkerDiagnostics()).toMatchObject({
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
      idleCallbackMode: 'unavailable',
      createObjectUrlFailureCount: 0,
      workerConstructorFailureCount: 0,
    })

    await expect(harness.api.createFileProtocolStandaloneWorker({ name: undefined })).rejects.toThrow('metadata mismatch')
    expect(harness.objectUrlBlobs).toHaveLength(0)
    expect(harness.api.debugGetFileProtocolStandaloneWorkerDiagnostics()).toMatchObject({
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
      idleCallbackMode: 'unavailable',
      createObjectUrlFailureCount: 0,
      workerConstructorFailureCount: 0,
    })

    await expect(harness.api.createFileProtocolStandaloneWorker({ name: undefined })).rejects.toThrow('byte length mismatch')
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
      idleCallbackMode: 'unavailable',
      createObjectUrlFailureCount: 0,
      workerConstructorFailureCount: 0,
    })

    await expect(harness.api.createFileProtocolStandaloneWorker({ name: undefined })).rejects.toThrow('must be a local file:// URL')
    expect(harness.scriptLoadCount()).toBe(0)
    expect(harness.objectUrlBlobs).toHaveLength(0)
  })

  it('uses the timeout fallback to warm the shared asset without creating a Worker', async () => {
    const harness = createSuccessfulHarness({ idleCallbackMode: 'unavailable' })

    harness.api.scheduleFileProtocolStandaloneWorkerAssetWarmup()
    expect(harness.scheduledCallbacks).toHaveLength(1)
    harness.scheduledCallbacks[0]?.()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(harness.scriptLoadCount()).toBe(1)
    expect(harness.objectUrlBlobs).toHaveLength(1)
    expect(harness.workerRecords).toHaveLength(0)
    expect(harness.api.debugGetFileProtocolStandaloneWorkerDiagnostics()).toMatchObject({
      blobUrlStatus: 'ready',
      objectUrlsCreated: 1,
      workersCreated: 0,
    })
  })

  it('keeps non-callable idle scheduling fail-open', () => {
    const harness = createSuccessfulHarness({ idleCallbackMode: 'unavailable' })
    harness.globalObject.requestIdleCallback = () => {
      throw new Error('synthetic idle scheduling failure')
    }

    expect(() => harness.api.scheduleFileProtocolStandaloneWorkerAssetWarmup()).not.toThrow()
    expect(harness.api.debugGetFileProtocolStandaloneWorkerDiagnostics()).toMatchObject({
      blobUrlStatus: 'idle',
      workersCreated: 0,
    })
  })

  it('uses requestIdleCallback with an explicit timeout when it is available', async () => {
    const harness = createSuccessfulHarness({ idleCallbackMode: 'available' })

    harness.api.scheduleFileProtocolStandaloneWorkerAssetWarmup()

    expect(harness.scheduledCallbacks).toEqual([])
    expect(harness.idleCallbacks).toHaveLength(1)
    expect(harness.idleCallbacks[0]?.options).toEqual({ timeout: 1000 })
    harness.idleCallbacks[0]?.callback({
      didTimeout: false,
      timeRemaining: () => 50,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(harness.scriptLoadCount()).toBe(1)
    expect(harness.workerRecords).toEqual([])
  })

  it('coalesces repeated warmup requests before and after the shared Blob URL is ready', async () => {
    const harness = createSuccessfulHarness({ idleCallbackMode: 'unavailable' })

    harness.api.scheduleFileProtocolStandaloneWorkerAssetWarmup()
    harness.api.scheduleFileProtocolStandaloneWorkerAssetWarmup()
    harness.api.scheduleFileProtocolStandaloneWorkerAssetWarmup()
    expect(harness.scheduledCallbacks).toHaveLength(1)

    harness.scheduledCallbacks[0]?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    harness.api.scheduleFileProtocolStandaloneWorkerAssetWarmup()

    expect(harness.scheduledCallbacks).toHaveLength(1)
    expect(harness.scriptLoadCount()).toBe(1)
    expect(harness.objectUrlBlobs).toHaveLength(1)
  })

  it('shares one physical load when idle warming and first Worker creation overlap', async () => {
    const harness = createSuccessfulHarness({ idleCallbackMode: 'unavailable' })

    harness.api.scheduleFileProtocolStandaloneWorkerAssetWarmup()
    harness.scheduledCallbacks[0]?.()
    const worker = await harness.api.createFileProtocolStandaloneWorker({ name: 'first-worker' })

    expect(worker).toBeDefined()
    expect(harness.scriptLoadCount()).toBe(1)
    expect(harness.objectUrlBlobs).toHaveLength(1)
    expect(harness.workerRecords).toHaveLength(1)
  })

  it('does not let a failed idle warmup poison later Worker creation', async () => {
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
      idleCallbackMode: 'unavailable',
      createObjectUrlFailureCount: 0,
      workerConstructorFailureCount: 0,
    })

    harness.api.scheduleFileProtocolStandaloneWorkerAssetWarmup()
    harness.scheduledCallbacks[0]?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(harness.api.createFileProtocolStandaloneWorker({ name: undefined })).resolves.toBeDefined()

    expect(harness.scriptLoadCount()).toBe(2)
    expect(harness.api.debugGetFileProtocolStandaloneWorkerDiagnostics()).toMatchObject({
      registryScriptLoadFailures: 1,
      registryScriptLoads: 1,
      workersCreated: 1,
    })
  })

  it('retries Object URL creation without reloading the already registered Blob', async () => {
    const workerSource = 'self.onmessage = function () {};'
    const sourceBytes = new Blob([workerSource]).size
    const harness = createRuntimeHarness({
      registryScript: './assets/worker-source-worker-hub.js',
      failLoadCount: 0,
      workerSource,
      blobSource: workerSource,
      manifestSourceBytes: sourceBytes,
      manifestSourcePartCount: 1,
      manifestSha256: 'object-url-retry-sha256',
      registrySourceBytes: sourceBytes,
      registrySourcePartCount: 1,
      registrySha256: 'object-url-retry-sha256',
      idleCallbackMode: 'unavailable',
      createObjectUrlFailureCount: 1,
      workerConstructorFailureCount: 0,
    })

    await expect(harness.api.createFileProtocolStandaloneWorker({ name: undefined })).rejects.toThrow('synthetic createObjectURL failure')
    expect(harness.globalObject).toHaveProperty(
      `__FILE_PROTOCOL_STANDALONE__.internal.core.workerBlobRegistry.${workerId}`,
    )
    await expect(harness.api.createFileProtocolStandaloneWorker({ name: undefined })).resolves.toBeDefined()

    expect(harness.scriptLoadCount()).toBe(1)
    expect(harness.objectUrlBlobs).toHaveLength(1)
    expect(harness.globalObject).not.toHaveProperty('__FILE_PROTOCOL_STANDALONE_WORKER_BLOBS__')
    expect(harness.globalObject).toHaveProperty(
      '__FILE_PROTOCOL_STANDALONE__.internal.core.workerBlobRegistry',
      {},
    )
  })

  it('reuses the page-lifetime Blob URL after a Worker constructor failure', async () => {
    const workerSource = 'self.onmessage = function () {};'
    const sourceBytes = new Blob([workerSource]).size
    const harness = createRuntimeHarness({
      registryScript: './assets/worker-source-worker-hub.js',
      failLoadCount: 0,
      workerSource,
      blobSource: workerSource,
      manifestSourceBytes: sourceBytes,
      manifestSourcePartCount: 1,
      manifestSha256: 'worker-constructor-retry-sha256',
      registrySourceBytes: sourceBytes,
      registrySourcePartCount: 1,
      registrySha256: 'worker-constructor-retry-sha256',
      idleCallbackMode: 'unavailable',
      createObjectUrlFailureCount: 0,
      workerConstructorFailureCount: 1,
    })

    await expect(harness.api.createFileProtocolStandaloneWorker({ name: undefined })).rejects.toThrow('synthetic Worker constructor failure')
    await expect(harness.api.createFileProtocolStandaloneWorker({ name: 'retry-worker' })).resolves.toBeDefined()

    expect(harness.scriptLoadCount()).toBe(1)
    expect(harness.objectUrlBlobs).toHaveLength(1)
    expect(harness.workerRecords).toHaveLength(1)
    expect(harness.workerRecords[0]?.url).toBe('blob:test-1')
    expect(harness.workerRecords[0]?.options).toEqual({ name: 'retry-worker' })
  })

})
