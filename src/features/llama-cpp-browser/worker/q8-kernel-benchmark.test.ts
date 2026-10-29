// @vitest-environment node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createCore, type Core } from '@/features/llama-cpp-browser/runtime/core';
import { TEST_ONLY } from './q8-kernel-benchmark';
import { createBenchmarkFixture } from './q8-kernel-benchmark.test-support';
import { createQ8KernelPairedSchedule, q8KernelVariants, type Q8KernelBenchmarkProgress } from '@/features/llama-cpp-browser/performance/q8-kernel-schema';

describe('explicit Q8 kernel benchmark', () => {
  let base: Core;

  beforeAll(async () => {
    const baseURL = pathToFileURL(path.resolve('node_modules/llama-cpp-browser-core/llama-cpp-browser-core/profiles') + '/');
    base = await createCore({
      profile: 'cpu-wasm32',
      baseURL,
      moduleOptions: {
        wasmBinary: await readFile(new URL('cpu-wasm32/browser/core.wasm', baseURL)),
        print() {},
        printErr() {},
      },
    });
  });

  it('uses independent CPU dequantization for exact warmups, follows all four fair orders and frees each shape before the next', async () => {
    await using fixture = createBenchmarkFixture({ base });
    const progress: Q8KernelBenchmarkProgress[] = [];
    const result = await TEST_ONLY.runBenchmark({
      input: {
        core: fixture.core,
        diagnostic: fixture.diagnostic,
        signal: undefined,
        onProgress: ({ progress: value }) => progress.push(value),
      },
      shapes: [[64, 5], [96, 3]],
      pairedShapes: [],
      validate: ({ result }) => result,
    });
    expect(result.status).toBe('complete');
    expect(result.shapes).toHaveLength(2);
    for (const shape of result.shapes) {
      expect(shape.variants.map(row => row.variant)).toEqual(q8KernelVariants);
      expect(shape.samples.map(row => row.variant)).toEqual([...q8KernelVariants, ...[...q8KernelVariants].reverse(), ...q8KernelVariants, ...[...q8KernelVariants].reverse()]);
      expect(shape.samples.every(row => row.report.dispatches === 32 && row.timingStatus === 'measured' && row.gpuMsPerDispatch === 2)).toBe(true);
      expect(shape.variants.every(row => row.prepare.report.dispatches === 0 && row.warmup?.call.report.dispatches === 1
        && row.warmup.exact?.mismatches === 0 && row.warmup.exact.actualSha256 === shape.fixture.expectedSha256)).toBe(true);
      expect(shape.inputsUnchanged).toMatchObject({ weights: true, input: true, guards: true });
    }
    expect(fixture.state.calls).toHaveLength(72);
    expect(fixture.state.calls.slice(0, 6).every(call => call.phase === 'prepare')).toBe(true);
    expect(fixture.state.calls.slice(6, 12).every(call => call.phase === 'execute' && call.repetitions === 1)).toBe(true);
    expect(result.shapes.every(shape => shape.samples.every(sample => sample.exact.words === shape.m && sample.exact.mismatches === 0
      && sample.exact.actualSha256 === shape.fixture.expectedSha256 && sample.readbackMs >= 0))).toBe(true);
    expect(fixture.events.indexOf('free-context')).toBeLessThan(fixture.events.lastIndexOf('context-init'));
    expect(fixture.events.at(-1)).toBe('free-backend');
    expect(fixture.allocations.size + fixture.buffers.size + fixture.contexts.size + fixture.backends.size).toBe(0);
    expect(progress.some(value => value.phase === 'verifying')).toBe(true);
    expect(Math.max(...progress.map(value => value.completedSamples))).toBe(48);
  });

  it.each(['quantized', 'unavailable'] as const)('keeps %s GPU evidence without producing a winner', async timestamps => {
    await using fixture = createBenchmarkFixture({ base });
    fixture.state.timestamps = timestamps;
    const result = await TEST_ONLY.runBenchmark({ input: { core: fixture.core, diagnostic: fixture.diagnostic, signal: undefined, onProgress() {} }, shapes: [[32, 3]], pairedShapes: [], validate: ({ result }) => result });
    expect(result.shapes[0]!.samples.every(sample => sample.timingStatus === timestamps && sample.gpuMsPerDispatch === (timestamps === 'quantized' ? 0 : undefined))).toBe(true);
    expect(result).not.toHaveProperty('winner');
  });

  it.each([false, true])('runs 8 adjacent ABBA/BAAB blocks after A/B re-warmups on the same allocation (same shader: %s)', async sameShader => {
    await using fixture = createBenchmarkFixture({ base });
    fixture.state.sameShader = sameShader;
    const progress: Q8KernelBenchmarkProgress[] = [];
    const result = await TEST_ONLY.runBenchmark({
      input: {
        core: fixture.core,
        diagnostic: fixture.diagnostic,
        signal: undefined,
        onProgress: ({ progress: value }) => progress.push(value),
      },
      shapes: [[64, 5]],
      pairedShapes: [[64, 5]],
      validate: ({ result }) => result,
    });
    const shape = result.shapes[0]!, paired = shape.pairedComparison!;
    expect(shape.samples).toHaveLength(24);
    expect(paired.status).toBe('complete');
    expect(paired.warmups.map(row => [row.variant, row.call.report.dispatches])).toEqual([['auto', 1], ['independent-wg128-r4', 1]]);
    expect(paired.samples.map(({ variant, block, order, arm, position, sequence }) => ({ variant, block, order, arm, position, sequence }))).toEqual(createQ8KernelPairedSchedule({ blocks: 8 }));
    expect(paired.samples.map(sample => sample.arm).join('')).toBe('ABBABAAB'.repeat(4));
    expect(paired.samples[0]!.report.rowsPerTile === paired.samples[1]!.report.rowsPerTile).toBe(sameShader);
    expect(paired.samples.every((sample, i) => sample.report.dispatches === 32 && sample.exact.words === 5 && sample.exact.guards
      && sample.callEndedMs >= sample.callStartedMs && sample.wallMs === sample.callEndedMs - sample.callStartedMs
      && (!i || sample.callStartedMs >= paired.samples[i - 1]!.callEndedMs))).toBe(true);
    expect(fixture.state.calls).toHaveLength(70);
    expect(fixture.state.calls.slice(36, 38).map(call => [call.variant, call.repetitions])).toEqual([['auto', 1], ['independent-wg128-r4', 1]]);
    expect(fixture.state.calls.slice(38).map(call => call.variant)).toEqual(createQ8KernelPairedSchedule({ blocks: 8 }).map(row => row.variant));
    expect(new Set(fixture.state.calls.map(call => `${call.backend}:${call.dst}`)).size).toBe(1);
    expect(fixture.events.filter(event => event === 'buffer-init')).toHaveLength(1);
    expect(progress.every(row => row.totalSamples === 256 && 'section' in row && row.completedSamples === row.baseCompletedSamples + row.pairedCompletedSamples)).toBe(true);
    expect(progress.filter(row => 'section' in row && row.section === 'paired').every(row => 'baseCompletedSamples' in row && row.baseCompletedSamples === 24)).toBe(true);
    expect(progress.at(-1)).toMatchObject({ completedSamples: 56, totalSamples: 256, baseCompletedSamples: 24, pairedCompletedSamples: 32 });
    expect(shape.inputsUnchanged).toMatchObject({ weights: true, input: true, guards: true });
    expect(fixture.allocations.size + fixture.buffers.size + fixture.contexts.size + fixture.backends.size).toBe(0);
  });

  it('does not replace an unsupported paired arm with another variant or run one-sided blocks', async () => {
    await using fixture = createBenchmarkFixture({ base });
    fixture.state.unsupported.add('independent-wg128-r4');
    const result = await TEST_ONLY.runBenchmark({
      input: { core: fixture.core, diagnostic: fixture.diagnostic, signal: undefined, onProgress() {} },
      shapes: [[64, 5]],
      pairedShapes: [[64, 5]],
      validate: ({ result }) => result,
    });
    expect(result.status).toBe('partial');
    expect(result.shapes[0]!.samples).toHaveLength(20);
    expect(result.shapes[0]!.pairedComparison).toMatchObject({ status: 'unsupported', warmups: [], samples: [] });
    expect(fixture.events.at(-1)).toBe('free-backend');
  });

  it('records a newly unsupported paired warmup after preserving all 24 base samples', async () => {
    await using fixture = createBenchmarkFixture({ base });
    fixture.state.onInvoke = () => {
      if (fixture.state.calls.length === 38) {
        fixture.state.unsupported.add('independent-wg128-r4');
      }
    };
    const result = await TEST_ONLY.runBenchmark({
      input: { core: fixture.core, diagnostic: fixture.diagnostic, signal: undefined, onProgress() {} },
      shapes: [[64, 5]],
      pairedShapes: [[64, 5]],
      validate: ({ result }) => result,
    });
    expect(result.status).toBe('partial');
    const shape = result.shapes[0]!, paired = shape.pairedComparison!;
    expect(shape.samples).toHaveLength(24);
    expect(paired.status).toBe('unsupported');
    expect(paired.samples).toEqual([]);
    expect(paired.warmups).toHaveLength(2);
    expect(paired.warmups[0]!.exact?.guards).toBe(true);
    expect(paired.warmups[1]!.call.report.status).toBe('unsupported');
    expect(paired.warmups[1]!.exact).toBeUndefined();
    expect(fixture.state.calls).toHaveLength(38);
    expect(fixture.events.at(-1)).toBe('free-backend');
  });

  it('keeps a cancelled paired prefix and waits for its native call before freeing', async () => {
    await using fixture = createBenchmarkFixture({ base });
    const controller = new AbortController(), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    fixture.state.onInvoke = () => {
      if (fixture.state.calls.length === 42) {
        fixture.state.delay = gate.promise;
        entered.resolve();
      }
    };
    const pending = TEST_ONLY.runBenchmark({
      input: { core: fixture.core, diagnostic: fixture.diagnostic, signal: controller.signal, onProgress() {} },
      shapes: [[64, 5]],
      pairedShapes: [[64, 5]],
      validate: ({ result }) => result,
    });
    await entered.promise;
    const before = [...fixture.events];
    controller.abort();
    await Promise.resolve();
    expect(fixture.events).toEqual(before);
    gate.resolve();
    const result = await pending;
    expect(result.status).toBe('cancelled');
    expect(result.shapes[0]!.pairedComparison).toMatchObject({ status: 'cancelled' });
    expect(result.shapes[0]!.pairedComparison!.samples.map(row => row.sequence)).toEqual([0, 1, 2]);
    expect(fixture.state.calls).toHaveLength(42);
    expect(fixture.events.at(-1)).toBe('free-backend');
    expect(fixture.allocations.size + fixture.buffers.size + fixture.contexts.size + fixture.backends.size).toBe(0);
  });

  it('rejects a paired-only output bit flip outside the timestamp interval and skips unsafe frees', async () => {
    await using fixture = createBenchmarkFixture({ base });
    fixture.state.corruptAtCall = 39;
    await expect(TEST_ONLY.runBenchmark({
      input: { core: fixture.core, diagnostic: fixture.diagnostic, signal: undefined, onProgress() {} },
      shapes: [[64, 5]],
      pairedShapes: [[64, 5]],
      validate: ({ result }) => result,
    })).rejects.toThrow('exact bytes');
    expect(fixture.state.calls).toHaveLength(39);
    expect(fixture.events).not.toContain('free-context');
    expect(fixture.events).not.toContain('free-backend');
  });

  it('records unsupported variants without substituting another kernel or changing the remaining fair order', async () => {
    await using fixture = createBenchmarkFixture({ base });
    fixture.state.unsupported.add('independent-wg128-r4');
    const result = await TEST_ONLY.runBenchmark({ input: { core: fixture.core, diagnostic: fixture.diagnostic, signal: undefined, onProgress() {} }, shapes: [[64, 7]], pairedShapes: [], validate: ({ result }) => result });
    expect(result.status).toBe('partial');
    const shape = result.shapes[0]!;
    expect(shape.variants[2]).toMatchObject({ variant: 'independent-wg128-r4', prepare: { report: { status: 'unsupported', algorithm: 'none', workgroupSize: 0 } } });
    expect(shape.variants[2]!.warmup).toBeUndefined();
    expect(shape.samples).toHaveLength(20);
    expect(shape.samples.some(sample => sample.variant === 'independent-wg128-r4')).toBe(false);
    expect(shape.samples.filter(sample => sample.round === 1).map(sample => sample.position)).toEqual([0, 1, 2, 4, 5]);
  });

  it('does not issue backend/native calls when already cancelled', async () => {
    await using fixture = createBenchmarkFixture({ base });
    const controller = new AbortController();
    controller.abort();
    const result = await TEST_ONLY.runBenchmark({ input: { core: fixture.core, diagnostic: fixture.diagnostic, signal: controller.signal, onProgress() {} }, shapes: [[32, 3]], pairedShapes: [], validate: ({ result }) => result });
    expect(result.status).toBe('cancelled');
    expect(fixture.events).toEqual([]);
  });

  it('waits for a suspended native operation before cancellation cleanup and never races frees against it', async () => {
    await using fixture = createBenchmarkFixture({ base });
    const controller = new AbortController(), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    fixture.state.delay = gate.promise;
    fixture.state.onInvoke = () => entered.resolve();
    const pending = TEST_ONLY.runBenchmark({ input: { core: fixture.core, diagnostic: fixture.diagnostic, signal: controller.signal, onProgress() {} }, shapes: [[32, 3]], pairedShapes: [], validate: ({ result }) => result });
    await entered.promise;
    const before = [...fixture.events];
    controller.abort();
    await Promise.resolve();
    expect(fixture.events).toEqual(before);
    expect(fixture.buffers.size).toBe(1);
    gate.resolve();
    const result = await pending;
    expect(result.status).toBe('cancelled');
    expect(fixture.state.calls).toHaveLength(1);
    expect(fixture.events.at(-1)).toBe('free-backend');
    expect(fixture.allocations.size + fixture.buffers.size + fixture.contexts.size + fixture.backends.size).toBe(0);
  });

  it.each(['native-failure', 'exact-mismatch', 'cleanup-trap'] as const)('discards ownership rather than making further frees after %s', async failure => {
    await using fixture = createBenchmarkFixture({ base });
    fixture.state.fail = failure === 'native-failure';
    fixture.state.corrupt = failure === 'exact-mismatch';
    fixture.state.cleanupTrap = failure === 'cleanup-trap';
    await expect(TEST_ONLY.runBenchmark({ input: { core: fixture.core, diagnostic: fixture.diagnostic, signal: undefined, onProgress() {} }, shapes: [[32, 3]], pairedShapes: [], validate: ({ result }) => result })).rejects.toThrow();
    expect(fixture.events).not.toContain('free-context');
    expect(fixture.events).not.toContain('free-backend');
    expect(fixture.buffers.size).toBe(1);
    expect(fixture.contexts.size).toBe(1);
  });

  it('rejects an output bit flip that occurs only for measured repetitions 32 after all six warmups passed', async () => {
    await using fixture = createBenchmarkFixture({ base });
    fixture.state.corruptAtRepetitions = 32;
    await expect(TEST_ONLY.runBenchmark({ input: { core: fixture.core, diagnostic: fixture.diagnostic, signal: undefined, onProgress() {} }, shapes: [[64, 5]], pairedShapes: [], validate: ({ result }) => result })).rejects.toThrow('exact bytes');
    expect(fixture.state.calls).toHaveLength(13);
    expect(fixture.state.calls.slice(6, 12).every(call => call.repetitions === 1)).toBe(true);
    expect(fixture.state.calls[12]!.repetitions).toBe(32);
    expect(fixture.events).not.toContain('free-context');
    expect(fixture.events).not.toContain('free-backend');
  });

  it('stops a chunked weight readback immediately after its pending first chunk settles on cancellation', async () => {
    await using fixture = createBenchmarkFixture({ base });
    const controller = new AbortController(), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    fixture.state.unsupported = new Set(q8KernelVariants);
    const pending = TEST_ONLY.runBenchmark({
      input: {
        core: fixture.core,
        diagnostic: fixture.diagnostic,
        signal: controller.signal,
        onProgress({ progress }) {
          if (progress.phase === 'verifying') {
            fixture.state.readbackDelay = gate.promise;
            fixture.state.onReadback = () => entered.resolve();
          }
        },
      },
      shapes: [[2048, 33]],
      pairedShapes: [],
      validate: ({ result }) => result,
    });
    await entered.promise;
    const before = [...fixture.events];
    controller.abort();
    await Promise.resolve();
    expect(fixture.events).toEqual(before);
    expect(fixture.buffers.size).toBe(1);
    gate.resolve();
    const result = await pending;
    expect(result.status).toBe('cancelled');
    expect(fixture.events.filter(event => event === 'readback')).toHaveLength(1);
    expect(fixture.events.at(-1)).toBe('free-backend');
    expect(result.shapes[0]!.inputsUnchanged).toBeUndefined();
  });

  it('keeps fixture bytes deterministic and all signed integer products exactly representable in either reduction order', () => {
    const fixture = TEST_ONLY.createFixture({ k: 640, m: 5 });
    expect(TEST_ONLY.createFixture({ k: 640, m: 5 })).toEqual(fixture);
    const weights = new DataView(fixture.weights.buffer), input = new DataView(fixture.input.buffer), expected = new DataView(fixture.expected.buffer);
    for (let row = 0; row < 5; row++) {
      const products: number[] = [];
      for (let column = 0; column < 640; column++) {
        const at = (row * 20 + Math.floor(column / 32)) * 34;
        expect(weights.getUint16(at, true)).toBe(0x2c00);
        const quant = weights.getInt8(at + 2 + column % 32), vector = input.getFloat32(column * 4, true);
        expect(Math.abs(quant)).toBeLessThanOrEqual(8);
        expect(Number.isInteger(vector * 16)).toBe(true);
        products.push(quant * vector / 16);
      }
      const forward = products.reduce((sum, value) => Math.fround(sum + value), 0);
      const reverse = products.reverse().reduce((sum, value) => Math.fround(sum + value), 0);
      expect(forward).toBe(expected.getFloat32(row * 4, true));
      expect(reverse).toBe(forward);
    }
    expect(fixture.maximumAbsoluteIntegerSum).toBeLessThan(2 ** 24);
    expect(() => TEST_ONLY.createFixture({ k: 33, m: 3 })).toThrow();
  });
});
