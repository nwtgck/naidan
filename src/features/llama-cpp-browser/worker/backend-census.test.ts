// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import { backendCensusSchema } from '@/features/llama-cpp-browser/performance/backend-census-schema';
import { createBackendCensus } from './backend-census';

function fixture({ timeDecode = false, pointerBytes = 4 }: { timeDecode?: boolean, pointerBytes?: 4 | 8 } = {}) {
  let time = 0;
  const now = vi.fn(() => time);
  let callback: (tensor: number | bigint, ask: number, data: number | bigint) => number = () => -1;
  const read = vi.fn(() => ({ op: 'GGML_OP_MUL_MAT', description: 'MUL_MAT', compute: true, type: 'GGML_TYPE_F32', shape: [8, 1, 1, 1], inputs: [] as { type: string, shape: number[] }[], name: 'result', buffer: 'CPU', storage: 'host' as const, webgpuSupport: 'unsupported' as const, metadataOnly: false }));
  const remove = vi.fn();
  const core = {
    pointerBytes,
    createTensorPlacementReader: () => ({ read, capability: 'legacy-synchronous-getters' as const }),
    module: {
      addFunction: (fn: typeof callback) => {
        callback = fn;
        return 10;
      },
      removeFunction: remove,
    },
  } as unknown as Core;
  const census = createBackendCensus({ core, timeDecode, now });
  return {
    read,
    remove,
    census,
    now,
    advance: ({ ms }: { ms: number }) => {
      time += ms;
    },
    [Symbol.dispose]() {
      census.release();
    },
    call: ({ tensor = 1, ask = 1 }: { tensor?: number | bigint, ask?: number } = {}) => callback(tensor, ask, 0),
  };
}

describe('bounded metadata census', () => {
  it('never requests node completion, normalizes wasm32 pointers, and snapshots without aliases', () => {
    using test = fixture();
    test.census.setPhase({ value: 'decode' });
    expect(test.call({ tensor: -1 })).toBe(0);
    expect(test.read).toHaveBeenCalledWith({ tensor: 4294967295n });
    expect(test.call({ ask: 0 })).toBe(1);
    expect(test.read).toHaveBeenCalledOnce();
    expect(test.now).not.toHaveBeenCalled();
    expect(test.census.snapshot().decodeCompletionTiming).toBeUndefined();
    const report = backendCensusSchema.parse(test.census.snapshot());
    expect(report).toMatchObject({ timing: 'not-a-speed-measurement', placementMeaning: 'destination-buffer-not-execution-backend', observedNodes: 1 });
    test.call();
    expect(report.entries[0]?.nodes).toBe(1);
    test.census.release();
    test.census.release();
    expect(test.remove).toHaveBeenCalledOnce();
  });

  it('bounds prefill observations without starving decode observations', () => {
    using test = fixture();
    test.census.setPhase({ value: 'prefill' });
    for (let i = 0; i < 25005; i++) {
      test.call();
    }
    test.census.setPhase({ value: 'decode' });
    test.call();
    expect(test.census.snapshot()).toMatchObject({ observedNodes: 25006, droppedNodes: 5, errors: 0 });
    expect(test.census.snapshot().entries.map(entry => entry.phase)).toEqual(['prefill', 'decode']);
  });

  it('bounds unique shapes and never unwinds an observer exception through native code', () => {
    using test = fixture();
    const normal = test.read.getMockImplementation()!;
    let size = 0;
    test.read.mockImplementation(() => ({ ...normal(), shape: [++size, 1, 1, 1] }));
    for (let i = 0; i < 515; i++) {
      test.call();
    }
    expect(test.census.snapshot().entries).toHaveLength(512);
    expect(test.census.snapshot().droppedNodes).toBe(3);
    test.read.mockImplementation(() => {
      throw new Error('observer');
    });
    expect(test.call()).toBe(0);
    expect(test.census.snapshot().errors).toBe(1);
    test.census.reset();
    expect(test.census.snapshot()).toMatchObject({ observedNodes: 0, droppedNodes: 0, errors: 0, entries: [] });
  });
});

describe('isolated diagnostic decode completion observations', () => {
  it('never samples a clock in setup, prefill or other phases, and also fences metadata-only views', () => {
    using test = fixture({ timeDecode: true });
    for (const value of ['setup', 'prefill', 'other'] as const) {
      test.census.setPhase({ value });
      expect(test.call()).toBe(0);
    }
    expect(test.now).not.toHaveBeenCalled();
    const metadata = test.read.getMockImplementation()!();
    test.read.mockImplementation(() => ({ ...metadata, compute: false, metadataOnly: true, op: 'GGML_OP_VIEW' }));
    test.census.setPhase({ value: 'decode' });
    expect(test.call()).toBe(1);
    test.advance({ ms: 4 });
    expect(test.call({ ask: 0 })).toBe(1);
    const snapshot = backendCensusSchema.parse(test.census.snapshot());
    expect(snapshot.decodeCompletionTiming).toEqual({
      method: 'per-node-synchronized-wall-time',
      requestedNodes: 1,
      completedNodes: 1,
      timedNodes: 1,
      unattributedNodes: 0,
      unfinishedNodes: 0,
      skippedNodes: 0,
      errors: 0,
      totalMs: 4,
    });
    expect(snapshot.entries.filter(entry => entry.phase !== 'decode').every(entry => !entry.completionTiming)).toBe(true);
    expect(snapshot.entries.at(-1)?.completionTiming?.samples).toBe(1);
  });

  it('excludes metadata-read time, aggregates matching nodes, and snapshots without timing aliases', () => {
    using test = fixture({ timeDecode: true });
    const metadata = test.read.getMockImplementation()!();
    let ordinal = 0;
    test.read.mockImplementation(() => {
      test.advance({ ms: 1000 });
      return { ...metadata, name: `node-${++ordinal}` };
    });
    test.census.setPhase({ value: 'decode' });
    for (const ms of [4, 6]) {
      expect(test.call()).toBe(1);
      test.advance({ ms });
      expect(test.call({ ask: 0 })).toBe(1);
    }
    const first = backendCensusSchema.parse(test.census.snapshot());
    expect(first.decodeCompletionTiming?.totalMs).toBe(10);
    expect(first.entries[0]?.completionTiming).toEqual({ samples: 2, totalMs: 10, minMs: 4, maxMs: 6, maxNodeName: 'node-2', maxNodeIndex: 2 });
    test.call();
    test.advance({ ms: 7 });
    test.call({ ask: 0 });
    expect(first.entries[0]?.completionTiming?.samples).toBe(2);
    first.entries[0]!.completionTiming!.totalMs = 99999;
    first.decodeCompletionTiming!.totalMs = 99999;
    expect(test.census.snapshot().decodeCompletionTiming?.totalMs).toBe(17);
    expect(test.census.snapshot().entries[0]?.completionTiming).toMatchObject({ samples: 3, totalMs: 17, minMs: 4, maxMs: 7, maxNodeName: 'node-3', maxNodeIndex: 3 });
    expect(test.read).toHaveBeenCalledTimes(3);
  });

  it('separates mixed weight quantizations even when operation and destination match', () => {
    using test = fixture({ timeDecode: true });
    const metadata = test.read.getMockImplementation()!();
    test.census.setPhase({ value: 'decode' });
    for (const [index, type] of ['GGML_TYPE_Q4_K', 'GGML_TYPE_Q5_1', 'GGML_TYPE_IQ4_NL'].entries()) {
      test.read.mockReturnValue({ ...metadata, inputs: [{ type, shape: [640, 2560, 512, 1] }] });
      test.call();
      test.advance({ ms: index + 1 });
      test.call({ ask: 0 });
    }
    const report = backendCensusSchema.parse(test.census.snapshot());
    expect(report.entries.map(entry => [entry.inputs[0]?.type, entry.completionTiming?.totalMs])).toEqual([
      ['GGML_TYPE_Q4_K', 1], ['GGML_TYPE_Q5_1', 2], ['GGML_TYPE_IQ4_NL', 3],
    ]);
  });

  it('fences unrecorded nodes so read failures never charge their work to the next recorded operation', () => {
    using test = fixture({ timeDecode: true });
    test.census.setPhase({ value: 'decode' });
    test.read.mockImplementationOnce(() => {
      throw new Error('unavailable metadata');
    });
    expect(test.call()).toBe(1);
    test.advance({ ms: 100 });
    expect(test.call({ ask: 0 })).toBe(1);
    expect(test.call()).toBe(1);
    test.advance({ ms: 3 });
    test.call({ ask: 0 });
    expect(test.census.snapshot()).toMatchObject({
      errors: 1,
      decodeCompletionTiming: {
        requestedNodes: 2,
        completedNodes: 2,
        timedNodes: 2,
        unattributedNodes: 1,
        totalMs: 103,
      },
    });
    expect(test.census.snapshot().entries[0]?.completionTiming?.totalMs).toBe(3);
  });

  it('continues fencing beyond the metadata-shape cap and discloses unattributed completions', () => {
    using test = fixture({ timeDecode: true });
    test.census.setPhase({ value: 'decode' });
    const metadata = test.read.getMockImplementation()!();
    let size = 0;
    test.read.mockImplementation(() => ({ ...metadata, shape: [++size, 1, 1, 1] }));
    for (let index = 0; index < 515; index++) {
      expect(test.call()).toBe(1);
      test.advance({ ms: 1 });
      expect(test.call({ ask: 0 })).toBe(1);
    }
    const report = backendCensusSchema.parse(test.census.snapshot());
    expect(report.entries).toHaveLength(512);
    expect(report.droppedNodes).toBe(3);
    expect(report.decodeCompletionTiming).toMatchObject({ requestedNodes: 515, completedNodes: 515, timedNodes: 515, unattributedNodes: 3, totalMs: 515 });
    expect(report.entries.every(entry => entry.completionTiming?.samples === 1)).toBe(true);
  });

  it('caps decode requests and clock reads, preserves coverage counters, and fully resets for reuse', () => {
    using test = fixture({ timeDecode: true });
    test.census.setPhase({ value: 'prefill' });
    for (let index = 0; index < 25002; index++) {
      test.call();
    }
    expect(test.now).not.toHaveBeenCalled();
    test.census.setPhase({ value: 'decode' });
    for (let index = 0; index < 25000; index++) {
      test.call();
      test.call({ ask: 0 });
    }
    for (let index = 0; index < 5; index++) {
      expect(test.call()).toBe(0);
    }
    expect(test.now).toHaveBeenCalledTimes(50000);
    expect(test.census.snapshot().decodeCompletionTiming).toMatchObject({ requestedNodes: 25000, completedNodes: 25000, skippedNodes: 5, unfinishedNodes: 0 });
    test.census.reset();
    expect(test.census.snapshot()).toMatchObject({
      observedNodes: 0,
      droppedNodes: 0,
      errors: 0,
      entries: [],
      decodeCompletionTiming: {
        requestedNodes: 0,
        completedNodes: 0,
        timedNodes: 0,
        unattributedNodes: 0,
        skippedNodes: 0,
        errors: 0,
        unfinishedNodes: 0,
        totalMs: 0,
      },
    });
    test.census.setPhase({ value: 'decode' });
    expect(test.call()).toBe(1);
    test.call({ ask: 0 });
    expect(test.census.snapshot().entries[0]?.completionTiming?.samples).toBe(1);
  });

  it.each([4, 8] as const)('matches the actual %s-byte pointer callback and releases unfinished requests safely', pointerBytes => {
    using test = fixture({ timeDecode: true, pointerBytes });
    test.census.setPhase({ value: 'decode' });
    const tensor = pointerBytes === 4 ? -1 : 0x100000002n;
    expect(test.call({ tensor })).toBe(1);
    expect(test.read).toHaveBeenLastCalledWith({ tensor: pointerBytes === 4 ? 4294967295n : 0x100000002n });
    expect(backendCensusSchema.parse(test.census.snapshot()).decodeCompletionTiming?.unfinishedNodes).toBe(1);
    test.advance({ ms: 5 });
    expect(test.call({ tensor, ask: 0 })).toBe(1);
    expect(test.census.snapshot().decodeCompletionTiming?.unfinishedNodes).toBe(0);
    test.call({ tensor });
    test.census.release();
    const last = test.census.snapshot();
    expect(last.decodeCompletionTiming?.unfinishedNodes).toBe(1);
    expect(test.call({ tensor, ask: 0 })).toBe(1);
    expect(test.call({ tensor })).toBe(0);
    expect(test.census.snapshot()).toEqual(last);
    expect(test.remove).toHaveBeenCalledOnce();
  });

  it.each(['wrong-pointer', 'missing-completion'] as const)('stops timing after %s instead of attributing an unisolated prefix', failure => {
    using test = fixture({ timeDecode: true });
    test.census.setPhase({ value: 'decode' });
    expect(test.call({ tensor: 3 })).toBe(1);
    if (failure === 'wrong-pointer') {
      expect(test.call({ tensor: 7, ask: 0 })).toBe(1);
    } else {
      expect(test.call({ tensor: 4 })).toBe(0);
    }
    expect(test.call({ tensor: 5 })).toBe(0);
    const report = backendCensusSchema.parse(test.census.snapshot());
    expect(report.decodeCompletionTiming).toMatchObject({ errors: 1, unfinishedNodes: 1, completedNodes: 0, timedNodes: 0 });
    expect(report.entries.every(entry => entry.completionTiming === undefined)).toBe(true);
    test.census.reset();
    test.census.setPhase({ value: 'decode' });
    expect(test.call()).toBe(1);
    expect(test.call({ ask: 0 })).toBe(1);
    expect(test.census.snapshot().decodeCompletionTiming?.errors).toBe(0);
  });

  it.each([[NaN, 1], [1, NaN], [Infinity, 5], [3, 2], [-1e308, 1e308]])('contains invalid clock pair %s, %s without terminating inference', (start, end) => {
    using test = fixture({ timeDecode: true });
    test.census.setPhase({ value: 'decode' });
    test.now.mockReturnValueOnce(start).mockReturnValueOnce(end);
    expect(test.call()).toBe(1);
    expect(test.call({ ask: 0 })).toBe(1);
    const report = backendCensusSchema.parse(test.census.snapshot());
    expect(report.decodeCompletionTiming).toMatchObject({ errors: 1, requestedNodes: 1, completedNodes: 1, timedNodes: 0, unfinishedNodes: 0, totalMs: 0 });
    expect(report.entries[0]?.completionTiming).toBeUndefined();
  });

  it('contains clock exceptions and unexpected completions without returning an abort', () => {
    using test = fixture({ timeDecode: true });
    test.census.setPhase({ value: 'decode' });
    test.now.mockImplementationOnce(() => {
      throw new Error('clock failure');
    });
    expect(test.call()).toBe(1);
    expect(test.call({ ask: 0 })).toBe(1);
    expect(test.census.snapshot().decodeCompletionTiming).toMatchObject({ errors: 1, completedNodes: 1, timedNodes: 0 });
    expect(test.call({ ask: 0 })).toBe(1);
    expect(test.census.snapshot().decodeCompletionTiming?.errors).toBe(2);
  });
});
