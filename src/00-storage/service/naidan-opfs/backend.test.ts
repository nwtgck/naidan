import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toBinaryObjectId, toChatGroupId, toChatId } from '@/01-models/ids';
import type { Settings } from '@/01-models/types';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { createNativeOpfsFileSystemSession } from '@/00-storage/service/storage-file-system/native-opfs';
import type {
  StorageDirectoryHandle,
  StorageEntryHandle,
  StorageFileHandle,
  StorageFileSystemSession,
} from '@/00-storage/service/storage-file-system/types';
import { HostVolumeDB } from '@/00-storage/service/opfs/host-volume-db';
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

describe('Naidan OPFS layout backend', () => {
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
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const snapshot = await backend.dump();
    const chunks = await collectAsyncIterable({ values: snapshot.contentStream });

    expect(chunks.filter((chunk) => chunk.type === 'binary_object')).toEqual([]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      '[NaidanOpfsStorageBackend] Failed to dump some binary objects',
      closeFailure,
    );
  });

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
