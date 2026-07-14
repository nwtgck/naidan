import { describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { NativeOpfsHizoFSBackingStore } from '@/00-storage/service/hizofs/backing-store/native-opfs-backing-store';
import {
  createHizoFSDescriptor,
  readHizoFSDescriptor,
} from './descriptor-store';

describe('HizoFS descriptor store', () => {
  it('creates a descriptor with an explicit HizoFS format identifier', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const backingStore = new NativeOpfsHizoFSBackingStore({ root });

    const descriptor = await createHizoFSDescriptor({ backingStore });
    expect(descriptor).toEqual({
      format: 'hizofs',
      formatVersion: 1,
      fileSystemId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/u),
    });
    expect(await readHizoFSDescriptor({ backingStore })).toEqual(descriptor);
  });

  it('does not silently replace an existing descriptor', async () => {
    const backingStore = new NativeOpfsHizoFSBackingStore({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
    });
    await createHizoFSDescriptor({ backingStore });
    await expect(createHizoFSDescriptor({ backingStore })).rejects.toThrow(
      'descriptor already exists',
    );
  });

  it('rejects a structurally valid but non-canonical filesystem ID', async () => {
    const backingStore = new NativeOpfsHizoFSBackingStore({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
    });
    await backingStore.write({
      path: ['descriptor.json'],
      bytes: new TextEncoder().encode(JSON.stringify({
        format: 'hizofs',
        formatVersion: 1,
        fileSystemId: 'not-an-id',
      })),
    });
    await expect(readHizoFSDescriptor({ backingStore })).rejects.toThrow(
      'canonical Base64URL',
    );
  });

  it('rejects a directory whose descriptor does not identify HizoFS', async () => {
    const backingStore = new NativeOpfsHizoFSBackingStore({
      root: new MockFileSystemDirectoryHandle({ name: 'filesystem.hizofs' }),
    });
    await backingStore.write({
      path: ['descriptor.json'],
      bytes: new TextEncoder().encode(JSON.stringify({
        format: 'something_else',
        formatVersion: 1,
        fileSystemId: 'AAAAAAAAAAAAAAAAAAAAAA',
      })),
    });
    await expect(readHizoFSDescriptor({ backingStore })).rejects.toThrow();
  });
});
