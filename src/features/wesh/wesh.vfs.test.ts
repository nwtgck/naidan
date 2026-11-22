import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Wesh } from './index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { WeshVFS } from './vfs';
import {
  MockFileSystemDirectoryHandle,
  MockFileSystemFileHandle,
  MockFileSystemWritableFileStream,
} from './mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from './utils/test-stream';
import { readAllFileBytes } from './utils/fs';
import { METADATA_DIR, WESH_SYSTEM_DIR } from './dto';
import type { WeshFileHandle, WeshOpenFlags, WeshStat, WeshVirtualMountProvider } from './types';

function createVirtualFileHandle({ text }: { text: string }): WeshFileHandle {
  const bytes = new TextEncoder().encode(text);
  let cursor = 0;

  return {
    async read({ buffer, offset, length, position }) {
      const bufferOffset = offset ?? 0;
      const start = position ?? cursor;
      const maxLength = length ?? (buffer.length - bufferOffset);
      const end = Math.min(start + maxLength, bytes.length);
      const slice = bytes.subarray(start, end);
      buffer.set(slice, bufferOffset);
      if (position === undefined) {
        cursor = end;
      }
      return { bytesRead: slice.length };
    },
    async write() {
      throw new Error('File is read-only');
    },
    async close() {},
    async stat() {
      return { size: bytes.length, mode: 0o444, type: 'file', mtime: 0, ino: 0, uid: 0, gid: 0 };
    },
    async truncate() {
      throw new Error('File is read-only');
    },
    async ioctl() {
      return { ret: 0 };
    },
  };
}

function createDirectoryStat({ size }: { size: number }): WeshStat {
  return { size, mode: 0o555, type: 'directory', mtime: 0, ino: 0, uid: 0, gid: 0 };
}

function createFileStat({ size }: { size: number }): WeshStat {
  return { size, mode: 0o444, type: 'file', mtime: 0, ino: 0, uid: 0, gid: 0 };
}

function createSymlinkStat({ size }: { size: number }): WeshStat {
  return { size, mode: 0o777, type: 'symlink', mtime: 0, ino: 0, uid: 0, gid: 0 };
}

interface TestSyncAccessHandle {
  read(buffer: Uint8Array, options?: { at?: number }): number,
  write(buffer: Uint8Array, options?: { at?: number }): number,
  truncate(newSize: number): void,
  getSize(): number,
  flush(): void,
  close(): void,
}

interface TestSyncAccessCapableFileHandle extends MockFileSystemFileHandle {
  createSyncAccessHandle(): Promise<TestSyncAccessHandle>,
}

function attachTestSyncAccessHandle({
  fileHandle,
}: {
  fileHandle: MockFileSystemFileHandle,
}): {
  syncAccessHandle: TestSyncAccessHandle,
  createSyncAccessHandle: ReturnType<typeof vi.fn<() => Promise<TestSyncAccessHandle>>>,
} {
  const flush = vi.fn();
  const close = vi.fn();
  const syncAccessHandle: TestSyncAccessHandle = {
    read(buffer, options) {
      const position = options?.at ?? 0;
      const bytes = fileHandle.content.subarray(position, position + buffer.byteLength);
      buffer.set(bytes);
      return bytes.byteLength;
    },
    write(buffer, options) {
      const position = options?.at ?? 0;
      const requiredSize = position + buffer.byteLength;
      if (fileHandle.content.byteLength < requiredSize) {
        const content = new Uint8Array(requiredSize);
        content.set(fileHandle.content);
        fileHandle.content = content;
      }
      fileHandle.content.set(buffer, position);
      fileHandle.lastModified = Date.now();
      return buffer.byteLength;
    },
    truncate(newSize) {
      const content = new Uint8Array(newSize);
      content.set(fileHandle.content.subarray(0, newSize));
      fileHandle.content = content;
      fileHandle.lastModified = Date.now();
    },
    getSize() {
      return fileHandle.content.byteLength;
    },
    flush,
    close,
  };
  const createSyncAccessHandle = vi.fn(async () => syncAccessHandle);
  (fileHandle as TestSyncAccessCapableFileHandle).createSyncAccessHandle = createSyncAccessHandle;
  return { syncAccessHandle, createSyncAccessHandle };
}

describe('WeshVFS mount initialization', () => {
  it('does not inspect the metadata tree while registering directory mounts', async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    const rootGetDirectoryHandle = vi.spyOn(rootHandle, 'getDirectoryHandle');
    const vfs = new WeshVFS({
      rootHandle: rootHandle as unknown as FileSystemDirectoryHandle,
    });

    expect(rootGetDirectoryHandle).not.toHaveBeenCalled();

    const mountedHandle = new MockFileSystemDirectoryHandle({ name: 'mounted' });
    const mountedGetDirectoryHandle = vi.spyOn(mountedHandle, 'getDirectoryHandle');
    await vfs.mount({
      path: '/mounted',
      handle: mountedHandle as unknown as FileSystemDirectoryHandle,
      readOnly: false,
    });

    expect(mountedGetDirectoryHandle).not.toHaveBeenCalled();
  });

  it('only confirms a missing metadata root when its absence was reused during path resolution', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const project = await root.getDirectoryHandle('project', { create: true });
    const source = await project.getDirectoryHandle('src', { create: true });
    const target = await source.getFileHandle('target.txt', { create: true });
    const vfs = new WeshVFS({ rootHandle: root });
    using getDirectory = vi.spyOn(root, 'getDirectoryHandle');
    const metadataProbes = () => getDirectory.mock.calls.filter(([name]) => name === WESH_SYSTEM_DIR).length;

    await expect(vfs.getNativeHandle({ path: '/project' })).resolves.toBe(project);
    expect(metadataProbes()).toBe(1);
    getDirectory.mockClear();
    await expect(vfs.getNativeHandle({ path: '/project/src/target.txt' })).resolves.toBe(target);
    expect(metadataProbes()).toBe(2);
    await expect(vfs.getNativeHandle({ path: '/project/src/target.txt' })).resolves.toBe(target);
    expect(metadataProbes()).toBe(4);

    const publisher = new WeshVFS({ rootHandle: root });
    await publisher.symlink({ path: '/project/src/alias.txt', targetPath: 'target.txt' });
    await expect(vfs.getNativeHandle({ path: '/project/src/alias.txt' })).resolves.toBe(target);
  });

  it('retries metadata discovery on a later component after a transient read failure', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const directory = await root.getDirectoryHandle('project', { create: true });
    const target = await directory.getFileHandle('target.txt', { create: true });
    const publisher = new WeshVFS({ rootHandle: root });
    await publisher.symlink({ path: '/project/alias.txt', targetPath: 'target.txt' });
    const vfs = new WeshVFS({ rootHandle: root });
    using getDirectory = vi.spyOn(root, 'getDirectoryHandle')
      .mockRejectedValueOnce(new DOMException('metadata temporarily unavailable', 'NotAllowedError'));

    await expect(vfs.getNativeHandle({ path: '/project/alias.txt' })).resolves.toBe(target);
    expect(getDirectory.mock.calls.filter(([name]) => name === WESH_SYSTEM_DIR)).toHaveLength(2);
  });

  it.each([
    { publisherType: 'the original mount', publicationPath: '/project/alias', separateVfs: false },
    { publisherType: 'an alias mount', publicationPath: '/shared/project/alias', separateVfs: false },
    { publisherType: 'a separate VFS', publicationPath: '/project/alias', separateVfs: true },
  ])('observes metadata published by $publisherType while a missing root probe is pending', async ({ publicationPath, separateVfs }) => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const directory = await root.getDirectoryHandle('project', { create: true });
    const targetDirectory = await directory.getDirectoryHandle('target', { create: true });
    const target = await targetDirectory.getFileHandle('member.txt', { create: true });
    const vfs = new WeshVFS({ rootHandle: root });
    await vfs.mount({ path: '/shared', handle: root });
    const publisher = separateVfs ? new WeshVFS({ rootHandle: root }) : vfs;
    const getDirectoryHandle = root.getDirectoryHandle.bind(root);
    using publish = vi.spyOn(root, 'getDirectoryHandle').mockImplementationOnce(async (name, options) => {
      try {
        return await getDirectoryHandle(name, options);
      } catch (error: unknown) {
        expect(error).toMatchObject({ name: 'NotFoundError' });
        await publisher.symlink({ path: publicationPath, targetPath: 'target' });
        throw error;
      }
    });

    await expect(vfs.getNativeHandle({ path: '/project/alias/member.txt' })).resolves.toBe(target);
    expect(publish).toHaveBeenNthCalledWith(1, WESH_SYSTEM_DIR, { create: false });
  });

  it('discards a combined lookup when its mount changes during traversal', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const original = new MockFileSystemDirectoryHandle({ name: 'original' });
    const replacement = new MockFileSystemDirectoryHandle({ name: 'replacement' });
    const vfs = new WeshVFS({ rootHandle: root });
    const mountPath = '/work';
    const path = `${mountPath}/folder/member.txt`;
    const directory = await replacement.getDirectoryHandle('folder', { create: true });
    await directory.getFileHandle('member.txt', { create: true });
    await vfs.mount({ path: mountPath, handle: original });

    const getDirectoryHandle = original.getDirectoryHandle.bind(original);
    using replaceMount = vi.spyOn(original, 'getDirectoryHandle').mockImplementationOnce(async (name, options) => {
      await vfs.mount({ path: mountPath, handle: replacement });
      return getDirectoryHandle(name, options);
    });
    await expect(vfs.tryLookupEntryWithoutFollowingSymlinks({ path })).resolves.toBeUndefined();
    expect(replaceMount).toHaveBeenCalled();
    const lookup = await vfs.tryLookupEntryWithoutFollowingSymlinks({ path });
    try {
      expect(lookup).toMatchObject({ entry: { fullPath: path, type: 'file' } });
    } finally {
      lookup?.release();
    }
  });

  it('does not continue non-following recursive mkdir in a replacement mount', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const first = new MockFileSystemDirectoryHandle({ name: 'first' });
    const second = new MockFileSystemDirectoryHandle({ name: 'second' });
    const vfs = new WeshVFS({ rootHandle: root });
    const mountPath = '/work';
    const path = '/work/parent/child';
    await vfs.mount({ path: mountPath, handle: first });
    const getDirectory = first.getDirectoryHandle.bind(first);
    using _remount = vi.spyOn(first, 'getDirectoryHandle').mockImplementation(async (name, options) => {
      const directory = await getDirectory(name, options);
      if (name === 'parent' && options?.create) {
        await vfs.mount({ path: mountPath, handle: second });
      }
      return directory;
    });

    await expect(vfs.mkdir({ path, recursive: true, symlinkTreatment: 'no-follow' }))
      .rejects.toMatchObject({ name: 'WeshEntryChangedError', path });
    const created = await first.getDirectoryHandle('parent');
    await expect(created.getDirectoryHandle('child')).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(second.getDirectoryHandle('parent')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it.each([
    '/member.txt',
    '/alias/member.txt',
  ])('rejects publication after Wesh reuses the same native pathname via %s', async (mutationPath) => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const vfs = new WeshVFS({ rootHandle: root });
    await vfs.mount({ path: '/alias', handle: root });
    const path = '/member.txt';
    const lookup = await vfs.tryLookupEntryWithoutFollowingSymlinks({ path });
    if (lookup === undefined) {
      throw new Error('Expected a lookup for an absent file');
    }
    try {
      const result = await vfs.tryCreateFileWriterEfficiently({ lookup, mode: 'truncate' });
      if (result.kind !== 'writer') {
        throw new Error('Expected a writable stream');
      }
      try {
        await result.writer.write({ chunk: new TextEncoder().encode('archive data') });
        const opened = await root.getFileHandle('member.txt');
        // A native provider can compare these handles by path after recreation.
        using _compareByPath = vi.spyOn(opened, 'isSameEntry').mockResolvedValue(true);
        await vfs.unlink({ path: mutationPath });
        const replacement = await vfs.open({
          path: mutationPath,
          flags: { access: 'write', creation: 'always', truncate: 'preserve', append: 'preserve' },
        });
        await replacement.close();
        await expect(result.writer.close()).rejects.toMatchObject({ name: 'WeshEntryChangedError', path });
        await expect((await root.getFileHandle('member.txt')).getFile()).resolves.toMatchObject({ size: 0 });
      } finally {
        await result.writer.abort({ reason: undefined });
      }
    } finally {
      lookup.release();
    }
  });

  it.each([
    { renameFails: false, expectedContent: 'renamed' },
    { renameFails: true, expectedContent: 'archive data' },
  ])('only invalidates a fallback rename that reaches publication (failure: $renameFails)', async ({ renameFails, expectedContent }) => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const vfs = new WeshVFS({ rootHandle: root });
    const path = '/member.txt';
    const initial = await root.getFileHandle('member.txt', { create: true });
    initial.content = new TextEncoder().encode('original');
    const source = await root.getFileHandle('renamed.txt', { create: true });
    source.content = new TextEncoder().encode('renamed');
    const lookup = await vfs.tryLookupEntryWithoutFollowingSymlinks({ path });
    if (lookup === undefined) {
      throw new Error('Expected a lookup for an existing file');
    }
    try {
      const result = await vfs.tryCreateFileWriterEfficiently({ lookup, mode: 'truncate' });
      if (result.kind !== 'writer') {
        throw new Error('Expected a writable stream');
      }
      try {
        await result.writer.write({ chunk: new TextEncoder().encode('archive data') });
        if (renameFails) {
          using _failBeforePublication = vi.spyOn(initial, 'createWritable').mockRejectedValueOnce(new Error('Cannot start rename writer'));
          await expect(vfs.rename({ oldPath: '/renamed.txt', newPath: path })).rejects.toThrow('Cannot start rename writer');
          await result.writer.close();
        } else {
          await vfs.rename({ oldPath: '/renamed.txt', newPath: path });
          await expect(result.writer.close()).rejects.toMatchObject({ name: 'WeshEntryChangedError', path });
        }
        await expect(root.getFileHandle('member.txt')).resolves.toBe(initial);
        await expect((await initial.getFile()).text()).resolves.toBe(expectedContent);
      } finally {
        await result.writer.abort({ reason: undefined });
      }
    } finally {
      lookup.release();
    }
  });

  it('keeps a checked writer when the provider refuses to remove its file', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const vfs = new WeshVFS({ rootHandle: root });
    const path = '/member.txt';
    const initial = await root.getFileHandle('member.txt', { create: true });
    const lookup = await vfs.tryLookupEntryWithoutFollowingSymlinks({ path });
    if (lookup === undefined) {
      throw new Error('Expected a lookup for an existing file');
    }
    try {
      const result = await vfs.tryCreateFileWriterEfficiently({ lookup, mode: 'truncate' });
      if (result.kind !== 'writer') {
        throw new Error('Expected a writable stream');
      }
      try {
        await result.writer.write({ chunk: new TextEncoder().encode('archive data') });
        const busy = new DOMException('A writable stream is open', 'NoModificationAllowedError');
        using _refuseRemoval = vi.spyOn(root, 'removeEntry').mockRejectedValueOnce(busy);
        await expect(vfs.unlink({ path })).rejects.toBe(busy);
        await result.writer.close();
        await expect((await initial.getFile()).text()).resolves.toBe('archive data');
      } finally {
        await result.writer.abort({ reason: undefined });
      }
    } finally {
      lookup.release();
    }
  });
});

describe('WeshVFS exclusive file creation', () => {
  it('rejects an existing path without changing its contents', async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    const fileHandle = await rootHandle.getFileHandle('existing.txt', { create: true });
    fileHandle.content = new TextEncoder().encode('preserved');
    const vfs = new WeshVFS({
      rootHandle: rootHandle as unknown as FileSystemDirectoryHandle,
    });

    await expect(vfs.open({
      path: '/existing.txt',
      flags: {
        access: 'write',
        creation: 'always',
        truncate: 'truncate',
        append: 'preserve',
      },
    })).rejects.toThrow('File exists: /existing.txt');
    expect(new TextDecoder().decode(fileHandle.content)).toBe('preserved');
  });

  it('does not treat a permission failure as a missing path', async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    vi.spyOn(rootHandle, 'getFileHandle').mockImplementation(async (_name, options) => {
      if (options?.create === true) {
        throw new Error('Unexpected create attempt');
      }
      throw new DOMException('Permission denied', 'NotAllowedError');
    });
    const vfs = new WeshVFS({
      rootHandle: rootHandle as unknown as FileSystemDirectoryHandle,
    });

    await expect(vfs.open({
      path: '/blocked.txt',
      flags: {
        access: 'write',
        creation: 'if-needed',
        truncate: 'truncate',
        append: 'preserve',
      },
    })).rejects.toThrow('Permission denied: /blocked.txt: Permission denied');
  });
});

describe('WeshVFS FIFO buffering', () => {
  it('applies backpressure instead of buffering without a limit', async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    const vfs = new WeshVFS({
      rootHandle: rootHandle as unknown as FileSystemDirectoryHandle,
    });
    await vfs.mknod({ path: '/pipe', type: 'fifo' });
    const reader = await vfs.open({
      path: '/pipe',
      flags: {
        access: 'read',
        creation: 'never',
        truncate: 'preserve',
        append: 'preserve',
      },
    });
    const writer = await vfs.open({
      path: '/pipe',
      flags: {
        access: 'write',
        creation: 'never',
        truncate: 'preserve',
        append: 'preserve',
      },
    });
    const payload = new Uint8Array(128 * 1024).fill(0x61);
    let writeCompleted = false;
    const writePromise = writer.write({ buffer: payload }).then((result) => {
      writeCompleted = true;
      return result;
    });

    await vi.waitFor(async () => {
      expect((await writer.stat()).size).toBe(64 * 1024);
    });
    expect(writeCompleted).toBe(false);

    const first = new Uint8Array(64 * 1024);
    expect(await reader.read({ buffer: first })).toEqual({ bytesRead: first.byteLength });
    await expect(writePromise).resolves.toEqual({ bytesWritten: payload.byteLength });
    expect((await writer.stat()).size).toBe(64 * 1024);

    const second = new Uint8Array(64 * 1024);
    expect(await reader.read({ buffer: second })).toEqual({ bytesRead: second.byteLength });
    expect(first).toEqual(payload.subarray(0, first.byteLength));
    expect(second).toEqual(payload.subarray(first.byteLength));
    await writer.close();
    await reader.close();
  });
});

describe('wesh vfs mounts', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function execute({
    script,
    signal,
  }: {
    script: string,
    signal?: AbortSignal,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
      signal,
    });

    return { result, stdout, stderr };
  }

  it('lists and reads direct mount points from their parent directory', async () => {
    const mountedRoot = new MockFileSystemDirectoryHandle({ name: 'mounted' });
    const fileHandle = await mountedRoot.getFileHandle('note.txt', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write('mounted content');
    await writable.close();

    await wesh.vfs.mount({
      path: '/mnt',
      handle: mountedRoot as unknown as FileSystemDirectoryHandle,
      readOnly: false,
    });

    const listed = await execute({ script: 'ls -F /' });
    expect(listed.stdout.text).toContain('mnt/');
    expect(listed.stderr.text).toBe('');
    expect(listed.result.exitCode).toBe(0);

    const read = await execute({ script: 'cat /mnt/note.txt' });
    expect(read.stdout.text).toBe('mounted content');
    expect(read.stderr.text).toBe('');
    expect(read.result.exitCode).toBe(0);
  });

  it('treats synthetic parent directories of nested mounts as readable directories', async () => {
    const mountedRoot = new MockFileSystemDirectoryHandle({ name: 'nested' });
    const fileHandle = await mountedRoot.getFileHandle('hello.txt', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write('hello');
    await writable.close();

    await wesh.vfs.mount({
      path: '/volumes/work',
      handle: mountedRoot as unknown as FileSystemDirectoryHandle,
      readOnly: false,
    });

    const listedParent = await execute({ script: 'ls -F /' });
    expect(listedParent.stdout.text).toContain('volumes/');

    const listedSynthetic = await execute({ script: 'ls -F /volumes' });
    expect(listedSynthetic.stdout.text).toContain('work/');
    expect(listedSynthetic.stderr.text).toBe('');
    expect(listedSynthetic.result.exitCode).toBe(0);

    const changed = await execute({ script: 'cd /volumes/work; pwd' });
    expect(changed.stdout.text).toBe('/volumes/work\n');
    expect(changed.stderr.text).toBe('');
    expect(changed.result.exitCode).toBe(0);
  });

  it('lists synthetic special directories like /dev from their parent', async () => {
    const listedRoot = await execute({ script: 'ls -lF /' });
    expect(listedRoot.stdout.text).toContain('dev/');
    expect(listedRoot.stderr.text).toBe('');
    expect(listedRoot.result.exitCode).toBe(0);

    const listedDev = await execute({ script: 'ls -l /dev' });
    expect(listedDev.stdout.text).toContain('null');
    expect(listedDev.stdout.text).toContain('zero');
    expect(listedDev.stderr.text).toBe('');
    expect(listedDev.result.exitCode).toBe(0);

    const changed = await execute({ script: 'cd /dev; pwd' });
    expect(changed.stdout.text).toBe('/dev\n');
    expect(changed.stderr.text).toBe('');
    expect(changed.result.exitCode).toBe(0);
  });

  it('readDir reports fullPath for synthetic mount parents and mounted directories', async () => {
    const mountedRoot = new MockFileSystemDirectoryHandle({ name: 'work' });
    const fileHandle = await mountedRoot.getFileHandle('note.txt', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write('hello');
    await writable.close();

    await wesh.vfs.mount({
      path: '/volumes/work',
      handle: mountedRoot as unknown as FileSystemDirectoryHandle,
      readOnly: false,
    });

    const syntheticEntries = [];
    for await (const entry of wesh.vfs.readDir({ path: '/volumes' })) {
      syntheticEntries.push(entry);
    }
    expect(syntheticEntries).toEqual([
      { name: 'work', type: 'directory', fullPath: '/volumes/work' },
    ]);

    const mountedEntries = [];
    for await (const entry of wesh.vfs.readDir({ path: '/volumes/work' })) {
      mountedEntries.push(entry);
    }
    expect(mountedEntries).toEqual([
      { name: 'note.txt', type: 'file', fullPath: '/volumes/work/note.txt' },
    ]);
  });

  it('readDir reports special-file types without stat fallback', async () => {
    const devEntries = [];
    for await (const entry of wesh.vfs.readDir({ path: '/dev' })) {
      devEntries.push(entry);
    }

    expect(devEntries).toEqual(expect.arrayContaining([
      { name: 'null', type: 'chardev', fullPath: '/dev/null' },
      { name: 'zero', type: 'chardev', fullPath: '/dev/zero' },
    ]));

    const binEntries = [];
    for await (const entry of wesh.vfs.readDir({ path: '/bin' })) {
      binEntries.push(entry);
    }

    expect(binEntries).toEqual(expect.arrayContaining([
      { name: 'sh', type: 'file', fullPath: '/bin/sh' },
      { name: 'bash', type: 'file', fullPath: '/bin/bash' },
    ]));
  });

  it('appends with >> without racing back to offset zero', async () => {
    const first = await wesh.vfs.open({
      path: '/append.txt',
      flags: { access: 'write', creation: 'if-needed', truncate: 'truncate', append: 'preserve' },
    });
    await first.write({ buffer: new TextEncoder().encode('first\n') });
    await first.close();

    const append = await wesh.vfs.open({
      path: '/append.txt',
      flags: { access: 'write', creation: 'if-needed', truncate: 'preserve', append: 'append' },
    });
    await append.write({ buffer: new TextEncoder().encode('second\n') });
    await append.close();

    const data = await readAllFileBytes({ files: wesh.kernel, path: '/append.txt' });
    expect(new TextDecoder().decode(data)).toBe(`\
first
second
`);
  });

  it('finishes a sequential write that has started seeking when its handle closes', async () => {
    const file = await rootHandle.getFileHandle('pending.txt', { create: true });
    const writer = await file.createWritable({ keepExistingData: true });
    const seeking = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const seek = writer.seek.bind(writer);
    vi.spyOn(writer, 'seek').mockImplementation(async position => {
      seeking.resolve();
      await resume.promise;
      await seek(position);
    });
    vi.spyOn(file, 'createWritable').mockResolvedValueOnce(writer);
    const handle = await wesh.vfs.open({
      path: '/pending.txt',
      flags: { access: 'write', creation: 'never', truncate: 'preserve', append: 'preserve' },
    });
    const write = handle.write({ buffer: new TextEncoder().encode('kept') });
    await seeking.promise;
    const close = handle.close();
    await expect(handle.write({ buffer: new TextEncoder().encode('late') })).rejects.toThrow('File handle is closed');
    resume.resolve();
    await expect(Promise.all([write, close])).resolves.toEqual([{ bytesWritten: 4 }, undefined]);
    expect(await (await file.getFile()).text()).toBe('kept');
  });

  it('waits for a write started before Stop when the descriptor remains open across inputs', async () => {
    const file = await rootHandle.getFileHandle('pending.txt', { create: true });
    const writer = await file.createWritable({ keepExistingData: true });
    const seeking = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    using _resume = { [Symbol.dispose]: () => resume.resolve() };
    const seek = writer.seek.bind(writer);
    vi.spyOn(writer, 'seek').mockImplementationOnce(async position => {
      seeking.resolve();
      await resume.promise;
      await seek(position);
    });
    vi.spyOn(file, 'createWritable').mockResolvedValueOnce(writer);
    expect((await execute({ script: 'exec 3>>pending.txt' })).result.exitCode).toBe(0);

    const stop = new AbortController();
    const execution = execute({ script: 'printf first >&3; printf skipped', signal: stop.signal });
    await seeking.promise;
    stop.abort();
    await expect(wesh.interruptForeground({ foregroundSignal: stop.signal })).resolves.toBe(true);
    const state = await Promise.race([
      execution.then(() => 'finished'),
      new Promise(resolve => setTimeout(() => resolve('writing'), 0)),
    ]);
    expect(state).toBe('writing');

    resume.resolve();
    const stopped = await execution;
    expect(stopped.result.exitCode).toBe(130);
    expect(stopped.stdout.text).toBe('');
    expect((await execute({ script: 'printf second >&3; exec 3>&-' })).result.exitCode).toBe(0);
    expect(await (await file.getFile()).text()).toBe('firstsecond');
  });

  it('settles a regular file read before the next input uses its persistent descriptor', async () => {
    const file = await rootHandle.getFileHandle('pending.txt', { create: true });
    const contents = await file.getFile();
    const reading = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    using _resume = { [Symbol.dispose]: () => resume.resolve() };
    vi.spyOn(file, 'getFile').mockResolvedValue(contents);
    vi.spyOn(contents, 'stream').mockReturnValue(new ReadableStream({
      async pull(controller) {
        reading.resolve();
        await resume.promise;
        controller.enqueue(new TextEncoder().encode('firstsecond'));
        controller.close();
      },
    }, { highWaterMark: 0 }));
    expect((await execute({ script: 'exec 3<pending.txt' })).result.exitCode).toBe(0);

    const stop = new AbortController();
    const execution = execute({ script: 'head -c 5 <&3', signal: stop.signal });
    await reading.promise;
    stop.abort();
    await expect(wesh.interruptForeground({ foregroundSignal: stop.signal })).resolves.toBe(true);
    const state = await Promise.race([
      execution.then(() => 'finished'),
      new Promise(resolve => setTimeout(() => resolve('reading'), 0)),
    ]);
    expect(state).toBe('reading');

    resume.resolve();
    expect((await execution).result.exitCode).toBe(130);
    const next = await execute({ script: 'head -c 6 <&3; exec 3<&-' });
    expect(next.result.exitCode).toBe(0);
    expect(next.stdout.text).toBe('second');
  });

  it('rejects unlink and rmdir mutations on read-only mounts', async () => {
    const readOnlyRoot = new MockFileSystemDirectoryHandle({ name: 'readonly' });
    const fileHandle = await readOnlyRoot.getFileHandle('locked.txt', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write('locked');
    await writable.close();

    await wesh.vfs.mount({
      path: '/ro',
      handle: readOnlyRoot as unknown as FileSystemDirectoryHandle,
      readOnly: true,
    });

    await expect(wesh.vfs.unlink({ path: '/ro/locked.txt' })).rejects.toThrow('Read-only filesystem');
    await expect(wesh.vfs.rmdir({ path: '/ro' })).rejects.toThrow('Cannot remove mount point');
  });

  it('rejects write-oriented opens on read-only mounts', async () => {
    const readOnlyRoot = new MockFileSystemDirectoryHandle({ name: 'readonly-open' });
    const fileHandle = await readOnlyRoot.getFileHandle('existing.txt', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write('existing');
    await writable.close();

    await wesh.vfs.mount({
      path: '/ro-open',
      handle: readOnlyRoot as unknown as FileSystemDirectoryHandle,
      readOnly: true,
    });

    await expect(wesh.vfs.open({
      path: '/ro-open/new.txt',
      flags: { access: 'write', creation: 'if-needed', truncate: 'truncate', append: 'preserve' },
    })).rejects.toThrow('Read-only file system');

    await expect(wesh.vfs.open({
      path: '/ro-open/existing.txt',
      flags: { access: 'write', creation: 'never', truncate: 'truncate', append: 'preserve' },
    })).rejects.toThrow('File is read-only');

    const createWritable = vi.spyOn(fileHandle, 'createWritable');
    for (const mode of ['truncate', 'append'] as const) {
      await expect(wesh.vfs.tryCreateFileWriterEfficiently({ path: '/ro-open/existing.txt', mode }))
        .rejects.toThrow('Read-only file system');
    }
    expect(createWritable).not.toHaveBeenCalled();

    const readable = await wesh.vfs.open({
      path: '/ro-open/existing.txt',
      flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
    });
    await readable.close();
  });

  it('rejects mkdir and mknod on read-only mounts', async () => {
    const readOnlyRoot = new MockFileSystemDirectoryHandle({ name: 'readonly-create' });

    await wesh.vfs.mount({
      path: '/ro-create',
      handle: readOnlyRoot as unknown as FileSystemDirectoryHandle,
      readOnly: true,
    });

    await expect(wesh.vfs.mkdir({ path: '/ro-create/subdir', recursive: true })).rejects.toThrow('Read-only filesystem');
    await expect(wesh.vfs.mknod({ path: '/ro-create/pipe', type: 'fifo' })).rejects.toThrow('Read-only filesystem');
  });

  it('rejects rename when the source or destination filesystem is read-only', async () => {
    const sourceRoot = new MockFileSystemDirectoryHandle({ name: 'readonly-source' });
    const sourceFile = await sourceRoot.getFileHandle('file.txt', { create: true });
    const sourceWritable = await sourceFile.createWritable();
    await sourceWritable.write('source');
    await sourceWritable.close();

    const destinationRoot = new MockFileSystemDirectoryHandle({ name: 'readonly-destination' });
    const destinationDir = await destinationRoot.getDirectoryHandle('dir', { create: true });
    void destinationDir;

    await wesh.vfs.mount({
      path: '/ro-source',
      handle: sourceRoot as unknown as FileSystemDirectoryHandle,
      readOnly: true,
    });
    await wesh.vfs.mount({
      path: '/ro-destination',
      handle: destinationRoot as unknown as FileSystemDirectoryHandle,
      readOnly: true,
    });

    const writableRootFile = await rootHandle.getFileHandle('movable.txt', { create: true });
    const writableRootWritable = await writableRootFile.createWritable();
    await writableRootWritable.write('movable');
    await writableRootWritable.close();

    await expect(wesh.vfs.rename({
      oldPath: '/ro-source/file.txt',
      newPath: '/renamed.txt',
    })).rejects.toThrow('Read-only source');

    await expect(wesh.vfs.rename({
      oldPath: '/movable.txt',
      newPath: '/ro-destination/file.txt',
    })).rejects.toThrow('Read-only destination');
  });

  async function createMoveFile({ parent, name, contents }: {
    parent: MockFileSystemDirectoryHandle,
    name: string,
    contents: string,
  }): Promise<MockFileSystemFileHandle> {
    const file = await parent.getFileHandle(name, { create: true });
    const writer = await file.createWritable();
    await writer.write(contents);
    await writer.close();
    return file;
  }

  it('keeps the shared entry when renaming through a different name for its parent', async () => {
    const parent = await rootHandle.getDirectoryHandle('real', { create: true });
    const source = await createMoveFile({ parent, name: 'data', contents: 'original' });
    await wesh.vfs.symlink({ path: '/alias', targetPath: '/real' });

    await wesh.vfs.rename({ oldPath: '/real/data', newPath: '/alias/data' });

    expect(await parent.getFileHandle('data')).toBe(source);
    expect(await (await source.getFile()).text()).toBe('original');
  });

  it.each(['getFile', 'createWritable', 'write', 'close'] as const)('keeps an existing destination when rename fails at %s', async step => {
    const source = await createMoveFile({ parent: rootHandle, name: 'source', contents: 'moved' });
    const destination = await createMoveFile({ parent: rootHandle, name: 'dest', contents: 'original' });
    const writer = await destination.createWritable();
    const failure = new DOMException(`failure at ${step}`, 'NotAllowedError');
    switch (step) {
    case 'getFile':
      vi.spyOn(source, 'getFile').mockRejectedValueOnce(failure);
      break;
    case 'createWritable':
      vi.spyOn(destination, 'createWritable').mockRejectedValueOnce(failure);
      break;
    case 'write':
    case 'close':
      vi.spyOn(destination, 'createWritable').mockResolvedValueOnce(writer);
      vi.spyOn(writer, step).mockRejectedValueOnce(failure);
      break;
    default: {
      const _ex: never = step;
      throw new Error(`Unhandled failure step: ${_ex}`);
    }
    }

    await expect(wesh.vfs.rename({ oldPath: '/source', newPath: '/dest' })).rejects.toThrow(failure.message);
    expect(await (await (await rootHandle.getFileHandle('dest')).getFile()).text()).toBe('original');
    expect(await (await (await rootHandle.getFileHandle('source')).getFile()).text()).toBe('moved');
  });

  it('retains a newly created source entry after committing the old source to the destination', async () => {
    await createMoveFile({ parent: rootHandle, name: 'source', contents: 'moved' });
    const destination = await createMoveFile({ parent: rootHandle, name: 'dest', contents: 'original' });
    const writer = await destination.createWritable();
    const close = writer.close.bind(writer);
    vi.spyOn(destination, 'createWritable').mockResolvedValueOnce(writer);
    vi.spyOn(writer, 'close').mockImplementationOnce(async () => {
      await close();
      await rootHandle.removeEntry('source');
      await createMoveFile({ parent: rootHandle, name: 'source', contents: 'new source' });
    });

    await expect(wesh.vfs.rename({ oldPath: '/source', newPath: '/dest' })).rejects.toThrow('source changed');
    expect(await (await (await rootHandle.getFileHandle('dest')).getFile()).text()).toBe('moved');
    expect(await (await (await rootHandle.getFileHandle('source')).getFile()).text()).toBe('new source');
  });

  it('keeps a destination created while waiting for the source snapshot', async () => {
    const source = await createMoveFile({ parent: rootHandle, name: 'source', contents: 'moved' });
    const reading = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    using _resume = { [Symbol.dispose]: () => resume.resolve() };
    const snapshot = await source.getFile();
    vi.spyOn(source, 'getFile').mockImplementationOnce(async () => {
      reading.resolve();
      await resume.promise;
      return snapshot;
    });

    const move = wesh.vfs.rename({ oldPath: '/source', newPath: '/dest' });
    await reading.promise;
    const destination = await createMoveFile({ parent: rootHandle, name: 'dest', contents: 'concurrent' });
    resume.resolve();

    await expect(move).rejects.toThrow('destination changed');
    expect(await (await source.getFile()).text()).toBe('moved');
    expect(await (await destination.getFile()).text()).toBe('concurrent');
  });

  it('keeps the source if the committed writer no longer belongs to the destination name', async () => {
    const source = await createMoveFile({ parent: rootHandle, name: 'source', contents: 'moved' });
    const destination = await createMoveFile({ parent: rootHandle, name: 'dest', contents: 'original' });
    const writer = await destination.createWritable();
    const close = writer.close.bind(writer);
    vi.spyOn(destination, 'createWritable').mockResolvedValueOnce(writer);
    vi.spyOn(writer, 'close').mockImplementationOnce(async () => {
      await rootHandle.removeEntry('dest');
      await createMoveFile({ parent: rootHandle, name: 'dest', contents: 'new destination' });
      await close();
    });

    await expect(wesh.vfs.rename({ oldPath: '/source', newPath: '/dest' })).rejects.toThrow('destination changed');
    expect(await (await source.getFile()).text()).toBe('moved');
    expect(await (await (await rootHandle.getFileHandle('dest')).getFile()).text()).toBe('new destination');
  });

  it('keeps the original link if publishing its new metadata fails', async () => {
    await wesh.vfs.symlink({ path: '/source', targetPath: '/target' });
    const system = await rootHandle.getDirectoryHandle(WESH_SYSTEM_DIR);
    const metadata = await system.getDirectoryHandle(METADATA_DIR);
    const getFile = metadata.getFileHandle.bind(metadata);
    vi.spyOn(metadata, 'getFileHandle').mockImplementation(async (name, options) => {
      if (name === 'dest' && options?.create) {
        throw new DOMException('metadata denied', 'NotAllowedError');
      }
      return getFile(name, options);
    });

    await expect(wesh.vfs.rename({ oldPath: '/source', newPath: '/dest' })).rejects.toThrow('metadata denied');
    expect(await wesh.vfs.readlink({ path: '/source' })).toBe('/target');
    await expect(wesh.vfs.lstat({ path: '/dest' })).rejects.toThrow();
  });

  it.each(['', 'backing bytes'])('can retry a failed registry publication with backing contents %j', async contents => {
    await wesh.vfs.symlink({ path: '/source', targetPath: '/target' });
    await createMoveFile({ parent: rootHandle, name: 'source', contents });
    const system = await rootHandle.getDirectoryHandle(WESH_SYSTEM_DIR);
    const metadata = await system.getDirectoryHandle(METADATA_DIR);
    const getFile = metadata.getFileHandle.bind(metadata);
    let injectFailure = true;
    vi.spyOn(metadata, 'getFileHandle').mockImplementation(async (name, options) => {
      const file = await getFile(name, options);
      if (injectFailure && name === 'dest' && options?.create) {
        injectFailure = false;
        const writer = await file.createWritable();
        vi.spyOn(file, 'createWritable').mockResolvedValueOnce(writer);
        vi.spyOn(writer, 'close').mockRejectedValueOnce(new Error('metadata close failed'));
      }
      return file;
    });

    await expect(wesh.vfs.rename({ oldPath: '/source', newPath: '/dest' })).rejects.toThrow('metadata close failed');
    expect(await wesh.vfs.readlink({ path: '/source' })).toBe('/target');
    await expect(wesh.vfs.lstat({ path: '/dest' })).rejects.toMatchObject({ name: 'NotFoundError' });

    await wesh.vfs.rename({ oldPath: '/source', newPath: '/dest' });
    expect(await wesh.vfs.readlink({ path: '/dest' })).toBe('/target');
    expect(await (await (await rootHandle.getFileHandle('dest')).getFile()).text()).toBe(contents);
  });

  it('propagates a registry lookup failure before changing an existing file', async () => {
    await wesh.vfs.symlink({ path: '/unrelated', targetPath: '/target' });
    const source = await createMoveFile({ parent: rootHandle, name: 'source', contents: 'moved' });
    const destination = await createMoveFile({ parent: rootHandle, name: 'dest', contents: 'original' });
    const system = await rootHandle.getDirectoryHandle(WESH_SYSTEM_DIR);
    const metadata = await system.getDirectoryHandle(METADATA_DIR);
    const getFile = metadata.getFileHandle.bind(metadata);
    vi.spyOn(metadata, 'getFileHandle').mockImplementation(async (name, options) => {
      if (name === 'dest') {
        throw new DOMException('lookup denied', 'NotAllowedError');
      }
      return getFile(name, options);
    });

    await expect(wesh.vfs.rename({ oldPath: '/source', newPath: '/dest' })).rejects.toThrow('lookup denied');
    expect(await (await source.getFile()).text()).toBe('moved');
    expect(await (await destination.getFile()).text()).toBe('original');
  });

  it('renames files in a directory whose registry contains entries for its children', async () => {
    const directory = await rootHandle.getDirectoryHandle('sub', { create: true });
    await createMoveFile({ parent: directory, name: 'regular', contents: 'payload' });
    await wesh.vfs.symlink({ path: '/sub/link', targetPath: 'regular' });

    await wesh.vfs.rename({ oldPath: '/sub/link', newPath: '/sub/renamed-link' });
    await wesh.vfs.rename({ oldPath: '/sub/regular', newPath: '/sub/renamed-file' });

    expect(await wesh.vfs.readlink({ path: '/sub/renamed-link' })).toBe('regular');
    expect(await (await (await directory.getFileHandle('renamed-file')).getFile()).text()).toBe('payload');
  });

  it('uses a same-mount native move without reading the file contents', async () => {
    const source = await createMoveFile({ parent: rootHandle, name: 'source', contents: 'moved' });
    const read = vi.spyOn(source, 'getFile');
    const move = vi.fn(async () => {
      await createMoveFile({ parent: rootHandle, name: 'dest', contents: 'moved' });
      vi.spyOn(source, 'isSameEntry').mockResolvedValueOnce(true);
      await rootHandle.removeEntry('source');
    });
    Object.assign(source, { move });

    await wesh.vfs.rename({ oldPath: '/source', newPath: '/dest' });

    expect(move).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
    expect(await (await (await rootHandle.getFileHandle('dest')).getFile()).text()).toBe('moved');
  });

  it('copies to a vacant destination after a native move reports non-support', async () => {
    const source = await createMoveFile({ parent: rootHandle, name: 'source', contents: 'moved' });
    const move = vi.fn(async () => {
      throw new DOMException('move unavailable', 'NotSupportedError');
    });
    Object.assign(source, { move });

    await wesh.vfs.rename({ oldPath: '/source', newPath: '/dest' });

    expect(move).toHaveBeenCalledOnce();
    await expect(rootHandle.getFileHandle('source')).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(await (await (await rootHandle.getFileHandle('dest')).getFile()).text()).toBe('moved');
  });

  it('keeps a checked writer when an unsupported native move and its fallback make no changes', async () => {
    const path = '/source';
    const source = await createMoveFile({ parent: rootHandle, name: 'source', contents: 'original' });
    Object.assign(source, {
      async move() {
        throw new DOMException('move unavailable', 'NotSupportedError');
      },
    });
    const lookup = await wesh.vfs.tryLookupEntryWithoutFollowingSymlinks({ path });
    if (lookup === undefined) {
      throw new Error('Expected a lookup for the source');
    }
    try {
      const result = await wesh.vfs.tryCreateFileWriterEfficiently({ lookup, mode: 'truncate' });
      if (result.kind !== 'writer') {
        throw new Error('Expected a writable stream');
      }
      try {
        await result.writer.write({ chunk: new TextEncoder().encode('archive data') });
        using _failFallback = vi.spyOn(source, 'getFile').mockRejectedValueOnce(new Error('Cannot read source'));
        await expect(wesh.vfs.rename({ oldPath: path, newPath: '/dest' })).rejects.toThrow('Cannot read source');
        await expect(rootHandle.getFileHandle('dest')).rejects.toMatchObject({ name: 'NotFoundError' });
        await result.writer.close();
        await expect((await source.getFile()).text()).resolves.toBe('archive data');
      } finally {
        await result.writer.abort({ reason: undefined });
      }
    } finally {
      lookup.release();
    }
  });

  it('keeps both entries when a failed native move has already created the destination', async () => {
    const source = await createMoveFile({ parent: rootHandle, name: 'source', contents: 'moved' });
    Object.assign(source, {
      async move() {
        await createMoveFile({ parent: rootHandle, name: 'dest', contents: 'present' });
        throw new DOMException('move unavailable', 'NotSupportedError');
      },
    });

    await expect(wesh.vfs.rename({ oldPath: '/source', newPath: '/dest' })).rejects.toMatchObject({ name: 'NotSupportedError' });
    expect(await (await (await rootHandle.getFileHandle('dest')).getFile()).text()).toBe('present');
    expect(await (await source.getFile()).text()).toBe('moved');
  });

  it('refuses mixed registry replacement with both entries intact', async () => {
    await createMoveFile({ parent: rootHandle, name: 'plain', contents: 'payload' });
    await wesh.vfs.symlink({ path: '/link', targetPath: '/target' });

    await expect(wesh.vfs.rename({ oldPath: '/link', newPath: '/plain' })).rejects.toThrow('registry entry');
    await expect(wesh.vfs.rename({ oldPath: '/plain', newPath: '/link' })).rejects.toThrow('registry entry');
    expect(await wesh.vfs.readlink({ path: '/link' })).toBe('/target');
    expect(await (await (await rootHandle.getFileHandle('plain')).getFile()).text()).toBe('payload');
  });

  it('distinguishes registry identities that use the same backing file through two mounts', async () => {
    const directory = await rootHandle.getDirectoryHandle('real', { create: true });
    await wesh.vfs.mount({ path: '/alias', handle: directory as unknown as FileSystemDirectoryHandle, readOnly: false });
    await wesh.vfs.mknod({ path: '/real/item', type: 'fifo' });

    await expect(wesh.vfs.rename({ oldPath: '/real/item', newPath: '/alias/item' })).rejects.toThrow('registry entry');
    const system = await directory.getDirectoryHandle(WESH_SYSTEM_DIR, { create: true });
    const metadata = await system.getDirectoryHandle(METADATA_DIR, { create: true });
    await createMoveFile({ parent: metadata, name: 'item', contents: JSON.stringify({ type: 'chardev', mode: 0o644 }) });
    await expect(wesh.vfs.rename({ oldPath: '/real/item', newPath: '/alias/item' })).rejects.toThrow('different registry entries');

    expect((await wesh.vfs.lstat({ path: '/real/item' })).type).toBe('fifo');
    expect((await wesh.vfs.lstat({ path: '/alias/item' })).type).toBe('chardev');
  });

  it.each([false, true])('keeps live FIFO descriptors distinct when replacing its name, backing failure %s', async failBacking => {
    await wesh.vfs.mknod({ path: '/source', type: 'fifo' });
    await wesh.vfs.mknod({ path: '/dest', type: 'fifo' });
    const flags = { access: 'read-write', creation: 'never', truncate: 'preserve', append: 'preserve' } as const;
    const source = await wesh.vfs.open({ path: '/source', flags });
    const dest = await wesh.vfs.open({ path: '/dest', flags });
    await source.write({ buffer: new Uint8Array([11]) });
    await dest.write({ buffer: new Uint8Array([22]) });

    if (failBacking) {
      await createMoveFile({ parent: rootHandle, name: 'source', contents: 'backing bytes' });
      const backing = await rootHandle.getFileHandle('dest');
      const writer = await backing.createWritable();
      vi.spyOn(backing, 'createWritable').mockResolvedValueOnce(writer);
      vi.spyOn(writer, 'close').mockRejectedValueOnce(new Error('backing close failed'));
      await expect(wesh.vfs.rename({ oldPath: '/source', newPath: '/dest' })).rejects.toThrow('backing close failed');
      expect((await wesh.vfs.lstat({ path: '/source' })).type).toBe('fifo');
    } else {
      await wesh.vfs.rename({ oldPath: '/source', newPath: '/dest' });
    }
    const renamed = await wesh.vfs.open({ path: '/dest', flags });
    try {
      const buffer = new Uint8Array(1);
      expect(await renamed.read({ buffer })).toEqual({ bytesRead: 1 });
      expect(buffer[0]).toBe(11);
      expect(await dest.read({ buffer })).toEqual({ bytesRead: 1 });
      expect(buffer[0]).toBe(22);
      if (failBacking) {
        await wesh.vfs.rename({ oldPath: '/source', newPath: '/dest' });
      }
      await wesh.vfs.mknod({ path: '/source', type: 'fifo' });
      const recreated = await wesh.vfs.open({ path: '/source', flags });
      await using _recreated = { [Symbol.asyncDispose]: () => recreated.close() };
      await source.write({ buffer: new Uint8Array([33]) });
      await recreated.write({ buffer: new Uint8Array([44]) });
      expect(await renamed.read({ buffer })).toEqual({ bytesRead: 1 });
      expect(buffer[0]).toBe(33);
      expect(await recreated.read({ buffer })).toEqual({ bytesRead: 1 });
      expect(buffer[0]).toBe(44);
    } finally {
      await Promise.all([source.close(), dest.close(), renamed.close()]);
    }
  });

  it('rejects rmdir on regular files', async () => {
    const fileHandle = await rootHandle.getFileHandle('plain.txt', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write('plain');
    await writable.close();

    await expect(wesh.vfs.rmdir({ path: '/plain.txt' })).rejects.toThrow('Not a directory');
  });

  it('preserves registry-backed node types across rename', async () => {
    await wesh.vfs.mknod({ path: '/pipe.old', type: 'fifo' });

    await wesh.vfs.rename({ oldPath: '/pipe.old', newPath: '/pipe.new' });

    await expect(wesh.vfs.stat({ path: '/pipe.old' })).rejects.toThrow();

    const stat = await wesh.vfs.stat({ path: '/pipe.new' });
    expect(stat.type).toBe('fifo');

    const listed = await execute({ script: 'ls -lF /' });
    expect(listed.stdout.text).toContain('pipe.new|');
    expect(listed.stderr.text).toBe('');
    expect(listed.result.exitCode).toBe(0);
  });

  it('creates directories in traversal order and keeps the actual parent', async () => {
    await rootHandle.getDirectoryHandle('tree', { create: true });
    await wesh.vfs.mkdir({ path: '/tree/inner', recursive: false });
    await wesh.vfs.symlink({ path: '/up', targetPath: 'tree/inner' });

    await wesh.vfs.mkdir({ path: '/up/../first/../second', recursive: true });
    expect((await wesh.vfs.stat({ path: '/tree/first' })).type).toBe('directory');
    expect((await wesh.vfs.stat({ path: '/tree/second' })).type).toBe('directory');
    await expect(wesh.vfs.stat({ path: '/second' })).rejects.toThrow();
    await expect(wesh.vfs.mkdir({ path: '/missing/../new', recursive: false })).rejects.toThrow();
    await expect(wesh.vfs.stat({ path: '/new' })).rejects.toThrow();
  });

  it('reuses the resolved parent when making a single directory', async () => {
    const directory = await rootHandle.getDirectoryHandle('tree', { create: true });
    using lookup = vi.spyOn(rootHandle, 'getDirectoryHandle');

    await wesh.vfs.mkdir({ path: '/tree/new', recursive: false });

    expect(lookup.mock.calls.filter(([name]) => name === 'tree')).toHaveLength(1);
    expect(await directory.getDirectoryHandle('new')).toBeDefined();
  });

  it('creates special entries in the grant reached through an aliased parent', async () => {
    const volume = new MockFileSystemDirectoryHandle({ name: 'volume' });
    await wesh.vfs.mount({ path: '/volume', handle: volume as unknown as FileSystemDirectoryHandle, readOnly: false });
    await wesh.vfs.mkdir({ path: '/volume/inner', recursive: false });
    await wesh.vfs.symlink({ path: '/parent', targetPath: '/volume/inner' });

    await wesh.vfs.symlink({ path: '/parent/../link', targetPath: 'target' });
    await wesh.vfs.mknod({ path: '/parent/pipe', type: 'fifo' });

    expect(await wesh.vfs.readlink({ path: '/volume/link' })).toBe('target');
    expect(await wesh.vfs.readlink({ path: '/parent/../link' })).toBe('target');
    expect((await wesh.vfs.lstat({ path: '/volume/inner/pipe' })).type).toBe('fifo');
    expect((await wesh.vfs.lstat({ path: '/parent/pipe' })).type).toBe('fifo');
    await expect(rootHandle.getFileHandle('link')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('checks the resolved mount and the existing entry before creating registry data', async () => {
    const volume = new MockFileSystemDirectoryHandle({ name: 'volume' });
    await wesh.vfs.mount({ path: '/ro', handle: volume as unknown as FileSystemDirectoryHandle, readOnly: true });
    await wesh.vfs.symlink({ path: '/parent', targetPath: '/ro' });
    const old = await createMoveFile({ parent: rootHandle, name: 'regular', contents: 'keep' });

    await expect(wesh.vfs.symlink({ path: '/parent/link', targetPath: 'target' })).rejects.toThrow('Read-only filesystem');
    await expect(wesh.vfs.mknod({ path: '/parent/pipe', type: 'fifo' })).rejects.toThrow('Read-only filesystem');
    await expect(volume.getFileHandle('link')).rejects.toThrow();
    await expect(volume.getFileHandle('pipe')).rejects.toThrow();
    await expect(wesh.vfs.mknod({ path: '/./regular', type: 'fifo' })).rejects.toThrow('File exists');
    expect((await wesh.vfs.lstat({ path: '/regular' })).type).toBe('file');
    expect(await (await old.getFile()).text()).toBe('keep');
    await wesh.vfs.mknod({ path: '/plain', type: 'file' });
    expect((await wesh.vfs.lstat({ path: '/plain' })).type).toBe('file');
  });

  it('cleans up an unpublished entry after its metadata writer fails', async () => {
    const system = await rootHandle.getDirectoryHandle(WESH_SYSTEM_DIR, { create: true });
    const metadata = await system.getDirectoryHandle(METADATA_DIR, { create: true });
    const getFileHandle = metadata.getFileHandle.bind(metadata);
    let injected = false;
    using override = vi.spyOn(metadata, 'getFileHandle').mockImplementation(async (name, options) => {
      const handle = await getFileHandle(name, options);
      if (options?.create && name === 'link' && !injected) {
        injected = true;
        const writer = await handle.createWritable();
        vi.spyOn(writer, 'close').mockRejectedValueOnce(new Error('metadata close failed'));
        vi.spyOn(handle, 'createWritable').mockResolvedValueOnce(writer);
      }
      return handle;
    });

    await expect(wesh.vfs.symlink({ path: '/link', targetPath: 'target' })).rejects.toThrow('metadata close failed');
    expect(override).toHaveBeenCalledWith('link', { create: true });
    await expect(metadata.getFileHandle('link')).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(rootHandle.getFileHandle('link')).rejects.toMatchObject({ name: 'NotFoundError' });
    await wesh.vfs.symlink({ path: '/link', targetPath: 'target' });
    expect(await wesh.vfs.readlink({ path: '/link' })).toBe('target');
  });

  it('preserves ordinary contents written before metadata is published', async () => {
    const getFileHandle = rootHandle.getFileHandle.bind(rootHandle);
    using override = vi.spyOn(rootHandle, 'getFileHandle').mockImplementation(async (name, options) => {
      const handle = await getFileHandle(name, options);
      if (options?.create && name === 'link') {
        const writer = await handle.createWritable();
        await writer.write('ordinary contents');
        await writer.close();
      }
      return handle;
    });

    await expect(wesh.vfs.symlink({ path: '/link', targetPath: 'target' })).rejects.toThrow('Registry destination changed');
    expect(override).toHaveBeenCalledWith('link', { create: true });
    expect((await wesh.vfs.lstat({ path: '/link' })).type).toBe('file');
    expect(await (await (await getFileHandle('link')).getFile()).text()).toBe('ordinary contents');
  });

  it('distinguishes stat from lstat for symlinks and follows symlinks on open', async () => {
    const fileHandle = await rootHandle.getFileHandle('note.txt', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write('linked content');
    await writable.close();

    await wesh.vfs.symlink({
      path: '/note.link',
      targetPath: '/note.txt',
    });

    const stat = await wesh.vfs.stat({ path: '/note.link' });
    expect(stat.type).toBe('file');
    expect(stat.size).toBe('linked content'.length);

    const lstat = await wesh.vfs.lstat({ path: '/note.link' });
    expect(lstat.type).toBe('symlink');
    expect(lstat.size).toBe('/note.txt'.length);

    const read = await execute({ script: 'cat /note.link' });
    expect(read.stdout.text).toBe('linked content');
    expect(read.stderr.text).toBe('');
    expect(read.result.exitCode).toBe(0);
  });

  it('follows symlinked directories for readDir and cd', async () => {
    const realDir = await rootHandle.getDirectoryHandle('real', { create: true });
    const nestedFile = await realDir.getFileHandle('child.txt', { create: true });
    const writable = await nestedFile.createWritable();
    await writable.write('child');
    await writable.close();

    await wesh.vfs.symlink({
      path: '/real.link',
      targetPath: '/real',
    });

    const entries = [];
    for await (const entry of wesh.vfs.readDir({ path: '/real.link' })) {
      entries.push(entry);
    }
    expect(entries).toEqual([{ name: 'child.txt', type: 'file', fullPath: '/real/child.txt' }]);

    const changed = await execute({ script: 'cd /real.link; pwd' });
    expect(changed.stdout.text).toBe('/real.link\n');
    expect(changed.stderr.text).toBe('');
    expect(changed.result.exitCode).toBe(0);
  });

  it('unlinks symlinks without removing their targets and rejects rmdir on symlinks', async () => {
    const realDir = await rootHandle.getDirectoryHandle('dir', { create: true });
    const nestedFile = await realDir.getFileHandle('keep.txt', { create: true });
    const writable = await nestedFile.createWritable();
    await writable.write('keep');
    await writable.close();

    await wesh.vfs.symlink({
      path: '/dir.link',
      targetPath: '/dir',
    });

    await expect(wesh.vfs.rmdir({ path: '/dir.link' })).rejects.toThrow('Not a directory');

    await wesh.vfs.unlink({ path: '/dir.link' });

    await expect(wesh.vfs.lstat({ path: '/dir.link' })).rejects.toThrow();
    const entries = [];
    for await (const entry of wesh.vfs.readDir({ path: '/dir' })) {
      entries.push(entry);
    }
    expect(entries).toEqual([{ name: 'keep.txt', type: 'file', fullPath: '/dir/keep.txt' }]);
  });

  it('leaves a new file created at the symlink name during unlink', async () => {
    await wesh.vfs.symlink({ path: '/link', targetPath: '/target' });
    const system = await rootHandle.getDirectoryHandle(WESH_SYSTEM_DIR);
    const metadata = await system.getDirectoryHandle(METADATA_DIR);
    const removeEntry = metadata.removeEntry.bind(metadata);
    using replacement = vi.spyOn(metadata, 'removeEntry').mockImplementationOnce(async name => {
      await removeEntry(name);
      await rootHandle.removeEntry('link');
      const file = await rootHandle.getFileHandle('link', { create: true });
      const writable = await file.createWritable();
      await writable.write('replacement');
      await writable.close();
    });

    const { result, stderr } = await execute({ script: 'rm /link' });

    expect(result.exitCode).toBe(1);
    expect(stderr.text).toContain('Source backing changed');
    const file = await rootHandle.getFileHandle('link');
    expect(await (await file.getFile()).text()).toBe('replacement');
    expect(replacement).toHaveBeenCalledOnce();
  });

  it('renames symlinks without renaming their targets', async () => {
    const fileHandle = await rootHandle.getFileHandle('target.txt', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write('target');
    await writable.close();

    await wesh.vfs.symlink({
      path: '/target.link',
      targetPath: '/target.txt',
    });

    await wesh.vfs.rename({
      oldPath: '/target.link',
      newPath: '/renamed.link',
    });

    await expect(wesh.vfs.lstat({ path: '/target.link' })).rejects.toThrow();
    expect((await wesh.vfs.lstat({ path: '/renamed.link' })).type).toBe('symlink');
    expect((await wesh.vfs.stat({ path: '/renamed.link' })).type).toBe('file');
    expect((await wesh.vfs.stat({ path: '/target.txt' })).type).toBe('file');
  });

  it('keeps dangling symlinks visible to lstat but not stat/open', async () => {
    await wesh.vfs.symlink({
      path: '/dangling.link',
      targetPath: '/missing.txt',
    });

    const lstat = await wesh.vfs.lstat({ path: '/dangling.link' });
    expect(lstat.type).toBe('symlink');

    await expect(wesh.vfs.stat({ path: '/dangling.link' })).rejects.toThrow();
    await expect(wesh.vfs.open({
      path: '/dangling.link',
      flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
    })).rejects.toThrow();
  });

  it.each(['open', 'efficient writer'] as const)('creates a dangling link target through %s', async operation => {
    const output = new MockFileSystemDirectoryHandle({ name: 'output' });
    await wesh.vfs.mount({ path: '/output', handle: output as unknown as FileSystemDirectoryHandle, readOnly: false });
    await wesh.vfs.symlink({ path: '/link', targetPath: 'output/target' });
    const fallback = new TextEncoder().encode('saved');
    switch (operation) {
    case 'open': {
      const handle = await wesh.vfs.open({
        path: '/link',
        flags: { access: 'write', creation: 'if-needed', truncate: 'truncate', append: 'preserve' },
      });
      await handle.write({ buffer: fallback });
      await handle.close();
      break;
    }
    case 'efficient writer': {
      const result = await wesh.vfs.tryCreateFileWriterEfficiently({ path: '/link', mode: 'truncate' });
      if (result.kind !== 'writer') {
        throw new Error('Expected an efficient writer');
      }
      await result.writer.write({ chunk: fallback });
      await result.writer.close();
      break;
    }
    default: {
      const _ex: never = operation;
      throw new Error(`Unhandled operation: ${_ex}`);
    }
    }
    expect(await wesh.vfs.readlink({ path: '/link' })).toBe('output/target');
    expect((await (await rootHandle.getFileHandle('link')).getFile()).size).toBe(0);
    expect(await (await (await output.getFileHandle('target')).getFile()).text()).toBe('saved');
  });

  it('rejects exclusive creation on a dangling symbolic link', async () => {
    await wesh.vfs.symlink({ path: '/link', targetPath: 'absent' });

    await expect(wesh.vfs.open({
      path: '/link',
      flags: { access: 'write', creation: 'always', truncate: 'truncate', append: 'preserve' },
    })).rejects.toThrow('File exists');
    await expect(rootHandle.getFileHandle('absent')).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(await wesh.vfs.readlink({ path: '/link' })).toBe('absent');
  });

  it('rejects creation through a dangling symbolic link into a read-only mount', async () => {
    const output = new MockFileSystemDirectoryHandle({ name: 'output' });
    await wesh.vfs.mount({ path: '/output', handle: output as unknown as FileSystemDirectoryHandle, readOnly: true });
    await wesh.vfs.symlink({ path: '/link', targetPath: '/output/target' });

    await expect(wesh.vfs.open({
      path: '/link',
      flags: { access: 'write', creation: 'if-needed', truncate: 'truncate', append: 'preserve' },
    })).rejects.toThrow('Read-only file system');
    await expect(wesh.vfs.tryCreateFileWriterEfficiently({ path: '/link', mode: 'truncate' }))
      .rejects.toThrow('Read-only file system');
    await expect(output.getFileHandle('target')).rejects.toMatchObject({ name: 'NotFoundError' });
    expect((await (await rootHandle.getFileHandle('link')).getFile()).size).toBe(0);
  });

  it('does not retry a denied writer lookup as creation', async () => {
    const file = await rootHandle.getFileHandle('protected', { create: true });
    const writable = await file.createWritable();
    await writable.write('old data');
    await writable.close();
    const getFileHandle = rootHandle.getFileHandle.bind(rootHandle);
    const lookup = vi.spyOn(rootHandle, 'getFileHandle').mockImplementation(async (name, options) => {
      if (name === 'protected' && !options?.create) {
        throw new DOMException('Denied', 'NotAllowedError');
      }
      return getFileHandle(name, options);
    });

    await expect(wesh.vfs.tryCreateFileWriterEfficiently({ path: '/protected', mode: 'truncate' }))
      .rejects.toThrow('Permission denied');
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(await (await file.getFile()).text()).toBe('old data');
  });

  it('reuses the native parent lookup when opening a new file', async () => {
    await rootHandle.getDirectoryHandle('directory', { create: true });
    using getDirectory = vi.spyOn(rootHandle, 'getDirectoryHandle');

    const result = await wesh.vfs.tryCreateFileWriterEfficiently({ path: '/directory/new', mode: 'truncate' });
    expect(result.kind).toBe('writer');
    if (result.kind === 'writer') {
      await result.writer.close();
    }

    expect(getDirectory.mock.calls.filter(([name]) => name === 'directory')).toHaveLength(1);
  });

  it('resolves a link before moving to its parent for stat, open and rename', async () => {
    const directory = await rootHandle.getDirectoryHandle('tree', { create: true });
    await directory.getDirectoryHandle('inner', { create: true });
    const file = await directory.getFileHandle('target', { create: true });
    const shadow = await rootHandle.getFileHandle('target', { create: true });
    await wesh.vfs.symlink({ path: '/link', targetPath: 'tree/inner' });
    await wesh.vfs.symlink({ path: '/target-link', targetPath: 'link/../target' });

    expect((await wesh.vfs.resolve({ path: '/target-link' })).fullPath).toBe('/tree/target');
    const handle = await wesh.vfs.open({
      path: '/link/../target',
      flags: { access: 'write', creation: 'if-needed', truncate: 'truncate', append: 'preserve' },
    });
    await handle.write({ buffer: new TextEncoder().encode('inside') });
    await handle.close();
    expect(await (await file.getFile()).text()).toBe('inside');
    expect((await shadow.getFile()).size).toBe(0);

    await wesh.vfs.rename({ oldPath: '/link/../target', newPath: '/link/../renamed' });
    expect(await (await (await directory.getFileHandle('renamed')).getFile()).text()).toBe('inside');
    expect(await rootHandle.getFileHandle('target')).toBe(shadow);
    await wesh.vfs.unlink({ path: '/link/../renamed' });
    await expect(directory.getFileHandle('renamed')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('rejects missing and non-directory components before a dot component', async () => {
    const file = await rootHandle.getFileHandle('regular', { create: true });
    await expect(wesh.vfs.stat({ path: '/regular/.' })).rejects.toThrow('Not a directory');
    await expect(wesh.vfs.lstat({ path: '/regular/..' })).rejects.toThrow('Not a directory');
    await expect(wesh.vfs.stat({ path: '/missing/../regular' })).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(wesh.vfs.tryCreateFileWriterEfficiently({ path: '/missing/../new', mode: 'truncate' }))
      .rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(wesh.vfs.rename({ oldPath: '/regular/', newPath: '/new' })).rejects.toThrow('Not a directory');
    await expect(rootHandle.getFileHandle('new')).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(await rootHandle.getFileHandle('regular')).toBe(file);
  });

  it('keeps one symlink limit across successive parent components', async () => {
    await rootHandle.getDirectoryHandle('directory', { create: true });
    await rootHandle.getFileHandle('file', { create: true });
    await wesh.vfs.symlink({ path: '/link', targetPath: '/directory' });

    expect((await wesh.vfs.stat({ path: `/${'link/../'.repeat(40)}file` })).type).toBe('file');
    await expect(wesh.vfs.stat({ path: `/${'link/../'.repeat(41)}file` })).rejects.toThrow('Too many levels');
  });

  it('resolves an intervening dot without looking up the ordinary parent twice', async () => {
    const directory = await rootHandle.getDirectoryHandle('directory', { create: true });
    await directory.getFileHandle('file', { create: true });
    using getDirectory = vi.spyOn(rootHandle, 'getDirectoryHandle');

    expect((await wesh.vfs.resolveEntry({ path: '/directory/./file', finalSymlinkTreatment: 'follow' })).type).toBe('file');
    expect(getDirectory.mock.calls.filter(([name]) => name === 'directory')).toHaveLength(1);
  });

  it('requires a directory when a file pathname or link target ends with a slash', async () => {
    await rootHandle.getFileHandle('regular', { create: true });
    await wesh.vfs.symlink({ path: '/directory-required', targetPath: 'regular/' });
    await wesh.vfs.symlink({ path: '/missing-directory', targetPath: 'missing/' });

    await expect(wesh.vfs.stat({ path: '/regular/' })).rejects.toThrow('Not a directory');
    await expect(wesh.vfs.tryCreateFileWriterEfficiently({ path: '/directory-required', mode: 'truncate' }))
      .rejects.toThrow('Not a directory');
    await expect(wesh.vfs.tryCreateFileWriterEfficiently({ path: '/missing-directory', mode: 'truncate' })).rejects.toThrow();
    await expect(rootHandle.getFileHandle('missing')).rejects.toMatchObject({ name: 'NotFoundError' });
    expect((await (await rootHandle.getFileHandle('missing-directory')).getFile()).size).toBe(0);

    await rootHandle.getDirectoryHandle('folder', { create: true });
    await wesh.vfs.symlink({ path: '/folder-link', targetPath: 'folder' });
    expect((await wesh.vfs.lstat({ path: '/folder-link/' })).type).toBe('directory');
  });

  it('rm -r removes a symlinked directory entry without traversing into the target', async () => {
    const realDir = await rootHandle.getDirectoryHandle('tree', { create: true });
    const nestedFile = await realDir.getFileHandle('leaf.txt', { create: true });
    const writable = await nestedFile.createWritable();
    await writable.write('leaf');
    await writable.close();

    await wesh.vfs.symlink({
      path: '/tree.link',
      targetPath: '/tree',
    });

    const removed = await execute({ script: 'rm -r /tree.link' });
    expect(removed.stderr.text).toBe('');
    expect(removed.result.exitCode).toBe(0);

    await expect(wesh.vfs.lstat({ path: '/tree.link' })).rejects.toThrow();
    const treeEntries = [];
    for await (const entry of wesh.vfs.readDir({ path: '/tree' })) {
      treeEntries.push(entry);
    }
    expect(treeEntries.map(entry => entry.name)).toEqual(['leaf.txt']);
  });
});

describe('WeshVFS — getNativeHandle / getReadOnlyForPath / optional root', () => {
  it('getNativeHandle returns a real handle for a mounted directory', async () => {
    const mount = new MockFileSystemDirectoryHandle({ name: 'mount' });
    await mount.getFileHandle('file.txt', { create: true });
    const vfs = new WeshVFS({ rootHandle: undefined });
    await vfs.mount({ path: '/data', handle: mount as unknown as FileSystemDirectoryHandle, readOnly: false });

    const handle = await vfs.getNativeHandle({ path: '/data' });
    expect(handle).not.toBeNull();
    expect(handle!.kind).toBe('directory');
  });

  it('getNativeHandle returns null for a synthetic intermediate directory', async () => {
    const mount = new MockFileSystemDirectoryHandle({ name: 'mount' });
    const vfs = new WeshVFS({ rootHandle: undefined });
    await vfs.mount({ path: '/home/user/v1', handle: mount as unknown as FileSystemDirectoryHandle, readOnly: false });

    expect(await vfs.getNativeHandle({ path: '/home' })).toBeNull();
    expect(await vfs.getNativeHandle({ path: '/home/user' })).toBeNull();
  });

  it('getNativeHandle returns a file handle for a real file inside a mount', async () => {
    const mount = new MockFileSystemDirectoryHandle({ name: 'mount' });
    await mount.getFileHandle('note.txt', { create: true });
    const vfs = new WeshVFS({ rootHandle: undefined });
    await vfs.mount({ path: '/data', handle: mount as unknown as FileSystemDirectoryHandle, readOnly: false });

    const handle = await vfs.getNativeHandle({ path: '/data/note.txt' });
    expect(handle).not.toBeNull();
    expect(handle!.kind).toBe('file');
  });

  it('getReadOnlyForPath returns the mount readOnly flag for paths inside a mount', async () => {
    const m1 = new MockFileSystemDirectoryHandle({ name: 'm1' });
    const m2 = new MockFileSystemDirectoryHandle({ name: 'm2' });
    const vfs = new WeshVFS({ rootHandle: undefined });
    await vfs.mount({ path: '/home/user/rw', handle: m1 as unknown as FileSystemDirectoryHandle, readOnly: false });
    await vfs.mount({ path: '/home/user/ro', handle: m2 as unknown as FileSystemDirectoryHandle, readOnly: true });

    expect(vfs.getReadOnlyForPath({ path: '/home/user/rw' })).toBe(false);
    expect(vfs.getReadOnlyForPath({ path: '/home/user/ro' })).toBe(true);
  });

  it('getReadOnlyForPath returns true for synthetic directories outside any mount', async () => {
    const mount = new MockFileSystemDirectoryHandle({ name: 'mount' });
    const vfs = new WeshVFS({ rootHandle: undefined });
    await vfs.mount({ path: '/home/user/v1', handle: mount as unknown as FileSystemDirectoryHandle, readOnly: false });

    expect(vfs.getReadOnlyForPath({ path: '/' })).toBe(true);
    expect(vfs.getReadOnlyForPath({ path: '/home' })).toBe(true);
    expect(vfs.getReadOnlyForPath({ path: '/home/user' })).toBe(true);
  });

  it('VFS with no rootHandle synthesises directories for nested mounts', async () => {
    const v1 = new MockFileSystemDirectoryHandle({ name: 'v1' });
    const v2 = new MockFileSystemDirectoryHandle({ name: 'v2' });
    const vfs = new WeshVFS({ rootHandle: undefined });
    await vfs.mount({ path: '/home/user/v1', handle: v1 as unknown as FileSystemDirectoryHandle, readOnly: false });
    await vfs.mount({ path: '/home/user/v2', handle: v2 as unknown as FileSystemDirectoryHandle, readOnly: true });

    const rootEntries: string[] = [];
    for await (const e of vfs.readDir({ path: '/' })) {
      rootEntries.push(e.name);
    }
    expect(rootEntries).toEqual(['home']);

    const userEntries: string[] = [];
    for await (const e of vfs.readDir({ path: '/home/user' })) {
      userEntries.push(e.name);
    }
    expect(userEntries.sort()).toEqual(['v1', 'v2']);
  });

  it('VFS with no rootHandle does not expose /dev special files', async () => {
    const vfs = new WeshVFS({ rootHandle: undefined });
    const mount = new MockFileSystemDirectoryHandle({ name: 'mount' });
    await vfs.mount({ path: '/data', handle: mount as unknown as FileSystemDirectoryHandle, readOnly: false });

    const rootEntries: string[] = [];
    for await (const e of vfs.readDir({ path: '/' })) {
      rootEntries.push(e.name);
    }
    expect(rootEntries).toEqual(['data']);
    expect(rootEntries).not.toContain('dev');
  });
});

describe('WeshVFS virtual mounts', () => {
  it('exposes virtual mounts through synthetic parent directories', async () => {
    const vfs = new WeshVFS({ rootHandle: undefined });
    const provider: WeshVirtualMountProvider = {
      async open({ path, flags, mode }: { path: string, flags: WeshOpenFlags, mode?: number }) {
        void path;
        void flags;
        void mode;
        return createVirtualFileHandle({ text: '' });
      },
      async stat({ path }: { path: string }) {
        return path === '/sys/fs/naidan'
          ? createDirectoryStat({ size: 0 })
          : createFileStat({ size: 0 });
      },
      async lstat({ path }: { path: string }) {
        return path === '/sys/fs/naidan'
          ? createDirectoryStat({ size: 0 })
          : createFileStat({ size: 0 });
      },
      async *readDir({ path }: { path: string }) {
        if (path === '/sys/fs/naidan') {
          yield { name: 'version', type: 'file', fullPath: '/sys/fs/naidan/version' };
        }
      },
      async readlink({ path }: { path: string }) {
        return path;
      },
    };

    vfs.mountVirtual({
      path: '/sys/fs/naidan',
      readOnly: true,
      provider,
    });

    const rootEntries: string[] = [];
    for await (const entry of vfs.readDir({ path: '/' })) {
      rootEntries.push(entry.name);
    }
    expect(rootEntries).toEqual(['sys']);

    const sysEntries: string[] = [];
    for await (const entry of vfs.readDir({ path: '/sys' })) {
      sysEntries.push(entry.name);
    }
    expect(sysEntries).toEqual(['fs']);

    const fsEntries: string[] = [];
    for await (const entry of vfs.readDir({ path: '/sys/fs' })) {
      fsEntries.push(entry.name);
    }
    expect(fsEntries).toEqual(['naidan']);
  });

  it('delegates file operations to the virtual provider', async () => {
    const nativeRoot = new MockFileSystemDirectoryHandle({ name: 'root' });
    const vfs = new WeshVFS({ rootHandle: nativeRoot as unknown as FileSystemDirectoryHandle });
    const open = vi.fn(async ({ path }: { path: string, flags: WeshOpenFlags, mode?: number }) => {
      expect(path).toBe('/sys/fs/naidan/version');
      return createVirtualFileHandle({ text: 'naidan-sysfs-v1\n' });
    });
    const stat = vi.fn(async ({ path }: { path: string }) => {
      if (path === '/sys/fs/naidan/current-chat') {
        return createSymlinkStat({ size: '/sys/fs/naidan/chats/chat-1'.length });
      }
      if (path === '/sys/fs/naidan') {
        return createDirectoryStat({ size: 0 });
      }
      return createFileStat({ size: 'naidan-sysfs-v1\n'.length });
    });
    const lstat = vi.fn(async ({ path }: { path: string }) => {
      if (path === '/sys/fs/naidan/current-chat') {
        return createSymlinkStat({ size: '/sys/fs/naidan/chats/chat-1'.length });
      }
      if (path === '/sys/fs/naidan') {
        return createDirectoryStat({ size: 0 });
      }
      return createFileStat({ size: 'naidan-sysfs-v1\n'.length });
    });
    const readlink = vi.fn(async ({ path }: { path: string }) => {
      expect(path).toBe('/sys/fs/naidan/current-chat');
      return '/sys/fs/naidan/chats/chat-1';
    });
    const provider: WeshVirtualMountProvider = {
      open,
      stat,
      lstat,
      async *readDir({ path }: { path: string }) {
        if (path === '/sys/fs/naidan') {
          yield { name: 'version', type: 'file', fullPath: '/sys/fs/naidan/version' };
          yield { name: 'current-chat', type: 'symlink', fullPath: '/sys/fs/naidan/current-chat' };
        }
      },
      readlink,
    };

    vfs.mountVirtual({
      path: '/sys/fs/naidan',
      readOnly: true,
      provider,
    });

    const handle = await vfs.open({
      path: '/sys/fs/naidan/version',
      flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
    });
    const buffer = new Uint8Array(32);
    const readResult = await handle.read({ buffer });
    await handle.close();

    expect(new TextDecoder().decode(buffer.subarray(0, readResult.bytesRead))).toBe('naidan-sysfs-v1\n');
    expect((await vfs.stat({ path: '/sys/fs/naidan/version' })).type).toBe('file');
    expect((await vfs.lstat({ path: '/sys/fs/naidan/current-chat' })).type).toBe('symlink');
    expect(await vfs.readlink({ path: '/sys/fs/naidan/current-chat' })).toBe('/sys/fs/naidan/chats/chat-1');
    expect(open).toHaveBeenCalledTimes(1);
    expect(stat).toHaveBeenCalledTimes(1);
    expect(lstat).toHaveBeenCalledTimes(1);
    expect(readlink).toHaveBeenCalledTimes(1);

    await vfs.symlink({ path: '/version-link', targetPath: '/sys/fs/naidan/version' });
    const linked = await vfs.open({
      path: '/version-link',
      flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
    });
    await linked.close();
    expect(open).toHaveBeenCalledTimes(2);
    const entry = await vfs.resolveEntry({ path: '/version-link', finalSymlinkTreatment: 'follow' });
    expect(entry.fullPath).toBe('/sys/fs/naidan/version');
    const writeFlags: WeshOpenFlags = { access: 'write', creation: 'if-needed', truncate: 'truncate', append: 'preserve' };
    await expect(vfs.open({
      path: '/version-link',
      flags: writeFlags,
    })).rejects.toThrow('Read-only filesystem');
    await expect(vfs.openEntry({ entry, flags: writeFlags })).rejects.toThrow('Read-only filesystem');
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('keeps one file snapshot for sequential reads', async () => {
    const localRootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    const vfs = new WeshVFS({
      rootHandle: localRootHandle as unknown as FileSystemDirectoryHandle,
    });
    const fileHandle = await localRootHandle.getFileHandle('large-read.bin', { create: true });
    fileHandle.content = new Uint8Array(4 * 1024 * 1024).fill(0x61);
    const getFile = vi.spyOn(fileHandle, 'getFile');

    const handle = await vfs.open({
      path: '/large-read.bin',
      flags: {
        access: 'read',
        creation: 'never',
        truncate: 'preserve',
        append: 'preserve',
      },
    });
    const buffer = new Uint8Array(64 * 1024);
    let totalBytesRead = 0;

    while (true) {
      const { bytesRead } = await handle.read({ buffer });
      if (bytesRead === 0) {
        break;
      }
      totalBytesRead += bytesRead;
    }

    await handle.close();

    expect(totalBytesRead).toBe(fileHandle.content.byteLength);
    expect(getFile).toHaveBeenCalledTimes(1);
  });

  it.each(['descriptor', 'efficient writer'] as const)('rejects a %s if its mount changed during path resolution', async mode => {
    const original = new MockFileSystemDirectoryHandle({ name: 'original' });
    const replacement = new MockFileSystemDirectoryHandle({ name: 'replacement' });
    const originalFile = await original.getFileHandle('output.txt', { create: true });
    const replacementFile = await replacement.getFileHandle('output.txt', { create: true });
    originalFile.content = new TextEncoder().encode('old');
    replacementFile.content = new TextEncoder().encode('new');
    const vfs = new WeshVFS({ rootHandle: undefined });
    vfs.mount({ path: '/work', handle: original, readOnly: false });
    using writer = vi.spyOn(originalFile, 'createWritable');
    const getFileHandle = original.getFileHandle.bind(original);
    using _replaced = vi.spyOn(original, 'getFileHandle').mockImplementationOnce(async (name, options) => {
      const file = await getFileHandle(name, options);
      vfs.mount({ path: '/work', handle: replacement, readOnly: false });
      return file;
    });
    const path = '/work/output.txt';
    const opening = mode === 'descriptor' ? vfs.open({
      path,
      flags: { access: 'write', creation: 'never', truncate: 'preserve', append: 'append' },
    }) : vfs.tryCreateFileWriterEfficiently({ path, mode: 'append' });

    await expect(opening).rejects.toMatchObject({ name: 'WeshEntryChangedError', path });
    expect(writer).not.toHaveBeenCalled();
    await expect((await originalFile.getFile()).text()).resolves.toBe('old');
    await expect((await replacementFile.getFile()).text()).resolves.toBe('new');
  });

  it('keeps one writable stream for sequential writes', async () => {
    const localRootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    const vfs = new WeshVFS({
      rootHandle: localRootHandle as unknown as FileSystemDirectoryHandle,
    });
    const fileHandle = await localRootHandle.getFileHandle('large-write.bin', { create: true });
    const createWritable = vi.spyOn(fileHandle, 'createWritable');

    const handle = await vfs.open({
      path: '/large-write.bin',
      flags: {
        access: 'write',
        creation: 'never',
        truncate: 'truncate',
        append: 'preserve',
      },
    });
    const chunk = new Uint8Array(64 * 1024).fill(0x62);

    for (let index = 0; index < 64; index += 1) {
      const { bytesWritten } = await handle.write({ buffer: chunk });
      expect(bytesWritten).toBe(chunk.byteLength);
    }

    await handle.close();

    expect(fileHandle.content.byteLength).toBe(4 * 1024 * 1024);
    expect(createWritable).toHaveBeenCalledTimes(1);
  });

  it('uses one sync access handle for OPFS read-write operations when available', async () => {
    const localRootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    const vfs = new WeshVFS({
      rootHandle: localRootHandle as unknown as FileSystemDirectoryHandle,
    });
    const fileHandle = await localRootHandle.getFileHandle('sync-access.bin', { create: true });
    fileHandle.content = new TextEncoder().encode('abcdef');
    const createWritable = vi.spyOn(fileHandle, 'createWritable');
    const { syncAccessHandle, createSyncAccessHandle } = attachTestSyncAccessHandle({ fileHandle });
    const flush = vi.spyOn(syncAccessHandle, 'flush');
    const close = vi.spyOn(syncAccessHandle, 'close');

    const handle = await vfs.open({
      path: '/sync-access.bin',
      flags: {
        access: 'read-write',
        creation: 'never',
        truncate: 'preserve',
        append: 'preserve',
      },
    });
    await handle.write({
      buffer: new TextEncoder().encode('XY'),
      position: 1,
    });
    const buffer = new Uint8Array(6);
    const { bytesRead } = await handle.read({ buffer, position: 0 });
    await handle.truncate({ size: 4 });
    const stat = await handle.stat();
    await handle.close();

    expect(new TextDecoder().decode(buffer.subarray(0, bytesRead))).toBe('aXYdef');
    expect(new TextDecoder().decode(fileHandle.content)).toBe('aXYd');
    expect(stat.size).toBe(4);
    expect(createSyncAccessHandle).toHaveBeenCalledTimes(1);
    expect(createWritable).not.toHaveBeenCalled();
    expect(flush).toHaveBeenCalledTimes(3);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('falls back to committed read-write operations when sync access is unavailable', async () => {
    const localRootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    const vfs = new WeshVFS({
      rootHandle: localRootHandle as unknown as FileSystemDirectoryHandle,
    });
    const fileHandle = await localRootHandle.getFileHandle('fallback.bin', { create: true });
    fileHandle.content = new TextEncoder().encode('abc');
    const createWritable = vi.spyOn(fileHandle, 'createWritable');

    const handle = await vfs.open({
      path: '/fallback.bin',
      flags: {
        access: 'read-write',
        creation: 'never',
        truncate: 'preserve',
        append: 'preserve',
      },
    });
    await handle.write({
      buffer: new TextEncoder().encode('Z'),
      position: 1,
    });
    const buffer = new Uint8Array(3);
    const { bytesRead } = await handle.read({ buffer, position: 0 });
    await handle.truncate({ size: 2 });
    await handle.close();

    expect(new TextDecoder().decode(buffer.subarray(0, bytesRead))).toBe('aZc');
    expect(new TextDecoder().decode(fileHandle.content)).toBe('aZ');
    expect(createWritable).toHaveBeenCalledTimes(2);
  });

  it.each(['staged writer', 'sync access', 'committed writes'] as const)('keeps the descriptor offset when truncating through %s', async mode => {
    const localRootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    const vfs = new WeshVFS({ rootHandle: localRootHandle as unknown as FileSystemDirectoryHandle });
    const fileHandle = await localRootHandle.getFileHandle('offset.bin', { create: true });
    if (mode === 'sync access') {
      attachTestSyncAccessHandle({ fileHandle });
    }

    {
      const handle = await vfs.open({
        path: '/offset.bin',
        flags: {
          access: mode === 'staged writer' ? 'write' : 'read-write',
          creation: 'never',
          truncate: 'preserve',
          append: 'preserve',
        },
      });
      await using _close = { [Symbol.asyncDispose]: () => handle.close() };
      await handle.write({ buffer: new TextEncoder().encode('abcdef') });
      await handle.truncate({ size: 2 });
      await handle.write({ buffer: new Uint8Array([0x58]) });
    }

    expect(fileHandle.content).toEqual(new Uint8Array([0x61, 0x62, 0, 0, 0, 0, 0x58]));
  });

  it('waits for sequential writer acquisition and releases it without publishing on close', async () => {
    const localRootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    const vfs = new WeshVFS({
      rootHandle: localRootHandle as unknown as FileSystemDirectoryHandle,
    });
    const fileHandle = await localRootHandle.getFileHandle('delayed-write.bin', { create: true });
    const writable = new MockFileSystemWritableFileStream({
      fileHandle,
      options: { keepExistingData: true },
    });
    using writableClose = vi.spyOn(writable, 'close');
    using writableAbort = vi.spyOn(writable, 'abort');
    const acquiring = Promise.withResolvers<void>();
    const deferred = Promise.withResolvers<MockFileSystemWritableFileStream>();
    using _create = vi.spyOn(fileHandle, 'createWritable').mockImplementationOnce(() => {
      acquiring.resolve();
      return deferred.promise;
    });
    using _resume = {
      [Symbol.dispose]() {
        deferred.resolve(writable);
      },
    };

    let descriptorReturned = false;
    const opening = vfs.open({
      path: '/delayed-write.bin',
      flags: {
        access: 'write',
        creation: 'never',
        truncate: 'preserve',
        append: 'preserve',
      },
    }).then(handle => {
      descriptorReturned = true;
      return handle;
    });
    await acquiring.promise;
    expect(descriptorReturned).toBe(false);
    deferred.resolve(writable);
    const handle = await opening;
    await handle.close();

    expect(writableClose).not.toHaveBeenCalled();
    expect(writableAbort).toHaveBeenCalledTimes(1);
  });

  it('tracks a pending write but excludes discard when that first write fails', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const vfs = new WeshVFS({ rootHandle: root as unknown as FileSystemDirectoryHandle });
    const file = await root.getFileHandle('output', { create: true });
    const writer = await file.createWritable({ keepExistingData: true });
    const writing = Promise.withResolvers<void>();
    const writeResult = Promise.withResolvers<void>();
    const discarding = Promise.withResolvers<void>();
    const discardResult = Promise.withResolvers<void>();
    using _finish = {
      [Symbol.dispose]() {
        writeResult.resolve();
        discardResult.resolve();
      },
    };
    using _writer = vi.spyOn(file, 'createWritable').mockResolvedValueOnce(writer);
    using _write = vi.spyOn(writer, 'write').mockImplementationOnce(() => {
      writing.resolve();
      return writeResult.promise;
    });
    using _abort = vi.spyOn(writer, 'abort').mockImplementationOnce(() => {
      discarding.resolve();
      return discardResult.promise;
    });
    using close = vi.spyOn(writer, 'close');
    const fd = await vfs.open({ path: '/output', flags: { access: 'write', creation: 'never', truncate: 'preserve', append: 'preserve' } });

    const result = expect(fd.write({ buffer: new Uint8Array([1]) })).rejects.toThrow('write failed');
    await writing.promise;
    const closing = fd.close();
    expect(vfs.hasPendingFilePublications()).toBe(true);
    writeResult.reject(new Error('write failed'));
    await discarding.promise;
    expect(vfs.hasPendingFilePublications()).toBe(false);
    discardResult.resolve();
    await closing;
    await result;
    expect(close).not.toHaveBeenCalled();
  });

  it('abandons an unaccepted registry replacement when stopping overtakes writer acquisition', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const vfs = new WeshVFS({ rootHandle: root as unknown as FileSystemDirectoryHandle });
    await vfs.symlink({ path: '/source', targetPath: '/new-target' });
    await vfs.symlink({ path: '/destination', targetPath: '/old-target' });
    const system = await root.getDirectoryHandle(WESH_SYSTEM_DIR);
    const metadata = await system.getDirectoryHandle(METADATA_DIR);
    const entry = await metadata.getFileHandle('destination');
    const writer = await entry.createWritable();
    const acquiring = Promise.withResolvers<void>();
    const acquired = Promise.withResolvers<typeof writer>();
    using _resume = {
      [Symbol.dispose]() {
        acquired.resolve(writer);
      },
    };
    using _open = vi.spyOn(entry, 'createWritable').mockImplementationOnce(() => {
      acquiring.resolve();
      return acquired.promise;
    });
    using write = vi.spyOn(writer, 'write');
    using abort = vi.spyOn(writer, 'abort');
    const stop = new AbortController();

    const renaming = vfs.rename({ oldPath: '/source', newPath: '/destination', checkActive: () => stop.signal.throwIfAborted() });
    const rejected = expect(renaming).rejects.toMatchObject({ name: 'AbortError' });
    await acquiring.promise;
    stop.abort();
    expect(vfs.hasPendingFilePublications()).toBe(false);
    acquired.resolve(writer);
    await rejected;

    expect(write).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledOnce();
    await expect(vfs.readlink({ path: '/source' })).resolves.toBe('/new-target');
    await expect(vfs.readlink({ path: '/destination' })).resolves.toBe('/old-target');
  });

  it('does not extend Stop while a publication group is still reading its first input', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const vfs = new WeshVFS({ rootHandle: root as unknown as FileSystemDirectoryHandle });
    const staged = await root.getFileHandle('staged', { create: true });
    const entry = await vfs.resolveEntry({ path: '/staged', finalSymlinkTreatment: 'no-follow' });
    const reading = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    using _release = {
      [Symbol.dispose]() {
        proceed.resolve();
      },
    };
    const getFile = staged.getFile.bind(staged);
    using _read = vi.spyOn(staged, 'getFile').mockImplementationOnce(async () => {
      reading.resolve();
      await proceed.promise;
      return getFile();
    });
    const stop = new AbortController();
    const publishing = vfs.publishEntries({
      changes: [{ operation: 'rename', entry, path: '/output', expected: undefined }],
      checkActive: () => stop.signal.throwIfAborted(),
    });
    const rejection = expect(publishing).rejects.toMatchObject({ name: 'AbortError' });
    await reading.promise;
    stop.abort();
    expect(vfs.hasPendingFilePublications()).toBe(false);
    proceed.resolve();

    await rejection;
    await expect(root.getFileHandle('output')).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(root.getFileHandle('staged')).resolves.toBe(staged);
  });

  it('rejects a group whose missing destinations alias the same directory entry', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const directory = await root.getDirectoryHandle('output', { create: true });
    const vfs = new WeshVFS({ rootHandle: root as unknown as FileSystemDirectoryHandle });
    await vfs.mount({ path: '/alias', handle: directory as unknown as FileSystemDirectoryHandle });
    await root.getFileHandle('staged-one', { create: true });
    await root.getFileHandle('staged-two', { create: true });
    const first = await vfs.resolveEntry({ path: '/staged-one', finalSymlinkTreatment: 'no-follow' });
    const second = await vfs.resolveEntry({ path: '/staged-two', finalSymlinkTreatment: 'no-follow' });

    await expect(vfs.publishEntries({
      changes: [
        { operation: 'rename', entry: first, path: '/output/ref', expected: undefined },
        { operation: 'rename', entry: second, path: '/alias/ref', expected: undefined },
      ],
    })).rejects.toThrow('Cannot verify distinct publication paths');
    await expect(directory.getFileHandle('ref')).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(root.getFileHandle('staged-one')).resolves.toBeDefined();
    await expect(root.getFileHandle('staged-two')).resolves.toBeDefined();
  });

  it('rejects an incompatible rename before removing an earlier entry in the group', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const vfs = new WeshVFS({ rootHandle: root as unknown as FileSystemDirectoryHandle });
    const victim = await root.getFileHandle('victim', { create: true });
    const target = await root.getFileHandle('target', { create: true });
    await vfs.symlink({ path: '/staged', targetPath: '/another-target' });
    const removed = await vfs.resolveEntry({ path: '/victim', finalSymlinkTreatment: 'no-follow' });
    const source = await vfs.resolveEntry({ path: '/staged', finalSymlinkTreatment: 'no-follow', pinBacking: true });
    const destination = await vfs.resolveEntry({ path: '/target', finalSymlinkTreatment: 'no-follow' });

    await expect(vfs.publishEntries({
      changes: [
        { operation: 'unlink', entry: removed },
        { operation: 'rename', entry: source, path: '/target', expected: destination },
      ],
    })).rejects.toThrow('Cannot replace a regular file with a registry entry or vice versa');
    await expect(root.getFileHandle('victim')).resolves.toBe(victim);
    await expect(root.getFileHandle('target')).resolves.toBe(target);
    await expect(vfs.readlink({ path: '/staged' })).resolves.toBe('/another-target');
  });

  it('rejects an unlink before publishing or checking for recovery when its mount changes', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const mounted = new MockFileSystemDirectoryHandle({ name: 'mounted' });
    const handle = mounted as unknown as FileSystemDirectoryHandle;
    const vfs = new WeshVFS({ rootHandle: root as unknown as FileSystemDirectoryHandle });
    await vfs.mount({ path: '/work', handle });
    const victim = await mounted.getFileHandle('victim', { create: true });
    const entry = await vfs.resolveEntry({ path: '/work/victim', finalSymlinkTreatment: 'no-follow' });
    const getFile = mounted.getFileHandle.bind(mounted);
    let reads = 0;
    using _lookup = vi.spyOn(mounted, 'getFileHandle').mockImplementation(async (name, options) => {
      const file = await getFile(name, options);
      if (name === 'victim' && ++reads === 2) {
        await vfs.mount({ path: '/work', handle, readOnly: true });
      }
      return file;
    });
    using remove = vi.spyOn(mounted, 'removeEntry');

    await expect(vfs.publishEntries({ changes: [{ operation: 'unlink', entry }] })).rejects.toThrow('Mount changed while removing');
    expect(reads).toBe(2);
    expect(remove).not.toHaveBeenCalled();
    expect(vfs.hasPendingFilePublications()).toBe(false);
    await expect(getFile('victim')).resolves.toBe(victim);
  });

  it('serializes plain unlink behind removal that depends on the retained entry', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const vfs = new WeshVFS({ rootHandle: root as unknown as FileSystemDirectoryHandle });
    await root.getFileHandle('source', { create: true });
    await root.getFileHandle('retained', { create: true });
    const entry = await vfs.resolveEntry({ path: '/source', finalSymlinkTreatment: 'no-follow' });
    const retained = await vfs.resolveEntry({ path: '/retained', finalSymlinkTreatment: 'no-follow' });
    const entered = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    using _release = {
      [Symbol.dispose]() {
        proceed.resolve();
      },
    };
    const getFile = root.getFileHandle.bind(root);
    using _read = vi.spyOn(root, 'getFileHandle').mockImplementation(async (name, options) => {
      if (name === 'source') {
        entered.resolve();
        await proceed.promise;
      }
      return getFile(name, options);
    });
    using removals = vi.spyOn(root, 'removeEntry');
    const guarded = vfs.unlink({ path: '/source', expected: { entry, retainedEntries: [retained] } });
    await entered.promise;
    const following = vfs.unlink({ path: '/retained' });
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(removals).not.toHaveBeenCalled();
    proceed.resolve();

    await guarded;
    await following;
    expect(removals.mock.calls.map(([name]) => name)).toEqual(['source', 'retained']);
  });

  it('keeps recovery and staged files when the destination mount changes after the backup', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const originalMount = new MockFileSystemDirectoryHandle({ name: 'original' });
    const remounted = new MockFileSystemDirectoryHandle({ name: 'remounted' });
    const vfs = new WeshVFS({ rootHandle: root as unknown as FileSystemDirectoryHandle });
    await vfs.mount({ path: '/work', handle: originalMount as unknown as FileSystemDirectoryHandle });
    const original = await originalMount.getFileHandle('target', { create: true });
    original.content = new TextEncoder().encode('old');
    const staged = await root.getFileHandle('staged', { create: true });
    staged.content = new TextEncoder().encode('new');
    const expected = await vfs.resolveEntry({ path: '/work/target', finalSymlinkTreatment: 'no-follow' });
    const entry = await vfs.resolveEntry({ path: '/staged', finalSymlinkTreatment: 'no-follow' });
    const removeEntry = originalMount.removeEntry.bind(originalMount);
    using _remove = vi.spyOn(originalMount, 'removeEntry').mockImplementationOnce(async (name, options) => {
      await removeEntry(name, options);
      await vfs.mount({ path: '/work', handle: remounted as unknown as FileSystemDirectoryHandle });
    });

    await expect(vfs.replaceEntry({ path: '/work/target', entry, expected, backupPath: '/backup' })).rejects.toMatchObject({ name: 'WeshRenameIncompleteError' });

    await expect(remounted.getFileHandle('target')).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect((await (await root.getFileHandle('backup')).getFile()).text()).resolves.toBe('old');
    await expect((await staged.getFile()).text()).resolves.toBe('new');
  });

  it('keeps the original if its newly published backup is replaced before source removal', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const vfs = new WeshVFS({ rootHandle: root as unknown as FileSystemDirectoryHandle });
    const original = await root.getFileHandle('target', { create: true });
    original.content = new TextEncoder().encode('old');
    const staged = await root.getFileHandle('staged', { create: true });
    staged.content = new TextEncoder().encode('new');
    const expected = await vfs.resolveEntry({ path: '/target', finalSymlinkTreatment: 'no-follow' });
    const entry = await vfs.resolveEntry({ path: '/staged', finalSymlinkTreatment: 'no-follow' });
    const getFile = original.getFile.bind(original);
    let exchanged = false;
    using _read = vi.spyOn(original, 'getFile').mockImplementation(async () => {
      const snapshot = await getFile();
      if (!exchanged && await root.getFileHandle('backup').catch(() => undefined) !== undefined) {
        exchanged = true;
        await root.removeEntry('backup');
        const foreign = await root.getFileHandle('backup', { create: true });
        foreign.content = new TextEncoder().encode('foreign');
      }
      return snapshot;
    });

    await expect(vfs.replaceEntry({ path: '/target', expected, entry, backupPath: '/backup' })).rejects.toMatchObject({ name: 'WeshRenameIncompleteError' });

    expect(exchanged).toBe(true);
    await expect((await getFile()).text()).resolves.toBe('old');
    await expect((await staged.getFile()).text()).resolves.toBe('new');
    await expect((await (await root.getFileHandle('backup')).getFile()).text()).resolves.toBe('foreign');
  });

  it('does not overwrite a nonempty file returned by creation at an initially vacant backup name', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const vfs = new WeshVFS({ rootHandle: root as unknown as FileSystemDirectoryHandle });
    const original = await root.getFileHandle('target', { create: true });
    original.content = new TextEncoder().encode('old');
    const staged = await root.getFileHandle('staged', { create: true });
    staged.content = new TextEncoder().encode('new');
    const expected = await vfs.resolveEntry({ path: '/target', finalSymlinkTreatment: 'no-follow' });
    const entry = await vfs.resolveEntry({ path: '/staged', finalSymlinkTreatment: 'no-follow' });
    const getFileHandle = root.getFileHandle.bind(root);
    using _create = vi.spyOn(root, 'getFileHandle').mockImplementation(async (name, options) => {
      const file = await getFileHandle(name, options);
      if (name === 'backup' && options?.create) {
        file.content = new TextEncoder().encode('foreign');
      }
      return file;
    });

    await expect(vfs.replaceEntry({ path: '/target', expected, entry, backupPath: '/backup' })).rejects.toThrow('Rename destination changed: backup');

    await expect((await original.getFile()).text()).resolves.toBe('old');
    await expect((await staged.getFile()).text()).resolves.toBe('new');
    await expect((await (await getFileHandle('backup')).getFile()).text()).resolves.toBe('foreign');
  });

  it('keeps all available entries when registry close publishes and then rejects', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const vfs = new WeshVFS({ rootHandle: root as unknown as FileSystemDirectoryHandle });
    await vfs.symlink({ path: '/target', targetPath: '/old-link' });
    const staged = await root.getFileHandle('staged', { create: true });
    staged.content = new TextEncoder().encode('new');
    const expected = await vfs.resolveEntry({ path: '/target', finalSymlinkTreatment: 'no-follow', pinBacking: true });
    const entry = await vfs.resolveEntry({ path: '/staged', finalSymlinkTreatment: 'no-follow' });
    const system = await root.getDirectoryHandle(WESH_SYSTEM_DIR);
    const metadata = await system.getDirectoryHandle(METADATA_DIR);
    const getFileHandle = metadata.getFileHandle.bind(metadata);
    using _failClose = vi.spyOn(metadata, 'getFileHandle').mockImplementation(async (name, options) => {
      const file = await getFileHandle(name, options);
      if (name === 'backup' && options?.create) {
        const writer = await file.createWritable();
        const close = writer.close.bind(writer);
        vi.spyOn(writer, 'close').mockImplementationOnce(async () => {
          await close();
          throw new Error('publication acknowledgement lost');
        });
        vi.spyOn(file, 'createWritable').mockResolvedValueOnce(writer);
      }
      return file;
    });

    await expect(vfs.replaceEntry({ path: '/target', entry, expected, backupPath: '/backup' })).rejects.toMatchObject({ name: 'WeshRenameIncompleteError' });

    await expect(vfs.readlink({ path: '/target' })).resolves.toBe('/old-link');
    await expect(vfs.readlink({ path: '/backup' })).resolves.toBe('/old-link');
    await expect((await staged.getFile()).text()).resolves.toBe('new');
  });

  it('refuses to publish a checked writer after the same directory is mounted read-only', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const mounted = new MockFileSystemDirectoryHandle({ name: 'mounted' });
    const handle = mounted as unknown as FileSystemDirectoryHandle;
    const vfs = new WeshVFS({ rootHandle: root as unknown as FileSystemDirectoryHandle });
    await vfs.mount({ path: '/work', handle });
    const target = await mounted.getFileHandle('target', { create: true });
    target.content = new TextEncoder().encode('old');
    const path = '/work/target';
    const entry = await vfs.resolveEntry({ path, finalSymlinkTreatment: 'no-follow' });
    if (entry.type !== 'file') {
      throw new Error('Expected a regular file');
    }
    const acquired = await vfs.tryCreateFileWriterEfficiently({ path, expected: entry, mode: 'truncate' });
    if (acquired.kind !== 'writer') {
      throw new Error('Expected a writable stream');
    }
    await acquired.writer.write({ chunk: new TextEncoder().encode('new') });
    await vfs.mount({ path: '/work', handle, readOnly: true });

    const reason = new Error('Expected a read-only mount');
    try {
      await expect(acquired.writer.close()).rejects.toThrow('File is read-only');
      await expect((await target.getFile()).text()).resolves.toBe('old');
    } finally {
      await acquired.writer.abort({ reason });
    }
  });

  it('treats virtual mounts as read-only and non-native', async () => {
    const vfs = new WeshVFS({ rootHandle: undefined });
    const provider: WeshVirtualMountProvider = {
      async open({ path, flags, mode }: { path: string, flags: WeshOpenFlags, mode?: number }) {
        void path;
        void flags;
        void mode;
        return createVirtualFileHandle({ text: '' });
      },
      async stat({ path }: { path: string }) {
        return path === '/sys/fs/naidan'
          ? createDirectoryStat({ size: 0 })
          : createFileStat({ size: 0 });
      },
      async lstat({ path }: { path: string }) {
        return path === '/sys/fs/naidan'
          ? createDirectoryStat({ size: 0 })
          : createFileStat({ size: 0 });
      },
      async *readDir({ path }: { path: string }) {
        if (path === '/sys/fs/naidan') {
          yield { name: 'version', type: 'file', fullPath: '/sys/fs/naidan/version' };
        }
      },
      async readlink({ path }: { path: string }) {
        return path;
      },
    };

    vfs.mountVirtual({
      path: '/sys/fs/naidan',
      readOnly: true,
      provider,
    });

    expect(await vfs.getNativeHandle({ path: '/sys/fs/naidan' })).toBeNull();
    expect(vfs.getReadOnlyForPath({ path: '/sys/fs/naidan' })).toBe(true);
    await expect(vfs.mkdir({ path: '/sys/fs/naidan', recursive: true })).resolves.toBeUndefined();
    await expect(vfs.mkdir({ path: '/sys/fs/naidan/version', recursive: true })).rejects.toThrow('Not a directory');
    await expect(vfs.mknod({ path: '/sys/fs/naidan/node', type: 'fifo' })).rejects.toThrow('Read-only filesystem');
    await expect(vfs.unlink({ path: '/sys/fs/naidan/version' })).rejects.toThrow('Read-only filesystem');
  });
});
