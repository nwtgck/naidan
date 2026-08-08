import { describe, expect, it } from 'vitest';
import { readStorageFileText } from '@/00-storage/service/storage-file-system/io';
import {
  HIZOFS_COMPREHENSIVE_FIXTURE_ROOT_PATH,
  generateHizoFSComprehensiveFixture,
  type HizoFSComprehensiveFixtureThresholds,
} from './comprehensive-workload';
import { createInMemoryStorageRoot } from '@/00-storage/service/storage-file-system/test-support/in-memory-storage-file-system';

const thresholds = {
  directoryIndexLeafEntryLimit: 5,
  fileChunkSize: 32,
  fileExtentIndexLeafEntryLimit: 3,
  inodeIndexLeafEntryLimit: 8,
  inlineDirectoryEncodedByteLimit: 128,
  inlineFileByteLimit: 16,
} as const satisfies HizoFSComprehensiveFixtureThresholds;

describe('HizoFS comprehensive fixture workload', () => {
  it('generates deterministic public-API coverage without owning format authority', async () => {
    const root = createInMemoryStorageRoot({ name: 'decrypted-root' });
    const progressPhases: string[] = [];

    const result = await generateHizoFSComprehensiveFixture({
      root,
      thresholds,
      onProgress: ({ progress }) => progressPhases.push(progress.phase),
    });

    expect(result.rootPath).toBe(HIZOFS_COMPREHENSIVE_FIXTURE_ROOT_PATH);
    expect(progressPhases).toEqual([
      'preparing',
      'directories',
      'files',
      'indexes',
      'symlinks',
      'mutations',
      'manifest',
      'complete',
    ]);
    expect(result.coverage.map(entry => entry.id)).toContain('extent-index-branch');

    const fixtureRoot = await root.getDirectoryHandle({
      name: '__hizofs_fixture__',
      create: false,
    });
    const manifestText = await readStorageFileText({
      fileHandle: await fixtureRoot.getFileHandle({ name: 'manifest.json', create: false }),
    });
    expect(manifestText).toContain('HizoFS persisted data-structure coverage');
    expect(manifestText).toContain('extent-index-branch');
    expect(await (await fixtureRoot.getDirectoryHandle({ name: 'links', create: false }))
      .getEntryHandle({ name: 'dangling' })).toMatchObject({ kind: 'symlink' });
  });

  it('refuses to merge a second fixture into the same root', async () => {
    const root = createInMemoryStorageRoot({ name: 'decrypted-root' });
    await generateHizoFSComprehensiveFixture({ root, thresholds, onProgress: () => undefined });

    await expect(generateHizoFSComprehensiveFixture({
      root,
      thresholds,
      onProgress: () => undefined,
    })).rejects.toThrow(`${HIZOFS_COMPREHENSIVE_FIXTURE_ROOT_PATH} already exists`);
  });

  it('rejects invalid caller-provided thresholds before mutating the target', async () => {
    const root = createInMemoryStorageRoot({ name: 'decrypted-root' });
    await expect(generateHizoFSComprehensiveFixture({
      root,
      thresholds: { ...thresholds, fileChunkSize: 0 },
      onProgress: () => undefined,
    })).rejects.toThrow('fileChunkSize');
    await expect(root.getDirectoryHandle({ name: '__hizofs_fixture__', create: false }))
      .rejects.toMatchObject({ name: 'NotFoundError' });
  });
});
