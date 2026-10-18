// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import { nativeGraphCountersSchema } from '@/features/llama-cpp-browser/performance/native-graph-counters-schema';
import { createNativeGraphCounters } from './native-graph-counters';

function fixture() {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  const fields: Record<string, number> = { n_reused: 4, n_reallocs_same: 12, n_reallocs_diff: 24 };
  const allocRecord = vi.fn(() => 4n);
  const free = vi.fn();
  const read = vi.fn(async () => {});
  const fieldLayout = vi.fn(({ field }: { field: string }) => ({ offset: BigInt(fields[field]!), kind: 'signed', size: 4 }));
  const core = {
    allocRecord,
    free,
    fieldLayout,
    api: { llama_perf_context: read },
    bytes: ({ pointer, length }: { pointer: bigint, length: number }) => bytes.subarray(Number(pointer - 4n), Number(pointer - 4n) + length),
  } as unknown as Core;
  const observer = createNativeGraphCounters({ core, context: 0x10000001n });
  return {
    observer,
    read,
    free,
    allocRecord,
    fieldLayout,
    set: ({ reused, same, changed }: { reused: number, same: number, changed: number }) => {
      view.setInt32(4, reused, true);
      view.setInt32(12, same, true);
      view.setInt32(24, changed, true);
    },
  };
}

describe('passive native graph counters', () => {
  it('allocates only during capture, uses native field offsets, and snapshots without aliases', async () => {
    const test = fixture();
    expect(test.allocRecord).not.toHaveBeenCalled();
    test.set({ reused: 3, same: 1, changed: 2 });
    await test.observer.capture({ point: 'before' });
    test.set({ reused: 63, same: 4, changed: 6 });
    await test.observer.capture({ point: 'after' });
    const report = nativeGraphCountersSchema.parse(test.observer.snapshot());
    expect(report).toEqual({ method: 'llama-perf-context', errors: 0, before: { n_reused: 3, n_reallocs_same: 1, n_reallocs_diff: 2 }, after: { n_reused: 63, n_reallocs_same: 4, n_reallocs_diff: 6 } });
    expect(test.read).toHaveBeenCalledTimes(2);
    expect(test.read).toHaveBeenCalledWith(4n, 0x10000001n);
    expect(test.free).toHaveBeenCalledTimes(2);
    expect(test.free).toHaveBeenLastCalledWith({ pointer: 4n });
    report.before!.n_reused = 999;
    report.after!.n_reallocs_diff = 999;
    expect(test.observer.snapshot().before?.n_reused).toBe(3);
    expect(test.observer.snapshot().after?.n_reallocs_diff).toBe(6);
  });

  it.each(['allocation', 'native-read', 'layout', 'negative', 'free'] as const)('contains %s failures and keeps unavailable boundaries missing', async failure => {
    const test = fixture();
    switch (failure) {
    case 'allocation': test.allocRecord.mockImplementationOnce(() => {
      throw new Error('allocation');
    });
      break;
    case 'native-read': test.read.mockRejectedValueOnce(new Error('read'));
      break;
    case 'layout': test.fieldLayout.mockReturnValueOnce({ offset: 0n, kind: 'float', size: 8 });
      break;
    case 'negative': test.set({ reused: -1, same: 0, changed: 0 });
      break;
    case 'free': test.free.mockImplementationOnce(() => {
      throw new Error('free');
    });
      break;
    default: {
      const exhaustive: never = failure;
      throw new Error(String(exhaustive));
    }
    }
    await expect(test.observer.capture({ point: 'before' })).resolves.toBeUndefined();
    const report = nativeGraphCountersSchema.parse(test.observer.snapshot());
    expect(report.errors).toBe(1);
    if (failure !== 'free') {
      expect(report.before).toBeUndefined();
    }
    expect(report.after).toBeUndefined();
    expect(test.free).toHaveBeenCalledTimes(failure === 'allocation' ? 0 : 1);
  });
});
