import { describe, expect, it } from 'vitest';
import { TEST_ONLY } from './engine';
import { hizoFSBenchmarkReportSchema } from './types';

type CaseSample = Parameters<typeof TEST_ONLY.aggregateSamples>[0]['samples'][number];

function createSample({ backend, phase, iteration, parameters, durationMs }: {
  backend: CaseSample['backend'];
  phase: CaseSample['sample']['phase'];
  iteration: number;
  parameters: CaseSample['parameters'];
  durationMs: number;
}): CaseSample {
  return {
    backend,
    workload: 'random_access',
    caseId: 'random_read',
    label: 'Random reads',
    parameters,
    sample: {
      iteration,
      phase,
      includedInAggregates: phase === 'measured',
      acceptedDurationMs: durationMs,
      settlementDurationMs: undefined,
      durationMs,
      operationCount: 10,
      bytesProcessed: 100,
      checksum: 42,
      apiOperations: {
        directoryHandleLookups: 0, directoryCreates: 0, fileHandleLookups: 0,
        fileCreates: 0, writableOpens: 0, writeCalls: 0, truncateCalls: 0,
        readableOpens: 0, readCalls: 0, directoryLists: 0, removeCalls: 0,
        cloneCalls: 0, bulkBuilderCreates: 0, bulkEntryCreates: 0, bulkCommits: 0,
      },
      memory: {
        maximumTrackedBytes: 0,
        largestTrackedAllocationBytes: 0,
        scope: 'benchmark_harness_buffers_only',
      },
      hizoFSDiagnostics: undefined,
      garbageCollection: undefined,
      foregroundLatency: undefined,
    },
  };
}

function aggregate({ samples }: { samples: readonly CaseSample[] }) {
  const [result] = TEST_ONLY.aggregateSamples({ samples });
  if (result === undefined) throw new TypeError('expected one benchmark case');
  return result;
}

describe('benchmark report sample parameters', () => {
  it.each([true, false])('keeps per-iteration observations with warmup=%s', warmup => {
    const samples: CaseSample[] = [];
    if (warmup) {
      samples.push(createSample({
        backend: 'raw_opfs', phase: 'warmup', iteration: 0,
        parameters: { fileSizeBytes: 100, uniqueBlockPositions: 99 }, durationMs: 10_000,
      }));
    }
    for (const [iteration, uniqueBlockPositions, durationMs] of [[0, 7, 10], [1, 8, 30]] as const) {
      for (const backend of ['raw_opfs', 'hizofs'] as const) {
        samples.push(createSample({
          backend, phase: 'measured', iteration,
          parameters: { fileSizeBytes: 100, uniqueBlockPositions }, durationMs,
        }));
      }
    }
    const result = aggregate({ samples });
    expect(result.parameters).toEqual({ fileSizeBytes: 100 });
    expect(result.backends.rawOpfs?.durationMs?.median).toBe(20);
    expect(result.backends.rawOpfs?.sampleCount).toBe(2);
    expect(result.backends.rawOpfs?.samples.map(sample => sample.parameters.uniqueBlockPositions))
      .toEqual(warmup ? [99, 7, 8] : [7, 8]);
    expect(hizoFSBenchmarkReportSchema.shape.results.element.safeParse(result).success).toBe(true);
  });

  it('preserves warmup-only samples without inventing measured aggregates', () => {
    const result = aggregate({ samples: [createSample({
      backend: 'raw_opfs', phase: 'warmup', iteration: 0,
      parameters: { uniqueBlockPositions: 99 }, durationMs: 100,
    })] });
    expect(result.parameters).toEqual({});
    expect(result.backends.rawOpfs).toMatchObject({ sampleCount: 0 });
    expect(result.backends.rawOpfs?.samples[0]?.parameters).toEqual({ uniqueBlockPositions: 99 });
    expect(result.backends.rawOpfs?.durationMs).toBeUndefined();
    expect(result.backends.rawOpfs?.operationsPerSecond).toBeUndefined();
    expect(result.backends.hizofs).toBeUndefined();
    expect(result.comparison).toBeUndefined();
    expect(hizoFSBenchmarkReportSchema.shape.results.element.safeParse(result).success).toBe(true);
  });

  it('uses only recorded measured samples when a backend has not completed measurement', () => {
    const result = aggregate({ samples: [
      createSample({
        backend: 'raw_opfs', phase: 'measured', iteration: 0,
        parameters: { fileSizeBytes: 100, uniqueBlockPositions: 7 }, durationMs: 10,
      }),
      createSample({
        backend: 'hizofs', phase: 'warmup', iteration: 0,
        parameters: { fileSizeBytes: 100, uniqueBlockPositions: 99 }, durationMs: 100,
      }),
    ] });
    expect(result.parameters).toEqual({ fileSizeBytes: 100, uniqueBlockPositions: 7 });
    expect(result.backends.hizofs?.samples).toHaveLength(1);
    expect(result.backends.hizofs?.sampleCount).toBe(0);
    expect(result.comparison).toBeUndefined();
  });

  it('does not promote backend-specific or missing parameters into common parameters', () => {
    const result = aggregate({ samples: [
      createSample({
        backend: 'raw_opfs', phase: 'measured', iteration: 0,
        parameters: { stable: false, count: 0, label: 'shared', uniqueBlockPositions: 7, rawOnly: 1 },
        durationMs: 10,
      }),
      createSample({
        backend: 'hizofs', phase: 'measured', iteration: 0,
        parameters: { stable: false, count: 0, label: 'shared', uniqueBlockPositions: 8 },
        durationMs: 20,
      }),
    ] });
    expect(result.parameters).toEqual({ stable: false, count: 0, label: 'shared' });
    expect(result.backends.rawOpfs?.samples[0]?.parameters.rawOnly).toBe(1);
    expect(result.backends.hizofs?.samples[0]?.parameters.uniqueBlockPositions).toBe(8);
  });

  it('keeps the completed prefix when cancellation leaves unequal backend sample counts', () => {
    const samples: CaseSample[] = [];
    for (const [backend, iteration, uniqueBlockPositions] of [
      ['raw_opfs', 0, 7], ['hizofs', 0, 7], ['raw_opfs', 1, 8],
    ] as const) {
      samples.push(createSample({
        backend, phase: 'measured', iteration,
        parameters: { fileSizeBytes: 100, uniqueBlockPositions }, durationMs: 10,
      }));
    }
    const result = aggregate({ samples });
    expect(result.parameters).toEqual({ fileSizeBytes: 100 });
    expect(result.backends.rawOpfs?.samples.map(sample => sample.parameters.uniqueBlockPositions))
      .toEqual([7, 8]);
    expect(result.backends.hizofs?.samples.map(sample => sample.parameters.uniqueBlockPositions))
      .toEqual([7]);
    expect(result.comparison).toBeUndefined();
  });

  it.each([
    { raw: [0], hizofs: [1], comparable: false },
    { raw: [3], hizofs: [3], comparable: true },
    { raw: [1, 0], hizofs: [0, 1], comparable: true },
    { raw: [0, 0, 1], hizofs: [0, 1, 1], comparable: false },
  ])('compares only matching measured iterations: %j', ({ raw, hizofs, comparable }) => {
    const samples = [
      ...raw.map(iteration => createSample({
        backend: 'raw_opfs', phase: 'measured', iteration,
        parameters: { count: 1 }, durationMs: 10,
      })),
      ...hizofs.map(iteration => createSample({
        backend: 'hizofs', phase: 'measured', iteration,
        parameters: { count: 1 }, durationMs: 20,
      })),
    ];
    const result = aggregate({ samples });
    expect(result.backends.rawOpfs?.sampleCount).toBe(raw.length);
    expect(result.backends.hizofs?.sampleCount).toBe(hizofs.length);
    expect(result.backends.rawOpfs?.durationMs?.median).toBe(10);
    expect(result.backends.hizofs?.durationMs?.median).toBe(20);
    if (comparable) expect(result.comparison?.durationRatio).toBe(2);
    else expect(result.comparison).toBeUndefined();
  });

  it('does not compare warmup-only backends even when their iteration identities match', () => {
    const samples = (['raw_opfs', 'hizofs'] as const).map(backend => createSample({
      backend, phase: 'warmup', iteration: 0,
      parameters: { count: 1 }, durationMs: 10,
    }));
    const result = aggregate({ samples });
    expect(result.backends.rawOpfs?.samples).toHaveLength(1);
    expect(result.backends.hizofs?.samples).toHaveLength(1);
    expect(result.parameters).toEqual({});
    expect(result.comparison).toBeUndefined();
  });
});
