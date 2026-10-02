import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toBinaryObjectId, toChatGroupId, toChatId } from '@/01-models/ids';
import type { Settings } from '@/01-models/types';
import { SettingsSchemaDto } from '@/00-storage/00-dto/dto';
import { settingsToDto } from '@/00-storage/mapper/mappers';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { createNativeOpfsFileSystemSession } from '@/00-storage/service/storage-file-system/native-opfs';
import type {
  StorageDirectoryHandle,
  StorageEntryHandle,
  StorageFileHandle,
  StorageFileSystemSession,
  StorageWritableFile,
} from '@/00-storage/service/storage-file-system/types';
import { HostVolumeDB } from '@/00-storage/service/opfs/host-volume-db';
import {
  createBlobStorageBinaryObjectReadHandle,
  type StorageBinaryObjectReadHandle,
} from '@/00-storage/service/binary-object-io';
import { NaidanOpfsStorageBackend } from './backend';
import { NaidanOpfsLayoutDirectoryHandle, NaidanOpfsLayoutFileHandle } from './layout-handle';

const BINARY_OBJECT_ID = toBinaryObjectId({
  raw: '00000000-0000-4000-a000-0000000000a1',
});

const SETTINGS: Settings = {
  titleGeneration: {
    endpoint: 'same_scope',
    model: 'same_scope',
    lmParameters: {
      temperature: undefined,
      topP: undefined,
      maxCompletionTokens: undefined,
      presencePenalty: undefined,
      frequencyPenalty: undefined,
      stop: undefined,
      reasoning: { effort: undefined },
    },
  },
  storageType: 'opfs',
  providerProfiles: [],
  mounts: [],
  endpoint: { type: 'openai', url: 'http://localhost' },
};

type LogicalTreeValue =
  | { readonly kind: 'directory' }
  | { readonly kind: 'file'; readonly bytes: readonly number[] }
  | { readonly kind: 'symlink'; readonly target: string };

async function readLogicalTree({ root }: {
  root: StorageDirectoryHandle;
}): Promise<Readonly<Record<string, LogicalTreeValue>>> {
  const values: Record<string, LogicalTreeValue> = {};

  async function visit({ directory, prefix }: {
    directory: StorageDirectoryHandle;
    prefix: string;
  }): Promise<void> {
    const entries: Array<readonly [string, StorageEntryHandle]> = [];
    for await (const entry of directory.entries()) {
      entries.push(entry);
    }
    entries.sort(([left], [right]) => left.localeCompare(right));

    for (const [name, handle] of entries) {
      const path = prefix.length === 0 ? name : `${prefix}/${name}`;
      switch (handle.kind) {
      case 'directory':
        values[path] = { kind: 'directory' };
        await visit({ directory: handle, prefix: path });
        break;
      case 'file': {
        const readable = await handle.openReadable({
          mimeType: 'application/octet-stream',
        });
        try {
          const bytes = new Uint8Array(await new Response(readable.stream({
            start: 0,
            end: undefined,
            signal: undefined,
          })).arrayBuffer());
          values[path] = { kind: 'file', bytes: [...bytes] };
        } finally {
          await readable.close();
        }
        break;
      }
      case 'symlink':
        values[path] = { kind: 'symlink', target: await handle.readTarget() };
        break;
      default: {
        const _ex: never = handle;
        throw new Error(`Unhandled storage entry: ${String(_ex)}`);
      }
      }
    }
  }

  await visit({ directory: root, prefix: '' });
  return values;
}

async function exerciseBackend({ session }: {
  session: StorageFileSystemSession;
}): Promise<Readonly<Record<string, LogicalTreeValue>>> {
  const backend = new NaidanOpfsStorageBackend({
    namespaceRoot: session.root,
    hostVolumeDB: new HostVolumeDB(),
  });
  await backend.init();
  await backend.saveSettings({ settings: SETTINGS });
  await backend.writeBinaryObject({
    source: {
      type: 'direct_blob',
      blob: new Blob([new Uint8Array([1, 2, 3, 4])], {
        type: 'application/octet-stream',
      }),
    },
    binaryObjectId: BINARY_OBJECT_ID,
    name: 'value.bin',
    mimeType: 'application/octet-stream',
    size: 4,
    createdAt: 123,
    signal: undefined,
  });

  const special = await backend.openSpecialFileSystemDirectory({
    type: 'debug_wesh',
    path: '/global/home',
    create: true,
  });
  expect(special?.type).toBe('storage_directory');
  if (special?.type !== 'storage_directory') {
    throw new Error('Expected a storage directory');
  }
  const file = await special.handle.getFileHandle({
    name: 'note.txt',
    create: true,
  });
  const writable = await file.createWritable({ keepExistingData: false });
  await writable.write({
    position: 0,
    data: new TextEncoder().encode('debug'),
  });
  await writable.close();

  expect(await backend.loadSettings()).toMatchObject(SETTINGS);
  const binary = await backend.openBinaryObject({
    binaryObjectId: BINARY_OBJECT_ID,
  });
  expect(binary).not.toBeNull();
  if (binary === null) {
    throw new Error('Expected the binary object');
  }
  try {
    expect([...new Uint8Array(await new Response(binary.stream({
      start: 0,
      end: undefined,
      signal: undefined,
    })).arrayBuffer())]).toEqual([1, 2, 3, 4]);
  } finally {
    await binary.close();
  }

  return await readLogicalTree({ root: session.root });
}

async function collectAsyncIterable<T>({ values }: {
  values: AsyncIterable<T>;
}): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) {
    result.push(value);
  }
  return result;
}

async function readerOnlyBinaryFixture({ bytes }: { bytes: Uint8Array<ArrayBuffer> }) {
  const root = new MockFileSystemDirectoryHandle({ name: 'reader-only-binary' });
  const session = createNativeOpfsFileSystemSession({ root });
  const backend = new NaidanOpfsStorageBackend({ namespaceRoot: session.root, hostVolumeDB: new HostVolumeDB() });
  await backend.init();
  await backend.saveFile({
    binaryObjectId: BINARY_OBJECT_ID, blob: new Blob([bytes]), name: 'value.bin', mimeType: 'application/x-indexed',
  });
  const direct = createBlobStorageBinaryObjectReadHandle({ blob: new Blob([bytes]), mimeType: 'application/octet-stream' });
  const read = vi.fn<StorageBinaryObjectReadHandle['read']>(async request => {
    if (request.position < 0 || request.position + request.length > bytes.length) throw new RangeError('exact range required');
    return await direct.read(request);
  });
  const stream = vi.fn<StorageBinaryObjectReadHandle['stream']>(request => {
    if (request.start < 0 || request.start > bytes.length || (request.end !== undefined && request.end > bytes.length)) {
      throw new RangeError('exact stream range required');
    }
    return direct.stream(request);
  });
  const close = vi.fn(async () => {});
  const openReadable = vi.fn<StorageFileHandle['openReadable']>(async () => ({
    backing: { type: 'reader_only' }, size: bytes.length, mimeType: 'application/octet-stream', read, stream, close,
  }));
  const originalLookup = NaidanOpfsLayoutDirectoryHandle.prototype.getFileHandle;
  const lookup = vi.spyOn(NaidanOpfsLayoutDirectoryHandle.prototype, 'getFileHandle')
    .mockImplementation(async function(this: NaidanOpfsLayoutDirectoryHandle, name, options) {
      if (name === '00000000-0000-4000-a000-0000000000a1.bin') {
        return new NaidanOpfsLayoutFileHandle({ handle: {
          kind: 'file', name, openReadable,
          async stat() {
            return { size: bytes.length, createdAt: undefined, modifiedAt: undefined };
          },
          async createWritable() {
            throw new Error('Unexpected body write');
          },
        } });
      }
      return await originalLookup.call(this, name, options);
    });
  return {
    backend, root, read, stream, close, openReadable,
    async dispose() {
      lookup.mockRestore(); await session.close();
    },
  };
}

describe('Naidan OPFS layout backend', () => {
  describe('single settings save writer ownership', () => {
    async function fixture() {
      const session = createNativeOpfsFileSystemSession({
        root: new MockFileSystemDirectoryHandle({ name: 'settings-write-root' }),
      });
      const backend = new NaidanOpfsStorageBackend({ namespaceRoot: session.root, hostVolumeDB: new HostVolumeDB() });
      await backend.init();
      const writable = {
        read: undefined,
        write: vi.fn<StorageWritableFile['write']>(async () => {}),
        truncate: vi.fn<StorageWritableFile['truncate']>(async () => {}),
        close: vi.fn<StorageWritableFile['close']>(async () => {}),
        abort: vi.fn<StorageWritableFile['abort']>(async () => {}),
      };
      const createWritable = vi.fn<StorageFileHandle['createWritable']>(async () => writable);
      const originalLookup = NaidanOpfsLayoutDirectoryHandle.prototype.getFileHandle;
      const lookup = vi.spyOn(NaidanOpfsLayoutDirectoryHandle.prototype, 'getFileHandle')
        .mockImplementation(async function(this: NaidanOpfsLayoutDirectoryHandle, name, options) {
          const file = await originalLookup.call(this, name, options);
          if (name === 'settings.json') vi.spyOn(file.handle, 'createWritable').mockImplementation(createWritable);
          return file;
        });
      return {
        backend, writable, createWritable,
        async dispose() {
          lookup.mockRestore();
          await session.close();
        },
      };
    }

    it('writes the same JSON with replacement semantics before closing', async () => {
      const { backend, writable, createWritable, dispose } = await fixture();
      try {
        await backend.saveSettings({ settings: SETTINGS });
        expect(createWritable).toHaveBeenCalledExactlyOnceWith({ keepExistingData: false });
        expect(writable.write).toHaveBeenCalledExactlyOnceWith({
          position: 0,
          data: new TextEncoder().encode(JSON.stringify(SettingsSchemaDto.parse(settingsToDto({ domain: SETTINGS })))),
        });
        expect(writable.close).toHaveBeenCalledOnce();
        expect(writable.write.mock.invocationCallOrder[0]).toBeLessThan(writable.close.mock.invocationCallOrder[0]!);
        expect(writable.abort).not.toHaveBeenCalled();
        expect(writable.truncate).not.toHaveBeenCalled();
      } finally {
        await dispose();
      }
    });

    it.each([new Error('settings write failed'), undefined])('aborts a failed write while retaining its cause (%s)', async cause => {
      const { backend, writable, dispose } = await fixture();
      writable.write.mockRejectedValueOnce(cause);
      try {
        await expect(backend.saveSettings({ settings: SETTINGS })).rejects.toBe(cause);
        expect(writable.abort).toHaveBeenCalledExactlyOnceWith({ reason: cause });
        expect(writable.close).not.toHaveBeenCalled();
      } finally {
        await dispose();
      }
    });

    it.each([
      { primary: new Error('settings write failed'), cleanup: new Error('settings abort failed') },
      { primary: undefined, cleanup: new Error('settings abort failed') },
      { primary: new Error('settings write failed'), cleanup: undefined },
    ])('keeps write and abort failures in operation order ($primary, $cleanup)', async ({ primary, cleanup }) => {
      const { backend, writable, dispose } = await fixture();
      writable.write.mockRejectedValueOnce(primary);
      writable.abort.mockRejectedValueOnce(cleanup);
      try {
        await expect(backend.saveSettings({ settings: SETTINGS })).rejects.toMatchObject({
          name: 'AggregateError',
          errors: [primary, cleanup],
        });
        expect(writable.abort).toHaveBeenCalledExactlyOnceWith({ reason: primary });
        expect(writable.close).not.toHaveBeenCalled();
      } finally {
        await dispose();
      }
    });

    it('does not abort the lower writer after layout close has settled', async () => {
      const { backend, writable, dispose } = await fixture();
      const cause = new Error('settings close failed');
      writable.close.mockRejectedValueOnce(cause);
      try {
        await expect(backend.saveSettings({ settings: SETTINGS })).rejects.toBe(cause);
        expect(writable.write).toHaveBeenCalledOnce();
        expect(writable.close).toHaveBeenCalledOnce();
        expect(writable.abort).not.toHaveBeenCalled();
      } finally {
        await dispose();
      }
    });

    it('does not create a writable when serialization fails', async () => {
      const { backend, writable, createWritable, dispose } = await fixture();
      const cause = new Error('settings serialization failed');
      const stringify = vi.spyOn(JSON, 'stringify').mockImplementationOnce(() => {
        throw cause;
      });
      try {
        await expect(backend.saveSettings({ settings: SETTINGS })).rejects.toBe(cause);
        expect(createWritable).not.toHaveBeenCalled();
        expect(writable.write).not.toHaveBeenCalled();
        expect(writable.close).not.toHaveBeenCalled();
        expect(writable.abort).not.toHaveBeenCalled();
      } finally {
        stringify.mockRestore();
        await dispose();
      }
    });

    it('preserves writable acquisition failure without attempting cleanup', async () => {
      const { backend, writable, createWritable, dispose } = await fixture();
      const cause = new Error('settings writable unavailable');
      createWritable.mockRejectedValueOnce(cause);
      try {
        await expect(backend.saveSettings({ settings: SETTINGS })).rejects.toBe(cause);
        expect(createWritable).toHaveBeenCalledOnce();
        expect(writable.write).not.toHaveBeenCalled();
        expect(writable.close).not.toHaveBeenCalled();
        expect(writable.abort).not.toHaveBeenCalled();
      } finally {
        await dispose();
      }
    });
  });

  it.each([0, 4])('opens a %i-byte reader-only body without materializing it and keeps Blob range semantics', async size => {
    const fixture = await readerOnlyBinaryFixture({ bytes: Uint8Array.from({ length: size }, (_, index) => index + 1) });
    try {
      const handle = await fixture.backend.openBinaryObject({ binaryObjectId: BINARY_OBJECT_ID });
      expect(handle).not.toBeNull();
      if (handle === null) throw new Error('Expected binary reader');
      expect(handle).toMatchObject({ size, mimeType: 'application/x-indexed', backing: { type: 'reader_only' } });
      expect(fixture.read).not.toHaveBeenCalled();
      expect(fixture.stream).not.toHaveBeenCalled();
      expect(fixture.close).not.toHaveBeenCalled();
      const expected = createBlobStorageBinaryObjectReadHandle({
        blob: new Blob([Uint8Array.from({ length: size }, (_, index) => index + 1)]), mimeType: handle.mimeType,
      });
      for (const { position, length, offset } of [
        { position: 0, length: 1, offset: 1 },
        { position: 0, length: 8, offset: 2 },
        { position: Math.max(0, size - 1), length: 4, offset: 0 },
        { position: size, length: 1, offset: 0 },
        { position: size + 1, length: 0, offset: 0 },
      ]) {
        const actualBuffer = new Uint8Array(5).fill(99);
        const expectedBuffer = actualBuffer.slice();
        expect(await handle.read({ buffer: actualBuffer, position, length, offset, signal: undefined }))
          .toEqual(await expected.read({ buffer: expectedBuffer, position, length, offset, signal: undefined }));
        expect(actualBuffer).toEqual(expectedBuffer);
      }
      if (size > 0) expect(fixture.read.mock.calls[0]?.[0]).toMatchObject({ position: 0, length: 1, offset: 1 });
      if (size > 1) {
        fixture.read.mockResolvedValueOnce({ bytesRead: 1 });
        await expect(handle.read({ buffer: new Uint8Array(size), offset: 0, position: 0, length: size, signal: undefined }))
          .resolves.toEqual({ bytesRead: 1 });
      }
      for (const [start, end] of [[0, undefined], [2, 20], [-2, undefined], [3, 1], [10, undefined]] as const) {
        const actual = await new Response(handle.stream({ start, end, signal: undefined })).arrayBuffer();
        const wanted = await new Response(expected.stream({ start, end, signal: undefined })).arrayBuffer();
        expect(new Uint8Array(actual)).toEqual(new Uint8Array(wanted));
      }
      const cancelled = handle.stream({ start: 0, end: undefined, signal: undefined });
      await cancelled.cancel();
      expect(fixture.close).not.toHaveBeenCalled();
      const controller = new AbortController();
      const abort = new Error('cancel binary read');
      controller.abort(abort);
      await expect(handle.read({ buffer: new Uint8Array(1), position: 0, length: 0, offset: 0, signal: controller.signal })).rejects.toBe(abort);
      expect(() => handle.stream({ start: 0, end: undefined, signal: controller.signal })).toThrow(abort);
      await handle.close();
      expect(fixture.close).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.dispose();
    }
  });

  it('reports lazy body failures at read or stream time and closes compatibility and dump readers', async () => {
    const fixture = await readerOnlyBinaryFixture({ bytes: Uint8Array.of(1, 2, 3) });
    const failure = new Error('binary body unavailable');
    fixture.read.mockRejectedValue(failure);
    fixture.stream.mockImplementation(() => new ReadableStream({ start(controller) {
      controller.error(failure);
    } }));
    try {
      const handle = await fixture.backend.openBinaryObject({ binaryObjectId: BINARY_OBJECT_ID });
      expect(handle).not.toBeNull();
      if (handle === null) throw new Error('Expected lazy reader');
      await expect(handle.read({ buffer: new Uint8Array(1), position: 0, length: 1, offset: 0, signal: undefined })).rejects.toBe(failure);
      await handle.close();
      await expect(fixture.backend.getFile({ binaryObjectId: BINARY_OBJECT_ID })).rejects.toBe(failure);
      const snapshot = await fixture.backend.dump();
      await expect(snapshot.contentStream[Symbol.asyncIterator]().next()).rejects.toBe(failure);
      expect(fixture.close).toHaveBeenCalledTimes(3);
    } finally {
      await fixture.dispose();
    }
  });

  it('does not acquire a body reader if reading its existing index fails', async () => {
    const fixture = await readerOnlyBinaryFixture({ bytes: Uint8Array.of(1) });
    const storage = await fixture.root.getDirectoryHandle('naidan-storage');
    const binaries = await storage.getDirectoryHandle('binary-objects');
    const shard = await binaries.getDirectoryHandle('a1');
    const index = await shard.getFileHandle('index.json');
    const indexRead = vi.spyOn(index, 'getFile').mockRejectedValue(new Error('index read failed'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(fixture.backend.openBinaryObject({ binaryObjectId: BINARY_OBJECT_ID })).resolves.toBeNull();
      expect(fixture.openReadable).not.toHaveBeenCalled();
      indexRead.mockRestore();
      fixture.openReadable.mockRejectedValue(new Error('body open failed'));
      await expect(fixture.backend.openBinaryObject({ binaryObjectId: BINARY_OBJECT_ID })).resolves.toBeNull();
      expect(fixture.openReadable).toHaveBeenCalledTimes(1);
      expect(fixture.close).not.toHaveBeenCalled();
    } finally {
      indexRead.mockRestore();
      log.mockRestore();
      await fixture.dispose();
    }
  });

  it('preserves layout read and close failures in operation order', async () => {
    const readFailure = new Error('layout read failed');
    const closeFailure = new Error('layout readable close failed');
    const close = vi.fn(async () => {
      throw closeFailure;
    });
    const handle: StorageFileHandle = {
      kind: 'file',
      name: 'value.bin',
      async stat() {
        throw readFailure;
      },
      async openReadable({ mimeType }) {
        return {
          size: 0,
          mimeType,
          backing: {
            type: 'direct_blob',
            blob: new Blob([], { type: mimeType }),
          },
          async read() {
            return { bytesRead: 0 };
          },
          stream() {
            return new ReadableStream<Uint8Array>();
          },
          close,
        };
      },
      async createWritable() {
        throw new Error('Unexpected writable creation');
      },
    };
    const file = new NaidanOpfsLayoutFileHandle({ handle });

    await expect(file.getFile()).rejects.toSatisfy((failure: unknown) => {
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([readFailure, closeFailure]);
      return true;
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not publish a migration binary chunk before its read handle closes', async () => {
    const session = createNativeOpfsFileSystemSession({
      root: new MockFileSystemDirectoryHandle({ name: 'dump-root' }),
    });
    const backend = new NaidanOpfsStorageBackend({
      namespaceRoot: session.root,
      hostVolumeDB: new HostVolumeDB(),
    });
    await backend.init();
    await backend.writeBinaryObject({
      source: {
        type: 'direct_blob',
        blob: new Blob([new Uint8Array([1, 2, 3])], {
          type: 'application/octet-stream',
        }),
      },
      binaryObjectId: BINARY_OBJECT_ID,
      name: 'value.bin',
      mimeType: 'application/octet-stream',
      size: 3,
      createdAt: 123,
      signal: undefined,
    });
    const opened = await backend.openBinaryObject({ binaryObjectId: BINARY_OBJECT_ID });
    expect(opened).not.toBeNull();
    if (opened === null) throw new Error('Expected binary object handle');

    const closeFailure = new Error('binary dump handle close failed');
    const close = vi.fn(async () => {
      throw closeFailure;
    });
    vi.spyOn(backend, 'openBinaryObject').mockResolvedValue({ ...opened, close });
    const snapshot = await backend.dump();
    await expect(snapshot.contentStream[Symbol.asyncIterator]().next()).rejects.toBe(closeFailure);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each(['malformed', 'NotFoundError', 'NotReadableError'] as const)(
    'rejects writes and dumps without changing binary bytes when the acquired index is %s',
    async failureKind => {
      const root = new MockFileSystemDirectoryHandle({ name: 'index-failure-root' });
      const session = createNativeOpfsFileSystemSession({ root });
      const backend = new NaidanOpfsStorageBackend({ namespaceRoot: session.root, hostVolumeDB: new HostVolumeDB() });
      await backend.init();
      await backend.saveFile({
        binaryObjectId: BINARY_OBJECT_ID, blob: new Blob(['original']), name: 'original.bin', mimeType: 'text/plain',
      });
      const storage = await root.getDirectoryHandle('naidan-storage');
      const binaries = await storage.getDirectoryHandle('binary-objects');
      const shard = await binaries.getDirectoryHandle('a1');
      const index = await shard.getFileHandle('index.json');
      const body = await shard.getFileHandle('00000000-0000-4000-a000-0000000000a1.bin');
      const marker = await shard.getFileHandle('.00000000-0000-4000-a000-0000000000a1.bin.complete');
      if (failureKind === 'malformed') {
        const writable = await index.createWritable();
        await writable.write('{invalid');
        await writable.close();
      }
      const before = await (await index.getFile()).text();
      const readIndex = vi.spyOn(index, 'getFile');
      if (failureKind !== 'malformed') {
        readIndex.mockRejectedValue(new DOMException('Index read failed after lookup', failureKind));
      }
      try {
        await expect(backend.saveFile({
          binaryObjectId: BINARY_OBJECT_ID, blob: new Blob(['replacement']), name: 'replacement.bin', mimeType: 'text/plain',
        })).rejects.toThrow();
        const snapshot = await backend.dump();
        await expect(collectAsyncIterable({ values: snapshot.contentStream })).rejects.toThrow();
        expect(await (await body.getFile()).text()).toBe('original');
        expect(await shard.getFileHandle(marker.name)).toBe(marker);
      } finally {
        readIndex.mockRestore();
      }
      expect(await (await index.getFile()).text()).toBe(before);
      await session.close();
    },
  );

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves existing bytes only when the layout writer explicitly requests it', async () => {
    const session = createNativeOpfsFileSystemSession({
      root: new MockFileSystemDirectoryHandle({ name: 'layout-root' }),
    });
    const root = new NaidanOpfsLayoutDirectoryHandle({ handle: session.root });
    const file = await root.getFileHandle('value.bin', { create: true });

    const initial = await file.createWritable();
    await initial.write(new Uint8Array([1, 2, 3]));
    await initial.close();

    const preserved = await file.createWritable({ keepExistingData: true });
    await preserved.write(new Uint8Array([9]));
    await preserved.close();

    expect([...new Uint8Array(await (await file.getFile()).arrayBuffer())]).toEqual([9, 2, 3]);
    expect([...await collectAsyncIterable({ values: root.keys() })]).toEqual(['value.bin']);
  });

  it('ignores missing delete targets but propagates storage failures', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'delete-root' });
    const session = createNativeOpfsFileSystemSession({ root });
    const backend = new NaidanOpfsStorageBackend({
      namespaceRoot: session.root,
      hostVolumeDB: new HostVolumeDB(),
    });
    await backend.init();

    const chatId = toChatId({ raw: '00000000-0000-4000-a000-0000000000c1' });
    const chatGroupId = toChatGroupId({ raw: '00000000-0000-4000-a000-0000000000c2' });

    await expect(backend.deleteChat({ id: chatId })).resolves.toBeUndefined();
    await expect(backend.deleteChatGroup({ id: chatGroupId })).resolves.toBeUndefined();
    await expect(backend.deleteBinaryObject({ binaryObjectId: BINARY_OBJECT_ID })).resolves.toBeUndefined();

    const failure = new DOMException('storage unavailable', 'UnknownError');
    const removeEntry = vi
      .spyOn(MockFileSystemDirectoryHandle.prototype, 'removeEntry')
      .mockRejectedValue(failure);

    await expect(backend.deleteChat({ id: chatId })).rejects.toBe(failure);
    await expect(backend.deleteChatGroup({ id: chatGroupId })).rejects.toBe(failure);
    await expect(backend.deleteBinaryObject({ binaryObjectId: BINARY_OBJECT_ID })).rejects.toBe(failure);

    removeEntry.mockRestore();
  });

  it('produces the same released logical layout over independent filesystem sessions', async () => {
    const firstSession = createNativeOpfsFileSystemSession({
      root: new MockFileSystemDirectoryHandle({ name: 'first-root' }),
    });
    const secondSession = createNativeOpfsFileSystemSession({
      root: new MockFileSystemDirectoryHandle({ name: 'second-root' }),
    });

    const nativeTree = await exerciseBackend({ session: firstSession });
    const secondTree = await exerciseBackend({ session: secondSession });

    expect(secondTree).toEqual(nativeTree);
    expect(nativeTree).toMatchObject({
      'naidan-storage': { kind: 'directory' },
      'naidan-storage/settings.json': { kind: 'file' },
      'naidan-storage/binary-objects/a1': { kind: 'directory' },
      'naidan-debug-wesh/global/home/note.txt': {
        kind: 'file',
        bytes: [...new TextEncoder().encode('debug')],
      },
    });
  });
});
