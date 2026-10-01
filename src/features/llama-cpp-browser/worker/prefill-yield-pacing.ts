/** Keep long prefills cooperative without paying a task-scheduling round trip
 * after every small native batch. Elapsed time is checked at batch boundaries;
 * the token limit bounds fast batches whose timer barely advances. */
export function createPrefillYieldPacing({ now, maximumElapsedMs = 16, maximumTokens = 1024 }: {
  now: () => number,
  maximumElapsedMs?: number,
  maximumTokens?: number,
}) {
  let lastYieldAt = now();
  let tokensSinceYield = 0;
  return {
    shouldYield({ decodedTokens }: { decodedTokens: number }): boolean {
      tokensSinceYield += Math.max(0, decodedTokens);
      const elapsed = now() - lastYieldAt;
      return tokensSinceYield >= maximumTokens || elapsed >= maximumElapsedMs || elapsed < 0 || !Number.isFinite(elapsed);
    },
    yielded(): void {
      tokensSinceYield = 0;
      lastYieldAt = now();
    },
  };
}

export const TEST_ONLY = {
};
