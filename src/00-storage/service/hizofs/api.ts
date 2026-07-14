import type {
  HizoFSCommitDto,
  HizoFSDescriptorDto,
  HizoFSSuperblockDto,
} from '@/00-storage/00-dto/hizofs.dto';
import type { StorageFileSystemSession } from '@/00-storage/service/storage-file-system/types';
import { NativeOpfsHizoFSBackingStore } from './backing-store/native-opfs-backing-store';
import { importHizoFSRootKey } from './crypto/object-crypto';
import {
  createHizoFSDescriptor,
  readHizoFSDescriptor,
} from './format/descriptor-store';
import { createHizoFSStableId } from './id';
import { DEFAULT_HIZOFS_POLICY, type HizoFSPolicy } from './file-system/policy';
import { createHizoFSRuntime } from './file-system/runtime';
import { HizoFSSession } from './file-system/session';
import { acquireHizoFSSessionLease } from './file-system/maintenance-lock';

export async function createHizoFS({ backingDirectory, fileSystemRootKey }: {
  backingDirectory: FileSystemDirectoryHandle;
  fileSystemRootKey: Uint8Array;
}): Promise<StorageFileSystemSession> {
  return createHizoFSInternal({
    backingDirectory,
    fileSystemRootKey,
    policy: DEFAULT_HIZOFS_POLICY,
    now: () => Date.now(),
  });
}

export async function openHizoFS({ backingDirectory, fileSystemRootKey }: {
  backingDirectory: FileSystemDirectoryHandle;
  fileSystemRootKey: Uint8Array;
}): Promise<StorageFileSystemSession> {
  return openHizoFSInternal({
    backingDirectory,
    fileSystemRootKey,
    policy: DEFAULT_HIZOFS_POLICY,
    now: () => Date.now(),
  });
}


export async function readHizoFSFileSystemId({ backingDirectory }: {
  backingDirectory: FileSystemDirectoryHandle;
}): Promise<string> {
  const descriptor = await readHizoFSDescriptor({
    backingStore: new NativeOpfsHizoFSBackingStore({ root: backingDirectory }),
  });
  if (descriptor === undefined) {
    throw new Error('HizoFS descriptor is missing');
  }
  return descriptor.fileSystemId;
}

export interface HizoFSInspection {
  readonly descriptor: HizoFSDescriptorDto;
  readonly superblock: HizoFSSuperblockDto;
  readonly activeCommitObjectId: string;
  readonly activeCommit: HizoFSCommitDto;
}

export async function inspectHizoFS({
  backingDirectory,
  fileSystemRootKey,
}: {
  backingDirectory: FileSystemDirectoryHandle;
  fileSystemRootKey: Uint8Array;
}): Promise<HizoFSInspection> {
  const backingStore = new NativeOpfsHizoFSBackingStore({ root: backingDirectory });
  const descriptor = await readHizoFSDescriptor({ backingStore });
  if (descriptor === undefined) {
    throw new Error('HizoFS descriptor is missing');
  }
  const maintenanceLease = await acquireHizoFSSessionLease({
    fileSystemId: descriptor.fileSystemId,
  });
  try {
    const rootKey = await importHizoFSRootKey({ rawRootKey: fileSystemRootKey });
    const runtime = createHizoFSRuntime({
      backingStore,
      rootKey,
      fileSystemId: descriptor.fileSystemId,
      policy: DEFAULT_HIZOFS_POLICY,
      now: () => Date.now(),
    });
    const activeState = await runtime.core.loadActiveState();
    return {
      descriptor,
      superblock: activeState.superblock,
      activeCommitObjectId: activeState.commitObjectId,
      activeCommit: activeState.commit,
    };
  } finally {
    await maintenanceLease.release();
  }
}

async function createHizoFSInternal({
  backingDirectory,
  fileSystemRootKey,
  policy,
  now,
}: {
  backingDirectory: FileSystemDirectoryHandle;
  fileSystemRootKey: Uint8Array;
  policy: HizoFSPolicy;
  now: () => number;
}): Promise<StorageFileSystemSession> {
  const backingStore = new NativeOpfsHizoFSBackingStore({ root: backingDirectory });
  const descriptor = await createHizoFSDescriptor({ backingStore });
  const maintenanceLease = await acquireHizoFSSessionLease({
    fileSystemId: descriptor.fileSystemId,
  });
  try {
    const rootKey = await importHizoFSRootKey({ rawRootKey: fileSystemRootKey });
    const runtime = createHizoFSRuntime({
      backingStore,
      rootKey,
      fileSystemId: descriptor.fileSystemId,
      policy,
      now,
    });

    const rootDirectoryNodeId = createHizoFSStableId();
    const timestamp = now();
    const rootInodeObjectId = await runtime.inodeStore.writeDirectory({
      inode: {
        nodeId: rootDirectoryNodeId,
        revision: 0,
        createdAt: timestamp,
        modifiedAt: timestamp,
        storage: { type: 'inline', entries: [] },
      },
    });
    let inodeIndexRootObjectId = await runtime.inodeIndex.createEmpty();
    inodeIndexRootObjectId = await runtime.inodeIndex.set({
      rootObjectId: inodeIndexRootObjectId,
      entry: {
        nodeId: rootDirectoryNodeId,
        inodeObjectId: rootInodeObjectId,
      },
    });
    const commitObjectId = await runtime.commitStore.write({
      commit: {
        revision: 0,
        rootDirectoryNodeId,
        inodeIndexRootObjectId,
      },
    });
    await runtime.core.superblockStore.write({
      value: {
        sequence: 0,
        fileSystemId: descriptor.fileSystemId,
        activeCommitObjectId: commitObjectId,
      },
    });
    await runtime.core.loadActiveState();
    return new HizoFSSession({
      runtime,
      rootDirectoryNodeId,
      maintenanceLease,
    });
  } catch (error) {
    await maintenanceLease.release();
    throw error;
  }
}

async function openHizoFSInternal({
  backingDirectory,
  fileSystemRootKey,
  policy,
  now,
}: {
  backingDirectory: FileSystemDirectoryHandle;
  fileSystemRootKey: Uint8Array;
  policy: HizoFSPolicy;
  now: () => number;
}): Promise<StorageFileSystemSession> {
  const backingStore = new NativeOpfsHizoFSBackingStore({ root: backingDirectory });
  const descriptor = await readHizoFSDescriptor({ backingStore });
  if (descriptor === undefined) {
    throw new Error('HizoFS descriptor is missing');
  }
  const maintenanceLease = await acquireHizoFSSessionLease({
    fileSystemId: descriptor.fileSystemId,
  });
  try {
    const rootKey = await importHizoFSRootKey({ rawRootKey: fileSystemRootKey });
    const runtime = createHizoFSRuntime({
      backingStore,
      rootKey,
      fileSystemId: descriptor.fileSystemId,
      policy,
      now,
    });
    const state = await runtime.core.loadActiveState();
    return new HizoFSSession({
      runtime,
      rootDirectoryNodeId: state.commit.rootDirectoryNodeId,
      maintenanceLease,
    });
  } catch (error) {
    await maintenanceLease.release();
    throw error;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  createHizoFSInternal,
  openHizoFSInternal,
};
