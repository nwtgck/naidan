import {
  cleanHizoFSBenchmarkData,
  runHizoFSBenchmark,
} from '@/features/debug-hizofs/benchmark/engine';
import {
  hizoFSBenchmarkConfigurationSchema,
  hizoFSBenchmarkProgressSchema,
  hizoFSBenchmarkReportSchema,
} from '@/features/debug-hizofs/benchmark/types';
import type { IHizoFSBenchmarkWorker } from '@/features/debug-hizofs/benchmark/worker-client';
import type { HizoFSBenchmarkRuntimePort } from '@/features/debug-hizofs/benchmark/runtime-port';
import type { WorkerServerApi } from '@/utils/worker-transport';

/**
 * Owns cancellation for benchmark operations without retaining an Inspector,
 * decrypted filesystem handle, credential, or root-key capability.
 *
 * The generation check is deliberately local to this Worker. A cancellation
 * request invalidates every callback held by the current run, while a later
 * run receives a distinct generation and cannot be cancelled by stale UI.
 */
export function createHizoFSBenchmarkWorker({ runtimePort }: {
  readonly runtimePort: HizoFSBenchmarkRuntimePort;
}): WorkerServerApi<IHizoFSBenchmarkWorker> {
  let operationGeneration = 0;

  function beginOperation(): { readonly generation: number } {
    operationGeneration += 1;
    return { generation: operationGeneration };
  }

  function assertOperationActive({ generation }: { readonly generation: number }): void {
    if (generation !== operationGeneration) {
      throw new DOMException('HizoFS benchmark operation was cancelled', 'AbortError');
    }
  }

  return {
    // Comlink boundary: progress callbacks must be passed as top-level proxy arguments.
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements the positional Comlink boundary declared by IHizoFSBenchmarkWorker.
    async runBenchmark(configuration, onProgress) {
      const operation = beginOperation();
      return hizoFSBenchmarkReportSchema.parse(await runHizoFSBenchmark({
        configuration: hizoFSBenchmarkConfigurationSchema.parse(configuration),
        onProgress: ({ progress }) => onProgress({
          progress: hizoFSBenchmarkProgressSchema.parse(progress),
        }),
        assertActive: () => assertOperationActive(operation),
        nativeOpfsRoot: undefined,
        runtimePort,
      }));
    },

    async cleanBenchmarkData() {
      await cleanHizoFSBenchmarkData({ nativeOpfsRoot: undefined });
    },

    async cancelCurrentOperation() {
      operationGeneration += 1;
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
