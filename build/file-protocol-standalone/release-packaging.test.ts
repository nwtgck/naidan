import { describe, expect, it } from 'vitest';

import { createFileProtocolStandaloneReleasePackagingPlugin } from './plugin/release-packaging.js';

describe('createFileProtocolStandaloneReleasePackagingPlugin', () => {
  it('waits for earlier writeBundle hooks before package planning', () => {
    const plugin = createFileProtocolStandaloneReleasePackagingPlugin({
      outputDirectory: './dist/standalone',
      workerEntryModuleIds: ['/tmp/worker.ts'],
      packageRelease: async () => {},
    });

    const hook = plugin.writeBundle;
    if (typeof hook !== 'object' || hook === null) throw new Error('Expected ordered writeBundle hook');
    expect(hook.sequential).toBe(true);
  });

  it('rejects incomplete packaging configuration', () => {
    expect(() => createFileProtocolStandaloneReleasePackagingPlugin({
      outputDirectory: '',
      workerEntryModuleIds: ['/tmp/worker.ts'],
      packageRelease: async () => {},
    })).toThrow('outputDirectory is required');

    expect(() => createFileProtocolStandaloneReleasePackagingPlugin({
      outputDirectory: '/tmp/output',
      workerEntryModuleIds: ['/tmp/worker.ts'],
      packageRelease: undefined as never,
    })).toThrow('packageRelease is required');

    expect(() => createFileProtocolStandaloneReleasePackagingPlugin({
      outputDirectory: '/tmp/output',
      workerEntryModuleIds: [],
      packageRelease: async () => {},
    })).toThrow('workerEntryModuleIds must not be empty');
  });
});
