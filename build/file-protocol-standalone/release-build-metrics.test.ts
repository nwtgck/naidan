import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { collectStandaloneWorkerBudgetFailures, createStandaloneWorkerMetricsPlan, measureStandaloneWorkerMetricsFromDisk } from './release-build-metrics.js';

const files = [
  'assets/ui.js',
  'assets/shared.js',
  'assets/lazy.js',
  'assets/worker.js',
  'file-protocol-standalone/system.min.js',
  'assets/ui.css',
];

const chunks = [
  {
    fileName: 'assets/ui.js',
    isEntry: true,
    imports: ['assets/shared.js'],
    dynamicImports: ['assets/lazy.js'],
    moduleIds: ['/src/ui.ts'],
  },
  {
    fileName: 'assets/shared.js',
    imports: [],
    dynamicImports: [],
    moduleIds: ['/src/shared.ts'],
  },
  {
    fileName: 'assets/lazy.js',
    imports: [],
    dynamicImports: [],
    moduleIds: ['/src/lazy.ts'],
  },
  {
    fileName: 'assets/worker.js',
    isEntry: true,
    imports: ['assets/shared.js'],
    dynamicImports: [],
    moduleIds: ['/src/worker.ts'],
  },
];

function createPlan(overrides: Partial<Parameters<typeof createStandaloneWorkerMetricsPlan>[0]> = {}) {
  return createStandaloneWorkerMetricsPlan({
    files,
    chunks,
    uiEntryFileName: 'assets/ui.js',
    workers: [{ name: 'worker', entryFileName: 'assets/worker.js' }],
    runtimeFileNames: ['file-protocol-standalone/system.min.js'],
    initialStyleFileNames: ['assets/ui.css'],
    ...overrides,
  });
}

describe('createStandaloneWorkerMetricsPlan', () => {
  it('computes deterministic static and reachable closures for UI and Workers', () => {
    const plan = createPlan();

    expect(plan.ui.staticChunkClosure).toEqual(['assets/shared.js', 'assets/ui.js']);
    expect(plan.ui.reachableChunkClosure).toEqual(['assets/lazy.js', 'assets/shared.js', 'assets/ui.js']);
    expect(plan.workers[0]?.staticChunkClosure).toEqual(['assets/shared.js', 'assets/worker.js']);
    expect(plan.ui.initialFiles).toEqual([
      'assets/shared.js',
      'assets/ui.css',
      'assets/ui.js',
      'file-protocol-standalone/system.min.js',
    ]);
  });

  it('counts shared physical files once while charging shared cold-start bytes to every Worker Realm', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'naidan-worker-metrics-'));
    const sizedFiles = {
      'assets/ui.js': 10,
      'assets/ui-worker-shared.js': 20,
      'assets/worker-shared.js': 30,
      'assets/worker-a.js': 40,
      'assets/worker-b.js': 50,
      'assets/worker-subset-lazy.js': 60,
      'file-protocol-standalone/system.min.js': 7,
      'assets/ui.css': 3,
    } as const;
    try {
      await Promise.all(Object.entries(sizedFiles).map(async ([fileName, bytes]) => {
        const absolute = path.join(root, fileName);
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        await fs.writeFile(absolute, Buffer.alloc(bytes));
      }));
      const plan = createStandaloneWorkerMetricsPlan({
        files: Object.keys(sizedFiles),
        chunks: [
          {
            fileName: 'assets/ui.js',
            isEntry: true,
            imports: ['assets/ui-worker-shared.js'],
            dynamicImports: [],
            moduleIds: ['/src/ui.ts'],
          },
          {
            fileName: 'assets/ui-worker-shared.js',
            imports: [],
            dynamicImports: [],
            moduleIds: ['/src/ui-worker-shared.ts'],
          },
          {
            fileName: 'assets/worker-shared.js',
            imports: [],
            dynamicImports: [],
            moduleIds: ['/src/worker-shared.ts'],
          },
          {
            fileName: 'assets/worker-a.js',
            isEntry: true,
            imports: ['assets/ui-worker-shared.js', 'assets/worker-shared.js'],
            dynamicImports: ['assets/worker-subset-lazy.js'],
            moduleIds: ['/src/worker-a.ts'],
          },
          {
            fileName: 'assets/worker-b.js',
            isEntry: true,
            imports: ['assets/ui-worker-shared.js', 'assets/worker-shared.js'],
            dynamicImports: ['assets/worker-subset-lazy.js'],
            moduleIds: ['/src/worker-b.ts'],
          },
          {
            fileName: 'assets/worker-subset-lazy.js',
            imports: [],
            dynamicImports: [],
            moduleIds: ['/src/worker-subset-lazy.ts'],
          },
        ],
        uiEntryFileName: 'assets/ui.js',
        workers: [
          { name: 'worker-a', entryFileName: 'assets/worker-a.js' },
          { name: 'worker-b', entryFileName: 'assets/worker-b.js' },
        ],
        runtimeFileNames: ['file-protocol-standalone/system.min.js'],
        initialStyleFileNames: ['assets/ui.css'],
        bootstrapSourceBytes: 5,
      });
      const metrics = await measureStandaloneWorkerMetricsFromDisk({
        plan,
        outputDirectory: root,
      });

      expect(metrics.ui.initialRequestBytes).toBe(40);
      expect(metrics.workers.map(({ name, staticBytes, reachableBytes }) => ({ name, staticBytes, reachableBytes }))).toEqual([
        { name: 'worker-a', staticBytes: 102, reachableBytes: 162 },
        { name: 'worker-b', staticBytes: 112, reachableBytes: 172 },
      ]);
      expect(metrics.workerGraph).toMatchObject({
        staticUnionBytes: 152,
        reachableUnionBytes: 212,
        sharedWithUiFiles: ['assets/ui-worker-shared.js', 'file-protocol-standalone/system.min.js'],
        sharedWithUiBytes: 27,
        workerOnlyStaticFiles: ['assets/worker-a.js', 'assets/worker-b.js', 'assets/worker-shared.js'],
        workerOnlyStaticBytes: 120,
        cumulativeColdStartEvaluationBytes: 214,
        maxWorkerStaticBytes: 112,
      });
      expect(collectStandaloneWorkerBudgetFailures({
        metrics,
        budgets: {
          maxWorkerStaticUnionBytes: 152,
          maxCumulativeWorkerColdStartBytes: 214,
          maxWorkerStaticBytes: 112,
          maxWorkerStaticBytesByName: { 'worker-a': 102, 'worker-b': 112 },
        },
      })).toEqual([]);
      expect(collectStandaloneWorkerBudgetFailures({
        metrics,
        budgets: {
          maxWorkerStaticUnionBytes: 151,
          maxCumulativeWorkerColdStartBytes: 213,
          maxWorkerStaticBytes: 111,
          maxWorkerStaticBytesByName: { 'worker-a': 101 },
        },
      })).toEqual([
        'Worker static union 152 bytes exceeds 151 bytes',
        'all-Worker cumulative cold-start evaluation 214 bytes exceeds 213 bytes',
        'largest Worker static closure 112 bytes exceeds 111 bytes',
        'Worker worker-a static closure 102 bytes exceeds 101 bytes',
      ]);
      expect(collectStandaloneWorkerBudgetFailures({
        metrics: {
          ...metrics,
          deduplication: {
            duplicateModuleOwners: [{ moduleId: '/src/shared.ts', owners: ['assets/a.js', 'assets/b.js'] }],
            duplicateModuleOwnerCount: 1,
          },
        },
      })).toEqual(['duplicate module owners 1 exceeds 0']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when distribution files and the chunk graph disagree', () => {
    expect(() => createPlan({ files: files.filter(fileName => fileName !== 'assets/shared.js') }))
      .toThrow('Output chunk is missing from distribution files: assets/shared.js');

    expect(() => createPlan({
      chunks: chunks.map(chunk => chunk.fileName === 'assets/ui.js'
        ? { ...chunk, imports: ['assets/missing.js'] }
        : chunk),
    })).toThrow('Output chunk assets/ui.js references a missing chunk: assets/missing.js');

    expect(() => createPlan({ uiEntryFileName: 'assets/missing-ui.js' }))
      .toThrow('UI entry chunk is missing from the chunk graph: assets/missing-ui.js');

    expect(() => createPlan({ workers: [{ name: 'worker', entryFileName: 'assets/missing-worker.js' }] }))
      .toThrow('Worker entry chunk is missing from the chunk graph: worker: assets/missing-worker.js');
  });

  it('detects duplicate module ownership and rejects invalid duplicate/output-file references', () => {
    expect(() => createPlan({ chunks: [...chunks, chunks[0]!] }))
      .toThrow('Duplicate output chunk file name: assets/ui.js');

    const duplicateModulePlan = createPlan({
      chunks: chunks.map(chunk => chunk.fileName === 'assets/lazy.js'
        ? { ...chunk, moduleIds: [...chunk.moduleIds, '/src/shared.ts'] }
        : chunk),
    });
    expect(duplicateModulePlan.duplicateModuleOwners).toEqual([{
      moduleId: '/src/shared.ts',
      owners: ['assets/lazy.js', 'assets/shared.js'],
    }]);

    expect(() => createPlan({ runtimeFileNames: ['file-protocol-standalone/missing-system.js'] }))
      .toThrow('Runtime file is missing from distribution files: file-protocol-standalone/missing-system.js');

    expect(() => createPlan({ initialStyleFileNames: ['assets/missing.css'] }))
      .toThrow('Initial stylesheet is missing from distribution files: assets/missing.css');
  });
});
