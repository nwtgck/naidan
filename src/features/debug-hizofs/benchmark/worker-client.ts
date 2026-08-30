import {
  hizoFSBenchmarkConfigurationSchema,
  hizoFSBenchmarkProgressSchema,
  hizoFSBenchmarkReportSchema,
} from "@/features/debug-hizofs/benchmark/types";
import type {
  HizoFSBenchmarkConfiguration,
  HizoFSBenchmarkProgress,
  HizoFSBenchmarkReport,
} from "@/features/debug-hizofs/benchmark/types";
import type { WorkerProxy, WorkerRemote } from '@/utils/worker-transport';

type HizoFSBenchmarkProgressCallback = ({ progress }: { progress: HizoFSBenchmarkProgress }) => void;

export interface IHizoFSBenchmarkWorker {
  cancelCurrentOperation(): Promise<void>;
  cleanBenchmarkData(): Promise<void>;

  // Comlink boundary: progress callbacks must be passed as top-level proxy arguments.
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink proxy callbacks cannot be nested in the request object.
  runBenchmark(
    configuration: HizoFSBenchmarkConfiguration,
    onProgress: WorkerProxy<HizoFSBenchmarkProgressCallback>,
  ): Promise<HizoFSBenchmarkReport>;
}

export interface HizoFSBenchmarkWorkerClient {
  cancelCurrentOperation(): Promise<void>;
  cleanBenchmarkData(): Promise<void>;
  dispose(): Promise<void>;
  terminate(): void;
  runBenchmark({ configuration, onProgress }: {
    configuration: HizoFSBenchmarkConfiguration;
    onProgress: ({ progress }: { progress: HizoFSBenchmarkProgress }) => void;
  }): Promise<HizoFSBenchmarkReport>;
}


export function createHizoFSBenchmarkWorkerClientBoundary({
  release,
  remote,
  terminateWorker,
  wrapProgressCallback,
}: {
  release: () => Promise<void>;
  remote: WorkerRemote<IHizoFSBenchmarkWorker>;
  terminateWorker: () => void;
  wrapProgressCallback: ({ callback }: { callback: HizoFSBenchmarkProgressCallback }) => WorkerProxy<HizoFSBenchmarkProgressCallback>;
}): HizoFSBenchmarkWorkerClient {
  let terminated = false;
  let resolveTermination!: () => void;
  const termination = new Promise<void>(resolve => {
    resolveTermination = resolve;
  });
  const forceTerminate = (): void => {
    if (terminated) return;
    terminated = true;
    terminateWorker();
    resolveTermination();
  };
  const raceTermination = async <Value>({ operation }: { operation: Promise<Value> }): Promise<Value> => await Promise.race([
    operation,
    termination.then<never>(() => {
      throw new DOMException("benchmark Worker terminated", "AbortError");
    }),
  ]);

  return {
    async runBenchmark({ configuration, onProgress }) {
      return hizoFSBenchmarkReportSchema.parse(await raceTermination({ operation: remote.runBenchmark(
        hizoFSBenchmarkConfigurationSchema.parse(configuration),
        wrapProgressCallback({ callback: ({ progress }) => onProgress({
          progress: hizoFSBenchmarkProgressSchema.parse(progress),
        }) }),
      ) }));
    },
    async cleanBenchmarkData() {
      await raceTermination({ operation: remote.cleanBenchmarkData() });
    },
    async cancelCurrentOperation() {
      await raceTermination({ operation: remote.cancelCurrentOperation() });
    },
    async dispose() {
      if (terminated) return;
      try {
        await raceTermination({ operation: release() });
      } finally {
        forceTerminate();
      }
    },
    terminate: forceTerminate,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  createHizoFSBenchmarkWorkerClientBoundary,
};
