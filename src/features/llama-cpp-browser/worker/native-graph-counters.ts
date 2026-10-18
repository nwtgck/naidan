import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import type { NativeGraphCounters } from '@/features/llama-cpp-browser/performance/native-graph-counters-schema';

/** Read existing upstream counters at request boundaries, only in measurement.
 * No perf reset, no no_perf change, no callback or synchronization request.
 * Reallocation counters are lifetime values and exclude backend-assignment
 * changes; they are not allocations, graph builds or physical residency. */
export function createNativeGraphCounters({ core, context }: { core: Core, context: bigint }) {
  const state: NativeGraphCounters = { method: 'llama-perf-context', errors: 0 };
  return {
    async capture({ point }: { point: 'before' | 'after' }): Promise<void> {
      let pointer = 0n;
      try {
        pointer = core.allocRecord({ name: 'llama_perf_context_data' });
        await core.api.llama_perf_context(pointer, context);
        const read = ({ field }: { field: string }): number => {
          const layout = core.fieldLayout({ name: 'llama_perf_context_data', field });
          if (layout.kind !== 'signed' || layout.size !== 4) {
            throw new TypeError('Unexpected graph counter field');
          }
          const bytes = core.bytes({ pointer: pointer + layout.offset, length: 4 });
          const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(0, true);
          if (value < 0) {
            throw new RangeError('Unavailable graph counter');
          }
          return value;
        };
        state[point] = {
          n_reused: read({ field: 'n_reused' }),
          n_reallocs_same: read({ field: 'n_reallocs_same' }),
          n_reallocs_diff: read({ field: 'n_reallocs_diff' }),
        };
      } catch {
        state.errors++;
      } finally {
        if (pointer !== 0n) {
          try {
            core.free({ pointer });
          } catch {
            state.errors++;
          }
        }
      }
    },
    snapshot(): NativeGraphCounters {
      return {
        ...state,
        ...(state.before ? { before: { ...state.before } } : {}),
        ...(state.after ? { after: { ...state.after } } : {}),
      };
    },
  };
}

export const TEST_ONLY = {
};
