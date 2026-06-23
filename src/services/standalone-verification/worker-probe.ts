import * as Comlink from 'comlink'

import {
  createFileProtocolCompatibleStandaloneWorkerHub,
  getFileProtocolCompatibleStandaloneWorkerHubDiagnostics,
} from '@/services/worker-hub-standalone-loader'
import type { IWorkerHub } from '@/services/worker-hub.types'
import type { WeshWorkerRemoteExecutionEvent } from '@/services/wesh/worker/types'
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

async function runHighlightRoundTrip({ worker, source }: {
  worker: Worker
  source: string
}): Promise<StandaloneWorkerRoundTripResult> {
  const remote = Comlink.wrap<IWorkerHub>(worker)

  try {
    const highlight = await remote.highlight
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
  } finally {
    await remote[Comlink.releaseProxy]()
  }
}

async function runWeshFileProbe({ worker }: {
  worker: Worker
}): Promise<StandaloneWeshFileProbeResult> {
  const remote = Comlink.wrap<IWorkerHub>(worker)

  try {
    const wesh = await remote.wesh
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

    const stdout: string[] = []
    const stderr: string[] = []
    const decoder = new TextDecoder()
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

    try {
      const summary = await wesh.awaitExecution({
        request: { executionId: started.executionId },
      })
      return {
        exitCode: summary.exitCode,
        stdout: stdout.join(''),
        stderr: stderr.join(''),
      }
    } finally {
      await wesh.disposeExecution({
        request: { executionId: started.executionId },
      })
      await wesh.dispose()
    }
  } finally {
    await remote[Comlink.releaseProxy]()
  }
}

async function runRoundTripAndTerminate({
  worker,
  source,
  runRoundTrip,
}: {
  worker: Worker
  source: string
  runRoundTrip: ({ worker, source }: { worker: Worker, source: string }) => Promise<StandaloneWorkerRoundTripResult>
}): Promise<StandaloneWorkerRoundTripResult> {
  try {
    return await runRoundTrip({ worker, source })
  } finally {
    // Worker instances are disposable, but the page-lifetime Blob URL is shared.
    // Always terminate instances here so a failed diagnostic cannot leak a realm.
    worker.terminate()
  }
}

async function createConcurrentWorkers({
  createWorker,
}: {
  createWorker: () => Promise<Worker>
}): Promise<readonly [Worker, Worker]> {
  const [first, second] = await Promise.allSettled([
    createWorker(),
    createWorker(),
  ])

  switch (first.status) {
  case 'fulfilled': {
    switch (second.status) {
    case 'fulfilled':
      return [first.value, second.value]
    case 'rejected':
      // A sibling creation can fail after another Worker has already started.
      // Terminate every fulfilled instance before preserving the original error.
      first.value.terminate()
      throw second.reason
    default: {
      const _ex: never = second
      throw new Error(`Unhandled second Worker creation result: ${String(_ex)}`)
    }
    }
  }
  case 'rejected': {
    switch (second.status) {
    case 'fulfilled':
      second.value.terminate()
      throw first.reason
    case 'rejected':
      throw first.reason
    default: {
      const _ex: never = second
      throw new Error(`Unhandled second Worker creation result: ${String(_ex)}`)
    }
    }
  }
  default: {
    const _ex: never = first
    throw new Error(`Unhandled first Worker creation result: ${String(_ex)}`)
  }
  }
}

export async function runStandaloneWorkerFactoryVerificationWithDependencies({
  createWorker,
  readDiagnostics,
  runRoundTrip,
  runFileProbe,
}: {
  createWorker: () => Promise<Worker>
  readDiagnostics: () => FileProtocolWorkerDiagnostics
  runRoundTrip: ({ worker, source }: { worker: Worker, source: string }) => Promise<StandaloneWorkerRoundTripResult>
  runFileProbe: ({ worker }: { worker: Worker }) => Promise<StandaloneWeshFileProbeResult>
}): Promise<StandaloneWorkerVerificationResult> {
  const before = readDiagnostics()
  const concurrentWorkers = await createConcurrentWorkers({ createWorker })
  const concurrent = await Promise.all([
    runRoundTripAndTerminate({
      worker: concurrentWorkers[0],
      source: '{"probe":"concurrent-a"}',
      runRoundTrip,
    }),
    runRoundTripAndTerminate({
      worker: concurrentWorkers[1],
      source: '{"probe":"concurrent-b"}',
      runRoundTrip,
    }),
  ])

  const recreatedWorker = await createWorker()
  let recreated: StandaloneWorkerRoundTripResult
  let weshFileProbe: StandaloneWeshFileProbeResult
  try {
    recreated = await runRoundTrip({
      worker: recreatedWorker,
      source: '{"probe":"recreated-after-terminate"}',
    })
    weshFileProbe = await runFileProbe({ worker: recreatedWorker })
  } finally {
    recreatedWorker.terminate()
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
 * Create isolated Worker instances from the same page-lifetime Blob URL. The
 * highlight operation is read-only and exercises the real Comlink hub without
 * creating chats, sessions, files, or persistent application state.
 */
export async function runStandaloneWorkerFactoryVerification(): Promise<StandaloneWorkerVerificationResult> {
  return runStandaloneWorkerFactoryVerificationWithDependencies({
    createWorker: createFileProtocolCompatibleStandaloneWorkerHub,
    readDiagnostics: getFileProtocolCompatibleStandaloneWorkerHubDiagnostics,
    runRoundTrip: runHighlightRoundTrip,
    runFileProbe: runWeshFileProbe,
  })
}
