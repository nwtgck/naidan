import { describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { createNativeOpfsFileSystemSession } from './native-opfs';
import { readStorageFileText, writeStorageFileText } from './io';

describe('native OPFS storage file-system adapter', () => {
  it('preserves the direct Blob read capability', async () => {
    const nativeRoot = new MockFileSystemDirectoryHandle({ name: 'root' });
    const session = createNativeOpfsFileSystemSession({ root: nativeRoot });
    const file = await session.root.getFileHandle({ name: 'a.txt', create: true });
    await writeStorageFileText({ fileHandle: file, value: 'hello' });

    const readable = await file.openReadable({ mimeType: 'text/plain' });
    expect(readable.backing.type).toBe('direct_blob');
    expect(await new Response(readable.stream({
      start: 0,
      end: undefined,
      signal: undefined,
    })).text()).toBe('hello');
  });

  it('supports random writes and truncate through the common writer', async () => {
    const nativeRoot = new MockFileSystemDirectoryHandle({ name: 'root' });
    const session = createNativeOpfsFileSystemSession({ root: nativeRoot });
    const file = await session.root.getFileHandle({ name: 'a.bin', create: true });
    const writable = await file.createWritable({ keepExistingData: false });
    await writable.write({ position: 4, data: new Uint8Array([5, 6]) });
    await writable.write({ position: 1, data: new Uint8Array([2, 3]) });
    await writable.truncate({ size: 5 });
    await writable.close();

    const readable = await file.openReadable({ mimeType: 'application/octet-stream' });
    const bytes = new Uint8Array(await new Response(readable.stream({
      start: 0,
      end: undefined,
      signal: undefined,
    })).arrayBuffer());
    expect([...bytes]).toEqual([0, 2, 3, 0, 5]);
  });

  it('wraps directory traversal and removal', async () => {
    const nativeRoot = new MockFileSystemDirectoryHandle({ name: 'root' });
    const session = createNativeOpfsFileSystemSession({ root: nativeRoot });
    const directory = await session.root.getDirectoryHandle({ name: 'dir', create: true });
    const file = await directory.getFileHandle({ name: 'value.json', create: true });
    await writeStorageFileText({ fileHandle: file, value: '{"ok":true}' });

    const entries: string[] = [];
    for await (const [name, handle] of directory.entries()) {
      entries.push(`${handle.kind}:${name}`);
    }
    expect(entries).toEqual(['file:value.json']);
    expect(await readStorageFileText({ fileHandle: file })).toBe('{"ok":true}');

    await session.root.removeEntry({ name: 'dir', recursive: true });
    await expect(session.root.getDirectoryHandle({
      name: 'dir',
      create: false,
    })).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('reports native capability limits explicitly', () => {
    const nativeRoot = new MockFileSystemDirectoryHandle({ name: 'root' });
    const session = createNativeOpfsFileSystemSession({ root: nativeRoot });
    expect(session.capabilities).toEqual({
      directBlob: 'supported',
      symbolicLink: 'unsupported',
      atomicMove: 'unsupported',
    });
  });
});
