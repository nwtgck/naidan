import { subscribeWorkerNotifications } from '@/utils/worker-transport';
import { readonly, shallowRef } from 'vue';
import { memoryDiagnosticSchema, type MemoryDiagnostic } from './memory-diagnostics';

export type MemoryDiagnosticsHistory = {
  workerId: number,
  instanceId: string,
  profile: MemoryDiagnostic['profile'],
  status: 'observed' | 'runtime-released' | 'worker-ended',
  observedMaximumBytes: number,
  latestLoad: { ordinal: number, baselineBytes: number } | undefined,
  samples: MemoryDiagnostic[],
};
const histories = shallowRef<MemoryDiagnosticsHistory[]>([]);
let nextWorkerId = 0;
export const memoryDiagnosticsHistories = readonly(histories);

/** Attach only after a worker exists. No remote call, native call or polling. */
export function observeWorkerMemory({ worker }: { worker: Pick<Worker, 'postMessage' | 'addEventListener' | 'removeEventListener'> }): () => void {
  const workerId = ++nextWorkerId;
  let ended = false;
  const stopListening = subscribeWorkerNotifications({
    endpoint: worker,
    schema: memoryDiagnosticSchema,
    listener: ({ value: sample }) => {
      const previous = histories.value.find(history => history.workerId === workerId && history.instanceId === sample.instanceId);
      const samples = [...(previous?.samples ?? []), sample];
      // Keep initial loading checkpoints for before/after comparisons during long runs.
      const retained = samples.length <= 128 ? samples : [...samples.slice(0, 16), ...samples.slice(-112)];
      let status: MemoryDiagnosticsHistory['status'];
      let latestLoad = previous?.latestLoad;
      switch (sample.checkpoint) {
      case 'runtime-released': status = 'runtime-released'; break;
      case 'before-model-load':
        latestLoad = { ordinal: (latestLoad?.ordinal ?? 0) + 1, baselineBytes: sample.capacityBytes };
        status = 'observed'; break;
      case 'decode': case 'runtime-ready': case 'model-loaded': case 'model-load-failed': case 'context-ready': case 'prefill-start': case 'prefill-complete': case 'generation-complete': case 'generation-interrupted': case 'generation-cleaned': case 'model-released': status = 'observed'; break;
      default: { const exhaustive: never = sample.checkpoint; throw new Error(String(exhaustive)); }
      }
      const next: MemoryDiagnosticsHistory = {
        workerId,
        instanceId: sample.instanceId,
        profile: sample.profile,
        status,
        latestLoad,
        observedMaximumBytes: Math.max(previous?.observedMaximumBytes ?? 0, sample.capacityBytes),
        samples: retained,
      };
      histories.value = [...histories.value.filter(history => history !== previous), next].slice(-8);
    },
  });
  return () => {
    if (ended) return;
    ended = true;
    stopListening();
    histories.value = histories.value.map(history => history.workerId === workerId ? { ...history, status: 'worker-ended' } : history);
  };
}
export const TEST_ONLY = {
  reset() {
    histories.value = []; nextWorkerId = 0;
  },
};
