import { createProductionHizoFSBenchmarkRuntimePort } from '@/features/debug-hizofs/benchmark/production-runtime-port';
import { createHizoFSBenchmarkWorker } from '@/features/debug-hizofs/benchmark/worker-impl';
import type { IHizoFSBenchmarkWorker } from '@/features/debug-hizofs/benchmark/worker-client';
import { exposeWorkerRemote } from '@/utils/worker-transport';

exposeWorkerRemote<IHizoFSBenchmarkWorker>({
  api: createHizoFSBenchmarkWorker({
    runtimePort: createProductionHizoFSBenchmarkRuntimePort(),
  }),
  endpoint: undefined,
});

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
