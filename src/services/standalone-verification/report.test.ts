import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FileProtocolWorkerDiagnostics } from 'virtual:file-protocol-standalone/worker/file-protocol-compatible-standalone-worker-hub'
import type { StandaloneWorkerVerificationResult } from './worker-probe'
import { runStandaloneVerification } from './report'

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
  }
}

function appendScript({
  type,
  src,
  crossorigin,
}: {
  type: string | undefined
  src: string | undefined
  crossorigin: string | undefined
}): HTMLScriptElement {
  const script = document.createElement('script')
  if (type !== undefined) {
    script.type = type
  }
  if (src !== undefined) {
    script.src = src
  }
  if (crossorigin !== undefined) {
    script.setAttribute('crossorigin', crossorigin)
  }
  document.head.appendChild(script)
  return script
}

function createStyleProbes(): Readonly<{
  tailwindProbe: HTMLElement
  scopedProbe: HTMLElement
  lazyCssProbe: HTMLElement
}> {
  const tailwindProbe = document.createElement('div')
  tailwindProbe.style.width = '43px'
  tailwindProbe.style.height = '13px'
  const scopedProbe = document.createElement('div')
  scopedProbe.style.borderLeft = '7px solid black'
  const lazyCssProbe = document.createElement('div')
  document.body.append(tailwindProbe, scopedProbe, lazyCssProbe)
  return { tailwindProbe, scopedProbe, lazyCssProbe }
}

function installValidSystemJsPatch(): void {
  Object.defineProperty(globalThis, '__FILE_PROTOCOL_STANDALONE_SYSTEMJS_PATCH__', {
    configurable: true,
    writable: true,
    value: {
      installed: true,
      patchedScripts: [{
        url: 'file:///tmp/assets/entry.js',
        crossOriginProperty: null,
        crossoriginAttribute: null,
      }],
    },
  })
}

beforeEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = '<div id="app"><div>mounted</div></div>'
  document.body.style.margin = '0px'
  vi.stubGlobal('location', {
    protocol: 'file:',
    href: 'file:///tmp/naidan/index.html#/',
    origin: 'null',
  })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  installValidSystemJsPatch()
  Object.defineProperty(globalThis, '__FILE_PROTOCOL_STANDALONE_STARTUP__', {
    configurable: true,
    writable: true,
    value: {
      format: 'file-protocol-standalone-startup-v1',
      phase: 'mounted',
      history: [{ phase: 'mounted', at: 1 }],
    },
  })
  Object.defineProperty(globalThis, '__FILE_PROTOCOL_STANDALONE_SYSTEMJS_RETRY__', {
    configurable: true,
    writable: true,
    value: { installed: true, deletedModuleUrls: [] },
  })
  Object.defineProperty(globalThis, '__FILE_PROTOCOL_STANDALONE_WORKER_RUNTIME__', {
    configurable: true,
    writable: true,
    value: { worker: { objectUrlsCreated: 1 } },
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete (globalThis as typeof globalThis & {
    __FILE_PROTOCOL_STANDALONE_STARTUP__?: unknown
  }).__FILE_PROTOCOL_STANDALONE_STARTUP__
  delete (globalThis as typeof globalThis & {
    __FILE_PROTOCOL_STANDALONE_SYSTEMJS_PATCH__?: unknown
  }).__FILE_PROTOCOL_STANDALONE_SYSTEMJS_PATCH__
  delete (globalThis as typeof globalThis & {
    __FILE_PROTOCOL_STANDALONE_SYSTEMJS_RETRY__?: unknown
  }).__FILE_PROTOCOL_STANDALONE_SYSTEMJS_RETRY__
  delete (globalThis as typeof globalThis & {
    __FILE_PROTOCOL_STANDALONE_WORKER_RUNTIME__?: unknown
  }).__FILE_PROTOCOL_STANDALONE_WORKER_RUNTIME__
  Reflect.deleteProperty(performance, 'memory')
  document.head.innerHTML = ''
  document.body.innerHTML = ''
  document.body.removeAttribute('style')
})

describe('runStandaloneVerification', () => {
  it('reports all standalone checks and runtime diagnostics when they pass', async () => {
    const probes = createStyleProbes()
    appendScript({
      type: undefined,
      src: './assets/entry.js',
      crossorigin: undefined,
    })
    appendScript({
      type: 'application/json',
      src: undefined,
      crossorigin: undefined,
    })
    Object.defineProperty(performance, 'memory', {
      configurable: true,
      value: {
        jsHeapSizeLimit: 1000,
        totalJSHeapSize: 800,
        usedJSHeapSize: 600,
      },
    })
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{
      name: 'file:///tmp/assets/lazy.js',
      duration: 4,
      entryType: 'resource',
      startTime: 1,
      toJSON: () => ({}),
      initiatorType: 'script',
    } as PerformanceResourceTiming])
    const loadLazyProbe = vi.fn(async () => {
      probes.lazyCssProbe.style.outlineStyle = 'solid'
      probes.lazyCssProbe.style.outlineWidth = '3px'
      return { marker: 'standalone-verification-lazy-probe-v1' }
    })
    const runWorkerProbe = vi.fn().mockResolvedValue(createValidWorkerResult())

    const report = await runStandaloneVerification({
      route: {
        fullPath: '/',
        name: 'home',
        matchedPaths: ['/'],
        resolvedHref: '#/',
      },
      ...probes,
      loadLazyProbe,
      runWorkerProbe,
    })

    expect(report.status).toBe('pass')
    expect(report.summary).toMatchObject({ passed: 9, failed: 0 })
    expect(report.checks.map((check) => [check.id, check.status])).toEqual([
      ['environment.file-protocol', 'pass'],
      ['startup.app-mounted', 'pass'],
      ['router.current-route', 'pass'],
      ['styles.initial', 'pass'],
      ['dynamic-imports.lazy-probe', 'pass'],
      ['systemjs.file-patch', 'pass'],
      ['systemjs.retry-hook', 'pass'],
      ['output.classic-script-shape', 'pass'],
      ['worker.reusable-blob-url-factory', 'pass'],
    ])
    expect(loadLazyProbe).toHaveBeenCalledOnce()
    expect(runWorkerProbe).toHaveBeenCalledOnce()
    expect(report.environment).toMatchObject({
      href: 'file:///tmp/naidan/index.html#/',
      protocol: 'file:',
      origin: 'null',
      performanceMemory: {
        jsHeapSizeLimit: 1000,
        totalJSHeapSize: 800,
        usedJSHeapSize: 600,
      },
    })
    const runtimeGlobals = globalThis as typeof globalThis & {
      __FILE_PROTOCOL_STANDALONE_STARTUP__?: unknown
      __FILE_PROTOCOL_STANDALONE_SYSTEMJS_PATCH__?: unknown
      __FILE_PROTOCOL_STANDALONE_SYSTEMJS_RETRY__?: unknown
      __FILE_PROTOCOL_STANDALONE_WORKER_RUNTIME__?: unknown
    }
    expect(report.runtime.startup).toEqual(runtimeGlobals.__FILE_PROTOCOL_STANDALONE_STARTUP__)
    expect(report.runtime.systemJsPatch).toEqual(runtimeGlobals.__FILE_PROTOCOL_STANDALONE_SYSTEMJS_PATCH__)
    expect(report.runtime.systemJsRetry).toEqual(runtimeGlobals.__FILE_PROTOCOL_STANDALONE_SYSTEMJS_RETRY__)
    expect(report.runtime.worker).toEqual(runtimeGlobals.__FILE_PROTOCOL_STANDALONE_WORKER_RUNTIME__)
    expect(report.runtime.resourceEntries).toEqual([{
      name: 'file:///tmp/assets/lazy.js',
      duration: 4,
      initiatorType: 'script',
    }])
  })

  it('isolates every failed check and continues through the worker probe', async () => {
    document.body.innerHTML = ''
    document.body.style.margin = '8px'
    vi.stubGlobal('location', {
      protocol: 'https:',
      href: 'https://example.invalid/',
      origin: 'https://example.invalid',
    })
    delete (globalThis as typeof globalThis & {
      __FILE_PROTOCOL_STANDALONE_SYSTEMJS_PATCH__?: unknown
    }).__FILE_PROTOCOL_STANDALONE_SYSTEMJS_PATCH__
    delete (globalThis as typeof globalThis & {
      __FILE_PROTOCOL_STANDALONE_SYSTEMJS_RETRY__?: unknown
    }).__FILE_PROTOCOL_STANDALONE_SYSTEMJS_RETRY__
    appendScript({
      type: 'MoDuLe; charset=utf-8',
      src: './assets/entry.js',
      crossorigin: 'anonymous',
    })
    const probes = createStyleProbes()
    probes.tailwindProbe.style.width = '1px'
    probes.scopedProbe.style.borderLeftWidth = '1px'
    const loadLazyProbe = vi.fn().mockRejectedValue(new Error('synthetic lazy failure'))
    const invalidWorkerResult = createValidWorkerResult()
    const runWorkerProbe = vi.fn().mockResolvedValue({
      ...invalidWorkerResult,
      deltas: {
        ...invalidWorkerResult.deltas,
        workersCreated: 2,
      },
    })

    const report = await runStandaloneVerification({
      route: {
        fullPath: 'invalid-route',
        name: undefined,
        matchedPaths: [],
        resolvedHref: '',
      },
      ...probes,
      loadLazyProbe,
      runWorkerProbe,
    })

    expect(report.status).toBe('fail')
    expect(report.summary).toMatchObject({ passed: 0, failed: 9 })
    expect(report.checks).toHaveLength(9)
    expect(report.checks.every((check) => check.status === 'fail')).toBe(true)
    expect(report.checks.map((check) => check.id)).toEqual([
      'environment.file-protocol',
      'startup.app-mounted',
      'router.current-route',
      'styles.initial',
      'dynamic-imports.lazy-probe',
      'systemjs.file-patch',
      'systemjs.retry-hook',
      'output.classic-script-shape',
      'worker.reusable-blob-url-factory',
    ])
    expect(report.checks.find((check) => check.id === 'dynamic-imports.lazy-probe')?.error).toBe('synthetic lazy failure')
    expect(report.checks.find((check) => check.id === 'output.classic-script-shape')?.error).toBe('A native module script remains in standalone output.')
    expect(runWorkerProbe).toHaveBeenCalledOnce()
  })

  it('rejects a classic executable script that retains crossorigin', async () => {
    const probes = createStyleProbes()
    appendScript({
      type: 'Application/JavaScript; charset=utf-8',
      src: './assets/entry.js',
      crossorigin: 'anonymous',
    })

    const report = await runStandaloneVerification({
      route: {
        fullPath: '/',
        name: 'home',
        matchedPaths: ['/'],
        resolvedHref: '#/',
      },
      ...probes,
      loadLazyProbe: async () => {
        probes.lazyCssProbe.style.outlineStyle = 'solid'
        probes.lazyCssProbe.style.outlineWidth = '3px'
        return { marker: 'standalone-verification-lazy-probe-v1' }
      },
      runWorkerProbe: async () => createValidWorkerResult(),
    })

    expect(report.status).toBe('fail')
    expect(report.summary.failed).toBe(1)
    expect(report.checks.find((check) => check.id === 'output.classic-script-shape')).toMatchObject({
      status: 'fail',
      error: 'An executable standalone script still has crossorigin.',
    })
  })

  it('fails the retry-hook check when its deletion records are malformed', async () => {
    const probes = createStyleProbes()
    Object.defineProperty(globalThis, '__FILE_PROTOCOL_STANDALONE_SYSTEMJS_RETRY__', {
      configurable: true,
      writable: true,
      value: {
        installed: true,
        deletedModuleUrls: [42],
      },
    })

    const report = await runStandaloneVerification({
      route: {
        fullPath: '/',
        name: 'home',
        matchedPaths: ['/'],
        resolvedHref: '#/',
      },
      ...probes,
      loadLazyProbe: async () => {
        probes.lazyCssProbe.style.outlineStyle = 'solid'
        probes.lazyCssProbe.style.outlineWidth = '3px'
        return { marker: 'standalone-verification-lazy-probe-v1' }
      },
      runWorkerProbe: async () => createValidWorkerResult(),
    })

    expect(report.status).toBe('fail')
    expect(report.summary.failed).toBe(1)
    expect(report.checks.find((check) => check.id === 'systemjs.retry-hook')).toMatchObject({
      status: 'fail',
      error: 'SystemJS retry hook deletion records are invalid.',
    })
  })

  it('fails the SystemJS check when the patch has not observed a loaded script', async () => {
    const probes = createStyleProbes()
    Object.defineProperty(globalThis, '__FILE_PROTOCOL_STANDALONE_SYSTEMJS_PATCH__', {
      configurable: true,
      writable: true,
      value: {
        installed: true,
        patchedScripts: [],
      },
    })

    const report = await runStandaloneVerification({
      route: {
        fullPath: '/',
        name: 'home',
        matchedPaths: ['/'],
        resolvedHref: '#/',
      },
      ...probes,
      loadLazyProbe: async () => {
        probes.lazyCssProbe.style.outlineStyle = 'solid'
        probes.lazyCssProbe.style.outlineWidth = '3px'
        return { marker: 'standalone-verification-lazy-probe-v1' }
      },
      runWorkerProbe: async () => createValidWorkerResult(),
    })

    expect(report.checks.find((check) => check.id === 'systemjs.file-patch')).toMatchObject({
      status: 'fail',
      error: 'SystemJS file-protocol patch did not observe any loaded script.',
    })
  })

  it('rejects malformed SystemJS patch records without aborting later checks', async () => {
    const probes = createStyleProbes()
    Object.defineProperty(globalThis, '__FILE_PROTOCOL_STANDALONE_SYSTEMJS_PATCH__', {
      configurable: true,
      writable: true,
      value: {
        installed: true,
        patchedScripts: [{
          url: 'file:///tmp/assets/entry.js',
          crossOriginProperty: 'anonymous',
          crossoriginAttribute: 'anonymous',
        }],
      },
    })
    const runWorkerProbe = vi.fn().mockResolvedValue(createValidWorkerResult())

    const report = await runStandaloneVerification({
      route: {
        fullPath: '/',
        name: 'home',
        matchedPaths: ['/'],
        resolvedHref: '#/',
      },
      ...probes,
      loadLazyProbe: async () => {
        probes.lazyCssProbe.style.outlineStyle = 'solid'
        probes.lazyCssProbe.style.outlineWidth = '3px'
        return { marker: 'standalone-verification-lazy-probe-v1' }
      },
      runWorkerProbe,
    })

    expect(report.summary.failed).toBe(1)
    expect(report.checks.find((check) => check.id === 'systemjs.file-patch')).toMatchObject({
      status: 'fail',
      error: 'SystemJS patch record 0 retains the crossOrigin property.',
    })
    expect(runWorkerProbe).toHaveBeenCalledOnce()
  })
})
