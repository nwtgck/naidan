import { diagnosticSchema, type Diagnostic } from '@/features/llama-cpp-browser/debug-log';
import type { MemoryDiagnostics } from '@/features/llama-cpp-browser/performance/memory-schema';
import { subscribeWorkerNotifications } from '@/utils/worker-transport';
import { memoryDiagnosticSchema } from '@/features/llama-cpp-browser/memory-diagnostics';

/** Request-local observation only: no native reads, timers, or GPU wrappers.
 * Retain initial loading evidence and the latest cleanup even in a long request.
 */
export function observeMeasurementMemory({ worker, now }: { worker: Pick<Worker, 'postMessage' | 'addEventListener' | 'removeEventListener'>, now: () => number }) {
  const state: MemoryDiagnostics = { samples: [], droppedSamples: 0, nativeAllocations: [], droppedNativeAllocations: 0, nativeSettings: [], droppedNativeSettings: 0 };
  let stopped = false;
  let contextAttempts = 0;
  let activeContextAttempt: number | undefined;
  const appendSetting = ({ setting }: { setting: MemoryDiagnostics['nativeSettings'][number] }): void => {
    state.nativeSettings.push(setting);
    if (state.nativeSettings.length > 128) {
      state.nativeSettings.splice(16, 1); state.droppedNativeSettings++;
    }
  };
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
  const observation = {
    record({ diagnostic }: { diagnostic: Diagnostic }): void {
      if (stopped) return;
      if (diagnostic.event === 'native-info' && diagnostic.loadedModelDescriptor !== undefined) {
        appendSetting({ setting: { observedMs: Math.max(0, now()), loadedModelDescriptor: { ...diagnostic.loadedModelDescriptor } } });
        return;
      }
      if (diagnostic.event === 'context-start' || diagnostic.event === 'context-retry' || diagnostic.event === 'context-ready') {
        // A retry begins the next attempt; requested/resolved records from the
        // failed attempt remain separate. No derived effective state is retained.
        const contextEvent = diagnostic.event;
        let contextAttempt = activeContextAttempt;
        switch (contextEvent) {
        case 'context-start': case 'context-retry':
          contextAttempt = ++contextAttempts; activeContextAttempt = contextAttempt; break;
        case 'context-ready': activeContextAttempt = undefined; break;
        default: { const exhaustive: never = contextEvent; void exhaustive; }
        }
        appendSetting({ setting: { observedMs: Math.max(0, now()), contextAttempt, contextEvent, contextTokens: diagnostic.contextTokens, batchTokens: diagnostic.batchTokens } });
        return;
      }
      if (diagnostic.event !== 'native-info' || (diagnostic.nativeFlashAttention === undefined && diagnostic.nativeValue === undefined)) return;
      if (diagnostic.nativeFlashAttention !== undefined) {
        // Requested means the native-normalized constructor parameter, not the UI setting.
        appendSetting({ setting: { observedMs: Math.max(0, now()), contextAttempt: activeContextAttempt, nativeFlashAttention: { ...diagnostic.nativeFlashAttention } } });
        return;
      }
      if (diagnostic.nativeValue === undefined) return;
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
        appendSetting({ setting: { observedMs: Math.max(0, now()), nativeMetric, nativeValue, batchTokens: diagnostic.batchTokens, nativeSingleTokenValue: diagnostic.nativeSingleTokenValue } });
        break;
      case undefined: break;
      default: { const exhaustive: never = nativeMetric; void exhaustive; }
      }
    },
    finish(): MemoryDiagnostics {
      stopped = true; activeContextAttempt = undefined; unsubscribe(); unsubscribeSettings();
      return state;
    },
  };
  // These notifications share the RPC endpoint, so accepted observations arrive
  // before its terminal response. Forced Worker termination remains best effort.
  const unsubscribeSettings = subscribeWorkerNotifications({
    endpoint: worker,
    schema: diagnosticSchema,
    listener: ({ value: diagnostic }) => observation.record({ diagnostic }),
  });
  return observation;
}

export const TEST_ONLY = {
};
