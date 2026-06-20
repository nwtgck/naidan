import * as Comlink from 'comlink'

import {
  createFileProtocolCompatibleStandaloneWorkerHub,
  getFileProtocolCompatibleStandaloneWorkerHubDiagnostics,
} from '@/services/worker-hub-standalone-loader'
import type { IWorkerHub } from '@/services/worker-hub.types'
import type { FileProtocolWorkerDiagnostics } from 'virtual:file-protocol-standalone/worker/file-protocol-compatible-standalone-worker-hub'

export type StandaloneWorkerRoundTripResult = Readonly<{
  resolvedLanguage: string
  htmlLength: number
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
}: {
  createWorker: () => Promise<Worker>
  readDiagnostics: () => FileProtocolWorkerDiagnostics
  runRoundTrip: ({ worker, source }: { worker: Worker, source: string }) => Promise<StandaloneWorkerRoundTripResult>
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
  const recreated = await runRoundTripAndTerminate({
    worker: recreatedWorker,
    source: '{"probe":"recreated-after-terminate"}',
    runRoundTrip,
  })
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
  })
}
