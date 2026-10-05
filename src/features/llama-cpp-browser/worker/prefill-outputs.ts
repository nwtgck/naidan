import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';
import { prefillBatchTokens } from './prefill-config';

/** Intermediate text batches only advance memory; sampling needs the final
 * prompt output. Keep one zero-filled flag buffer until all decodes settle.
 * The caller must initialize the batch first and dispose after native use. */
export function createPrefillOutputs({ core, mode }: {
  core: Pick<Core, 'tryAlloc' | 'bytes' | 'setField' | 'free'>,
  mode: 'final-only' | 'per-batch',
}) {
  let pointer = 0n;
  let state: 'unallocated' | 'ready' | 'fallback' | 'disposed' = 'unallocated';
  const counters = { requestedLogits: 0, skippedLogits: 0, allocationFallbacks: 0 };
  return {
    counters,
    configure({ batch, count, final }: { batch: bigint, count: number, final: boolean }): void {
      if (state === 'disposed' || !Number.isSafeInteger(count) || count < 1 || count > prefillBatchTokens) {
        throw new LlamaCppBrowserError({ code: 'runtime-error' });
      }
      if (!final && mode === 'final-only' && state === 'unallocated') {
        // Only an ordinary declined allocation is recoverable. A trap or a
        // broken runtime must propagate instead of being retried as inference.
        const allocated = core.tryAlloc({ bytes: prefillBatchTokens });
        if (allocated === undefined) {
          state = 'fallback'; counters.allocationFallbacks++;
        } else {
          pointer = allocated;
          core.bytes({ pointer, length: prefillBatchTokens }).fill(0);
          state = 'ready';
        }
      }
      const omit = !final && mode === 'final-only' && state === 'ready';
      // batch_get_one resets logits. Explicitly reset it here as well so final
      // batches cannot accidentally retain the all-zero selection.
      core.setField({ name: 'llama_batch', pointer: batch, field: 'logits', value: omit ? pointer : 0n });
      if (omit) counters.skippedLogits++; else counters.requestedLogits++;
    },
    dispose(): void {
      state = 'disposed';
      const allocation = pointer; pointer = 0n;
      if (allocation !== 0n) core.free({ pointer: allocation });
    },
  };
}

export const TEST_ONLY = {
};
