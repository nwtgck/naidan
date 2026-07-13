import { describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { writeStorageFileText, readStorageFileText } from '@/00-storage/service/storage-file-system/io';
import type { StorageFileSystemSession } from '@/00-storage/service/storage-file-system/types';
import { collectEncryptedOpfsGarbage } from './garbage-collector';
import { inspectEncryptedOpfs, TEST_ONLY } from './api';
import type { EncryptedOpfsPolicy } from './file-system/policy';
import { getEncryptedOpfsObjectShard } from './object-store/object-id';
import { toExactArrayBuffer } from './bytes';

const ROOT_KEY = new Uint8Array(32).fill(17);
const TINY_POLICY: EncryptedOpfsPolicy = {
  inlineFileByteLimit: 8,
  inlineDirectoryEntryLimit: 2,
  fileChunkSize: 4,
  indexPageEntryLimit: 2,
  readerStreamChunkSize: 3,
};

function createTiny({ backing }: {
  backing: FileSystemDirectoryHandle;
}): Promise<StorageFileSystemSession> {
  return TEST_ONLY.createEncryptedOpfsInternal({
    backingDirectory: backing,
    fileSystemRootKey: ROOT_KEY,
    policy: TINY_POLICY,
    now: () => 1,
  });
}

function openTiny({ backing }: {
  backing: FileSystemDirectoryHandle;
}): Promise<StorageFileSystemSession> {
  return TEST_ONLY.openEncryptedOpfsInternal({
    backingDirectory: backing,
    fileSystemRootKey: ROOT_KEY,
    policy: TINY_POLICY,
    now: () => 2,
  });
}

async function writeLargeValue({ session, value }: {
  session: StorageFileSystemSession;
  value: string;
}): Promise<void> {
  const file = await session.root.getFileHandle({ name: 'value.txt', create: true });
  await writeStorageFileText({ fileHandle: file, value });
}

async function countPhysicalFiles({ directory }: {
  directory: FileSystemDirectoryHandle;
}): Promise<number> {
  let count = 0;
  for await (const [, handle] of directory.entries()) {
    if (handle.kind === 'file') {
      count += 1;
    } else {
      count += await countPhysicalFiles({ directory: handle });
    }
  }
  return count;
}

async function overwritePhysicalFile({
  backing,
  path,
  bytes,
}: {
  backing: FileSystemDirectoryHandle;
  path: readonly string[];
  bytes: Uint8Array;
}): Promise<void> {
  let directory = backing;
  for (const segment of path.slice(0, -1)) {
    directory = await directory.getDirectoryHandle(segment);
  }
  const name = path.at(-1);
  if (name === undefined) throw new Error('Physical file path must not be empty');
  const file = await directory.getFileHandle(name);
  const writable = await file.createWritable({ keepExistingData: false });
  await writable.write(toExactArrayBuffer({ bytes }));
  await writable.close();
}

describe('EncryptedOpfs garbage collection', () => {
  it('removes only unreachable immutable objects and preserves the active filesystem', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ backing });
    await writeLargeValue({ session, value: 'first-large-value' });
    await writeLargeValue({ session, value: 'second-large-value' });
    await session.close();

    const dryRun = await collectEncryptedOpfsGarbage({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: true,
    });
    expect(dryRun.unreachableObjectIds.length).toBeGreaterThan(0);
    expect(dryRun.removedObjectCount).toBe(0);

    const before = await countPhysicalFiles({ directory: backing });
    const collected = await collectEncryptedOpfsGarbage({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: false,
    });
    expect(collected.unreachableObjectIds).toEqual(dryRun.unreachableObjectIds);
    expect(collected.removedObjectCount).toBe(dryRun.unreachableObjectIds.length);
    expect(await countPhysicalFiles({ directory: backing })).toBe(
      before - collected.removedObjectCount,
    );

    const reopened = await openTiny({ backing });
    const file = await reopened.root.getFileHandle({ name: 'value.txt', create: false });
    expect(await readStorageFileText({ fileHandle: file })).toBe('second-large-value');
    await reopened.close();
    expect((await collectEncryptedOpfsGarbage({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: true,
    })).unreachableObjectIds).toEqual([]);
  });

  it('preserves the previous valid superblock generation as a physical fallback', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ backing });
    await writeLargeValue({ session, value: 'first-large-value' });
    await writeLargeValue({ session, value: 'second-large-value' });
    await session.close();

    await collectEncryptedOpfsGarbage({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: false,
    });
    const inspection = await inspectEncryptedOpfs({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    await overwritePhysicalFile({
      backing,
      path: [`superblock-${String(inspection.superblock.sequence % 2)}.eopfs`],
      bytes: new Uint8Array([1, 2, 3]),
    });

    const reopened = await openTiny({ backing });
    const file = await reopened.root.getFileHandle({ name: 'value.txt', create: false });
    expect(await readStorageFileText({ fileHandle: file })).toBe('first-large-value');
    await reopened.close();
  });

  it('waits for the open filesystem session and closes its child resources before collection', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ backing });
    await writeLargeValue({ session, value: 'reader-snapshot-value' });
    const file = await session.root.getFileHandle({ name: 'value.txt', create: false });
    const reader = await file.openReadable({ mimeType: 'text/plain' });
    const writer = await file.createWritable({ keepExistingData: true });
    await writer.write({ position: 0, data: new TextEncoder().encode('not-committed') });

    let settled = false;
    const collection = collectEncryptedOpfsGarbage({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: true,
    }).finally(() => {
      settled = true;
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    await session.close();
    await collection;
    expect(settled).toBe(true);
    await expect(reader.read({
      buffer: new Uint8Array(1),
      offset: 0,
      length: 1,
      position: 0,
      signal: undefined,
    })).rejects.toThrow('reader is closed');
    await expect(writer.close()).rejects.toThrow('writer is already closed or aborted');

    const reopened = await openTiny({ backing });
    const reopenedFile = await reopened.root.getFileHandle({ name: 'value.txt', create: false });
    expect(await readStorageFileText({ fileHandle: reopenedFile })).toBe('reader-snapshot-value');
    await reopened.close();
  });

  it('does not delete anything if reachable state validation fails', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ backing });
    await writeLargeValue({ session, value: 'first-large-value' });
    await writeLargeValue({ session, value: 'second-large-value' });
    await session.close();

    const inspection = await inspectEncryptedOpfs({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    const before = await countPhysicalFiles({ directory: backing });
    await overwritePhysicalFile({
      backing,
      path: [
        'objects',
        getEncryptedOpfsObjectShard({ objectId: inspection.activeCommitObjectId }),
        `${inspection.activeCommitObjectId}.eopfs`,
      ],
      bytes: new Uint8Array([1, 2, 3]),
    });

    await expect(collectEncryptedOpfsGarbage({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: false,
    })).rejects.toThrow();
    expect(await countPhysicalFiles({ directory: backing })).toBe(before);
  });

  it('leaves unknown physical entries untouched and reports them', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ backing });
    await session.close();
    const unknownDirectory = await backing
      .getDirectoryHandle('objects')
      .then(directory => directory.getDirectoryHandle('not-a-shard', { create: true }));
    await unknownDirectory.getFileHandle('manual-backup', { create: true });

    const result = await collectEncryptedOpfsGarbage({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: true,
    });
    expect(result.ignoredPhysicalPaths).toContain('objects/not-a-shard');
    await expect(unknownDirectory.getFileHandle('manual-backup')).resolves.toBeDefined();
  });
});
