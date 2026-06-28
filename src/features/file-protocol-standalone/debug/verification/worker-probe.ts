import * as Comlink from 'comlink';

import {
  createFileProtocolStandaloneWorkerHub,
  debugGetFileProtocolStandaloneWorkerHubDiagnostics,
} from '@/features/file-protocol-standalone/worker/worker-hub-standalone-loader';
import type { IWorkerHub } from '@/features/file-protocol-standalone/worker/worker-hub.types';
import type {
  IWeshWorker,
  WeshWorkerRemoteExecutionEvent,
} from '@/features/wesh/worker/types';
import type { DebugFileProtocolStandaloneWorkerDiagnostics } from 'virtual:file-protocol-standalone/worker/file-protocol-standalone-worker-hub';

export type DebugFileProtocolStandaloneHighlightProbeResult = Readonly<{
  resolvedLanguage: string,
  htmlLength: number,
}>;

export type DebugFileProtocolStandaloneWeshFileProbeResult = Readonly<{
  exitCode: number,
  stdout: string,
  stderr: string,
}>;

export type DebugFileProtocolStandaloneWorkerVerificationResult = Readonly<{
  diagnosticsBefore: DebugFileProtocolStandaloneWorkerDiagnostics,
  diagnosticsAfter: DebugFileProtocolStandaloneWorkerDiagnostics,
  diagnosticDeltas: Readonly<{
    workersCreated: number,
    workersTerminated: number,
    activeWorkers: number,
    registryScriptLoads: number,
    blobRegistrations: number,
    objectUrlsCreated: number,
  }>,
  concurrentHighlights: readonly DebugFileProtocolStandaloneHighlightProbeResult[],
  recreatedWorkerHighlight: DebugFileProtocolStandaloneHighlightProbeResult,
  weshFileProbe: DebugFileProtocolStandaloneWeshFileProbeResult,
}>;

export type DebugFileProtocolStandaloneWorkerHubSession = Readonly<{
  worker: Worker,
  remote: Comlink.Remote<IWorkerHub>,
}>;

const debugFileProtocolStandaloneWorkerSessionCreationDeadlineMs = 30_000;
const debugFileProtocolStandaloneWorkerOperationDeadlineMs = 30_000;
const debugFileProtocolStandaloneWorkerCleanupDeadlineMs = 5_000;

/**
 * Stop waiting at the deadline. This does not cancel the underlying operation;
 * resource-producing callers must arrange late cleanup explicitly.
 */
async function debugWaitForOperationUntilDeadline<Result>({
  label,
  timeoutMs,
  action,
}: {
  label: string,
  timeoutMs: number,
  action: () => Promise<Result>,
}): Promise<Result> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([action(), timeout]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

async function debugCreateFileProtocolStandaloneWorkerHubSession(): Promise<DebugFileProtocolStandaloneWorkerHubSession> {
  const worker = await createFileProtocolStandaloneWorkerHub();
  try {
    return {
      worker,
      remote: Comlink.wrap<IWorkerHub>(worker),
    };
  } catch (error) {
    worker.terminate();
    throw error;
  }
}

/** @internal Exported for Comlink lifecycle regression tests. */
export async function debugReleaseAndTerminateFileProtocolStandaloneWorkerHubSession({ session }: {
  session: DebugFileProtocolStandaloneWorkerHubSession,
}): Promise<void> {
  let releaseError: unknown | undefined;
  try {
    await debugWaitForOperationUntilDeadline({
      label: 'Standalone Worker Comlink proxy release',
      timeoutMs: debugFileProtocolStandaloneWorkerCleanupDeadlineMs,
      action: async () => {
        await session.remote[Comlink.releaseProxy]();
      },
    });
  } catch (error) {
    releaseError = error;
  } finally {
    // terminate() is idempotent in the standalone Worker wrapper. Always call it
    // even when a released or unresponsive Comlink endpoint never acknowledges.
    session.worker.terminate();
  }
  if (releaseError !== undefined) {
    throw releaseError;
  }
}

/** @internal Exported for Comlink lifecycle regression tests. */
export async function debugRunFileProtocolStandaloneHighlightProbe({ session, source }: {
  session: DebugFileProtocolStandaloneWorkerHubSession,
  source: string,
}): Promise<DebugFileProtocolStandaloneHighlightProbeResult> {
  const highlight = await session.remote.highlight;
  const result = await highlight.highlight({
    request: {
      code: source,
      language: 'json',
      mode: 'named-language',
    },
  });

  return {
    resolvedLanguage: result.resolvedLanguage,
    htmlLength: result.html.length,
  };
}

/** @internal Exported for Wesh lifecycle regression tests. */
export async function debugRunFileProtocolStandaloneWeshFileProbeWithRemote({ wesh }: {
  wesh: Comlink.Remote<IWeshWorker>,
}): Promise<DebugFileProtocolStandaloneWeshFileProbeResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const decoder = new TextDecoder();
  let executionId: string | undefined;
  let result: DebugFileProtocolStandaloneWeshFileProbeResult | undefined;
  let operationError: unknown | undefined;

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
    });

    const started = await wesh.startExecution(
      { script: 'file --mime-type /bin/sh' },
      Comlink.proxy((event: WeshWorkerRemoteExecutionEvent) => {
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
          const _ex: never = event;
          throw new Error(`Unhandled Wesh verification event: ${String(_ex)}`);
        }
        }
      }),
    );
    executionId = started.executionId;
    const summary = await wesh.awaitExecution({
      request: { executionId },
    });
    result = {
      exitCode: summary.exitCode,
      stdout: stdout.join(''),
      stderr: stderr.join(''),
    };
  } catch (error) {
    operationError = error;
  }

  let cleanupError: unknown | undefined;
  if (executionId !== undefined) {
    try {
      await wesh.disposeExecution({
        request: { executionId },
      });
    } catch (error) {
      cleanupError = error;
    }
  }
  try {
    await wesh.dispose();
  } catch (error) {
    cleanupError ??= error;
  }

  if (operationError !== undefined) {
    throw operationError;
  }
  if (cleanupError !== undefined) {
    throw cleanupError;
  }
  if (result === undefined) {
    throw new Error('Standalone Wesh file probe produced no result.');
  }
  return result;
}

/** @internal Exported for Comlink lifecycle regression tests. */
export async function debugRunFileProtocolStandaloneWeshFileProbe({ session }: {
  session: DebugFileProtocolStandaloneWorkerHubSession,
}): Promise<DebugFileProtocolStandaloneWeshFileProbeResult> {
  const wesh = await session.remote.wesh as unknown as Comlink.Remote<IWeshWorker>;
  return debugRunFileProtocolStandaloneWeshFileProbeWithRemote({ wesh });
}

async function debugReleaseAndTerminateSessionUntilDeadline({
  session,
  releaseSession,
  timeoutMs,
}: {
  session: DebugFileProtocolStandaloneWorkerHubSession,
  releaseSession: ({ session }: { session: DebugFileProtocolStandaloneWorkerHubSession }) => Promise<void>,
  timeoutMs: number,
}): Promise<void> {
  try {
    await debugWaitForOperationUntilDeadline({
      label: 'Standalone Worker session cleanup',
      timeoutMs,
      action: async () => releaseSession({ session }),
    });
  } catch (error) {
    // A dependency-injected cleanup can itself become permanently pending. Force
    // the physical Worker down so verification never leaks a live realm.
    session.worker.terminate();
    throw error;
  }
}

async function debugCreateSessionUntilDeadline({
  createSession,
  releaseSession,
  creationTimeoutMs,
  cleanupTimeoutMs,
  label,
}: {
  createSession: () => Promise<DebugFileProtocolStandaloneWorkerHubSession>,
  releaseSession: ({ session }: { session: DebugFileProtocolStandaloneWorkerHubSession }) => Promise<void>,
  creationTimeoutMs: number,
  cleanupTimeoutMs: number,
  label: string,
}): Promise<DebugFileProtocolStandaloneWorkerHubSession> {
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
      // Promise.race does not cancel Worker creation. If it completes after the
      // deadline, release the late session instead of leaking a live Worker.
      void creation.then(
        async (session) => {
          try {
            await debugReleaseAndTerminateSessionUntilDeadline({
              session,
              releaseSession,
              timeoutMs: cleanupTimeoutMs,
            });
          } catch {
            // debugReleaseAndTerminateSessionUntilDeadline already forces physical termination.
          }
        },
        () => undefined,
      );
    }
  }
}

async function debugCreateConcurrentWorkerHubSessions({
  createSession,
  releaseSession,
  sessionCreationTimeoutMs,
  cleanupTimeoutMs,
}: {
  createSession: () => Promise<DebugFileProtocolStandaloneWorkerHubSession>,
  releaseSession: ({ session }: { session: DebugFileProtocolStandaloneWorkerHubSession }) => Promise<void>,
  sessionCreationTimeoutMs: number,
  cleanupTimeoutMs: number,
}): Promise<readonly [DebugFileProtocolStandaloneWorkerHubSession, DebugFileProtocolStandaloneWorkerHubSession]> {
  const [first, second] = await Promise.allSettled([
    debugCreateSessionUntilDeadline({
      createSession,
      releaseSession,
      creationTimeoutMs: sessionCreationTimeoutMs,
      cleanupTimeoutMs,
      label: 'First standalone Worker session creation',
    }),
    debugCreateSessionUntilDeadline({
      createSession,
      releaseSession,
      creationTimeoutMs: sessionCreationTimeoutMs,
      cleanupTimeoutMs,
      label: 'Second standalone Worker session creation',
    }),
  ]);

  switch (first.status) {
  case 'fulfilled': {
    switch (second.status) {
    case 'fulfilled':
      return [first.value, second.value];
    case 'rejected':
      try {
        await debugReleaseAndTerminateSessionUntilDeadline({
          session: first.value,
          releaseSession,
          timeoutMs: cleanupTimeoutMs,
        });
      } catch {
        // Preserve the Worker creation failure as the primary diagnostic.
      }
      throw second.reason;
    default: {
      const _ex: never = second;
      throw new Error(`Unhandled second Worker session creation result: ${String(_ex)}`);
    }
    }
  }
  case 'rejected': {
    switch (second.status) {
    case 'fulfilled':
      try {
        await debugReleaseAndTerminateSessionUntilDeadline({
          session: second.value,
          releaseSession,
          timeoutMs: cleanupTimeoutMs,
        });
      } catch {
        // Preserve the Worker creation failure as the primary diagnostic.
      }
      throw first.reason;
    case 'rejected':
      throw first.reason;
    default: {
      const _ex: never = second;
      throw new Error(`Unhandled second Worker session creation result: ${String(_ex)}`);
    }
    }
  }
  default: {
    const _ex: never = first;
    throw new Error(`Unhandled first Worker session creation result: ${String(_ex)}`);
  }
  }
}

async function debugRunHighlightProbeAndCleanup({
  session,
  source,
  runRoundTrip,
  releaseSession,
  operationTimeoutMs,
  cleanupTimeoutMs,
}: {
  session: DebugFileProtocolStandaloneWorkerHubSession,
  source: string,
  runRoundTrip: ({ session, source }: {
    session: DebugFileProtocolStandaloneWorkerHubSession,
    source: string,
  }) => Promise<DebugFileProtocolStandaloneHighlightProbeResult>,
  releaseSession: ({ session }: { session: DebugFileProtocolStandaloneWorkerHubSession }) => Promise<void>,
  operationTimeoutMs: number,
  cleanupTimeoutMs: number,
}): Promise<DebugFileProtocolStandaloneHighlightProbeResult> {
  let result: DebugFileProtocolStandaloneHighlightProbeResult | undefined;
  let operationError: unknown | undefined;
  try {
    result = await debugWaitForOperationUntilDeadline({
      label: 'Standalone Worker highlight probe',
      timeoutMs: operationTimeoutMs,
      action: async () => runRoundTrip({ session, source }),
    });
  } catch (error) {
    operationError = error;
  }

  let cleanupError: unknown | undefined;
  try {
    await debugReleaseAndTerminateSessionUntilDeadline({
      session,
      releaseSession,
      timeoutMs: cleanupTimeoutMs,
    });
  } catch (error) {
    cleanupError = error;
  }

  if (operationError !== undefined) {
    throw operationError;
  }
  if (cleanupError !== undefined) {
    throw cleanupError;
  }
  if (result === undefined) {
    throw new Error('Standalone Worker highlight probe produced no result.');
  }
  return result;
}

export async function debugVerifyFileProtocolStandaloneWorkerFactoryWithDependencies({
  createSession,
  readDiagnostics,
  runRoundTrip,
  runFileProbe,
  releaseSession,
  sessionCreationTimeoutMs,
  operationTimeoutMs,
  cleanupTimeoutMs,
}: {
  createSession: () => Promise<DebugFileProtocolStandaloneWorkerHubSession>,
  readDiagnostics: () => DebugFileProtocolStandaloneWorkerDiagnostics,
  runRoundTrip: ({ session, source }: {
    session: DebugFileProtocolStandaloneWorkerHubSession,
    source: string,
  }) => Promise<DebugFileProtocolStandaloneHighlightProbeResult>,
  runFileProbe: ({ session }: {
    session: DebugFileProtocolStandaloneWorkerHubSession,
  }) => Promise<DebugFileProtocolStandaloneWeshFileProbeResult>,
  releaseSession: ({ session }: { session: DebugFileProtocolStandaloneWorkerHubSession }) => Promise<void>,
  sessionCreationTimeoutMs: number,
  operationTimeoutMs: number,
  cleanupTimeoutMs: number,
}): Promise<DebugFileProtocolStandaloneWorkerVerificationResult> {
  const diagnosticsBefore = readDiagnostics();
  const concurrentSessions = await debugCreateConcurrentWorkerHubSessions({
    createSession,
    releaseSession,
    sessionCreationTimeoutMs,
    cleanupTimeoutMs,
  });
  const concurrentOutcomes = await Promise.allSettled([
    debugRunHighlightProbeAndCleanup({
      session: concurrentSessions[0],
      source: '{"probe":"concurrent-a"}',
      runRoundTrip,
      releaseSession,
      operationTimeoutMs,
      cleanupTimeoutMs,
    }),
    debugRunHighlightProbeAndCleanup({
      session: concurrentSessions[1],
      source: '{"probe":"concurrent-b"}',
      runRoundTrip,
      releaseSession,
      operationTimeoutMs,
      cleanupTimeoutMs,
    }),
  ]);

  for (const outcome of concurrentOutcomes) {
    switch (outcome.status) {
    case 'fulfilled':
      break;
    case 'rejected':
      throw outcome.reason;
    default: {
      const _ex: never = outcome;
      throw new Error(`Unhandled concurrent Worker probe result: ${String(_ex)}`);
    }
    }
  }

  const concurrent = concurrentOutcomes.map((outcome) => {
    switch (outcome.status) {
    case 'fulfilled':
      return outcome.value;
    case 'rejected':
      throw outcome.reason;
    default: {
      const _ex: never = outcome;
      throw new Error(`Unhandled concurrent Worker probe result: ${String(_ex)}`);
    }
    }
  });

  const recreatedSession = await debugCreateSessionUntilDeadline({
    createSession,
    releaseSession,
    creationTimeoutMs: sessionCreationTimeoutMs,
    cleanupTimeoutMs,
    label: 'Recreated standalone Worker session creation',
  });
  let recreatedWorkerHighlight: DebugFileProtocolStandaloneHighlightProbeResult | undefined;
  let weshFileProbe: DebugFileProtocolStandaloneWeshFileProbeResult | undefined;
  let operationError: unknown | undefined;
  try {
    recreatedWorkerHighlight = await debugWaitForOperationUntilDeadline({
      label: 'Recreated standalone Worker highlight probe',
      timeoutMs: operationTimeoutMs,
      action: async () => runRoundTrip({
        session: recreatedSession,
        source: '{"probe":"recreated-after-terminate"}',
      }),
    });
    weshFileProbe = await debugWaitForOperationUntilDeadline({
      label: 'Recreated standalone Worker Wesh file probe',
      timeoutMs: operationTimeoutMs,
      action: async () => runFileProbe({ session: recreatedSession }),
    });
  } catch (error) {
    operationError = error;
  }

  let cleanupError: unknown | undefined;
  try {
    await debugReleaseAndTerminateSessionUntilDeadline({
      session: recreatedSession,
      releaseSession,
      timeoutMs: cleanupTimeoutMs,
    });
  } catch (error) {
    cleanupError = error;
  }

  if (operationError !== undefined) {
    throw operationError;
  }
  if (cleanupError !== undefined) {
    throw cleanupError;
  }
  if (recreatedWorkerHighlight === undefined || weshFileProbe === undefined) {
    throw new Error('Recreated standalone Worker verification produced no result.');
  }

  const diagnosticsAfter = readDiagnostics();
  return {
    diagnosticsBefore,
    diagnosticsAfter,
    diagnosticDeltas: {
      workersCreated: diagnosticsAfter.workersCreated - diagnosticsBefore.workersCreated,
      workersTerminated: diagnosticsAfter.workersTerminated - diagnosticsBefore.workersTerminated,
      activeWorkers: diagnosticsAfter.activeWorkers - diagnosticsBefore.activeWorkers,
      registryScriptLoads: diagnosticsAfter.registryScriptLoads - diagnosticsBefore.registryScriptLoads,
      blobRegistrations: diagnosticsAfter.blobRegistrations - diagnosticsBefore.blobRegistrations,
      objectUrlsCreated: diagnosticsAfter.objectUrlsCreated - diagnosticsBefore.objectUrlsCreated,
    },
    concurrentHighlights: concurrent,
    recreatedWorkerHighlight,
    weshFileProbe,
  };
}

/**
 * Create isolated Worker sessions from the same page-lifetime Blob URL. Each
 * session owns one Comlink root proxy for its full lifetime. The recreated
 * session intentionally runs highlight and Wesh through that same proxy before
 * releasing it, which guards against reusing a Worker after Comlink RELEASE.
 */
export async function debugVerifyFileProtocolStandaloneWorkerFactory(): Promise<DebugFileProtocolStandaloneWorkerVerificationResult> {
  return debugVerifyFileProtocolStandaloneWorkerFactoryWithDependencies({
    createSession: debugCreateFileProtocolStandaloneWorkerHubSession,
    readDiagnostics: debugGetFileProtocolStandaloneWorkerHubDiagnostics,
    runRoundTrip: debugRunFileProtocolStandaloneHighlightProbe,
    runFileProbe: debugRunFileProtocolStandaloneWeshFileProbe,
    releaseSession: debugReleaseAndTerminateFileProtocolStandaloneWorkerHubSession,
    sessionCreationTimeoutMs: debugFileProtocolStandaloneWorkerSessionCreationDeadlineMs,
    operationTimeoutMs: debugFileProtocolStandaloneWorkerOperationDeadlineMs,
    cleanupTimeoutMs: debugFileProtocolStandaloneWorkerCleanupDeadlineMs,
  });
}
