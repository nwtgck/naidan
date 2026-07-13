import { describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { writeStorageFileText } from '@/00-storage/service/storage-file-system/io';
import { createEncryptedOpfs } from '@/00-storage/service/encrypted-opfs/api';
import { createEncryptedOpfsInspectionReader } from '@/00-storage/service/encrypted-opfs/inspection';
import { createEncryptedOpfsInspectionWorker } from './impl';

const ROOT_KEY = new Uint8Array(32).fill(29);

describe('EncryptedOpfs inspection worker', () => {
  it('builds namespace and reachability views from persisted DTO records', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createEncryptedOpfs({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    const directory = await session.root.getDirectoryHandle({ name: 'docs', create: true });
    await writeStorageFileText({
      fileHandle: await directory.getFileHandle({ name: 'readme.txt', create: true }),
      value: 'hello',
    });
    await directory.createSymlink({ name: 'latest', target: 'readme.txt' });

    const reader = await createEncryptedOpfsInspectionReader({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    const worker = createEncryptedOpfsInspectionWorker();
    await worker.configure(reader);

    const namespace = await worker.readNamespace({ maximumEntryCount: 100 });
    expect(namespace.truncated).toBe(false);
    expect(namespace.issues).toEqual([]);
    expect(namespace.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/', kind: 'directory' }),
      expect.objectContaining({ path: '/docs', kind: 'directory' }),
      expect.objectContaining({ path: '/docs/readme.txt', kind: 'file', size: 5 }),
      expect.objectContaining({ path: '/docs/latest', kind: 'symlink' }),
    ]));

    const scan = await worker.runIntegrityScan();
    expect(scan.issues).toEqual([]);
    expect(scan.activeReachableObjectCount).toBeGreaterThan(0);
    expect(scan.reachableObjectCount).toBeGreaterThanOrEqual(scan.activeReachableObjectCount);
    expect(scan.physicalObjectCount).toBeGreaterThanOrEqual(scan.reachableObjectCount);
    expect(scan.recordKindCounts.commit).toBeGreaterThanOrEqual(1);

    const overview = await worker.readOverview();
    const commit = await worker.inspectObject({
      objectId: overview.activeCommitObjectId,
      binaryPayloadPreviewByteLength: 16,
    });
    expect(commit).toMatchObject({
      validation: { status: 'valid' },
      references: [{ relation: 'inode index root' }],
    });

    await reader.dispose();
    await session.close();
  });

  it('protects objects referenced only by the valid fallback superblock generation', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createEncryptedOpfs({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    await writeStorageFileText({
      fileHandle: await session.root.getFileHandle({ name: 'old.txt', create: true }),
      value: 'old',
    });
    const newFile = await session.root.getFileHandle({ name: 'new.txt', create: true });
    const readerBefore = await createEncryptedOpfsInspectionReader({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    const previousOverview = await readerBefore.readOverview();
    await readerBefore.dispose();

    await writeStorageFileText({
      fileHandle: newFile,
      value: 'new',
    });

    const reader = await createEncryptedOpfsInspectionReader({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    const worker = createEncryptedOpfsInspectionWorker();
    await worker.configure(reader);
    const scan = await worker.runIntegrityScan();

    expect(scan.fallbackReachableObjectCount).toBeGreaterThan(0);
    expect(scan.fallbackOnlyObjectIds).toContain(previousOverview.activeCommitObjectId);
    expect(scan.orphanObjectIds).not.toContain(previousOverview.activeCommitObjectId);

    await reader.dispose();
    await session.close();
  });

});
