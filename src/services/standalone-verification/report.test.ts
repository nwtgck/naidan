import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FileProtocolWorkerDiagnostics } from 'virtual:file-protocol-standalone/worker/file-protocol-compatible-standalone-worker-hub'
import type { StandaloneWorkerVerificationResult } from './worker-probe'
import {
  runStandaloneVerification,
  serializeStandaloneVerificationReportForCopy,
} from './report'

function createWorkerDiagnostics({
  workersCreated,
  workersTerminated,
  activeWorkers,
}: {
  workersCreated: number
  workersTerminated: number
  activeWorkers: number
}): FileProtocolWorkerDiagnostics {
  return {
    workerId: 'file-protocol-compatible-standalone-worker-hub',
    registryScriptLoads: 1,
    registryScriptLoadFailures: 0,
    blobRegistrations: 1,
    objectUrlsCreated: 1,
    workersCreated,
    workersTerminated,
    activeWorkers,
    runtimeDigestCalls: 0,
    sourceStoredAsGlobalString: false,
    objectUrlLifetime: 'page',
    registryEntryReleased: true,
    registryEntryPresent: false,
    blobUrlReady: true,
    blobBytes: 4096,
    sourcePartCount: 2,
    sha256: 'diagnostic-sha256',
    timingsMs: {},
  }
}

function createValidWorkerResult(): StandaloneWorkerVerificationResult {
  const before = createWorkerDiagnostics({
    workersCreated: 2,
    workersTerminated: 2,
    activeWorkers: 0,
  })
  const after = createWorkerDiagnostics({
    workersCreated: 5,
    workersTerminated: 5,
    activeWorkers: 0,
  })

  return {
    before,
    after,
    deltas: {
      workersCreated: 3,
      workersTerminated: 3,
      activeWorkers: 0,
      registryScriptLoads: 0,
      blobRegistrations: 0,
      objectUrlsCreated: 0,
    },
    concurrent: [
      { resolvedLanguage: 'json', htmlLength: 20 },
      { resolvedLanguage: 'json', htmlLength: 21 },
    ],
    recreated: { resolvedLanguage: 'json', htmlLength: 22 },
    weshFileProbe: {
      exitCode: 0,
      stdout: '/bin/sh: text/x-shellscript\n',
      stderr: '',
    },
  }
}

function appendExpectedScripts(): void {
  for (const id of [
    'file-protocol-standalone-systemjs-runtime',
    'file-protocol-standalone-systemjs-file-patch',
    'file-protocol-standalone-systemjs-retry-hook',
  ]) {
    const script = document.createElement('script')
    script.id = id
    script.src = `./assets/${id}.js`
    document.head.appendChild(script)
  }
  const manifest = document.createElement('script')
  manifest.id = 'file-protocol-standalone-worker-manifest'
  manifest.type = 'application/json'
  document.head.appendChild(manifest)
  const entry = document.createElement('script')
  entry.id = 'file-protocol-standalone-entry'
  document.head.appendChild(entry)
}

function createStyleProbes(): Readonly<{
  tailwindProbe: HTMLElement
  scopedProbe: HTMLElement
  lazyStyleProbe: HTMLElement
}> {
  const tailwindProbe = document.createElement('div')
  tailwindProbe.style.width = '43px'
  tailwindProbe.style.height = '13px'
  const scopedProbe = document.createElement('div')
  scopedProbe.style.borderLeft = '7px solid black'
  const lazyStyleProbe = document.createElement('div')
  document.body.append(tailwindProbe, scopedProbe, lazyStyleProbe)
  return { tailwindProbe, scopedProbe, lazyStyleProbe }
}

function installValidGlobals(): void {
  const startup = {
    format: 'file-protocol-standalone-startup-v1' as const,
    phase: 'mounted' as const,
    startedAt: 0,
    updatedAt: 1,
    documentReadyState: 'complete' as const,
    entryFileName: 'assets/index-legacy.js',
    history: [{
      phase: 'mounted' as const,
      at: 1,
      documentReadyState: 'complete' as const,
      details: undefined,
    }],
    error: undefined,
    watchdog: undefined,
  }
  const internal: FileProtocolStandaloneInternalState = {
    startup,
    systemJsPatch: {
      installed: true,
      patchedScripts: [{
        url: 'file:///__nonexistent_file_protocol_test_root__/assets/entry.js',
        crossOriginProperty: null,
        crossoriginAttribute: null,
      }],
    },
    systemJsRetry: {
      installed: true,
      physicalScriptLoadFailureUrls: [],
      deletedModuleUrls: [],
      retryableErrorCount: 0,
      nonRetryableErrorCount: 0,
    },
    workerRuntime: { worker: { objectUrlsCreated: 1 } },
  }
  globalThis.__FILE_PROTOCOL_STANDALONE__ = {
    internal,
    getDiagnostics: () => ({
      format: 'file-protocol-standalone-diagnostics-v1',
      protocol: 'file:',
      documentReadyState: document.readyState,
      systemJsAvailable: true,
      systemJsPatch: internal.systemJsPatch,
      systemJsRetry: internal.systemJsRetry,
      workerRuntime: internal.workerRuntime,
      startup: internal.startup,
    }),
  }
}

function createBaseArguments() {
  const probes = createStyleProbes()
  return {
    route: {
      fullPath: '/standalone-verification',
      name: '/standalone-verification',
      matchedPaths: ['/standalone-verification'],
      resolvedHref: '#/standalone-verification',
    },
    ...probes,
    loadLazyStyleProbe: async () => {
      probes.lazyStyleProbe.style.outlineStyle = 'solid'
      probes.lazyStyleProbe.style.outlineWidth = '3px'
      return { marker: 'standalone-verification-lazy-style-probe-v1' }
    },
    exerciseRouteTransition: async () => ({
      before: '/standalone-verification',
      transitioned: '/standalone-verification?__standalone-verification-route-probe=1',
      restored: '/standalone-verification',
    }),
    runWorkerProbe: async () => createValidWorkerResult(),
  }
}

beforeEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = '<div id="app"><div>mounted</div></div>'
  document.body.style.margin = '0px'
  vi.stubGlobal('location', {
    protocol: 'file:',
    href: 'file:///__nonexistent_file_protocol_test_root__/index.html#/standalone-verification',
    origin: 'null',
  })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  installValidGlobals()
  appendExpectedScripts()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete globalThis.__FILE_PROTOCOL_STANDALONE__
  Reflect.deleteProperty(performance, 'memory')
  document.head.innerHTML = ''
  document.body.innerHTML = ''
  document.body.removeAttribute('style')
})

describe('runStandaloneVerification', () => {
  it('reports every standalone check and runtime diagnostic when they pass', async () => {
    Object.defineProperty(performance, 'memory', {
      configurable: true,
      value: {
        jsHeapSizeLimit: 1000,
        totalJSHeapSize: 800,
        usedJSHeapSize: 600,
      },
    })
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{
      name: 'file:///__nonexistent_file_protocol_test_root__/assets/lazy.js',
      duration: 4,
      entryType: 'resource',
      startTime: 1,
      toJSON: () => ({}),
      initiatorType: 'script',
    } as PerformanceResourceTiming])
    const args = createBaseArguments()
    const runWorkerProbe = vi.fn(args.runWorkerProbe)

    const report = await runStandaloneVerification({ ...args, runWorkerProbe })

    expect(report.status).toBe('pass')
    expect(report.summary).toMatchObject({ passed: 12, failed: 0 })
    expect(report.checks.map((check) => [check.id, check.status])).toEqual([
      ['environment.file-protocol', 'pass'],
      ['startup.app-mounted', 'pass'],
      ['router.current-route', 'pass'],
      ['router.query-transition', 'pass'],
      ['styles.initial', 'pass'],
      ['styles.lazy-before-import', 'pass'],
      ['dynamic-imports.lazy-style-probe', 'pass'],
      ['systemjs.global-diagnostics', 'pass'],
      ['systemjs.file-patch', 'pass'],
      ['systemjs.retry-hook', 'pass'],
      ['output.classic-script-shape', 'pass'],
      ['worker.reusable-blob-url-factory', 'pass'],
    ])
    expect(runWorkerProbe).toHaveBeenCalledOnce()
    expect(report.environment).toMatchObject({
      href: 'file:///__nonexistent_file_protocol_test_root__/index.html#/standalone-verification',
      protocol: 'file:',
      origin: 'null',
      performanceMemory: {
        jsHeapSizeLimit: 1000,
        totalJSHeapSize: 800,
        usedJSHeapSize: 600,
      },
    })
    expect(report.runtime.pluginDiagnostics).toMatchObject({
      format: 'file-protocol-standalone-diagnostics-v1',
    })
    expect(report.runtime.resourceEntries).toEqual([{
      name: 'file:///__nonexistent_file_protocol_test_root__/assets/lazy.js',
      duration: 4,
      initiatorType: 'script',
    }])
  })

  it('isolates failed checks and continues through the Worker probe', async () => {
    document.body.innerHTML = ''
    document.body.style.margin = '8px'
    vi.stubGlobal('location', {
      protocol: 'https:',
      href: 'https://should-not-be-requested.invalid/',
      origin: 'https://should-not-be-requested.invalid',
    })
    delete globalThis.__FILE_PROTOCOL_STANDALONE__
    document.head.innerHTML = '<script type="module" crossorigin="anonymous"></script>'
    const args = createBaseArguments()
    args.tailwindProbe.style.width = '1px'
    args.scopedProbe.style.borderLeftWidth = '1px'
    const runWorkerProbe = vi.fn().mockResolvedValue({
      ...createValidWorkerResult(),
      deltas: {
        ...createValidWorkerResult().deltas,
        workersCreated: 2,
      },
    })

    const report = await runStandaloneVerification({
      ...args,
      route: {
        fullPath: 'invalid-route',
        name: undefined,
        matchedPaths: [],
        resolvedHref: '',
      },
      loadLazyStyleProbe: vi.fn().mockRejectedValue(new Error('synthetic lazy failure')),
      exerciseRouteTransition: vi.fn().mockResolvedValue({
        before: '/a',
        transitioned: '/a',
        restored: '/b',
      }),
      runWorkerProbe,
    })

    expect(report.status).toBe('fail')
    expect(report.checks).toHaveLength(12)
    expect(report.checks.filter((check) => check.status === 'fail').length).toBeGreaterThan(8)
    expect(report.checks.find((check) => check.id === 'dynamic-imports.lazy-style-probe')?.error).toBe('synthetic lazy failure')
    expect(report.checks.find((check) => check.id === 'output.classic-script-shape')?.error).toBe('A native module script remains in standalone output.')
    expect(runWorkerProbe).toHaveBeenCalledOnce()
  })

  it('times out a pending check and continues to a completed report', async () => {
    const args = createBaseArguments()
    const runWorkerProbe = vi.fn(async () => new Promise<StandaloneWorkerVerificationResult>(() => {}))

    const report = await runStandaloneVerification({
      ...args,
      runWorkerProbe,
      checkTimeoutMs: 100,
    })

    expect(report.status).toBe('fail')
    expect(report.checks.find((check) => check.id === 'worker.reusable-blob-url-factory')).toMatchObject({
      status: 'fail',
      error: 'Standalone verification check "worker.reusable-blob-url-factory" timed out after 100 ms.',
    })
    expect(report.summary).toMatchObject({ passed: 11, failed: 1 })
  })

  it('reads the global diagnostics API once and reuses one snapshot for all checks', async () => {
    const namespace = globalThis.__FILE_PROTOCOL_STANDALONE__
    if (namespace === undefined) throw new Error('Expected standalone namespace.')
    const originalGetDiagnostics = namespace.getDiagnostics
    const getDiagnostics = vi.fn(originalGetDiagnostics)
      .mockImplementationOnce(originalGetDiagnostics)
      .mockImplementation(() => {
        throw new Error('diagnostics should not be read twice')
      })
    globalThis.__FILE_PROTOCOL_STANDALONE__ = {
      internal: namespace.internal,
      getDiagnostics,
    }

    const report = await runStandaloneVerification(createBaseArguments())

    expect(report.status).toBe('pass')
    expect(getDiagnostics).toHaveBeenCalledOnce()
  })

  it('does not retry a failed diagnostics read for later checks', async () => {
    const namespace = globalThis.__FILE_PROTOCOL_STANDALONE__
    if (namespace === undefined) throw new Error('Expected standalone namespace.')
    const getDiagnostics = vi.fn(() => {
      throw new Error('synthetic diagnostics failure')
    })
    globalThis.__FILE_PROTOCOL_STANDALONE__ = {
      internal: namespace.internal,
      getDiagnostics,
    }

    const report = await runStandaloneVerification(createBaseArguments())

    expect(report.status).toBe('fail')
    expect(getDiagnostics).toHaveBeenCalledOnce()
    for (const id of [
      'startup.app-mounted',
      'systemjs.global-diagnostics',
      'systemjs.file-patch',
      'systemjs.retry-hook',
    ]) {
      expect(report.checks.find((check) => check.id === id)).toMatchObject({
        status: 'fail',
        error: 'synthetic diagnostics failure',
      })
    }
  })

  it('keeps report diagnostics detached from later live runtime mutations', async () => {
    const report = await runStandaloneVerification(createBaseArguments())
    const startupDetails = report.checks.find(({ id }) => id === 'startup.app-mounted')?.details

    const internal = globalThis.__FILE_PROTOCOL_STANDALONE__?.internal
    if (internal === undefined || internal.startup === undefined) {
      throw new Error('Expected standalone startup diagnostics.')
    }
    internal.startup.phase = 'bootstrap-failed'
    internal.startup.history.push({
      phase: 'bootstrap-failed',
      at: 2,
      documentReadyState: 'complete',
      details: undefined,
    })
    const livePatch = internal.systemJsPatch as unknown as {
      patchedScripts: {
        url: string
        crossOriginProperty: string | null
        crossoriginAttribute: string | null
      }[]
    }
    livePatch.patchedScripts.push({
      url: 'file:///__nonexistent_file_protocol_test_root__/assets/later.js',
      crossOriginProperty: null,
      crossoriginAttribute: null,
    })
    const liveWorker = internal.workerRuntime as {
      worker: { objectUrlsCreated: number }
    }
    liveWorker.worker.objectUrlsCreated = 99

    expect(startupDetails).toHaveProperty('startup.phase', 'mounted')
    expect(report.runtime.startup).toHaveProperty('phase', 'mounted')
    expect(report.runtime.systemJsPatch).toHaveProperty('patchedScripts.length', 1)
    expect(report.runtime.worker).toHaveProperty('worker.objectUrlsCreated', 1)
  })

  it('fails retry validation when its physical failure records are malformed', async () => {
    const internal = globalThis.__FILE_PROTOCOL_STANDALONE__?.internal
    if (internal === undefined) throw new Error('Expected standalone namespace.')
    internal.systemJsRetry = {
      installed: true,
      physicalScriptLoadFailureUrls: [42] as unknown as string[],
      deletedModuleUrls: [],
      retryableErrorCount: 0,
      nonRetryableErrorCount: 0,
    }
    const args = createBaseArguments()

    const report = await runStandaloneVerification(args)

    expect(report.checks.find((check) => check.id === 'systemjs.retry-hook')).toMatchObject({
      status: 'fail',
      error: 'SystemJS retry hook physicalScriptLoadFailureUrls records are invalid.',
    })
  })

  it('sanitizes the standalone root in copied JSON without mutating the report', async () => {
    const report = await runStandaloneVerification(createBaseArguments())

    const serialized = serializeStandaloneVerificationReportForCopy({ report })

    expect(serialized).toContain('<standalone-root>/index.html')
    expect(serialized).not.toContain('file:///__nonexistent_file_protocol_test_root__/')
    expect(report.environment.href).toContain('file:///__nonexistent_file_protocol_test_root__/')
  })
})
