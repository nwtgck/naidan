import { describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { NativeOpfsEncryptedOpfsBackingStore } from '@/00-storage/service/encrypted-opfs/backing-store/native-opfs-backing-store';
import {
  createEncryptedOpfsDescriptor,
  readEncryptedOpfsDescriptor,
} from './descriptor-store';

describe('EncryptedOpfs descriptor store', () => {
  it('creates a generic descriptor without a Naidan format discriminator', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const backingStore = new NativeOpfsEncryptedOpfsBackingStore({ root });

    const descriptor = await createEncryptedOpfsDescriptor({ backingStore });
    expect(descriptor).toEqual({
      formatVersion: 1,
      fileSystemId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/u),
    });
    expect(descriptor).not.toHaveProperty('format');
    expect(await readEncryptedOpfsDescriptor({ backingStore })).toEqual(descriptor);
  });

  it('does not silently replace an existing descriptor', async () => {
    const backingStore = new NativeOpfsEncryptedOpfsBackingStore({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
    });
    await createEncryptedOpfsDescriptor({ backingStore });
    await expect(createEncryptedOpfsDescriptor({ backingStore })).rejects.toThrow(
      'descriptor already exists',
    );
  });

  it('rejects a structurally valid but non-canonical filesystem ID', async () => {
    const backingStore = new NativeOpfsEncryptedOpfsBackingStore({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
    });
    await backingStore.write({
      path: ['descriptor.json'],
      bytes: new TextEncoder().encode(JSON.stringify({
        formatVersion: 1,
        fileSystemId: 'not-an-id',
      })),
    });
    await expect(readEncryptedOpfsDescriptor({ backingStore })).rejects.toThrow(
      'canonical Base64URL',
    );
  });
});
