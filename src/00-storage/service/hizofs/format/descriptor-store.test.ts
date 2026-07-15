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
    });
    expect(await readHizoFSDescriptor({ backingStore })).toEqual(descriptor);
  });

  it('does not silently replace an existing descriptor', async () => {
    const backingStore = new NativeOpfsHizoFSBackingStore({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
    });
    await createHizoFSDescriptor({ backingStore });
    await expect(createHizoFSDescriptor({ backingStore })).rejects.toThrow(
      'backing directory must be empty',
    );
  });

  it('ignores unknown non-secret descriptor fields', async () => {
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
    await expect(readHizoFSDescriptor({ backingStore })).resolves.toEqual({
      format: 'hizofs',
      formatVersion: 1,
    });
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
      })),
    });
    await expect(readHizoFSDescriptor({ backingStore })).rejects.toThrow();
  });
});
