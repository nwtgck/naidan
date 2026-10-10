import type { Diagnostic } from '@/features/llama-cpp-browser/debug-log';
import type { MemoryDiagnostics } from '@/features/llama-cpp-browser/performance/memory-schema';
import { subscribeWorkerNotifications } from '@/utils/worker-transport';
import { memoryDiagnosticSchema } from '@/features/llama-cpp-browser/memory-diagnostics';

/** Request-local observation only: no native reads, timers, or GPU wrappers.
 * Retain initial loading evidence and the latest cleanup even in a long request.
 */
export function observeMeasurementMemory({ worker, now }: { worker: Pick<Worker, 'postMessage' | 'addEventListener' | 'removeEventListener'>, now: () => number }) {
  const state: MemoryDiagnostics = { samples: [], droppedSamples: 0, nativeAllocations: [], droppedNativeAllocations: 0, nativeSettings: [], droppedNativeSettings: 0 };
  let stopped = false;
  const unsubscribe = subscribeWorkerNotifications({
    endpoint: worker,
    schema: memoryDiagnosticSchema,
    listener: ({ value: diagnostic }) => {
      if (stopped) return;
      state.samples.push({ ...diagnostic, gpuRequests: diagnostic.gpuRequests ? { ...diagnostic.gpuRequests } : undefined });
      if (state.samples.length > 128) {
        state.samples.splice(16, 1); state.droppedSamples++;
      }
    },
  });
  return {
    record({ diagnostic }: { diagnostic: Diagnostic }): void {
      if (stopped || diagnostic.event !== 'native-info' || diagnostic.nativeValue === undefined) return;
      const { nativeMetric, nativeBackend, nativeValue } = diagnostic;
      switch (nativeMetric) {
      case 'model_buffer_mib': case 'kv_buffer_mib': case 'recurrent_buffer_mib': case 'compute_buffer_mib':
        if (nativeBackend === undefined) return;
        state.nativeAllocations.push({ observedMs: Math.max(0, now()), nativeMetric, nativeBackend, nativeValue });
        if (state.nativeAllocations.length > 128) {
          state.nativeAllocations.splice(16, 1); state.droppedNativeAllocations++;
        }
        break;
      case 'n_ctx': case 'n_ctx_seq': case 'n_batch': case 'n_ubatch': case 'n_seq_max': case 'graph_nodes': case 'graph_splits':
        if (!Number.isSafeInteger(nativeValue)) return;
        state.nativeSettings.push({ observedMs: Math.max(0, now()), nativeMetric, nativeValue, batchTokens: diagnostic.batchTokens, nativeSingleTokenValue: diagnostic.nativeSingleTokenValue });
        if (state.nativeSettings.length > 128) {
          state.nativeSettings.splice(16, 1); state.droppedNativeSettings++;
        }
        break;
      case undefined: break;
      default: { const exhaustive: never = nativeMetric; void exhaustive; }
      }
    },
    finish(): MemoryDiagnostics {
      stopped = true; unsubscribe();
      return state;
    },
  };
}

export const TEST_ONLY = {
};
