import { NaidanRpcError } from '@/features/naidan-rpc';

/** Shared by all connections, not allocated once per peer. Reservations bound
 * accepted input and retained results independently of the native engine lane. */
export function createInferenceBudget({ capacity }: { capacity: number }) {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Invalid inference budget');
  let reserved = 0;
  let idle: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  return {
    reserve({ bytes }: { bytes: number }): { release(): void } {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > capacity - reserved) throw new NaidanRpcError({ code: 'RESOURCE_EXHAUSTED' });
      if (bytes > 0 && reserved === 0) idle = Promise.withResolvers<void>();
      reserved += bytes;
      let owned = true;
      return {
        release() {
          if (!owned) return;
          owned = false; reserved -= bytes;
          if (reserved === 0) {
            const completed = idle; idle = undefined; completed?.resolve();
          }
        },
      };
    },
    get reserved(): number {
      return reserved;
    },
    /** Close admission before waiting. An errored result stream may still own
     * non-cancellable Blob reads or asynchronous source cleanup. */
    whenIdle(): Promise<void> {
      return idle?.promise ?? Promise.resolve();
    },
  };
}

export type InferenceBudget = ReturnType<typeof createInferenceBudget>;
export const TEST_ONLY = {
};
