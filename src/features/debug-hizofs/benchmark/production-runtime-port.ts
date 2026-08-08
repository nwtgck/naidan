import { HizoFSRuntimeDiagnosticsUnavailableError } from '@/00-storage/service/hizofs/diagnostics/runtime-diagnostics';
import {
  createBrowserHizoFSBenchmarkApplicationRuntime,
  type BrowserHizoFSBenchmarkApplicationRuntime,
} from '@/00-storage/service/hizofs/worker-entry';
import type {
  HizoFSBenchmarkRuntime,
  HizoFSBenchmarkRuntimeDiagnostics,
  HizoFSBenchmarkRuntimePort,
} from '@/features/debug-hizofs/benchmark/runtime-port';

function measuredRuntimeDiagnostics({ resetHighWaterMarks, snapshotRuntimeDiagnostics }: {
  readonly resetHighWaterMarks: () => void;
  readonly snapshotRuntimeDiagnostics:
    BrowserHizoFSBenchmarkApplicationRuntime['snapshotRuntimeDiagnostics'];
}): HizoFSBenchmarkRuntimeDiagnostics {
  return {
    snapshot() {
      let snapshot;
      try {
        snapshot = snapshotRuntimeDiagnostics();
      } catch (cause: unknown) {
        if (!(cause instanceof HizoFSRuntimeDiagnosticsUnavailableError)) throw cause;
        return {
          schemaVersion: 10,
          type: 'unavailable',
          reason: 'runtime diagnostics recording failed',
        };
      }
      const {
        caches,
        coordinator,
        inodeLeafLookup,
        indexes,
        phases,
        mutation,
        publication,
        records,
        resources,
        segmentWriters,
        ...unhandledSnapshot
      } = snapshot;
      unhandledSnapshot satisfies Record<PropertyKey, never>;
      return {
        schemaVersion: 10,
        type: 'measured',
        caches,
        coordinator,
        inodeLeafLookup,
        indexes,
        phases,
        mutation,
        publication,
        records,
        resources,
        segmentWriters,
      };
    },
    resetResourceHighWaterMarks: resetHighWaterMarks,
  };
}

/**
 * Adapts the product-owned isolated HizoFS composition to the debug benchmark.
 * The product composition owns the counters and exposes only non-secret
 * snapshots. Keeping the adapter structural prevents the debug feature from
 * reaching into runtime internals while making missing instrumentation visible
 * as actual zero counters rather than a disconnected placeholder.
 */
export function createProductionHizoFSBenchmarkRuntimePort(): HizoFSBenchmarkRuntimePort {
  return {
    async createRuntime({ backingDirectory, policy }) {
      const applicationRuntime = await createBrowserHizoFSBenchmarkApplicationRuntime({
        backingDirectory,
        backingFileHandleCacheEntryLimit: policy.backingFileHandleCacheEntryLimit,
        decodedInodeIndexPageCacheEntryLimit: policy.decodedInodeIndexPageCacheEntryLimit,
        metadataRecordCachePolicy: {
          maximumBytes: policy.metadataObjectCacheByteLimit,
          maximumEntries: policy.metadataObjectCacheEntryLimit,
        },
      });
      const runtime: HizoFSBenchmarkRuntime = {
        get session() {
          return applicationRuntime.session;
        },
        diagnostics: measuredRuntimeDiagnostics({
          resetHighWaterMarks: () => applicationRuntime.resetRuntimeDiagnosticsHighWaterMarks(),
          snapshotRuntimeDiagnostics: () => applicationRuntime.snapshotRuntimeDiagnostics(),
        }),
        reopen: async () => await applicationRuntime.reopen(),
        async createBulkBuilder() {
          return await applicationRuntime.createBulkBuilder();
        },
        async settleAcceptedGeneration() {
          await applicationRuntime.settleAcceptedGeneration();
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
  measuredRuntimeDiagnostics,
};
