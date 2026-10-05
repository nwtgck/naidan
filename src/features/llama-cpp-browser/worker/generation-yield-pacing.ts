/** Task yields remain bounded independently of parsing and delivery. In the
 * fast text-only path, check the clock after every successful decode and yield
 * at least once per four decodes. A single native call cannot be interrupted
 * by this scheduler; the elapsed limit is not a cancellation deadline. */
export function createGenerationYieldPacing({ mode, now }: {
  mode: 'per-token' | 'coalesced',
  now: () => number,
}) {
  const counters = { mode, checks: 0, requestedYields: 0, completedYields: 0,
    coalescedYields: 0, maximumDecodesBetweenYields: 0 };
  let decodedSinceYield = 0;
  let firstYieldCompleted = false;
  let waiting = false;
  const readClock = (): number => {
    switch (mode) {
    case 'coalesced': return now();
    case 'per-token': return 0;
    default: { const exhaustive: never = mode; throw new Error(`Unknown generation pacing: ${exhaustive}`); }
    }
  };
  let lastYieldAt = readClock();
  let lastObservedAt = lastYieldAt;
  return {
    counters,
    shouldYield(): boolean {
      if (waiting) throw new Error('Complete the requested generation yield before continuing');
      decodedSinceYield++;
      counters.checks++;
      counters.maximumDecodesBetweenYields = Math.max(counters.maximumDecodesBetweenYields, decodedSinceYield);
      let needed: boolean;
      switch (mode) {
      case 'per-token': needed = true; break;
      case 'coalesced': {
        const at = now();
        const elapsed = at - lastYieldAt;
        const clockInvalid = !Number.isFinite(at) || !Number.isFinite(lastObservedAt)
          || !Number.isFinite(elapsed) || at < lastObservedAt || elapsed < 0;
        lastObservedAt = at;
        // Let queued worker messages run after the first decode even when no
        // text is visible yet. Neither an event ACK nor a Promise microtask
        // substitutes for the real task yield performed by the caller.
        needed = !firstYieldCompleted || clockInvalid || decodedSinceYield >= 4 || elapsed >= 8;
        break;
      }
      default: { const exhaustive: never = mode; throw new Error(`Unknown generation pacing: ${exhaustive}`); }
      }
      if (needed) {
        waiting = true;
        counters.requestedYields++;
      } else counters.coalescedYields++;
      return needed;
    },
    yielded(): void {
      if (!waiting) throw new Error('No generation yield is pending');
      waiting = false;
      decodedSinceYield = 0;
      firstYieldCompleted = true;
      counters.completedYields++;
      lastYieldAt = lastObservedAt = readClock();
    },
  };
}

export const TEST_ONLY = {
};
