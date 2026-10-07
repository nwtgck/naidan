import { logFailure } from '@/features/llama-cpp-browser/debug-log';
import { errorCode, LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';

/** At most one owned JS delivery and one decode. Every started operation must
 * settle before the caller can sample, parse, reuse a batch, or free memory. */
export function createDeliveryDecode({ mode, signal, now }: {
  mode: 'serial' | 'overlap',
  signal: AbortSignal | undefined,
  now: (() => number) | undefined,
}) {
  let active = false;
  const counters = {
    mode,
    pairedSteps: 0,
    settledPairs: 0,
    serialSteps: 0,
    deliveryWaitMs: now ? 0 : undefined,
    decodeWaitMs: now ? 0 : undefined,
    jointWaitMs: now ? 0 : undefined,
  };
  const checkCancelled = (): void => {
    if (signal?.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
  };
  const clock = (): number | undefined => {
    try {
      const value = now?.();
      return value !== undefined && Number.isFinite(value) ? value : undefined;
    } catch {
      return undefined; /* Diagnostics must never interrupt ownership. */
    }
  };
  const elapsed = ({ start }: { start: number | undefined }): number => {
    const end = clock();
    return start !== undefined && end !== undefined ? Math.max(0, end - start) : 0;
  };
  async function observe({ operation, kind, onFailure }: { operation: () => void | Promise<void>, kind: 'deliveryWaitMs' | 'decodeWaitMs', onFailure: (() => void) | undefined }): Promise<void> {
    const start = clock();
    try {
      await operation();
    } catch (error) {
      onFailure?.();
      throw error;
    } finally {
      if (counters[kind] !== undefined) counters[kind] += elapsed({ start });
    }
  }
  return {
    mode,
    counters,
    async run({ deliver, decode }: { deliver: () => void | Promise<void>, decode: () => Promise<void> }): Promise<void> {
      if (active) throw new LlamaCppBrowserError({ code: 'busy' });
      active = true;
      try {
        checkCancelled();
        switch (mode) {
        case 'serial':
          counters.serialSteps++;
          await deliver();
          checkCancelled();
          await decode();
          checkCancelled();
          return;
        case 'overlap': break;
        default: { const exhaustive: never = mode; throw new Error(`Unknown delivery mode: ${exhaustive}`); }
        }
        counters.pairedSteps++;
        const start = clock();
        let deliveryRejected = false;
        // Start delivery first, without a task/timer delay. Attach a rejection
        // handler before starting any native work, including synchronous throws.
        const delivery = observe({
          operation: deliver,
          kind: 'deliveryWaitMs',
          onFailure: () => {
            deliveryRejected = true;
          },
        });
        void delivery.catch(() => {});
        await Promise.resolve();
        const decoding = observe({
          kind: 'decodeWaitMs',
          onFailure: undefined,
          operation: async () => {
            checkCancelled();
            if (!deliveryRejected) await decode();
          },
        });
        // Fail-fast aggregation would release the caller while native code or a
        // remote callback still owns its resources. Never race this with abort.
        const [delivered, decoded] = await Promise.allSettled([delivery, decoding]);
        counters.settledPairs++;
        if (counters.jointWaitMs !== undefined) counters.jointWaitMs += elapsed({ start });
        // Real failures take precedence over cooperative cancellation, just as
        // in serial mode. A simultaneous delivery failure wins, but retain a
        // separate, sanitized diagnostic for any native failure it masks.
        if (decoded.status === 'rejected' && errorCode({ error: decoded.reason }) !== 'aborted') {
          if (delivered.status !== 'rejected' || errorCode({ error: delivered.reason }) === 'aborted') throw decoded.reason;
          try {
            logFailure({ stage: 'generation-decode', error: decoded.reason });
          } catch { /* Diagnostics must not replace the owning failure. */ }
        }
        // decode() must also reject nonzero native statuses, not merely traps.
        switch (delivered.status) {
        case 'rejected': throw delivered.reason;
        case 'fulfilled': break;
        default: { const exhaustive: never = delivered; throw new Error(String(exhaustive)); }
        }
        switch (decoded.status) {
        case 'rejected': throw decoded.reason;
        case 'fulfilled': checkCancelled(); return;
        default: { const exhaustive: never = decoded; throw new Error(String(exhaustive)); }
        }
      } finally {
        active = false;
      }
    },
  };
}

export const TEST_ONLY = {
};
