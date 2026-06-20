import { describe, expect, it, vi } from 'vitest'

import type { FileProtocolWorkerDiagnostics } from 'virtual:file-protocol-standalone/worker/file-protocol-compatible-standalone-worker-hub'
import {
  runStandaloneWorkerFactoryVerificationWithDependencies,
  type StandaloneWorkerRoundTripResult,
} from './worker-probe'

type MutableDiagnostics = {
  workersCreated: number
  workersTerminated: number
  activeWorkers: number
}

function createDiagnostics({
  mutable,
}: {
  mutable: MutableDiagnostics
}): FileProtocolWorkerDiagnostics {
  return {
    workerId: 'file-protocol-compatible-standalone-worker-hub',
    registryScriptLoads: 1,
    registryScriptLoadFailures: 0,
    blobRegistrations: 1,
    objectUrlsCreated: 1,
    workersCreated: mutable.workersCreated,
    workersTerminated: mutable.workersTerminated,
    activeWorkers: mutable.activeWorkers,
    runtimeDigestCalls: 0,
    sourceStoredAsGlobalString: false,
    objectUrlLifetime: 'page',
    registryEntryReleased: true,
    registryEntryPresent: false,
    blobUrlReady: true,
    blobBytes: 1024,
    sourcePartCount: 2,
    sha256: 'diagnostic-sha256',
    timingsMs: {},
  }
}

function createTrackedWorkerFactory({
  mutable,
  terminateCalls,
}: {
  mutable: MutableDiagnostics
  terminateCalls: number[]
}): () => Promise<Worker> {
  let nextId = 0

  return async () => {
    const id = nextId
    nextId += 1
    mutable.workersCreated += 1
    mutable.activeWorkers += 1
    let active = true

    return {
      terminate: () => {
        if (!active) {
          return
        }
        active = false
        mutable.workersTerminated += 1
        mutable.activeWorkers -= 1
        terminateCalls.push(id)
      },
    } as unknown as Worker
  }
}

describe('runStandaloneWorkerFactoryVerificationWithDependencies', () => {
  it('runs two concurrent Workers and recreates a third from the same asset', async () => {
    const mutable: MutableDiagnostics = {
      workersCreated: 4,
      workersTerminated: 4,
      activeWorkers: 0,
    }
    const terminateCalls: number[] = []
    const createWorker = vi.fn(createTrackedWorkerFactory({ mutable, terminateCalls }))
    const sources: string[] = []
    const runRoundTrip = vi.fn(async ({ source }: {
      worker: Worker
      source: string
    }): Promise<StandaloneWorkerRoundTripResult> => {
      sources.push(source)
      return {
        resolvedLanguage: 'json',
        htmlLength: source.length,
      }
    })

    const result = await runStandaloneWorkerFactoryVerificationWithDependencies({
      createWorker,
      readDiagnostics: () => createDiagnostics({ mutable }),
      runRoundTrip,
    })

    expect(createWorker).toHaveBeenCalledTimes(3)
    expect(runRoundTrip).toHaveBeenCalledTimes(3)
    expect(sources).toEqual([
      '{"probe":"concurrent-a"}',
      '{"probe":"concurrent-b"}',
      '{"probe":"recreated-after-terminate"}',
    ])
    expect(terminateCalls).toEqual([0, 1, 2])
    expect(result.concurrent).toEqual([
      { resolvedLanguage: 'json', htmlLength: 24 },
      { resolvedLanguage: 'json', htmlLength: 24 },
    ])
    expect(result.recreated).toEqual({
      resolvedLanguage: 'json',
      htmlLength: 37,
    })
    expect(result.deltas).toEqual({
      workersCreated: 3,
      workersTerminated: 3,
      activeWorkers: 0,
      registryScriptLoads: 0,
      blobRegistrations: 0,
      objectUrlsCreated: 0,
    })
    expect(result.before.activeWorkers).toBe(0)
    expect(result.after.activeWorkers).toBe(0)
  })

  it('terminates all concurrent Workers when one round trip fails', async () => {
    const mutable: MutableDiagnostics = {
      workersCreated: 0,
      workersTerminated: 0,
      activeWorkers: 0,
    }
    const terminateCalls: number[] = []
    const createWorker = vi.fn(createTrackedWorkerFactory({ mutable, terminateCalls }))
    const runRoundTrip = vi.fn(async ({ source }: {
      worker: Worker
      source: string
    }): Promise<StandaloneWorkerRoundTripResult> => {
      if (source.includes('concurrent-a')) {
        throw new Error('synthetic round-trip failure')
      }
      return { resolvedLanguage: 'json', htmlLength: source.length }
    })

    await expect(runStandaloneWorkerFactoryVerificationWithDependencies({
      createWorker,
      readDiagnostics: () => createDiagnostics({ mutable }),
      runRoundTrip,
    })).rejects.toThrow('synthetic round-trip failure')

    expect(createWorker).toHaveBeenCalledTimes(2)
    expect(terminateCalls).toEqual([0, 1])
    expect(mutable).toEqual({
      workersCreated: 2,
      workersTerminated: 2,
      activeWorkers: 0,
    })
  })

  it('terminates a fulfilled sibling when concurrent Worker creation partially fails', async () => {
    const terminate = vi.fn()
    const firstWorker = { terminate } as unknown as Worker
    const createWorker = vi.fn()
      .mockResolvedValueOnce(firstWorker)
      .mockRejectedValueOnce(new Error('synthetic worker creation failure'))
    const mutable: MutableDiagnostics = {
      workersCreated: 1,
      workersTerminated: 0,
      activeWorkers: 1,
    }
    const runRoundTrip = vi.fn()

    await expect(runStandaloneWorkerFactoryVerificationWithDependencies({
      createWorker,
      readDiagnostics: () => createDiagnostics({ mutable }),
      runRoundTrip,
    })).rejects.toThrow('synthetic worker creation failure')

    expect(createWorker).toHaveBeenCalledTimes(2)
    expect(terminate).toHaveBeenCalledOnce()
    expect(runRoundTrip).not.toHaveBeenCalled()
  })
})
