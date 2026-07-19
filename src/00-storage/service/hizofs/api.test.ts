import { describe, expect, it, vi } from 'vitest';
import type { HizoFSSubvolumeMountDto } from '@/00-storage/00-dto/hizofs.dto';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import {
  readStorageFileText,
  writeStorageFileText,
} from '@/00-storage/service/storage-file-system/io';
import type {
  StorageDirectoryHandle,
  StorageFileSystemSession,
} from '@/00-storage/service/storage-file-system/types';
import {
  createHizoFS,
  createHizoFSBulkBuilder,
  createHizoFSDiagnosticSession,
  createHizoFSSubvolume,
  deleteHizoFSSubvolume,
  getHizoFSSubvolumeInfo,
  inspectHizoFS,
  openHizoFS,
  openHizoFSWorkerMount,
  snapshotHizoFSSubvolume,
  TEST_ONLY,
} from './api';
import {
  DEFAULT_HIZOFS_POLICY,
  type HizoFSPolicy,
} from './file-system/policy';
import { createHizoFSRuntimeDiagnostics } from './file-system/diagnostics';
import { createQueuedTestLockManager } from './test-lock-manager';
import {
  getHizoFSDirectoryHandleContext,
  HizoFSSession,
} from './file-system/session';
import type { LoadedHizoFSFile } from './file-system/node-service';
import { createHizoFSInspectionReader } from './inspection';
import type { HizoFSRecordKind } from './format/record';
import { NativeOpfsHizoFSBackingStore } from './backing-store/native-opfs-backing-store';
import { getHizoFSObjectShard } from './object-store/object-id';
import {
  decodeHizoFSObjectReference,
  encodeHizoFSSegmentId,
} from './segment-store/object-reference';
import { HIZOFS_RECORD_FRAME_HEADER_BYTE_LENGTH } from './segment-store/segment-format';
import { collectHizoFSGarbage } from './garbage-collector';
import { TEST_ONLY as MAINTENANCE_LOCK_TEST_ONLY } from './file-system/maintenance-lock';
import { createHizoFSStableId } from './id';

const ROOT_KEY = new Uint8Array(32).fill(9);
const TINY_POLICY: HizoFSPolicy = {
  inlineFileByteLimit: 8,
  inlineDirectoryEntryLimit: 2,
  fileChunkSize: 4,
  decodedInodeIndexPageCacheEntryLimit: 16,
  inodeIndexPageEntryLimit: 2,
  directoryIndexPageEntryLimit: 2,
  fileExtentIndexPageEntryLimit: 2,
  readerStreamChunkSize: 3,
  fileChunkReadPrefetchConcurrency: 2,
  backingFileHandleCacheEntryLimit: 64,
  backingFileSnapshotCacheEntryLimit: 64,
  maxDirtyFileBytes: 16,
  fileChunkWriteConcurrency: 2,
  metadataObjectCacheByteLimit: 64 * 1024,
  metadataObjectCacheEntryLimit: 1024,
  fileChunkCacheByteLimit: 64,
  fileChunkCacheEntryLimit: 16,
  fileChunkCacheAdmission: 'read',
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

async function getOnlyRootSubvolumeMount({
  session,
}: {
  session: StorageFileSystemSession;
}): Promise<HizoFSSubvolumeMountDto> {
  const hizofs = requireHizoFSSession({ session });
  const state = await hizofs.loadFilesystemState();
  const mounts: HizoFSSubvolumeMountDto[] = [];
  for await (const mount of hizofs.runtime.subvolumeMountIndex.entries({
    rootObjectId: state.commit.subvolumeMountIndexRootObjectId,
  })) {
    mounts.push(mount);
  }
  const mount = mounts[0];
  if (mount === undefined || mounts.length !== 1) {
    throw new Error(`Expected exactly one root subvolume mount, found ${mounts.length}`);
  }
  return mount;
}

async function publishRootMountReplacement({
  session,
  mount,
}: {
  session: StorageFileSystemSession;
  mount: HizoFSSubvolumeMountDto;
}): Promise<void> {
  const hizofs = requireHizoFSSession({ session });
  await hizofs.core.mutateTopologyAndReturnState({
    operation: async ({ state }) => ({
      changed: 'yes' as const,
      inodeIndexRootObjectId: state.commit.inodeIndexRootObjectId,
      subvolumeMountIndexRootObjectId:
        await hizofs.runtime.subvolumeMountIndex.set({
          rootObjectId: state.commit.subvolumeMountIndexRootObjectId,
          mount,
        }),
      result: undefined,
    }),
  });
}

async function publishRootSubvolumeAlias({
  session,
  name,
  subvolumeDescriptorObjectId,
}: {
  session: StorageFileSystemSession;
  name: string;
  subvolumeDescriptorObjectId: string;
}): Promise<void> {
  const hizofs = requireHizoFSSession({ session });
  const mountId = createHizoFSStableId();
  await hizofs.core.mutateTopologyAndReturnState({
    operation: async ({ state }) => {
      const rootDirectory = await hizofs.runtime.nodeService.readDirectory({
        state,
        nodeId: state.commit.rootDirectoryNodeId,
      });
      const changedRootDirectory =
        await hizofs.runtime.directoryStorage.writeChangedInode({
          inode: rootDirectory.inode,
          changes: [{
            type: 'set',
            entry: {
              name,
              kind: 'subvolume',
              mountId,
            },
          }],
          modifiedAt: 2,
        });
      const subvolumeMountIndexRootObjectId =
        await hizofs.runtime.subvolumeMountIndex.set({
          rootObjectId: state.commit.subvolumeMountIndexRootObjectId,
          mount: {
            mountId,
            subvolumeDescriptorObjectId,
            parentDirectoryNodeId: state.commit.rootDirectoryNodeId,
            entryName: name,
          },
        });
      const inodeIndexRootObjectId = await hizofs.runtime.nodeService.setInode({
        inodeIndexRootObjectId: state.commit.inodeIndexRootObjectId,
        nodeId: state.commit.rootDirectoryNodeId,
        inodeObjectId: changedRootDirectory.inodeObjectId,
      });
      return {
        changed: 'yes' as const,
        inodeIndexRootObjectId,
        subvolumeMountIndexRootObjectId,
        result: undefined,
      };
    },
  });
}

async function publishSubvolumeAlias({
  destination,
  name,
  subvolumeDescriptorObjectId,
}: {
  destination: StorageDirectoryHandle;
  name: string;
  subvolumeDescriptorObjectId: string;
}): Promise<void> {
  const context = getHizoFSDirectoryHandleContext({ handle: destination });
  if (context === undefined) {
    throw new Error('Expected a HizoFS destination directory');
  }
  const mountId = createHizoFSStableId();
  await context.session.core.mutateTopologyAndReturnState({
    operation: async ({ state }) => {
      const directory = await context.session.runtime.nodeService.readDirectory({
        state,
        nodeId: context.nodeId,
      });
      const changedDirectory =
        await context.session.runtime.directoryStorage.writeChangedInode({
          inode: directory.inode,
          changes: [{
            type: 'set',
            entry: {
              name,
              kind: 'subvolume',
              mountId,
            },
          }],
          modifiedAt: 2,
        });
      const subvolumeMountIndexRootObjectId =
        await context.session.runtime.subvolumeMountIndex.set({
          rootObjectId: state.commit.subvolumeMountIndexRootObjectId,
          mount: {
            mountId,
            subvolumeDescriptorObjectId,
            parentDirectoryNodeId: context.nodeId,
            entryName: name,
          },
        });
      const inodeIndexRootObjectId =
        await context.session.runtime.nodeService.setInode({
          inodeIndexRootObjectId: state.commit.inodeIndexRootObjectId,
          nodeId: context.nodeId,
          inodeObjectId: changedDirectory.inodeObjectId,
        });
      return {
        changed: 'yes' as const,
        inodeIndexRootObjectId,
        subvolumeMountIndexRootObjectId,
        result: undefined,
      };
    },
  });
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
  it('creates and reopens the root as one read_write subvolume', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const created = await createTiny({ root, now: () => 1 });
    const createdInfo = await getHizoFSSubvolumeInfo({
      handle: created.root,
    });
    expect(createdInfo).toMatchObject({
      access: 'read_write',
      stateSelection: 'current',
      root: true,
    });
    expect(createdInfo?.subvolumeId).toEqual(expect.any(String));
    const createdId = createdInfo?.subvolumeId;
    const createdInstanceId = requireHizoFSSession({
      session: created,
    }).instanceId;
    await created.close();

    const reopened = await openTiny({ root, now: () => 2 });
    expect(requireHizoFSSession({ session: reopened }).instanceId)
      .toBe(createdInstanceId);
    await expect(getHizoFSSubvolumeInfo({
      handle: reopened.root,
    })).resolves.toEqual({
      subvolumeId: createdId,
      access: 'read_write',
      stateSelection: 'current',
      root: true,
    });
    await reopened.close();
  });

  it('rejects a root whose descriptor is persistently read access', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ root, now: () => 1 });
    if (!(session instanceof HizoFSSession)) throw new Error('Expected a HizoFS session');
    const state = await session.loadActiveState();
    const descriptorObjectId = await session.runtime.subvolumeDescriptorStore.write({
      descriptor: {
        subvolumeId: state.commit.subvolumeId,
        access: 'read',
        fixedCommitObjectId: state.commitObjectId,
      },
    });
    await session.runtime.objectStore.flushPendingRecords();
    for (const sequence of [state.superblock.sequence + 1, state.superblock.sequence + 2]) {
      await session.runtime.core.superblockStore.write({
        value: {
          ...state.superblock,
          sequence,
          subvolumeDescriptorObjectId: descriptorObjectId,
        },
      });
    }
    await session.close();

    await expect(openTiny({ root, now: () => 2 })).rejects.toThrow(
      'No complete HizoFS superblock generation remains',
    );
  });

  it('rejects a root commit bound to another subvolume identity', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ root, now: () => 1 });
    if (!(session instanceof HizoFSSession)) throw new Error('Expected a HizoFS session');
    const state = await session.loadActiveState();
    const foreignCommitObjectId = await session.runtime.commitStore.write({
      commit: {
        ...state.commit,
        publicationId: createHizoFSStableId(),
        subvolumeId: createHizoFSStableId(),
      },
    });
    await session.runtime.objectStore.flushPendingRecords();
    for (const sequence of [state.superblock.sequence + 1, state.superblock.sequence + 2]) {
      await session.runtime.core.superblockStore.write({
        value: {
          ...state.superblock,
          sequence,
          activeCommitObjectId: foreignCommitObjectId,
        },
      });
    }
    await session.close();

    await expect(openTiny({ root, now: () => 2 })).rejects.toThrow(
      'No complete HizoFS superblock generation remains',
    );
  });

  it('adds no subvolume metadata I/O to ordinary root operations', async () => {
    const diagnostics = createHizoFSRuntimeDiagnostics();
    const session = await createHizoFSDiagnosticSession({
      backingDirectory: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      fileSystemRootKey: ROOT_KEY,
      policy: TINY_POLICY,
      diagnostics,
    });
    const before = diagnostics.snapshot();

    await session.root.getFileHandle({ name: 'ordinary', create: true });
    await session.root.getFileHandle({ name: 'ordinary', create: false });

    const after = diagnostics.snapshot();
    expect(after.records.subvolume_descriptor.readOperations)
      .toBe(before.records.subvolume_descriptor.readOperations);
    expect(after.records.subvolume_descriptor.writeOperations)
      .toBe(before.records.subvolume_descriptor.writeOperations);
    expect(after.records.subvolume_mount_index_page.readOperations)
      .toBe(before.records.subvolume_mount_index_page.readOperations);
    expect(after.records.subvolume_mount_index_page.writeOperations)
      .toBe(before.records.subvolume_mount_index_page.writeOperations);
    await session.close();
  });

  it('keeps ordinary root operations free of mount metadata I/O after children exist', async () => {
    const diagnostics = createHizoFSRuntimeDiagnostics();
    const session = await createHizoFSDiagnosticSession({
      backingDirectory: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      fileSystemRootKey: ROOT_KEY,
      policy: TINY_POLICY,
      diagnostics,
    });
    await createHizoFSSubvolume({
      destination: session.root,
      name: 'archive',
      access: 'read',
    });
    await createHizoFSSubvolume({
      destination: session.root,
      name: 'workspace',
      access: 'read_write',
    });
    const before = diagnostics.snapshot();

    await session.root.getFileHandle({ name: 'ordinary', create: true });
    await session.root.getFileHandle({ name: 'ordinary', create: false });

    const after = diagnostics.snapshot();
    expect(after.records.subvolume_descriptor.readOperations)
      .toBe(before.records.subvolume_descriptor.readOperations);
    expect(after.records.subvolume_descriptor.writeOperations)
      .toBe(before.records.subvolume_descriptor.writeOperations);
    expect(after.records.subvolume_mount_index_page.readOperations)
      .toBe(before.records.subvolume_mount_index_page.readOperations);
    expect(after.records.subvolume_mount_index_page.writeOperations)
      .toBe(before.records.subvolume_mount_index_page.writeOperations);
    await session.close();
  });

  it('opens an empty read subvolume through one stable mount entry', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ root: backing, now: () => 1 });
    const hizofs = requireHizoFSSession({ session });
    const child = await hizofs.createReadSubvolume({
      directoryNodeId: hizofs.rootDirectoryNodeId,
      name: 'archive',
    });

    await expect(child.getFileHandle({
      name: 'forbidden.txt',
      create: true,
    })).rejects.toMatchObject({ name: 'NoModificationAllowedError' });
    await expect(session.root.getDirectoryHandle({
      name: 'archive',
      create: false,
    })).resolves.toMatchObject({ kind: 'directory', name: 'archive' });
    await expect(session.root.getEntryHandle({ name: 'archive' }))
      .resolves.toMatchObject({ kind: 'directory', name: 'archive' });
    const listed: string[] = [];
    for await (const [name, handle] of session.root.entries()) {
      if (handle.kind === 'directory') listed.push(name);
    }
    expect(listed).toContain('archive');

    await expect(session.root.removeEntry({
      name: 'archive',
      recursive: true,
    })).rejects.toMatchObject({ name: 'InvalidModificationError' });
    await session.close();

    const reopened = await openTiny({ root: backing, now: () => 2 });
    const reopenedChild = await reopened.root.getDirectoryHandle({
      name: 'archive',
      create: false,
    });
    await expect(reopenedChild.getFileHandle({
      name: 'still-forbidden.txt',
      create: true,
    })).rejects.toMatchObject({ name: 'NoModificationAllowedError' });
    await reopened.close();
  });

  it('releases the resource lease when a mounted snapshot cannot acquire its runtime pin', async () => {
    const ownerSession = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    const child = await createHizoFSSubvolume({
      destination: ownerSession.root,
      name: 'workspace',
      access: 'read_write',
    });
    const childContext = getHizoFSDirectoryHandleContext({ handle: child });
    if (childContext === undefined) {
      throw new Error('Expected a HizoFS child context');
    }
    const originalLocks = navigator.locks;
    const queuedLocks = createQueuedTestLockManager({ onRequest: undefined });
    const failure = new Error('injected runtime pin acquisition failure');
    let maintenanceRequestSettled = false;
    const queuedRequest = queuedLocks.request.bind(queuedLocks) as unknown as (
      name: string,
      options: LockOptions,
      callback: () => Promise<unknown> | unknown,
    ) => Promise<unknown>;
    const request = (
      name: string,
      options: LockOptions,
      callback: () => Promise<unknown> | unknown,
    ): Promise<unknown> => {
      if (name.includes('/subvolume-runtime/')) {
        return Promise.reject(failure);
      }
      const completion = queuedRequest(name, options, callback);
      if (name.endsWith('/maintenance')) {
        void completion.finally(() => {
          maintenanceRequestSettled = true;
        });
      }
      return completion;
    };
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request } as unknown as LockManager,
    });
    try {
      await expect(childContext.session.createReadSnapshot()).rejects.toBe(failure);
      expect(maintenanceRequestSettled).toBe(true);
    } finally {
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: originalLocks,
      });
      await ownerSession.close();
    }
  });

  it('retries a mounted child after runtime pin acquisition fails once', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const created = await createTiny({ root: backing, now: () => 1 });
    await createHizoFSSubvolume({
      destination: created.root,
      name: 'archive',
      access: 'read',
    });
    await created.close();

    const reopened = await openTiny({ root: backing, now: () => 2 });
    const originalLocks = navigator.locks;
    const queuedLocks = createQueuedTestLockManager({ onRequest: undefined });
    const failure = new Error('injected first runtime pin failure');
    let failedRuntimePin = false;
    const queuedRequest = queuedLocks.request.bind(queuedLocks) as unknown as (
      name: string,
      options: LockOptions,
      callback: () => Promise<unknown> | unknown,
    ) => Promise<unknown>;
    const request = (
      name: string,
      options: LockOptions,
      callback: () => Promise<unknown> | unknown,
    ): Promise<unknown> => {
      if (name.includes('/subvolume-runtime/') && !failedRuntimePin) {
        failedRuntimePin = true;
        return Promise.reject(failure);
      }
      return queuedRequest(name, options, callback);
    };
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request } as unknown as LockManager,
    });
    try {
      await expect(reopened.root.getDirectoryHandle({
        name: 'archive',
        create: false,
      })).rejects.toBe(failure);
      const retried = await reopened.root.getDirectoryHandle({
        name: 'archive',
        create: false,
      });
      await expect(getHizoFSSubvolumeInfo({ handle: retried })).resolves.toMatchObject({
        access: 'read',
        root: false,
      });
    } finally {
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: originalLocks,
      });
      await reopened.close();
    }
  });

  it('rejects a mount whose authenticated location disagrees with the namespace', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    await createHizoFSSubvolume({
      destination: session.root,
      name: 'archive',
      access: 'read',
    });
    const mount = await getOnlyRootSubvolumeMount({ session });
    await publishRootMountReplacement({
      session,
      mount: {
        ...mount,
        entryName: 'detached',
      },
    });

    await expect(session.root.getDirectoryHandle({
      name: 'archive',
      create: false,
    })).rejects.toThrow('mount location does not match the namespace');
    await expect((async () => {
      for await (const _entry of session.root.entries()) {
        // Iteration itself must validate every mounted entry.
      }
    })()).rejects.toThrow('mount location does not match the namespace');
    await expect(snapshotHizoFSSubvolume({
      source: session.root,
      destination: session.root,
      name: 'snapshot',
      access: 'read',
    })).rejects.toThrow('mount location does not match the namespace');
    await expect(session.root.getDirectoryHandle({
      name: 'snapshot',
      create: false,
    })).rejects.toMatchObject({ name: 'NotFoundError' });
    await session.close();
  });

  it('rejects one subvolume descriptor mounted from multiple current locations', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ root: backing, now: () => 1 });
    const child = await createHizoFSSubvolume({
      destination: session.root,
      name: 'primary',
      access: 'read_write',
    });
    const source = child.createWorkerMountSource?.();
    if (source === undefined) {
      throw new Error('Expected a HizoFS Worker mount source');
    }
    const hizofs = requireHizoFSSession({ session });
    const originalMount = await getOnlyRootSubvolumeMount({ session });
    const aliasMountId = createHizoFSStableId();
    await hizofs.core.mutateTopologyAndReturnState({
      operation: async ({ state }) => {
        const rootDirectory = await hizofs.runtime.nodeService.readDirectory({
          state,
          nodeId: state.commit.rootDirectoryNodeId,
        });
        const changedRootDirectory =
          await hizofs.runtime.directoryStorage.writeChangedInode({
            inode: rootDirectory.inode,
            changes: [{
              type: 'set',
              entry: {
                name: 'alias',
                kind: 'subvolume',
                mountId: aliasMountId,
              },
            }],
            modifiedAt: 2,
          });
        const subvolumeMountIndexRootObjectId =
          await hizofs.runtime.subvolumeMountIndex.set({
            rootObjectId: state.commit.subvolumeMountIndexRootObjectId,
            mount: {
              mountId: aliasMountId,
              subvolumeDescriptorObjectId:
                originalMount.subvolumeDescriptorObjectId,
              parentDirectoryNodeId: state.commit.rootDirectoryNodeId,
              entryName: 'alias',
            },
          });
        const inodeIndexRootObjectId = await hizofs.runtime.nodeService.setInode({
          inodeIndexRootObjectId: state.commit.inodeIndexRootObjectId,
          nodeId: state.commit.rootDirectoryNodeId,
          inodeObjectId: changedRootDirectory.inodeObjectId,
        });
        return {
          changed: 'yes' as const,
          inodeIndexRootObjectId,
          subvolumeMountIndexRootObjectId,
          result: undefined,
        };
      },
    });

    await expect(session.root.getDirectoryHandle({
      name: 'alias',
      create: false,
    })).rejects.toThrow('descriptor is mounted from multiple locations');

    const originalLocks = navigator.locks;
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: createQueuedTestLockManager({ onRequest: undefined }),
    });
    try {
      await expect(openHizoFSWorkerMount({ source })).rejects.toThrow(
        'subvolume graph contains multiple parents',
      );
    } finally {
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: originalLocks,
      });
      await session.close();
    }
  });

  it('rejects one descriptor mounted below distinct parent subvolumes', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    const firstParent = await createHizoFSSubvolume({
      destination: session.root,
      name: 'first-parent',
      access: 'read_write',
    });
    const secondParent = await createHizoFSSubvolume({
      destination: session.root,
      name: 'second-parent',
      access: 'read_write',
    });
    const original = await createHizoFSSubvolume({
      destination: firstParent,
      name: 'original',
      access: 'read',
    });
    const originalContext = getHizoFSDirectoryHandleContext({ handle: original });
    if (originalContext === undefined) {
      throw new Error('Expected an original subvolume context');
    }
    const originalInfo = await getHizoFSSubvolumeInfo({ handle: original });
    if (originalInfo === undefined) {
      throw new Error('Expected original subvolume information');
    }
    const originalMounts = [];
    const firstParentContext = getHizoFSDirectoryHandleContext({
      handle: firstParent,
    });
    if (firstParentContext === undefined) {
      throw new Error('Expected a first parent context');
    }
    const firstParentState = await firstParentContext.session.loadFilesystemState();
    for await (const mount of firstParentContext.session.runtime
      .subvolumeMountIndex.entries({
        rootObjectId:
          firstParentState.commit.subvolumeMountIndexRootObjectId,
      })) {
      originalMounts.push(mount);
    }
    const originalMount = originalMounts[0];
    if (originalMount === undefined || originalMounts.length !== 1) {
      throw new Error('Expected one original child mount');
    }
    await publishSubvolumeAlias({
      destination: secondParent,
      name: 'alias',
      subvolumeDescriptorObjectId:
        originalMount.subvolumeDescriptorObjectId,
    });

    await expect(secondParent.getDirectoryHandle({
      name: 'alias',
      create: false,
    })).rejects.toThrow('descriptor is mounted from multiple locations');
    expect(originalContext.session.subvolumeId).toBe(originalInfo.subvolumeId);
    await session.close();
  });

  it('rejects one subvolume identity bound to distinct authenticated descriptors', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ root: backing, now: () => 1 });
    const child = await createHizoFSSubvolume({
      destination: session.root,
      name: 'primary',
      access: 'read',
    });
    const source = child.createWorkerMountSource?.();
    if (source === undefined) {
      throw new Error('Expected a HizoFS Worker mount source');
    }
    const hizofs = requireHizoFSSession({ session });
    const originalMount = await getOnlyRootSubvolumeMount({ session });
    const originalDescriptor = await hizofs.runtime.subvolumeDescriptorStore.read({
      objectId: originalMount.subvolumeDescriptorObjectId,
    });
    if (originalDescriptor.access !== 'read') {
      throw new Error('Expected a read subvolume descriptor');
    }
    const originalCommit = await hizofs.runtime.commitStore.read({
      objectId: originalDescriptor.fixedCommitObjectId,
    });
    const conflictingCommitObjectId = await hizofs.runtime.commitStore.write({
      commit: {
        ...originalCommit,
        publicationId: createHizoFSStableId(),
      },
    });
    const conflictingDescriptorObjectId =
      await hizofs.runtime.subvolumeDescriptorStore.write({
        descriptor: {
          subvolumeId: originalDescriptor.subvolumeId,
          access: 'read',
          fixedCommitObjectId: conflictingCommitObjectId,
        },
      });
    await hizofs.runtime.objectStore.flushPendingRecords();
    expect(conflictingDescriptorObjectId)
      .not.toBe(originalMount.subvolumeDescriptorObjectId);
    await publishRootSubvolumeAlias({
      session,
      name: 'conflicting',
      subvolumeDescriptorObjectId: conflictingDescriptorObjectId,
    });

    await expect(session.root.getDirectoryHandle({
      name: 'conflicting',
      create: false,
    })).rejects.toThrow('identity is bound to multiple descriptors');

    const originalLocks = navigator.locks;
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: createQueuedTestLockManager({ onRequest: undefined }),
    });
    try {
      await expect(openHizoFSWorkerMount({ source })).rejects.toThrow(
        'identity is bound to multiple descriptors',
      );
    } finally {
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: originalLocks,
      });
      await session.close();
    }
  });

  it('creates independently writable child subvolumes through the public API', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({
      root: backing,
      now: () => 1,
    });

    const child = await createHizoFSSubvolume({
      destination: session.root,
      name: 'archive',
      access: 'read',
    });

    await expect(child.getFileHandle({
      name: 'forbidden.txt',
      create: true,
    })).rejects.toMatchObject({ name: 'NoModificationAllowedError' });
    const writable = await createHizoFSSubvolume({
      destination: session.root,
      name: 'writable',
      access: 'read_write',
    });
    const rootContext = getHizoFSDirectoryHandleContext({
      handle: session.root,
    });
    const writableContext = getHizoFSDirectoryHandleContext({
      handle: writable,
    });
    if (rootContext === undefined || writableContext === undefined) {
      throw new Error('Expected HizoFS subvolume contexts');
    }
    const rootStateBeforeChildWrite = await rootContext.session.loadActiveState();
    const childStateBeforeWrite = await writableContext.session.loadActiveState();
    await writeStorageFileText({
      fileHandle: await writable.getFileHandle({
        name: 'child.txt',
        create: true,
      }),
      value: 'independent child state',
    });
    const rootStateAfterChildWrite = await rootContext.session.loadActiveState();
    const childStateAfterWrite = await writableContext.session.loadActiveState();
    expect(rootStateAfterChildWrite.commitObjectId)
      .toBe(rootStateBeforeChildWrite.commitObjectId);
    expect(childStateAfterWrite.commit.revision)
      .toBeGreaterThan(childStateBeforeWrite.commit.revision);
    expect(await getHizoFSSubvolumeInfo({
      handle: writable,
    })).toMatchObject({
      access: 'read_write',
      root: false,
    });
    await session.close();

    const reopened = await openTiny({ root: backing, now: () => 2 });
    const reopenedWritable = await reopened.root.getDirectoryHandle({
      name: 'writable',
      create: false,
    });
    expect(await readStorageFileText({
      fileHandle: await reopenedWritable.getFileHandle({
        name: 'child.txt',
        create: false,
      }),
    })).toBe('independent child state');
    await reopened.close();
  });

  it('keeps a newly prepared child invisible when its parent publication fails', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    const hizofs = requireHizoFSSession({ session });
    const failure = new Error('injected subvolume creation publication failure');
    vi.spyOn(hizofs.core.superblockStore, 'write').mockRejectedValueOnce(failure);

    await expect(createHizoFSSubvolume({
      destination: session.root,
      name: 'must-not-appear',
      access: 'read_write',
    })).rejects.toBe(failure);
    await expect(session.root.getDirectoryHandle({
      name: 'must-not-appear',
      create: false,
    })).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(session.root.getFileHandle({
      name: 'still-writable.txt',
      create: true,
    })).resolves.toBeDefined();
    await session.close();
  });

  it('snapshots one subvolume without copying file or chunk records', async () => {
    const diagnostics = createHizoFSRuntimeDiagnostics();
    const session = await createHizoFSDiagnosticSession({
      backingDirectory: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      fileSystemRootKey: ROOT_KEY,
      policy: TINY_POLICY,
      diagnostics,
    });
    await writeStorageFileText({
      fileHandle: await session.root.getFileHandle({
        name: 'shared.txt',
        create: true,
      }),
      value: 'shared immutable data',
    });
    const sourceSession = requireHizoFSSession({ session });
    const sourceState = await sourceSession.loadFilesystemState();
    const before = diagnostics.snapshot();

    const snapshot = await snapshotHizoFSSubvolume({
      source: session.root,
      destination: session.root,
      name: 'snapshot',
      access: 'read',
    });
    const after = diagnostics.snapshot();

    expect(await readStorageFileText({
      fileHandle: await snapshot.getFileHandle({
        name: 'shared.txt',
        create: false,
      }),
    })).toBe('shared immutable data');
    const snapshotContext = getHizoFSDirectoryHandleContext({
      handle: snapshot,
    });
    if (snapshotContext === undefined) {
      throw new Error('Expected a HizoFS snapshot directory');
    }
    const snapshotState = await snapshotContext.session.loadFilesystemState();
    expect(snapshotState.commit.inodeIndexRootObjectId)
      .toBe(sourceState.commit.inodeIndexRootObjectId);
    expect(snapshotState.commit.rootDirectoryNodeId)
      .toBe(sourceState.commit.rootDirectoryNodeId);
    expect(snapshotState.commit.subvolumeId)
      .not.toBe(sourceState.commit.subvolumeId);
    expect(
      after.phases.commit_publication.operationCount
      - before.phases.commit_publication.operationCount,
    ).toBe(1);
    expect(
      after.records.subvolume_descriptor.writeOperations
      - before.records.subvolume_descriptor.writeOperations,
    ).toBe(1);
    expect(
      after.records.file_inode.readOperations
      - before.records.file_inode.readOperations,
    ).toBe(0);
    expect(
      after.records.file_inode.writeOperations
      - before.records.file_inode.writeOperations,
    ).toBe(0);
    expect(
      after.records.file_chunk.readOperations
      - before.records.file_chunk.readOperations,
    ).toBe(0);
    expect(
      after.records.file_chunk.writeOperations
      - before.records.file_chunk.writeOperations,
    ).toBe(0);
    await expect(snapshot.getFileHandle({
      name: 'forbidden.txt',
      create: true,
    })).rejects.toMatchObject({ name: 'NoModificationAllowedError' });
    await session.close();
  });

  it('recursively snapshots nested read subvolumes with fresh identities', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    const sourceChild = await createHizoFSSubvolume({
      destination: session.root,
      name: 'child',
      access: 'read',
    });
    const sourceChildContext = getHizoFSDirectoryHandleContext({
      handle: sourceChild,
    });
    if (sourceChildContext === undefined) {
      throw new Error('Expected a HizoFS child subvolume');
    }
    const sourceChildId = sourceChildContext.session.subvolumeId;

    const snapshot = await snapshotHizoFSSubvolume({
      source: session.root,
      destination: session.root,
      name: 'recursive-snapshot',
      access: 'read',
    });
    const clonedChild = await snapshot.getDirectoryHandle({
      name: 'child',
      create: false,
    });
    const snapshotContext = getHizoFSDirectoryHandleContext({
      handle: snapshot,
    });
    const clonedChildContext = getHizoFSDirectoryHandleContext({
      handle: clonedChild,
    });
    if (snapshotContext === undefined || clonedChildContext === undefined) {
      throw new Error('Expected recursive HizoFS subvolume handles');
    }
    const rootContext = getHizoFSDirectoryHandleContext({
      handle: session.root,
    });
    if (rootContext === undefined) {
      throw new Error('Expected the HizoFS root directory');
    }
    expect(snapshotContext.session.subvolumeId)
      .not.toBe(rootContext.session.subvolumeId);
    expect(clonedChildContext.session.subvolumeId).not.toBe(sourceChildId);
    expect(clonedChildContext.session.subvolumeId)
      .not.toBe(snapshotContext.session.subvolumeId);
    await session.close();
  });

  it('freezes nested read_write subvolumes into one recursive read snapshot', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    const sourceChild = await createHizoFSSubvolume({
      destination: session.root,
      name: 'workspace',
      access: 'read_write',
    });
    await writeStorageFileText({
      fileHandle: await sourceChild.getFileHandle({
        name: 'value.txt',
        create: true,
      }),
      value: 'captured value',
    });

    const snapshot = await snapshotHizoFSSubvolume({
      source: session.root,
      destination: session.root,
      name: 'snapshot',
      access: 'read',
    });
    const clonedChild = await snapshot.getDirectoryHandle({
      name: 'workspace',
      create: false,
    });
    expect(await readStorageFileText({
      fileHandle: await clonedChild.getFileHandle({
        name: 'value.txt',
        create: false,
      }),
    })).toBe('captured value');
    await expect(clonedChild.getFileHandle({
      name: 'forbidden.txt',
      create: true,
    })).rejects.toMatchObject({ name: 'NoModificationAllowedError' });

    await writeStorageFileText({
      fileHandle: await sourceChild.getFileHandle({
        name: 'value.txt',
        create: false,
      }),
      value: 'new source value',
    });
    expect(await readStorageFileText({
      fileHandle: await clonedChild.getFileHandle({
        name: 'value.txt',
        create: false,
      }),
    })).toBe('captured value');
    expect(await readStorageFileText({
      fileHandle: await sourceChild.getFileHandle({
        name: 'value.txt',
        create: false,
      }),
    })).toBe('new source value');
    await session.close();
  });

  it('creates an independently writable recursive snapshot graph', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    const sourceChild = await createHizoFSSubvolume({
      destination: session.root,
      name: 'workspace',
      access: 'read_write',
    });
    await writeStorageFileText({
      fileHandle: await sourceChild.getFileHandle({
        name: 'source.txt',
        create: true,
      }),
      value: 'shared initial state',
    });

    const snapshot = await snapshotHizoFSSubvolume({
      source: session.root,
      destination: session.root,
      name: 'writable-snapshot',
      access: 'read_write',
    });
    const clonedChild = await snapshot.getDirectoryHandle({
      name: 'workspace',
      create: false,
    });
    const snapshotContext = getHizoFSDirectoryHandleContext({
      handle: snapshot,
    });
    const clonedChildContext = getHizoFSDirectoryHandleContext({
      handle: clonedChild,
    });
    expect(snapshotContext).toBeDefined();
    expect(clonedChildContext).toBeDefined();
    if (snapshotContext === undefined || clonedChildContext === undefined) {
      throw new Error('Expected HizoFS subvolume directory contexts');
    }
    await expect(getHizoFSSubvolumeInfo({
      handle: snapshot,
    })).resolves.toMatchObject({ access: 'read_write', root: false });
    await expect(getHizoFSSubvolumeInfo({
      handle: clonedChild,
    })).resolves.toMatchObject({ access: 'read_write', root: false });

    await writeStorageFileText({
      fileHandle: await clonedChild.getFileHandle({
        name: 'snapshot-only.txt',
        create: true,
      }),
      value: 'snapshot mutation',
    });
    await expect(sourceChild.getFileHandle({
      name: 'snapshot-only.txt',
      create: false,
    })).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(await readStorageFileText({
      fileHandle: await clonedChild.getFileHandle({
        name: 'source.txt',
        create: false,
      }),
    })).toBe('shared initial state');
    await session.close();
  });

  it('captures one recursive snapshot cut while a later child write waits behind the maintenance fence', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    const source = await createHizoFSSubvolume({
      destination: session.root,
      name: 'source',
      access: 'read_write',
    });
    const nested = await createHizoFSSubvolume({
      destination: source,
      name: 'nested',
      access: 'read_write',
    });
    await writeStorageFileText({
      fileHandle: await nested.getFileHandle({
        name: 'baseline.txt',
        create: true,
      }),
      value: 'baseline',
    });
    const hizofs = requireHizoFSSession({ session });
    const descriptorWriteStarted = Promise.withResolvers<void>();
    const releaseDescriptorWrite = Promise.withResolvers<void>();
    const originalWrite = hizofs.runtime.subvolumeDescriptorStore.write.bind(
      hizofs.runtime.subvolumeDescriptorStore,
    );
    const descriptorWrite = vi.spyOn(
      hizofs.runtime.subvolumeDescriptorStore,
      'write',
    ).mockImplementationOnce(async input => {
      descriptorWriteStarted.resolve();
      await releaseDescriptorWrite.promise;
      return await originalWrite(input);
    });
    let laterWriteSettled = false;
    try {
      const snapshotPromise = snapshotHizoFSSubvolume({
        source,
        destination: session.root,
        name: 'snapshot',
        access: 'read',
      });
      await descriptorWriteStarted.promise;
      const laterWrite = (async () => {
        const fileHandle = await nested.getFileHandle({
          name: 'later.txt',
          create: true,
        });
        await writeStorageFileText({
          fileHandle,
          value: 'later-source-only',
        });
      })().finally(() => {
        laterWriteSettled = true;
      });
      await Promise.resolve();
      expect(laterWriteSettled).toBe(false);

      releaseDescriptorWrite.resolve();
      const snapshot = await snapshotPromise;
      await laterWrite;
      const snapshotNested = await snapshot.getDirectoryHandle({
        name: 'nested',
        create: false,
      });
      expect(await readStorageFileText({
        fileHandle: await snapshotNested.getFileHandle({
          name: 'baseline.txt',
          create: false,
        }),
      })).toBe('baseline');
      await expect(snapshotNested.getFileHandle({
        name: 'later.txt',
        create: false,
      })).rejects.toMatchObject({ name: 'NotFoundError' });
      expect(await readStorageFileText({
        fileHandle: await nested.getFileHandle({
          name: 'later.txt',
          create: false,
        }),
      })).toBe('later-source-only');
    } finally {
      releaseDescriptorWrite.resolve();
      descriptorWrite.mockRestore();
      await session.close();
    }
  });

  it('keeps a recursive snapshot invisible when its final parent publication fails', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    const sourceChild = await createHizoFSSubvolume({
      destination: session.root,
      name: 'workspace',
      access: 'read_write',
    });
    await writeStorageFileText({
      fileHandle: await sourceChild.getFileHandle({
        name: 'source.txt',
        create: true,
      }),
      value: 'source remains reachable',
    });
    const hizofs = requireHizoFSSession({ session });
    const failure = new Error('injected snapshot publication failure');
    vi.spyOn(hizofs.core.superblockStore, 'write').mockRejectedValueOnce(failure);

    await expect(snapshotHizoFSSubvolume({
      source: session.root,
      destination: session.root,
      name: 'must-not-appear',
      access: 'read_write',
    })).rejects.toBe(failure);
    await expect(session.root.getDirectoryHandle({
      name: 'must-not-appear',
      create: false,
    })).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(await readStorageFileText({
      fileHandle: await sourceChild.getFileHandle({
        name: 'source.txt',
        create: false,
      }),
    })).toBe('source remains reachable');
    await session.close();
  });

  it('rejects snapshots between distinct stores that use the same root key', async () => {
    const sourceSession = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'source-backing' }),
      now: () => 1,
    });
    const destinationSession = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'destination-backing' }),
      now: () => 1,
    });

    await expect(snapshotHizoFSSubvolume({
      source: sourceSession.root,
      destination: destinationSession.root,
      name: 'must-not-cross',
      access: 'read',
    })).rejects.toMatchObject({
      name: 'CrossDeviceError',
      code: 'EXDEV',
    });
    await expect(destinationSession.root.getDirectoryHandle({
      name: 'must-not-cross',
      create: false,
    })).rejects.toMatchObject({ name: 'NotFoundError' });
    await sourceSession.close();
    await destinationSession.close();
  });

  it('publishes one bounded metadata-only transaction for an empty read subvolume', async () => {
    const diagnostics = createHizoFSRuntimeDiagnostics();
    const session = await createHizoFSDiagnosticSession({
      backingDirectory: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      fileSystemRootKey: ROOT_KEY,
      policy: TINY_POLICY,
      diagnostics,
    });
    const hizofs = requireHizoFSSession({ session });
    const before = diagnostics.snapshot();

    await hizofs.createReadSubvolume({
      directoryNodeId: hizofs.rootDirectoryNodeId,
      name: 'archive',
    });

    const after = diagnostics.snapshot();
    expect(
      after.phases.commit_publication.operationCount
      - before.phases.commit_publication.operationCount,
    ).toBe(1);
    expect(
      after.records.subvolume_descriptor.writeOperations
      - before.records.subvolume_descriptor.writeOperations,
    ).toBe(1);
    expect(
      after.records.subvolume_mount_index_page.writeOperations
      - before.records.subvolume_mount_index_page.writeOperations,
    ).toBe(2);
    expect(
      after.records.commit.writeOperations
      - before.records.commit.writeOperations,
    ).toBe(2);
    expect(
      after.records.file_chunk.writeOperations
      - before.records.file_chunk.writeOperations,
    ).toBe(0);
    await session.close();
  });

  it('initializes two child heads before one bounded parent publication', async () => {
    const diagnostics = createHizoFSRuntimeDiagnostics();
    const session = await createHizoFSDiagnosticSession({
      backingDirectory: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      fileSystemRootKey: ROOT_KEY,
      policy: TINY_POLICY,
      diagnostics,
    });
    const before = diagnostics.snapshot();

    await createHizoFSSubvolume({
      destination: session.root,
      name: 'writable',
      access: 'read_write',
    });

    const after = diagnostics.snapshot();
    expect(
      after.phases.commit_publication.operationCount
      - before.phases.commit_publication.operationCount,
    ).toBe(1);
    expect(
      after.records.subvolume_descriptor.writeOperations
      - before.records.subvolume_descriptor.writeOperations,
    ).toBe(1);
    expect(
      after.records.subvolume_mount_index_page.writeOperations
      - before.records.subvolume_mount_index_page.writeOperations,
    ).toBe(2);
    expect(
      after.records.commit.writeOperations
      - before.records.commit.writeOperations,
    ).toBe(2);
    expect(
      after.records.superblock.writeOperations
      - before.records.superblock.writeOperations,
    ).toBe(3);
    expect(
      after.records.file_chunk.writeOperations
      - before.records.file_chunk.writeOperations,
    ).toBe(0);
    await session.close();
  });

  it('moves a read subvolume entry with one matching mount-location update', async () => {
    const diagnostics = createHizoFSRuntimeDiagnostics();
    const session = await createHizoFSDiagnosticSession({
      backingDirectory: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      fileSystemRootKey: ROOT_KEY,
      policy: TINY_POLICY,
      diagnostics,
    });
    const hizofs = requireHizoFSSession({ session });
    const child = await hizofs.createReadSubvolume({
      directoryNodeId: hizofs.rootDirectoryNodeId,
      name: 'before',
    });
    const before = diagnostics.snapshot();

    await session.root.moveEntry({
      name: 'before',
      destination: session.root,
      newName: 'after',
      replace: false,
    });

    const after = diagnostics.snapshot();
    expect(after.records.subvolume_mount_index_page.writeOperations)
      .toBe(before.records.subvolume_mount_index_page.writeOperations + 1);
    await expect(session.root.getDirectoryHandle({
      name: 'before',
      create: false,
    })).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(session.root.getDirectoryHandle({
      name: 'after',
      create: false,
    })).resolves.toMatchObject({ kind: 'directory', name: 'after' });
    await deleteHizoFSSubvolume({
      subvolume: child,
      recursiveSubvolumes: false,
    });
    await expect(session.root.getDirectoryHandle({
      name: 'after',
      create: false,
    })).rejects.toMatchObject({ name: 'NotFoundError' });
    await session.close();
  });

  it('deletes a leaf subvolume with one topology publication and no file walk', async () => {
    const diagnostics = createHizoFSRuntimeDiagnostics();
    const session = await createHizoFSDiagnosticSession({
      backingDirectory: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      fileSystemRootKey: ROOT_KEY,
      policy: TINY_POLICY,
      diagnostics,
    });
    const child = await createHizoFSSubvolume({
      destination: session.root,
      name: 'child',
      access: 'read_write',
    });
    const file = await child.getFileHandle({ name: 'value.txt', create: true });
    await writeStorageFileText({ fileHandle: file, value: 'retained-by-open-handle' });
    const before = diagnostics.snapshot();

    await deleteHizoFSSubvolume({
      subvolume: child,
      recursiveSubvolumes: false,
    });

    const after = diagnostics.snapshot();
    expect(after.phases.commit_publication.operationCount)
      .toBe(before.phases.commit_publication.operationCount + 1);
    expect(after.records.file_chunk.readOperations)
      .toBe(before.records.file_chunk.readOperations);
    expect(after.records.file_chunk.writeOperations)
      .toBe(before.records.file_chunk.writeOperations);
    await expect(session.root.getDirectoryHandle({
      name: 'child',
      create: false,
    })).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(readStorageFileText({ fileHandle: file }))
      .resolves.toBe('retained-by-open-handle');
    await session.close();
  });

  it('keeps a subvolume mounted when the delete publication fails', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    const hizofs = requireHizoFSSession({ session });
    const child = await createHizoFSSubvolume({
      destination: session.root,
      name: 'child',
      access: 'read_write',
    });
    const file = await child.getFileHandle({ name: 'value.txt', create: true });
    await writeStorageFileText({ fileHandle: file, value: 'still-mounted' });
    const failure = new Error('injected subvolume delete publication failure');
    vi.spyOn(hizofs.core.superblockStore, 'write').mockRejectedValueOnce(failure);

    await expect(deleteHizoFSSubvolume({
      subvolume: child,
      recursiveSubvolumes: false,
    })).rejects.toBe(failure);
    const reopened = await session.root.getDirectoryHandle({
      name: 'child',
      create: false,
    });
    expect(await readStorageFileText({
      fileHandle: await reopened.getFileHandle({
        name: 'value.txt',
        create: false,
      }),
    })).toBe('still-mounted');
    await session.close();
  });

  it('requires recursive deletion for a subvolume with nested subvolumes', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    const parent = await createHizoFSSubvolume({
      destination: session.root,
      name: 'parent',
      access: 'read_write',
    });
    await createHizoFSSubvolume({
      destination: parent,
      name: 'nested',
      access: 'read',
    });

    await expect(deleteHizoFSSubvolume({
      subvolume: parent,
      recursiveSubvolumes: false,
    })).rejects.toMatchObject({ name: 'InvalidModificationError' });
    await expect(session.root.getDirectoryHandle({
      name: 'parent',
      create: false,
    })).resolves.toMatchObject({ kind: 'directory' });

    await deleteHizoFSSubvolume({
      subvolume: parent,
      recursiveSubvolumes: true,
    });
    await expect(session.root.getDirectoryHandle({
      name: 'parent',
      create: false,
    })).rejects.toMatchObject({ name: 'NotFoundError' });
    await session.close();
  });

  it('uses the parent access when deleting a nested subvolume entry', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    const source = await createHizoFSSubvolume({
      destination: session.root,
      name: 'source',
      access: 'read_write',
    });
    await createHizoFSSubvolume({
      destination: source,
      name: 'nested',
      access: 'read_write',
    });
    const snapshot = await snapshotHizoFSSubvolume({
      source,
      destination: session.root,
      name: 'readonly-tree',
      access: 'read',
    });
    const snapshotNested = await snapshot.getDirectoryHandle({
      name: 'nested',
      create: false,
    });

    await expect(deleteHizoFSSubvolume({
      subvolume: snapshotNested,
      recursiveSubvolumes: false,
    })).rejects.toMatchObject({ name: 'NoModificationAllowedError' });
    await deleteHizoFSSubvolume({
      subvolume: snapshot,
      recursiveSubvolumes: true,
    });
    await expect(session.root.getDirectoryHandle({
      name: 'readonly-tree',
      create: false,
    })).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(session.root.getDirectoryHandle({
      name: 'source',
      create: false,
    })).resolves.toBeDefined();
    await session.close();
  });

  it('rejects deleting the root subvolume', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    await expect(deleteHizoFSSubvolume({
      subvolume: session.root,
      recursiveSubvolumes: true,
    })).rejects.toMatchObject({ name: 'InvalidModificationError' });
    await session.close();
  });

  it('rejects atomic moves across a subvolume boundary as EXDEV', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    const hizofs = requireHizoFSSession({ session });
    const child = await hizofs.createReadSubvolume({
      directoryNodeId: hizofs.rootDirectoryNodeId,
      name: 'archive',
    });
    await session.root.getFileHandle({ name: 'value.txt', create: true });

    await expect(session.root.moveEntry({
      name: 'value.txt',
      destination: child,
      newName: 'value.txt',
      replace: false,
    })).rejects.toMatchObject({
      name: 'CrossDeviceError',
      code: 'EXDEV',
    });
    await expect(session.root.getFileHandle({
      name: 'value.txt',
      create: false,
    })).resolves.toBeDefined();
    await session.close();
  });

  it('rejects moving a subvolume entry into another subvolume as EXDEV', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    await createHizoFSSubvolume({
      destination: session.root,
      name: 'archive',
      access: 'read',
    });
    const destination = await createHizoFSSubvolume({
      destination: session.root,
      name: 'workspace',
      access: 'read_write',
    });

    await expect(session.root.moveEntry({
      name: 'archive',
      destination,
      newName: 'archive',
      replace: false,
    })).rejects.toMatchObject({
      name: 'CrossDeviceError',
      code: 'EXDEV',
    });
    await expect(session.root.getDirectoryHandle({
      name: 'archive',
      create: false,
    })).resolves.toBeDefined();
    await expect(destination.getDirectoryHandle({
      name: 'archive',
      create: false,
    })).rejects.toMatchObject({ name: 'NotFoundError' });
    await session.close();
  });

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
      'head-0.hfs',
      'head-1.hfs',
      'segments',
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

  it('publishes bulk-created empty files and directories in one commit', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    const before = await inspectHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    const builder = await createHizoFSBulkBuilder({ fileSystemSession: session });
    if (builder === undefined) {
      throw new Error('Expected a HizoFS bulk builder');
    }

    await builder.createEmptyFile({ name: 'empty.txt' });
    await builder.createEmptyDirectory({ name: 'empty-directory' });
    await builder.commit();

    const after = await inspectHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    expect(after.superblock.sequence).toBe(before.superblock.sequence + 1);
    expect(await (await session.root.getFileHandle({
      name: 'empty.txt',
      create: false,
    })).stat()).toMatchObject({ size: 0 });
    await expect(session.root.getDirectoryHandle({
      name: 'empty-directory',
      create: false,
    })).resolves.toBeDefined();
    await session.close();
  });

  it('bounds bulk inode-object writes before one-commit publication', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ root: backing, now: () => 1 });
    const builder = await createHizoFSBulkBuilder({ fileSystemSession: session });
    if (builder === undefined) {
      throw new Error('Expected a HizoFS bulk builder');
    }
    const hizofs = requireHizoFSSession({ session });
    const originalWrite = hizofs.runtime.inodeStore.writeFile
      .bind(hizofs.runtime.inodeStore);
    const releaseWrites = Promise.withResolvers<void>();
    const firstWaveStarted = Promise.withResolvers<void>();
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    let startedWrites = 0;
    vi.spyOn(hizofs.runtime.inodeStore, 'writeFile').mockImplementation(
      async arguments_ => {
        activeWrites += 1;
        startedWrites += 1;
        maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
        if (startedWrites === TINY_POLICY.fileChunkWriteConcurrency) {
          firstWaveStarted.resolve();
        }
        try {
          await releaseWrites.promise;
          return await originalWrite(arguments_);
        } finally {
          activeWrites -= 1;
        }
      },
    );

    await builder.createEmptyFile({ name: 'first.txt' });
    await builder.createEmptyFile({ name: 'second.txt' });
    await firstWaveStarted.promise;
    let thirdScheduled = false;
    const third = builder.createEmptyFile({ name: 'third.txt' }).finally(() => {
      thirdScheduled = true;
    });
    await Promise.resolve();

    expect(thirdScheduled).toBe(false);
    expect(maximumActiveWrites).toBe(TINY_POLICY.fileChunkWriteConcurrency);
    releaseWrites.resolve();
    await third;
    await builder.commit();

    expect(maximumActiveWrites).toBe(TINY_POLICY.fileChunkWriteConcurrency);
    expect(startedWrites).toBe(3);
    await expect(session.root.getFileHandle({
      name: 'third.txt',
      create: false,
    })).resolves.toBeDefined();
    await session.close();
  });

  it('waits for scheduled bulk object writes before abort releases its lease', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ root: backing, now: () => 1 });
    const builder = await createHizoFSBulkBuilder({ fileSystemSession: session });
    if (builder === undefined) {
      throw new Error('Expected a HizoFS bulk builder');
    }
    const hizofs = requireHizoFSSession({ session });
    const originalWrite = hizofs.runtime.inodeStore.writeFile
      .bind(hizofs.runtime.inodeStore);
    const writeStarted = Promise.withResolvers<void>();
    const releaseWrite = Promise.withResolvers<void>();
    vi.spyOn(hizofs.runtime.inodeStore, 'writeFile').mockImplementation(
      async arguments_ => {
        writeStarted.resolve();
        await releaseWrite.promise;
        return await originalWrite(arguments_);
      },
    );

    await builder.createEmptyFile({ name: 'orphan.txt' });
    await writeStarted.promise;
    let abortSettled = false;
    const abort = builder.abort({ reason: new Error('cancelled') }).finally(() => {
      abortSettled = true;
    });
    await Promise.resolve();
    expect(abortSettled).toBe(false);

    releaseWrite.resolve();
    await abort;
    expect(abortSettled).toBe(true);
    await session.close();
  });

  it('never publishes after a bounded bulk object write fails', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ root: backing, now: () => 1 });
    const builder = await createHizoFSBulkBuilder({ fileSystemSession: session });
    if (builder === undefined) {
      throw new Error('Expected a HizoFS bulk builder');
    }
    const hizofs = requireHizoFSSession({ session });
    const originalWrite = hizofs.runtime.inodeStore.writeFile
      .bind(hizofs.runtime.inodeStore);
    const firstWriteStarted = Promise.withResolvers<void>();
    const secondWriteStarted = Promise.withResolvers<void>();
    const failFirstWrite = Promise.withResolvers<void>();
    const releaseSecondWrite = Promise.withResolvers<void>();
    const failure = new Error('simulated bulk object-write failure');
    let writeCount = 0;
    vi.spyOn(hizofs.runtime.inodeStore, 'writeFile').mockImplementation(
      async arguments_ => {
        writeCount += 1;
        switch (writeCount) {
        case 1:
          firstWriteStarted.resolve();
          await failFirstWrite.promise;
          throw failure;
        case 2:
          secondWriteStarted.resolve();
          await releaseSecondWrite.promise;
          return await originalWrite(arguments_);
        default:
          return await originalWrite(arguments_);
        }
      },
    );

    await builder.createEmptyFile({ name: 'first.txt' });
    await builder.createEmptyFile({ name: 'second.txt' });
    await Promise.all([firstWriteStarted.promise, secondWriteStarted.promise]);
    const third = builder.createEmptyFile({ name: 'third.txt' });
    failFirstWrite.resolve();
    await expect(third).rejects.toBe(failure);

    releaseSecondWrite.resolve();
    await expect(builder.commit()).rejects.toThrow('HizoFS bulk object write failed');
    const state = await hizofs.runtime.core.loadActiveState();
    expect(state.commit.revision).toBe(0);
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
    const originalInstanceId = requireHizoFSSession({ session: created }).instanceId;
    const staleWorkerSource = created.root.createWorkerMountSource?.();
    if (staleWorkerSource === undefined) {
      throw new Error('Expected a HizoFS Worker mount source');
    }
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
    expect(requireHizoFSSession({ session: reopened }).instanceId)
      .toBe(originalInstanceId);
    expect(staleWorkerSource.instanceId).toBe(originalInstanceId);
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
    const originalInstanceId = requireHizoFSSession({ session: created }).instanceId;
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
    expect(JSON.parse(await (await descriptorHandle.getFile()).text())).toMatchObject({
      format: 'hizofs',
      formatVersion: 1,
      instanceId: originalInstanceId,
    });
    await reopened.close();
  });

  it('rejects a canonical descriptor instance identity that does not match the authenticated root', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const created = await createHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    await created.close();

    const descriptorFile = await backing.getFileHandle('descriptor.json');
    const descriptor = JSON.parse(
      await (await descriptorFile.getFile()).text(),
    ) as Record<string, unknown>;
    const writable = await descriptorFile.createWritable({
      keepExistingData: false,
    });
    await writable.write(JSON.stringify({
      ...descriptor,
      instanceId: 'AQEBAQEBAQEBAQEBAQEBAQ',
    }));
    await writable.close();

    await expect(openHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    })).rejects.toThrow(
      'instanceId does not match the authenticated root subvolume identity',
    );
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

  it('reopens a read subvolume as an immutable Worker-local session', async () => {
    const originalLocks = navigator.locks;
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: createQueuedTestLockManager({ onRequest: undefined }),
    });
    try {
      const ownerSession = await createHizoFS({
        backingDirectory: new MockFileSystemDirectoryHandle({ name: 'backing' }),
        fileSystemRootKey: ROOT_KEY,
      });
      const hizofs = requireHizoFSSession({ session: ownerSession });
      const child = await hizofs.createReadSubvolume({
        directoryNodeId: hizofs.rootDirectoryNodeId,
        name: 'archive',
      });
      const source = child.createWorkerMountSource?.();
      if (source === undefined) {
        throw new Error('HizoFS subvolume did not expose a Worker mount source');
      }

      const workerSession = await openHizoFSWorkerMount({ source });
      await expect(getHizoFSSubvolumeInfo({
        handle: workerSession.root,
      })).resolves.toMatchObject({
        access: 'read',
        stateSelection: 'current',
        root: false,
      });
      await expect(workerSession.root.getFileHandle({
        name: 'forbidden.txt',
        create: true,
      })).rejects.toMatchObject({ name: 'NoModificationAllowedError' });
      const entries: string[] = [];
      for await (const [name] of workerSession.root.entries()) {
        entries.push(name);
      }
      expect(entries).toEqual([]);

      await workerSession.close();
      await ownerSession.close();
    } finally {
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: originalLocks,
      });
    }
  });

  it('reopens a read_write subvolume with its scoped Worker coordinator', async () => {
    const originalLocks = navigator.locks;
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: createQueuedTestLockManager({ onRequest: undefined }),
    });
    try {
      const ownerSession = await createHizoFS({
        backingDirectory: new MockFileSystemDirectoryHandle({ name: 'backing' }),
        fileSystemRootKey: ROOT_KEY,
      });
      const child = await createHizoFSSubvolume({
        destination: ownerSession.root,
        name: 'workspace',
        access: 'read_write',
      });
      const source = child.createWorkerMountSource?.();
      if (source === undefined) {
        throw new Error('HizoFS subvolume did not expose a Worker mount source');
      }

      const workerSession = await openHizoFSWorkerMount({ source });
      await expect(getHizoFSSubvolumeInfo({
        handle: workerSession.root,
      })).resolves.toMatchObject({
        access: 'read_write',
        stateSelection: 'current',
        root: false,
      });
      await writeStorageFileText({
        fileHandle: await workerSession.root.getFileHandle({
          name: 'worker.txt',
          create: true,
        }),
        value: 'scoped child publication',
      });
      expect(await readStorageFileText({
        fileHandle: await child.getFileHandle({
          name: 'worker.txt',
          create: false,
        }),
      })).toBe('scoped child publication');

      await workerSession.close();
      await ownerSession.close();
    } finally {
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: originalLocks,
      });
    }
  });

  it('rejects a stale Worker mount source after its subvolume is deleted', async () => {
    const originalLocks = navigator.locks;
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: createQueuedTestLockManager({ onRequest: undefined }),
    });
    try {
      const ownerSession = await createHizoFS({
        backingDirectory: new MockFileSystemDirectoryHandle({ name: 'backing' }),
        fileSystemRootKey: ROOT_KEY,
      });
      const child = await createHizoFSSubvolume({
        destination: ownerSession.root,
        name: 'workspace',
        access: 'read_write',
      });
      const source = child.createWorkerMountSource?.();
      if (source === undefined) {
        throw new Error('HizoFS subvolume did not expose a Worker mount source');
      }

      await deleteHizoFSSubvolume({
        subvolume: child,
        recursiveSubvolumes: false,
      });
      await expect(openHizoFSWorkerMount({ source })).rejects.toMatchObject({
        name: 'NotFoundError',
      });
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

  it('isolates distinct backing instances that use the same root key', async () => {
    const originalLocks = navigator.locks;
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: createQueuedTestLockManager({ onRequest: undefined }),
    });
    const firstBacking = new MockFileSystemDirectoryHandle({ name: 'first-backing' });
    const secondBacking = new MockFileSystemDirectoryHandle({ name: 'second-backing' });
    let first: StorageFileSystemSession | undefined;
    let second: StorageFileSystemSession | undefined;
    try {
      first = await createTiny({ root: firstBacking, now: () => 1 });
      second = await createTiny({ root: secondBacking, now: () => 2 });
      const firstSession = requireHizoFSSession({ session: first });
      const secondSession = requireHizoFSSession({ session: second });
      expect(firstSession.fileSystemId).toBe(secondSession.fileSystemId);
      expect(firstSession.instanceId).not.toBe(secondSession.instanceId);

      await Promise.all([
        writeStorageFileText({
          fileHandle: await first.root.getFileHandle({
            name: 'first.txt',
            create: true,
          }),
          value: 'first backing',
        }),
        writeStorageFileText({
          fileHandle: await second.root.getFileHandle({
            name: 'second.txt',
            create: true,
          }),
          value: 'second backing',
        }),
      ]);

      await expect(first.root.getFileHandle({
        name: 'second.txt',
        create: false,
      })).rejects.toMatchObject({ name: 'NotFoundError' });
      await expect(second.root.getFileHandle({
        name: 'first.txt',
        create: false,
      })).rejects.toMatchObject({ name: 'NotFoundError' });
      await expect(readStorageFileText({
        fileHandle: await first.root.getFileHandle({
          name: 'first.txt',
          create: false,
        }),
      })).resolves.toBe('first backing');
      await expect(readStorageFileText({
        fileHandle: await second.root.getFileHandle({
          name: 'second.txt',
          create: false,
        }),
      })).resolves.toBe('second backing');
    } finally {
      await Promise.allSettled([first?.close(), second?.close()]);
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: originalLocks,
      });
    }
  });

  it('rejects mounting the root descriptor as a nested subvolume', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    try {
      const hizofs = requireHizoFSSession({ session });
      const state = await hizofs.loadFilesystemState();
      await publishRootSubvolumeAlias({
        session,
        name: 'root-alias',
        subvolumeDescriptorObjectId: state.subvolumeDescriptorObjectId,
      });

      await expect(session.root.getDirectoryHandle({
        name: 'root-alias',
        create: false,
      })).rejects.toThrow('descriptor is mounted from multiple locations');
    } finally {
      await session.close();
    }
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
        sweepPolicy: undefined,
        signal: undefined,
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
      const lockName = `hizofs/${hizofs.instanceId}/maintenance`;
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

  it('reuses a directory inode on one handle and invalidates it after another session publishes', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const first = await createTiny({ root: backing, now: () => 1 });
    const directory = await first.root.getDirectoryHandle({
      name: 'values',
      create: true,
    });
    await directory.getFileHandle({ name: 'first.txt', create: true });
    const firstHizoFS = requireHizoFSSession({ session: first });
    const readDirectory = vi.spyOn(
      firstHizoFS.runtime.nodeService,
      'readDirectory',
    );

    await directory.getFileHandle({ name: 'first.txt', create: false });
    await directory.getFileHandle({ name: 'first.txt', create: false });
    expect(readDirectory).not.toHaveBeenCalled();

    const second = await openTiny({ root: backing, now: () => 2 });
    const secondDirectory = await second.root.getDirectoryHandle({
      name: 'values',
      create: false,
    });
    await secondDirectory.getFileHandle({ name: 'second.txt', create: true });

    await expect(directory.getFileHandle({
      name: 'second.txt',
      create: false,
    })).resolves.toBeDefined();
    expect(readDirectory).toHaveBeenCalledTimes(1);

    await first.close();
    await second.close();
  });

  it('carries the published directory inode across sequential creates', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    const directory = await session.root.getDirectoryHandle({
      name: 'values',
      create: true,
    });
    const hizofs = requireHizoFSSession({ session });
    const readDirectory = vi.spyOn(
      hizofs.runtime.nodeService,
      'readDirectory',
    );

    for (let index = 0; index < 8; index += 1) {
      await directory.getFileHandle({
        name: `value-${String(index)}.txt`,
        create: true,
      });
    }

    expect(readDirectory).not.toHaveBeenCalled();
    await session.close();
  });

  it('reuses validation of an unchanged root inode and revalidates a changed root', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    const directory = await session.root.getDirectoryHandle({
      name: 'values',
      create: true,
    });
    const hizofs = requireHizoFSSession({ session });
    const readDirectory = vi.spyOn(hizofs.runtime.inodeStore, 'readDirectory');

    for (let index = 0; index < 8; index += 1) {
      await directory.getFileHandle({
        name: `nested-${String(index)}.txt`,
        create: true,
      });
    }
    expect(readDirectory).not.toHaveBeenCalled();

    await session.root.getFileHandle({ name: 'root.txt', create: true });
    expect(readDirectory).toHaveBeenCalledTimes(2);
    await session.close();
  });

  it('preserves every entry across concurrent creates in one indexed directory', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    const directory = await session.root.getDirectoryHandle({
      name: 'values',
      create: true,
    });
    for (let index = 0; index < 4; index += 1) {
      await directory.getFileHandle({
        name: `seed-${String(index)}.txt`,
        create: true,
      });
    }

    const concurrentNames = Array.from(
      { length: 12 },
      (_, index) => `parallel-${String(index).padStart(2, '0')}.txt`,
    );
    await Promise.all(concurrentNames.map(async (name) => {
      await directory.getFileHandle({ name, create: true });
    }));

    const names: string[] = [];
    for await (const [name] of directory.entries()) names.push(name);
    expect(names.sort()).toEqual([
      ...Array.from({ length: 4 }, (_, index) => `seed-${String(index)}.txt`),
      ...concurrentNames,
    ].sort());
    await session.close();
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
    const setSpy = vi.spyOn(
      hizofs.runtime.directoryIndex,
      'setWithRightmostPathCache',
    );
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

  it('reuses the coordinator-owned A/B head handles across publications', async () => {
    const headOpens: string[] = [];
    const originalOpen = NativeOpfsHizoFSBackingStore.prototype.openRandomAccessFile;
    const openSpy = vi.spyOn(
      NativeOpfsHizoFSBackingStore.prototype,
      'openRandomAccessFile',
    ).mockImplementation(function (
      this: NativeOpfsHizoFSBackingStore,
      arguments_,
    ) {
      const name = arguments_.path.at(-1);
      if (name === 'head-0.hfs' || name === 'head-1.hfs') {
        headOpens.push(name);
      }
      return originalOpen.call(this, arguments_);
    });
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ root: backing, now: () => 1 });
    const initialHeadOpenCount = headOpens.length;
    try {
      for (let index = 0; index < 12; index += 1) {
        await session.root.getFileHandle({
          name: `persistent-head-${String(index)}`,
          create: true,
        });
      }
      expect(headOpens.length - initialHeadOpenCount).toBe(2);
    } finally {
      await session.close();
      openSpy.mockRestore();
    }
  });

  it('serves repeated lookups from the authoritative active-state cache', async () => {
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

    expect(backingReadSpy).not.toHaveBeenCalled();
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

  it('overlaps independent child inode and parent directory preparation', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ root: backing, now: () => 1 });
    const hizofs = requireHizoFSSession({ session });
    const originalWriteFile = hizofs.runtime.inodeStore.writeFile.bind(
      hizofs.runtime.inodeStore,
    );
    const originalWriteDirectory =
      hizofs.runtime.directoryStorage.writeChangedInode.bind(
        hizofs.runtime.directoryStorage,
      );
    const releaseWrites = Promise.withResolvers<void>();
    const bothWritesStarted = Promise.withResolvers<void>();
    let startedWrites = 0;
    const markStarted = (): void => {
      startedWrites += 1;
      if (startedWrites === 2) bothWritesStarted.resolve();
    };
    vi.spyOn(hizofs.runtime.inodeStore, 'writeFile').mockImplementation(
      async (arguments_) => {
        markStarted();
        await releaseWrites.promise;
        return originalWriteFile(arguments_);
      },
    );
    vi.spyOn(
      hizofs.runtime.directoryStorage,
      'writeChangedInode',
    ).mockImplementation(async (arguments_) => {
      markStarted();
      await releaseWrites.promise;
      return originalWriteDirectory(arguments_);
    });

    const createPromise = session.root.getFileHandle({
      name: 'parallel-create.bin',
      create: true,
    });
    const startedInParallel = await Promise.race([
      bothWritesStarted.promise.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 1000)),
    ]);
    releaseWrites.resolve();

    expect(startedInParallel).toBe(true);
    await expect(createPromise).resolves.toBeDefined();
    await session.close();
  });

  it('waits for both independent create writes to settle before reporting failure', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ root: backing, now: () => 1 });
    const hizofs = requireHizoFSSession({ session });
    const originalWriteDirectory =
      hizofs.runtime.directoryStorage.writeChangedInode.bind(
        hizofs.runtime.directoryStorage,
      );
    const directoryWriteStarted = Promise.withResolvers<void>();
    const releaseDirectoryWrite = Promise.withResolvers<void>();
    vi.spyOn(hizofs.runtime.inodeStore, 'writeFile').mockRejectedValue(
      new Error('injected child inode failure'),
    );
    vi.spyOn(
      hizofs.runtime.directoryStorage,
      'writeChangedInode',
    ).mockImplementation(async (arguments_) => {
      directoryWriteStarted.resolve();
      await releaseDirectoryWrite.promise;
      return originalWriteDirectory(arguments_);
    });

    let createSettled = false;
    const createPromise = session.root.getFileHandle({
      name: 'failed-parallel-create.bin',
      create: true,
    });
    void createPromise.then(
      () => {
        createSettled = true;
      },
      () => {
        createSettled = true;
      },
    );
    await directoryWriteStarted.promise;
    await Promise.resolve();
    expect(createSettled).toBe(false);

    releaseDirectoryWrite.resolve();
    await expect(createPromise).rejects.toThrow('injected child inode failure');
    await expect(session.root.getFileHandle({
      name: 'failed-parallel-create.bin',
      create: false,
    })).rejects.toMatchObject({ name: 'NotFoundError' });
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

  it('writes one immutable chunk per default 256 KiB without timing assertions', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const diagnostics = createHizoFSRuntimeDiagnostics();
    const session = await TEST_ONLY.createHizoFSInternal({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      policy: DEFAULT_HIZOFS_POLICY,
      now: () => 1,
      diagnostics,
    });
    const file = await session.root.getFileHandle({
      name: 'default-chunk-shape.bin',
      create: true,
    });
    const hizofs = requireHizoFSSession({ session });
    const writeSpy = vi.spyOn(hizofs.runtime.chunkStore, 'write');
    const writeManyPipelinedSpy = vi.spyOn(
      hizofs.runtime.chunkStore,
      'writeManyPipelined',
    );
    const writer = await file.createWritable({ keepExistingData: false });

    await writer.write({
      position: 0,
      data: new Uint8Array(4 * 1024 * 1024).fill(7),
    });
    await writer.close();

    expect(writeSpy).not.toHaveBeenCalled();
    expect(writeManyPipelinedSpy).toHaveBeenCalledTimes(1);
    expect(writeManyPipelinedSpy).toHaveBeenCalledWith(expect.objectContaining({
      payloads: expect.any(Array),
      maximumPlaintextRecordsInFlight: 2,
    }));
    expect(writeManyPipelinedSpy.mock.calls[0]?.[0].payloads).toHaveLength(16);
    expect(diagnostics.snapshot().resources.writerPendingChunkWrites)
      .toMatchObject({
        maximumBytes: 512 * 1024,
        maximumOperations: 2,
      });
    await session.close();
  });

  it('bounds empty-file index write amplification without timing assertions', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const diagnostics = createHizoFSRuntimeDiagnostics();
    const session = await TEST_ONLY.createHizoFSInternal({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      policy: DEFAULT_HIZOFS_POLICY,
      now: () => 1,
      diagnostics,
    });
    const before = diagnostics.snapshot();

    for (let index = 0; index < 64; index += 1) {
      await session.root.getFileHandle({
        name: `empty-${String(index).padStart(2, '0')}`,
        create: true,
      });
    }

    const after = diagnostics.snapshot();
    expect(
      after.records.commit.writeOperations
        - before.records.commit.writeOperations,
    ).toBe(64);
    expect(
      after.records.superblock.writeOperations
        - before.records.superblock.writeOperations,
    ).toBe(64);
    expect(
      after.records.inode_index_page.writeOperations
        - before.records.inode_index_page.writeOperations,
    ).toBeLessThanOrEqual(192);
    expect(
      after.records.directory_index_page.writeOperations
        - before.records.directory_index_page.writeOperations,
    ).toBeLessThanOrEqual(96);
    expect(
      after.phases.object_encrypt.operationCount
        - before.phases.object_encrypt.operationCount,
    ).toBeLessThanOrEqual(450);
    await session.close();
  });

  it('batches close-time chunk persistence within the configured plaintext bound', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const diagnostics = createHizoFSRuntimeDiagnostics();
    const policy: HizoFSPolicy = {
      ...TINY_POLICY,
      fileChunkWriteConcurrency: 2,
    };
    const session = await TEST_ONLY.createHizoFSInternal({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      policy,
      now: () => 1,
      diagnostics,
    });
    const file = await session.root.getFileHandle({
      name: 'concurrent-chunks.bin',
      create: true,
    });
    const hizofs = requireHizoFSSession({ session });
    const originalWriteManyPipelined = hizofs.runtime.chunkStore.writeManyPipelined
      .bind(hizofs.runtime.chunkStore);
    const pipelineRequests: {
      readonly payloadCount: number;
      readonly maximumPlaintextRecordsInFlight: number;
    }[] = [];
    vi.spyOn(hizofs.runtime.chunkStore, 'writeManyPipelined')
      .mockImplementation(async (arguments_) => {
        pipelineRequests.push({
          payloadCount: arguments_.payloads.length,
          maximumPlaintextRecordsInFlight:
            arguments_.maximumPlaintextRecordsInFlight,
        });
        return originalWriteManyPipelined(arguments_);
      });

    const writer = await file.createWritable({ keepExistingData: false });
    const expected = new Uint8Array(16).map((_, index) => index + 1);
    await writer.write({ position: 0, data: expected });
    await writer.close();

    expect(pipelineRequests).toEqual([{
      payloadCount: 4,
      maximumPlaintextRecordsInFlight: 2,
    }]);
    expect(diagnostics.snapshot().resources.writerPendingChunkWrites)
      .toMatchObject({ maximumBytes: 8, maximumOperations: 2 });
    expect(await readBytes({ session, path: ['concurrent-chunks.bin'] })).toEqual(expected);
    await session.close();
  });


  it('pipelines byte-budget overflow writes and waits for them before abort settles', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const diagnostics = createHizoFSRuntimeDiagnostics();
    const policy: HizoFSPolicy = {
      ...TINY_POLICY,
      maxDirtyFileBytes: 8,
      fileChunkWriteConcurrency: 2,
    };
    const session = await TEST_ONLY.createHizoFSInternal({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      policy,
      now: () => 1,
      diagnostics,
    });
    const file = await session.root.getFileHandle({
      name: 'overflow-pipeline.bin',
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
    await writer.write({
      position: 0,
      data: new Uint8Array(16).map((_, index) => index + 1),
    });
    await firstWaveStarted.promise;

    expect(maximumActiveWrites).toBe(2);
    expect(startedWrites).toBe(2);
    expect(diagnostics.snapshot().resources.writerPendingChunkWrites).toMatchObject({
      currentBytes: 8,
      maximumBytes: 8,
      currentOperations: 2,
      maximumOperations: 2,
    });
    expect(diagnostics.snapshot().resources.writerDirtyChunks).toMatchObject({
      currentBytes: 8,
      maximumBytes: 8,
      currentOperations: 2,
      maximumOperations: 2,
    });

    let abortSettled = false;
    const abortPromise = writer.abort({ reason: new Error('test complete') }).finally(() => {
      abortSettled = true;
    });
    await Promise.resolve();
    expect(abortSettled).toBe(false);

    releaseWrites.resolve();
    await abortPromise;
    expect(diagnostics.snapshot().resources).toMatchObject({
      writerDirtyChunks: {
        currentBytes: 0,
        currentOperations: 0,
      },
      writerPendingChunkWrites: {
        currentBytes: 0,
        currentOperations: 0,
      },
    });
    await session.close();
  });

  it('prepares immutable file data outside the publication mutation lock', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ root: backing, now: () => 1 });
    const slowFile = await session.root.getFileHandle({
      name: 'slow-large.bin',
      create: true,
    });
    const independentFile = await session.root.getFileHandle({
      name: 'independent-inline.bin',
      create: true,
    });
    const hizofs = requireHizoFSSession({ session });
    const originalWriteManyPipelined = hizofs.runtime.chunkStore.writeManyPipelined
      .bind(hizofs.runtime.chunkStore);
    const chunkWriteStarted = Promise.withResolvers<void>();
    const releaseChunkWrites = Promise.withResolvers<void>();
    vi.spyOn(hizofs.runtime.chunkStore, 'writeManyPipelined')
      .mockImplementation(async (arguments_) => {
        chunkWriteStarted.resolve();
        await releaseChunkWrites.promise;
        return originalWriteManyPipelined(arguments_);
      });

    const slowWriter = await slowFile.createWritable({ keepExistingData: false });
    await slowWriter.write({
      position: 0,
      data: new Uint8Array(16).fill(1),
    });
    const slowClose = slowWriter.close();
    await chunkWriteStarted.promise;

    const independentWriter = await independentFile.createWritable({
      keepExistingData: false,
    });
    await independentWriter.write({
      position: 0,
      data: new Uint8Array([7]),
    });
    await independentWriter.close();
    expect(await readBytes({
      session,
      path: ['independent-inline.bin'],
    })).toEqual(new Uint8Array([7]));

    releaseChunkWrites.resolve();
    await slowClose;
    await session.close();
  });

  it('bounds sequential chunk-read prefetch and overlaps the next read window', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const diagnostics = createHizoFSRuntimeDiagnostics();
    const policy: HizoFSPolicy = {
      ...TINY_POLICY,
      fileChunkReadPrefetchConcurrency: 3,
    };
    const session = await TEST_ONLY.createHizoFSInternal({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      policy,
      now: () => 1,
      diagnostics,
    });
    const file = await session.root.getFileHandle({
      name: 'prefetched-read.bin',
      create: true,
    });
    const expected = new Uint8Array(16).map((_, index) => index + 1);
    const writer = await file.createWritable({ keepExistingData: false });
    await writer.write({ position: 0, data: expected });
    await writer.close();

    const hizofs = requireHizoFSSession({ session });
    const originalRead = hizofs.runtime.chunkStore.read.bind(hizofs.runtime.chunkStore);
    const releaseReads = Promise.withResolvers<void>();
    const prefetchWindowStarted = Promise.withResolvers<void>();
    let blocking = false;
    let activeReads = 0;
    let maximumActiveReads = 0;
    let blockedReadCount = 0;
    vi.spyOn(hizofs.runtime.chunkStore, 'read').mockImplementation(async (arguments_) => {
      if (!blocking) return originalRead(arguments_);
      activeReads += 1;
      blockedReadCount += 1;
      maximumActiveReads = Math.max(maximumActiveReads, activeReads);
      if (blockedReadCount === 3) prefetchWindowStarted.resolve();
      try {
        await releaseReads.promise;
        return await originalRead(arguments_);
      } finally {
        activeReads -= 1;
      }
    });

    const readable = await file.openReadable({ mimeType: 'application/octet-stream' });
    const buffer = new Uint8Array(4);
    await expect(readable.read({
      buffer,
      offset: 0,
      length: 4,
      position: 0,
      signal: undefined,
    })).resolves.toEqual({ bytesRead: 4 });
    expect(buffer).toEqual(expected.subarray(0, 4));

    blocking = true;
    const secondRead = readable.read({
      buffer,
      offset: 0,
      length: 4,
      position: 4,
      signal: undefined,
    });
    await prefetchWindowStarted.promise;
    expect(maximumActiveReads).toBe(3);
    expect(blockedReadCount).toBe(3);
    releaseReads.resolve();
    await expect(secondRead).resolves.toEqual({ bytesRead: 4 });
    expect(buffer).toEqual(expected.subarray(4, 8));

    await readable.close();
    expect(diagnostics.snapshot().resources.readerPrefetch).toEqual({
      currentBytes: 0,
      maximumBytes: 12,
      currentOperations: 0,
      maximumOperations: 3,
    });
    await session.close();
  });

  it('reuses one extent leaf without prefetching non-sequential chunks', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const policy: HizoFSPolicy = {
      ...TINY_POLICY,
      fileChunkReadPrefetchConcurrency: 4,
    };
    const session = await TEST_ONLY.createHizoFSInternal({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      policy,
      now: () => 1,
    });
    const file = await session.root.getFileHandle({
      name: 'random-read.bin',
      create: true,
    });
    const writer = await file.createWritable({ keepExistingData: false });
    await writer.write({
      position: 0,
      data: new Uint8Array(16).map((_, index) => index + 1),
    });
    await writer.close();
    const hizofs = requireHizoFSSession({ session });
    const fullChunkReadSpy = vi.spyOn(hizofs.runtime.chunkStore, 'read');
    const rangeReadSpy = vi.spyOn(hizofs.runtime.chunkStore, 'readRange');
    const extentPageReadSpy = vi.spyOn(hizofs.runtime.recordStore, 'read');
    const readable = await file.openReadable({ mimeType: 'application/octet-stream' });
    const buffer = new Uint8Array(2);

    await readable.read({
      buffer,
      offset: 0,
      length: 2,
      position: 0,
      signal: undefined,
    });
    expect(buffer).toEqual(new Uint8Array([1, 2]));
    await readable.read({
      buffer,
      offset: 0,
      length: 2,
      position: 4,
      signal: undefined,
    });
    expect(buffer).toEqual(new Uint8Array([5, 6]));

    expect(fullChunkReadSpy).not.toHaveBeenCalled();
    expect(rangeReadSpy).toHaveBeenCalledTimes(2);
    expect(
      extentPageReadSpy.mock.calls.filter(([request]) =>
        request.expectedKind === 'file_extent_page'
      ),
    ).toHaveLength(2);
    await readable.close();
    await session.close();
  });

  it('clears unscheduled chunks after a close-time batch write failure', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const diagnostics = createHizoFSRuntimeDiagnostics();
    const policy: HizoFSPolicy = {
      ...TINY_POLICY,
      fileChunkWriteConcurrency: 2,
    };
    const session = await TEST_ONLY.createHizoFSInternal({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      policy,
      now: () => 1,
      diagnostics,
    });
    const file = await session.root.getFileHandle({
      name: 'failed-concurrent-chunks.bin',
      create: true,
    });
    const hizofs = requireHizoFSSession({ session });
    let invocation = 0;
    vi.spyOn(hizofs.runtime.chunkStore, 'writeManyPipelined')
      .mockImplementation(async () => {
        invocation += 1;
        throw new Error('injected chunk write failure');
      });

    const writer = await file.createWritable({ keepExistingData: false });
    await writer.write({
      position: 0,
      data: new Uint8Array(16).map((_, index) => index + 1),
    });
    await expect(writer.close()).rejects.toThrow('injected chunk write failure');
    expect(invocation).toBe(1);
    expect(diagnostics.snapshot().resources).toMatchObject({
      writerDirtyChunks: {
        currentBytes: 0,
        currentOperations: 0,
      },
      writerPendingChunkWrites: {
        currentBytes: 0,
        currentOperations: 0,
      },
    });

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
    await vi.waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(1));

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
    const activeCommitReference = decodeHizoFSObjectReference({
      value: activeCommitObjectId,
    });
    await session.close();
    const backingStore = new NativeOpfsHizoFSBackingStore({
      root: backing,
      fileHandleCacheEntryLimit: 64,
      fileSnapshotCacheEntryLimit: 64,
      diagnostics: undefined,
    });
    const activeCommitPath = [
      'segments',
      'metadata',
      getHizoFSObjectShard({ objectId: activeCommitObjectId }),
      `${encodeHizoFSSegmentId({ segmentId: activeCommitReference.homeSegmentId })}.seg`,
    ] as const;
    const segmentBytes = await backingStore.read({ path: activeCommitPath });
    if (segmentBytes === undefined) throw new Error('Expected the active metadata segment');
    const corruptionOffset = activeCommitReference.homeOffset
      + HIZOFS_RECORD_FRAME_HEADER_BYTE_LENGTH;
    const originalCiphertextByte = segmentBytes[corruptionOffset];
    if (originalCiphertextByte === undefined) {
      throw new Error('Expected the active commit ciphertext inside its segment');
    }
    segmentBytes[corruptionOffset] = originalCiphertextByte ^ 0x01;
    await backingStore.write({ path: activeCommitPath, bytes: segmentBytes });

    const recovered = await openTiny({ root: backing, now: () => 2 });
    const recoveredSession = requireHizoFSSession({ session: recovered });
    expect((await recoveredSession.loadActiveState()).stateSelection).toBe('fallback');
    await expect(recovered.root.getFileHandle({
      name: 'must-not-write.txt',
      create: true,
    })).rejects.toThrow('read-only recovery mode');
    await recovered.close();
  });

});
