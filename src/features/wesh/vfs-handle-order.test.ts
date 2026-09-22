// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBlobContext } from '@/utils/blob-view';
import { readNativeBlobRange } from '@/utils/blob-view-io';
import { promiseAllKeyed } from '@/utils/promise';
import { MockFileSystemDirectoryHandle, MockFileSystemWritableFileStream } from '@/features/wesh/mocks/InMemoryFileSystem';
import { WeshVFS } from '@/features/wesh/vfs';
import type { WeshOpenFlags } from '@/features/wesh/types';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  try {
    for (const close of cleanup.splice(0).reverse()) await close();
  } finally {
    vi.restoreAllMocks();
  }
});

async function fixture({ access, context }: { access: WeshOpenFlags['access'], context: 'view' | 'native' }) {
  const root = new MockFileSystemDirectoryHandle({ name: 'root' });
  const file = await root.getFileHandle('data.bin', { create: true });
  file.content = new TextEncoder().encode('abcdef');
  const read = vi.fn(readNativeBlobRange);
  const blobs = createBlobContext({ reader: { read }, release: undefined });
  cleanup.push(() => blobs.dispose());
  const getFile = vi.spyOn(file as unknown as FileSystemFileHandle, 'getFile').mockImplementation(async () =>
    new File([file.content.slice().buffer], 'data.bin', { lastModified: file.lastModified }));
  const files = new WeshVFS({ rootHandle: root as unknown as FileSystemDirectoryHandle, blobs: context === 'view' ? blobs : undefined });
  const handle = await files.open({ path: '/data.bin', flags: { access, creation: 'never', truncate: 'preserve', append: 'preserve' } });
  cleanup.push(() => handle.close());
  return { file, handle, read, blobs, getFile, files };
}

function text({ bytes }: { bytes: Uint8Array }): string {
  return new TextDecoder().decode(bytes);
}

// These are public-handle operations, not calls into StandardFileHandle internals.
describe('native file handle ordering across asynchronous Blob reads', () => {
  it.each([
    { access: 'read', context: 'view' }, { access: 'read-write', context: 'view' },
    { access: 'read', context: 'native' }, { access: 'read-write', context: 'native' },
  ] as const)('assigns disjoint implicit ranges to concurrent $access / $context reads', async ({ access, context }) => {
    const { handle } = await fixture({ access, context });
    const first = new Uint8Array(2), second = new Uint8Array(2), third = new Uint8Array(2);
    expect(await promiseAllKeyed({ first: handle.read({ buffer: first }), second: handle.read({ buffer: second }), third: handle.read({ buffer: third }) }))
      .toEqual({ first: { bytesRead: 2 }, second: { bytesRead: 2 }, third: { bytesRead: 2 } });
    expect([text({ bytes: first }), text({ bytes: second }), text({ bytes: third })]).toEqual(['ab', 'cd', 'ef']);
    expect(await handle.read({ buffer: new Uint8Array(1) })).toEqual({ bytesRead: 0 });
  });

  it.each(['read', 'read-write'] as const)('keeps explicit positions independent among queued %s reads', async access => {
    const { handle } = await fixture({ access, context: 'view' });
    const first = new Uint8Array(2), positioned = new Uint8Array(2), second = new Uint8Array(2);
    await promiseAllKeyed({ first: handle.read({ buffer: first }), positioned: handle.read({ buffer: positioned, position: 4 }), second: handle.read({ buffer: second }) });
    expect([text({ bytes: first }), text({ bytes: positioned }), text({ bytes: second })]).toEqual(['ab', 'ef', 'cd']);
    expect(await handle.read({ buffer: positioned })).toEqual({ bytesRead: 2 });
    expect(text({ bytes: positioned })).toBe('ef');
  });

  it('does not poison later cursor reads after an invalid or failed positional request', async () => {
    const { handle, read } = await fixture({ access: 'read-write', context: 'view' });
    const first = new Uint8Array(2), second = new Uint8Array(2);
    const failed = handle.read({ buffer: first, offset: -1 });
    const rejected = expect(failed).rejects.toBeInstanceOf(RangeError);
    const next = handle.read({ buffer: second });
    await rejected; await next;
    expect(text({ bytes: second })).toBe('ab');
    const error = new Error('Snapshot read failed');
    read.mockRejectedValueOnce(error);
    const reading = handle.read({ buffer: first, position: 4 });
    const readRejected = expect(reading).rejects.toBe(error);
    const resumed = handle.read({ buffer: second });
    await readRejected; await resumed;
    expect(text({ bytes: second })).toBe('cd');
  });

  it('does not let a later write, truncate or stat overtake a pending read', async () => {
    const { handle, file, read } = await fixture({ access: 'read-write', context: 'view' });
    const gate = Promise.withResolvers<void>();
    read.mockImplementationOnce(async request => {
      await gate.promise; return readNativeBlobRange(request);
    });
    const first = new Uint8Array(2), second = new Uint8Array(3);
    const reading = handle.read({ buffer: first });
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    const writable = vi.spyOn(file, 'createWritable');
    const all = promiseAllKeyed({
      reading,
      write: handle.write({ buffer: new TextEncoder().encode('XY'), position: 2 }),
      truncate: handle.truncate({ size: 5 }),
      stat: handle.stat(),
      next: handle.read({ buffer: second }),
    });
    try {
      await Promise.resolve(); await Promise.resolve();
      expect(writable).not.toHaveBeenCalled();
      expect(text({ bytes: file.content })).toBe('abcdef');
    } finally {
      gate.resolve();
    }
    const result = await all;
    expect(result.stat.size).toBe(5);
    expect(text({ bytes: first })).toBe('ab');
    expect(text({ bytes: second })).toBe('XYe');
    expect(text({ bytes: file.content })).toBe('abXYe');
  });

  it.each(['write', 'read-write'] as const)('serializes the cursor and writer seeks for concurrent %s writes', async access => {
    const { handle, file } = await fixture({ access, context: 'view' });
    await promiseAllKeyed({
      first: handle.write({ buffer: new TextEncoder().encode('12') }),
      positioned: handle.write({ buffer: new TextEncoder().encode('XY'), position: 4 }),
      second: handle.write({ buffer: new TextEncoder().encode('34') }),
    });
    await handle.close();
    expect(text({ bytes: file.content })).toBe('1234XY');
  });

  it('reports only bytes that fit the write source and does not move the cursor for an empty write', async () => {
    const { handle, file } = await fixture({ access: 'write', context: 'view' });
    expect(await handle.write({ buffer: new TextEncoder().encode('AB'), offset: 1, length: 99 })).toEqual({ bytesWritten: 1 });
    expect(await handle.write({ buffer: new Uint8Array(0), position: 20 })).toEqual({ bytesWritten: 0 });
    expect(await handle.write({ buffer: new TextEncoder().encode('C') })).toEqual({ bytesWritten: 1 });
    await handle.close();
    expect(text({ bytes: file.content })).toBe('BCcdef');
  });

  it.each([{ offset: -1 }, { offset: 3 }, { offset: 0.5 }, { length: NaN }, { length: -1 }, { position: -1 }, { position: Infinity }])('rejects invalid write ranges without starting a fallback writer: %j', async options => {
    const { handle, file } = await fixture({ access: 'read-write', context: 'view' });
    const writable = vi.spyOn(file, 'createWritable');
    await expect(handle.write({ buffer: new Uint8Array(2), ...options })).rejects.toBeInstanceOf(RangeError);
    expect(writable).not.toHaveBeenCalled();
    expect(text({ bytes: file.content })).toBe('abcdef');
  });

  it.each([-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid truncate size %s without starting a writer', async size => {
    const { handle, file } = await fixture({ access: 'read-write', context: 'view' });
    const writable = vi.spyOn(file, 'createWritable');
    await expect(handle.truncate({ size })).rejects.toBeInstanceOf(RangeError);
    expect(writable).not.toHaveBeenCalled();
  });

  it('keeps an unfinished sequential chunk for the next read instead of exposing bytes in a failed result', async () => {
    const error = new Error('Second chunk failed');
    const native = new File(['abcd'], 'data.bin');
    let reads = 0;
    vi.spyOn(native, 'stream').mockImplementation(() => new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(new Uint8Array([97, 98])); else controller.error(error);
      },
    }, { highWaterMark: 0 }));
    // Use the same file only through a public VFS; no hidden class construction.
    const root = new MockFileSystemDirectoryHandle({ name: 'raw' });
    const file = await root.getFileHandle('raw', { create: true });
    vi.spyOn(file as unknown as FileSystemFileHandle, 'getFile').mockResolvedValue(native);
    const raw = new WeshVFS({ rootHandle: root as unknown as FileSystemDirectoryHandle });
    const opened = await raw.open({ path: '/raw', flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' } });
    cleanup.push(() => opened.close());
    const buffer = new Uint8Array(4).fill(77);
    expect(await opened.read({ buffer })).toEqual({ bytesRead: 2 });
    expect(buffer).toEqual(new Uint8Array([97, 98, 77, 77]));
    buffer.fill(77);
    await expect(opened.read({ buffer })).rejects.toBe(error);
    expect(buffer).toEqual(new Uint8Array(4).fill(77));
  });
});

describe('native handle close drains owned operations', () => {
  it.each(['read', 'read-write'] as const)('cancels a pending %s read and queued reads without affecting a sibling', async access => {
    const { handle, read, blobs } = await fixture({ access, context: 'view' });
    const delayed = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
    read.mockReturnValueOnce(delayed.promise);
    const first = new Uint8Array(2).fill(77), second = first.slice();
    const active = handle.read({ buffer: first });
    const activeRejected = expect(active).rejects.toThrow();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    const queued = handle.read({ buffer: second });
    const queuedRejected = expect(queued).rejects.toThrow('closed');
    await Promise.all([handle.close(), handle.close()]);
    await activeRejected; await queuedRejected;
    expect(read).toHaveBeenCalledOnce();
    expect(first).toEqual(new Uint8Array([77, 77]));
    expect(second).toEqual(first);
    delayed.resolve(new Uint8Array([97, 98]));
    expect(await blobs.fromNative({ blob: new Blob(['sibling']) }).text()).toBe('sibling');
  });

  it('cancels a pending raw native stream before draining the operation queue', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const file = await root.getFileHandle('data', { create: true });
    const snapshot = new File(['ab'], 'data');
    const gate = Promise.withResolvers<void>();
    const pull = vi.fn(() => gate.promise), cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({ pull, cancel }, { highWaterMark: 0 });
    vi.spyOn(snapshot, 'stream').mockReturnValue(stream);
    vi.spyOn(file as unknown as FileSystemFileHandle, 'getFile').mockResolvedValue(snapshot);
    const files = new WeshVFS({ rootHandle: root as unknown as FileSystemDirectoryHandle });
    const handle = await files.open({ path: '/data', flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' } });
    const output = new Uint8Array(2).fill(77);
    const active = handle.read({ buffer: output });
    const rejected = expect(active).rejects.toThrow('closed');
    try {
      await vi.waitFor(() => expect(pull).toHaveBeenCalledOnce());
      await handle.close();
      await rejected;
      expect(cancel).toHaveBeenCalledOnce();
      expect(stream.locked).toBe(false);
      expect(output).toEqual(new Uint8Array([77, 77]));
    } finally {
      gate.resolve(); await handle.close();
    }
  });

  it('does not abort a fallback commit that already completed after close was requested', async () => {
    const { handle, file } = await fixture({ access: 'read-write', context: 'view' });
    const writer = new MockFileSystemWritableFileStream({ fileHandle: file, options: { keepExistingData: true } });
    const gate = Promise.withResolvers<void>();
    const closeOriginal = writer.close.bind(writer);
    const commit = vi.spyOn(writer, 'close').mockImplementation(async () => {
      await gate.promise; await closeOriginal();
    });
    const abort = vi.spyOn(writer, 'abort');
    vi.spyOn(file, 'createWritable').mockResolvedValueOnce(writer);
    const active = handle.write({ buffer: new TextEncoder().encode('ZZ') });
    const rejected = expect(active).rejects.toThrow('closed');
    await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
    const closing = handle.close();
    gate.resolve();
    await rejected; await closing;
    expect(commit).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();
    expect(text({ bytes: file.content })).toBe('ZZcdef');
  });

  it('waits for an acquired fallback writer, aborting instead of committing after close', async () => {
    const { handle, file } = await fixture({ access: 'read-write', context: 'view' });
    const writer = new MockFileSystemWritableFileStream({ fileHandle: file, options: { keepExistingData: true } });
    const abort = vi.spyOn(writer, 'abort');
    const close = vi.spyOn(writer, 'close');
    const write = vi.spyOn(writer, 'write');
    const delayed = Promise.withResolvers<MockFileSystemWritableFileStream>();
    const create = vi.spyOn(file, 'createWritable').mockReturnValue(delayed.promise);
    const active = handle.write({ buffer: new TextEncoder().encode('ZZ') });
    const rejected = expect(active).rejects.toThrow('closed');
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    let closed = false;
    const closing = handle.close().then(() => {
      closed = true;
    });
    try {
      await Promise.resolve();
      expect(closed).toBe(false);
    } finally {
      delayed.resolve(writer);
    }
    await rejected; await closing;
    expect(abort).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(text({ bytes: file.content })).toBe('abcdef');
  });

  it('does not acquire a writer if initialization receives its snapshot after close', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const file = await root.getFileHandle('data', { create: true });
    const gate = Promise.withResolvers<File>();
    vi.spyOn(file as unknown as FileSystemFileHandle, 'getFile').mockReturnValue(gate.promise);
    const writer = vi.spyOn(file, 'createWritable');
    const files = new WeshVFS({ rootHandle: root as unknown as FileSystemDirectoryHandle });
    const handle = await files.open({ path: '/data', flags: { access: 'write', creation: 'never', truncate: 'preserve', append: 'preserve' } });
    const closing = handle.close();
    gate.resolve(new File(['original'], 'data'));
    await closing;
    expect(writer).not.toHaveBeenCalled();
    await expect(handle.write({ buffer: new Uint8Array([1]) })).rejects.toThrow('closed');
  });

  it('preserves both fallback mutation and abort errors and can accept a later independent operation', async () => {
    const { handle, file } = await fixture({ access: 'read-write', context: 'view' });
    const writer = new MockFileSystemWritableFileStream({ fileHandle: file, options: { keepExistingData: true } });
    const writeError = new Error('Write failed'), abortError = new Error('Abort failed');
    vi.spyOn(writer, 'write').mockRejectedValue(writeError);
    vi.spyOn(writer, 'abort').mockRejectedValue(abortError);
    const close = vi.spyOn(writer, 'close');
    vi.spyOn(file, 'createWritable').mockResolvedValueOnce(writer);
    await expect(handle.write({ buffer: new Uint8Array([1]) })).rejects.toMatchObject({ errors: [writeError, abortError] });
    expect(close).not.toHaveBeenCalled();
    const output = new Uint8Array(2);
    await handle.read({ buffer: output });
    expect(text({ bytes: output })).toBe('ab');
  });

  it('aborts a failed persistent writer at close instead of committing its earlier staged output', async () => {
    const { handle, file } = await fixture({ access: 'write', context: 'view' });
    await handle.write({ buffer: new TextEncoder().encode('ZZ') });
    const error = new Error('Persistent stream failed');
    const write = vi.spyOn(MockFileSystemWritableFileStream.prototype, 'write').mockRejectedValue(error);
    const close = vi.spyOn(MockFileSystemWritableFileStream.prototype, 'close');
    const abort = vi.spyOn(MockFileSystemWritableFileStream.prototype, 'abort');
    await expect(handle.write({ buffer: new Uint8Array([1]) })).rejects.toBe(error);
    await expect(handle.write({ buffer: new Uint8Array([2]) })).rejects.toBe(error);
    await expect(handle.truncate({ size: 0 })).rejects.toBe(error);
    expect(write).toHaveBeenCalledOnce();
    await handle.close();
    expect(close).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledOnce();
    expect(text({ bytes: file.content })).toBe('abcdef');
  });

  it.each(['write', 'truncate'] as const)('aborts a failed fallback %s instead of publishing partially staged contents', async action => {
    const { handle, file } = await fixture({ access: 'read-write', context: 'view' });
    // Prime the snapshot; a rejected write must not leave it as a stale cache.
    await handle.read({ buffer: new Uint8Array(1), position: 0 });
    const writer = new MockFileSystemWritableFileStream({ fileHandle: file, options: { keepExistingData: true } });
    const abort = vi.spyOn(writer, 'abort');
    const close = vi.spyOn(writer, 'close');
    const error = new Error('Mutation failed after staging');
    const write = writer.write.bind(writer), truncate = writer.truncate.bind(writer);
    switch (action) {
    case 'write': vi.spyOn(writer, 'write').mockImplementation(async value => {
      await write(value); throw error;
    }); break;
    case 'truncate': vi.spyOn(writer, 'truncate').mockImplementation(async size => {
      await truncate(size); throw error;
    }); break;
    default: { const _ex: never = action; throw new Error(String(_ex)); }
    }
    vi.spyOn(file, 'createWritable').mockResolvedValueOnce(writer);
    const operation = action === 'write' ? handle.write({ buffer: new Uint8Array([0]) }) : handle.truncate({ size: 1 });
    await expect(operation).rejects.toBe(error);
    expect(abort).toHaveBeenCalledWith(error);
    expect(close).not.toHaveBeenCalled();
    expect(text({ bytes: file.content })).toBe('abcdef');
    file.content = new TextEncoder().encode('UVWXYZ');
    const buffer = new Uint8Array(2);
    expect(await handle.read({ buffer })).toEqual({ bytesRead: 2 });
    expect(text({ bytes: buffer })).toBe('UV');
  });

  it('does not close a persistent writer while its write is still running', async () => {
    const { handle, file } = await fixture({ access: 'write', context: 'view' });
    // Initialization has already requested the writer; observe its physical mutation.
    const gate = Promise.withResolvers<void>();
    const original = MockFileSystemWritableFileStream.prototype.write;
    const write = vi.spyOn(MockFileSystemWritableFileStream.prototype, 'write').mockImplementation(async function(this: MockFileSystemWritableFileStream, value) {
      await gate.promise; await original.call(this, value);
    });
    const close = vi.spyOn(MockFileSystemWritableFileStream.prototype, 'close');
    const abort = vi.spyOn(MockFileSystemWritableFileStream.prototype, 'abort');
    const active = handle.write({ buffer: new Uint8Array([0]) });
    const rejected = expect(active).rejects.toThrow('closed');
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    const closing = handle.close();
    try {
      await Promise.resolve(); await Promise.resolve();
      expect(close).not.toHaveBeenCalled();
      expect(abort).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
    }
    await rejected; await closing;
    expect(abort).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(text({ bytes: file.content })).toBe('abcdef');
  });

  it.each(['stat', 'positional EOF'] as const)('does not publish %s after a delayed snapshot outlives close', async operation => {
    const { handle, getFile } = await fixture({ access: 'read-write', context: 'view' });
    const gate = Promise.withResolvers<File>();
    getFile.mockReturnValueOnce(gate.promise);
    const pending = operation === 'stat' ? handle.stat() : handle.read({ buffer: new Uint8Array(1), position: 99 });
    const rejected = expect(pending).rejects.toThrow('closed');
    await vi.waitFor(() => expect(getFile).toHaveBeenCalledTimes(2));
    const closing = handle.close();
    gate.resolve(new File([], 'data.bin'));
    await rejected; await closing;
  });
});

describe('native synchronous access and isolated handles', () => {
  async function syncFixture() {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const file = await root.getFileHandle('data', { create: true });
    file.content = new TextEncoder().encode('abcdef');
    const sync = {
      read: vi.fn((buffer: Uint8Array, { at }: { at: number }) => {
        const bytes = file.content.subarray(at, at + buffer.length);
        buffer.set(bytes); return bytes.length;
      }),
      write: vi.fn((buffer: Uint8Array, { at }: { at: number }) => {
        file.content.set(buffer, at); return buffer.length;
      }),
      truncate: vi.fn((size: number) => {
        file.content = file.content.slice(0, size);
      }),
      getSize: vi.fn(() => file.content.length),
      flush: vi.fn(), close: vi.fn(),
    };
    Object.assign(file, { createSyncAccessHandle: vi.fn(async () => sync) });
    const vfs = new WeshVFS({ rootHandle: root as unknown as FileSystemDirectoryHandle });
    const handle = await vfs.open({ path: '/data', flags: { access: 'read-write', creation: 'never', truncate: 'preserve', append: 'preserve' } });
    const fallback = vi.spyOn(file, 'createWritable');
    return { handle, file, sync, fallback };
  }

  it('preserves the synchronous fast path and orders reads with writes and truncates', async () => {
    const { handle, sync, fallback, file } = await syncFixture();
    try {
      const first = new Uint8Array(2), second = new Uint8Array(2);
      const result = await promiseAllKeyed({
        first: handle.read({ buffer: first }),
        write: handle.write({ buffer: new TextEncoder().encode('XY') }),
        truncate: handle.truncate({ size: 5 }),
        stat: handle.stat(),
        next: handle.read({ buffer: second }),
      });
      expect(text({ bytes: first })).toBe('ab');
      expect(result.next).toEqual({ bytesRead: 1 });
      expect(second).toEqual(new Uint8Array([101, 0]));
      expect(result.stat.size).toBe(5);
      expect(text({ bytes: file.content })).toBe('abXYe');
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
    expect(sync.flush).toHaveBeenCalledTimes(3);
    expect(sync.close).toHaveBeenCalledOnce();
  });

  it('closes a sync handle even when flushing it fails, without retrying close', async () => {
    const { handle, sync } = await syncFixture();
    await handle.stat();
    const error = new Error('Flush failed');
    sync.flush.mockImplementation(() => {
      throw error;
    });
    const results = await Promise.allSettled([handle.close(), handle.close()]);
    expect(results).toEqual([{ status: 'rejected', reason: error }, { status: 'rejected', reason: error }]);
    expect(sync.close).toHaveBeenCalledOnce();
    await expect(handle.stat()).rejects.toThrow('closed');
  });

  it('keeps both sync flush and close failures', async () => {
    const { handle, sync } = await syncFixture();
    await handle.stat();
    const first = new Error('Flush failed'), second = new Error('Close failed');
    sync.flush.mockImplementation(() => {
      throw first;
    });
    sync.close.mockImplementation(() => {
      throw second;
    });
    await expect(handle.close()).rejects.toMatchObject({ errors: [first, second] });
    expect(sync.close).toHaveBeenCalledOnce();
  });

  it.each([-1, 0.5, 99])('does not advance the cursor for an invalid sync count %s', async bytesRead => {
    const { handle, sync } = await syncFixture();
    try {
      sync.read.mockReturnValueOnce(bytesRead);
      const buffer = new Uint8Array(2);
      await expect(handle.read({ buffer })).rejects.toThrow('Invalid native file read count');
      await handle.read({ buffer });
      expect(text({ bytes: buffer })).toBe('ab');
    } finally {
      await handle.close();
    }
  });

  it('does not lock other file handles while one Blob range waits', async () => {
    const { handle, files, read } = await fixture({ access: 'read-write', context: 'view' });
    const another = await files.open({ path: '/data.bin', flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' } });
    cleanup.push(() => another.close());
    const pending = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
    read.mockReturnValueOnce(pending.promise);
    const reading = handle.read({ buffer: new Uint8Array(2) });
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    try {
      const buffer = new Uint8Array(2);
      expect(await another.read({ buffer })).toEqual({ bytesRead: 2 });
      expect(text({ bytes: buffer })).toBe('ab');
    } finally {
      pending.resolve(new Uint8Array([97, 98])); await reading;
    }
  });
});
