import { logFailure } from '@/features/llama-cpp-browser/debug-log';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';
import { verifySharedStorage } from '@/features/llama-cpp-browser/runtime/shared-storage-probe';
import { createStandaloneWorker } from 'virtual:file-protocol-standalone/worker/llama-cpp-browser-download';
import { createStandaloneWorkerSession, disposeStandaloneWorkerSession, STANDALONE_WORKER_CLEANUP_TIMEOUT_MS } from '@/features/file-protocol-standalone/worker/standalone-worker-session';
import type { DownloadWriterApi } from './writer';
import type { DownloadWriterClient } from './writer-client';

export async function createDownloadWriterClient({ signal }: { signal: AbortSignal }): Promise<DownloadWriterClient> {
  if (signal.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
  const start = async (): Promise<DownloadWriterClient> => {
    const session = await createStandaloneWorkerSession<DownloadWriterApi>({ createWorker: createStandaloneWorker });
    try {
      await verifySharedStorage({ verify: ({ probeId }) => session.remote.verifyStorage({ probeId }), signal });
    } catch (error) {
      await disposeStandaloneWorkerSession({ session, beforeRelease: undefined, cleanupTimeoutMs: STANDALONE_WORKER_CLEANUP_TIMEOUT_MS })
        .catch(cleanupError => logFailure({ stage: 'cleanup', error: cleanupError }));
      throw error;
    }
    return {
      ...session,
      dispose: ({ beforeRelease }) => disposeStandaloneWorkerSession({
        session, beforeRelease, cleanupTimeoutMs: STANDALONE_WORKER_CLEANUP_TIMEOUT_MS,
      }),
    };
  };
  const starting = start();
  const cancellation = Promise.withResolvers<never>();
  const abort = (): void => cancellation.reject(new LlamaCppBrowserError({ code: 'aborted' }));
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  let handedOff = false;
  try {
    const client = await Promise.race([starting, cancellation.promise]);
    // Cancellation can win after startup settles but before this continuation.
    if (signal.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
    handedOff = true;
    return client;
  } finally {
    signal.removeEventListener('abort', abort);
    if (!handedOff) {
      // Do not keep a cancelled download/repository lock waiting for bootstrap.
      // A late successful startup still owns a Worker and must retire it.
      void starting.then(
        client => client.dispose({ beforeRelease: undefined }).catch(error => logFailure({ stage: 'cleanup', error })),
        () => {}, // Failed startup already cleaned up its session above.
      );
    }
  }
}
export const TEST_ONLY = {
};
