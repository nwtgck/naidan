import { describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { NativeOpfsHizoFSBackingStore } from '@/00-storage/service/hizofs/backing-store/native-opfs-backing-store';
import { importHizoFSRootKey } from '@/00-storage/service/hizofs/crypto/object-crypto';
import { encodeBase64Url } from '@/00-storage/service/hizofs/base64-url';
import { HizoFSRelocationStore, TEST_ONLY } from './relocation-store';

const FILE_SYSTEM_ID = encodeBase64Url({ bytes: new Uint8Array(16).fill(3) });
function objectId({ segmentByte, offset }: { segmentByte: number; offset: number }): string {
  const bytes = new Uint8Array(32);
  bytes.fill(segmentByte, 0, 16);
  new DataView(bytes.buffer).setBigUint64(16, BigInt(offset), false);
  new DataView(bytes.buffer).setUint32(24, 80, false);
  bytes[28] = 1;
  return encodeBase64Url({ bytes });
}

async function createStore(): Promise<{ store: HizoFSRelocationStore; backing: NativeOpfsHizoFSBackingStore }> {
  const backing = new NativeOpfsHizoFSBackingStore({
    root: new MockFileSystemDirectoryHandle({ name: 'root' }),
    fileHandleCacheEntryLimit: 8,
    fileSnapshotCacheEntryLimit: 8,
    diagnostics: undefined,
  });
  const rootKey = await importHizoFSRootKey({ rawRootKey: new Uint8Array(32).fill(7) });
  return { backing, store: new HizoFSRelocationStore({ backingStore: backing, rootKey, fileSystemId: FILE_SYSTEM_ID }) };
}

describe('HizoFS relocation store', () => {
  it('publishes A/B authenticated mappings and flattens chains', async () => {
    const { backing, store } = await createStore();
    const a = objectId({ segmentByte: 1, offset: 64 });
    const b = objectId({ segmentByte: 2, offset: 64 });
    const c = objectId({ segmentByte: 3, offset: 64 });
    await store.publish({ mappings: new Map([[a, b]]) });
    await store.publish({ mappings: new Map([[b, c]]) });
    expect(await store.resolve({ objectId: a })).toBe(c);
    expect(await store.resolve({ objectId: b })).toBe(c);

    const rootKey = await importHizoFSRootKey({ rawRootKey: new Uint8Array(32).fill(7) });
    const reopened = new HizoFSRelocationStore({ backingStore: backing, rootKey, fileSystemId: FILE_SYSTEM_ID });
    expect(await reopened.resolve({ objectId: a })).toBe(c);
  });

  it('uses the older valid slot when the newest slot is corrupt', async () => {
    const { backing, store } = await createStore();
    const a = objectId({ segmentByte: 1, offset: 64 });
    const b = objectId({ segmentByte: 2, offset: 64 });
    const c = objectId({ segmentByte: 3, offset: 64 });
    await store.publish({ mappings: new Map([[a, b]]) });
    await store.publish({ mappings: new Map([[b, c]]) });
    const newestPath = TEST_ONLY.pathForSlot({ slot: 0 });
    const newest = await backing.read({ path: newestPath });
    const corrupted = newest?.slice() ?? new Uint8Array();
    corrupted[corrupted.byteLength - 1] ^= 1;
    await backing.write({ path: newestPath, bytes: corrupted });

    const rootKey = await importHizoFSRootKey({ rawRootKey: new Uint8Array(32).fill(7) });
    const reopened = new HizoFSRelocationStore({ backingStore: backing, rootKey, fileSystemId: FILE_SYSTEM_ID });
    expect(await reopened.resolve({ objectId: a })).toBe(c);
  });

  it('rejects cycles and kind changes before publication', async () => {
    const { store } = await createStore();
    const a = objectId({ segmentByte: 1, offset: 64 });
    const b = objectId({ segmentByte: 2, offset: 64 });
    await store.publish({ mappings: new Map([[a, b]]) });
    await expect(store.publish({ mappings: new Map([[b, a]]) })).rejects.toThrow('cycle');
    const differentKindBytes = new Uint8Array(32);
    differentKindBytes.fill(4, 0, 16);
    new DataView(differentKindBytes.buffer).setBigUint64(16, 64n, false);
    new DataView(differentKindBytes.buffer).setUint32(24, 80, false);
    differentKindBytes[28] = 2;
    await expect(store.publish({
      mappings: new Map([[a, encodeBase64Url({ bytes: differentKindBytes })]]),
    })).rejects.toThrow('logical record kind');
  });
});
