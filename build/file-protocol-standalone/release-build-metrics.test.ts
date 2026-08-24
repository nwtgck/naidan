import { describe, expect, it } from 'vitest';

import { createStandaloneWorkerMetricsPlan } from './release-build-metrics.js';

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

  it('rejects duplicate chunk ownership and runtime/style files outside the distribution', () => {
    expect(() => createPlan({ chunks: [...chunks, chunks[0]!] }))
      .toThrow('Duplicate output chunk file name: assets/ui.js');

    expect(() => createPlan({ runtimeFileNames: ['file-protocol-standalone/missing-system.js'] }))
      .toThrow('Runtime file is missing from distribution files: file-protocol-standalone/missing-system.js');

    expect(() => createPlan({ initialStyleFileNames: ['assets/missing.css'] }))
      .toThrow('Initial stylesheet is missing from distribution files: assets/missing.css');
  });
});
