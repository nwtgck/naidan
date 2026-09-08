import { awaitWithAbort } from '@/features/transformers-js/download-verification/logic/await-with-abort';

// This is a bounded investigation preflight, not a claim that every supported
// model can compile within this time. Expiry is inconclusive, never rejection
// evidence that justifies downloading another model candidate.
export const DEFAULT_CACHE_ACCEPTANCE_TIMEOUT_MS = 120_000;

export class CacheAcceptanceTimeoutError extends Error {
  constructor({ timeoutMs }: { timeoutMs: number }) {
    super(`Production cache acceptance exceeded ${timeoutMs} ms; the investigation stopped this model without downloading artifacts`);
    this.name = 'CacheAcceptanceTimeoutError';
  }
}

export async function withCacheAcceptanceDeadline<T>({ start, controller, timeoutMs }: {
  start: () => Promise<T>;
  controller: AbortController;
  timeoutMs: number;
}): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid cache acceptance timeout');
  controller.signal.throwIfAborted();
  const timer = setTimeout(() => controller.abort(new CacheAcceptanceTimeoutError({ timeoutMs })), timeoutMs);
  try {
    // Aborting the same controller passed to the actual Worker owner ensures
    // that returning partial Evidence does not abandon a live model load.
    return await awaitWithAbort({ operation: start(), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
