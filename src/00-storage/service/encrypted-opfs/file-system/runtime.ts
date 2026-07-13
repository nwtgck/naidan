import type { EncryptedOpfsBackingStore } from '@/00-storage/service/encrypted-opfs/backing-store/backing-store';
import type { EncryptedOpfsPolicy } from './policy';
import { EncryptedOpfsObjectStore } from '@/00-storage/service/encrypted-opfs/object-store/object-store';
import { EncryptedOpfsSuperblockStore } from '@/00-storage/service/encrypted-opfs/object-store/superblock-store';
import { EncryptedOpfsRecordStore } from './record-store';
import { EncryptedOpfsCommitStore } from './commit-store';
import { EncryptedOpfsInodeIndex } from './inode-index';
import { EncryptedOpfsDirectoryIndex } from './directory-index';
import { EncryptedOpfsExtentIndex } from './extent-index';
import { EncryptedOpfsInodeStore } from './inode-store';
import { EncryptedOpfsFileChunkStore } from './file-chunk-store';
import { EncryptedOpfsNodeService } from './node-service';
import { EncryptedOpfsDirectoryStorage } from './directory-storage';
import { EncryptedOpfsCore } from './core';

export type EncryptedOpfsRuntime = {
  readonly core: EncryptedOpfsCore;
  readonly objectStore: EncryptedOpfsObjectStore;
  readonly recordStore: EncryptedOpfsRecordStore;
  readonly commitStore: EncryptedOpfsCommitStore;
  readonly inodeIndex: EncryptedOpfsInodeIndex;
  readonly directoryIndex: EncryptedOpfsDirectoryIndex;
  readonly extentIndex: EncryptedOpfsExtentIndex;
  readonly inodeStore: EncryptedOpfsInodeStore;
  readonly chunkStore: EncryptedOpfsFileChunkStore;
  readonly nodeService: EncryptedOpfsNodeService;
  readonly directoryStorage: EncryptedOpfsDirectoryStorage;
  readonly policy: EncryptedOpfsPolicy;
  readonly now: () => number;
};

export function createEncryptedOpfsRuntime({
  backingStore,
  rootKey,
  fileSystemId,
  policy,
  now,
}: {
  backingStore: EncryptedOpfsBackingStore;
  rootKey: CryptoKey;
  fileSystemId: string;
  policy: EncryptedOpfsPolicy;
  now: () => number;
}): EncryptedOpfsRuntime {
  const objectStore = new EncryptedOpfsObjectStore({
    backingStore,
    rootKey,
    fileSystemId,
  });
  const recordStore = new EncryptedOpfsRecordStore({ objectStore });
  const commitStore = new EncryptedOpfsCommitStore({ recordStore });
  const inodeIndex = new EncryptedOpfsInodeIndex({
    recordStore,
    maxPageEntries: policy.indexPageEntryLimit,
  });
  const directoryIndex = new EncryptedOpfsDirectoryIndex({
    recordStore,
    maxPageEntries: policy.indexPageEntryLimit,
  });
  const extentIndex = new EncryptedOpfsExtentIndex({
    recordStore,
    maxPageEntries: policy.indexPageEntryLimit,
  });
  const inodeStore = new EncryptedOpfsInodeStore({ recordStore });
  const chunkStore = new EncryptedOpfsFileChunkStore({ recordStore });
  const nodeService = new EncryptedOpfsNodeService({ inodeIndex, inodeStore });
  const directoryStorage = new EncryptedOpfsDirectoryStorage({
    inodeStore,
    directoryIndex,
    inlineEntryLimit: policy.inlineDirectoryEntryLimit,
  });
  const superblockStore = new EncryptedOpfsSuperblockStore({
    objectStore,
    fileSystemId,
  });
  const core = new EncryptedOpfsCore({
    fileSystemId,
    objectStore,
    superblockStore,
    commitStore,
    inodeIndex,
    inodeStore,
  });
  return {
    core,
    objectStore,
    recordStore,
    commitStore,
    inodeIndex,
    directoryIndex,
    extentIndex,
    inodeStore,
    chunkStore,
    nodeService,
    directoryStorage,
    policy,
    now,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
