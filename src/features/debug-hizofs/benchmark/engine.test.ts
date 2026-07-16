import { describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { createHizoFSBenchmarkPresetConfiguration } from './presets';
import type { HizoFSBenchmarkConfiguration } from './types';
import { cleanHizoFSBenchmarkData, runHizoFSBenchmark } from './engine';

function createTinyConfiguration(): HizoFSBenchmarkConfiguration {
  return {
    ...createHizoFSBenchmarkPresetConfiguration({ preset: 'quick' }),
    backendMode: 'compare' as const,
    workloads: ['small_files'],
    smallFiles: {
      count: 3,
      sizeBytes: 32,
    },
    measuredIterations: 1,
    warmupIterations: 0,
  };
}

describe('HizoFS benchmark engine', () => {
  it('compares isolated HizoFS and raw OPFS workloads and deletes run data', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'opfs-root' });
    const progressMessages: string[] = [];

    const report = await runHizoFSBenchmark({
      configuration: createTinyConfiguration(),
      onProgress: ({ progress }) => progressMessages.push(progress.message),
      assertActive: () => {},
      nativeOpfsRoot: root,
    });

    expect(report.status).toBe('completed');
    expect(report.results.map(result => result.caseId)).toEqual([
      'small_files_write',
      'small_files_read',
      'small_files_delete',
    ]);
    const readResult = report.results.find(result => result.caseId === 'small_files_read');
    expect(readResult?.backends.rawOpfs?.samples[0]?.checksum)
      .toBe(readResult?.backends.hizofs?.samples[0]?.checksum);
    for (const result of report.results) {
      expect(result.backends.rawOpfs?.sampleCount).toBe(1);
      expect(result.backends.hizofs?.sampleCount).toBe(1);
      expect(result.comparison?.durationRatio).toBeGreaterThanOrEqual(0);
    }
    expect(report.results[0]?.backends.hizofs?.hizoFSDiagnosticsTotals)
      .toMatchObject({
        backingStore: {
          readOperations: expect.any(Number),
          writeOperations: expect.any(Number),
        },
        commits: {
          superblockPublications: expect.any(Number),
        },
      });
    expect(report.results[0]?.backends.hizofs?.samples[0]?.hizoFSDiagnostics)
      .toMatchObject({
        backingStore: {
          readOperations: expect.any(Number),
          writeOperations: expect.any(Number),
        },
        commits: {
          superblockPublications: expect.any(Number),
        },
      });
    expect(
      report.results[0]?.backends.hizofs?.samples[0]
        ?.hizoFSDiagnostics?.commits.superblockPublications,
    ).toBeGreaterThan(0);
    expect(
      report.results[0]?.backends.hizofs?.samples[0]
        ?.hizoFSDiagnostics?.objects.created,
    ).toBeGreaterThan(0);
    expect(report.cleanup).toEqual({
      attempted: true,
      completed: true,
      retainedByConfiguration: false,
      remainingPaths: [],
    });
    const benchmarkRoot = await root.getDirectoryHandle('naidan-debug-benchmark');
    expect([...(await collectNames({ directory: benchmarkRoot }))]).toEqual([]);
    expect(progressMessages).toContain('Cleaning benchmark data');
  });

  it('removes retained benchmark runs through the explicit cleanup operation', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'opfs-root' });
    const configuration: HizoFSBenchmarkConfiguration = {
      ...createTinyConfiguration(),
      benchmarkDataRetention: 'keep_after_run',
    };

    const report = await runHizoFSBenchmark({
      configuration,
      onProgress: () => {},
      assertActive: () => {},
      nativeOpfsRoot: root,
    });

    expect(report.cleanup).toEqual({
      attempted: false,
      completed: false,
      retainedByConfiguration: true,
      remainingPaths: [`naidan-debug-benchmark/run-${report.runId}`],
    });

    await cleanHizoFSBenchmarkData({ nativeOpfsRoot: root });
    await expect(root.getDirectoryHandle('naidan-debug-benchmark'))
      .rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('returns a cancelled report and cleans the isolated run', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'opfs-root' });
    let activeChecks = 0;

    const report = await runHizoFSBenchmark({
      configuration: createTinyConfiguration(),
      onProgress: () => {},
      assertActive: () => {
        activeChecks += 1;
        throw new DOMException('cancelled', 'AbortError');
      },
      nativeOpfsRoot: root,
    });

    expect(activeChecks).toBeGreaterThan(0);
    expect(report.status).toBe('cancelled');
    expect(report.failure).toMatchObject({
      errorName: 'AbortError',
    });
    expect(report.cleanup.completed).toBe(true);
  });
});

async function collectNames({
  directory,
}: {
  directory: FileSystemDirectoryHandle;
}): Promise<readonly string[]> {
  const result: string[] = [];
  for await (const [name] of directory.entries()) result.push(name);
  return result;
}
