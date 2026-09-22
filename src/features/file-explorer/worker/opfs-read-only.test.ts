// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPFSStorageProvider, OpfsBlobReadError } from '@/00-storage/service/opfs-storage';
import { toBinaryObjectId, toChatGroupId, toChatId, toVolumeId } from '@/01-models/ids';
import { MockFile, MockFileSystemDirectoryHandle, MockFileSystemFileHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { createWorkerBlobContext } from '@/utils/worker-blob-context';
import { workerTransfer } from '@/utils/worker-transport';
import * as io from '@/utils/blob-view-io';

const nativeRead = io.readNativeBlobRange;
const cleanup: Array<() => void> = [];
const chatId = toChatId({ raw: 'chat-1' });
const groupId = toChatGroupId({ raw: 'group-1' });
const binaryObjectId = toBinaryObjectId({ raw: 'blob-a1' });
const volumeId = toVolumeId({ raw: 'volume-a1' });
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function put({ root, path, data }: {
  root: MockFileSystemDirectoryHandle,
  path: string,
  data: string | Uint8Array<ArrayBuffer>,
}) {
  const parts = path.split('/'); const name = parts.pop()!;
  let parent = root;
  for (const part of parts) parent = await parent.getDirectoryHandle(part, { create: true });
  const file = await parent.getFileHandle(name, { create: true });
  const writable = await file.createWritable();
  await writable.write(data); await writable.close();
  return file;
}
async function tree({ root }: { root: MockFileSystemDirectoryHandle }): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for await (const [name, entry] of root.entries()) {
    switch (entry.kind) {
    case 'directory': {
      result[`${name}/`] = '';
      for (const [path, data] of Object.entries(await tree({ root: entry as MockFileSystemDirectoryHandle }))) result[`${name}/${path}`] = data;
      break;
    }
    case 'file': result[name] = Buffer.from((entry as MockFileSystemFileHandle).content).toString('hex'); break;
    default: {
      const _ex: never = entry;
      throw new Error(`Unhandled entry: ${String(_ex)}`);
    }
    }
  }
  return result;
}

/** Reject attempted mutations too, including create:true calls that would be no-ops. */
function forbidMutations() {
  const mutations = vi.fn(() => {
    throw new Error('Read-only operation requested mutation authority');
  });
  const directoryPrototype = MockFileSystemDirectoryHandle.prototype;
  const getDirectory = directoryPrototype.getDirectoryHandle;
  const getFile = directoryPrototype.getFileHandle;
  const directoryLookup = vi.spyOn(directoryPrototype, 'getDirectoryHandle').mockImplementation(function (this: MockFileSystemDirectoryHandle, name, options) {
    if (options?.create) return mutations();
    return getDirectory.call(this, name, options);
  });
  const fileLookup = vi.spyOn(directoryPrototype, 'getFileHandle').mockImplementation(function (this: MockFileSystemDirectoryHandle, name, options) {
    if (options?.create) return mutations();
    return getFile.call(this, name, options);
  });
  vi.spyOn(directoryPrototype, 'removeEntry').mockImplementation(mutations);
  vi.spyOn(MockFileSystemFileHandle.prototype, 'createWritable').mockImplementation(mutations);
  vi.stubGlobal('indexedDB', { open: mutations });
  return { mutations, directoryLookup, fileLookup };
}
async function fixture({ seeded, host }: { seeded: boolean, host: boolean }) {
  const root = new MockFileSystemDirectoryHandle({ name: 'root' });
  vi.stubGlobal('navigator', { storage: { getDirectory: vi.fn(async () => root) } });
  const files: Record<string, MockFileSystemFileHandle> = {};
  if (seeded) {
    const contents: Record<string, string | Uint8Array<ArrayBuffer>> = {
      'chat-metas/chat-1.json': JSON.stringify({ id: 'chat-1', title: '日本語', createdAt: 1, updatedAt: 2, debugEnabled: false }),
      'chat-contents/chat-1.json': JSON.stringify({ root: { items: [{ id: 'u1', role: 'user', parts: [{ id: 'p1', type: 'text', text: '内容😀' }], replies: { items: [] }, createdAt: 1 }] } }),
      'chat-groups/group-1.json': JSON.stringify({ id: 'group-1', name: 'Group', isCollapsed: false, updatedAt: 2 }),
      'hierarchy.json': JSON.stringify({ items: [{ type: 'chat', id: 'chat-1' }, { type: 'chat_group', id: 'group-1', chat_ids: [] }] }),
      'settings.json': JSON.stringify({ storageType: 'opfs', endpoint: { type: 'openai', url: '' }, titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: { reasoning: {} } }, providerProfiles: [] }),
      'binary-objects/a1/index.json': JSON.stringify({ objects: { 'blob-a1': { id: 'blob-a1', name: 'bytes.bin', mimeType: 'application/octet-stream', size: 4, createdAt: 1 } } }),
      'binary-objects/a1/blob-a1.bin': new Uint8Array([0, 255, 128, 1]),
      'binary-objects/a1/.blob-a1.bin.complete': '',
      'volumes/a1/index.json': JSON.stringify({ volumes: { 'volume-a1': { id: 'volume-a1', name: 'Volume', type: 'opfs', createdAt: 1 } } }),
      'volumes/a1/volume-a1/data.txt': 'untouched',
      // Even malformed migration state is not relevant to a read-only observer.
      'migration-state.json': '{unreadable migration state',
      'uploaded-files/legacy/input.bin': new Uint8Array([255, 0, 2]),
    };
    for (const [path, data] of Object.entries(contents)) files[path] = await put({ root, path: `naidan-storage/${path}`, data });
  }
  const read = vi.fn(async ({ blob, offset, length }: { blob: Blob, offset: number, length: number }) => {
    const bytes = await nativeRead({ blob, offset, length });
    return workerTransfer({ value: bytes, transferables: [bytes.buffer] });
  });
  const blobs = host ? createWorkerBlobContext({ host: { read } }) : undefined;
  if (blobs !== undefined) {
    cleanup.push(() => blobs.dispose());
    vi.spyOn(io, 'readNativeBlobRange').mockRejectedValue(new DOMException('Opaque Worker', 'NotReadableError'));
    vi.spyOn(MockFile.prototype, 'text').mockRejectedValue(new Error('Must use BlobView'));
    vi.spyOn(MockFile.prototype, 'stream').mockImplementation(() => {
      throw new Error('Must use BlobView');
    });
  }
  const provider = new OPFSStorageProvider({ blobs, access: 'read-only' });
  return { root, files, read, blobs, provider };
}
async function collect<T>({ values }: { values: AsyncIterable<T> }): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}
async function assertEmpty({ provider }: { provider: OPFSStorageProvider }) {
  expect(await provider.loadChatMeta({ id: chatId })).toBeNull();
  expect(await provider.loadChatContent({ id: chatId })).toBeNull();
  expect(await provider.loadChatContentWithoutAttachments({ id: chatId })).toBeNull();
  expect(await provider.loadChat({ id: chatId })).toBeNull();
  expect(await provider.loadChatGroup({ id: groupId })).toBeNull();
  expect(await provider.listChats()).toEqual([]);
  expect(await provider.listChatGroups()).toEqual([]);
  expect(await provider.getSidebarStructure()).toEqual([]);
  expect(await provider.loadHierarchy()).toEqual({ items: [] });
  expect(await provider.loadSettings()).toBeNull();
  expect(await provider.getFile({ binaryObjectId })).toBeNull();
  expect(await provider.getBinaryObject({ binaryObjectId })).toBeNull();
  expect(await collect({ values: provider.listBinaryObjects() })).toEqual([]);
  expect(await provider.hasAttachments()).toBe(false);
  expect(await collect({ values: provider.listVolumes() })).toEqual([]);
  expect(await provider.hasVolumeMountReference({ volumeId })).toBe(false);
  const snapshot = await provider.dump();
  expect(snapshot.structure.chatMetas).toEqual([]);
  expect(await collect({ values: snapshot.contentStream })).toEqual([]);
}

describe('OPFS read-only owner policy', () => {
  it.each([false, true])('does not initialize an absent or empty store (existing root: %s)', async existing => {
    const { root, provider, read } = await fixture({ seeded: false, host: true });
    if (existing) await root.getDirectoryHandle('naidan-storage', { create: true });
    const before = await tree({ root }); const guard = forbidMutations();
    await provider.init(); await provider.init(); await assertEmpty({ provider });
    expect(await tree({ root })).toEqual(before);
    expect(guard.mutations).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(provider.canPersistBinary).toBe(false);
  });

  it.each([false, true])('reads all available data without changing legacy files or migration state (host: %s)', async host => {
    const { root, provider, read } = await fixture({ seeded: true, host });
    const before = await tree({ root }); const guard = forbidMutations();
    await provider.init();
    expect(read).not.toHaveBeenCalled();
    expect(await provider.loadChatMeta({ id: chatId })).toMatchObject({ title: '日本語' });
    expect(await provider.loadChatContent({ id: chatId })).toMatchObject({ root: { items: [{ parts: [{ type: 'text', text: '内容😀' }] }] } });
    expect(await provider.loadChatContentWithoutAttachments({ id: chatId })).toMatchObject({ root: { items: [{ role: 'user' }] } });
    expect(await provider.loadChat({ id: chatId })).toMatchObject({ title: '日本語' });
    expect(await provider.listChats()).toHaveLength(1);
    expect(await provider.listChatGroups()).toHaveLength(1);
    expect(await provider.getSidebarStructure()).toHaveLength(2);
    expect(await provider.loadChatGroup({ id: groupId })).toMatchObject({ name: 'Group' });
    expect(await provider.loadSettings()).not.toBeNull();
    expect(await provider.getBinaryObject({ binaryObjectId })).toMatchObject({ size: 4 });
    expect((await provider.getFile({ binaryObjectId }))?.size).toBe(4);
    expect(await collect({ values: provider.listBinaryObjects() })).toHaveLength(1);
    expect(await collect({ values: provider.listVolumes() })).toMatchObject([{ name: 'Volume' }]);
    expect(await provider.hasAttachments()).toBe(true);
    const snapshot = await provider.dump();
    expect((await collect({ values: snapshot.contentStream })).map(chunk => chunk.type)).toEqual(['chat', 'binary_object']);
    expect(guard.mutations).not.toHaveBeenCalled();
    expect(guard.fileLookup.mock.calls.some(([name]) => name === 'migration-state.json')).toBe(false);
    expect(await tree({ root })).toEqual(before);
    if (host) expect(read).toHaveBeenCalled();
  });

  it('does not cache absence or retain a removed storage root', async () => {
    const { root, provider } = await fixture({ seeded: false, host: false });
    await provider.init(); expect(await provider.loadChatMeta({ id: chatId })).toBeNull();
    const data = JSON.stringify({ id: 'chat-1', title: 'Created later', createdAt: 1, updatedAt: 1, debugEnabled: false });
    await put({ root, path: 'naidan-storage/chat-metas/chat-1.json', data });
    expect(await provider.loadChatMeta({ id: chatId })).toMatchObject({ title: 'Created later' });
    await root.removeEntry('naidan-storage', { recursive: true });
    expect(await provider.loadChatMeta({ id: chatId })).toBeNull();
    await put({ root, path: 'naidan-storage/chat-metas/chat-1.json', data: data.replace('Created later', 'Replacement root') });
    const guard = forbidMutations();
    expect(await provider.loadChatMeta({ id: chatId })).toMatchObject({ title: 'Replacement root' });
    expect(guard.mutations).not.toHaveBeenCalled();
  });

  it('does not create absent categories or binary shards while hydrating attachments', async () => {
    const { root, provider } = await fixture({ seeded: false, host: false });
    await put({ root, path: 'naidan-storage/chat-contents/chat-1.json', data: JSON.stringify({ root: { items: [{
      id: 'u', role: 'user', createdAt: 1, replies: { items: [] }, parts: [{ id: 'a1', type: 'attachment', attachment: {
        status: 'persisted', id: 'attachment-1', binaryObjectId: 'missing-zz', name: 'missing.bin', mimeType: 'application/octet-stream', size: 1, uploadedAt: 1,
      } }],
    }] } }) });
    const before = await tree({ root }); const guard = forbidMutations();
    await provider.init();
    expect(await provider.loadChatContent({ id: chatId })).toMatchObject({ root: { items: [{ parts: [{ attachment: { status: 'missing' } }] }] } });
    expect(await provider.getFile({ binaryObjectId })).toBeNull();
    expect(await provider.listChats()).toEqual([]);
    expect(guard.mutations).not.toHaveBeenCalled();
    expect(await tree({ root })).toEqual(before);
  });
});

const readOperations = {
  hierarchy: { path: 'hierarchy.json', run: ({ provider }: { provider: OPFSStorageProvider }) => provider.loadHierarchy() },
  metadata: { path: 'chat-metas/chat-1.json', run: ({ provider }: { provider: OPFSStorageProvider }) => provider.loadChatMeta({ id: chatId }) },
  content: { path: 'chat-contents/chat-1.json', run: ({ provider }: { provider: OPFSStorageProvider }) => provider.loadChatContent({ id: chatId }) },
  groups: { path: 'chat-groups/group-1.json', run: ({ provider }: { provider: OPFSStorageProvider }) => provider.listChatGroups() },
  group: { path: 'chat-groups/group-1.json', run: ({ provider }: { provider: OPFSStorageProvider }) => provider.loadChatGroup({ id: groupId }) },
  settings: { path: 'settings.json', run: ({ provider }: { provider: OPFSStorageProvider }) => provider.loadSettings() },
  binary: { path: 'binary-objects/a1/index.json', run: ({ provider }: { provider: OPFSStorageProvider }) => provider.getBinaryObject({ binaryObjectId }) },
  binaries: { path: 'binary-objects/a1/index.json', run: ({ provider }: { provider: OPFSStorageProvider }) => collect({ values: provider.listBinaryObjects() }) },
  file: { path: 'binary-objects/a1/index.json', run: ({ provider }: { provider: OPFSStorageProvider }) => provider.getFile({ binaryObjectId }) },
  volumes: { path: 'volumes/a1/index.json', run: ({ provider }: { provider: OPFSStorageProvider }) => collect({ values: provider.listVolumes() }) },
};

describe('read-only missing entries are not failed reads', () => {
  it.each(Object.entries(readOperations))('does not hide malformed %s as empty data', async (_name, operation) => {
    const { root, provider } = await fixture({ seeded: true, host: true });
    await put({ root, path: `naidan-storage/${operation.path}`, data: '{invalid JSON' });
    const before = await tree({ root }); const guard = forbidMutations();
    await expect(operation.run({ provider })).rejects.toBeInstanceOf(SyntaxError);
    expect(guard.mutations).not.toHaveBeenCalled();
    expect(await tree({ root })).toEqual(before);
  });

  it.each(Object.entries(readOperations))('does not hide snapshot NotFoundError for %s as absence', async (_name, operation) => {
    const { provider, files } = await fixture({ seeded: true, host: true });
    const failure = new DOMException('Snapshot disappeared', 'NotFoundError');
    vi.spyOn(files[operation.path]!, 'getFile').mockRejectedValue(failure);
    const guard = forbidMutations();
    await expect(operation.run({ provider })).rejects.toMatchObject({ name: 'OpfsBlobReadError', cause: failure });
    expect(guard.mutations).not.toHaveBeenCalled();
  });

  it.each(['NotAllowedError', 'SecurityError', 'TypeMismatchError'])('does not treat directory %s as an absent store', async name => {
    const { root, provider } = await fixture({ seeded: false, host: true });
    const failure = new DOMException('Cannot access storage', name);
    vi.spyOn(root, 'getDirectoryHandle').mockRejectedValue(failure);
    const guard = forbidMutations();
    await expect(provider.init()).rejects.toBe(failure);
    await expect(provider.listChats()).rejects.toBe(failure);
    await expect(provider.loadChatContent({ id: chatId })).rejects.toBe(failure);
    await expect(provider.getFile({ binaryObjectId })).rejects.toBe(failure);
    expect(guard.mutations).not.toHaveBeenCalled();
  });

  it('does not treat an unavailable OPFS root as a missing storage directory', async () => {
    const { provider } = await fixture({ seeded: false, host: false });
    const failure = new DOMException('OPFS unavailable', 'NotFoundError');
    vi.mocked(navigator.storage.getDirectory).mockRejectedValue(failure);
    await expect(provider.init()).rejects.toBe(failure);
    await expect(provider.listChats()).rejects.toBe(failure);
  });

  it.each(['chat-metas', 'binary-objects', 'volumes'])('propagates failed enumeration of %s even when it reports NotFoundError', async name => {
    const { root, provider } = await fixture({ seeded: true, host: true });
    const directory = await (await root.getDirectoryHandle('naidan-storage')).getDirectoryHandle(name);
    const failure = new DOMException('Enumeration failed', 'NotFoundError');
    vi.spyOn(directory, 'values').mockImplementation(async function* () {
      yield await Promise.reject(failure);
      return undefined;
    });
    const guard = forbidMutations();
    const operation = name === 'chat-metas' ? provider.listChats() : name === 'binary-objects'
      ? collect({ values: provider.listBinaryObjects() }) : collect({ values: provider.listVolumes() });
    await expect(operation).rejects.toBe(failure);
    expect(guard.mutations).not.toHaveBeenCalled();
  });

  it('does not manufacture a missing completion marker or index', async () => {
    const { root, provider } = await fixture({ seeded: false, host: true });
    await put({ root, path: 'naidan-storage/binary-objects/a1/blob-a1.bin', data: new Uint8Array([1]) });
    const before = await tree({ root }); const guard = forbidMutations();
    expect(await provider.getFile({ binaryObjectId })).toBeNull();
    expect(await provider.getBinaryObject({ binaryObjectId })).toBeNull();
    expect(await collect({ values: provider.listBinaryObjects() })).toEqual([]);
    expect(await tree({ root })).toEqual(before);
    expect(guard.mutations).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'hierarchy', run: ({ provider }: { provider: OPFSStorageProvider }) => provider.loadHierarchy() },
    { name: 'settings', run: ({ provider }: { provider: OPFSStorageProvider }) => provider.loadSettings() },
    { name: 'binaries', run: ({ provider }: { provider: OPFSStorageProvider }) => collect({ values: provider.listBinaryObjects() }) },
    { name: 'volumes', run: ({ provider }: { provider: OPFSStorageProvider }) => collect({ values: provider.listVolumes() }) },
  ])('keeps root access failures outside default writable $name recovery', async ({ run }) => {
    await fixture({ seeded: false, host: false });
    const error = new DOMException('Root unavailable', 'NotAllowedError');
    vi.mocked(navigator.storage.getDirectory).mockRejectedValue(error);
    await expect(run({ provider: new OPFSStorageProvider() })).rejects.toBe(error);
  });

  it.each(['read-only', 'read-write'] as const)('uses code-only missing-index recovery only for the legacy writer path (%s)', async access => {
    const { root } = await fixture({ seeded: true, host: false });
    const shard = await (await (await root.getDirectoryHandle('naidan-storage')).getDirectoryHandle('binary-objects')).getDirectoryHandle('a1');
    const error = Object.assign(new Error('Legacy code-only error'), { code: 8 });
    vi.spyOn(shard, 'getFileHandle').mockRejectedValue(error);
    const provider = new OPFSStorageProvider({ access });
    switch (access) {
    case 'read-only':
      await expect(provider.getBinaryObject({ binaryObjectId })).rejects.toBe(error);
      break;
    case 'read-write':
      expect(await provider.getBinaryObject({ binaryObjectId })).toBeNull();
      break;
    default: {
      const _ex: never = access; throw new Error(`Unhandled access: ${_ex}`);
    }
    }
  });

  it.each(['NotAllowedError', 'SecurityError', 'TypeMismatchError'])('does not treat file lookup %s as missing', async name => {
    const { root, provider } = await fixture({ seeded: true, host: true });
    const directory = await (await root.getDirectoryHandle('naidan-storage')).getDirectoryHandle('chat-groups');
    const error = new DOMException('Cannot look up record', name);
    vi.spyOn(directory, 'getFileHandle').mockRejectedValue(error);
    const guard = forbidMutations();
    await expect(provider.loadChatGroup({ id: groupId })).rejects.toBe(error);
    expect(guard.mutations).not.toHaveBeenCalled();
  });

  it('classifies failed native byte access even when a read-only owner has no BlobContext', async () => {
    const { provider } = await fixture({ seeded: true, host: false });
    const error = new DOMException('Native read failed', 'NotReadableError');
    vi.spyOn(MockFile.prototype, 'text').mockRejectedValue(error);
    const guard = forbidMutations();
    await expect(provider.loadHierarchy()).rejects.toMatchObject({ name: 'OpfsBlobReadError', cause: error });
    await expect(provider.getBinaryObject({ binaryObjectId })).rejects.toMatchObject({ name: 'OpfsBlobReadError', cause: error });
    expect(guard.mutations).not.toHaveBeenCalled();
  });

  it('preserves the native optional-record behavior for default writable providers', async () => {
    const { root } = await fixture({ seeded: false, host: false });
    await put({ root, path: 'naidan-storage/hierarchy.json', data: '{bad' });
    const provider = new OPFSStorageProvider();
    expect(await provider.loadHierarchy()).toEqual({ items: [] });
    expect(provider.canPersistBinary).toBe(true);
    await provider.init();
    expect(await tree({ root })).toHaveProperty('naidan-storage/migration-state.json');
  });
});

// Every public mutation (and the raw writable-handle exit) must reject before I/O.
const deniedOperations = {
  saveHierarchy: async ({ provider, seed }: { provider: OPFSStorageProvider, seed: OPFSStorageProvider }) => provider.saveHierarchy({ hierarchy: (await seed.loadHierarchy())! }),
  saveChatMeta: async ({ provider, seed }: { provider: OPFSStorageProvider, seed: OPFSStorageProvider }) => provider.saveChatMeta({ meta: (await seed.loadChatMeta({ id: chatId }))! }),
  saveChatContent: async ({ provider, seed }: { provider: OPFSStorageProvider, seed: OPFSStorageProvider }) => provider.saveChatContent({ id: chatId, content: (await seed.loadChatContent({ id: chatId }))! }),
  deleteChat: ({ provider }: { provider: OPFSStorageProvider }) => provider.deleteChat({ id: chatId }),
  saveChatGroup: async ({ provider, seed }: { provider: OPFSStorageProvider, seed: OPFSStorageProvider }) => provider.saveChatGroup({ chatGroup: (await seed.loadChatGroup({ id: groupId }))! }),
  deleteChatGroup: ({ provider }: { provider: OPFSStorageProvider }) => provider.deleteChatGroup({ id: groupId }),
  saveFile: ({ provider }: { provider: OPFSStorageProvider }) => provider.saveFile({ binaryObjectId, name: 'data', blob: new Blob(['x']) }),
  deleteBinaryObject: ({ provider }: { provider: OPFSStorageProvider }) => provider.deleteBinaryObject({ binaryObjectId }),
  saveSettings: async ({ provider, seed }: { provider: OPFSStorageProvider, seed: OPFSStorageProvider }) => provider.saveSettings({ settings: (await seed.loadSettings())! }),
  clearAll: ({ provider }: { provider: OPFSStorageProvider }) => provider.clearAll(),
  restore: async ({ provider, seed }: { provider: OPFSStorageProvider, seed: OPFSStorageProvider }) => provider.restore({ snapshot: await seed.dump() }),
  createOpfsVolume: ({ provider, root }: { provider: OPFSStorageProvider, root: MockFileSystemDirectoryHandle }) => provider.createVolume({ name: 'Volume', type: 'opfs', sourceHandle: root as unknown as FileSystemDirectoryHandle }),
  createHostVolume: ({ provider, root }: { provider: OPFSStorageProvider, root: MockFileSystemDirectoryHandle }) => provider.createVolume({ name: 'Volume', type: 'host', sourceHandle: root as unknown as FileSystemDirectoryHandle }),
  createVolumeFromFiles: ({ provider }: { provider: OPFSStorageProvider }) => provider.createVolumeFromFiles({ name: 'Volume', entries: [] }),
  renameVolume: ({ provider }: { provider: OPFSStorageProvider }) => provider.renameVolume({ volumeId, name: 'New' }),
  deleteVolume: ({ provider }: { provider: OPFSStorageProvider }) => provider.deleteVolume({ volumeId }),
  getVolumeDirectoryHandle: ({ provider }: { provider: OPFSStorageProvider }) => provider.getVolumeDirectoryHandle({ volumeId }),
};

describe('explicit read-only storage has no mutation or native-handle exit', () => {
  it.each(Object.entries(deniedOperations))('rejects %s even for an existing target', async (_name, operation) => {
    const { root, provider } = await fixture({ seeded: true, host: true });
    // Both sides read through the restricted owner, so preparing valid arguments
    // cannot create directories or silently repair data either.
    const seed = provider;
    const before = await tree({ root }); const guard = forbidMutations();
    await expect(operation({ provider, seed, root })).rejects.toMatchObject({ name: 'NoModificationAllowedError' });
    expect(guard.mutations).not.toHaveBeenCalled();
    expect(await tree({ root })).toEqual(before);
  });

  it('does not enumerate restore content or import sources before rejecting', async () => {
    const { provider, root } = await fixture({ seeded: false, host: false });
    const snapshot = await provider.dump();
    const consumed = vi.fn();
    snapshot.contentStream = (async function* () {
      consumed(); yield await Promise.reject(new Error('Must not consume restore input'));
    })();
    const entries = vi.spyOn(root, 'values'); const progress = vi.fn();
    const guard = forbidMutations();
    await expect(provider.restore({ snapshot })).rejects.toMatchObject({ name: 'NoModificationAllowedError' });
    await expect(provider.createVolumeFromFiles({ name: 'New', entries: [{ file: new File(['x'], 'x'), relativePath: 'x' }], onProgress: progress })).rejects.toMatchObject({ name: 'NoModificationAllowedError' });
    expect(consumed).not.toHaveBeenCalled(); expect(entries).not.toHaveBeenCalled(); expect(progress).not.toHaveBeenCalled();
    expect(guard.mutations).not.toHaveBeenCalled();
  });

  it('does not dispose the borrowed context after reads or rejected writes', async () => {
    const { provider, blobs } = await fixture({ seeded: true, host: true });
    await provider.init();
    expect(await provider.loadChatMeta({ id: chatId })).not.toBeNull();
    await expect(provider.clearAll()).rejects.toMatchObject({ name: 'NoModificationAllowedError' });
    expect(await blobs!.fromNative({ blob: new Blob(['still alive']) }).text()).toBe('still alive');
    blobs!.dispose();
    await expect(provider.loadChatMeta({ id: chatId })).rejects.toBeInstanceOf(OpfsBlobReadError);
  });
});
