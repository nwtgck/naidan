import * as Comlink from 'comlink';
import { createHizoFSBenchmarkWorkerClientBoundary } from '@/features/debug-hizofs/benchmark/worker-client';
import type { HizoFSBenchmarkWorkerClient, IHizoFSBenchmarkWorker } from '@/features/debug-hizofs/benchmark/worker-client';
import { createFileProtocolStandaloneWorkerHub } from '@/features/file-protocol-standalone/worker/worker-hub-standalone-loader';
import type { IWorkerHub } from '@/features/file-protocol-standalone/worker/worker-hub.types';

export async function createHizoFSBenchmarkWorkerClient(): Promise<HizoFSBenchmarkWorkerClient> {
  const worker = await createFileProtocolStandaloneWorkerHub();
  const remoteHub = Comlink.wrap<IWorkerHub>(worker);
  const remote = await remoteHub.hizoFSBenchmark as Comlink.Remote<IHizoFSBenchmarkWorker>;
  return createBenchmarkClient({
    remote,
    release: async () => await remoteHub[Comlink.releaseProxy](),
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
