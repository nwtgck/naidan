import type {
  HizoFSBenchmarkConfiguration,
  HizoFSBenchmarkProgress,
  HizoFSBenchmarkReport,
} from "@/features/debug-hizofs/benchmark/types";

export interface IHizoFSBenchmarkWorker {
  cancelCurrentOperation(): Promise<void>;
  cleanBenchmarkData(): Promise<void>;

  // Comlink boundary: progress callbacks must be passed as top-level proxy arguments.
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink proxy callbacks cannot be nested in the request object.
  runBenchmark(
    configuration: HizoFSBenchmarkConfiguration,
    onProgress: ({ progress }: { progress: HizoFSBenchmarkProgress }) => void,
  ): Promise<HizoFSBenchmarkReport>;
}

export interface HizoFSBenchmarkWorkerClient {
  cancelCurrentOperation(): Promise<void>;
  cleanBenchmarkData(): Promise<void>;
  dispose(): Promise<void>;
  runBenchmark({ configuration, onProgress }: {
    configuration: HizoFSBenchmarkConfiguration;
    onProgress: ({ progress }: { progress: HizoFSBenchmarkProgress }) => void;
  }): Promise<HizoFSBenchmarkReport>;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
