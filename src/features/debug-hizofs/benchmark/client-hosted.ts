import * as Comlink from 'comlink';
import { HIZOFS_BENCHMARK_WORKER_NAME } from '@/constants';
import { createHizoFSBenchmarkWorkerClientBoundary } from '@/features/debug-hizofs/benchmark/worker-client';
import type { HizoFSBenchmarkWorkerClient, IHizoFSBenchmarkWorker } from '@/features/debug-hizofs/benchmark/worker-client';

export async function createHizoFSBenchmarkWorkerClient(): Promise<HizoFSBenchmarkWorkerClient> {
  const worker = new Worker(new URL('./worker-entry.ts', import.meta.url), {
    type: 'module',
    name: HIZOFS_BENCHMARK_WORKER_NAME,
  });
  const remote = Comlink.wrap<IHizoFSBenchmarkWorker>(worker);
  return createBenchmarkClient({
    remote,
    release: async () => await remote[Comlink.releaseProxy](),
    terminate: () => worker.terminate(),
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
