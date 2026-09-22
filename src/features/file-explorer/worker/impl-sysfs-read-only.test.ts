// @vitest-environment node
import { MessageChannel } from 'node:worker_threads';
import * as Comlink from 'comlink';
import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPFSStorageProvider } from '@/00-storage/service/opfs-storage';
import { createLegacyUploadedFileId } from '@/00-storage/service/legacy-uploaded-file-id';
import { idToRaw, toChatId } from '@/01-models/ids';
import { MockFile, MockFileSystemDirectoryHandle, MockFileSystemFileHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { NAIDAN_SYSFS_ROOT_PATH } from '@/features/wesh/naidan-sysfs/constants';
import { createOpfsNaidanSysfsStorageReader } from '@/features/wesh/naidan-sysfs/storage-reader';
import { createWeshWorker } from '@/features/wesh/worker/impl';
import type { IWeshWorker, WeshWorkerInitRequest, WeshWorkerRemoteExecutionEvent } from '@/features/wesh/worker/types';
import { createWorkerBlobContext } from '@/utils/worker-blob-context';
import { exposeWorkerRemote, releaseWorkerRemote, workerCapability, workerProxy, workerTransfer, wrapWorkerRemote } from '@/utils/worker-transport';
import * as io from '@/utils/blob-view-io';
import { createFileExplorerWorker } from './impl';
import type { IFileExplorerWorker, FileExplorerRootDescriptor } from './types';

const nativeRead = io.readNativeBlobRange;
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  try {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
  } finally {
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  }
});
const mount: WeshWorkerInitRequest['mounts'][number] = {
  type: 'naidan_sysfs' as const, path: NAIDAN_SYSFS_ROOT_PATH, readOnly: true,
  storageType: 'opfs' as const, visibility: 'main_chats' as const, binaryObjectAccess: 'data' as const,
  currentChatId: 'chat-1', currentChatGroupId: undefined,
};
const explorerRoot: FileExplorerRootDescriptor = { kind: 'wesh-mounts', rootName: 'Sysfs', mounts: [mount] };
const metadataPath = `${NAIDAN_SYSFS_ROOT_PATH}/current-chat/metadata.json`;

function makeHost() {
  const release = vi.fn();
  const read = vi.fn(async ({ blob, offset, length }: { blob: Blob, offset: number, length: number }) => {
    if (release.mock.calls.length > 0) throw new Error('Host released before reading finished');
    const bytes = await nativeRead({ blob, offset, length });
    return workerTransfer({ value: bytes, transferables: [bytes.buffer] });
  });
  return { host: Object.assign({ read }, { [Comlink.releaseProxy]: release }), read, release };
}
async function fixture({ empty }: { empty: boolean }) {
  const root = new MockFileSystemDirectoryHandle({ name: 'root' });
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
  const files = new Map<string, MockFileSystemFileHandle>();
  if (!empty) {
    const content = JSON.stringify({ root: { items: [{
      id: 'legacy-message', role: 'user', timestamp: 0, content: '  original <think>literal</think>  ',
      attachments: [{ id: 'legacy-dir', originalName: 'a.bin', mimeType: 'application/custom', uploadedAt: 0, size: 4, status: 'persisted' }],
      replies: { items: [] }, unknownField: { keep: true },
    }] }, unknownDocument: [1, 2] });
    const documents: Record<string, string | Uint8Array<ArrayBuffer>> = {
      'chat-metas/chat-1.json': JSON.stringify({ id: 'chat-1', title: '日本語 😀', createdAt: 1, updatedAt: 2, debugEnabled: false }),
      'chat-contents/chat-1.json': content,
      'hierarchy.json': JSON.stringify({ items: [{ type: 'chat', id: 'chat-1' }] }),
      'uploaded-files/legacy-dir/a.bin': new Uint8Array([0, 255, 128, 1]),
      // Deliberately no migration-state, categories, or binary shard indices.
    };
    for (const [path, data] of Object.entries(documents)) {
      const parts = path.split('/'); const name = parts.pop()!;
      let parent = await root.getDirectoryHandle('naidan-storage', { create: true });
      for (const part of parts) parent = await parent.getDirectoryHandle(part, { create: true });
      const file = await parent.getFileHandle(name, { create: true });
      const writer = await file.createWritable(); await writer.write(data); await writer.close();
      files.set(path, file);
    }
  }
  vi.spyOn(io, 'readNativeBlobRange').mockRejectedValue(new DOMException('Opaque Worker', 'NotReadableError'));
  vi.spyOn(MockFile.prototype, 'text').mockRejectedValue(new Error('Native byte read bypass'));
  vi.spyOn(MockFile.prototype, 'stream').mockImplementation(() => {
    throw new Error('Native byte stream bypass');
  });
  return { root, files };
}
function watchStorage() {
  const directories = vi.spyOn(MockFileSystemDirectoryHandle.prototype, 'getDirectoryHandle');
  const files = vi.spyOn(MockFileSystemDirectoryHandle.prototype, 'getFileHandle');
  const write = vi.spyOn(MockFileSystemFileHandle.prototype, 'createWritable');
  const remove = vi.spyOn(MockFileSystemDirectoryHandle.prototype, 'removeEntry');
  return {
    assertNoWrites() {
      expect(directories.mock.calls.filter(([, options]) => options?.create)).toEqual([]);
      expect(files.mock.calls.filter(([, options]) => options?.create)).toEqual([]);
      expect(files.mock.calls.filter(([name]) => name === 'migration-state.json')).toEqual([]);
      expect(write).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    },
    stop() {
      directories.mockRestore(); files.mockRestore(); write.mockRestore(); remove.mockRestore();
    },
  };
}
async function assertNoMigration({ root, files }: {
  root: MockFileSystemDirectoryHandle,
  files: Map<string, MockFileSystemFileHandle>,
}) {
  const storage = await root.getDirectoryHandle('naidan-storage');
  const names: string[] = [];
  for await (const name of storage.keys()) names.push(name);
  expect(names.sort()).toEqual(['chat-contents', 'chat-metas', 'hierarchy.json', 'uploaded-files']);
  expect(JSON.parse(new TextDecoder().decode(files.get('chat-contents/chat-1.json')!.content)).root.items[0].attachments[0]).not.toHaveProperty('binaryObjectId');
  expect(files.get('uploaded-files/legacy-dir/a.bin')!.content).toEqual(new Uint8Array([0, 255, 128, 1]));
}
async function initializeWesh({ worker, host }: { worker: ReturnType<typeof createWeshWorker>, host: ReturnType<typeof makeHost>['host'] }) {
  const request: WeshWorkerInitRequest = {
    rootHandle: 'readonly', mounts: [mount], initialEnv: {}, initialCwd: undefined, user: 'user',
  };
  await worker.init(request, undefined, host);
}
async function run({ worker, script }: { worker: Pick<IWeshWorker, 'startExecution' | 'awaitExecution' | 'disposeExecution'>, script: string }) {
  const stdout: Uint8Array[] = []; const stderr: Uint8Array[] = [];
  const { executionId } = await worker.startExecution({ script }, workerProxy({ value: async (event: WeshWorkerRemoteExecutionEvent) => {
    switch (event.type) {
    case 'stdout': stdout.push(new Uint8Array(event.buffer)); break;
    case 'stderr': stderr.push(new Uint8Array(event.buffer)); break;
    case 'started':
    case 'exit':
    case 'error':
      break;
    default: {
      const _ex: never = event;
      throw new Error(`Unhandled event: ${String(_ex)}`);
    }
    }
  } }));
  try {
    const result = await worker.awaitExecution({ request: { executionId } });
    return { ...result, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
  } finally {
    await worker.disposeExecution({ request: { executionId } });
  }
}

describe('sysfs owners observe storage without running maintenance', () => {
  it('File Explorer can mount and list a not-yet-initialized store without creating it', async () => {
    const { root } = await fixture({ empty: true }); const host = makeHost();
    const watch = watchStorage(); const worker = createFileExplorerWorker();
    const { sessionId } = await worker.prepareSession({ request: { root: explorerRoot } }, undefined, host.host);
    cleanup.push(() => worker.disposeSession({ request: { sessionId } }));
    expect((await worker.readDirectory({ request: { sessionId, path: `${NAIDAN_SYSFS_ROOT_PATH}/chats` } })).entries).toEqual([]);
    expect((await worker.readFile({ request: { sessionId, path: `${NAIDAN_SYSFS_ROOT_PATH}/version` } })).blob.size).toBeGreaterThan(0);
    watch.assertNoWrites();
    const entries: string[] = []; for await (const name of root.keys()) entries.push(name);
    expect(entries).toEqual([]); expect(host.read).not.toHaveBeenCalled();
    await worker.disposeSession({ request: { sessionId } }); expect(host.release).toHaveBeenCalledOnce();
  });

  it('metadata preview and virtual archive leave legacy input and all missing categories unchanged', async () => {
    const { root, files } = await fixture({ empty: false }); const host = makeHost(); const watch = watchStorage();
    const before = new Uint8Array(files.get('chat-contents/chat-1.json')!.content);
    const worker = createFileExplorerWorker();
    const { sessionId } = await worker.prepareSession({ request: { root: explorerRoot } }, undefined, host.host);
    cleanup.push(() => worker.disposeSession({ request: { sessionId } }));
    await assertNoMigration({ root, files });
    expect(host.read).not.toHaveBeenCalled();
    const preview = await worker.readPreview({ request: { sessionId, path: metadataPath, mode: 'bounded' } });
    if (preview.kind !== 'text') throw new Error('Expected text');
    expect(JSON.parse(preview.rawText).title).toBe('日本語 😀');
    const result = await worker.createDirectoryArchive({ request: {
      sessionId, jobId: 'readonly-archive', directoryPath: `${NAIDAN_SYSFS_ROOT_PATH}/current-chat`, excludedRelativePaths: [],
    } });
    if (result.status !== 'completed') throw new Error('Expected archive');
    const zip = await JSZip.loadAsync(new Uint8Array(await result.blob.arrayBuffer()));
    const metadata = Object.values(zip.files).find(entry => entry.name.endsWith('/metadata.json') && !entry.name.includes('/branches/'));
    expect(metadata).toBeDefined();
    expect(JSON.parse(await metadata!.async('string')).title).toBe('日本語 😀');
    watch.assertNoWrites(); await assertNoMigration({ root, files });
    expect(files.get('chat-contents/chat-1.json')!.content).toEqual(before);
  });

  it('Wesh reads current data without running migration even when a legacy attachment is present', async () => {
    const { root, files } = await fixture({ empty: false }); const host = makeHost(); const watch = watchStorage();
    const worker = createWeshWorker(); cleanup.push(() => worker.dispose());
    await initializeWesh({ worker, host: host.host });
    await assertNoMigration({ root, files });
    expect(host.read).not.toHaveBeenCalled();
    const result = await run({ worker, script: `cat ${metadataPath}` });
    expect(result.exitCode).toBe(0); expect(JSON.parse(result.stdout).title).toBe('日本語 😀');
    expect(result.stderr).toBe('');
    watch.assertNoWrites(); await assertNoMigration({ root, files });
    await worker.dispose(); expect(host.release).toHaveBeenCalledOnce();
  });

  it('keeps separate mounted readers independent without creating migration state', async () => {
    const { root, files } = await fixture({ empty: false });
    const watch = watchStorage();
    const explorer = createFileExplorerWorker(); const shell = createWeshWorker();
    cleanup.push(() => shell.dispose());
    const first = makeHost(); const second = makeHost(); const third = makeHost();
    const a = await explorer.prepareSession({ request: { root: explorerRoot } }, undefined, first.host);
    cleanup.push(() => explorer.disposeSession({ request: { sessionId: a.sessionId } }));
    const b = await explorer.prepareSession({ request: { root: explorerRoot } }, undefined, second.host);
    cleanup.push(() => explorer.disposeSession({ request: { sessionId: b.sessionId } }));
    await initializeWesh({ worker: shell, host: third.host });
    await explorer.disposeSession({ request: { sessionId: a.sessionId } });
    expect(first.release).toHaveBeenCalledOnce();
    expect(second.release).not.toHaveBeenCalled(); expect(third.release).not.toHaveBeenCalled();
    expect(await explorer.readPreview({ request: { sessionId: b.sessionId, path: metadataPath, mode: 'bounded' } })).toMatchObject({ kind: 'text', oversized: false });
    expect((await run({ worker: shell, script: `cat ${metadataPath}` })).exitCode).toBe(0);
    watch.assertNoWrites(); await assertNoMigration({ root, files });
    await Promise.all([explorer.disposeSession({ request: { sessionId: b.sessionId } }), shell.dispose()]);
    expect(second.release).toHaveBeenCalledOnce(); expect(third.release).toHaveBeenCalledOnce();
  });

  it('leaves legacy attachment references unresolved until a normal storage owner explicitly migrates', async () => {
    const { root, files } = await fixture({ empty: false }); const host = makeHost();
    const blobs = createWorkerBlobContext({ host: host.host }); cleanup.push(() => blobs.dispose());
    const watch = watchStorage();
    const reader = await createOpfsNaidanSysfsStorageReader({ blobs });
    const old = await reader.loadChatContent({ chatId: toChatId({ raw: 'chat-1' }) });
    expect(old?.root.items[0]?.parts).toMatchObject([
      { type: 'text', text: '  original <think>literal</think>  ' }, { type: 'attachment', attachment: { status: 'missing' } },
    ]);
    expect(await reader.getBinaryObjectBlob({ binaryObjectId: await createLegacyUploadedFileId({ attachmentId: 'legacy-dir', name: 'a.bin' }) })).toBeUndefined();
    watch.assertNoWrites(); await assertNoMigration({ root, files }); watch.stop();
    const writable = new OPFSStorageProvider({ blobs }); await writable.init();
    const id = await createLegacyUploadedFileId({ attachmentId: 'legacy-dir', name: 'a.bin' });
    const migrated = await reader.loadChatContent({ chatId: toChatId({ raw: 'chat-1' }) });
    expect(migrated?.root.items[0]?.parts).toMatchObject([
      { type: 'text', text: '  original <think>literal</think>  ' }, { type: 'attachment', attachment: { status: 'persisted', binaryObjectId: id, mimeType: 'application/custom', uploadedAt: 0 } },
    ]);
    const raw = JSON.parse(new TextDecoder().decode(files.get('chat-contents/chat-1.json')!.content));
    expect(raw.unknownDocument).toEqual([1, 2]); expect(raw.root.items[0].unknownField).toEqual({ keep: true });
    expect(raw.root.items[0].attachments[0].binaryObjectId).toBe(idToRaw({ id }));
    expect(await reader.getBinaryObject({ binaryObjectId: id })).toMatchObject({ name: 'a.bin', createdAt: 0 });
    const freshWatch = watchStorage();
    const blob = await reader.getBinaryObjectBlob({ binaryObjectId: id });
    expect(blob).toBeDefined(); expect(await blobs.fromNative({ blob: blob! }).bytes()).toEqual(new Uint8Array([0, 255, 128, 1]));
    freshWatch.assertNoWrites();
  });

  it('does not consult an unreadable migration marker before normal read-only metadata access', async () => {
    const { root } = await fixture({ empty: false }); const host = makeHost();
    const state = await (await root.getDirectoryHandle('naidan-storage')).getFileHandle('migration-state.json', { create: true });
    state.content = new Uint8Array([255, 0, 128]);
    const stateRead = vi.spyOn(state, 'getFile').mockRejectedValue(new DOMException('No snapshot', 'NotReadableError'));
    const watch = watchStorage(); const blobs = createWorkerBlobContext({ host: host.host }); cleanup.push(() => blobs.dispose());
    const reader = await createOpfsNaidanSysfsStorageReader({ blobs });
    expect(await reader.loadChatMeta({ chatId: toChatId({ raw: 'chat-1' }) })).toMatchObject({ title: '日本語 😀' });
    expect(stateRead).not.toHaveBeenCalled(); watch.assertNoWrites();
    const writable = new OPFSStorageProvider({ blobs });
    await expect(writable.init()).rejects.toMatchObject({ name: 'OpfsBlobReadError' });
    expect(stateRead).toHaveBeenCalledOnce();
  });

  it('uses the unchanged Comlink Blob host while keeping OPFS sysfs reads non-mutating', async () => {
    const { root, files } = await fixture({ empty: false });
    // Only this transport fixture converts Mock handles into real cloneable Files.
    for (const [path, file] of files) {
      vi.spyOn(file as unknown as FileSystemFileHandle, 'getFile').mockImplementation(async () => new File([Uint8Array.from(file.content)], path.split('/').pop()!));
    }
    const watch = watchStorage();
    const worker = createFileExplorerWorker(); const channel = new MessageChannel();
    exposeWorkerRemote<IFileExplorerWorker>({ api: worker, endpoint: channel.port1 as unknown as MessagePort });
    const remote = wrapWorkerRemote<IFileExplorerWorker>({ endpoint: channel.port2 as unknown as MessagePort });
    const finalized = vi.fn(); const buffers: ArrayBuffer[] = [];
    const host = { read: async ({ blob, offset, length }: { blob: Blob, offset: number, length: number }) => {
      const bytes = await nativeRead({ blob, offset, length }); buffers.push(bytes.buffer);
      return workerTransfer({ value: bytes, transferables: [bytes.buffer] });
    } };
    Object.assign(host, { [Comlink.finalizer]: finalized });
    let sessionId: string | undefined;
    try {
      const prepared = await remote.prepareSession(workerCapability({ value: { request: { root: explorerRoot } }, capability: 'file-system-handle-clone' }), undefined, workerProxy({ value: host }));
      sessionId = prepared.sessionId;
      const response = await remote.readFile({ request: { sessionId, path: metadataPath } });
      expect(JSON.parse(await response.blob.text()).title).toBe('日本語 😀');
      expect(buffers.length).toBeGreaterThan(1); expect(buffers.every(buffer => buffer.byteLength === 0)).toBe(true);
      await remote.disposeSession({ request: { sessionId } });
      await vi.waitFor(() => expect(finalized).toHaveBeenCalledOnce());
      watch.assertNoWrites();
      const storage = await root.getDirectoryHandle('naidan-storage');
      await expect(storage.getDirectoryHandle('uploaded-files')).resolves.toBeDefined();
    } finally {
      if (sessionId !== undefined) await remote.disposeSession({ request: { sessionId } });
      releaseWorkerRemote({ remote }); channel.port1.close(); channel.port2.close();
    }
  });
});
