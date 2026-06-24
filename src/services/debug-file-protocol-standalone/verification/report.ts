import { FILE_PROTOCOL_STANDALONE_EXECUTABLE_ELEMENT_IDS } from '@/file-protocol-standalone-protocol'
import type { DebugFileProtocolStandaloneWorkerVerificationResult } from './worker-probe'

export type DebugFileProtocolStandaloneVerificationStatus = 'pass' | 'fail'

export type DebugFileProtocolStandaloneVerificationCheck = Readonly<{
  id: string
  category: 'environment' | 'startup' | 'router' | 'styles' | 'dynamic-imports' | 'systemjs' | 'output' | 'worker'
  status: DebugFileProtocolStandaloneVerificationStatus
  durationMs: number
  details: unknown | undefined
  error: string | undefined
}>

export type DebugFileProtocolStandaloneVerificationRouteSnapshot = Readonly<{
  fullPath: string
  name: string | undefined
  matchedPaths: readonly string[]
  resolvedHref: string
}>

export type DebugFileProtocolStandaloneVerificationRouteTransition = Readonly<{
  beforePath: string
  transitionedPath: string
  restoredPath: string
}>

export type DebugFileProtocolStandaloneVerificationReport = Readonly<{
  format: 'naidan-standalone-verification-v1'
  generatedAt: string
  status: DebugFileProtocolStandaloneVerificationStatus
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
  checks: readonly DebugFileProtocolStandaloneVerificationCheck[]
  runtime: Readonly<{
    pluginDiagnostics: unknown
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
  installed: true
  patchedScripts: readonly SystemJsPatchRecord[]
}>

type SystemJsRetryState = Readonly<{
  installed: true
  physicalScriptLoadFailureUrls: readonly string[]
  deletedModuleUrls: readonly string[]
  retryableErrorCount: number
  nonRetryableErrorCount: number
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


function debugCloneFileProtocolStandaloneVerificationValue<Value>({ value }: { value: Value }): Value {
  if (value === undefined) return value
  if (typeof structuredClone === 'function') {
    return structuredClone(value)
  }
  return JSON.parse(JSON.stringify(value)) as Value
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

function readSystemJsPatchState({ value }: { value: unknown }): SystemJsPatchState {
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

function readSystemJsRetryState({ value }: { value: unknown }): SystemJsRetryState {
  if (typeof value !== 'object' || value === null) {
    throw new Error('SystemJS retry hook state is missing.')
  }

  const candidate = value as {
    installed?: unknown
    physicalScriptLoadFailureUrls?: unknown
    deletedModuleUrls?: unknown
    retryableErrorCount?: unknown
    nonRetryableErrorCount?: unknown
  }
  assertCondition({
    condition: candidate.installed === true,
    message: 'SystemJS retry hook is not installed.',
  })
  for (const [field, fieldValue] of [
    ['physicalScriptLoadFailureUrls', candidate.physicalScriptLoadFailureUrls],
    ['deletedModuleUrls', candidate.deletedModuleUrls],
  ] as const) {
    assertCondition({
      condition: Array.isArray(fieldValue) && fieldValue.every((url) => typeof url === 'string'),
      message: `SystemJS retry hook ${field} records are invalid.`,
    })
  }
  assertCondition({
    condition: Number.isSafeInteger(candidate.retryableErrorCount) && Number(candidate.retryableErrorCount) >= 0,
    message: 'SystemJS retryable error count is invalid.',
  })
  assertCondition({
    condition: Number.isSafeInteger(candidate.nonRetryableErrorCount) && Number(candidate.nonRetryableErrorCount) >= 0,
    message: 'SystemJS non-retryable error count is invalid.',
  })

  return {
    installed: true,
    physicalScriptLoadFailureUrls: [...candidate.physicalScriptLoadFailureUrls as string[]],
    deletedModuleUrls: [...candidate.deletedModuleUrls as string[]],
    retryableErrorCount: candidate.retryableErrorCount as number,
    nonRetryableErrorCount: candidate.nonRetryableErrorCount as number,
  }
}

function debugValidateAndReadFileProtocolStandaloneOutputScripts(): readonly Readonly<{
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
  const expectedExecutableIds = FILE_PROTOCOL_STANDALONE_EXECUTABLE_ELEMENT_IDS

  assertCondition({
    condition: scripts.every((script) => normalizeScriptType({ type: script.type }) !== 'module'),
    message: 'A native module script remains in standalone output.',
  })
  assertCondition({
    condition: executableScripts.every((script) => script.crossorigin === undefined),
    message: 'An executable standalone script still has crossorigin.',
  })
  assertCondition({
    condition: JSON.stringify(executableScripts.map((script) => script.id)) === JSON.stringify(expectedExecutableIds),
    message: 'Standalone executable scripts are missing or out of order.',
  })

  return scripts
}

function debugAssertValidFileProtocolStandaloneWorkerVerificationResult({ result }: { result: DebugFileProtocolStandaloneWorkerVerificationResult }): void {
  const { diagnosticsAfter, diagnosticsBefore, diagnosticDeltas } = result
  assertCondition({ condition: diagnosticDeltas.workersCreated === 3, message: `Expected 3 verification Workers; created ${diagnosticDeltas.workersCreated}.` })
  assertCondition({ condition: diagnosticDeltas.workersTerminated === 3, message: `Expected 3 verification Workers to terminate; terminated ${diagnosticDeltas.workersTerminated}.` })
  assertCondition({ condition: diagnosticDeltas.activeWorkers === 0, message: 'Verification changed the number of active Workers.' })
  assertCondition({ condition: diagnosticsAfter.registryScriptLoads === 1, message: `Expected one worker registry load; observed ${diagnosticsAfter.registryScriptLoads}.` })
  assertCondition({ condition: diagnosticsAfter.blobRegistrations === 1, message: `Expected one worker Blob registration; observed ${diagnosticsAfter.blobRegistrations}.` })
  assertCondition({ condition: diagnosticsAfter.objectUrlsCreated === 1, message: `Expected one worker object URL; observed ${diagnosticsAfter.objectUrlsCreated}.` })
  assertCondition({ condition: diagnosticsAfter.runtimeDigestCalls === 0, message: 'Worker runtime unexpectedly calculated a digest.' })
  assertCondition({ condition: diagnosticsAfter.sourceStoredAsGlobalString === false, message: 'Worker source is retained as a global string.' })
  assertCondition({ condition: diagnosticsAfter.registryEntryReleased === true, message: 'Worker registry entry was not released.' })
  assertCondition({ condition: diagnosticsAfter.registryEntryPresent === false, message: 'Worker registry entry is still present.' })
  assertCondition({ condition: result.concurrentHighlights.length === 2, message: 'Concurrent Worker verification did not return two results.' })
  assertCondition({
    condition: [...result.concurrentHighlights, result.recreatedWorkerHighlight].every((roundTrip) => roundTrip.htmlLength > 0 && roundTrip.resolvedLanguage.length > 0),
    message: 'A Worker highlight round trip returned an empty result.',
  })
  assertCondition({
    condition: result.weshFileProbe.exitCode === 0,
    message: `Wesh file verification exited with ${result.weshFileProbe.exitCode}.`,
  })
  assertCondition({
    condition: result.weshFileProbe.stdout === '/bin/sh: text/x-shellscript\n',
    message: `Unexpected Wesh file verification output: ${JSON.stringify(result.weshFileProbe.stdout)}`,
  })
  assertCondition({
    condition: result.weshFileProbe.stderr === '',
    message: `Wesh file verification wrote stderr: ${result.weshFileProbe.stderr}`,
  })
  assertCondition({
    condition: diagnosticsBefore.activeWorkers === diagnosticsAfter.activeWorkers,
    message: 'Verification leaked an active Worker.',
  })
}

async function waitForStyleApplication({ signal }: { signal: AbortSignal }): Promise<void> {
  if (typeof requestAnimationFrame === 'function') {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    signal.throwIfAborted()
    return
  }
  await Promise.resolve()
  signal.throwIfAborted()
}

function debugReadFileProtocolStandalonePluginDiagnostics(): DebugFileProtocolStandaloneGlobalDiagnostics {
  const diagnostics = globalThis.__FILE_PROTOCOL_STANDALONE__
  if (diagnostics === undefined || typeof diagnostics.getDiagnostics !== 'function') {
    throw new Error('The standalone global diagnostics API is missing.')
  }
  return diagnostics.getDiagnostics()
}


async function debugWaitForVerificationCheckUntilDeadline<Result>({
  id,
  timeoutMs,
  action,
}: {
  id: string
  timeoutMs: number
  action: ({ signal }: { signal: AbortSignal }) => Result | Promise<Result>
}): Promise<Result> {
  const controller = new AbortController()
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(`Standalone verification check "${id}" timed out after ${timeoutMs} ms.`)
      controller.abort(error)
      reject(error)
    }, timeoutMs)
  })
  try {
    return await Promise.race([
      Promise.resolve().then(() => action({ signal: controller.signal })),
      timeout,
    ])
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}

export async function debugRunFileProtocolStandaloneVerification({
  route,
  tailwindStyleProbeElement,
  scopedStyleProbeElement,
  lazyStyleProbeElement,
  lazyStyleInitialOutlineWidth,
  debugLoadFileProtocolStandaloneLazyStyleProbeModule,
  debugExerciseFileProtocolStandaloneRouteRoundTrip,
  debugRunWorkerProbe,
  checkTimeoutMs,
}: {
  route: DebugFileProtocolStandaloneVerificationRouteSnapshot
  tailwindStyleProbeElement: HTMLElement
  scopedStyleProbeElement: HTMLElement
  lazyStyleProbeElement: HTMLElement
  lazyStyleInitialOutlineWidth: string
  debugLoadFileProtocolStandaloneLazyStyleProbeModule: ({ signal }: { signal: AbortSignal }) => Promise<Readonly<{ marker: string }>>
  debugExerciseFileProtocolStandaloneRouteRoundTrip: ({ signal }: { signal: AbortSignal }) => Promise<DebugFileProtocolStandaloneVerificationRouteTransition>
  debugRunWorkerProbe: ({ signal }: { signal: AbortSignal }) => Promise<DebugFileProtocolStandaloneWorkerVerificationResult>
  checkTimeoutMs: number
}): Promise<DebugFileProtocolStandaloneVerificationReport> {
  const startedAt = performance.now()
  const checks: DebugFileProtocolStandaloneVerificationCheck[] = []
  let pluginDiagnosticsReadResult:
    | Readonly<{ status: 'fulfilled'; value: DebugFileProtocolStandaloneGlobalDiagnostics }>
    | Readonly<{ status: 'rejected'; reason: unknown }>
    | undefined

  function getPluginDiagnosticsSnapshot(): DebugFileProtocolStandaloneGlobalDiagnostics {
    if (pluginDiagnosticsReadResult === undefined) {
      try {
        pluginDiagnosticsReadResult = {
          status: 'fulfilled',
          value: debugCloneFileProtocolStandaloneVerificationValue({ value: debugReadFileProtocolStandalonePluginDiagnostics() }),
        }
      } catch (reason) {
        pluginDiagnosticsReadResult = { status: 'rejected', reason }
      }
    }

    switch (pluginDiagnosticsReadResult.status) {
    case 'fulfilled':
      return pluginDiagnosticsReadResult.value
    case 'rejected':
      throw pluginDiagnosticsReadResult.reason
    default: {
      const _ex: never = pluginDiagnosticsReadResult
      throw new Error(`Unhandled diagnostics read result: ${String(_ex)}`)
    }
    }
  }

  async function check({
    id,
    category,
    action,
  }: {
    id: string
    category: DebugFileProtocolStandaloneVerificationCheck['category']
    action: ({ signal }: { signal: AbortSignal }) => unknown | Promise<unknown>
  }): Promise<void> {
    const checkStartedAt = performance.now()
    try {
      const details = debugCloneFileProtocolStandaloneVerificationValue({
        value: await debugWaitForVerificationCheckUntilDeadline({
          id,
          timeoutMs: checkTimeoutMs,
          action,
        }),
      })
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
      const startup = getPluginDiagnosticsSnapshot().startup
      assertCondition({
        condition: startup?.checkpoint === 'mounted',
        message: `Startup checkpoint is ${String(startup?.checkpoint)} instead of mounted.`,
      })
      return {
        readyState: document.readyState,
        appChildElementCount: app?.childElementCount ?? 0,
        startup,
      }
    },
  })

  await check({
    id: 'router.current-route',
    category: 'router',
    action: () => {
      assertCondition({ condition: route.fullPath.startsWith('/standalone-verification'), message: `Current route is invalid: ${route.fullPath}` })
      assertCondition({ condition: route.resolvedHref.length > 0, message: 'Router did not resolve the current route.' })
      assertCondition({ condition: route.matchedPaths.includes('/standalone-verification'), message: 'Verification route is not matched.' })
      return route
    },
  })

  await check({
    id: 'router.query-transition',
    category: 'router',
    action: async ({ signal }) => {
      const transition = await debugExerciseFileProtocolStandaloneRouteRoundTrip({ signal })
      assertCondition({ condition: transition.transitionedPath !== transition.beforePath, message: 'Router transition did not change the route.' })
      assertCondition({ condition: transition.restoredPath === transition.beforePath, message: 'Router transition did not restore the original route.' })
      return transition
    },
  })

  await check({
    id: 'styles.initial',
    category: 'styles',
    action: () => {
      const bodyStyle = getComputedStyle(document.body)
      const tailwindStyle = getComputedStyle(tailwindStyleProbeElement)
      const scopedStyle = getComputedStyle(scopedStyleProbeElement)
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
    id: 'styles.lazy-before-import',
    category: 'styles',
    action: () => {
      assertCondition({
        condition: lazyStyleInitialOutlineWidth !== '3px',
        message: 'Lazy CSS was already applied before its first dynamic import.',
      })
      return { outlineWidth: lazyStyleInitialOutlineWidth }
    },
  })

  await check({
    id: 'dynamic-imports.lazy-style-probe',
    category: 'dynamic-imports',
    action: async ({ signal }) => {
      const loaded = await debugLoadFileProtocolStandaloneLazyStyleProbeModule({ signal })
      await waitForStyleApplication({ signal })
      const outlineWidth = getComputedStyle(lazyStyleProbeElement).outlineWidth
      assertCondition({
        condition: loaded.marker === 'standalone-verification-lazy-style-probe-v1',
        message: `Unexpected lazy marker: ${loaded.marker}`,
      })
      assertCondition({ condition: outlineWidth === '3px', message: `Lazy CSS outline is ${outlineWidth}.` })
      return { marker: loaded.marker, outlineWidth }
    },
  })

  await check({
    id: 'systemjs.global-diagnostics',
    category: 'systemjs',
    action: () => getPluginDiagnosticsSnapshot(),
  })

  await check({
    id: 'systemjs.file-patch',
    category: 'systemjs',
    action: () => readSystemJsPatchState({ value: getPluginDiagnosticsSnapshot().systemJsPatch }),
  })

  await check({
    id: 'systemjs.retry-hook',
    category: 'systemjs',
    action: () => readSystemJsRetryState({ value: getPluginDiagnosticsSnapshot().systemJsRetry }),
  })

  await check({
    id: 'output.classic-script-shape',
    category: 'output',
    action: () => debugValidateAndReadFileProtocolStandaloneOutputScripts(),
  })

  await check({
    id: 'worker.reusable-blob-url-factory',
    category: 'worker',
    action: async ({ signal }) => {
      signal.throwIfAborted()
      const result = await debugRunWorkerProbe({ signal })
      signal.throwIfAborted()
      debugAssertValidFileProtocolStandaloneWorkerVerificationResult({ result })
      return result
    },
  })

  const failed = checks.filter((item) => item.status === 'fail').length
  const resolvedPluginDiagnostics = (() => {
    if (pluginDiagnosticsReadResult === undefined) return undefined
    switch (pluginDiagnosticsReadResult.status) {
    case 'fulfilled':
      return pluginDiagnosticsReadResult.value
    case 'rejected':
      return undefined
    default: {
      const _ex: never = pluginDiagnosticsReadResult
      throw new Error(`Unhandled diagnostics read result: ${String(_ex)}`)
    }
    }
  })()

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
      pluginDiagnostics: debugCloneFileProtocolStandaloneVerificationValue({ value: resolvedPluginDiagnostics }),
      startup: debugCloneFileProtocolStandaloneVerificationValue({ value: resolvedPluginDiagnostics?.startup }),
      systemJsPatch: debugCloneFileProtocolStandaloneVerificationValue({ value: resolvedPluginDiagnostics?.systemJsPatch }),
      systemJsRetry: debugCloneFileProtocolStandaloneVerificationValue({ value: resolvedPluginDiagnostics?.systemJsRetry }),
      worker: debugCloneFileProtocolStandaloneVerificationValue({ value: resolvedPluginDiagnostics?.workerRuntime }),
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

export function debugSerializeFileProtocolStandaloneVerificationReportForCopy({
  report,
}: {
  report: DebugFileProtocolStandaloneVerificationReport
}): string {
  let standaloneRoot: string | undefined
  try {
    if (report.environment.protocol === 'file:') {
      standaloneRoot = new URL('./', report.environment.href).href
    }
  } catch {
    standaloneRoot = undefined
  }

  return JSON.stringify(report, (_key, value: unknown) => {
    if (standaloneRoot !== undefined && typeof value === 'string') {
      return value.replaceAll(standaloneRoot, '<standalone-root>/')
    }
    return value
  }, 2)
}
