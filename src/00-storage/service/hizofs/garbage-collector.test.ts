import { describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { writeStorageFileText, readStorageFileText } from '@/00-storage/service/storage-file-system/io';
import type { StorageFileSystemSession } from '@/00-storage/service/storage-file-system/types';
import { collectHizoFSGarbage } from './garbage-collector';
import { inspectHizoFS, TEST_ONLY } from './api';
import type { HizoFSPolicy } from './file-system/policy';
import { getHizoFSObjectShard } from './object-store/object-id';
import { toExactArrayBuffer } from './bytes';
import { HizoFSSession } from './file-system/session';
import { createHizoFSStableId } from './id';

const ROOT_KEY = new Uint8Array(32).fill(17);
const TINY_POLICY: HizoFSPolicy = {
  inlineFileByteLimit: 8,
  inlineDirectoryEntryLimit: 2,
  fileChunkSize: 4,
  indexPageEntryLimit: 2,
  readerStreamChunkSize: 3,
  maxDirtyFileBytes: 16,
  fileChunkWriteConcurrency: 2,
  metadataObjectCacheByteLimit: 64 * 1024,
  metadataObjectCacheEntryLimit: 1024,
  fileChunkCacheByteLimit: 64,
  fileChunkCacheEntryLimit: 16,
};

function createTiny({ backing }: {
  backing: FileSystemDirectoryHandle;
}): Promise<StorageFileSystemSession> {
  return TEST_ONLY.createHizoFSInternal({
    backingDirectory: backing,
    fileSystemRootKey: ROOT_KEY,
    policy: TINY_POLICY,
    now: () => 1,
  });
}

function openTiny({ backing }: {
  backing: FileSystemDirectoryHandle;
}): Promise<StorageFileSystemSession> {
  return TEST_ONLY.openHizoFSInternal({
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

describe('HizoFS garbage collection', () => {
  it('removes only unreachable immutable objects and preserves the active filesystem', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ backing });
    await writeLargeValue({ session, value: 'first-large-value' });
    await writeLargeValue({ session, value: 'second-large-value' });
    await session.close();

    const dryRun = await collectHizoFSGarbage({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: true,
    });
    expect(dryRun.unreachableObjectIds.length).toBeGreaterThan(0);
    expect(dryRun.removedObjectCount).toBe(0);

    const before = await countPhysicalFiles({ directory: backing });
    const collected = await collectHizoFSGarbage({
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
    expect((await collectHizoFSGarbage({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: true,
    })).unreachableObjectIds).toEqual([]);
  });


  it('runs while an idle filesystem session remains open', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ backing });
    await writeLargeValue({ session, value: 'idle-session-value' });

    await expect(collectHizoFSGarbage({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: true,
    })).resolves.toBeDefined();
    await session.close();
  });

  it('waits for an active directory traversal while allowing idle sessions', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ backing });
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      await writeStorageFileText({
        fileHandle: await session.root.getFileHandle({ name, create: true }),
        value: name,
      });
    }

    const iterator = session.root.entries()[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    let settled = false;
    const collection = collectHizoFSGarbage({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: true,
    }).finally(() => {
      settled = true;
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    await iterator.return?.();
    await collection;
    expect(settled).toBe(true);
    await session.close();
  });

  it('refuses to sweep when the inode index contains a disconnected node', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ backing });
    if (!(session instanceof HizoFSSession)) {
      throw new Error('Expected a HizoFS session');
    }
    await session.runtime.core.mutate({
      operation: async ({ state }) => {
        const nodeId = createHizoFSStableId();
        const inodeObjectId = await session.runtime.inodeStore.writeFile({
          inode: {
            nodeId,
            revision: 0,
            createdAt: 1,
            modifiedAt: 1,
            size: 0,
            storage: { type: 'inline' },
          },
          binaryPayload: new Uint8Array(),
        });
        return {
          changed: 'yes' as const,
          inodeIndexRootObjectId: await session.runtime.inodeIndex.set({
            rootObjectId: state.commit.inodeIndexRootObjectId,
            entry: { nodeId, inodeObjectId },
          }),
          result: undefined,
        };
      },
    });

    await expect(collectHizoFSGarbage({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: false,
    })).rejects.toThrow('disconnected');
    await session.close();
  });

  it('preserves the previous valid superblock generation as a physical fallback', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ backing });
    await writeLargeValue({ session, value: 'first-large-value' });
    await writeLargeValue({ session, value: 'second-large-value' });
    await session.close();

    await collectHizoFSGarbage({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: false,
    });
    const inspection = await inspectHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    await overwritePhysicalFile({
      backing,
      path: [`superblock-${String(inspection.superblock.sequence % 2)}.enc`],
      bytes: new Uint8Array([1, 2, 3]),
    });

    const reopened = await openTiny({ backing });
    if (!(reopened instanceof HizoFSSession)) {
      throw new Error('Expected a HizoFS session');
    }
    expect((await reopened.loadActiveState()).mode).toBe('fallback_read_only');
    const file = await reopened.root.getFileHandle({ name: 'value.txt', create: false });
    expect(await readStorageFileText({ fileHandle: file })).toBe('first-large-value');
    await reopened.close();
    await expect(collectHizoFSGarbage({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: true,
    })).rejects.toThrow('read-only recovery mode');
  });

  it('waits for active child resources and session close disposes them before collection', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ backing });
    await writeLargeValue({ session, value: 'reader-snapshot-value' });
    const file = await session.root.getFileHandle({ name: 'value.txt', create: false });
    const reader = await file.openReadable({ mimeType: 'text/plain' });
    const writer = await file.createWritable({ keepExistingData: true });
    await writer.write({ position: 0, data: new TextEncoder().encode('not-committed') });

    let settled = false;
    const collection = collectHizoFSGarbage({
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

    const inspection = await inspectHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    const before = await countPhysicalFiles({ directory: backing });
    await overwritePhysicalFile({
      backing,
      path: [
        'objects',
        getHizoFSObjectShard({ objectId: inspection.activeCommitObjectId }),
        `${inspection.activeCommitObjectId}.enc`,
      ],
      bytes: new Uint8Array([1, 2, 3]),
    });

    await expect(collectHizoFSGarbage({
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

    const result = await collectHizoFSGarbage({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: true,
    });
    expect(result.ignoredPhysicalPaths).toContain('objects/not-a-shard');
    await expect(unknownDirectory.getFileHandle('manual-backup')).resolves.toBeDefined();
  });

  it('preserves shared reflink objects until both file identities are unreachable', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ backing });
    await writeLargeValue({ session, value: 'shared-reflink-value' });
    await session.root.cloneFile({
      name: 'value.txt',
      destination: session.root,
      newName: 'clone.txt',
      replace: false,
    });
    await session.root.removeEntry({ name: 'value.txt', recursive: false });
    await session.close();

    await collectHizoFSGarbage({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: false,
    });
    const cloneOnly = await openTiny({ backing });
    expect(await readStorageFileText({
      fileHandle: await cloneOnly.root.getFileHandle({ name: 'clone.txt', create: false }),
    })).toBe('shared-reflink-value');
    await cloneOnly.root.removeEntry({ name: 'clone.txt', recursive: false });
    await cloneOnly.root.getFileHandle({ name: 'rotate-a', create: true });
    await cloneOnly.root.getFileHandle({ name: 'rotate-b', create: true });
    await cloneOnly.close();

    const finalCollection = await collectHizoFSGarbage({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: false,
    });
    expect(finalCollection.removedObjectCount).toBeGreaterThan(0);
    const reopened = await openTiny({ backing });
    await expect(reopened.root.getFileHandle({
      name: 'clone.txt',
      create: false,
    })).rejects.toMatchObject({ name: 'NotFoundError' });
    await reopened.close();
  });

  it('marks one shared extent graph for one hundred whole-file clones', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ backing });
    await writeLargeValue({ session, value: 'one-hundred-reflink-clones' });
    for (let index = 0; index < 100; index += 1) {
      await session.root.cloneFile({
        name: 'value.txt',
        destination: session.root,
        newName: `clone-${String(index).padStart(3, '0')}`,
        replace: false,
      });
    }
    await session.close();

    const result = await collectHizoFSGarbage({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: true,
    });
    expect(result.reachableObjectCount).toBeGreaterThan(100);
  }, 30_000);
});
