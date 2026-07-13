import { describe, expect, it, vi } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { NativeOpfsEncryptedOpfsBackingStore } from './native-opfs-backing-store';

describe('native OPFS EncryptedOpfs backing store', () => {
  it('uses the provided directory as the complete physical namespace', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'provided-root' });
    const store = new NativeOpfsEncryptedOpfsBackingStore({ root });

    await store.write({
      path: ['objects', 'ab', 'object.eopfs'],
      bytes: new Uint8Array([1, 2, 3]),
    });

    expect(await store.read({
      path: ['objects', 'ab', 'object.eopfs'],
    })).toEqual(new Uint8Array([1, 2, 3]));
    await expect(root.getDirectoryHandle('objects')).resolves.toBeDefined();
  });

  it('returns undefined for missing files and makes removal idempotent', async () => {
    const store = new NativeOpfsEncryptedOpfsBackingStore({
      root: new MockFileSystemDirectoryHandle({ name: 'root' }),
    });
    expect(await store.read({ path: ['missing'] })).toBeUndefined();
    await expect(store.remove({
      path: ['missing'],
      recursive: false,
    })).resolves.toBeUndefined();
  });

  it('lists physical entries without interpreting their contents', async () => {
    const store = new NativeOpfsEncryptedOpfsBackingStore({
      root: new MockFileSystemDirectoryHandle({ name: 'root' }),
    });
    await store.write({ path: ['a', 'one'], bytes: new Uint8Array([1]) });
    await store.write({ path: ['a', 'two'], bytes: new Uint8Array([2]) });

    const entries = [];
    for await (const entry of store.list({ path: ['a'] })) {
      entries.push(entry);
    }
    expect(entries).toEqual([
      { name: 'one', kind: 'file' },
      { name: 'two', kind: 'file' },
    ]);
  });

  it('accepts an ambiguous close failure only when read-back proves the complete write', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const handle = await root.getFileHandle('value', { create: true });
    const createWritable = handle.createWritable.bind(handle);
    vi.spyOn(handle, 'createWritable').mockImplementation(async (options) => {
      const writable = await createWritable(options);
      const close = writable.close.bind(writable);
      vi.spyOn(writable, 'close').mockImplementation(async () => {
        await close();
        throw new Error('ambiguous close failure');
      });
      return writable;
    });
    const store = new NativeOpfsEncryptedOpfsBackingStore({ root });

    await expect(store.write({
      path: ['value'],
      bytes: new Uint8Array([4, 5, 6]),
    })).resolves.toBeUndefined();
    expect(await store.read({ path: ['value'] })).toEqual(new Uint8Array([4, 5, 6]));
  });

  it('preserves the write error when read-back cannot prove durable completion', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const handle = await root.getFileHandle('value', { create: true });
    const createWritable = handle.createWritable.bind(handle);
    vi.spyOn(handle, 'createWritable').mockImplementation(async (options) => {
      const writable = await createWritable(options);
      vi.spyOn(writable, 'write').mockImplementation(async () => undefined);
      vi.spyOn(writable, 'close').mockRejectedValue(new Error('definite close failure'));
      return writable;
    });
    const store = new NativeOpfsEncryptedOpfsBackingStore({ root });

    await expect(store.write({
      path: ['value'],
      bytes: new Uint8Array([7, 8, 9]),
    })).rejects.toThrow('definite close failure');
    expect(await store.read({ path: ['value'] })).toEqual(new Uint8Array());
  });

  it('rejects traversal-like physical paths', async () => {
    const store = new NativeOpfsEncryptedOpfsBackingStore({
      root: new MockFileSystemDirectoryHandle({ name: 'root' }),
    });
    await expect(store.write({
      path: ['..', 'value'],
      bytes: new Uint8Array(),
    })).rejects.toThrow('Invalid EncryptedOpfs backing-store path segment');
  });
});
