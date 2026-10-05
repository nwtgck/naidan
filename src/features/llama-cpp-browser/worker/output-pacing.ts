/** Bound repeated full-output parsing without scheduling callbacks that could
 * outlive the native request. Stop matching and sampling still run per token.
 * The elapsed-time limit is checked at token boundaries, not a timer deadline. */
export function createOutputPacing({ mode, now }: {
  mode: 'per-token' | 'coalesced',
  now: () => number,
}) {
  let lastParsedLength = -1;
  let lastParsedAt = 0;
  let pendingTokens = 0;
  let hasDelivered = false;
  return {
    mode,
    shouldParse({ outputLength, force }: { outputLength: number, force: boolean }): boolean {
      pendingTokens++;
      switch (mode) {
      case 'per-token': return true;
      case 'coalesced': break;
      default: { const exhaustive: never = mode; throw new Error(`Unknown output pacing: ${exhaustive}`); }
      }
      if (force) return true;
      // Native parsing depends on the cumulative text, not the token count.
      // A held stop prefix or an incomplete UTF-8 character needs no reparse.
      if (outputLength === lastParsedLength) return false;
      // Do not add a batching delay before the first visible event. A template
      // may consume many tokens before it exposes text, reasoning or a call.
      if (!hasDelivered || outputLength < lastParsedLength) return true;
      if (pendingTokens >= 8 || outputLength - lastParsedLength >= 4096) return true;
      const elapsed = now() - lastParsedAt;
      // performance.now() is monotonic; an unusual/injected clock fails open.
      return elapsed >= 32 || elapsed < 0 || !Number.isFinite(elapsed);
    },
    parsed({ outputLength }: { outputLength: number }): void {
      lastParsedLength = outputLength;
      pendingTokens = 0;
      // Start at parsing, not at delivery acknowledgement. Slow consumers must
      // not incur a fresh batching interval after they release backpressure.
      switch (mode) {
      case 'coalesced': lastParsedAt = now(); break;
      case 'per-token': break;
      default: { const exhaustive: never = mode; throw new Error(`Unknown output pacing: ${exhaustive}`); }
      }
    },
    delivered(): void {
      hasDelivered = true;
    },
  };
}

export const TEST_ONLY = {
};
