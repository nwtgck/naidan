import * as Comlink from 'comlink'

import {
  createFileProtocolCompatibleStandaloneWorkerHub,
  getFileProtocolCompatibleStandaloneWorkerHubDiagnostics,
} from '@/services/worker-hub-standalone-loader'
import type { IWorkerHub } from '@/services/worker-hub.types'
import type {
  IWeshWorker,
  WeshWorkerRemoteExecutionEvent,
} from '@/services/wesh/worker/types'
import type { FileProtocolWorkerDiagnostics } from 'virtual:file-protocol-standalone/worker/file-protocol-compatible-standalone-worker-hub'

export type StandaloneWorkerRoundTripResult = Readonly<{
  resolvedLanguage: string
  htmlLength: number
}>

export type StandaloneWeshFileProbeResult = Readonly<{
  exitCode: number
  stdout: string
  stderr: string
}>

export type StandaloneWorkerVerificationResult = Readonly<{
  before: FileProtocolWorkerDiagnostics
  after: FileProtocolWorkerDiagnostics
  deltas: Readonly<{
    workersCreated: number
    workersTerminated: number
    activeWorkers: number
    registryScriptLoads: number
    blobRegistrations: number
    objectUrlsCreated: number
  }>
  concurrent: readonly StandaloneWorkerRoundTripResult[]
  recreated: StandaloneWorkerRoundTripResult
  weshFileProbe: StandaloneWeshFileProbeResult
}>

export type StandaloneWorkerHubSession = Readonly<{
  worker: Worker
  remote: Comlink.Remote<IWorkerHub>
}>

const standaloneWorkerProbeOperationTimeoutMs = 30_000
const standaloneWorkerProbeCleanupTimeoutMs = 5_000

async function runWithTimeout<Result>({
  label,
  timeoutMs,
  action,
}: {
  label: string
  timeoutMs: number
  action: () => Promise<Result>
}): Promise<Result> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs} ms.`))
    }, timeoutMs)
  })

  try {
    return await Promise.race([action(), timeout])
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId)
    }
  }
}

async function createStandaloneWorkerHubSession(): Promise<StandaloneWorkerHubSession> {
  const worker = await createFileProtocolCompatibleStandaloneWorkerHub()
  try {
    return {
      worker,
      remote: Comlink.wrap<IWorkerHub>(worker),
    }
  } catch (error) {
    worker.terminate()
    throw error
  }
}

/** @internal Exported for Comlink lifecycle regression tests. */
export async function releaseStandaloneWorkerHubSession({ session }: {
  session: StandaloneWorkerHubSession
}): Promise<void> {
  let releaseError: unknown | undefined
  try {
    await runWithTimeout({
      label: 'Standalone Worker Comlink proxy release',
      timeoutMs: standaloneWorkerProbeCleanupTimeoutMs,
      action: async () => {
        await session.remote[Comlink.releaseProxy]()
      },
    })
  } catch (error) {
    releaseError = error
  } finally {
    // terminate() is idempotent in the standalone Worker wrapper. Always call it
    // even when a released or unresponsive Comlink endpoint never acknowledges.
    session.worker.terminate()
  }
  if (releaseError !== undefined) {
    throw releaseError
  }
}

/** @internal Exported for Comlink lifecycle regression tests. */
export async function runHighlightRoundTrip({ session, source }: {
  session: StandaloneWorkerHubSession
  source: string
}): Promise<StandaloneWorkerRoundTripResult> {
  const highlight = await session.remote.highlight
  const result = await highlight.highlight({
    request: {
      code: source,
      language: 'json',
      mode: 'named-language',
    },
  })

  return {
    resolvedLanguage: result.resolvedLanguage,
    htmlLength: result.html.length,
  }
}

/** @internal Exported for Wesh lifecycle regression tests. */
export async function runStandaloneWeshFileProbeWithRemote({ wesh }: {
  wesh: Comlink.Remote<IWeshWorker>
}): Promise<StandaloneWeshFileProbeResult> {
  const stdout: string[] = []
  const stderr: string[] = []
  const decoder = new TextDecoder()
  let executionId: string | undefined
  let result: StandaloneWeshFileProbeResult | undefined
  let operationError: unknown | undefined

  try {
    await wesh.init({
      // The built-in /bin/sh special file is readable from an otherwise empty,
      // immutable root. This exercises Wesh's real file classification path,
      // including file-type, without creating files or touching user storage.
      rootHandle: 'readonly',
      mounts: [],
      user: 'standalone-verification',
      initialEnv: {},
      initialCwd: '/',
    })

    const started = await wesh.startExecution(
      { script: 'file --mime-type /bin/sh' },
      Comlink.proxy((event: WeshWorkerRemoteExecutionEvent) => {
        switch (event.type) {
        case 'started':
        case 'exit':
          return
        case 'stdout':
          stdout.push(decoder.decode(event.buffer))
          return
        case 'stderr':
          stderr.push(decoder.decode(event.buffer))
          return
        case 'error':
          throw new Error(event.message)
        default: {
          const _ex: never = event
          throw new Error(`Unhandled Wesh verification event: ${String(_ex)}`)
        }
        }
      }),
    )
    executionId = started.executionId
    const summary = await wesh.awaitExecution({
      request: { executionId },
    })
    result = {
      exitCode: summary.exitCode,
      stdout: stdout.join(''),
      stderr: stderr.join(''),
    }
  } catch (error) {
    operationError = error
  }

  let cleanupError: unknown | undefined
  if (executionId !== undefined) {
    try {
      await wesh.disposeExecution({
        request: { executionId },
      })
    } catch (error) {
      cleanupError = error
    }
  }
  try {
    await wesh.dispose()
  } catch (error) {
    cleanupError ??= error
  }

  if (operationError !== undefined) {
    throw operationError
  }
  if (cleanupError !== undefined) {
    throw cleanupError
  }
  if (result === undefined) {
    throw new Error('Standalone Wesh file probe produced no result.')
  }
  return result
}

/** @internal Exported for Comlink lifecycle regression tests. */
export async function runWeshFileProbe({ session }: {
  session: StandaloneWorkerHubSession
}): Promise<StandaloneWeshFileProbeResult> {
  const wesh = await session.remote.wesh as unknown as Comlink.Remote<IWeshWorker>
  return runStandaloneWeshFileProbeWithRemote({ wesh })
}

async function releaseSessionWithTimeout({
  session,
  releaseSession,
  timeoutMs,
}: {
  session: StandaloneWorkerHubSession
  releaseSession: ({ session }: { session: StandaloneWorkerHubSession }) => Promise<void>
  timeoutMs: number
}): Promise<void> {
  try {
    await runWithTimeout({
      label: 'Standalone Worker session cleanup',
      timeoutMs,
      action: async () => releaseSession({ session }),
    })
  } catch (error) {
    // A dependency-injected cleanup can itself become permanently pending. Force
    // the physical Worker down so verification never leaks a live realm.
    session.worker.terminate()
    throw error
  }
}

async function createConcurrentSessions({
  createSession,
  releaseSession,
  cleanupTimeoutMs,
}: {
  createSession: () => Promise<StandaloneWorkerHubSession>
  releaseSession: ({ session }: { session: StandaloneWorkerHubSession }) => Promise<void>
  cleanupTimeoutMs: number
}): Promise<readonly [StandaloneWorkerHubSession, StandaloneWorkerHubSession]> {
  const [first, second] = await Promise.allSettled([
    createSession(),
    createSession(),
  ])

  switch (first.status) {
  case 'fulfilled': {
    switch (second.status) {
    case 'fulfilled':
      return [first.value, second.value]
    case 'rejected':
      try {
        await releaseSessionWithTimeout({
          session: first.value,
          releaseSession,
          timeoutMs: cleanupTimeoutMs,
        })
      } catch {
        // Preserve the Worker creation failure as the primary diagnostic.
      }
      throw second.reason
    default: {
      const _ex: never = second
      throw new Error(`Unhandled second Worker session creation result: ${String(_ex)}`)
    }
    }
  }
  case 'rejected': {
    switch (second.status) {
    case 'fulfilled':
      try {
        await releaseSessionWithTimeout({
          session: second.value,
          releaseSession,
          timeoutMs: cleanupTimeoutMs,
        })
      } catch {
        // Preserve the Worker creation failure as the primary diagnostic.
      }
      throw first.reason
    case 'rejected':
      throw first.reason
    default: {
      const _ex: never = second
      throw new Error(`Unhandled second Worker session creation result: ${String(_ex)}`)
    }
    }
  }
  default: {
    const _ex: never = first
    throw new Error(`Unhandled first Worker session creation result: ${String(_ex)}`)
  }
  }
}

async function runRoundTripAndRelease({
  session,
  source,
  runRoundTrip,
  releaseSession,
  operationTimeoutMs,
  cleanupTimeoutMs,
}: {
  session: StandaloneWorkerHubSession
  source: string
  runRoundTrip: ({ session, source }: {
    session: StandaloneWorkerHubSession
    source: string
  }) => Promise<StandaloneWorkerRoundTripResult>
  releaseSession: ({ session }: { session: StandaloneWorkerHubSession }) => Promise<void>
  operationTimeoutMs: number
  cleanupTimeoutMs: number
}): Promise<StandaloneWorkerRoundTripResult> {
  let result: StandaloneWorkerRoundTripResult | undefined
  let operationError: unknown | undefined
  try {
    result = await runWithTimeout({
      label: 'Standalone Worker highlight probe',
      timeoutMs: operationTimeoutMs,
      action: async () => runRoundTrip({ session, source }),
    })
  } catch (error) {
    operationError = error
  }

  let cleanupError: unknown | undefined
  try {
    await releaseSessionWithTimeout({
      session,
      releaseSession,
      timeoutMs: cleanupTimeoutMs,
    })
  } catch (error) {
    cleanupError = error
  }

  if (operationError !== undefined) {
    throw operationError
  }
  if (cleanupError !== undefined) {
    throw cleanupError
  }
  if (result === undefined) {
    throw new Error('Standalone Worker highlight probe produced no result.')
  }
  return result
}

export async function runStandaloneWorkerFactoryVerificationWithDependencies({
  createSession,
  readDiagnostics,
  runRoundTrip,
  runFileProbe,
  releaseSession,
  operationTimeoutMs,
  cleanupTimeoutMs,
}: {
  createSession: () => Promise<StandaloneWorkerHubSession>
  readDiagnostics: () => FileProtocolWorkerDiagnostics
  runRoundTrip: ({ session, source }: {
    session: StandaloneWorkerHubSession
    source: string
  }) => Promise<StandaloneWorkerRoundTripResult>
  runFileProbe: ({ session }: {
    session: StandaloneWorkerHubSession
  }) => Promise<StandaloneWeshFileProbeResult>
  releaseSession: ({ session }: { session: StandaloneWorkerHubSession }) => Promise<void>
  operationTimeoutMs: number
  cleanupTimeoutMs: number
}): Promise<StandaloneWorkerVerificationResult> {
  const before = readDiagnostics()
  const concurrentSessions = await createConcurrentSessions({
    createSession,
    releaseSession,
    cleanupTimeoutMs,
  })
  const concurrentOutcomes = await Promise.allSettled([
    runRoundTripAndRelease({
      session: concurrentSessions[0],
      source: '{"probe":"concurrent-a"}',
      runRoundTrip,
      releaseSession,
      operationTimeoutMs,
      cleanupTimeoutMs,
    }),
    runRoundTripAndRelease({
      session: concurrentSessions[1],
      source: '{"probe":"concurrent-b"}',
      runRoundTrip,
      releaseSession,
      operationTimeoutMs,
      cleanupTimeoutMs,
    }),
  ])

  for (const outcome of concurrentOutcomes) {
    switch (outcome.status) {
    case 'fulfilled':
      break
    case 'rejected':
      throw outcome.reason
    default: {
      const _ex: never = outcome
      throw new Error(`Unhandled concurrent Worker probe result: ${String(_ex)}`)
    }
    }
  }

  const concurrent = concurrentOutcomes.map((outcome) => {
    switch (outcome.status) {
    case 'fulfilled':
      return outcome.value
    case 'rejected':
      throw outcome.reason
    default: {
      const _ex: never = outcome
      throw new Error(`Unhandled concurrent Worker probe result: ${String(_ex)}`)
    }
    }
  })

  const recreatedSession = await createSession()
  let recreated: StandaloneWorkerRoundTripResult | undefined
  let weshFileProbe: StandaloneWeshFileProbeResult | undefined
  let operationError: unknown | undefined
  try {
    recreated = await runWithTimeout({
      label: 'Recreated standalone Worker highlight probe',
      timeoutMs: operationTimeoutMs,
      action: async () => runRoundTrip({
        session: recreatedSession,
        source: '{"probe":"recreated-after-terminate"}',
      }),
    })
    weshFileProbe = await runWithTimeout({
      label: 'Recreated standalone Worker Wesh file probe',
      timeoutMs: operationTimeoutMs,
      action: async () => runFileProbe({ session: recreatedSession }),
    })
  } catch (error) {
    operationError = error
  }

  let cleanupError: unknown | undefined
  try {
    await releaseSessionWithTimeout({
      session: recreatedSession,
      releaseSession,
      timeoutMs: cleanupTimeoutMs,
    })
  } catch (error) {
    cleanupError = error
  }

  if (operationError !== undefined) {
    throw operationError
  }
  if (cleanupError !== undefined) {
    throw cleanupError
  }
  if (recreated === undefined || weshFileProbe === undefined) {
    throw new Error('Recreated standalone Worker verification produced no result.')
  }

  const after = readDiagnostics()
  return {
    before,
    after,
    deltas: {
      workersCreated: after.workersCreated - before.workersCreated,
      workersTerminated: after.workersTerminated - before.workersTerminated,
      activeWorkers: after.activeWorkers - before.activeWorkers,
      registryScriptLoads: after.registryScriptLoads - before.registryScriptLoads,
      blobRegistrations: after.blobRegistrations - before.blobRegistrations,
      objectUrlsCreated: after.objectUrlsCreated - before.objectUrlsCreated,
    },
    concurrent,
    recreated,
    weshFileProbe,
  }
}

/**
 * Create isolated Worker sessions from the same page-lifetime Blob URL. Each
 * session owns one Comlink root proxy for its full lifetime. The recreated
 * session intentionally runs highlight and Wesh through that same proxy before
 * releasing it, which guards against reusing a Worker after Comlink RELEASE.
 */
export async function runStandaloneWorkerFactoryVerification(): Promise<StandaloneWorkerVerificationResult> {
  return runStandaloneWorkerFactoryVerificationWithDependencies({
    createSession: createStandaloneWorkerHubSession,
    readDiagnostics: getFileProtocolCompatibleStandaloneWorkerHubDiagnostics,
    runRoundTrip: runHighlightRoundTrip,
    runFileProbe: runWeshFileProbe,
    releaseSession: releaseStandaloneWorkerHubSession,
    operationTimeoutMs: standaloneWorkerProbeOperationTimeoutMs,
    cleanupTimeoutMs: standaloneWorkerProbeCleanupTimeoutMs,
  })
}
