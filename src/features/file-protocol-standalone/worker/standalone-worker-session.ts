import {
  releaseWorkerRemote,
  wrapWorkerRemote,
  type WorkerRemote,
} from '@/utils/worker-transport';

export type StandaloneWorkerSession<Api extends object> = Readonly<{
  worker: Worker,
  remote: WorkerRemote<Api>,
}>;

export const STANDALONE_WORKER_CLEANUP_TIMEOUT_MS = 3_000;

async function runCleanupStep({
  operation,
  timeoutMs,
  label,
}: {
  operation: () => Promise<unknown> | unknown,
  timeoutMs: number,
  label: string,
}): Promise<void> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

export async function createStandaloneWorkerSession<Api extends object>({
  createWorker,
}: {
  createWorker: () => Promise<Worker>,
}): Promise<StandaloneWorkerSession<Api>> {
  const worker = await createWorker();
  try {
    return {
      worker,
      remote: wrapWorkerRemote<Api>({ endpoint: worker }),
    };
  } catch (error) {
    worker.terminate();
    throw error;
  }
}

const disposalPromises = new WeakMap<object, Promise<void>>();

async function disposeStandaloneWorkerSessionOnce<Api extends object>({
  session,
  beforeRelease,
  cleanupTimeoutMs,
}: {
  session: StandaloneWorkerSession<Api>,
  beforeRelease: (() => Promise<unknown> | unknown) | undefined,
  cleanupTimeoutMs: number,
}): Promise<void> {
  const errors: unknown[] = [];
  try {
    if (beforeRelease !== undefined) {
      try {
        await runCleanupStep({
          operation: beforeRelease,
          timeoutMs: cleanupTimeoutMs,
          label: 'Standalone Worker logical cleanup',
        });
      } catch (error) {
        errors.push(error);
      }
    }

    try {
      await runCleanupStep({
        operation: () => releaseWorkerRemote({ remote: session.remote }),
        timeoutMs: cleanupTimeoutMs,
        label: 'Standalone Worker Comlink release',
      });
    } catch (error) {
      errors.push(error);
    }
  } finally {
    session.worker.terminate();
  }

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Standalone Worker cleanup failed');
}

export function disposeStandaloneWorkerSession<Api extends object>({
  session,
  beforeRelease,
  cleanupTimeoutMs,
}: {
  session: StandaloneWorkerSession<Api>,
  beforeRelease: (() => Promise<unknown> | unknown) | undefined,
  cleanupTimeoutMs: number,
}): Promise<void> {
  const existingDisposal = disposalPromises.get(session);
  if (existingDisposal !== undefined) return existingDisposal;

  const disposal = disposeStandaloneWorkerSessionOnce({
    session,
    beforeRelease,
    cleanupTimeoutMs,
  });
  disposalPromises.set(session, disposal);
  return disposal;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
