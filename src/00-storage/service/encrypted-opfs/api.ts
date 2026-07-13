import type {
  EncryptedOpfsCommitDto,
  EncryptedOpfsDescriptorDto,
  EncryptedOpfsSuperblockDto,
} from '@/00-storage/00-dto/encrypted-opfs.dto';
import type { StorageFileSystemSession } from '@/00-storage/service/storage-file-system/types';
import { NativeOpfsEncryptedOpfsBackingStore } from './backing-store/native-opfs-backing-store';
import { importEncryptedOpfsRootKey } from './crypto/object-crypto';
import {
  createEncryptedOpfsDescriptor,
  readEncryptedOpfsDescriptor,
} from './format/descriptor-store';
import { createEncryptedOpfsStableId } from './id';
import { DEFAULT_ENCRYPTED_OPFS_POLICY, type EncryptedOpfsPolicy } from './file-system/policy';
import { createEncryptedOpfsRuntime } from './file-system/runtime';
import { EncryptedOpfsSession } from './file-system/session';
import { acquireEncryptedOpfsSessionLease } from './file-system/maintenance-lock';

export async function createEncryptedOpfs({ backingDirectory, fileSystemRootKey }: {
  backingDirectory: FileSystemDirectoryHandle;
  fileSystemRootKey: Uint8Array;
}): Promise<StorageFileSystemSession> {
  return createEncryptedOpfsInternal({
    backingDirectory,
    fileSystemRootKey,
    policy: DEFAULT_ENCRYPTED_OPFS_POLICY,
    now: () => Date.now(),
  });
}

export async function openEncryptedOpfs({ backingDirectory, fileSystemRootKey }: {
  backingDirectory: FileSystemDirectoryHandle;
  fileSystemRootKey: Uint8Array;
}): Promise<StorageFileSystemSession> {
  return openEncryptedOpfsInternal({
    backingDirectory,
    fileSystemRootKey,
    policy: DEFAULT_ENCRYPTED_OPFS_POLICY,
    now: () => Date.now(),
  });
}


export async function readEncryptedOpfsFileSystemId({ backingDirectory }: {
  backingDirectory: FileSystemDirectoryHandle;
}): Promise<string> {
  const descriptor = await readEncryptedOpfsDescriptor({
    backingStore: new NativeOpfsEncryptedOpfsBackingStore({ root: backingDirectory }),
  });
  if (descriptor === undefined) {
    throw new Error('EncryptedOpfs descriptor is missing');
  }
  return descriptor.fileSystemId;
}

export interface EncryptedOpfsInspection {
  readonly descriptor: EncryptedOpfsDescriptorDto;
  readonly superblock: EncryptedOpfsSuperblockDto;
  readonly activeCommitObjectId: string;
  readonly activeCommit: EncryptedOpfsCommitDto;
}

export async function inspectEncryptedOpfs({
  backingDirectory,
  fileSystemRootKey,
}: {
  backingDirectory: FileSystemDirectoryHandle;
  fileSystemRootKey: Uint8Array;
}): Promise<EncryptedOpfsInspection> {
  const backingStore = new NativeOpfsEncryptedOpfsBackingStore({ root: backingDirectory });
  const descriptor = await readEncryptedOpfsDescriptor({ backingStore });
  if (descriptor === undefined) {
    throw new Error('EncryptedOpfs descriptor is missing');
  }
  const maintenanceLease = await acquireEncryptedOpfsSessionLease({
    fileSystemId: descriptor.fileSystemId,
  });
  try {
    const rootKey = await importEncryptedOpfsRootKey({ rawRootKey: fileSystemRootKey });
    const runtime = createEncryptedOpfsRuntime({
      backingStore,
      rootKey,
      fileSystemId: descriptor.fileSystemId,
      policy: DEFAULT_ENCRYPTED_OPFS_POLICY,
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

async function createEncryptedOpfsInternal({
  backingDirectory,
  fileSystemRootKey,
  policy,
  now,
}: {
  backingDirectory: FileSystemDirectoryHandle;
  fileSystemRootKey: Uint8Array;
  policy: EncryptedOpfsPolicy;
  now: () => number;
}): Promise<StorageFileSystemSession> {
  const backingStore = new NativeOpfsEncryptedOpfsBackingStore({ root: backingDirectory });
  const descriptor = await createEncryptedOpfsDescriptor({ backingStore });
  const maintenanceLease = await acquireEncryptedOpfsSessionLease({
    fileSystemId: descriptor.fileSystemId,
  });
  try {
    const rootKey = await importEncryptedOpfsRootKey({ rawRootKey: fileSystemRootKey });
    const runtime = createEncryptedOpfsRuntime({
      backingStore,
      rootKey,
      fileSystemId: descriptor.fileSystemId,
      policy,
      now,
    });

    const rootDirectoryNodeId = createEncryptedOpfsStableId();
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
    return new EncryptedOpfsSession({
      runtime,
      rootDirectoryNodeId,
      maintenanceLease,
    });
  } catch (error) {
    await maintenanceLease.release();
    throw error;
  }
}

async function openEncryptedOpfsInternal({
  backingDirectory,
  fileSystemRootKey,
  policy,
  now,
}: {
  backingDirectory: FileSystemDirectoryHandle;
  fileSystemRootKey: Uint8Array;
  policy: EncryptedOpfsPolicy;
  now: () => number;
}): Promise<StorageFileSystemSession> {
  const backingStore = new NativeOpfsEncryptedOpfsBackingStore({ root: backingDirectory });
  const descriptor = await readEncryptedOpfsDescriptor({ backingStore });
  if (descriptor === undefined) {
    throw new Error('EncryptedOpfs descriptor is missing');
  }
  const maintenanceLease = await acquireEncryptedOpfsSessionLease({
    fileSystemId: descriptor.fileSystemId,
  });
  try {
    const rootKey = await importEncryptedOpfsRootKey({ rawRootKey: fileSystemRootKey });
    const runtime = createEncryptedOpfsRuntime({
      backingStore,
      rootKey,
      fileSystemId: descriptor.fileSystemId,
      policy,
      now,
    });
    const state = await runtime.core.loadActiveState();
    return new EncryptedOpfsSession({
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
  createEncryptedOpfsInternal,
  openEncryptedOpfsInternal,
};
