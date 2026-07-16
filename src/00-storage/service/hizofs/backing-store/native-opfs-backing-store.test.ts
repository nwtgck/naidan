import { describe, expect, it, vi } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { NativeOpfsHizoFSBackingStore } from './native-opfs-backing-store';

describe('native OPFS HizoFS backing store', () => {
  it('uses the provided directory as the complete physical namespace', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'provided-root' });
    const store = new NativeOpfsHizoFSBackingStore({ root });

    await store.write({
      path: ['objects', 'ab', 'object.enc'],
      bytes: new Uint8Array([1, 2, 3]),
    });

    expect(await store.read({
      path: ['objects', 'ab', 'object.enc'],
    })).toEqual(new Uint8Array([1, 2, 3]));
    await expect(root.getDirectoryHandle('objects')).resolves.toBeDefined();
  });

  it('reuses resolved directory handles for repeated object operations', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const objects = await root.getDirectoryHandle('objects', { create: true });
    const shard = await objects.getDirectoryHandle('ab', { create: true });
    const rootLookup = vi.spyOn(root, 'getDirectoryHandle');
    const objectsLookup = vi.spyOn(objects, 'getDirectoryHandle');
    const store = new NativeOpfsHizoFSBackingStore({ root });

    await store.write({
      path: ['objects', 'ab', 'one.enc'],
      bytes: new Uint8Array([1]),
    });
    await store.write({
      path: ['objects', 'ab', 'two.enc'],
      bytes: new Uint8Array([2]),
    });
    await expect(store.read({
      path: ['objects', 'ab', 'one.enc'],
    })).resolves.toEqual(new Uint8Array([1]));

    expect(rootLookup).toHaveBeenCalledTimes(1);
    expect(objectsLookup).toHaveBeenCalledTimes(1);
    await expect(shard.getFileHandle('two.enc')).resolves.toBeDefined();
  });

  it('invalidates cached directory handles after recursive removal', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const rootLookup = vi.spyOn(root, 'getDirectoryHandle');
    const store = new NativeOpfsHizoFSBackingStore({ root });

    await store.write({ path: ['temporary', 'one'], bytes: new Uint8Array([1]) });
    await store.remove({ path: ['temporary'], recursive: true });
    await store.write({ path: ['temporary', 'two'], bytes: new Uint8Array([2]) });

    expect(rootLookup.mock.calls.filter(([name]) => name === 'temporary')).toHaveLength(2);
    await expect(store.read({ path: ['temporary', 'two'] })).resolves.toEqual(
      new Uint8Array([2]),
    );
  });

  it('reuses root file handles while reading fresh file contents each time', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const rootFileLookup = vi.spyOn(root, 'getFileHandle');
    const store = new NativeOpfsHizoFSBackingStore({ root });

    await store.write({ path: ['superblock-0.enc'], bytes: new Uint8Array([1]) });
    await expect(store.read({ path: ['superblock-0.enc'] })).resolves.toEqual(
      new Uint8Array([1]),
    );
    await store.write({ path: ['superblock-0.enc'], bytes: new Uint8Array([2]) });
    await expect(store.read({ path: ['superblock-0.enc'] })).resolves.toEqual(
      new Uint8Array([2]),
    );

    expect(rootFileLookup).toHaveBeenCalledTimes(1);
  });

  it('invalidates a cached root file handle after removal', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const rootFileLookup = vi.spyOn(root, 'getFileHandle');
    const store = new NativeOpfsHizoFSBackingStore({ root });

    await store.write({ path: ['descriptor.json'], bytes: new Uint8Array([1]) });
    await store.remove({ path: ['descriptor.json'], recursive: false });
    await store.write({ path: ['descriptor.json'], bytes: new Uint8Array([2]) });

    expect(rootFileLookup).toHaveBeenCalledTimes(2);
    await expect(store.read({ path: ['descriptor.json'] })).resolves.toEqual(
      new Uint8Array([2]),
    );
  });

  it('returns undefined for missing files and makes removal idempotent', async () => {
    const store = new NativeOpfsHizoFSBackingStore({
      root: new MockFileSystemDirectoryHandle({ name: 'root' }),
    });
    expect(await store.read({ path: ['missing'] })).toBeUndefined();
    await expect(store.remove({
      path: ['missing'],
      recursive: false,
    })).resolves.toBeUndefined();
  });

  it('lists physical entries without interpreting their contents', async () => {
    const store = new NativeOpfsHizoFSBackingStore({
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
    const store = new NativeOpfsHizoFSBackingStore({ root });

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
    const store = new NativeOpfsHizoFSBackingStore({ root });

    await expect(store.write({
      path: ['value'],
      bytes: new Uint8Array([7, 8, 9]),
    })).rejects.toThrow('definite close failure');
    expect(await store.read({ path: ['value'] })).toEqual(new Uint8Array());
  });

  it('rejects traversal-like physical paths', async () => {
    const store = new NativeOpfsHizoFSBackingStore({
      root: new MockFileSystemDirectoryHandle({ name: 'root' }),
    });
    await expect(store.write({
      path: ['..', 'value'],
      bytes: new Uint8Array(),
    })).rejects.toThrow('Invalid HizoFS backing-store path segment');
  });
});
