import {
  releaseWorkerRemote,
  workerCapability,
  workerProxy,
  wrapWorkerRemote,
  type WorkerRemote,
} from '@/utils/worker-transport';

import type { IHighlightWorker } from '@/features/highlight/worker/types';
import type {
  IWeshWorker,
  WeshWorkerRemoteExecutionEvent,
} from '@/features/wesh/worker/types';
import type {
  StandaloneWorkerNameDiagnostics,
  StandaloneWorkerRuntimeDiagnostics,
} from '@/features/file-protocol-standalone/worker/standalone-worker-runtime.types';
import {
  createStandaloneWorker as createHighlightWorker,
  debugGetStandaloneWorkerRuntimeDiagnostics,
} from 'virtual:file-protocol-standalone/worker/highlight';
import { createStandaloneWorker as createWeshWorker } from 'virtual:file-protocol-standalone/worker/wesh';

export type DebugFileProtocolStandaloneHighlightProbeResult = Readonly<{
  resolvedLanguage: string,
  htmlLength: number,
}>;

export type DebugFileProtocolStandaloneWeshCommandProbeResult = Readonly<{
  exitCode: number,
  stdout: string,
  stderr: string,
}>;

type DiagnosticDelta = Readonly<{
  workersCreated: number,
  workersTerminated: number,
  activeWorkers: number,
  initializationAttempts: number,
  initializationSuccesses: number,
  initializationFailures: number,
  initializationTimeouts: number,
}>;

export type DebugFileProtocolStandaloneWorkerVerificationResult = Readonly<{
  diagnosticsBefore: StandaloneWorkerRuntimeDiagnostics,
  diagnosticsAfter: StandaloneWorkerRuntimeDiagnostics,
  diagnosticDeltas: DiagnosticDelta,
  workerDeltas: Readonly<{
    highlight: DiagnosticDelta,
    wesh: DiagnosticDelta,
  }>,
  concurrentHighlights: readonly DebugFileProtocolStandaloneHighlightProbeResult[],
  recreatedWorkerHighlight: DebugFileProtocolStandaloneHighlightProbeResult,
  weshCommandProbe: DebugFileProtocolStandaloneWeshCommandProbeResult,
}>;

export type DebugFileProtocolStandaloneWorkerSession<Api> = Readonly<{
  worker: Worker,
  remote: WorkerRemote<Api>,
}>;

type ReleaseSession<Api> = ({ session }: {
  session: DebugFileProtocolStandaloneWorkerSession<Api>,
}) => Promise<void>;

const sessionCreationDeadlineMs = 30_000;
const operationDeadlineMs = 30_000;
const cleanupDeadlineMs = 5_000;
const highlightWorkerName = 'naidan-highlight-worker';
const weshWorkerName = 'file-protocol-compatible-wesh-worker';

/**
 * Stop waiting at the deadline. Promise.race does not cancel an underlying
 * Worker operation, so every resource-producing caller must arrange cleanup.
 */
async function waitForOperationUntilDeadline<Result>({ label, timeoutMs, action }: {
  label: string,
  timeoutMs: number,
  action: () => Promise<Result>,
}): Promise<Result> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms.`)), timeoutMs);
  });
  try {
    return await Promise.race([action(), timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function createSession<Api>({ label, createWorker }: {
  label: string,
  createWorker: () => Promise<Worker>,
}): Promise<DebugFileProtocolStandaloneWorkerSession<Api>> {
  const worker = await waitForOperationUntilDeadline({
    label,
    timeoutMs: sessionCreationDeadlineMs,
    action: createWorker,
  });
  try {
    return { worker, remote: wrapWorkerRemote<Api>({ endpoint: worker }) };
  } catch (error) {
    worker.terminate();
    throw error;
  }
}

async function releaseAndTerminateSession<Api>({ session }: {
  session: DebugFileProtocolStandaloneWorkerSession<Api>,
}): Promise<void> {
  let releaseError: unknown;
  try {
    await waitForOperationUntilDeadline({
      label: 'Split Worker Comlink proxy release',
      timeoutMs: cleanupDeadlineMs,
      action: async () => {
        await releaseWorkerRemote({ remote: session.remote });
      },
    });
  } catch (error) {
    releaseError = error;
  } finally {
    // terminate() is idempotent in the generated standalone Worker wrapper. Always
    // force the physical realm down even when Comlink never acknowledges release.
    session.worker.terminate();
  }
  if (releaseError !== undefined) throw releaseError;
}

async function releaseSessionUntilDeadline<Api>({ session, releaseSession, timeoutMs }: {
  session: DebugFileProtocolStandaloneWorkerSession<Api>,
  releaseSession: ReleaseSession<Api>,
  timeoutMs: number,
}): Promise<void> {
  try {
    await waitForOperationUntilDeadline({
      label: 'Split Worker session cleanup',
      timeoutMs,
      action: () => releaseSession({ session }),
    });
  } catch (error) {
    // Dependency-injected cleanup can itself hang. The verification route must
    // never leak a Worker realm merely because its diagnostic cleanup failed.
    session.worker.terminate();
    throw error;
  }
}

async function createSessionUntilDeadline<Api>({
  createSession,
  releaseSession,
  creationTimeoutMs,
  cleanupTimeoutMs,
  label,
}: {
  createSession: () => Promise<DebugFileProtocolStandaloneWorkerSession<Api>>,
  releaseSession: ReleaseSession<Api>,
  creationTimeoutMs: number,
  cleanupTimeoutMs: number,
  label: string,
}): Promise<DebugFileProtocolStandaloneWorkerSession<Api>> {
  const timeoutError = new Error(`${label} timed out after ${creationTimeoutMs} ms.`);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const creation = Promise.resolve().then(createSession);
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      reject(timeoutError);
    }, creationTimeoutMs);
  });
  try {
    return await Promise.race([creation, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (timedOut) {
      // Promise.race does not cancel Worker construction. Reclaim a session that
      // resolves after the deadline instead of leaving a hidden live Worker.
      void creation.then(async (session) => {
        try {
          await releaseSessionUntilDeadline({ session, releaseSession, timeoutMs: cleanupTimeoutMs });
        } catch {
          // releaseSessionUntilDeadline already forced physical termination.
        }
      }, () => undefined);
    }
  }
}

async function createConcurrentHighlightSessions({
  createSession,
  releaseSession,
  creationTimeoutMs,
  cleanupTimeoutMs,
}: {
  createSession: () => Promise<DebugFileProtocolStandaloneWorkerSession<IHighlightWorker>>,
  releaseSession: ReleaseSession<IHighlightWorker>,
  creationTimeoutMs: number,
  cleanupTimeoutMs: number,
}): Promise<readonly [
  DebugFileProtocolStandaloneWorkerSession<IHighlightWorker>,
  DebugFileProtocolStandaloneWorkerSession<IHighlightWorker>,
]> {
  const outcomes = await Promise.allSettled([
    createSessionUntilDeadline({
      createSession,
      releaseSession,
      creationTimeoutMs,
      cleanupTimeoutMs,
      label: 'First Highlight Worker session creation',
    }),
    createSessionUntilDeadline({
      createSession,
      releaseSession,
      creationTimeoutMs,
      cleanupTimeoutMs,
      label: 'Second Highlight Worker session creation',
    }),
  ]);
  const fulfilled = outcomes.filter((outcome): outcome is PromiseFulfilledResult<DebugFileProtocolStandaloneWorkerSession<IHighlightWorker>> => outcome.status === 'fulfilled');
  const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
  const firstRejected = rejected[0];
  if (firstRejected !== undefined) {
    await Promise.allSettled(fulfilled.map(({ value }) => releaseSessionUntilDeadline({
      session: value,
      releaseSession,
      timeoutMs: cleanupTimeoutMs,
    })));
    throw firstRejected.reason;
  }
  const firstFulfilled = fulfilled[0];
  const secondFulfilled = fulfilled[1];
  if (firstFulfilled === undefined || secondFulfilled === undefined) {
    throw new Error('Concurrent Highlight Worker creation produced an incomplete outcome set.');
  }
  return [firstFulfilled.value, secondFulfilled.value];
}

async function runHighlightProbeWithSession({ session, source }: {
  session: DebugFileProtocolStandaloneWorkerSession<IHighlightWorker>,
  source: string,
}): Promise<DebugFileProtocolStandaloneHighlightProbeResult> {
  const result = await session.remote.highlight({
    request: { code: source, language: 'json', mode: 'named-language' },
  });
  return { resolvedLanguage: result.resolvedLanguage, htmlLength: result.html.length };
}

async function runHighlightProbeAndCleanup({
  session,
  source,
  runProbe,
  releaseSession,
  operationTimeoutMs,
  cleanupTimeoutMs,
}: {
  session: DebugFileProtocolStandaloneWorkerSession<IHighlightWorker>,
  source: string,
  runProbe: typeof runHighlightProbeWithSession,
  releaseSession: ReleaseSession<IHighlightWorker>,
  operationTimeoutMs: number,
  cleanupTimeoutMs: number,
}): Promise<DebugFileProtocolStandaloneHighlightProbeResult> {
  let result: DebugFileProtocolStandaloneHighlightProbeResult | undefined;
  let operationError: unknown;
  try {
    result = await waitForOperationUntilDeadline({
      label: 'Highlight Worker probe',
      timeoutMs: operationTimeoutMs,
      action: () => runProbe({ session, source }),
    });
  } catch (error) {
    operationError = error;
  }
  let cleanupError: unknown;
  try {
    await releaseSessionUntilDeadline({ session, releaseSession, timeoutMs: cleanupTimeoutMs });
  } catch (error) {
    cleanupError = error;
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
  if (result === undefined) throw new Error('Highlight Worker probe produced no result.');
  return result;
}

/** @internal Exported for Wesh lifecycle regression tests. */
async function runWeshCommandProbeWithRemote({ wesh }: {
  wesh: WorkerRemote<IWeshWorker>,
}): Promise<DebugFileProtocolStandaloneWeshCommandProbeResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const decoder = new TextDecoder();
  let executionId: string | undefined;
  let result: DebugFileProtocolStandaloneWeshCommandProbeResult | undefined;
  let operationError: unknown;
  try {
    await wesh.init(workerCapability({
      value: {
        rootHandle: 'readonly',
        mounts: [],
        user: 'standalone-verification',
        initialEnv: {},
        initialCwd: '/',
      },
      capability: 'file-system-handle-clone',
    }));
    const started = await wesh.startExecution(
      { script: 'ls -1 /' },
      // eslint-disable-next-line local-rules-named-args/require-named-args -- Mirrors the external Comlink positional callback boundary.
      workerProxy({ value: (event: WeshWorkerRemoteExecutionEvent) => {
        switch (event.type) {
        case 'started':
        case 'exit':
          return;
        case 'stdout':
          stdout.push(decoder.decode(event.buffer));
          return;
        case 'stderr':
          stderr.push(decoder.decode(event.buffer));
          return;
        case 'error':
          throw new Error(event.message);
        default: {
          const _exhaustive: never = event;
          throw new Error(`Unhandled Wesh verification event: ${String(_exhaustive)}`);
        }
        }
      } }),
    );
    executionId = started.executionId;
    const summary = await wesh.awaitExecution({ request: { executionId } });
    result = { exitCode: summary.exitCode, stdout: stdout.join(''), stderr: stderr.join('') };
  } catch (error) {
    operationError = error;
  }
  let cleanupError: unknown;
  if (executionId !== undefined) {
    try {
      await wesh.disposeExecution({ request: { executionId } });
    } catch (error) {
      cleanupError = error;
    }
  }
  try {
    await wesh.dispose();
  } catch (error) {
    cleanupError ??= error;
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
  if (result === undefined) throw new Error('Standalone Wesh file probe produced no result.');
  return result;
}

async function runWeshProbeAndCleanup({
  session,
  runProbe,
  releaseSession,
  operationTimeoutMs,
  cleanupTimeoutMs,
}: {
  session: DebugFileProtocolStandaloneWorkerSession<IWeshWorker>,
  runProbe: ({ session }: { session: DebugFileProtocolStandaloneWorkerSession<IWeshWorker> }) => Promise<DebugFileProtocolStandaloneWeshCommandProbeResult>,
  releaseSession: ReleaseSession<IWeshWorker>,
  operationTimeoutMs: number,
  cleanupTimeoutMs: number,
}): Promise<DebugFileProtocolStandaloneWeshCommandProbeResult> {
  let result: DebugFileProtocolStandaloneWeshCommandProbeResult | undefined;
  let operationError: unknown;
  try {
    result = await waitForOperationUntilDeadline({
      label: 'Wesh Worker file probe',
      timeoutMs: operationTimeoutMs,
      action: () => runProbe({ session }),
    });
  } catch (error) {
    operationError = error;
  }
  let cleanupError: unknown;
  try {
    await releaseSessionUntilDeadline({ session, releaseSession, timeoutMs: cleanupTimeoutMs });
  } catch (error) {
    cleanupError = error;
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
  if (result === undefined) throw new Error('Wesh Worker file probe produced no result.');
  return result;
}

function zeroDiagnostics(): StandaloneWorkerNameDiagnostics {
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

function diagnosticDelta({ before, after }: {
  before: StandaloneWorkerNameDiagnostics,
  after: StandaloneWorkerNameDiagnostics,
}): DiagnosticDelta {
  return {
    workersCreated: after.workersCreated - before.workersCreated,
    workersTerminated: after.workersTerminated - before.workersTerminated,
    activeWorkers: after.activeWorkers - before.activeWorkers,
    initializationAttempts: after.initializationAttempts - before.initializationAttempts,
    initializationSuccesses: after.initializationSuccesses - before.initializationSuccesses,
    initializationFailures: after.initializationFailures - before.initializationFailures,
    initializationTimeouts: after.initializationTimeouts - before.initializationTimeouts,
  };
}

async function verifyWithDependencies({
  createHighlightSession,
  createWeshSession,
  readDiagnostics,
  runHighlightProbe,
  runWeshProbe,
  releaseHighlightSession,
  releaseWeshSession,
  creationTimeoutMs,
  operationTimeoutMs,
  cleanupTimeoutMs,
}: {
  createHighlightSession: () => Promise<DebugFileProtocolStandaloneWorkerSession<IHighlightWorker>>,
  createWeshSession: () => Promise<DebugFileProtocolStandaloneWorkerSession<IWeshWorker>>,
  readDiagnostics: () => StandaloneWorkerRuntimeDiagnostics,
  runHighlightProbe: typeof runHighlightProbeWithSession,
  runWeshProbe: ({ session }: { session: DebugFileProtocolStandaloneWorkerSession<IWeshWorker> }) => Promise<DebugFileProtocolStandaloneWeshCommandProbeResult>,
  releaseHighlightSession: ReleaseSession<IHighlightWorker>,
  releaseWeshSession: ReleaseSession<IWeshWorker>,
  creationTimeoutMs: number,
  operationTimeoutMs: number,
  cleanupTimeoutMs: number,
}): Promise<DebugFileProtocolStandaloneWorkerVerificationResult> {
  const diagnosticsBefore = readDiagnostics();
  const concurrentSessions = await createConcurrentHighlightSessions({
    createSession: createHighlightSession,
    releaseSession: releaseHighlightSession,
    creationTimeoutMs,
    cleanupTimeoutMs,
  });
  const concurrentOutcomes = await Promise.allSettled(concurrentSessions.map((session, index) => runHighlightProbeAndCleanup({
    session,
    source: `{"probe":"concurrent-${index === 0 ? 'a' : 'b'}"}`,
    runProbe: runHighlightProbe,
    releaseSession: releaseHighlightSession,
    operationTimeoutMs,
    cleanupTimeoutMs,
  })));
  const concurrentFailure = concurrentOutcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
  if (concurrentFailure) throw concurrentFailure.reason;
  const concurrentHighlights = concurrentOutcomes.map((outcome) => {
    switch (outcome.status) {
    case 'fulfilled':
      return outcome.value;
    case 'rejected':
      throw outcome.reason;
    default: {
      const _ex: never = outcome;
      throw new Error(`Unhandled Promise outcome: ${String(_ex)}`);
    }
    }
  });

  const recreatedHighlightSession = await createSessionUntilDeadline({
    createSession: createHighlightSession,
    releaseSession: releaseHighlightSession,
    creationTimeoutMs,
    cleanupTimeoutMs,
    label: 'Recreated Highlight Worker session creation',
  });
  const recreatedWorkerHighlight = await runHighlightProbeAndCleanup({
    session: recreatedHighlightSession,
    source: '{"probe":"recreated-after-terminate"}',
    runProbe: runHighlightProbe,
    releaseSession: releaseHighlightSession,
    operationTimeoutMs,
    cleanupTimeoutMs,
  });

  const weshSession = await createSessionUntilDeadline({
    createSession: createWeshSession,
    releaseSession: releaseWeshSession,
    creationTimeoutMs,
    cleanupTimeoutMs,
    label: 'Wesh Worker session creation',
  });
  const weshCommandProbe = await runWeshProbeAndCleanup({
    session: weshSession,
    runProbe: runWeshProbe,
    releaseSession: releaseWeshSession,
    operationTimeoutMs,
    cleanupTimeoutMs,
  });
  const diagnosticsAfter = readDiagnostics();
  return {
    diagnosticsBefore,
    diagnosticsAfter,
    diagnosticDeltas: diagnosticDelta({ before: diagnosticsBefore, after: diagnosticsAfter }),
    workerDeltas: {
      highlight: diagnosticDelta({
        before: diagnosticsBefore.workersByName[highlightWorkerName] ?? zeroDiagnostics(),
        after: diagnosticsAfter.workersByName[highlightWorkerName] ?? zeroDiagnostics(),
      }),
      wesh: diagnosticDelta({
        before: diagnosticsBefore.workersByName[weshWorkerName] ?? zeroDiagnostics(),
        after: diagnosticsAfter.workersByName[weshWorkerName] ?? zeroDiagnostics(),
      }),
    },
    concurrentHighlights,
    recreatedWorkerHighlight,
    weshCommandProbe,
  };
}

export async function debugVerifyFileProtocolStandaloneWorkerFactory(): Promise<DebugFileProtocolStandaloneWorkerVerificationResult> {
  return verifyWithDependencies({
    createHighlightSession: () => createSession<IHighlightWorker>({
      label: 'Highlight Worker creation',
      createWorker: () => createHighlightWorker(),
    }),
    createWeshSession: () => createSession<IWeshWorker>({
      label: 'Wesh Worker creation',
      createWorker: () => createWeshWorker(),
    }),
    readDiagnostics: debugGetStandaloneWorkerRuntimeDiagnostics,
    runHighlightProbe: runHighlightProbeWithSession,
    runWeshProbe: ({ session }) => runWeshCommandProbeWithRemote({ wesh: session.remote }),
    releaseHighlightSession: releaseAndTerminateSession,
    releaseWeshSession: releaseAndTerminateSession,
    creationTimeoutMs: sessionCreationDeadlineMs,
    operationTimeoutMs: operationDeadlineMs,
    cleanupTimeoutMs: cleanupDeadlineMs,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  createSessionUntilDeadline,
  createConcurrentHighlightSessions,
  releaseAndTerminateSession,
  runWeshCommandProbeWithRemote,
  verifyWithDependencies,
};
