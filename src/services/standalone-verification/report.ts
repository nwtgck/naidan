import type { StandaloneWorkerVerificationResult } from './worker-probe'

export type StandaloneVerificationStatus = 'pass' | 'fail'

export type StandaloneVerificationCheck = Readonly<{
  id: string
  category: 'environment' | 'startup' | 'router' | 'styles' | 'dynamic-imports' | 'systemjs' | 'output' | 'worker'
  status: StandaloneVerificationStatus
  durationMs: number
  details: unknown | undefined
  error: string | undefined
}>

export type StandaloneVerificationRouteSnapshot = Readonly<{
  fullPath: string
  name: string | undefined
  matchedPaths: readonly string[]
  resolvedHref: string
}>

export type StandaloneVerificationReport = Readonly<{
  format: 'naidan-standalone-verification-v1'
  generatedAt: string
  status: StandaloneVerificationStatus
  summary: Readonly<{
    passed: number
    failed: number
    durationMs: number
  }>
  environment: Readonly<{
    href: string
    protocol: string
    origin: string
    userAgent: string
    readyState: DocumentReadyState
    performanceMemory: Readonly<Record<string, number>> | undefined
  }>
  checks: readonly StandaloneVerificationCheck[]
  runtime: Readonly<{
    startup: unknown
    systemJsPatch: unknown
    systemJsRetry: unknown
    worker: unknown
    resourceEntries: readonly Readonly<{
      name: string
      duration: number
      initiatorType: string
    }>[]
  }>
}>

type SystemJsPatchRecord = Readonly<{
  url: string
  crossOriginProperty: string | null
  crossoriginAttribute: string | null
}>

type SystemJsPatchState = Readonly<{
  installed: boolean
  patchedScripts: readonly SystemJsPatchRecord[]
}>

type SystemJsRetryState = Readonly<{
  installed: true
  deletedModuleUrls: readonly string[]
}>

const executableScriptTypes = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'module',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
])

function normalizeScriptType({ type }: { type: string | undefined }): string {
  return type?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

function isExecutableScriptType({ type }: { type: string | undefined }): boolean {
  return type === undefined || type.trim() === '' || executableScriptTypes.has(normalizeScriptType({ type }))
}

function toErrorMessage({ error }: { error: unknown }): string {
  return error instanceof Error ? error.message : String(error)
}

function assertCondition({ condition, message }: { condition: boolean, message: string }): void {
  if (!condition) {
    throw new Error(message)
  }
}

function readPerformanceMemory(): Readonly<Record<string, number>> | undefined {
  const memory = (performance as Performance & {
    memory?: Readonly<{
      jsHeapSizeLimit: number
      totalJSHeapSize: number
      usedJSHeapSize: number
    }>
  }).memory

  if (memory === undefined) {
    return undefined
  }

  return {
    jsHeapSizeLimit: memory.jsHeapSizeLimit,
    totalJSHeapSize: memory.totalJSHeapSize,
    usedJSHeapSize: memory.usedJSHeapSize,
  }
}

function readSystemJsPatchState(): SystemJsPatchState {
  const value = (globalThis as typeof globalThis & {
    __FILE_PROTOCOL_STANDALONE_SYSTEMJS_PATCH__?: unknown
  }).__FILE_PROTOCOL_STANDALONE_SYSTEMJS_PATCH__

  if (typeof value !== 'object' || value === null) {
    throw new Error('SystemJS file-protocol patch state is missing.')
  }

  const candidate = value as {
    installed?: unknown
    patchedScripts?: unknown
  }
  assertCondition({
    condition: candidate.installed === true,
    message: 'SystemJS file-protocol patch is not installed.',
  })
  assertCondition({
    condition: Array.isArray(candidate.patchedScripts),
    message: 'SystemJS file-protocol patch records are invalid.',
  })

  const records = candidate.patchedScripts as unknown[]
  assertCondition({
    condition: records.length > 0,
    message: 'SystemJS file-protocol patch did not observe any loaded script.',
  })
  const patchedScripts = records.map((record, index): SystemJsPatchRecord => {
    if (typeof record !== 'object' || record === null) {
      throw new Error(`SystemJS patch record ${index} is invalid.`)
    }
    const typedRecord = record as {
      url?: unknown
      crossOriginProperty?: unknown
      crossoriginAttribute?: unknown
    }
    assertCondition({
      condition: typeof typedRecord.url === 'string',
      message: `SystemJS patch record ${index} has no URL.`,
    })
    assertCondition({
      condition: typedRecord.crossOriginProperty === null,
      message: `SystemJS patch record ${index} retains the crossOrigin property.`,
    })
    assertCondition({
      condition: typedRecord.crossoriginAttribute === null,
      message: `SystemJS patch record ${index} retains the crossorigin attribute.`,
    })

    return {
      url: typedRecord.url as string,
      crossOriginProperty: null,
      crossoriginAttribute: null,
    }
  })

  return {
    installed: true,
    patchedScripts,
  }
}

function readSystemJsRetryState(): SystemJsRetryState {
  const value = (globalThis as typeof globalThis & {
    __FILE_PROTOCOL_STANDALONE_SYSTEMJS_RETRY__?: unknown
  }).__FILE_PROTOCOL_STANDALONE_SYSTEMJS_RETRY__

  if (typeof value !== 'object' || value === null) {
    throw new Error('SystemJS retry hook state is missing.')
  }

  const candidate = value as {
    installed?: unknown
    deletedModuleUrls?: unknown
  }
  assertCondition({
    condition: candidate.installed === true,
    message: 'SystemJS retry hook is not installed.',
  })
  assertCondition({
    condition: Array.isArray(candidate.deletedModuleUrls)
      && candidate.deletedModuleUrls.every((url) => typeof url === 'string'),
    message: 'SystemJS retry hook deletion records are invalid.',
  })

  return {
    installed: true,
    deletedModuleUrls: [...candidate.deletedModuleUrls as string[]],
  }
}

function readOutputScriptShape(): readonly Readonly<{
  id: string | undefined
  type: string | undefined
  src: string | undefined
  crossorigin: string | undefined
}>[] {
  const scripts = Array.from(document.scripts).map((script) => ({
    id: script.id || undefined,
    type: script.getAttribute('type') || undefined,
    src: script.getAttribute('src') || undefined,
    crossorigin: script.getAttribute('crossorigin') || undefined,
  }))
  const executableScripts = scripts.filter((script) => isExecutableScriptType({ type: script.type }))

  assertCondition({
    condition: scripts.every((script) => normalizeScriptType({ type: script.type }) !== 'module'),
    message: 'A native module script remains in standalone output.',
  })
  assertCondition({
    condition: executableScripts.every((script) => script.crossorigin === undefined),
    message: 'An executable standalone script still has crossorigin.',
  })

  return scripts
}

function validateWorkerResult({ result }: { result: StandaloneWorkerVerificationResult }): void {
  const { after, before, deltas } = result
  assertCondition({ condition: deltas.workersCreated === 3, message: `Expected 3 verification Workers; created ${deltas.workersCreated}.` })
  assertCondition({ condition: deltas.workersTerminated === 3, message: `Expected 3 verification Workers to terminate; terminated ${deltas.workersTerminated}.` })
  assertCondition({ condition: deltas.activeWorkers === 0, message: 'Verification changed the number of active Workers.' })
  assertCondition({ condition: after.registryScriptLoads === 1, message: `Expected one worker registry load; observed ${after.registryScriptLoads}.` })
  assertCondition({ condition: after.blobRegistrations === 1, message: `Expected one worker Blob registration; observed ${after.blobRegistrations}.` })
  assertCondition({ condition: after.objectUrlsCreated === 1, message: `Expected one worker object URL; observed ${after.objectUrlsCreated}.` })
  assertCondition({ condition: after.runtimeDigestCalls === 0, message: 'Worker runtime unexpectedly calculated a digest.' })
  assertCondition({ condition: after.sourceStoredAsGlobalString === false, message: 'Worker source is retained as a global string.' })
  assertCondition({ condition: after.registryEntryReleased === true, message: 'Worker registry entry was not released.' })
  assertCondition({ condition: after.registryEntryPresent === false, message: 'Worker registry entry is still present.' })
  assertCondition({ condition: result.concurrent.length === 2, message: 'Concurrent Worker verification did not return two results.' })
  assertCondition({
    condition: [...result.concurrent, result.recreated].every((roundTrip) => roundTrip.htmlLength > 0 && roundTrip.resolvedLanguage.length > 0),
    message: 'A Worker highlight round trip returned an empty result.',
  })
  assertCondition({
    condition: before.activeWorkers === after.activeWorkers,
    message: 'Verification leaked an active Worker.',
  })
}

export async function runStandaloneVerification({
  route,
  tailwindProbe,
  scopedProbe,
  lazyCssProbe,
  loadLazyProbe,
  runWorkerProbe,
}: {
  route: StandaloneVerificationRouteSnapshot
  tailwindProbe: HTMLElement
  scopedProbe: HTMLElement
  lazyCssProbe: HTMLElement
  loadLazyProbe: () => Promise<Readonly<{ marker: string }>>
  runWorkerProbe: () => Promise<StandaloneWorkerVerificationResult>
}): Promise<StandaloneVerificationReport> {
  const startedAt = performance.now()
  const checks: StandaloneVerificationCheck[] = []

  async function check({
    id,
    category,
    action,
  }: {
    id: string
    category: StandaloneVerificationCheck['category']
    action: () => unknown | Promise<unknown>
  }): Promise<void> {
    const checkStartedAt = performance.now()
    try {
      const details = await action()
      checks.push({
        id,
        category,
        status: 'pass',
        durationMs: performance.now() - checkStartedAt,
        details,
        error: undefined,
      })
    } catch (error) {
      checks.push({
        id,
        category,
        status: 'fail',
        durationMs: performance.now() - checkStartedAt,
        details: undefined,
        error: toErrorMessage({ error }),
      })
    }
  }

  await check({
    id: 'environment.file-protocol',
    category: 'environment',
    action: () => {
      assertCondition({ condition: location.protocol === 'file:', message: `Expected file: protocol; received ${location.protocol}.` })
      return { href: location.href, origin: location.origin }
    },
  })

  await check({
    id: 'startup.app-mounted',
    category: 'startup',
    action: () => {
      const app = document.querySelector('#app')
      assertCondition({ condition: app !== null, message: 'The #app element is missing.' })
      assertCondition({ condition: app?.childElementCount !== 0, message: 'The Vue application is not mounted.' })
      return { readyState: document.readyState, appChildElementCount: app?.childElementCount ?? 0 }
    },
  })

  await check({
    id: 'router.current-route',
    category: 'router',
    action: () => {
      assertCondition({ condition: route.fullPath.startsWith('/'), message: `Current route is invalid: ${route.fullPath}` })
      assertCondition({ condition: route.resolvedHref.length > 0, message: 'Router did not resolve the current route.' })
      return route
    },
  })

  await check({
    id: 'styles.initial',
    category: 'styles',
    action: () => {
      const bodyStyle = getComputedStyle(document.body)
      const tailwindStyle = getComputedStyle(tailwindProbe)
      const scopedStyle = getComputedStyle(scopedProbe)
      const details = {
        bodyMargin: bodyStyle.margin,
        tailwindWidth: tailwindStyle.width,
        tailwindHeight: tailwindStyle.height,
        scopedBorderLeftWidth: scopedStyle.borderLeftWidth,
      }
      assertCondition({ condition: details.bodyMargin === '0px', message: `Global body margin is ${details.bodyMargin}.` })
      assertCondition({ condition: details.tailwindWidth === '43px', message: `Tailwind width is ${details.tailwindWidth}.` })
      assertCondition({ condition: details.tailwindHeight === '13px', message: `Tailwind height is ${details.tailwindHeight}.` })
      assertCondition({ condition: details.scopedBorderLeftWidth === '7px', message: `Scoped CSS border is ${details.scopedBorderLeftWidth}.` })
      return details
    },
  })

  await check({
    id: 'dynamic-imports.lazy-probe',
    category: 'dynamic-imports',
    action: async () => {
      const loaded = await loadLazyProbe()
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      const outlineWidth = getComputedStyle(lazyCssProbe).outlineWidth
      assertCondition({ condition: loaded.marker === 'standalone-verification-lazy-probe-v1', message: `Unexpected lazy marker: ${loaded.marker}` })
      assertCondition({ condition: outlineWidth === '3px', message: `Lazy CSS outline is ${outlineWidth}.` })
      return { marker: loaded.marker, outlineWidth }
    },
  })

  await check({
    id: 'systemjs.file-patch',
    category: 'systemjs',
    action: () => readSystemJsPatchState(),
  })

  await check({
    id: 'systemjs.retry-hook',
    category: 'systemjs',
    action: () => readSystemJsRetryState(),
  })

  await check({
    id: 'output.classic-script-shape',
    category: 'output',
    action: () => readOutputScriptShape(),
  })

  await check({
    id: 'worker.reusable-blob-url-factory',
    category: 'worker',
    action: async () => {
      const result = await runWorkerProbe()
      validateWorkerResult({ result })
      return result
    },
  })

  const failed = checks.filter((item) => item.status === 'fail').length
  const systemJsPatch = (globalThis as typeof globalThis & {
    __FILE_PROTOCOL_STANDALONE_SYSTEMJS_PATCH__?: unknown
  }).__FILE_PROTOCOL_STANDALONE_SYSTEMJS_PATCH__
  const systemJsRetry = (globalThis as typeof globalThis & {
    __FILE_PROTOCOL_STANDALONE_SYSTEMJS_RETRY__?: unknown
  }).__FILE_PROTOCOL_STANDALONE_SYSTEMJS_RETRY__
  const workerRuntime = (globalThis as typeof globalThis & {
    __FILE_PROTOCOL_STANDALONE_WORKER_RUNTIME__?: Record<string, unknown>
  }).__FILE_PROTOCOL_STANDALONE_WORKER_RUNTIME__

  return {
    format: 'naidan-standalone-verification-v1',
    generatedAt: new Date().toISOString(),
    status: failed === 0 ? 'pass' : 'fail',
    summary: {
      passed: checks.length - failed,
      failed,
      durationMs: performance.now() - startedAt,
    },
    environment: {
      href: location.href,
      protocol: location.protocol,
      origin: location.origin,
      userAgent: navigator.userAgent,
      readyState: document.readyState,
      performanceMemory: readPerformanceMemory(),
    },
    checks,
    runtime: {
      startup: (globalThis as typeof globalThis & {
        __FILE_PROTOCOL_STANDALONE_STARTUP__?: unknown
      }).__FILE_PROTOCOL_STANDALONE_STARTUP__,
      systemJsPatch: systemJsPatch ?? undefined,
      systemJsRetry: systemJsRetry ?? undefined,
      worker: workerRuntime ?? undefined,
      resourceEntries: performance.getEntriesByType('resource').map((entry) => {
        const resource = entry as PerformanceResourceTiming
        return {
          name: resource.name,
          duration: resource.duration,
          initiatorType: resource.initiatorType,
        }
      }),
    },
  }
}
