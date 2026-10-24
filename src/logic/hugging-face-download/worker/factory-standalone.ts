import { createStandaloneWorker } from 'virtual:file-protocol-standalone/worker/file-download';
import { createStandaloneWorkerSession, disposeStandaloneWorkerSession, STANDALONE_WORKER_CLEANUP_TIMEOUT_MS } from '@/features/file-protocol-standalone/worker/standalone-worker-session';
import { verifySharedStorage } from '@/features/llama-cpp-browser/runtime/shared-storage-probe';
import { awaitInspection } from '@/logic/model-file-inspection/abort';
import type { FileDownloadSession } from './factory';
import type { FileDownloadWorker } from './types';

export async function createFileDownloadSession({ signal }: { signal: AbortSignal }): Promise<FileDownloadSession> {
  signal.throwIfAborted();
  const starting = createStandaloneWorkerSession<FileDownloadWorker>({ createWorker: createStandaloneWorker });
  let handedOff = false;
  try {
    const session = await awaitInspection({ task: starting, signal });
    await verifySharedStorage({ verify: ({ probeId }) => session.remote.verifyStorage({ probeId }), signal });
    signal.throwIfAborted();
    handedOff = true;
    return {
      ...session,
      dispose: () => disposeStandaloneWorkerSession({ session, beforeRelease: undefined, cleanupTimeoutMs: STANDALONE_WORKER_CLEANUP_TIMEOUT_MS }),
    };
  } finally {
    if (!handedOff) {
      // A late bootstrap still owns a physical Worker even after cancellation wins.
      void starting.then(session => disposeStandaloneWorkerSession({ session, beforeRelease: undefined, cleanupTimeoutMs: STANDALONE_WORKER_CLEANUP_TIMEOUT_MS })).catch(() => undefined);
    }
  }
}

export const TEST_ONLY = {
};
