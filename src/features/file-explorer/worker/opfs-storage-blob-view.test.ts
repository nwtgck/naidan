// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockFile, MockFileSystemDirectoryHandle, MockFileSystemFileHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { toBinaryObjectId, toChatId, toChatGroupId, toVolumeId } from '@/01-models/ids';
import { createWorkerBlobContext } from '@/utils/worker-blob-context';
import * as io from '@/utils/blob-view-io';
import { workerTransfer } from '@/utils/worker-transport';
import { OPFSStorageProvider, OpfsBlobReadError } from '@/00-storage/service/opfs-storage';

const nativeRead = io.readNativeBlobRange;
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function write({ root, path, data }: { root: MockFileSystemDirectoryHandle, path: string, data: string | Uint8Array<ArrayBuffer> }) {
  const parts = path.split('/');
  const name = parts.pop()!;
  let directory = root;
  for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: true });
  const file = await directory.getFileHandle(name, { create: true });
  const writer = await file.createWritable();
  await writer.write(data); await writer.close();
  return file;
}
async function fixture() {
  const root = new MockFileSystemDirectoryHandle({ name: 'root' });
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
  const seed = new OPFSStorageProvider();
  await seed.init();
  const storage = await root.getDirectoryHandle('naidan-storage');
  const files = {
    metadata: await write({ root: storage, path: 'chat-metas/chat-1.json', data: JSON.stringify({ id: 'chat-1', title: '日本語', createdAt: 1, updatedAt: 2, debugEnabled: false }) }),
    content: await write({ root: storage, path: 'chat-contents/chat-1.json', data: JSON.stringify({ root: { items: [] } }) }),
    group: await write({ root: storage, path: 'chat-groups/group-1.json', data: JSON.stringify({ id: 'group-1', name: 'Group', isCollapsed: false, updatedAt: 2 }) }),
    hierarchy: await write({ root: storage, path: 'hierarchy.json', data: JSON.stringify({ items: [{ type: 'chat', id: 'chat-1' }, { type: 'chat_group', id: 'group-1', chat_ids: [] }] }) }),
    settings: await write({ root: storage, path: 'settings.json', data: JSON.stringify({}) }),
    index: await write({ root: storage, path: 'binary-objects/a1/index.json', data: JSON.stringify({ objects: { 'blob-a1': { id: 'blob-a1', name: 'data.bin', mimeType: 'application/octet-stream', size: 4, createdAt: 1 } } }) }),
    binary: await write({ root: storage, path: 'binary-objects/a1/blob-a1.bin', data: new Uint8Array([0, 255, 128, 1]) }),
    marker: await write({ root: storage, path: 'binary-objects/a1/.blob-a1.bin.complete', data: '' }),
    volume: await write({ root: storage, path: 'volumes/a1/index.json', data: JSON.stringify({ volumes: {} }) }),
    migration: await storage.getFileHandle('migration-state.json'),
  };
  vi.spyOn(io, 'readNativeBlobRange').mockRejectedValue(new DOMException('Opaque Worker', 'NotReadableError'));
  vi.spyOn(MockFile.prototype, 'text').mockRejectedValue(new Error('Must use BlobView.text'));
  vi.spyOn(MockFile.prototype, 'stream').mockImplementation(() => {
    throw new Error('Must use BlobView.stream');
  });
  const read = vi.fn(async ({ blob, offset, length }: { blob: Blob, offset: number, length: number }) => {
    const bytes = await nativeRead({ blob, offset, length });
    return workerTransfer({ value: bytes, transferables: [bytes.buffer] });
  });
  const blobs = createWorkerBlobContext({ host: { read } });
  cleanup.push(() => blobs.dispose());
  const provider = new OPFSStorageProvider({ blobs });
  return { root, storage, files, blobs, read, provider };
}
async function list<T>({ source }: { source: AsyncIterable<T> }) {
  const values: T[] = [];
  for await (const item of source) values.push(item);
  return values;
}

const operations = {
  metadata: (p: OPFSStorageProvider) => p.loadChatMeta({ id: toChatId({ raw: 'chat-1' }) }),
  content: (p: OPFSStorageProvider) => p.loadChatContent({ id: toChatId({ raw: 'chat-1' }) }),
  chat: (p: OPFSStorageProvider) => p.loadChat({ id: toChatId({ raw: 'chat-1' }) }),
  chats: (p: OPFSStorageProvider) => p.listChats(),
  group: (p: OPFSStorageProvider) => p.loadChatGroup({ id: toChatGroupId({ raw: 'group-1' }) }),
  groups: (p: OPFSStorageProvider) => p.listChatGroups(),
  hierarchy: (p: OPFSStorageProvider) => p.loadHierarchy(),
  sidebar: (p: OPFSStorageProvider) => p.getSidebarStructure(),
  settings: (p: OPFSStorageProvider) => p.loadSettings(),
  binary: (p: OPFSStorageProvider) => p.getBinaryObject({ binaryObjectId: toBinaryObjectId({ raw: 'blob-a1' }) }),
  file: (p: OPFSStorageProvider) => p.getFile({ binaryObjectId: toBinaryObjectId({ raw: 'blob-a1' }) }),
  binaries: (p: OPFSStorageProvider) => list({ source: p.listBinaryObjects() }),
  volumes: (p: OPFSStorageProvider) => list({ source: p.listVolumes() }),
  volume: (p: OPFSStorageProvider) => p.getVolumeDirectoryHandle({ volumeId: toVolumeId({ raw: 'volume-a1' }) }),
};

describe('OPFS storage with a borrowed BlobContext', () => {
  it('reads persisted metadata, hierarchy, content and sharded indices through the host', async () => {
    const { provider, read, blobs } = await fixture();
    await provider.init();
    expect(await operations.metadata(provider)).toMatchObject({ title: '日本語' });
    expect(await operations.content(provider)).toMatchObject({ root: { items: [] } });
    expect(await operations.chat(provider)).toMatchObject({ title: '日本語' });
    expect(await operations.chats(provider)).toHaveLength(1);
    expect(await operations.groups(provider)).toHaveLength(1);
    expect(await operations.group(provider)).toMatchObject({ name: 'Group' });
    expect(await operations.binary(provider)).toMatchObject({ size: 4 });
    expect(await operations.binaries(provider)).toHaveLength(1);
    expect(await operations.file(provider)).not.toBeNull();
    expect(read).toHaveBeenCalled();
    // Provider operations borrow, never dispose, the context.
    expect(await blobs.fromNative({ blob: new Blob(['still usable']) }).text()).toBe('still usable');
  });

  it.each(Object.keys(operations) as Array<keyof typeof operations>)('does not disguise a byte read failure as empty or missing: %s', async operation => {
    const { provider, read } = await fixture();
    await provider.init();
    const failure = new DOMException('Read failed', 'NotReadableError');
    read.mockRejectedValue(failure);
    await expect(operations[operation](provider)).rejects.toBeInstanceOf(OpfsBlobReadError);
  });

  it('does not start migrations or overwrite migration state when its bytes cannot be read', async () => {
    const { provider, files, storage, read } = await fixture();
    const before = await (await files.migration.getFile()).arrayBuffer();
    const writable = vi.spyOn(MockFileSystemFileHandle.prototype, 'createWritable');
    const remove = vi.spyOn(storage, 'removeEntry');
    read.mockRejectedValue(new Error('Host unavailable'));
    await expect(provider.init()).rejects.toBeInstanceOf(OpfsBlobReadError);
    expect(writable).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(await (await files.migration.getFile()).arrayBuffer()).toEqual(before);
  });

  it('distinguishes snapshot retrieval failure from a handle that was never found', async () => {
    const { provider, files } = await fixture();
    await provider.init();
    const failure = new DOMException('Snapshot lost', 'NotReadableError');
    vi.spyOn(files.metadata, 'getFile').mockRejectedValue(failure);
    await expect(operations.metadata(provider)).rejects.toMatchObject({ name: 'OpfsBlobReadError', cause: failure });
    expect(await provider.loadChatMeta({ id: toChatId({ raw: 'missing' }) })).toBeNull();
  });

  it('preserves the message-parts baseline distinction between corrupt chat records and optional hierarchy', async () => {
    const { provider, storage } = await fixture();
    await provider.init();
    await write({ root: storage, path: 'chat-metas/chat-1.json', data: '{not json' });
    await expect(operations.metadata(provider)).rejects.toBeInstanceOf(SyntaxError);
    await write({ root: storage, path: 'hierarchy.json', data: '{bad' });
    expect(await operations.hierarchy(provider)).toEqual({ items: [] });
    expect(await provider.getBinaryObject({ binaryObjectId: toBinaryObjectId({ raw: 'missing-zz' }) })).toBeNull();
  });

  it('does not replace a failed existing binary index when saving another object', async () => {
    const { provider, files, read } = await fixture();
    await provider.init();
    const old = await (await files.index.getFile()).arrayBuffer();
    const original = read.getMockImplementation()!;
    read.mockImplementation(async request => {
      if ('name' in request.blob && request.blob.name === 'index.json') throw new Error('Index read failed');
      return original(request);
    });
    await expect(provider.saveFile({ blob: new Blob(['new']), binaryObjectId: toBinaryObjectId({ raw: 'new-a1' }), name: 'new' })).rejects.toBeInstanceOf(OpfsBlobReadError);
    expect(await (await files.index.getFile()).arrayBuffer()).toEqual(old);
    // A binary file/marker written before the index failure may remain; not a new transaction.
  });

  it('streams binary payloads and imported volume files without whole-Blob arrayBuffer reads', async () => {
    const { provider, read } = await fixture();
    await provider.init();
    const bytes = Uint8Array.from({ length: io.BLOB_VIEW_CHUNK_SIZE + 7 }, (_, index) => index % 251);
    const blob = new Blob([bytes]);
    vi.spyOn(blob, 'arrayBuffer').mockRejectedValue(new Error('Do not consume the whole Blob'));
    await provider.saveFile({ blob, binaryObjectId: toBinaryObjectId({ raw: 'large-a1' }), name: 'large' });
    const stored = await provider.getFile({ binaryObjectId: toBinaryObjectId({ raw: 'large-a1' }) });
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(bytes);
    const input = new File([bytes], 'file.bin');
    vi.spyOn(input, 'arrayBuffer').mockRejectedValue(new Error('Do not read the whole File'));
    const volume = await provider.createVolumeFromFiles({ name: 'volume', entries: [{ file: input, relativePath: 'nested/file.bin' }] });
    const directory = await provider.getVolumeDirectoryHandle({ volumeId: volume.id });
    const file = await (await directory!.getDirectoryHandle('nested')).getFileHandle('file.bin');
    expect(new Uint8Array(await (await file.getFile()).arrayBuffer())).toEqual(bytes);
    expect(read.mock.calls.every(([request]) => request.length <= io.BLOB_VIEW_CHUNK_SIZE)).toBe(true);
  });

  it('copies a nested OPFS volume through the borrowed context', async () => {
    const { provider, root, read } = await fixture();
    await provider.init();
    const source = await root.getDirectoryHandle('volume-source', { create: true });
    const bytes = new Uint8Array([255, 0, 128, 1]);
    await write({ root: source, path: 'nested/source.bin', data: bytes });
    const volume = await provider.createVolume({ name: 'copied', type: 'opfs', sourceHandle: source as unknown as FileSystemDirectoryHandle });
    const destination = await provider.getVolumeDirectoryHandle({ volumeId: volume.id });
    const file = await (await destination!.getDirectoryHandle('nested')).getFileHandle('source.bin');
    expect(new Uint8Array(await (await file.getFile()).arrayBuffer())).toEqual(bytes);
    expect(read.mock.calls.some(([request]) => 'name' in request.blob && request.blob.name === 'source.bin')).toBe(true);
  });

  it('aborts a failed binary write without creating a completion marker or publishing an index', async () => {
    const { provider, storage, read } = await fixture();
    await provider.init();
    const abort = vi.spyOn(MockFileSystemFileHandle.prototype, 'createWritable');
    read.mockRejectedValue(new Error('Host failed'));
    await expect(provider.saveFile({ blob: new Blob(['payload']), binaryObjectId: toBinaryObjectId({ raw: 'new-b2' }), name: 'new' })).rejects.toThrow('Host failed');
    const dir = await (await storage.getDirectoryHandle('binary-objects')).getDirectoryHandle('b2');
    expect(abort).toHaveBeenCalledOnce();
    await expect(dir.getFileHandle('.new-b2.bin.complete')).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(dir.getFileHandle('index.json')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('rejects reads after owner disposal instead of presenting existing chats as missing', async () => {
    const { provider, blobs } = await fixture();
    await provider.init(); blobs.dispose();
    await expect(operations.metadata(provider)).rejects.toMatchObject({ name: 'OpfsBlobReadError', cause: { name: 'AbortError' } });
  });
});

describe('migration read failures are not missing legacy directories', () => {
  it('completes an actual legacy-file migration with host-backed reads', async () => {
    const { storage, provider, read } = await fixture();
    await storage.removeEntry('migration-state.json');
    const bytes = new Uint8Array([255, 0, 128, 1]);
    await write({ root: storage, path: 'uploaded-files/attachment-1/original.bin', data: bytes });
    await provider.init();
    const objects = await list({ source: provider.listBinaryObjects() });
    const migrated = objects.find(object => object.name === 'original.bin');
    expect(migrated).toBeDefined();
    const file = await provider.getFile({ binaryObjectId: migrated!.id });
    expect(new Uint8Array(await file!.arrayBuffer())).toEqual(bytes);
    await expect(storage.getDirectoryHandle('uploaded-files')).rejects.toMatchObject({ name: 'NotFoundError' });
    const stateFile = await storage.getFileHandle('migration-state.json');
    const state = JSON.parse(new TextDecoder().decode(await (await stateFile.getFile()).arrayBuffer()));
    expect(state.completedMigrations.map((entry: { name: string }) => entry.name)).toEqual(['v1_uploaded_files_to_binary_objects']);
    expect(read.mock.calls.some(([request]) => 'name' in request.blob && request.blob.name === 'original.bin')).toBe(true);
  });

  it.each(['content', 'payload'] as const)('keeps legacy data and does not mark completion after a %s read failure', async failureAt => {
    const { storage, provider, read } = await fixture();
    await storage.removeEntry('migration-state.json');
    const legacy = await write({ root: storage, path: 'uploaded-files/attachment-1/original.bin', data: new Uint8Array([255, 0, 128]) });
    const original = read.getMockImplementation()!;
    read.mockImplementation(async request => {
      const name = 'name' in request.blob ? request.blob.name : '';
      if (name === (failureAt === 'content' ? 'chat-1.json' : 'original.bin')) {
        // NotFound during an already-started read must not mean "no migration needed".
        throw new DOMException('Read lost source', 'NotFoundError');
      }
      return original(request);
    });
    await expect(provider.init()).rejects.toThrow();
    expect((await legacy.getFile()).size).toBe(3);
    await expect(storage.getDirectoryHandle('uploaded-files')).resolves.toBeDefined();
    await expect(storage.getFileHandle('migration-state.json')).rejects.toMatchObject({ name: 'NotFoundError' });
  });
});
