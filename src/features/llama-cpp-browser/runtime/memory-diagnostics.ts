import { readGpuRequests } from './webgpu-request-diagnostics';
import type { LlamaCppProfile } from '@/features/llama-cpp-browser/types';
import type { MemoryCheckpoint, MemoryDiagnostic } from '@/features/llama-cpp-browser/memory-diagnostics';

type ObservedCore = { module: { HEAPU8: Uint8Array } };
const instances = new WeakMap<ObservedCore, { instanceId: string, profile: LlamaCppProfile, lastDecode: number }>();
const listeners = new Set<({ diagnostic }: { diagnostic: MemoryDiagnostic }) => void>();

export function subscribeMemoryDiagnostics({ listener }: { listener: ({ diagnostic }: { diagnostic: MemoryDiagnostic }) => void }): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function beginMemoryDiagnostics({ core, profile }: { core: ObservedCore, profile: LlamaCppProfile }): void {
  // Observation must never change whether model initialization succeeds.
  try {
    instances.set(core, { instanceId: crypto.randomUUID(), profile, lastDecode: -Infinity });
    sampleMemoryDiagnostics({ core, checkpoint: 'runtime-ready' });
  } catch { /* Diagnostics fail open, including unsupported test/runtime globals. */ }
}

export function sampleMemoryDiagnostics({ core, checkpoint }: { core: ObservedCore, checkpoint: MemoryCheckpoint }): void {
  try {
    const instance = instances.get(core);
    if (!instance) return;
    const timestamp = Date.now();
    const now = performance.now();
    switch (checkpoint) {
    case 'decode':
      if (now - instance.lastDecode < 1000) return;
      instance.lastDecode = now; break;
    case 'runtime-released': instances.delete(core); break;
    case 'runtime-ready': case 'before-model-load': case 'model-loaded': case 'model-load-failed': case 'context-ready': case 'prefill-start': case 'prefill-complete': case 'generation-complete': case 'generation-interrupted': case 'generation-cleaned': case 'model-released': break;
    default: { const exhaustive: never = checkpoint; throw new Error(String(exhaustive)); }
    }
    // Never retain a view: memory.grow replaces the Emscripten heap view.
    const diagnostic: MemoryDiagnostic = {
      kind: 'naidan-llama-cpp-memory',
      instanceId: instance.instanceId,
      profile: instance.profile,
      checkpoint,
      capacityBytes: core.module.HEAPU8.buffer.byteLength,
      gpuRequests: readGpuRequests({ core }),
      timestamp,
    };
    for (const listener of listeners) {
      try {
        listener({ diagnostic });
      } catch { /* Observers cannot affect inference. */ }
    }
  } catch { /* An unavailable sample must not replace the operation result. */ }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
