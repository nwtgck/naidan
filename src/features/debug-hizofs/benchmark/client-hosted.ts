import * as Comlink from 'comlink';
import { HIZOFS_BENCHMARK_WORKER_NAME } from '@/constants';
import {
  hizoFSBenchmarkConfigurationSchema,
  hizoFSBenchmarkProgressSchema,
  hizoFSBenchmarkReportSchema,
} from '@/features/debug-hizofs/benchmark/types';
import type {
  HizoFSBenchmarkWorkerClient,
  IHizoFSBenchmarkWorker,
} from '@/features/debug-hizofs/benchmark/worker-client';

export async function createHizoFSBenchmarkWorkerClient(): Promise<HizoFSBenchmarkWorkerClient> {
  const worker = new Worker(new URL('./worker-entry.ts', import.meta.url), {
    type: 'module',
    name: HIZOFS_BENCHMARK_WORKER_NAME,
  });
  const remote = Comlink.wrap<IHizoFSBenchmarkWorker>(worker);
  const release = async (): Promise<void> => {
    try {
      await remote[Comlink.releaseProxy]();
    } finally {
      worker.terminate();
    }
  };
  return createBenchmarkClient({ remote, release });
}

function createBenchmarkClient({ remote, release }: {
  remote: Comlink.Remote<IHizoFSBenchmarkWorker>;
  release: () => Promise<void>;
}): HizoFSBenchmarkWorkerClient {
  return {
    async runBenchmark({ configuration, onProgress }) {
      return hizoFSBenchmarkReportSchema.parse(await remote.runBenchmark(
        hizoFSBenchmarkConfigurationSchema.parse(configuration),
        Comlink.proxy(({ progress }) => onProgress({
          progress: hizoFSBenchmarkProgressSchema.parse(progress),
        })),
      ));
    },
    async cleanBenchmarkData() {
      await remote.cleanBenchmarkData();
    },
    async cancelCurrentOperation() {
      await remote.cancelCurrentOperation();
    },
    dispose: release,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  createBenchmarkClient,
};
