import type { HizoFSBackingStore } from '@/00-storage/service/hizofs/backing-store/backing-store';
import type { HizoFSPolicy } from './policy';
import { HizoFSObjectStore } from '@/00-storage/service/hizofs/object-store/object-store';
import { HizoFSSuperblockStore } from '@/00-storage/service/hizofs/object-store/superblock-store';
import { HizoFSRecordStore } from './record-store';
import { HizoFSCommitStore } from './commit-store';
import { HizoFSInodeIndex } from './inode-index';
import { HizoFSDirectoryIndex } from './directory-index';
import { HizoFSExtentIndex } from './extent-index';
import { HizoFSInodeStore } from './inode-store';
import { HizoFSFileChunkStore } from './file-chunk-store';
import { HizoFSNodeService } from './node-service';
import { HizoFSDirectoryStorage } from './directory-storage';
import { HizoFSCore } from './core';

export type HizoFSRuntime = {
  readonly core: HizoFSCore;
  readonly objectStore: HizoFSObjectStore;
  readonly recordStore: HizoFSRecordStore;
  readonly commitStore: HizoFSCommitStore;
  readonly inodeIndex: HizoFSInodeIndex;
  readonly directoryIndex: HizoFSDirectoryIndex;
  readonly extentIndex: HizoFSExtentIndex;
  readonly inodeStore: HizoFSInodeStore;
  readonly chunkStore: HizoFSFileChunkStore;
  readonly nodeService: HizoFSNodeService;
  readonly directoryStorage: HizoFSDirectoryStorage;
  readonly policy: HizoFSPolicy;
  readonly now: () => number;
};

export function createHizoFSRuntime({
  backingStore,
  rootKey,
  fileSystemId,
  policy,
  now,
}: {
  backingStore: HizoFSBackingStore;
  rootKey: CryptoKey;
  fileSystemId: string;
  policy: HizoFSPolicy;
  now: () => number;
}): HizoFSRuntime {
  const objectStore = new HizoFSObjectStore({
    backingStore,
    rootKey,
    fileSystemId,
    metadataCacheByteLimit: policy.metadataObjectCacheByteLimit,
    metadataCacheEntryLimit: policy.metadataObjectCacheEntryLimit,
    fileChunkCacheByteLimit: policy.fileChunkCacheByteLimit,
    fileChunkCacheEntryLimit: policy.fileChunkCacheEntryLimit,
  });
  const recordStore = new HizoFSRecordStore({ objectStore });
  const commitStore = new HizoFSCommitStore({ recordStore });
  const inodeIndex = new HizoFSInodeIndex({
    recordStore,
    maxPageEntries: policy.indexPageEntryLimit,
  });
  const directoryIndex = new HizoFSDirectoryIndex({
    recordStore,
    maxPageEntries: policy.indexPageEntryLimit,
  });
  const extentIndex = new HizoFSExtentIndex({
    recordStore,
    maxPageEntries: policy.indexPageEntryLimit,
  });
  const inodeStore = new HizoFSInodeStore({ recordStore });
  const chunkStore = new HizoFSFileChunkStore({ recordStore });
  const nodeService = new HizoFSNodeService({ inodeIndex, inodeStore });
  const directoryStorage = new HizoFSDirectoryStorage({
    inodeStore,
    directoryIndex,
    inlineEntryLimit: policy.inlineDirectoryEntryLimit,
  });
  const superblockStore = new HizoFSSuperblockStore({
    objectStore,
    fileSystemId,
  });
  const core = new HizoFSCore({
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
