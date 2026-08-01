import * as Comlink from 'comlink';
import { createProductionHizoFSBenchmarkRuntimePort } from '@/features/debug-hizofs/benchmark/production-runtime-port';
import { createHizoFSBenchmarkWorker } from '@/features/debug-hizofs/benchmark/worker-impl';

Comlink.expose(createHizoFSBenchmarkWorker({
  runtimePort: createProductionHizoFSBenchmarkRuntimePort(),
}));

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
