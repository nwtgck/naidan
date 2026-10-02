import { describe, expect, it, vi } from 'vitest';
import type { StorageBinaryObjectReadHandle } from '@/00-storage/service/binary-object-io';
import { createInMemoryStorageRoot } from '@/00-storage/service/storage-file-system/test-support/in-memory-storage-file-system';
import type { WeshOpenFlags } from '@/features/wesh/types';
import type { StorageFileHandle } from '@/00-storage/service/storage-file-system/types';
import { RemoteStorageDirectoryWeshProvider } from './provider';
import { createWeshStorageDirectoryRemoteForMounts, OpenStorageFile } from './remote';

const MOUNT_PATH = '/mnt/encrypted';

const READ_ONLY_FLAGS: WeshOpenFlags = {
  access: 'read',
  creation: 'never',
  truncate: 'preserve',
  append: 'preserve',
};

const READ_WRITE_CREATE_FLAGS: WeshOpenFlags = {
  access: 'read-write',
  creation: 'if-needed',
  truncate: 'preserve',
  append: 'preserve',
};

async function createMountedStorageDirectory({ readOnly = false }: {
  readOnly?: boolean;
} = {}) {
  const root = createInMemoryStorageRoot({ name: 'storage-root' });
  const remote = createWeshStorageDirectoryRemoteForMounts({
    mounts: [{
      type: 'storage_directory',
      path: MOUNT_PATH,
      handle: root,
      readOnly,
    }],
    storageDirectoryExecution: 'ui_remote',
  });
  if (remote === undefined) {
    throw new Error('Expected storage directory remote');
  }
  return {
    root,
    remote,
    provider: new RemoteStorageDirectoryWeshProvider({
      remote,
      mountPath: MOUNT_PATH,
    }),
  };
}

async function readAll({
  provider,
  path,
}: {
  provider: RemoteStorageDirectoryWeshProvider;
  path: string;
}): Promise<string> {
  const handle = await provider.open({ path, flags: READ_ONLY_FLAGS });
  try {
    const stat = await handle.stat();
    const buffer = new Uint8Array(stat.size);
    const result = await handle.read({ buffer });
    return new TextDecoder().decode(buffer.subarray(0, result.bytesRead));
  } finally {
    await handle.close();
  }
}

async function createExistingFileFixture() {
  const mounted = await createMountedStorageDirectory();
  const file = await mounted.root.getFileHandle({ name: 'value.txt', create: true });
  const writer = await file.createWritable({ keepExistingData: true });
  await writer.write({ data: Uint8Array.of(1, 2, 3), position: 0 });
  await writer.close();
  vi.spyOn(mounted.root, 'getEntryHandle').mockResolvedValue(file);
  return { ...mounted, file };
}

describe('Wesh StorageDirectoryHandle remote', () => {
  describe('pending resource ownership', () => {
    it('waits for late writable acquisition and abort before finishing disposal', async () => {
      const { remote, file } = await createExistingFileFixture();
      const writer = await file.createWritable({ keepExistingData: true });
      const acquisition = Promise.withResolvers<typeof writer>();
      const acquisitionStarted = Promise.withResolvers<void>();
      const abortStarted = Promise.withResolvers<void>();
      const releaseAbort = Promise.withResolvers<void>();
      const originalAbort = writer.abort.bind(writer);
      const abort = vi.spyOn(writer, 'abort').mockImplementation(async request => {
        abortStarted.resolve();
        await releaseAbort.promise;
        await originalAbort(request);
        throw undefined;
      });
      const close = vi.spyOn(writer, 'close');
      vi.spyOn(file, 'createWritable').mockImplementation(() => {
        acquisitionStarted.resolve();
        return acquisition.promise;
      });
      const opening = Promise.allSettled([remote.open({
        mountPath: MOUNT_PATH, path: '/value.txt',
        flags: { ...READ_WRITE_CREATE_FLAGS, truncate: 'truncate' },
      })]);
      await acquisitionStarted.promise;
      let disposed = false;
      const disposal = remote.dispose().then(() => {
        disposed = true;
      });
      const repeatedDisposal = remote.dispose();
      try {
        acquisition.resolve(writer);
        expect(await Promise.race([
          abortStarted.promise.then(() => 'abort'),
          disposal.then(() => 'disposed'),
          repeatedDisposal.then(() => 'repeated disposal'),
        ])).toBe('abort');
        expect(disposed).toBe(false);
        releaseAbort.resolve();
        expect(await opening).toEqual([{ status: 'rejected', reason: expect.objectContaining({
          message: 'Wesh storage directory remote is disposed',
        }) }]);
        await Promise.all([disposal, repeatedDisposal]);
        expect(abort).toHaveBeenCalledOnce();
        expect(close).not.toHaveBeenCalled();
        const reader = await file.openReadable({ mimeType: 'application/octet-stream' });
        const bytes = new Uint8Array(3);
        await reader.read({ buffer: bytes, offset: 0, length: 3, position: 0, signal: undefined });
        await reader.close();
        expect(bytes).toEqual(Uint8Array.of(1, 2, 3));
        await expect(remote.open({ mountPath: MOUNT_PATH, path: '/value.txt', flags: READ_ONLY_FLAGS }))
          .rejects.toThrow('remote is disposed');
      } finally {
        acquisition.resolve(writer);
        releaseAbort.resolve();
        await opening;
        await Promise.all([disposal, repeatedDisposal]);
      }
    });

    it.each([new Error('writer acquisition failed'), undefined])(
      'preserves a pending open rejection %s during disposal', async cause => {
        const { remote, file } = await createExistingFileFixture();
        const acquisition = Promise.withResolvers<Awaited<ReturnType<typeof file.createWritable>>>();
        const acquisitionStarted = Promise.withResolvers<void>();
        const createWritable = vi.spyOn(file, 'createWritable').mockImplementation(() => {
          acquisitionStarted.resolve();
          return acquisition.promise;
        });
        const opening = Promise.allSettled([remote.open({
          mountPath: MOUNT_PATH, path: '/value.txt', flags: READ_WRITE_CREATE_FLAGS,
        })]);
        await acquisitionStarted.promise;
        const disposal = remote.dispose();
        acquisition.reject(cause);
        expect(await opening).toEqual([{ status: 'rejected', reason: cause }]);
        await disposal;
        expect(createWritable).toHaveBeenCalledOnce();
      },
    );

    it.each([
      { mode: 'close', cause: new Error('late reader close failed') },
      { mode: 'close', cause: undefined },
      { mode: 'dispose', cause: undefined },
    ] as const)('owns late reader cleanup during $mode with failure $cause', async ({ mode, cause }) => {
      const { remote, file } = await createExistingFileFixture();
      const reader = await file.openReadable({ mimeType: 'application/octet-stream' });
      const acquisition = Promise.withResolvers<typeof reader>();
      const acquisitionStarted = Promise.withResolvers<void>();
      const closeStarted = Promise.withResolvers<void>();
      const releaseClose = Promise.withResolvers<void>();
      const openReadable = vi.spyOn(file, 'openReadable').mockImplementation(() => {
        acquisitionStarted.resolve();
        return acquisition.promise;
      });
      const sourceRead = vi.spyOn(reader, 'read');
      const sourceClose = vi.spyOn(reader, 'close').mockImplementation(async () => {
        closeStarted.resolve();
        await releaseClose.promise;
        throw cause;
      });
      const handle = new OpenStorageFile({ fileHandle: file, flags: READ_ONLY_FLAGS });
      await handle.initialize();
      const { handleId } = await remote.open({ mountPath: MOUNT_PATH, path: '/value.txt', flags: READ_ONLY_FLAGS });
      const read = Promise.allSettled([mode === 'close'
        ? handle.read({ buffer: new Uint8Array(1) })
        : remote.read({ handleId, length: 1, position: 0 })]);
      await acquisitionStarted.promise;
      let ended = false;
      const endings = Promise.allSettled(mode === 'close'
        ? [handle.close(), handle.close()]
        : [remote.dispose(), remote.dispose()]).then(result => {
        ended = true;
        return result;
      });
      try {
        acquisition.resolve(reader);
        expect(await Promise.race([
          closeStarted.promise.then(() => 'close'),
          endings.then(() => 'ended'),
        ])).toBe('close');
        expect(ended).toBe(false);
        expect(await read).toEqual([{ status: 'rejected', reason: expect.objectContaining({
          message: 'The Wesh file handle is closed',
        }) }]);
        expect(sourceRead).not.toHaveBeenCalled();
        releaseClose.resolve();
        expect(await endings).toEqual(mode === 'close'
          ? [{ status: 'rejected', reason: cause }, { status: 'rejected', reason: cause }]
          : [{ status: 'fulfilled', value: undefined }, { status: 'fulfilled', value: undefined }]);
        expect(sourceClose).toHaveBeenCalledOnce();
        await handle.close();
        expect(openReadable).toHaveBeenCalledOnce();
      } finally {
        acquisition.resolve(reader);
        releaseClose.resolve();
        await read;
        await endings;
        await remote.dispose();
      }
    });

    it.each([
      { ending: false, cause: new Error('reader acquisition failed') },
      { ending: false, cause: undefined },
      { ending: true, cause: new Error('reader acquisition failed') },
      { ending: true, cause: undefined },
    ])('preserves reader acquisition failure $cause with ending=$ending', async ({ ending, cause }) => {
      const { remote, file } = await createExistingFileFixture();
      const reader = await file.openReadable({ mimeType: 'application/octet-stream' });
      const sourceClose = vi.spyOn(reader, 'close');
      const acquisition = Promise.withResolvers<typeof reader>();
      const openReadable = vi.spyOn(file, 'openReadable')
        .mockReturnValueOnce(acquisition.promise).mockResolvedValue(reader);
      const handle = new OpenStorageFile({ fileHandle: file, flags: READ_ONLY_FLAGS });
      await handle.initialize();
      const read = Promise.allSettled([handle.read({ buffer: new Uint8Array(1) })]);
      const close = ending ? handle.close() : undefined;
      acquisition.reject(cause);
      expect(await read).toEqual([{ status: 'rejected', reason: cause }]);
      await close;
      if (ending) {
        await expect(handle.read({ buffer: new Uint8Array(1) })).rejects.toThrow('handle is closed');
        expect(openReadable).toHaveBeenCalledOnce();
        expect(sourceClose).not.toHaveBeenCalled();
      } else {
        const bytes = new Uint8Array(1);
        await handle.read({ buffer: bytes, position: 0 });
        expect(bytes).toEqual(Uint8Array.of(1));
        await handle.read({ buffer: bytes, position: 1 });
        expect(bytes).toEqual(Uint8Array.of(2));
        expect(openReadable).toHaveBeenCalledTimes(2);
        await handle.close();
        expect(sourceClose).toHaveBeenCalledOnce();
      }
      await remote.dispose();
    });

    it.each([new Error('writer close failed'), undefined])(
      'keeps a closing remote file owned until close failure %s settles', async cause => {
        const { remote, file } = await createExistingFileFixture();
        const writer = await file.createWritable({ keepExistingData: true });
        const closeStarted = Promise.withResolvers<void>();
        const releaseClose = Promise.withResolvers<void>();
        const events: string[] = [];
        const sourceClose = vi.spyOn(writer, 'close').mockImplementation(async () => {
          closeStarted.resolve();
          await releaseClose.promise;
          events.push('lower close settled');
          throw cause;
        });
        const sourceAbort = vi.spyOn(writer, 'abort');
        vi.spyOn(file, 'createWritable').mockResolvedValue(writer);
        const { handleId } = await remote.open({ mountPath: MOUNT_PATH, path: '/value.txt', flags: READ_WRITE_CREATE_FLAGS });
        const firstClose = Promise.allSettled([remote.close({ handleId })]);
        await closeStarted.promise;
        const secondClose = Promise.allSettled([remote.close({ handleId }).finally(() => {
          events.push('second close settled');
        })]);
        const disposal = remote.dispose().then(() => {
          events.push('disposed');
        });
        try {
          releaseClose.resolve();
          expect(await firstClose).toEqual([{ status: 'rejected', reason: cause }]);
          expect(await secondClose).toEqual([{ status: 'rejected', reason: cause }]);
          await disposal;
          expect(events[0]).toBe('lower close settled');
          expect(events).toHaveLength(3);
          expect(sourceClose).toHaveBeenCalledOnce();
          expect(sourceAbort).not.toHaveBeenCalled();
        } finally {
          releaseClose.resolve();
          await Promise.all([firstClose, secondClose, disposal]);
          await writer.abort({ reason: undefined });
        }
      },
    );

    it('keeps abort as the first terminal mode when close joins it', async () => {
      const { remote, file } = await createExistingFileFixture();
      const writer = await file.createWritable({ keepExistingData: true });
      const abortStarted = Promise.withResolvers<void>();
      const releaseAbort = Promise.withResolvers<void>();
      const events: string[] = [];
      const sourceAbort = vi.spyOn(writer, 'abort').mockImplementation(async () => {
        abortStarted.resolve();
        await releaseAbort.promise;
        events.push('lower abort settled');
        throw undefined;
      });
      const sourceClose = vi.spyOn(writer, 'close');
      vi.spyOn(file, 'createWritable').mockResolvedValue(writer);
      const handle = new OpenStorageFile({ fileHandle: file, flags: READ_WRITE_CREATE_FLAGS });
      await handle.initialize();
      const abort = handle.abort();
      await abortStarted.promise;
      const close = handle.close().then(() => {
        events.push('close settled');
      });
      releaseAbort.resolve();
      await Promise.all([abort, close]);
      expect(sourceAbort).toHaveBeenCalledOnce();
      expect(sourceClose).not.toHaveBeenCalled();
      expect(events).toEqual(['lower abort settled', 'close settled']);
      await handle.close();
      await remote.dispose();
    });

    it('shares cold reader acquisition without serializing reads or delaying the warm path', async () => {
      const { remote, file } = await createExistingFileFixture();
      const reader = await file.openReadable({ mimeType: 'application/octet-stream' });
      const acquisition = Promise.withResolvers<typeof reader>();
      const readsStarted = Promise.withResolvers<void>();
      const releaseReads = Promise.withResolvers<void>();
      const originalRead = reader.read.bind(reader);
      let readCount = 0;
      const sourceRead = vi.spyOn(reader, 'read').mockImplementation(async request => {
        if (++readCount === 2) readsStarted.resolve();
        await releaseReads.promise;
        return originalRead(request);
      });
      const openReadable = vi.spyOn(file, 'openReadable').mockReturnValue(acquisition.promise);
      const handle = new OpenStorageFile({ fileHandle: file, flags: READ_ONLY_FLAGS });
      await handle.initialize();
      const first = new Uint8Array(1);
      const second = new Uint8Array(1);
      const reads = Promise.all([
        handle.read({ buffer: first, position: 0 }),
        handle.read({ buffer: second, position: 1 }),
      ]);
      try {
        expect(openReadable).toHaveBeenCalledOnce();
        acquisition.resolve(reader);
        await readsStarted.promise;
        expect(sourceRead).toHaveBeenCalledTimes(2);
        releaseReads.resolve();
        await reads;
        expect(first).toEqual(Uint8Array.of(1));
        expect(second).toEqual(Uint8Array.of(2));
        const warm = handle.read({ buffer: first, position: 2 });
        expect(sourceRead).toHaveBeenCalledTimes(3);
        await warm;
        expect(first).toEqual(Uint8Array.of(3));
        expect(openReadable).toHaveBeenCalledOnce();
      } finally {
        acquisition.resolve(reader);
        releaseReads.resolve();
        await reads;
        await handle.close();
        await remote.dispose();
      }
    });

    it('preserves Blob close without adding a drain for an already admitted read', async () => {
      const { remote, file } = await createExistingFileFixture();
      const reader = await file.openReadable({ mimeType: 'application/octet-stream' });
      const readStarted = Promise.withResolvers<void>();
      const releaseRead = Promise.withResolvers<void>();
      const originalRead = reader.read.bind(reader);
      vi.spyOn(reader, 'read').mockImplementation(async request => {
        readStarted.resolve();
        await releaseRead.promise;
        return originalRead(request);
      });
      const sourceClose = vi.spyOn(reader, 'close');
      vi.spyOn(file, 'openReadable').mockResolvedValue(reader);
      const handle = new OpenStorageFile({ fileHandle: file, flags: READ_ONLY_FLAGS });
      await handle.initialize();
      let readFinished = false;
      const bytes = new Uint8Array(1);
      const read = handle.read({ buffer: bytes, position: 0 }).then(result => {
        readFinished = true;
        return result;
      });
      try {
        await readStarted.promise;
        await handle.close();
        expect(sourceClose).toHaveBeenCalledOnce();
        expect(readFinished).toBe(false);
        releaseRead.resolve();
        expect(await read).toEqual({ bytesRead: 1 });
        expect(bytes).toEqual(Uint8Array.of(1));
      } finally {
        releaseRead.resolve();
        await read;
        await remote.dispose();
      }
    });
  });

  it.each([
    { label: 'empty', size: 0 },
    { label: 'smaller than the preview chunk', size: 31 },
    { label: 'at the preview chunk boundary', size: 64 * 1024 },
    { label: 'larger than the preview chunk', size: 64 * 1024 + 17 },
  ])('clamps $label reads to the current logical file size', async ({ size }) => {
    const bytes = Uint8Array.from({ length: size }, (_unused, index) => index & 0xff);
    const read = vi.fn(async ({ buffer, length, offset, position }: {
      buffer: Uint8Array;
      length: number;
      offset: number;
      position: number;
      signal: AbortSignal | undefined;
    }) => {
      if (position > bytes.byteLength || length > bytes.byteLength - position) {
        throw new RangeError('file read range exceeds file size');
      }
      buffer.set(bytes.subarray(position, position + length), offset);
      return { bytesRead: length };
    });
    const fileHandle: StorageFileHandle = {
      kind: 'file',
      name: 'preview.bin',
      stat: vi.fn(async () => ({ createdAt: undefined, modifiedAt: undefined, size })),
      openReadable: vi.fn(async ({ mimeType }: { mimeType: string }): Promise<StorageBinaryObjectReadHandle> => ({
        backing: { type: 'reader_only' },
        close: vi.fn(async () => undefined),
        mimeType,
        read,
        size,
        stream: vi.fn(({ end: _end, signal: _signal, start: _start }: {
          end: number | undefined;
          signal: AbortSignal | undefined;
          start: number;
        }) => new ReadableStream<Uint8Array>()),
      })),
      createWritable: vi.fn(),
    };
    const handle = new OpenStorageFile({ fileHandle, flags: READ_ONLY_FLAGS });
    await handle.initialize();
    const first = new Uint8Array(64 * 1024);
    const firstResult = await handle.read({ buffer: first });
    const second = new Uint8Array(64 * 1024);
    const secondResult = await handle.read({ buffer: second });

    expect(firstResult.bytesRead).toBe(Math.min(size, first.byteLength));
    expect(secondResult.bytesRead).toBe(Math.max(0, size - first.byteLength));
    expect(read.mock.calls.every(([request]) => request.position + request.length <= size)).toBe(true);
    await handle.close();
  });

  it.each([
    { label: 'shrink', initial: 'abcdef', captured: 'xy', position: 0 },
    { label: 'growth', initial: 'ab', captured: 'abcdef', position: 0 },
    { label: 'growth beyond the old EOF', initial: 'ab', captured: 'abcdef', position: 2 },
    { label: 'growth from empty', initial: '', captured: 'abc', position: 0 },
  ])('uses the lazily captured reader size after $label', async ({ initial, captured, position }) => {
    const root = createInMemoryStorageRoot({ name: 'storage-root' });
    const file = await root.getFileHandle({ name: 'value.txt', create: true });
    const replaceContents = async ({ value }: { value: string }) => {
      const writer = await file.createWritable({ keepExistingData: false });
      await writer.write({ data: new TextEncoder().encode(value), position: 0 });
      await writer.close();
    };
    await replaceContents({ value: initial });
    const originalOpen = file.openReadable.bind(file);
    const openReadable = vi.spyOn(file, 'openReadable').mockImplementation(async request => {
      const reader = await originalOpen(request);
      const originalRead = reader.read.bind(reader);
      vi.spyOn(reader, 'read').mockImplementation(readRequest => {
        expect(readRequest.position + readRequest.length).toBeLessThanOrEqual(reader.size);
        return originalRead(readRequest);
      });
      return reader;
    });
    const handle = new OpenStorageFile({ fileHandle: file, flags: READ_ONLY_FLAGS });
    await handle.initialize();
    try {
      expect(await handle.stat()).toMatchObject({ size: initial.length });
      expect(await handle.read({ buffer: new Uint8Array(1), length: 0 })).toEqual({ bytesRead: 0 });
      expect(openReadable).not.toHaveBeenCalled();
      await replaceContents({ value: captured });
      const bytes = new Uint8Array(16);
      expect(await handle.read({ buffer: bytes, position })).toEqual({ bytesRead: captured.length - position });
      expect(new TextDecoder().decode(bytes.subarray(0, captured.length - position))).toBe(captured.slice(position));
      expect(await handle.stat()).toMatchObject({ size: captured.length });

      await replaceContents({ value: 'z' });
      expect(await handle.stat()).toMatchObject({ size: captured.length });
      expect(await handle.read({ buffer: bytes })).toEqual({ bytesRead: captured.length });
      expect(new TextDecoder().decode(bytes.subarray(0, captured.length))).toBe(captured);
      expect(await handle.read({ buffer: bytes })).toEqual({ bytesRead: 0 });
      expect(openReadable).toHaveBeenCalledOnce();
    } finally {
      await handle.close();
    }
  });

  it('publishes multiple Wesh writes only when the storage writable closes', async () => {
    const { provider, remote } = await createMountedStorageDirectory();
    const handle = await provider.open({
      path: `${MOUNT_PATH}/value.txt`,
      flags: READ_WRITE_CREATE_FLAGS,
    });

    await handle.write({
      buffer: new TextEncoder().encode('abcdef'),
      position: 0,
    });
    await handle.write({
      buffer: new TextEncoder().encode('XY'),
      position: 2,
    });
    await handle.truncate({ size: 5 });

    expect(await provider.stat({ path: `${MOUNT_PATH}/value.txt` })).toMatchObject({
      type: 'file',
      size: 0,
    });
    expect(await handle.stat()).toMatchObject({ size: 5 });

    const staged = new Uint8Array(5);
    expect(await handle.read({ buffer: staged, position: 0 })).toEqual({ bytesRead: 5 });
    expect(new TextDecoder().decode(staged)).toBe('abXYe');
    await expect(readAll({ provider, path: `${MOUNT_PATH}/value.txt` })).resolves.toBe('');

    await handle.close();
    await expect(readAll({
      provider,
      path: `${MOUNT_PATH}/value.txt`,
    })).resolves.toBe('abXYe');

    await remote.dispose();
  });

  it.each(['success', 'undefined failure'] as const)(
    'aborts an unsupported read-write handle before truncation with %s cleanup', async cleanup => {
      const root = createInMemoryStorageRoot({ name: 'storage-root' });
      const fileHandle = await root.getFileHandle({ name: 'value.txt', create: true });
      const writable = await fileHandle.createWritable({ keepExistingData: true });
      const truncate = vi.spyOn(writable, 'truncate');
      const abort = vi.spyOn(writable, 'abort').mockImplementation(async () => {
        if (cleanup === 'undefined failure') throw undefined;
      });
      vi.spyOn(fileHandle, 'createWritable').mockResolvedValue({
        read: undefined,
        abort,
        truncate,
        close: () => writable.close(),
        write: request => writable.write(request),
      });
      const handle = new OpenStorageFile({
        fileHandle,
        flags: { ...READ_WRITE_CREATE_FLAGS, truncate: 'truncate' },
      });
      const result = await handle.initialize().then(
        () => ({ type: 'resolved' as const }),
        cause => ({ type: 'rejected' as const, cause }),
      );
      expect(result.type).toBe('rejected');
      if (result.type !== 'rejected') throw new Error('expected unsupported writable read rejection');
      const primary = abort.mock.calls[0]?.[0].reason;
      expect(primary).toBeInstanceOf(Error);
      expect((primary as Error).message).toContain('reading staged contents');
      if (cleanup === 'success') expect(result.cause).toBe(primary);
      else expect(result.cause).toMatchObject({ errors: [primary, undefined] });
      expect(abort).toHaveBeenCalledOnce();
      expect(truncate).not.toHaveBeenCalled();
      await handle.close();
      expect(abort).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { access: 'write', cause: new Error('initial truncate failed'), cleanup: undefined },
    { access: 'read-write', cause: undefined, cleanup: undefined },
    { access: 'write', cause: undefined, cleanup: { cause: new Error('initial abort failed') } },
    { access: 'read-write', cause: new Error('initial truncate failed'), cleanup: { cause: undefined } },
  ] as const)('aborts an unregistered $access file after initial truncate fails with $cause and $cleanup', async ({ access, cause, cleanup }) => {
    const { root, remote, provider } = await createMountedStorageDirectory();
    const file = await root.getFileHandle({ name: 'value.txt', create: true });
    const initial = await file.createWritable({ keepExistingData: true });
    await initial.write({ data: new TextEncoder().encode('original'), position: 0 });
    await initial.close();
    const writer = await file.createWritable({ keepExistingData: true });
    const releaseAbort = Promise.withResolvers<void>();
    const abortStarted = Promise.withResolvers<void>();
    const originalAbort = writer.abort.bind(writer);
    const abort = vi.spyOn(writer, 'abort').mockImplementation(async request => {
      abortStarted.resolve();
      await releaseAbort.promise;
      await originalAbort(request);
      if (cleanup !== undefined) throw cleanup.cause;
    });
    const close = vi.spyOn(writer, 'close');
    vi.spyOn(writer, 'truncate').mockRejectedValue(cause);
    vi.spyOn(file, 'createWritable').mockResolvedValue(writer);
    vi.spyOn(root, 'getEntryHandle').mockResolvedValue(file);
    let settled = false;
    const opening = remote.open({
      mountPath: MOUNT_PATH,
      path: '/value.txt',
      flags: { ...READ_WRITE_CREATE_FLAGS, access, truncate: 'truncate' },
    }).then(
      () => ({ type: 'resolved' as const }),
      failure => ({ type: 'rejected' as const, failure }),
    ).finally(() => {
      settled = true;
    });
    try {
      expect(await Promise.race([
        abortStarted.promise.then(() => 'abort'),
        opening.then(() => 'settled'),
      ])).toBe('abort');
      expect(settled).toBe(false);
      releaseAbort.resolve();
      const result = await opening;
      expect(result.type).toBe('rejected');
      if (result.type !== 'rejected') throw new Error('expected initial truncate rejection');
      if (cleanup === undefined) expect(result.failure).toBe(cause);
      else expect(result.failure).toMatchObject({ errors: [cause, cleanup.cause] });
      expect(abort).toHaveBeenCalledExactlyOnceWith({ reason: cause });
      expect(close).not.toHaveBeenCalled();
      expect(await readAll({ provider, path: `${MOUNT_PATH}/value.txt` })).toBe('original');
      await remote.dispose();
      expect(abort).toHaveBeenCalledOnce();
    } finally {
      releaseAbort.resolve();
      await opening;
      await remote.dispose();
    }
  });

  it.each([
    { owner: 'writer', cause: new Error('writer close failed') },
    { owner: 'writer', cause: undefined },
    { owner: 'writer', cause: null },
    { owner: 'reader', cause: new Error('reader close failed') },
    { owner: 'reader', cause: undefined },
  ] as const)('preserves $owner close failure $cause and settles only once', async ({ owner, cause }) => {
    const root = createInMemoryStorageRoot({ name: 'storage-root' });
    const fileHandle = await root.getFileHandle({ name: 'value.txt', create: true });
    const initial = await fileHandle.createWritable({ keepExistingData: true });
    await initial.write({ data: Uint8Array.of(1), position: 0 });
    await initial.close();
    const writer = await fileHandle.createWritable({ keepExistingData: true });
    const reader = await fileHandle.openReadable({ mimeType: 'application/octet-stream' });
    vi.spyOn(fileHandle, 'createWritable').mockResolvedValue(writer);
    vi.spyOn(fileHandle, 'openReadable').mockResolvedValue(reader);
    const writerClose = vi.spyOn(writer, 'close');
    const readerClose = vi.spyOn(reader, 'close');
    const failedClose = owner === 'writer' ? writerClose : readerClose;
    failedClose.mockRejectedValue(cause);
    const handle = new OpenStorageFile({
      fileHandle, flags: owner === 'writer' ? READ_WRITE_CREATE_FLAGS : READ_ONLY_FLAGS,
    });
    await handle.initialize();
    await handle.read({ buffer: new Uint8Array(1) });

    await expect(handle.close()).rejects.toBe(cause);
    await expect(handle.close()).resolves.toBeUndefined();
    expect(failedClose).toHaveBeenCalledOnce();
    expect(owner === 'writer' ? readerClose : writerClose).not.toHaveBeenCalled();
    await writer.abort({ reason: undefined });
  });

  it('supports recursive directories, cross-directory rename, and symbolic links', async () => {
    const { provider, remote } = await createMountedStorageDirectory();
    await provider.mkdir?.({
      path: `${MOUNT_PATH}/from/nested`,
      recursive: true,
    });
    await provider.mkdir?.({
      path: `${MOUNT_PATH}/to`,
      recursive: false,
    });
    const file = await provider.open({
      path: `${MOUNT_PATH}/from/nested/before.txt`,
      flags: READ_WRITE_CREATE_FLAGS,
    });
    await file.write({ buffer: new TextEncoder().encode('payload') });
    await file.close();

    await provider.rename?.({
      oldPath: `${MOUNT_PATH}/from/nested/before.txt`,
      newPath: `${MOUNT_PATH}/to/after.txt`,
    });
    await provider.symlink?.({
      path: `${MOUNT_PATH}/to/after-link`,
      targetPath: 'after.txt',
    });

    await expect(provider.lstat({ path: `${MOUNT_PATH}/to/after-link` }))
      .resolves.toMatchObject({ type: 'symlink' });
    await expect(provider.stat({ path: `${MOUNT_PATH}/to/after-link` }))
      .resolves.toMatchObject({ type: 'file', size: 7 });
    await expect(provider.readlink({ path: `${MOUNT_PATH}/to/after-link` }))
      .resolves.toBe('after.txt');
    await expect(readAll({
      provider,
      path: `${MOUNT_PATH}/to/after-link`,
    })).resolves.toBe('payload');

    const entries = [];
    for await (const entry of provider.readDir({ path: `${MOUNT_PATH}/to` })) {
      entries.push(entry);
    }
    expect(entries).toHaveLength(2);
    expect(entries).toEqual(expect.arrayContaining([
      {
        name: 'after-link',
        type: 'symlink',
        fullPath: `${MOUNT_PATH}/to/after-link`,
      },
      {
        name: 'after.txt',
        type: 'file',
        fullPath: `${MOUNT_PATH}/to/after.txt`,
      },
    ]));

    await remote.dispose();
  });

  it('enforces read-only mounts for all mutation entry points', async () => {
    const { provider, remote } = await createMountedStorageDirectory({ readOnly: true });
    await expect(provider.open({
      path: `${MOUNT_PATH}/new.txt`,
      flags: READ_WRITE_CREATE_FLAGS,
    })).rejects.toThrow('Read-only storage directory mount');
    await expect(provider.mkdir?.({
      path: `${MOUNT_PATH}/new-directory`,
      recursive: false,
    })).rejects.toThrow('Read-only storage directory mount');
    await expect(provider.symlink?.({
      path: `${MOUNT_PATH}/new-link`,
      targetPath: 'target',
    })).rejects.toThrow('Read-only storage directory mount');

    await remote.dispose();
  });

  it('aborts uncommitted writers when the remote is disposed', async () => {
    const { provider, remote, root } = await createMountedStorageDirectory();
    const initial = await provider.open({
      path: `${MOUNT_PATH}/existing.txt`,
      flags: READ_WRITE_CREATE_FLAGS,
    });
    await initial.write({ buffer: new TextEncoder().encode('original') });
    await initial.close();

    const pending = await provider.open({
      path: `${MOUNT_PATH}/existing.txt`,
      flags: READ_WRITE_CREATE_FLAGS,
    });
    await pending.write({
      buffer: new TextEncoder().encode('replacement'),
      position: 0,
    });
    await remote.dispose();

    const secondRemote = createWeshStorageDirectoryRemoteForMounts({
      mounts: [{
        type: 'storage_directory',
        path: MOUNT_PATH,
        handle: root,
        readOnly: false,
      }],
      storageDirectoryExecution: 'ui_remote',
    });
    if (secondRemote === undefined) {
      throw new Error('Expected replacement storage directory remote');
    }
    const secondProvider = new RemoteStorageDirectoryWeshProvider({
      remote: secondRemote,
      mountPath: MOUNT_PATH,
    });
    await expect(readAll({
      provider: secondProvider,
      path: `${MOUNT_PATH}/existing.txt`,
    })).resolves.toBe('original');

    await secondRemote.dispose();
  });
});
