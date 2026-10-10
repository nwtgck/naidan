import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import type { BackendCensus } from '@/features/llama-cpp-browser/performance/backend-census-schema';

/** A bounded, metadata-only diagnostic. Never read tensor values and never
 * request node completion. Upstream still synchronizes at split boundaries
 * when a callback is installed, so this request must not enter speed summaries. */
export function createBackendCensus({ core }: { core: Core }) {
  const { read, capability } = core.createTensorPlacementReader();
  let phase: BackendCensus['entries'][number]['phase'] = 'setup';
  let observedNodes = 0, droppedNodes = 0, errors = 0, released = false;
  const phaseReads = new Map<BackendCensus['entries'][number]['phase'], number>(), phaseEntries = new Map<BackendCensus['entries'][number]['phase'], number>();
  const entries = new Map<string, BackendCensus['entries'][number]>();
  const pointer = core.module.addFunction((tensor: number | bigint, ask: number, _userData: number | bigint): number => {
    // false on ask means do not split the graph for this node's completion.
    if (!ask) return 1;
    observedNodes++;
    const count = phaseReads.get(phase) ?? 0;
    if (count >= 25000) {
      droppedNodes++; return 0;
    }
    phaseReads.set(phase, count + 1);
    try {
      const address = core.pointerBytes === 4 ? BigInt(Number(tensor) >>> 0) : BigInt(tensor);
      const { name, ...metadata } = read({ tensor: address });
      const key = JSON.stringify({ phase, ...metadata });
      let entry = entries.get(key);
      if (!entry) {
        if ((phaseEntries.get(phase) ?? 0) >= 512) {
          droppedNodes++; return 0;
        }
        entry = { phase, ...metadata, nodes: 0, examples: [] };
        entries.set(key, entry); phaseEntries.set(phase, (phaseEntries.get(phase) ?? 0) + 1);
      }
      entry.nodes++;
      if (name && entry.examples.length < 3 && !entry.examples.includes(name)) entry.examples.push(name);
    } catch {
      errors++; /* Never unwind an observation error through native code. */
    }
    return 0;
  }, core.pointerBytes === 8 ? 'ijij' : 'iiii');
  return {
    pointer,
    setPhase({ value }: { value: typeof phase }): void {
      phase = value;
    },
    reset(): void {
      phase = 'setup'; observedNodes = 0; droppedNodes = 0; errors = 0; entries.clear(); phaseReads.clear(); phaseEntries.clear();
    },
    snapshot(): BackendCensus {
      return {
        version: 1,
        method: 'native-eval-metadata',
        timing: 'not-a-speed-measurement',
        placementMeaning: 'destination-buffer-not-execution-backend',
        capability,
        observedNodes,
        droppedNodes,
        errors,
        entries: Array.from(entries.values(), entry => ({
          ...entry,
          shape: [...entry.shape],
          inputs: entry.inputs.map(input => ({ ...input, shape: [...input.shape] })),
          examples: [...entry.examples],
        })),
      };
    },
    release(): void {
      if (!released) {
        core.module.removeFunction(pointer); released = true;
      }
    },
  };
}

export const TEST_ONLY = {
};
