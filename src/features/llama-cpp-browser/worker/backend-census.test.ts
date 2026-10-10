// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import { backendCensusSchema } from '@/features/llama-cpp-browser/performance/backend-census-schema';
import { createBackendCensus } from './backend-census';

function fixture() {
  let callback: (tensor: number | bigint, ask: number, data: number | bigint) => number = () => -1;
  const read = vi.fn(() => ({ op: 'GGML_OP_MUL_MAT', description: 'MUL_MAT', compute: true, type: 'GGML_TYPE_F32', shape: [8, 1, 1, 1], inputs: [], name: 'result', buffer: 'CPU', storage: 'host' as const, webgpuSupport: 'unsupported' as const, metadataOnly: false }));
  const remove = vi.fn();
  const core = {
    pointerBytes: 4,
    createTensorPlacementReader: () => ({ read, capability: 'legacy-synchronous-getters' as const }),
    module: {
      addFunction: (fn: typeof callback) => {
        callback = fn; return 10;
      },
      removeFunction: remove,
    },
  } as unknown as Core;
  const census = createBackendCensus({ core });
  return { read, remove, census, call: ({ tensor = 1, ask = 1 }: { tensor?: number | bigint, ask?: number } = {}) => callback(tensor, ask, 0) };
}

describe('bounded metadata census', () => {
  it('never requests node completion, normalizes wasm32 pointers, and snapshots without aliases', () => {
    const test = fixture(); test.census.setPhase({ value: 'decode' });
    expect(test.call({ tensor: -1 })).toBe(0);
    expect(test.read).toHaveBeenCalledWith({ tensor: 4294967295n });
    expect(test.call({ ask: 0 })).toBe(1); expect(test.read).toHaveBeenCalledOnce();
    const report = backendCensusSchema.parse(test.census.snapshot());
    expect(report).toMatchObject({ timing: 'not-a-speed-measurement', placementMeaning: 'destination-buffer-not-execution-backend', observedNodes: 1 });
    test.call(); expect(report.entries[0]?.nodes).toBe(1);
    test.census.release(); test.census.release(); expect(test.remove).toHaveBeenCalledOnce();
  });

  it('bounds prefill observations without starving decode observations', () => {
    const test = fixture(); test.census.setPhase({ value: 'prefill' });
    for (let i = 0; i < 25005; i++) test.call();
    test.census.setPhase({ value: 'decode' }); test.call();
    expect(test.census.snapshot()).toMatchObject({ observedNodes: 25006, droppedNodes: 5, errors: 0 });
    expect(test.census.snapshot().entries.map(entry => entry.phase)).toEqual(['prefill', 'decode']);
  });

  it('bounds unique shapes and never unwinds an observer exception through native code', () => {
    const test = fixture(); const normal = test.read.getMockImplementation()!;
    let size = 0;
    test.read.mockImplementation(() => ({ ...normal(), shape: [++size, 1, 1, 1] }));
    for (let i = 0; i < 515; i++) test.call();
    expect(test.census.snapshot().entries).toHaveLength(512); expect(test.census.snapshot().droppedNodes).toBe(3);
    test.read.mockImplementation(() => {
      throw new Error('observer');
    });
    expect(test.call()).toBe(0); expect(test.census.snapshot().errors).toBe(1);
    test.census.reset(); expect(test.census.snapshot()).toMatchObject({ observedNodes: 0, droppedNodes: 0, errors: 0, entries: [] });
  });
});
