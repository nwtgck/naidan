import * as Comlink from 'comlink';
import {
  hizoFSBenchmarkConfigurationSchema,
  hizoFSBenchmarkProgressSchema,
  hizoFSBenchmarkReportSchema,
} from '@/features/debug-hizofs/benchmark/types';
import type {
  HizoFSBenchmarkWorkerClient,
  IHizoFSBenchmarkWorker,
} from '@/features/debug-hizofs/benchmark/worker-client';
import { createFileProtocolStandaloneWorkerHub } from '@/features/file-protocol-standalone/worker/worker-hub-standalone-loader';
import type { IWorkerHub } from '@/features/file-protocol-standalone/worker/worker-hub.types';

export async function createHizoFSBenchmarkWorkerClient(): Promise<HizoFSBenchmarkWorkerClient> {
  const worker = await createFileProtocolStandaloneWorkerHub();
  const remoteHub = Comlink.wrap<IWorkerHub>(worker);
  const remote = await remoteHub.hizoFSBenchmark as Comlink.Remote<IHizoFSBenchmarkWorker>;
  const release = async (): Promise<void> => {
    try {
      await remoteHub[Comlink.releaseProxy]();
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
