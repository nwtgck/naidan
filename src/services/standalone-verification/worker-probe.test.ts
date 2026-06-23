import * as Comlink from 'comlink'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { IWorkerHub } from '@/services/worker-hub.types'
import type { IWeshWorker } from '@/services/wesh/worker/types'
import type { FileProtocolWorkerDiagnostics } from 'virtual:file-protocol-standalone/worker/file-protocol-compatible-standalone-worker-hub'
import {
  releaseStandaloneWorkerHubSession,
  runHighlightRoundTrip,
  runStandaloneWeshFileProbeWithRemote,
  runStandaloneWorkerFactoryVerificationWithDependencies,
  runWeshFileProbe,
  type StandaloneWorkerHubSession,
  type StandaloneWorkerRoundTripResult,
  type StandaloneWeshFileProbeResult,
} from './worker-probe'

type MutableDiagnostics = {
  workersCreated: number
  workersTerminated: number
  activeWorkers: number
}

type TrackedSession = StandaloneWorkerHubSession & Readonly<{
  testId: number
}>

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

function createTrackedSessionFactory({
  mutable,
  events,
}: {
  mutable: MutableDiagnostics
  events: string[]
}): () => Promise<StandaloneWorkerHubSession> {
  let nextId = 0

  return async () => {
    const testId = nextId
    nextId += 1
    mutable.workersCreated += 1
    mutable.activeWorkers += 1
    let active = true

    const worker = {
      terminate: () => {
        if (!active) return
        active = false
        mutable.workersTerminated += 1
        mutable.activeWorkers -= 1
        events.push(`terminate:${testId}`)
      },
    } as unknown as Worker

    return {
      testId,
      worker,
      remote: {} as TrackedSession['remote'],
    } satisfies TrackedSession
  }
}

function getTestId({ session }: { session: StandaloneWorkerHubSession }): number {
  return (session as TrackedSession).testId
}

function createReleaseSession({ events }: { events: string[] }) {
  return vi.fn(async ({ session }: { session: StandaloneWorkerHubSession }) => {
    const testId = getTestId({ session })
    events.push(`release:${testId}`)
    session.worker.terminate()
  })
}

function createDeferred<Result>() {
  let resolve!: (value: Result) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<Result>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

type MessageListener = (event: MessageEvent) => void

class LocalMessageEndpoint {
  private readonly listeners = new Set<MessageListener>()
  private peer: LocalMessageEndpoint | undefined

  connect({ peer }: { peer: LocalMessageEndpoint }): void {
    this.peer = peer
  }

  postMessage(message: unknown): void {
    queueMicrotask(() => {
      this.peer?.dispatchMessage({ data: message } as MessageEvent)
    })
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'message') {
      this.listeners.add(listener as MessageListener)
    }
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'message') {
      this.listeners.delete(listener as MessageListener)
    }
  }

  start(): void {}

  close(): void {
    this.listeners.clear()
  }

  listenerCount(): number {
    return this.listeners.size
  }

  private dispatchMessage(event: MessageEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}

function createRealComlinkSessionFactory({
  mutable,
  events,
  sessions,
}: {
  mutable: MutableDiagnostics
  events: string[]
  sessions: StandaloneWorkerHubSession[]
}): () => Promise<StandaloneWorkerHubSession> {
  let nextId = 0

  return async () => {
    const testId = nextId
    nextId += 1
    const clientEndpoint = new LocalMessageEndpoint()
    const workerEndpoint = new LocalMessageEndpoint()
    clientEndpoint.connect({ peer: workerEndpoint })
    workerEndpoint.connect({ peer: clientEndpoint })

    const stdout = new TextEncoder().encode('/bin/sh: text/x-shellscript\n').buffer as ArrayBuffer
    const hub = {
      highlight: {
        highlight: async ({ request }: { request: { code: string } }) => {
          events.push(`highlight:${testId}`)
          return {
            resolvedLanguage: 'json',
            html: `<pre>${request.code}</pre>`,
          }
        },
      },
      wesh: {
        init: async () => {
          events.push(`wesh-init:${testId}`)
        },
        startExecution: async (_request: unknown, onEvent?: (event: unknown) => void | Promise<void>) => {
          events.push(`wesh-start:${testId}`)
          await onEvent?.({ type: 'stdout', buffer: stdout })
          return { executionId: `execution-${testId}` }
        },
        awaitExecution: async () => {
          events.push(`wesh-await:${testId}`)
          return { exitCode: 0 }
        },
        disposeExecution: async () => {
          events.push(`wesh-dispose-execution:${testId}`)
        },
        dispose: async () => {
          events.push(`wesh-dispose:${testId}`)
        },
      },
    } as unknown as IWorkerHub
    Comlink.expose(hub, workerEndpoint as unknown as MessagePort)

    mutable.workersCreated += 1
    mutable.activeWorkers += 1
    let active = true
    const worker = {
      postMessage: (message: unknown) => clientEndpoint.postMessage(message),
      addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        clientEndpoint.addEventListener(type, listener)
      },
      removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        clientEndpoint.removeEventListener(type, listener)
      },
      terminate: () => {
        if (!active) return
        active = false
        events.push(`terminate:${testId}:worker-listeners=${workerEndpoint.listenerCount()}`)
        mutable.workersTerminated += 1
        mutable.activeWorkers -= 1
        clientEndpoint.close()
        workerEndpoint.close()
      },
    } as unknown as Worker
    const session = {
      worker,
      remote: Comlink.wrap<IWorkerHub>(worker),
    }
    sessions.push(session)
    return session
  }
}

function asRemoteWesh({ worker }: { worker: IWeshWorker }): Comlink.Remote<IWeshWorker> {
  return worker as Comlink.Remote<IWeshWorker>
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('runStandaloneWorkerFactoryVerificationWithDependencies', () => {
  it('keeps a real Comlink root endpoint alive through highlight and Wesh before release', async () => {
    const mutable: MutableDiagnostics = {
      workersCreated: 0,
      workersTerminated: 0,
      activeWorkers: 0,
    }
    const events: string[] = []
    const sessions: StandaloneWorkerHubSession[] = []

    const result = await runStandaloneWorkerFactoryVerificationWithDependencies({
      createSession: createRealComlinkSessionFactory({ mutable, events, sessions }),
      readDiagnostics: () => createDiagnostics({ mutable }),
      runRoundTrip: runHighlightRoundTrip,
      runFileProbe: runWeshFileProbe,
      releaseSession: releaseStandaloneWorkerHubSession,
      operationTimeoutMs: 1_000,
      cleanupTimeoutMs: 1_000,
    })

    expect(result.weshFileProbe).toEqual({
      exitCode: 0,
      stdout: '/bin/sh: text/x-shellscript\n',
      stderr: '',
    })
    expect(sessions).toHaveLength(3)
    const recreatedHighlight = events.indexOf('highlight:2')
    const recreatedWesh = events.indexOf('wesh-init:2')
    const recreatedTerminate = events.indexOf('terminate:2:worker-listeners=0')
    expect(recreatedHighlight).toBeGreaterThanOrEqual(0)
    expect(recreatedWesh).toBeGreaterThan(recreatedHighlight)
    expect(recreatedTerminate).toBeGreaterThan(recreatedWesh)
    expect(mutable).toEqual({
      workersCreated: 3,
      workersTerminated: 3,
      activeWorkers: 0,
    })
  })

  it('uses one recreated Comlink session for highlight and Wesh before releasing it', async () => {
    const mutable: MutableDiagnostics = {
      workersCreated: 4,
      workersTerminated: 4,
      activeWorkers: 0,
    }
    const events: string[] = []
    const createSession = vi.fn(createTrackedSessionFactory({ mutable, events }))
    const releaseSession = createReleaseSession({ events })
    const roundTripSessions: StandaloneWorkerHubSession[] = []
    const runRoundTrip = vi.fn(async ({ session, source }: {
      session: StandaloneWorkerHubSession
      source: string
    }): Promise<StandaloneWorkerRoundTripResult> => {
      roundTripSessions.push(session)
      events.push(`highlight:${getTestId({ session })}`)
      return {
        resolvedLanguage: 'json',
        htmlLength: source.length,
      }
    })
    const fileProbeSessions: StandaloneWorkerHubSession[] = []
    const runFileProbe = vi.fn(async ({ session }: {
      session: StandaloneWorkerHubSession
    }): Promise<StandaloneWeshFileProbeResult> => {
      fileProbeSessions.push(session)
      events.push(`wesh:${getTestId({ session })}`)
      return {
        exitCode: 0,
        stdout: '/bin/sh: text/x-shellscript\n',
        stderr: '',
      }
    })

    const result = await runStandaloneWorkerFactoryVerificationWithDependencies({
      createSession,
      readDiagnostics: () => createDiagnostics({ mutable }),
      runRoundTrip,
      runFileProbe,
      releaseSession,
      operationTimeoutMs: 1_000,
      cleanupTimeoutMs: 1_000,
    })

    expect(createSession).toHaveBeenCalledTimes(3)
    expect(runRoundTrip).toHaveBeenCalledTimes(3)
    expect(runFileProbe).toHaveBeenCalledOnce()
    expect(roundTripSessions[2]).toBe(fileProbeSessions[0])
    expect(events).toEqual([
      'highlight:0',
      'highlight:1',
      'release:0',
      'terminate:0',
      'release:1',
      'terminate:1',
      'highlight:2',
      'wesh:2',
      'release:2',
      'terminate:2',
    ])
    expect(result.deltas).toEqual({
      workersCreated: 3,
      workersTerminated: 3,
      activeWorkers: 0,
      registryScriptLoads: 0,
      blobRegistrations: 0,
      objectUrlsCreated: 0,
    })
  })

  it('waits for both concurrent cleanups before reporting one round-trip failure', async () => {
    const mutable: MutableDiagnostics = {
      workersCreated: 0,
      workersTerminated: 0,
      activeWorkers: 0,
    }
    const events: string[] = []
    const createSession = vi.fn(createTrackedSessionFactory({ mutable, events }))
    const releaseSession = createReleaseSession({ events })
    const sibling = createDeferred<StandaloneWorkerRoundTripResult>()
    const runRoundTrip = vi.fn(async ({ source }: {
      session: StandaloneWorkerHubSession
      source: string
    }): Promise<StandaloneWorkerRoundTripResult> => {
      if (source.includes('concurrent-a')) {
        throw new Error('synthetic round-trip failure')
      }
      return sibling.promise
    })

    let settled = false
    const verification = runStandaloneWorkerFactoryVerificationWithDependencies({
      createSession,
      readDiagnostics: () => createDiagnostics({ mutable }),
      runRoundTrip,
      runFileProbe: vi.fn(),
      releaseSession,
      operationTimeoutMs: 1_000,
      cleanupTimeoutMs: 1_000,
    }).finally(() => {
      settled = true
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    sibling.resolve({ resolvedLanguage: 'json', htmlLength: 1 })

    await expect(verification).rejects.toThrow('synthetic round-trip failure')
    expect(releaseSession).toHaveBeenCalledTimes(2)
    expect(mutable).toEqual({
      workersCreated: 2,
      workersTerminated: 2,
      activeWorkers: 0,
    })
  })

  it('releases a fulfilled sibling and preserves a concurrent session creation failure', async () => {
    const events: string[] = []
    const mutable: MutableDiagnostics = {
      workersCreated: 0,
      workersTerminated: 0,
      activeWorkers: 0,
    }
    const firstSession = await createTrackedSessionFactory({ mutable, events })()
    const createSession = vi.fn()
      .mockResolvedValueOnce(firstSession)
      .mockRejectedValueOnce(new Error('synthetic worker creation failure'))
    const releaseSession = createReleaseSession({ events })

    await expect(runStandaloneWorkerFactoryVerificationWithDependencies({
      createSession,
      readDiagnostics: () => createDiagnostics({ mutable }),
      runRoundTrip: vi.fn(),
      runFileProbe: vi.fn(),
      releaseSession,
      operationTimeoutMs: 1_000,
      cleanupTimeoutMs: 1_000,
    })).rejects.toThrow('synthetic worker creation failure')

    expect(releaseSession).toHaveBeenCalledOnce()
    expect(events).toEqual(['release:0', 'terminate:0'])
  })

  it('releases the recreated session when the Wesh file probe fails', async () => {
    const mutable: MutableDiagnostics = {
      workersCreated: 0,
      workersTerminated: 0,
      activeWorkers: 0,
    }
    const events: string[] = []
    const createSession = vi.fn(createTrackedSessionFactory({ mutable, events }))
    const releaseSession = createReleaseSession({ events })

    await expect(runStandaloneWorkerFactoryVerificationWithDependencies({
      createSession,
      readDiagnostics: () => createDiagnostics({ mutable }),
      runRoundTrip: async ({ session, source }) => {
        events.push(`highlight:${getTestId({ session })}`)
        return { resolvedLanguage: 'json', htmlLength: source.length }
      },
      runFileProbe: async ({ session }) => {
        events.push(`wesh:${getTestId({ session })}`)
        throw new Error('synthetic Wesh file probe failure')
      },
      releaseSession,
      operationTimeoutMs: 1_000,
      cleanupTimeoutMs: 1_000,
    })).rejects.toThrow('synthetic Wesh file probe failure')

    expect(events.slice(-4)).toEqual([
      'highlight:2',
      'wesh:2',
      'release:2',
      'terminate:2',
    ])
    expect(mutable.activeWorkers).toBe(0)
  })

  it('times out a pending Wesh probe and still releases the recreated session', async () => {
    vi.useFakeTimers()
    const mutable: MutableDiagnostics = {
      workersCreated: 0,
      workersTerminated: 0,
      activeWorkers: 0,
    }
    const events: string[] = []
    const createSession = vi.fn(createTrackedSessionFactory({ mutable, events }))
    const releaseSession = createReleaseSession({ events })

    const verification = runStandaloneWorkerFactoryVerificationWithDependencies({
      createSession,
      readDiagnostics: () => createDiagnostics({ mutable }),
      runRoundTrip: async ({ source }) => ({ resolvedLanguage: 'json', htmlLength: source.length }),
      runFileProbe: async () => new Promise<StandaloneWeshFileProbeResult>(() => {}),
      releaseSession,
      operationTimeoutMs: 25,
      cleanupTimeoutMs: 25,
    })

    const rejection = expect(verification).rejects.toThrow(
      'Recreated standalone Worker Wesh file probe timed out after 25 ms.',
    )
    await vi.advanceTimersByTimeAsync(25)
    await rejection
    expect(releaseSession).toHaveBeenCalledTimes(3)
    expect(mutable.activeWorkers).toBe(0)
  })

  it('forces termination when session cleanup itself never settles', async () => {
    vi.useFakeTimers()
    const mutable: MutableDiagnostics = {
      workersCreated: 0,
      workersTerminated: 0,
      activeWorkers: 0,
    }
    const events: string[] = []
    const createSession = vi.fn(createTrackedSessionFactory({ mutable, events }))
    let releaseCount = 0
    const releaseSession = vi.fn(async ({ session }: { session: StandaloneWorkerHubSession }) => {
      releaseCount += 1
      if (releaseCount < 3) {
        session.worker.terminate()
        return
      }
      await new Promise<void>(() => {})
    })

    const verification = runStandaloneWorkerFactoryVerificationWithDependencies({
      createSession,
      readDiagnostics: () => createDiagnostics({ mutable }),
      runRoundTrip: async ({ source }) => ({ resolvedLanguage: 'json', htmlLength: source.length }),
      runFileProbe: async () => ({ exitCode: 0, stdout: '/bin/sh: text/x-shellscript\n', stderr: '' }),
      releaseSession,
      operationTimeoutMs: 25,
      cleanupTimeoutMs: 25,
    })

    const rejection = expect(verification).rejects.toThrow(
      'Standalone Worker session cleanup timed out after 25 ms.',
    )
    await vi.advanceTimersByTimeAsync(25)
    await rejection
    expect(releaseSession).toHaveBeenCalledTimes(3)
    expect(mutable).toEqual({
      workersCreated: 3,
      workersTerminated: 3,
      activeWorkers: 0,
    })
  })
})

describe('runStandaloneWeshFileProbeWithRemote', () => {
  it('runs the real file command probe and disposes its execution and remote', async () => {
    const events: string[] = []
    const stdout = new TextEncoder().encode('/bin/sh: text/x-shellscript\n').buffer as ArrayBuffer
    const worker: IWeshWorker = {
      init: vi.fn(async () => {
        events.push('init')
      }),
      startExecution: vi.fn(async (_request, onEvent) => {
        events.push('start')
        await onEvent?.({ type: 'stdout', buffer: stdout })
        return { executionId: 'execution-1' }
      }),
      awaitExecution: vi.fn(async () => {
        events.push('await')
        return { exitCode: 0 }
      }),
      disposeExecution: vi.fn(async () => {
        events.push('dispose-execution')
      }),
      dispose: vi.fn(async () => {
        events.push('dispose')
      }),
    } as unknown as IWeshWorker

    const result = await runStandaloneWeshFileProbeWithRemote({
      wesh: asRemoteWesh({ worker }),
    })

    expect(result).toEqual({
      exitCode: 0,
      stdout: '/bin/sh: text/x-shellscript\n',
      stderr: '',
    })
    expect(events).toEqual(['init', 'start', 'await', 'dispose-execution', 'dispose'])
  })

  it('collects stdout and stderr while ignoring lifecycle events', async () => {
    const stdout = new TextEncoder().encode('out').buffer as ArrayBuffer
    const stderr = new TextEncoder().encode('err').buffer as ArrayBuffer
    const worker: IWeshWorker = {
      init: vi.fn(async () => {}),
      startExecution: vi.fn(async (_request, onEvent) => {
        await onEvent?.({ type: 'started' })
        await onEvent?.({ type: 'stdout', buffer: stdout })
        await onEvent?.({ type: 'stderr', buffer: stderr })
        await onEvent?.({ type: 'exit', exitCode: 7 })
        return { executionId: 'execution-2' }
      }),
      awaitExecution: vi.fn(async () => ({ exitCode: 7 })),
      disposeExecution: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    } as unknown as IWeshWorker

    await expect(runStandaloneWeshFileProbeWithRemote({
      wesh: asRemoteWesh({ worker }),
    })).resolves.toEqual({ exitCode: 7, stdout: 'out', stderr: 'err' })
  })

  it('disposes the execution and remote when awaiting completion fails', async () => {
    const disposeExecution = vi.fn(async () => {})
    const dispose = vi.fn(async () => {})
    const worker: IWeshWorker = {
      init: vi.fn(async () => {}),
      startExecution: vi.fn(async () => ({ executionId: 'execution-3' })),
      awaitExecution: vi.fn(async () => {
        throw new Error('synthetic await failure')
      }),
      disposeExecution,
      dispose,
    } as unknown as IWeshWorker

    await expect(runStandaloneWeshFileProbeWithRemote({
      wesh: asRemoteWesh({ worker }),
    })).rejects.toThrow('synthetic await failure')
    expect(disposeExecution).toHaveBeenCalledWith({ request: { executionId: 'execution-3' } })
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('still disposes the remote when execution startup fails', async () => {
    const disposeExecution = vi.fn(async () => {})
    const dispose = vi.fn(async () => {})
    const worker: IWeshWorker = {
      init: vi.fn(async () => {}),
      startExecution: vi.fn(async () => {
        throw new Error('synthetic start failure')
      }),
      awaitExecution: vi.fn(),
      disposeExecution,
      dispose,
    } as unknown as IWeshWorker

    await expect(runStandaloneWeshFileProbeWithRemote({
      wesh: asRemoteWesh({ worker }),
    })).rejects.toThrow('synthetic start failure')
    expect(disposeExecution).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
