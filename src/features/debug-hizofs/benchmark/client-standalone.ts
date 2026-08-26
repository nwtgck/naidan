import * as Comlink from 'comlink';
import { createStandaloneWorker } from 'virtual:file-protocol-standalone/worker/hizofs-benchmark';
import { createHizoFSBenchmarkWorkerClientBoundary } from '@/features/debug-hizofs/benchmark/worker-client';
import type { HizoFSBenchmarkWorkerClient, IHizoFSBenchmarkWorker } from '@/features/debug-hizofs/benchmark/worker-client';
import {
  createStandaloneWorkerSession,
  disposeStandaloneWorkerSession,
  STANDALONE_WORKER_CLEANUP_TIMEOUT_MS,
} from '@/features/file-protocol-standalone/worker/standalone-worker-session';

export async function createHizoFSBenchmarkWorkerClient(): Promise<HizoFSBenchmarkWorkerClient> {
  const session = await createStandaloneWorkerSession<IHizoFSBenchmarkWorker>({
    createWorker: createStandaloneWorker,
  });
  let physicallyTerminated = false;
  return createBenchmarkClient({
    remote: session.remote,
    release: async () => {
      try {
        await disposeStandaloneWorkerSession({
          session,
          beforeRelease: undefined,
          cleanupTimeoutMs: STANDALONE_WORKER_CLEANUP_TIMEOUT_MS,
        });
      } finally {
        physicallyTerminated = true;
      }
    },
    terminate: () => {
      if (physicallyTerminated) return;
      physicallyTerminated = true;
      session.worker.terminate();
    },
  });
}

function createBenchmarkClient({ remote, release, terminate }: {
  remote: Comlink.Remote<IHizoFSBenchmarkWorker>;
  release: () => Promise<void>;
  terminate: () => void;
}): HizoFSBenchmarkWorkerClient {
  return createHizoFSBenchmarkWorkerClientBoundary({
    release,
    remote: remote as unknown as IHizoFSBenchmarkWorker,
    terminateWorker: terminate,
    wrapProgressCallback: ({ callback }) => Comlink.proxy(callback),
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  createBenchmarkClient,
};
