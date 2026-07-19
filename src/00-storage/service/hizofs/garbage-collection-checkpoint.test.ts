import { describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { NativeOpfsHizoFSBackingStore } from '@/00-storage/service/hizofs/backing-store/native-opfs-backing-store';
import { importHizoFSRootKey } from '@/00-storage/service/hizofs/crypto/object-crypto';
import { encodeBase64Url } from '@/00-storage/service/hizofs/base64-url';
import { HizoFSGarbageCollectionCheckpointStore, TEST_ONLY } from './garbage-collection-checkpoint';

const FILE_SYSTEM_ID = encodeBase64Url({ bytes: new Uint8Array(16).fill(3) });
function objectId(byte: number): string {
  const bytes = new Uint8Array(32);
  bytes.fill(byte, 0, 16);
  new DataView(bytes.buffer).setBigUint64(16, 64n, false);
  new DataView(bytes.buffer).setUint32(24, 80, false);
  bytes[28] = 1;
  return encodeBase64Url({ bytes });
}
async function setup() {
  const backingStore = new NativeOpfsHizoFSBackingStore({
    root: new MockFileSystemDirectoryHandle({ name: 'root' }),
    fileHandleCacheEntryLimit: 8,
    fileSnapshotCacheEntryLimit: 8,
    diagnostics: undefined,
  });
  const rootKey = await importHizoFSRootKey({ rawRootKey: new Uint8Array(32).fill(7) });
  return { backingStore, rootKey, store: new HizoFSGarbageCollectionCheckpointStore({ backingStore, rootKey, fileSystemId: FILE_SYSTEM_ID }) };
}

describe('HizoFS garbage-collection checkpoint', () => {
  it('persists cumulative progress redundantly and clears both slots', async () => {
    const { backingStore, rootKey, store } = await setup();
    const checkpoint = {
      sequence: 4,
      activeCommitObjectId: objectId(1),
      phase: 'sweep' as const,
      completedCompactionCandidateCount: 2,
      completedSweepCandidateCount: 3,
      relocatedObjectCount: 5,
      reclaimedCompactionObjectCount: 7,
      removedSweepObjectCount: 11,
      lastCompletedCandidateObjectId: objectId(2),
    };
    await store.write({ checkpoint });
    await expect(store.read()).resolves.toEqual(checkpoint);

    const firstPath = TEST_ONLY.pathForSlot({ slot: 0 });
    const first = await backingStore.read({ path: firstPath });
    const corrupt = first?.slice() ?? new Uint8Array();
    corrupt[corrupt.byteLength - 1] ^= 1;
    await backingStore.write({ path: firstPath, bytes: corrupt });
    const reopened = new HizoFSGarbageCollectionCheckpointStore({ backingStore, rootKey, fileSystemId: FILE_SYSTEM_ID });
    await expect(reopened.read()).resolves.toEqual(checkpoint);
    await reopened.clear();
    await expect(reopened.read()).resolves.toBeUndefined();
  });
});
