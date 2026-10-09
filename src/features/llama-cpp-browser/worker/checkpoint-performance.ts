import type { CheckpointPerformance, CheckpointPhase } from '@/features/llama-cpp-browser/performance/checkpoint-schema';

export type CheckpointObserver = { enter: ({ phase }: { phase: CheckpointPhase }) => void, end: () => void };

/** Request-local, phase-level wall timings. Construct only for explicit
 * investigation, never install native callbacks or per-token clocks. These are
 * children of cache-checkpoint, not additional exclusive GPU/CPU durations. */
export function createCheckpointPerformance({ now }: { now: () => number }) {
  const phases = new Map<CheckpointPhase, CheckpointPerformance['phases'][number]>();
  let current: CheckpointPerformance['phases'][number] | undefined;
  let since = 0, captureAttempts = 0, restoreAttempts = 0, retainedRestoredCaptures = 0;
  const end = () => {
    if (current) current.elapsedMs += Math.max(0, now() - since);
    current = undefined;
  };
  return {
    enter({ phase }: { phase: CheckpointPhase }): void {
      end(); since = now();
      let entry = phases.get(phase);
      if (!entry) {
        entry = { phase, visits: 0, elapsedMs: 0 }; phases.set(phase, entry);
      }
      entry.visits++; current = entry;
      switch (phase) {
      case 'capture-position': captureAttempts++; break;
      case 'restore-memory': restoreAttempts++; break;
      case 'boundary-tokenize': case 'capture-size': case 'capture-allocation': case 'capture-readback':
      case 'restore-write': case 'restore-trim': case 'restore-verify': break;
      default: { const exhaustive: never = phase; throw new Error(String(exhaustive)); }
      }
    },
    end,
    retained(): void {
      retainedRestoredCaptures++;
    },
    snapshot(): CheckpointPerformance {
      end();
      return { captureAttempts, restoreAttempts, retainedRestoredCaptures, phases: [...phases.values()].map(phase => ({ ...phase })) };
    },
  };
}
export const TEST_ONLY = {
};
