import { describe, expect, it, vi } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import {
  readStorageFileText,
  writeStorageFileText,
} from '@/00-storage/service/storage-file-system/io';
import type { StorageFileSystemSession } from '@/00-storage/service/storage-file-system/types';
import {
  createHizoFS,
  createHizoFSBulkBuilder,
  inspectHizoFS,
  openHizoFS,
  openHizoFSWorkerMount,
  TEST_ONLY,
} from './api';
import type { HizoFSPolicy } from './file-system/policy';
import { createQueuedTestLockManager } from './test-lock-manager';
import { HizoFSSession } from './file-system/session';
import { TEST_ONLY as MUTATION_LOCK_TEST_ONLY } from './file-system/mutation-lock';
import type { LoadedHizoFSFile } from './file-system/node-service';
import { createHizoFSInspectionReader } from './inspection';
import type { HizoFSRecordKind } from './format/record';
import { NativeOpfsHizoFSBackingStore } from './backing-store/native-opfs-backing-store';
import { getHizoFSObjectShard } from './object-store/object-id';
import { collectHizoFSGarbage } from './garbage-collector';
import { TEST_ONLY as MAINTENANCE_LOCK_TEST_ONLY } from './file-system/maintenance-lock';

const ROOT_KEY = new Uint8Array(32).fill(9);
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

async function createTiny({ root, now }: {
  root: FileSystemDirectoryHandle;
  now: () => number;
}): Promise<StorageFileSystemSession> {
  return TEST_ONLY.createHizoFSInternal({
    backingDirectory: root,
    fileSystemRootKey: ROOT_KEY,
    policy: TINY_POLICY,
    now,
  });
}

async function openTiny({ root, now }: {
  root: FileSystemDirectoryHandle;
  now: () => number;
}): Promise<StorageFileSystemSession> {
  return TEST_ONLY.openHizoFSInternal({
    backingDirectory: root,
    fileSystemRootKey: ROOT_KEY,
    policy: TINY_POLICY,
    now,
  });
}

async function readBytes({ session, path }: {
  session: StorageFileSystemSession;
  path: readonly string[];
}): Promise<Uint8Array> {
  let directory = session.root;
  for (const segment of path.slice(0, -1)) {
    directory = await directory.getDirectoryHandle({ name: segment, create: false });
  }
  const name = path.at(-1);
  if (name === undefined) throw new Error('Path must include a file name');
  const file = await directory.getFileHandle({ name, create: false });
  const readable = await file.openReadable({ mimeType: 'application/octet-stream' });
  try {
    return new Uint8Array(await new Response(readable.stream({
      start: 0,
      end: undefined,
      signal: undefined,
    })).arrayBuffer());
  } finally {
    await readable.close();
  }
}

function requireHizoFSSession({ session }: {
  session: StorageFileSystemSession;
}): HizoFSSession {
  if (!(session instanceof HizoFSSession)) {
    throw new Error('Expected a HizoFS session');
  }
  return session;
}

async function readCurrentRootFile({ session, name }: {
  session: StorageFileSystemSession;
  name: string;
}): Promise<LoadedHizoFSFile> {
  const hizofs = requireHizoFSSession({ session });
  const state = await hizofs.runtime.core.loadActiveState();
  const root = await hizofs.runtime.nodeService.readDirectory({
    state,
    nodeId: state.commit.rootDirectoryNodeId,
  });
  const entry = await hizofs.runtime.directoryStorage.getEntry({
    inode: root.inode,
    name,
  });
  if (entry === undefined || entry.kind !== 'file') {
    throw new Error(`Expected root file: ${name}`);
  }
  return await hizofs.runtime.nodeService.readFile({ state, nodeId: entry.nodeId });
}

async function readCurrentRootFileExtents({ session, name }: {
  session: StorageFileSystemSession;
  name: string;
}): Promise<{
  readonly inode: LoadedHizoFSFile['inode'];
  readonly extents: ReadonlyMap<number, string>;
}> {
  const hizofs = requireHizoFSSession({ session });
  const file = await readCurrentRootFile({ session, name });
  if (file.inode.storage.type !== 'extents') {
    throw new Error(`Expected an extent-backed file: ${name}`);
  }
  const extents = new Map<number, string>();
  for await (const extent of hizofs.runtime.extentIndex.entries({
    rootObjectId: file.inode.storage.extentIndexRootObjectId,
  })) {
    extents.set(extent.chunkIndex, extent.chunkObjectId);
  }
  return { inode: file.inode, extents };
}

async function countPhysicalObjectsByKind({ backing, kind }: {
  backing: FileSystemDirectoryHandle;
  kind: HizoFSRecordKind;
}): Promise<number> {
  const reader = await createHizoFSInspectionReader({
    backingDirectory: backing,
    fileSystemRootKey: ROOT_KEY,
  });
  try {
    let count = 0;
    let cursor: string | undefined;
    do {
      const page = await reader.listPhysicalObjects({ cursor, limit: 1000 });
      for (const entry of page.entries) {
        const object = await reader.inspectObject({
          objectId: entry.objectId,
          binaryPreviewByteLength: 0,
        });
        if (object?.record.kind === kind) count += 1;
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return count;
  } finally {
    await reader.dispose();
  }
}

async function copyNativeDirectory({ source, destination }: {
  source: FileSystemDirectoryHandle;
  destination: FileSystemDirectoryHandle;
}): Promise<void> {
  for await (const [name, handle] of source.entries()) {
    switch (handle.kind) {
    case 'file': {
      const sourceFile = await (handle as FileSystemFileHandle).getFile();
      const targetFile = await destination.getFileHandle(name, { create: true });
      const writable = await targetFile.createWritable({ keepExistingData: false });
      await writable.write(sourceFile);
      await writable.close();
      break;
    }
    case 'directory': {
      const targetDirectory = await destination.getDirectoryHandle(name, { create: true });
      await copyNativeDirectory({
        source: handle as FileSystemDirectoryHandle,
        destination: targetDirectory,
      });
      break;
    }
    default: {
      const _ex: never = handle;
      throw new Error(`Unhandled backing entry: ${String(_ex)}`);
    }
    }
  }
}

describe('HizoFS public file-system API', () => {
  it('creates one file system inside exactly the provided backing directory', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'dedicated-backing' });
    const session = await createHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });

    const physicalNames: string[] = [];
    for await (const [name] of backing.entries()) physicalNames.push(name);
    expect(physicalNames.sort()).toEqual([
      'descriptor.json',
      'objects',
      'superblock-0.enc',
      'superblock-1.enc',
    ]);
    expect(session.capabilities).toEqual({
      directBlob: 'unsupported',
      symbolicLink: 'supported',
      atomicMove: 'supported',
      wholeFileClone: 'supported',
    });
  });


  it('opens byte-identical persisted data under renamed and moved backing directories', async () => {
    const nativeRoot = new MockFileSystemDirectoryHandle({ name: 'opfs-root' });
    const canonical = await nativeRoot.getDirectoryHandle('filesystem.hizofs', { create: true });
    const created = await createHizoFS({
      backingDirectory: canonical,
      fileSystemRootKey: ROOT_KEY,
    });
    await writeStorageFileText({
      fileHandle: await created.root.getFileHandle({ name: 'proof.txt', create: true }),
      value: 'directory names are not format identity',
    });
    await created.close();

    // Native OPFS does not expose directory rename. Copying the exact physical bytes
    // into differently named handles verifies that names and suffixes do not participate
    // in format identity, key derivation, AAD, or object addressing.
    const noSuffix = await nativeRoot.getDirectoryHandle('filesystem', { create: true });
    const unrelatedSuffix = await nativeRoot.getDirectoryHandle('filesystem.anything', {
      create: true,
    });
    const movedParent = await nativeRoot.getDirectoryHandle('moved-parent', { create: true });
    const movedAndRenamed = await movedParent.getDirectoryHandle('renamed-store', { create: true });

    for (const destination of [noSuffix, unrelatedSuffix, movedAndRenamed]) {
      await copyNativeDirectory({ source: canonical, destination });
      const reopened = await openHizoFS({
        backingDirectory: destination,
        fileSystemRootKey: ROOT_KEY,
      });
      expect(await readStorageFileText({
        fileHandle: await reopened.root.getFileHandle({ name: 'proof.txt', create: false }),
      })).toBe('directory names are not format identity');
      await reopened.close();
    }
  });

  it('limits bulk construction to a fresh empty target', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    await session.root.getFileHandle({ name: 'existing.txt', create: true });
    await expect(createHizoFSBulkBuilder({
      fileSystemSession: session,
    })).rejects.toThrow('fresh empty target');
    await session.close();
  });

  it('does not recognize an empty directory merely because it uses the canonical suffix', async () => {
    const emptyCanonicalName = new MockFileSystemDirectoryHandle({ name: 'filesystem.hizofs' });
    await expect(openHizoFS({
      backingDirectory: emptyCanonicalName,
      fileSystemRootKey: ROOT_KEY,
    })).rejects.toThrow('superblock');
  });


  it('reconstructs a missing descriptor after authenticating a complete generation', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const created = await createHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    await writeStorageFileText({
      fileHandle: await created.root.getFileHandle({ name: 'proof.txt', create: true }),
      value: 'recover descriptor',
    });
    await created.close();
    await backing.removeEntry('descriptor.json');

    const reopened = await openHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    expect(await readStorageFileText({
      fileHandle: await reopened.root.getFileHandle({ name: 'proof.txt', create: false }),
    })).toBe('recover descriptor');
    expect(await backing.getFileHandle('descriptor.json')).toBeDefined();
    await reopened.close();
  });

  it('reconstructs a corrupt descriptor after authenticating a complete generation', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const created = await createHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    await writeStorageFileText({
      fileHandle: await created.root.getFileHandle({ name: 'proof.txt', create: true }),
      value: 'recover corrupt descriptor',
    });
    await created.close();
    const descriptorHandle = await backing.getFileHandle('descriptor.json');
    const writable = await descriptorHandle.createWritable();
    await writable.write('{not valid json');
    await writable.close();

    const reopened = await openHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    expect(await readStorageFileText({
      fileHandle: await reopened.root.getFileHandle({ name: 'proof.txt', create: false }),
    })).toBe('recover corrupt descriptor');
    expect(JSON.parse(await (await descriptorHandle.getFile()).text())).toEqual({
      format: 'hizofs',
      formatVersion: 1,
    });
    await reopened.close();
  });

  it('fails closed when a Worker mount cannot coordinate through Web Locks', async () => {
    const originalLocks = navigator.locks;
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: undefined,
    });
    try {
      const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
      const ownerSession = await createHizoFS({
        backingDirectory: backing,
        fileSystemRootKey: ROOT_KEY,
      });
      const source = ownerSession.root.createWorkerMountSource?.();
      if (source === undefined) {
        throw new Error('HizoFS directory did not expose a Worker mount source');
      }
      await expect(openHizoFSWorkerMount({ source })).rejects.toThrow(
        'require the Web Locks API',
      );
      await ownerSession.close();
    } finally {
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: originalLocks,
      });
    }
  });

  it('reopens a scoped directory for Worker-local filesystem access', async () => {
    const originalLocks = navigator.locks;
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: createQueuedTestLockManager({ onRequest: undefined }),
    });
    try {
      const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
      const ownerSession = await createHizoFS({
        backingDirectory: backing,
        fileSystemRootKey: ROOT_KEY,
      });
      const mountedDirectory = await ownerSession.root.getDirectoryHandle({
        name: 'mounted',
        create: true,
      });
      const source = mountedDirectory.createWorkerMountSource?.();
      if (source === undefined) {
        throw new Error('HizoFS directory did not expose a Worker mount source');
      }
      expect(source.rootKey.extractable).toBe(false);
      expect(source.rootKey.usages).toEqual(['deriveKey']);

      const workerSession = await openHizoFSWorkerMount({ source });
      const unrelatedBackingDirectory = new MockFileSystemDirectoryHandle({
        name: 'unrelated-backing',
      });
      await expect(workerSession.openWorkerMountDirectory({
        source: {
          ...source,
          backingDirectory: unrelatedBackingDirectory,
        },
      })).rejects.toThrow('different backing directory');

      await writeStorageFileText({
        fileHandle: await workerSession.root.getFileHandle({
          name: 'worker.txt',
          create: true,
        }),
        value: 'worker-local HizoFS',
      });

      expect(await readStorageFileText({
        fileHandle: await mountedDirectory.getFileHandle({
          name: 'worker.txt',
          create: false,
        }),
      })).toBe('worker-local HizoFS');

      await workerSession.close();
      await ownerSession.close();
    } finally {
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: originalLocks,
      });
    }
  });

  it('round-trips an inline file across a complete reopen', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const first = await createHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    const file = await first.root.getFileHandle({ name: 'settings.json', create: true });
    await writeStorageFileText({ fileHandle: file, value: '{"ok":true}' });
    await first.close();

    const second = await openHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    try {
      const reopened = await second.root.getFileHandle({ name: 'settings.json', create: false });
      expect(await readStorageFileText({ fileHandle: reopened })).toBe('{"ok":true}');
      const readable = await reopened.openReadable({ mimeType: 'application/json' });
      try {
        expect(readable.backing).toEqual({ type: 'reader_only' });
      } finally {
        await readable.close();
      }
    } finally {
      await second.close();
    }
  });

  it('inspects the authenticated descriptor, superblock, and active commit', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    await writeStorageFileText({
      fileHandle: await session.root.getFileHandle({ name: 'settings.json', create: true }),
      value: '{"ok":true}',
    });

    const inspection = await inspectHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });

    expect(inspection.descriptor.formatVersion).toBe(1);
    expect(inspection.superblock.fileSystemId).toBe(inspection.fileSystemId);
    expect(inspection.superblock.activeCommitObjectId).toBe(inspection.activeCommitObjectId);
    expect(inspection.activeCommit.revision).toBe(2);
    expect(inspection.activeCommit.rootDirectoryNodeId).toBeTruthy();
  });

  it('fails closed when opened with the wrong root key', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    await createHizoFS({ backingDirectory: backing, fileSystemRootKey: ROOT_KEY });
    await expect(openHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: new Uint8Array(32).fill(10),
    })).rejects.toThrow();
  });

  it('supports extent-backed random writes, truncate, and sparse zero ranges', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ root: backing, now: () => 100 });
    const file = await session.root.getFileHandle({ name: 'large.bin', create: true });
    const writer = await file.createWritable({ keepExistingData: false });
    await writer.write({ position: 10, data: new Uint8Array([7, 8]) });
    await writer.write({ position: 1, data: new Uint8Array([1, 2, 3, 4, 5]) });
    await writer.truncate({ size: 11 });
    await writer.close();

    expect([...await readBytes({ session, path: ['large.bin'] })]).toEqual([
      0, 1, 2, 3, 4, 5, 0, 0, 0, 0, 7,
    ]);
    expect(await file.stat()).toMatchObject({ size: 11, modifiedAt: 100 });

    await session.close();
    const reopened = await openTiny({ root: backing, now: () => 200 });
    expect([...await readBytes({ session: reopened, path: ['large.bin'] })]).toEqual([
      0, 1, 2, 3, 4, 5, 0, 0, 0, 0, 7,
    ]);
  });

  it('preserves every inline byte when a later append converts the file to extents', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ root: backing, now: () => 1 });
    const file = await session.root.getFileHandle({ name: 'inline-to-extents.bin', create: true });
    const inlineWriter = await file.createWritable({ keepExistingData: false });
    await inlineWriter.write({
      position: 0,
      data: new TextEncoder().encode('1234567'),
    });
    await inlineWriter.close();

    const extentWriter = await file.createWritable({ keepExistingData: true });
    await extentWriter.write({
      position: 7,
      data: new TextEncoder().encode('89ABC'),
    });
    await extentWriter.close();

    expect(new TextDecoder().decode(await readBytes({
      session,
      path: ['inline-to-extents.bin'],
    }))).toBe('123456789ABC');
    await session.close();
  });

  it('whole-file clones an extent-backed file without creating new chunks', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ root: backing, now: () => 41 });
    const source = await session.root.getFileHandle({ name: 'source.bin', create: true });
    await writeStorageFileText({ fileHandle: source, value: 'abcdefghijklmnop' });
    const chunksBefore = await countPhysicalObjectsByKind({
      backing,
      kind: 'file_chunk',
    });

    const clone = await session.root.cloneFile({
      name: 'source.bin',
      destination: session.root,
      newName: 'clone.bin',
      replace: false,
    });

    expect(await readStorageFileText({ fileHandle: clone })).toBe('abcdefghijklmnop');
    const sourceFile = await readCurrentRootFile({ session, name: 'source.bin' });
    const clonedFile = await readCurrentRootFile({ session, name: 'clone.bin' });
    expect(clonedFile.inode.nodeId).not.toBe(sourceFile.inode.nodeId);
    expect(clonedFile.inode.revision).toBe(0);
    expect(clonedFile.inode.createdAt).toBe(41);
    expect(sourceFile.inode.storage.type).toBe('extents');
    expect(clonedFile.inode.storage.type).toBe('extents');
    if (
      sourceFile.inode.storage.type !== 'extents'
      || clonedFile.inode.storage.type !== 'extents'
    ) {
      throw new Error('Expected extent-backed source and clone');
    }
    expect(clonedFile.inode.storage.extentIndexRootObjectId).toBe(
      sourceFile.inode.storage.extentIndexRootObjectId,
    );
    expect(await countPhysicalObjectsByKind({
      backing,
      kind: 'file_chunk',
    })).toBe(chunksBefore);
    await session.close();

    const reopened = await openTiny({ root: backing, now: () => 42 });
    expect(await readStorageFileText({
      fileHandle: await reopened.root.getFileHandle({ name: 'source.bin', create: false }),
    })).toBe('abcdefghijklmnop');
    expect(await readStorageFileText({
      fileHandle: await reopened.root.getFileHandle({ name: 'clone.bin', create: false }),
    })).toBe('abcdefghijklmnop');
    await reopened.close();
  });

  it('copy-on-writes only changed clone chunks and preserves both directions', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    const source = await session.root.getFileHandle({ name: 'source.bin', create: true });
    await writeStorageFileText({ fileHandle: source, value: 'abcdefghijklmnop' });
    const clone = await session.root.cloneFile({
      name: 'source.bin',
      destination: session.root,
      newName: 'clone.bin',
      replace: false,
    });
    const shared = await readCurrentRootFileExtents({ session, name: 'source.bin' });

    const cloneWriter = await clone.createWritable({ keepExistingData: true });
    await cloneWriter.write({
      position: 5,
      data: new TextEncoder().encode('Z'),
    });
    await cloneWriter.close();

    const sourceAfterCloneWrite = await readCurrentRootFileExtents({
      session,
      name: 'source.bin',
    });
    const cloneAfterWrite = await readCurrentRootFileExtents({ session, name: 'clone.bin' });
    expect(sourceAfterCloneWrite.inode.storage).toEqual(shared.inode.storage);
    expect([...sourceAfterCloneWrite.extents]).toEqual([...shared.extents]);
    expect(cloneAfterWrite.extents.get(1)).not.toBe(shared.extents.get(1));
    expect(cloneAfterWrite.extents.get(0)).toBe(shared.extents.get(0));
    expect(cloneAfterWrite.extents.get(2)).toBe(shared.extents.get(2));
    expect(cloneAfterWrite.extents.get(3)).toBe(shared.extents.get(3));
    expect(await readStorageFileText({ fileHandle: source })).toBe('abcdefghijklmnop');
    expect(await readStorageFileText({ fileHandle: clone })).toBe('abcdeZghijklmnop');

    const sourceWriter = await source.createWritable({ keepExistingData: true });
    await sourceWriter.write({
      position: 10,
      data: new TextEncoder().encode('Q'),
    });
    await sourceWriter.close();
    expect(await readStorageFileText({ fileHandle: source })).toBe('abcdefghijQlmnop');
    expect(await readStorageFileText({ fileHandle: clone })).toBe('abcdeZghijklmnop');
    await session.close();
  });

  it('copy-on-writes every touched chunk for a cross-boundary clone write', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    const source = await session.root.getFileHandle({ name: 'source.bin', create: true });
    await writeStorageFileText({ fileHandle: source, value: 'abcdefghijklmnop' });
    const clone = await session.root.cloneFile({
      name: 'source.bin',
      destination: session.root,
      newName: 'clone.bin',
      replace: false,
    });
    const shared = await readCurrentRootFileExtents({ session, name: 'source.bin' });
    const writer = await clone.createWritable({ keepExistingData: true });
    await writer.write({
      position: 3,
      data: new TextEncoder().encode('123456789'),
    });
    await writer.close();

    const changed = await readCurrentRootFileExtents({ session, name: 'clone.bin' });
    for (const chunkIndex of [0, 1, 2]) {
      expect(changed.extents.get(chunkIndex)).not.toBe(shared.extents.get(chunkIndex));
    }
    expect(changed.extents.get(3)).toBe(shared.extents.get(3));
    expect(await readStorageFileText({ fileHandle: source })).toBe('abcdefghijklmnop');
    expect(await readStorageFileText({ fileHandle: clone })).toBe('abc123456789mnop');
    await session.close();
  });

  it('preserves clone independence across aligned overwrite, append, and truncate cycles', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    const source = await session.root.getFileHandle({ name: 'source.bin', create: true });
    await writeStorageFileText({ fileHandle: source, value: 'abcdefghijklmnop' });
    const clone = await session.root.cloneFile({
      name: 'source.bin',
      destination: session.root,
      newName: 'clone.bin',
      replace: false,
    });
    const shared = await readCurrentRootFileExtents({ session, name: 'source.bin' });

    const overwriteAndAppend = await clone.createWritable({ keepExistingData: true });
    await overwriteAndAppend.write({
      position: 4,
      data: new TextEncoder().encode('WXYZ'),
    });
    await overwriteAndAppend.write({
      position: 16,
      data: new TextEncoder().encode('qrst'),
    });
    await overwriteAndAppend.close();

    const appended = await readCurrentRootFileExtents({ session, name: 'clone.bin' });
    expect(appended.extents.get(0)).toBe(shared.extents.get(0));
    expect(appended.extents.get(1)).not.toBe(shared.extents.get(1));
    expect(appended.extents.get(2)).toBe(shared.extents.get(2));
    expect(appended.extents.get(3)).toBe(shared.extents.get(3));
    expect(appended.extents.get(4)).toBeDefined();
    expect(await readStorageFileText({ fileHandle: clone })).toBe('abcdWXYZijklmnopqrst');

    const truncateAndExpand = await clone.createWritable({ keepExistingData: true });
    await truncateAndExpand.truncate({ size: 10 });
    await truncateAndExpand.truncate({ size: 20 });
    await truncateAndExpand.write({ position: 18, data: new Uint8Array([33]) });
    await truncateAndExpand.close();
    expect([...await readBytes({ session, path: ['clone.bin'] })]).toEqual([
      97, 98, 99, 100, 87, 88, 89, 90, 105, 106,
      0, 0, 0, 0, 0, 0, 0, 0, 33, 0,
    ]);

    const truncateAtBoundary = await clone.createWritable({ keepExistingData: true });
    await truncateAtBoundary.truncate({ size: 8 });
    await truncateAtBoundary.truncate({ size: 12 });
    await truncateAtBoundary.close();
    expect([...await readBytes({ session, path: ['clone.bin'] })]).toEqual([
      97, 98, 99, 100, 87, 88, 89, 90, 0, 0, 0, 0,
    ]);

    const truncateToZero = await clone.createWritable({ keepExistingData: true });
    await truncateToZero.truncate({ size: 0 });
    await truncateToZero.truncate({ size: 4 });
    await truncateToZero.close();
    expect([...await readBytes({ session, path: ['clone.bin'] })]).toEqual([0, 0, 0, 0]);
    expect(await readStorageFileText({ fileHandle: source })).toBe('abcdefghijklmnop');
    await session.close();
  });

  it('clones inline boundary files independently and preserves sparse truncate semantics', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    for (const [suffix, value] of [
      ['empty', ''],
      ['one', 'x'],
      ['limit', '12345678'],
    ] as const) {
      const sourceName = `${suffix}-source`;
      const cloneName = `${suffix}-clone`;
      const source = await session.root.getFileHandle({ name: sourceName, create: true });
      await writeStorageFileText({ fileHandle: source, value });
      const clone = await session.root.cloneFile({
        name: sourceName,
        destination: session.root,
        newName: cloneName,
        replace: false,
      });
      const sourceRecord = await readCurrentRootFile({ session, name: sourceName });
      const cloneRecord = await readCurrentRootFile({ session, name: cloneName });
      expect(sourceRecord.inode.storage.type).toBe('inline');
      expect(cloneRecord.inode.storage.type).toBe('inline');
      expect(cloneRecord.inode.nodeId).not.toBe(sourceRecord.inode.nodeId);
      expect(await readStorageFileText({ fileHandle: clone })).toBe(value);
    }

    const clone = await session.root.getFileHandle({ name: 'limit-clone', create: false });
    const writer = await clone.createWritable({ keepExistingData: true });
    await writer.truncate({ size: 3 });
    await writer.truncate({ size: 12 });
    await writer.write({ position: 10, data: new Uint8Array([90]) });
    await writer.close();
    expect([...await readBytes({ session, path: ['limit-clone'] })]).toEqual([
      49, 50, 51, 0, 0, 0, 0, 0, 0, 0, 90, 0,
    ]);
    expect(await readStorageFileText({
      fileHandle: await session.root.getFileHandle({ name: 'limit-source', create: false }),
    })).toBe('12345678');
    await session.close();
  });

  it('enforces whole-file clone destination and session semantics', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ root: backing, now: () => 1 });
    const source = await session.root.getFileHandle({ name: 'source', create: true });
    await writeStorageFileText({ fileHandle: source, value: 'source-value' });
    await writeStorageFileText({
      fileHandle: await session.root.getFileHandle({ name: 'target', create: true }),
      value: 'old-target',
    });
    await expect(session.root.cloneFile({
      name: 'source',
      destination: session.root,
      newName: 'target',
      replace: false,
    })).rejects.toMatchObject({ name: 'InvalidModificationError' });
    expect(await readStorageFileText({
      fileHandle: await session.root.cloneFile({
        name: 'source',
        destination: session.root,
        newName: 'target',
        replace: true,
      }),
    })).toBe('source-value');

    await session.root.createSymlink({ name: 'link-target', target: 'source' });
    await expect(session.root.cloneFile({
      name: 'source',
      destination: session.root,
      newName: 'link-target',
      replace: true,
    })).resolves.toMatchObject({ kind: 'file', name: 'link-target' });
    await session.root.getDirectoryHandle({ name: 'directory-target', create: true });
    await expect(session.root.cloneFile({
      name: 'source',
      destination: session.root,
      newName: 'directory-target',
      replace: true,
    })).rejects.toMatchObject({ name: 'TypeMismatchError' });
    await expect(session.root.cloneFile({
      name: 'source',
      destination: session.root,
      newName: 'source',
      replace: true,
    })).rejects.toMatchObject({ name: 'InvalidModificationError' });
    await session.root.getDirectoryHandle({ name: 'directory-source', create: true });
    await expect(session.root.cloneFile({
      name: 'directory-source',
      destination: session.root,
      newName: 'wrong-kind',
      replace: false,
    })).rejects.toMatchObject({ name: 'TypeMismatchError' });

    const otherSession = await openTiny({ root: backing, now: () => 2 });
    await expect(session.root.cloneFile({
      name: 'source',
      destination: otherSession.root,
      newName: 'cross-session',
      replace: false,
    })).rejects.toThrow('same session');
    await otherSession.close();
    await session.close();
  });

  it('serializes whole-file clones from separate sessions without losing either entry', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const first = await createTiny({ root: backing, now: () => 1 });
    const source = await first.root.getFileHandle({ name: 'source.bin', create: true });
    await writeStorageFileText({ fileHandle: source, value: 'cross-session-reflink-value' });
    const second = await openTiny({ root: backing, now: () => 2 });

    await Promise.all([
      first.root.cloneFile({
        name: 'source.bin',
        destination: first.root,
        newName: 'clone-first.bin',
        replace: false,
      }),
      second.root.cloneFile({
        name: 'source.bin',
        destination: second.root,
        newName: 'clone-second.bin',
        replace: false,
      }),
    ]);
    await first.close();
    await second.close();

    const reopened = await openTiny({ root: backing, now: () => 3 });
    for (const name of ['source.bin', 'clone-first.bin', 'clone-second.bin']) {
      expect(await readStorageFileText({
        fileHandle: await reopened.root.getFileHandle({ name, create: false }),
      })).toBe('cross-session-reflink-value');
    }
    await reopened.close();
  });

  it('uses the persisted chunk size when a later implementation policy changes', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const first = await createTiny({ root: backing, now: () => 1 });
    const file = await first.root.getFileHandle({ name: 'policy.bin', create: true });
    const initial = new TextEncoder().encode('abcdefghijklmnop');
    const firstWriter = await file.createWritable({ keepExistingData: false });
    await firstWriter.write({ position: 0, data: initial });
    await firstWriter.close();
    await first.close();

    const changedPolicy: HizoFSPolicy = {
      ...TINY_POLICY,
      fileChunkSize: 7,
    };
    const second = await TEST_ONLY.openHizoFSInternal({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      policy: changedPolicy,
      now: () => 2,
    });
    const reopened = await second.root.getFileHandle({ name: 'policy.bin', create: false });
    const secondWriter = await reopened.createWritable({ keepExistingData: true });
    await secondWriter.write({ position: 5, data: new TextEncoder().encode('XYZ') });
    await secondWriter.close();

    expect(new TextDecoder().decode(await readBytes({
      session: second,
      path: ['policy.bin'],
    }))).toBe('abcdeXYZijklmnop');
    await second.close();
  });

  it('keeps an open reader on its immutable snapshot after a later overwrite', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ root: backing, now: () => 1 });
    try {
      const file = await session.root.getFileHandle({ name: 'snapshot.txt', create: true });
      await writeStorageFileText({ fileHandle: file, value: 'old-value-which-is-large' });
      const reader = await file.openReadable({ mimeType: 'text/plain' });
      try {
        await writeStorageFileText({ fileHandle: file, value: 'new-value-which-is-large' });

        expect(await new Response(reader.stream({
          start: 0,
          end: undefined,
          signal: undefined,
        })).text()).toBe('old-value-which-is-large');
        expect(await readStorageFileText({ fileHandle: file })).toBe('new-value-which-is-large');
      } finally {
        await reader.close();
      }
    } finally {
      await session.close();
    }
  });

  it('rejects the second writer when the file revision changed', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    const file = await session.root.getFileHandle({ name: 'conflict.bin', create: true });
    const first = await file.createWritable({ keepExistingData: true });
    const second = await file.createWritable({ keepExistingData: true });
    await first.write({ position: 0, data: new Uint8Array([1]) });
    await second.write({ position: 0, data: new Uint8Array([2]) });
    await first.close();
    await expect(second.close()).rejects.toThrow('changed while its writer was open');
    expect([...await readBytes({ session, path: ['conflict.bin'] })]).toEqual([1]);
  });


  it('publishes a writer while an exclusive GC request waits behind its existing lease', async () => {
    const originalLocks = navigator.locks;
    const exclusiveMaintenanceRequest = Promise.withResolvers<void>();
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: createQueuedTestLockManager({
        onRequest: ({ name, mode }) => {
          if (name.endsWith('/maintenance') && mode === 'exclusive') {
            exclusiveMaintenanceRequest.resolve();
          }
        },
      }),
    });
    try {
      const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
      const session = await createTiny({ root: backing, now: () => 1 });
      const file = await session.root.getFileHandle({ name: 'leased.bin', create: true });
      const writer = await file.createWritable({ keepExistingData: false });
      await writer.write({ position: 0, data: new Uint8Array([1, 2, 3, 4, 5]) });

      const garbageCollection = collectHizoFSGarbage({
        backingDirectory: backing,
        fileSystemRootKey: ROOT_KEY,
        dryRun: true,
      });
      await exclusiveMaintenanceRequest.promise;

      await Promise.all([
        writer.close(),
        garbageCollection,
      ]);
      expect([...await readBytes({ session, path: ['leased.bin'] })]).toEqual([
        1, 2, 3, 4, 5,
      ]);
      await session.close();
    } finally {
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: originalLocks,
      });
    }
  });

  it('holds a maintenance lease for bulk objects until the one-commit publication', async () => {
    const originalLocks = navigator.locks;
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: undefined,
    });
    try {
      const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
      const session = await createTiny({ root: backing, now: () => 1 });
      const hizofs = requireHizoFSSession({ session });
      const lockName = `hizofs/${hizofs.fileSystemId}/maintenance`;
      const activeSharedBefore = MAINTENANCE_LOCK_TEST_ONLY.localStates
        .get(lockName)?.activeSharedCount ?? 0;
      const builder = await createHizoFSBulkBuilder({ fileSystemSession: session });
      if (builder === undefined) {
        throw new Error('Expected a HizoFS bulk builder');
      }

      expect(MAINTENANCE_LOCK_TEST_ONLY.localStates.get(lockName)?.activeSharedCount)
        .toBe(activeSharedBefore + 1);
      await builder.createEmptyDirectory({ name: 'kept' });
      await builder.commit();
      expect(MAINTENANCE_LOCK_TEST_ONLY.localStates.get(lockName)?.activeSharedCount ?? 0)
        .toBe(activeSharedBefore);
      await expect(session.root.getDirectoryHandle({
        name: 'kept',
        create: false,
      })).resolves.toBeDefined();
      await session.close();
    } finally {
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: originalLocks,
      });
    }
  });


  it('prepares immutable file objects before acquiring the global commit lock', async () => {
    const originalLocks = navigator.locks;
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: undefined,
    });
    try {
      const session = await createTiny({
        root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
        now: () => 1,
      });
      const hizofs = requireHizoFSSession({ session });
      const lockName = `hizofs/${hizofs.fileSystemId}/commit`;
      const originalWriteFile = hizofs.runtime.inodeStore.writeFile.bind(
        hizofs.runtime.inodeStore,
      );
      const observedLockStates: boolean[] = [];
      vi.spyOn(hizofs.runtime.inodeStore, 'writeFile').mockImplementation(
        async options => {
          observedLockStates.push(
            MUTATION_LOCK_TEST_ONLY.localMutationTails.has(lockName),
          );
          return await originalWriteFile(options);
        },
      );

      await session.root.getFileHandle({ name: 'prepared.txt', create: true });

      expect(observedLockStates.length).toBeGreaterThan(0);
      expect(observedLockStates).not.toContain(true);
      await session.close();
    } finally {
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: originalLocks,
      });
    }
  });

  it('serializes mutations from separate sessions without losing either root update', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const first = await createTiny({ root: backing, now: () => 1 });
    const second = await openTiny({ root: backing, now: () => 2 });

    await Promise.all([
      first.root.getFileHandle({ name: 'from-first', create: true }),
      second.root.getFileHandle({ name: 'from-second', create: true }),
    ]);
    await first.close();
    await second.close();

    const reopened = await openTiny({ root: backing, now: () => 3 });
    await expect(reopened.root.getFileHandle({
      name: 'from-first',
      create: false,
    })).resolves.toBeDefined();
    await expect(reopened.root.getFileHandle({
      name: 'from-second',
      create: false,
    })).resolves.toBeDefined();
    await reopened.close();
  });

  it('rejects a writer from another session after the file revision changes', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const firstSession = await createTiny({ root: backing, now: () => 1 });
    const initialFile = await firstSession.root.getFileHandle({ name: 'shared.bin', create: true });
    await writeStorageFileText({ fileHandle: initialFile, value: 'initial' });
    const secondSession = await openTiny({ root: backing, now: () => 2 });
    const firstFile = await firstSession.root.getFileHandle({ name: 'shared.bin', create: false });
    const secondFile = await secondSession.root.getFileHandle({ name: 'shared.bin', create: false });
    const firstWriter = await firstFile.createWritable({ keepExistingData: true });
    const secondWriter = await secondFile.createWritable({ keepExistingData: true });

    await firstWriter.write({ position: 0, data: new TextEncoder().encode('winner') });
    await secondWriter.write({ position: 0, data: new TextEncoder().encode('loser!') });
    await firstWriter.close();
    await expect(secondWriter.close()).rejects.toThrow('changed while its writer was open');
    expect(await readStorageFileText({ fileHandle: firstFile })).toBe('winnerl');
    await firstSession.close();
    await secondSession.close();
  });

  it('rejects moving a directory into its descendant without changing the tree', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    const parent = await session.root.getDirectoryHandle({ name: 'parent', create: true });
    const child = await parent.getDirectoryHandle({ name: 'child', create: true });
    await parent.getFileHandle({ name: 'value.txt', create: true });

    await expect(session.root.moveEntry({
      name: 'parent',
      destination: child,
      newName: 'nested-parent',
      replace: false,
    })).rejects.toMatchObject({ name: 'InvalidModificationError' });
    await expect(session.root.getDirectoryHandle({
      name: 'parent',
      create: false,
    })).resolves.toBeDefined();
    await expect(child.getDirectoryHandle({
      name: 'nested-parent',
      create: false,
    })).rejects.toMatchObject({ name: 'NotFoundError' });
    await session.close();
  });

  it('atomically replaces compatible entries and rejects unsafe replacements', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    const source = await session.root.getDirectoryHandle({ name: 'source', create: true });
    const destination = await session.root.getDirectoryHandle({ name: 'destination', create: true });
    await writeStorageFileText({
      fileHandle: await source.getFileHandle({ name: 'incoming.txt', create: true }),
      value: 'incoming',
    });
    await writeStorageFileText({
      fileHandle: await destination.getFileHandle({ name: 'target.txt', create: true }),
      value: 'old-target',
    });

    await source.moveEntry({
      name: 'incoming.txt',
      destination,
      newName: 'target.txt',
      replace: true,
    });
    expect(await readStorageFileText({
      fileHandle: await destination.getFileHandle({ name: 'target.txt', create: false }),
    })).toBe('incoming');
    await expect(source.getFileHandle({
      name: 'incoming.txt',
      create: false,
    })).rejects.toMatchObject({ name: 'NotFoundError' });

    const sourceFile = await source.getFileHandle({ name: 'file', create: true });
    const targetDirectory = await destination.getDirectoryHandle({ name: 'entry', create: true });
    await expect(source.moveEntry({
      name: 'file',
      destination,
      newName: 'entry',
      replace: true,
    })).rejects.toMatchObject({ name: 'TypeMismatchError' });
    await expect(source.getFileHandle({ name: 'file', create: false })).resolves.toMatchObject({
      kind: sourceFile.kind,
      name: sourceFile.name,
    });
    await expect(destination.getDirectoryHandle({
      name: 'entry',
      create: false,
    })).resolves.toMatchObject({
      kind: targetDirectory.kind,
      name: targetDirectory.name,
    });

    const sourceDirectory = await source.getDirectoryHandle({ name: 'directory', create: true });
    await destination.getDirectoryHandle({ name: 'non-empty', create: true }).then(
      async directory => await directory.getFileHandle({ name: 'child', create: true }),
    );
    await expect(source.moveEntry({
      name: 'directory',
      destination,
      newName: 'non-empty',
      replace: true,
    })).rejects.toMatchObject({ name: 'InvalidModificationError' });
    await expect(source.getDirectoryHandle({
      name: 'directory',
      create: false,
    })).resolves.toMatchObject({
      kind: sourceDirectory.kind,
      name: sourceDirectory.name,
    });
    await session.close();
  });

  it('creates directories and symlinks and atomically moves a stable file between directories', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    const from = await session.root.getDirectoryHandle({ name: 'from', create: true });
    const to = await session.root.getDirectoryHandle({ name: 'to', create: true });
    const file = await from.getFileHandle({ name: 'before.txt', create: true });
    await writeStorageFileText({ fileHandle: file, value: 'payload' });
    const link = await from.createSymlink({ name: 'link', target: 'before.txt' });
    expect(await link.readTarget()).toBe('before.txt');

    await from.moveEntry({
      name: 'before.txt',
      destination: to,
      newName: 'after.txt',
      replace: false,
    });
    await expect(from.getFileHandle({ name: 'before.txt', create: false })).rejects.toMatchObject({
      name: 'NotFoundError',
    });
    expect(await readStorageFileText({
      fileHandle: await to.getFileHandle({ name: 'after.txt', create: false }),
    })).toBe('payload');
  });

  it('converts a large directory to an indexed representation without changing enumeration semantics', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    const directory = await session.root.getDirectoryHandle({ name: 'many', create: true });
    const hizofs = requireHizoFSSession({ session });
    const buildSpy = vi.spyOn(hizofs.runtime.directoryIndex, 'buildFromSortedEntries');
    const setSpy = vi.spyOn(hizofs.runtime.directoryIndex, 'set');
    for (const name of ['z', 'a', 'm', 'b', 'y']) {
      await directory.getFileHandle({ name, create: true });
    }
    const names: string[] = [];
    for await (const [name] of directory.entries()) names.push(name);
    expect(names).toEqual(['a', 'b', 'm', 'y', 'z']);
    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledTimes(2);
  });

  it('enforces non-recursive directory deletion and removes complete subtrees recursively', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    const parent = await session.root.getDirectoryHandle({ name: 'parent', create: true });
    const child = await parent.getDirectoryHandle({ name: 'child', create: true });
    await child.getFileHandle({ name: 'value', create: true });

    await expect(session.root.removeEntry({
      name: 'parent',
      recursive: false,
    })).rejects.toMatchObject({ name: 'InvalidModificationError' });
    await session.root.removeEntry({ name: 'parent', recursive: true });
    await expect(session.root.getDirectoryHandle({
      name: 'parent',
      create: false,
    })).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('invalidates handles when their session is closed', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    const root = session.root;
    await session.close();
    await expect(root.getFileHandle({ name: 'x', create: true })).rejects.toThrow(
      'session is closed',
    );
  });

  it('reuses immutable metadata while continuing to authenticate mutable superblocks', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ root: backing, now: () => 1 });
    for (let index = 0; index < 12; index += 1) {
      await session.root.getFileHandle({
        name: `cached-${String(index)}.txt`,
        create: true,
      });
    }
    const backingReadSpy = vi.spyOn(
      NativeOpfsHizoFSBackingStore.prototype,
      'read',
    );

    for (let index = 0; index < 10; index += 1) {
      await session.root.getFileHandle({
        name: 'cached-11.txt',
        create: false,
      });
    }

    expect(backingReadSpy).toHaveBeenCalledTimes(20);
    await session.close();
  });

  it('keeps one fixed generation for snapshot traversal without reloading active state', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ root: backing, now: () => 1 });
    for (let index = 0; index < 12; index += 1) {
      await writeStorageFileText({
        fileHandle: await session.root.getFileHandle({
          name: `file-${String(index)}.txt`,
          create: true,
        }),
        value: `value-${String(index)}`,
      });
    }
    const snapshot = await session.createReadSnapshot?.();
    expect(snapshot).toBeDefined();
    if (snapshot === undefined) throw new Error('Expected a HizoFS read snapshot');
    const snapshotSession = requireHizoFSSession({ session: snapshot });
    const activeStateSpy = vi.spyOn(snapshotSession.runtime.core, 'loadActiveState');

    for await (const [, entry] of snapshot.root.entries()) {
      if (entry.kind !== 'file') continue;
      await entry.stat();
      const readable = await entry.openReadable({ mimeType: 'text/plain' });
      try {
        await readable.read({
          buffer: new Uint8Array(2),
          offset: 0,
          length: 2,
          position: 0,
          signal: undefined,
        });
      } finally {
        await readable.close();
      }
    }

    expect(activeStateSpy).not.toHaveBeenCalled();
    await snapshot.close();
    await session.close();
  });

  it('flushes one replacement object for repeated writes to the same chunk', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ root: backing, now: () => 1 });
    const file = await session.root.getFileHandle({ name: 'same-chunk.bin', create: true });
    await writeStorageFileText({ fileHandle: file, value: 'abcdefghijklmnop' });
    const chunksBefore = await countPhysicalObjectsByKind({
      backing,
      kind: 'file_chunk',
    });
    const writer = await file.createWritable({ keepExistingData: true });
    await writer.write({ position: 0, data: new Uint8Array([1]) });
    await writer.write({ position: 1, data: new Uint8Array([2]) });
    await writer.write({ position: 2, data: new Uint8Array([3]) });
    await writer.close();

    expect(await countPhysicalObjectsByKind({
      backing,
      kind: 'file_chunk',
    })).toBe(chunksBefore + 1);
    await session.close();
  });

  it('coalesces repeated random writes to every dirty chunk retained by the byte budget', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ root: backing, now: () => 1 });
    const file = await session.root.getFileHandle({ name: 'random-write.bin', create: true });
    await writeStorageFileText({ fileHandle: file, value: 'abcdefghijklmnop' });
    const chunksBefore = await countPhysicalObjectsByKind({
      backing,
      kind: 'file_chunk',
    });
    const extentPagesBefore = await countPhysicalObjectsByKind({
      backing,
      kind: 'file_extent_page',
    });
    const hizofs = requireHizoFSSession({ session });
    const buildSpy = vi.spyOn(hizofs.runtime.extentIndex, 'buildFromSortedExtents');
    const setSpy = vi.spyOn(hizofs.runtime.extentIndex, 'set');

    const writer = await file.createWritable({ keepExistingData: true });
    for (let round = 0; round < 8; round += 1) {
      for (const position of [0, 4, 8, 12]) {
        await writer.write({
          position,
          data: new Uint8Array([round + position]),
        });
      }
    }
    await writer.close();

    expect(await countPhysicalObjectsByKind({
      backing,
      kind: 'file_chunk',
    })).toBe(chunksBefore + 4);
    expect(await countPhysicalObjectsByKind({
      backing,
      kind: 'file_extent_page',
    })).toBe(extentPagesBefore + 3);
    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).not.toHaveBeenCalled();
    expect(await readStorageFileText({ fileHandle: file })).toBe(
      `${String.fromCharCode(7)}bcd${String.fromCharCode(11)}fgh${String.fromCharCode(15)}jkl${String.fromCharCode(19)}nop`,
    );
    await session.close();
  });

  it('bounds concurrent immutable chunk writes while overlapping close-time persistence', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const policy: HizoFSPolicy = {
      ...TINY_POLICY,
      fileChunkWriteConcurrency: 2,
    };
    const session = await TEST_ONLY.createHizoFSInternal({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      policy,
      now: () => 1,
    });
    const file = await session.root.getFileHandle({
      name: 'concurrent-chunks.bin',
      create: true,
    });
    const hizofs = requireHizoFSSession({ session });
    const originalWrite = hizofs.runtime.chunkStore.write.bind(hizofs.runtime.chunkStore);
    const releaseWrites = Promise.withResolvers<void>();
    const firstWaveStarted = Promise.withResolvers<void>();
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    let startedWrites = 0;
    vi.spyOn(hizofs.runtime.chunkStore, 'write').mockImplementation(async (arguments_) => {
      activeWrites += 1;
      startedWrites += 1;
      maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
      if (startedWrites === 2) firstWaveStarted.resolve();
      try {
        await releaseWrites.promise;
        return await originalWrite(arguments_);
      } finally {
        activeWrites -= 1;
      }
    });

    const writer = await file.createWritable({ keepExistingData: false });
    const expected = new Uint8Array(16).map((_, index) => index + 1);
    await writer.write({ position: 0, data: expected });
    const closePromise = writer.close();
    await firstWaveStarted.promise;

    expect(maximumActiveWrites).toBe(2);
    expect(startedWrites).toBe(2);
    releaseWrites.resolve();
    await closePromise;
    expect(maximumActiveWrites).toBe(2);
    expect(startedWrites).toBe(4);
    expect(await readBytes({ session, path: ['concurrent-chunks.bin'] })).toEqual(expected);
    await session.close();
  });

  it('waits for every scheduled chunk write to settle before reporting a close failure', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const policy: HizoFSPolicy = {
      ...TINY_POLICY,
      fileChunkWriteConcurrency: 2,
    };
    const session = await TEST_ONLY.createHizoFSInternal({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      policy,
      now: () => 1,
    });
    const file = await session.root.getFileHandle({
      name: 'failed-concurrent-chunks.bin',
      create: true,
    });
    const hizofs = requireHizoFSSession({ session });
    const originalWrite = hizofs.runtime.chunkStore.write.bind(hizofs.runtime.chunkStore);
    const releaseSuccessfulWrites = Promise.withResolvers<void>();
    const blockedWritesStarted = Promise.withResolvers<void>();
    let invocation = 0;
    let blockedWriteCount = 0;
    vi.spyOn(hizofs.runtime.chunkStore, 'write').mockImplementation(async (arguments_) => {
      invocation += 1;
      if (invocation === 1) throw new Error('injected chunk write failure');
      blockedWriteCount += 1;
      if (blockedWriteCount === 2) blockedWritesStarted.resolve();
      await releaseSuccessfulWrites.promise;
      return originalWrite(arguments_);
    });

    const writer = await file.createWritable({ keepExistingData: false });
    await writer.write({
      position: 0,
      data: new Uint8Array(16).map((_, index) => index + 1),
    });
    let closeSettled = false;
    const closePromise = writer.close().finally(() => {
      closeSettled = true;
    });
    await blockedWritesStarted.promise;

    expect(closeSettled).toBe(false);
    releaseSuccessfulWrites.resolve();
    await expect(closePromise).rejects.toThrow('injected chunk write failure');
    expect(invocation).toBe(4);

    await expect(session.root.getFileHandle({
      name: 'session-remains-usable.bin',
      create: true,
    })).resolves.toBeDefined();
    await session.close();
  });

  it('flushes dirty chunks before close when the configured byte budget is exhausted', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const policy: HizoFSPolicy = {
      ...TINY_POLICY,
      maxDirtyFileBytes: 8,
    };
    const session = await TEST_ONLY.createHizoFSInternal({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      policy,
      now: () => 1,
    });
    const file = await session.root.getFileHandle({ name: 'bounded.bin', create: true });
    const hizofs = requireHizoFSSession({ session });
    const writeSpy = vi.spyOn(hizofs.runtime.chunkStore, 'write');
    const writer = await file.createWritable({ keepExistingData: false });

    await writer.write({ position: 0, data: new Uint8Array([1]) });
    await writer.write({ position: 4, data: new Uint8Array([2]) });
    expect(writeSpy).not.toHaveBeenCalled();
    await writer.write({ position: 8, data: new Uint8Array([3]) });
    expect(writeSpy).toHaveBeenCalledTimes(1);

    await writer.abort({ reason: new Error('test complete') });
    await session.close();
  });

  it('truncates an extent-backed file without one delete per extent', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ root: backing, now: () => 1 });
    const file = await session.root.getFileHandle({ name: 'truncate.bin', create: true });
    await writeStorageFileText({
      fileHandle: file,
      value: 'abcdefghijklmnopqrstuvwxyz0123456789',
    });
    const hizofs = requireHizoFSSession({ session });
    const truncateSpy = vi.spyOn(hizofs.runtime.extentIndex, 'truncateAtOrAfter');
    const deleteSpy = vi.spyOn(hizofs.runtime.extentIndex, 'delete');

    const writer = await file.createWritable({ keepExistingData: true });
    await writer.truncate({ size: 0 });
    await writer.close();

    expect(truncateSpy.mock.calls.length).toBeLessThanOrEqual(1);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(await file.stat()).toMatchObject({ size: 0 });
    await session.close();
  });

  it('batch-deletes one recursive subtree from the inode index', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ root: backing, now: () => 1 });
    const directory = await session.root.getDirectoryHandle({ name: 'tree', create: true });
    for (let index = 0; index < 12; index += 1) {
      await writeStorageFileText({
        fileHandle: await directory.getFileHandle({
          name: `file-${String(index)}.txt`,
          create: true,
        }),
        value: String(index),
      });
    }
    const hizofs = requireHizoFSSession({ session });
    const deleteManySpy = vi.spyOn(hizofs.runtime.inodeIndex, 'deleteMany');
    const deleteSpy = vi.spyOn(hizofs.runtime.inodeIndex, 'delete');

    await session.root.removeEntry({ name: 'tree', recursive: true });

    expect(deleteManySpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).not.toHaveBeenCalled();
    await session.close();
  });

  it('rejects malformed Unicode names before they enter persistent ordering', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    await expect(session.root.getFileHandle({
      name: '\uD800',
      create: true,
    })).rejects.toThrow('unpaired UTF-16 surrogate');
    await session.close();
  });


  it('falls back read-only when the newest complete superblock points to a corrupt commit', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ root: backing, now: () => 1 });
    await writeStorageFileText({
      fileHandle: await session.root.getFileHandle({ name: 'value.txt', create: true }),
      value: 'latest',
    });
    const inspection = await inspectHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    const activeCommitObjectId = inspection.activeCommitObjectId;
    await new NativeOpfsHizoFSBackingStore({ root: backing }).remove({
      path: [
        'objects',
        getHizoFSObjectShard({ objectId: activeCommitObjectId }),
        `${activeCommitObjectId}.enc`,
      ],
      recursive: false,
    });
    await session.close();

    const recovered = await openTiny({ root: backing, now: () => 2 });
    const recoveredSession = requireHizoFSSession({ session: recovered });
    expect((await recoveredSession.loadActiveState()).mode).toBe('fallback_read_only');
    await expect(recovered.root.getFileHandle({
      name: 'must-not-write.txt',
      create: true,
    })).rejects.toThrow('read-only recovery mode');
    await recovered.close();
  });

});
