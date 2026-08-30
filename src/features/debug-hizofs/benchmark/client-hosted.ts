import { HIZOFS_BENCHMARK_WORKER_NAME } from '@/constants';
import { createHizoFSBenchmarkWorkerClientBoundary } from '@/features/debug-hizofs/benchmark/worker-client';
import type { HizoFSBenchmarkWorkerClient, IHizoFSBenchmarkWorker } from '@/features/debug-hizofs/benchmark/worker-client';
import { releaseWorkerRemote, workerProxy, wrapWorkerRemote, type WorkerRemote } from '@/utils/worker-transport';

export async function createHizoFSBenchmarkWorkerClient(): Promise<HizoFSBenchmarkWorkerClient> {
  const worker = new Worker(new URL('./worker-entry.ts', import.meta.url), {
    type: 'module',
    name: HIZOFS_BENCHMARK_WORKER_NAME,
  });
  const remote = wrapWorkerRemote<IHizoFSBenchmarkWorker>({ endpoint: worker });
  return createBenchmarkClient({
    remote,
    release: async () => {
      await releaseWorkerRemote({ remote });
    },
    terminate: () => worker.terminate(),
  });
}

function createBenchmarkClient({ remote, release, terminate }: {
  remote: WorkerRemote<IHizoFSBenchmarkWorker>;
  release: () => Promise<void>;
  terminate: () => void;
}): HizoFSBenchmarkWorkerClient {
  return createHizoFSBenchmarkWorkerClientBoundary({
    release,
    remote,
    terminateWorker: terminate,
    wrapProgressCallback: ({ callback }) => workerProxy({ value: callback }),
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  createBenchmarkClient,
};
