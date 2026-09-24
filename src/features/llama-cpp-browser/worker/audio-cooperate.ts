import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';

/** Keep Stop responsive without paying a nested timer's minimum delay on every
 * fast frame. This is worker scheduling only; it does not stream or play audio. */
export function createAudioCooperator({ signal }: { signal: AbortSignal | undefined }) {
  let nextYieldAt = 0;
  return async ({ force }: { force: boolean }): Promise<void> => {
    if (signal?.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
    if (force || performance.now() >= nextYieldAt) {
      // Yield to tasks, not just Promise microtasks, so worker cancellation runs.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      nextYieldAt = performance.now() + 16;
    }
    if (signal?.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
  };
}
export const TEST_ONLY = {
};
