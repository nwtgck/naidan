import { createBrowserHizoFSBenchmarkApplicationRuntime } from '@/00-storage/service/hizofs/worker-entry';
import type {
  HizoFSBenchmarkRuntime,
  HizoFSBenchmarkRuntimeDiagnostics,
  HizoFSBenchmarkRuntimePort,
} from '@/features/debug-hizofs/benchmark/runtime-port';

function unavailableRuntimeDiagnostics({ resetHighWaterMarks }: { readonly resetHighWaterMarks: () => void }): HizoFSBenchmarkRuntimeDiagnostics {
  return {
    snapshot: () => ({
      schemaVersion: 3,
      type: 'unavailable',
      reason: 'production HizoFS runtime counters are not instrumented',
    }),
    resetResourceHighWaterMarks: resetHighWaterMarks,
  };
}

/**
 * Adapts the product-owned isolated HizoFS composition to the debug benchmark.
 * Unsupported diagnostics stay explicitly unavailable rather than becoming
 * synthetic zero measurements.
 */
export function createProductionHizoFSBenchmarkRuntimePort(): HizoFSBenchmarkRuntimePort {
  return {
    async createRuntime({ backingDirectory }) {
      const applicationRuntime = await createBrowserHizoFSBenchmarkApplicationRuntime({
        backingDirectory,
      });
      const runtime: HizoFSBenchmarkRuntime = {
        get session() {
          return applicationRuntime.session;
        },
        diagnostics: unavailableRuntimeDiagnostics({
          resetHighWaterMarks: () => applicationRuntime.resetRuntimeDiagnosticsHighWaterMarks(),
        }),
        reopen: async () => await applicationRuntime.reopen(),
        async createBulkBuilder() {
          return await applicationRuntime.createBulkBuilder();
        },
        async collectGarbage() {
          throw new Error('production HizoFS garbage-collection diagnostics are not connected');
        },
        close: async () => await applicationRuntime.close(),
      };
      return runtime;
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
