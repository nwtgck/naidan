import * as Comlink from 'comlink';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IHighlightWorker } from '@/features/highlight/worker/types';
import type { IWeshWorker } from '@/features/wesh/worker/types';
import type { StandaloneWorkerRuntimeDiagnostics } from '@/features/file-protocol-standalone/worker/standalone-worker-runtime.types';
import {
  type DebugFileProtocolStandaloneWorkerSession,
  TEST_ONLY,
} from './worker-probe';

type MutableNameDiagnostics = {
  workersCreated: number,
  workersTerminated: number,
  activeWorkers: number,
  initializationAttempts: number,
  initializationSuccesses: number,
  initializationFailures: number,
  initializationTimeouts: number,
};

type MutableRuntime = MutableNameDiagnostics & {
  workersByName: Record<string, MutableNameDiagnostics>,
};

type TrackedSession<Api> = DebugFileProtocolStandaloneWorkerSession<Api> & Readonly<{
  testId: number,
  workerName: string,
}>;

function zeroName(): MutableNameDiagnostics {
  return {
    workersCreated: 0,
    workersTerminated: 0,
    activeWorkers: 0,
    initializationAttempts: 0,
    initializationSuccesses: 0,
    initializationFailures: 0,
    initializationTimeouts: 0,
  };
}

function createMutableRuntime(): MutableRuntime {
  return { ...zeroName(), workersByName: {} };
}

function snapshot(runtime: MutableRuntime): StandaloneWorkerRuntimeDiagnostics {
  return {
    bootstrapObjectUrlStatus: 'ready',
    bootstrapObjectUrlsCreated: 1,
    bootstrapObjectUrlsRevoked: 0,
    warmupSchedules: 1,
    warmupRuns: 1,
    workerConstructorFailures: 0,
    workersCreated: runtime.workersCreated,
    workersTerminated: runtime.workersTerminated,
    activeWorkers: runtime.activeWorkers,
    terminateInstrumentationFailures: 0,
    initializationAttempts: runtime.initializationAttempts,
    initializationSuccesses: runtime.initializationSuccesses,
    initializationFailures: runtime.initializationFailures,
    initializationTimeouts: runtime.initializationTimeouts,
    workersByName: Object.fromEntries(Object.entries(runtime.workersByName).map(([name, value]) => [name, { ...value }])),
  };
}

function createTrackedFactory<Api>({ runtime, workerName, events }: {
  runtime: MutableRuntime,
  workerName: string,
  events: string[],
}): () => Promise<DebugFileProtocolStandaloneWorkerSession<Api>> {
  let nextId = 0;
  return async () => {
    const testId = nextId++;
    const byName = runtime.workersByName[workerName] ?? (runtime.workersByName[workerName] = zeroName());
    for (const target of [runtime, byName]) {
      target.workersCreated += 1;
      target.activeWorkers += 1;
      target.initializationAttempts += 1;
      target.initializationSuccesses += 1;
    }
    let active = true;
    const worker = {
      terminate() {
        if (!active) return;
        active = false;
        for (const target of [runtime, byName]) {
          target.workersTerminated += 1;
          target.activeWorkers -= 1;
        }
        events.push(`terminate:${workerName}:${testId}`);
      },
    } as unknown as Worker;
    return {
      testId,
      workerName,
      worker,
      remote: {} as Comlink.Remote<Api>,
    } satisfies TrackedSession<Api>;
  };
}

function idOf<Api>(session: DebugFileProtocolStandaloneWorkerSession<Api>): number {
  return (session as TrackedSession<Api>).testId;
}

function createRelease<Api>({ events }: { events: string[] }) {
  return vi.fn(async ({ session }: { session: DebugFileProtocolStandaloneWorkerSession<Api> }) => {
    const tracked = session as TrackedSession<Api>;
    events.push(`release:${tracked.workerName}:${tracked.testId}`);
    session.worker.terminate();
  });
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function asRemoteWesh(worker: IWeshWorker): Comlink.Remote<IWeshWorker> {
  return worker as Comlink.Remote<IWeshWorker>;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('standalone Worker verification lifecycle', () => {
  it('runs three Highlight sessions and one independent Wesh session without leaks', async () => {
    const runtime = createMutableRuntime();
    const events: string[] = [];
    const createHighlightSession = createTrackedFactory<IHighlightWorker>({ runtime, workerName: 'naidan-highlight-worker', events });
    const createWeshSession = createTrackedFactory<IWeshWorker>({ runtime, workerName: 'file-protocol-compatible-wesh-worker', events });
    const releaseHighlightSession = createRelease<IHighlightWorker>({ events });
    const releaseWeshSession = createRelease<IWeshWorker>({ events });

    const result = await TEST_ONLY.verifyWithDependencies({
      createHighlightSession,
      createWeshSession,
      readDiagnostics: () => snapshot(runtime),
      runHighlightProbe: async ({ session, source }) => {
        events.push(`highlight:${idOf(session)}`);
        return { resolvedLanguage: 'json', htmlLength: source.length };
      },
      runWeshProbe: async ({ session }) => {
        events.push(`wesh:${idOf(session)}`);
        return { exitCode: 0, stdout: '/bin/sh: text/x-shellscript\n', stderr: '' };
      },
      releaseHighlightSession,
      releaseWeshSession,
      creationTimeoutMs: 1_000,
      operationTimeoutMs: 1_000,
      cleanupTimeoutMs: 1_000,
    });

    expect(result.diagnosticDeltas).toMatchObject({ workersCreated: 4, workersTerminated: 4, activeWorkers: 0 });
    expect(result.workerDeltas.highlight).toMatchObject({ workersCreated: 3, workersTerminated: 3, activeWorkers: 0 });
    expect(result.workerDeltas.wesh).toMatchObject({ workersCreated: 1, workersTerminated: 1, activeWorkers: 0 });
    expect(runtime.activeWorkers).toBe(0);
    expect(events.filter(event => event.startsWith('release:'))).toHaveLength(4);
  });

  it('waits for both concurrent Highlight cleanups before preserving one operation failure', async () => {
    const runtime = createMutableRuntime();
    const events: string[] = [];
    const releaseGate = deferred<void>();
    const secondReleaseStarted = deferred<void>();
    const createHighlightSession = createTrackedFactory<IHighlightWorker>({ runtime, workerName: 'naidan-highlight-worker', events });
    const releaseHighlightSession = vi.fn(async ({ session }: { session: DebugFileProtocolStandaloneWorkerSession<IHighlightWorker> }) => {
      events.push(`release-start:${idOf(session)}`);
      if (idOf(session) === 1) {
        secondReleaseStarted.resolve();
        await releaseGate.promise;
      }
      session.worker.terminate();
      events.push(`release-end:${idOf(session)}`);
    });

    const verification = TEST_ONLY.verifyWithDependencies({
      createHighlightSession,
      createWeshSession: vi.fn(),
      readDiagnostics: () => snapshot(runtime),
      runHighlightProbe: async ({ session, source }) => {
        if (idOf(session) === 0) throw new Error('synthetic first Highlight failure');
        return { resolvedLanguage: 'json', htmlLength: source.length };
      },
      runWeshProbe: vi.fn(),
      releaseHighlightSession,
      releaseWeshSession: vi.fn(),
      creationTimeoutMs: 1_000,
      operationTimeoutMs: 1_000,
      cleanupTimeoutMs: 1_000,
    });

    await secondReleaseStarted.promise;
    expect(events).toContain('release-start:1');
    let settled = false;
    void verification.finally(() => {
      settled = true;
    }).catch(() => undefined);
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseGate.resolve();
    await expect(verification).rejects.toThrow('synthetic first Highlight failure');
    expect(events).toEqual(expect.arrayContaining(['release-end:0', 'release-end:1']));
    expect(runtime.activeWorkers).toBe(0);
  });

  it('releases a fulfilled Highlight sibling when the other creation fails', async () => {
    const runtime = createMutableRuntime();
    const events: string[] = [];
    const tracked = createTrackedFactory<IHighlightWorker>({ runtime, workerName: 'naidan-highlight-worker', events });
    const first = await tracked();
    const createHighlightSession = vi.fn()
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error('synthetic second creation failure'));
    const releaseHighlightSession = createRelease<IHighlightWorker>({ events });

    await expect(TEST_ONLY.verifyWithDependencies({
      createHighlightSession,
      createWeshSession: vi.fn(),
      readDiagnostics: () => snapshot(runtime),
      runHighlightProbe: vi.fn(),
      runWeshProbe: vi.fn(),
      releaseHighlightSession,
      releaseWeshSession: vi.fn(),
      creationTimeoutMs: 1_000,
      operationTimeoutMs: 1_000,
      cleanupTimeoutMs: 1_000,
    })).rejects.toThrow('synthetic second creation failure');
    expect(releaseHighlightSession).toHaveBeenCalledOnce();
    expect(runtime.activeWorkers).toBe(0);
  });

  it('reclaims a Highlight session that resolves after its creation deadline', async () => {
    vi.useFakeTimers();
    const runtime = createMutableRuntime();
    const events: string[] = [];
    const tracked = createTrackedFactory<IHighlightWorker>({ runtime, workerName: 'naidan-highlight-worker', events });
    const first = await tracked();
    const late = deferred<DebugFileProtocolStandaloneWorkerSession<IHighlightWorker>>();
    const createHighlightSession = vi.fn().mockResolvedValueOnce(first).mockImplementationOnce(() => late.promise);
    const releaseHighlightSession = createRelease<IHighlightWorker>({ events });

    const verification = TEST_ONLY.verifyWithDependencies({
      createHighlightSession,
      createWeshSession: vi.fn(),
      readDiagnostics: () => snapshot(runtime),
      runHighlightProbe: vi.fn(),
      runWeshProbe: vi.fn(),
      releaseHighlightSession,
      releaseWeshSession: vi.fn(),
      creationTimeoutMs: 25,
      operationTimeoutMs: 25,
      cleanupTimeoutMs: 25,
    });
    const rejection = expect(verification).rejects.toThrow('Second Highlight Worker session creation timed out after 25 ms.');
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(runtime.activeWorkers).toBe(0);

    const lateSession = await tracked();
    late.resolve(lateSession);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(releaseHighlightSession).toHaveBeenCalledTimes(2);
    expect(runtime.activeWorkers).toBe(0);
  });

  it('releases the independent Wesh session when its probe fails', async () => {
    const runtime = createMutableRuntime();
    const events: string[] = [];
    const createHighlightSession = createTrackedFactory<IHighlightWorker>({ runtime, workerName: 'naidan-highlight-worker', events });
    const createWeshSession = createTrackedFactory<IWeshWorker>({ runtime, workerName: 'file-protocol-compatible-wesh-worker', events });
    const releaseWeshSession = createRelease<IWeshWorker>({ events });

    await expect(TEST_ONLY.verifyWithDependencies({
      createHighlightSession,
      createWeshSession,
      readDiagnostics: () => snapshot(runtime),
      runHighlightProbe: async ({ source }) => ({ resolvedLanguage: 'json', htmlLength: source.length }),
      runWeshProbe: async () => {
        throw new Error('synthetic Wesh failure');
      },
      releaseHighlightSession: createRelease<IHighlightWorker>({ events }),
      releaseWeshSession,
      creationTimeoutMs: 1_000,
      operationTimeoutMs: 1_000,
      cleanupTimeoutMs: 1_000,
    })).rejects.toThrow('synthetic Wesh failure');
    expect(releaseWeshSession).toHaveBeenCalledOnce();
    expect(runtime.activeWorkers).toBe(0);
  });

  it('forces physical termination when injected Wesh cleanup never settles', async () => {
    vi.useFakeTimers();
    const runtime = createMutableRuntime();
    const events: string[] = [];
    const createHighlightSession = createTrackedFactory<IHighlightWorker>({ runtime, workerName: 'naidan-highlight-worker', events });
    const createWeshSession = createTrackedFactory<IWeshWorker>({ runtime, workerName: 'file-protocol-compatible-wesh-worker', events });

    const verification = TEST_ONLY.verifyWithDependencies({
      createHighlightSession,
      createWeshSession,
      readDiagnostics: () => snapshot(runtime),
      runHighlightProbe: async ({ source }) => ({ resolvedLanguage: 'json', htmlLength: source.length }),
      runWeshProbe: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      releaseHighlightSession: createRelease<IHighlightWorker>({ events }),
      releaseWeshSession: async () => new Promise<void>(() => {}),
      creationTimeoutMs: 25,
      operationTimeoutMs: 25,
      cleanupTimeoutMs: 25,
    });
    const rejection = expect(verification).rejects.toThrow('Split Worker session cleanup timed out after 25 ms.');
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(runtime.activeWorkers).toBe(0);
  });
});

describe('Wesh file probe cleanup', () => {
  it('disposes the execution and remote after a successful real command lifecycle', async () => {
    const events: string[] = [];
    const stdout = new TextEncoder().encode('/bin/sh: text/x-shellscript\n').buffer as ArrayBuffer;
    const worker = {
      init: vi.fn(async () => {
        events.push('init');
      }),
      startExecution: vi.fn(async (_request, onEvent) => {
        events.push('start');
        await onEvent?.({ type: 'stdout', buffer: stdout });
        return { executionId: 'execution-1' };
      }),
      awaitExecution: vi.fn(async () => {
        events.push('await'); return { exitCode: 0 };
      }),
      disposeExecution: vi.fn(async () => {
        events.push('dispose-execution');
      }),
      dispose: vi.fn(async () => {
        events.push('dispose');
      }),
    } as unknown as IWeshWorker;

    await expect(TEST_ONLY.runWeshFileProbeWithRemote({ wesh: asRemoteWesh(worker) })).resolves.toEqual({
      exitCode: 0,
      stdout: '/bin/sh: text/x-shellscript\n',
      stderr: '',
    });
    expect(events).toEqual(['init', 'start', 'await', 'dispose-execution', 'dispose']);
  });

  it('preserves an await failure while still disposing execution and remote', async () => {
    const disposeExecution = vi.fn(async () => {});
    const dispose = vi.fn(async () => {});
    const worker = {
      init: vi.fn(async () => {}),
      startExecution: vi.fn(async () => ({ executionId: 'execution-2' })),
      awaitExecution: vi.fn(async () => {
        throw new Error('synthetic await failure');
      }),
      disposeExecution,
      dispose,
    } as unknown as IWeshWorker;

    await expect(TEST_ONLY.runWeshFileProbeWithRemote({ wesh: asRemoteWesh(worker) })).rejects.toThrow('synthetic await failure');
    expect(disposeExecution).toHaveBeenCalledWith({ request: { executionId: 'execution-2' } });
    expect(dispose).toHaveBeenCalledOnce();
  });
});
