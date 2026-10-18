import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import type { BackendCensus } from '@/features/llama-cpp-browser/performance/backend-census-schema';

type Entry = BackendCensus['entries'][number];

/** Bounded diagnostics, never used in speed summaries. With timeDecode, request
 * completion for EVERY decode node (including views and unrecorded shapes).
 * Selecting just expensive ops would incorrectly time the preceding graph too.
 * This uses the public scheduler callback, not tensor reads or GPU timestamps.
 * The scheduler synchronizes and inhibits fusion; these are diagnostic wall times. */
export function createBackendCensus({ core, timeDecode = false, now = () => performance.now() }: { core: Core, timeDecode?: boolean, now?: () => number }) {
  const { read, capability } = core.createTensorPlacementReader();
  let phase: Entry['phase'] = 'setup';
  let observedNodes = 0, droppedNodes = 0, errors = 0, released = false;
  const phaseReads = new Map<Entry['phase'], number>(), phaseEntries = new Map<Entry['phase'], number>();
  const entries = new Map<string, Entry>();
  const emptyTiming = (): NonNullable<BackendCensus['decodeCompletionTiming']> => ({
    method: 'per-node-synchronized-wall-time',
    requestedNodes: 0,
    completedNodes: 0,
    timedNodes: 0,
    unattributedNodes: 0,
    unfinishedNodes: 0,
    skippedNodes: 0,
    errors: 0,
    totalMs: 0,
  });
  let timing = timeDecode ? emptyTiming() : undefined;
  let pending: { tensor: number | bigint, entry: Entry | undefined, name: string, index: number, started: number | undefined } | undefined;
  let timingStopped = false;

  function clock(): number | undefined {
    try {
      const value = now();
      if (Number.isFinite(value)) {
        return value;
      }
    } catch { /* Clock failures must not abort native inference. */ }
    if (timing) {
      timing.errors++;
    }
    return undefined;
  }

  const pointer = core.module.addFunction((tensor: number | bigint, ask: number, _userData: number | bigint): number => {
    if (released) {
      return ask ? 0 : 1;
    }
    if (!ask) {
      // Timestamp before metadata/aggregation. The original ask already read the
      // metadata, and the scheduler has synchronized this node's backend.
      if (timing) {
        const ended = pending ? clock() : undefined;
        if (!pending || pending.tensor !== tensor) {
          timing.errors++;
          pending = undefined;
          timingStopped = true;
          return 1;
        }
        const { entry, name, index, started } = pending;
        pending = undefined;
        timing.completedNodes++;
        timing.unfinishedNodes--;
        if (!entry) {
          timing.unattributedNodes++;
        }
        if (ended !== undefined && started !== undefined) {
          const elapsed = ended - started;
          if (elapsed < 0 || !Number.isFinite(elapsed) || !Number.isFinite(timing.totalMs + elapsed)) {
            timing.errors++;
          } else {
            timing.timedNodes++;
            timing.totalMs += elapsed;
            if (entry) {
              const previous = entry.completionTiming;
              entry.completionTiming = previous ? {
                samples: previous.samples + 1,
                totalMs: previous.totalMs + elapsed,
                minMs: Math.min(previous.minMs, elapsed),
                maxMs: Math.max(previous.maxMs, elapsed),
                maxNodeName: elapsed > previous.maxMs ? name : previous.maxNodeName,
                maxNodeIndex: elapsed > previous.maxMs ? index : previous.maxNodeIndex,
              } : { samples: 1, totalMs: elapsed, minMs: elapsed, maxMs: elapsed, maxNodeName: name, maxNodeIndex: index };
            }
          }
        }
      }
      // Never return false after completion: that would terminate the graph.
      return 1;
    }
    observedNodes++;
    const count = phaseReads.get(phase) ?? 0;
    if (count >= 25000) {
      droppedNodes++;
      if (phase === 'decode' && timing) {
        timing.skippedNodes++;
      }
      return 0;
    }
    phaseReads.set(phase, count + 1);
    let entry: Entry | undefined;
    let nodeName = '';
    try {
      const address = core.pointerBytes === 4 ? BigInt(Number(tensor) >>> 0) : BigInt(tensor);
      const { name, ...metadata } = read({ tensor: address });
      nodeName = name;
      const key = JSON.stringify({ phase, ...metadata });
      entry = entries.get(key);
      if (!entry) {
        if ((phaseEntries.get(phase) ?? 0) >= 512) {
          droppedNodes++;
        } else {
          entry = { phase, ...metadata, nodes: 0, examples: [] };
          entries.set(key, entry);
          phaseEntries.set(phase, (phaseEntries.get(phase) ?? 0) + 1);
        }
      }
      if (entry) {
        entry.nodes++;
        if (name && entry.examples.length < 3 && !entry.examples.includes(name)) {
          entry.examples.push(name);
        }
      }
    } catch {
      errors++; /* Never unwind an observation error through native code. */
    }
    if (phase === 'decode' && timing) {
      if (pending) {
        // A broken ask/completion sequence cannot provide isolated timings.
        // Preserve unfinishedNodes and stop rather than misattribute a prefix.
        timing.errors++;
        pending = undefined;
        timingStopped = true;
      }
      if (timingStopped) {
        timing.skippedNodes++;
        return 0;
      }
      timing.requestedNodes++;
      timing.unfinishedNodes++;
      pending = { tensor, entry, name: nodeName, index: timing.requestedNodes, started: clock() };
      return 1;
    }
    // Metadata-only asks leave grouping unchanged within this backend split.
    return 0;
  }, core.pointerBytes === 8 ? 'ijij' : 'iiii');
  return {
    pointer,
    setPhase({ value }: { value: typeof phase }): void {
      phase = value;
    },
    reset(): void {
      phase = 'setup';
      observedNodes = 0;
      droppedNodes = 0;
      errors = 0;
      entries.clear();
      phaseReads.clear();
      phaseEntries.clear();
      pending = undefined;
      timingStopped = false;
      timing = timeDecode ? emptyTiming() : undefined;
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
        ...(timing ? { decodeCompletionTiming: { ...timing } } : {}),
        entries: Array.from(entries.values(), entry => ({
          ...entry,
          shape: [...entry.shape],
          inputs: entry.inputs.map(input => ({ ...input, shape: [...input.shape] })),
          examples: [...entry.examples],
          ...(entry.completionTiming ? { completionTiming: { ...entry.completionTiming } } : {}),
        })),
      };
    },
    release(): void {
      if (!released) {
        core.module.removeFunction(pointer);
        released = true;
        pending = undefined;
      }
    },
  };
}

export const TEST_ONLY = {
};
