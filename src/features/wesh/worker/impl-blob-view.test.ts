// @vitest-environment node
import { MessageChannel } from 'node:worker_threads';
import * as Comlink from 'comlink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as io from '@/utils/blob-view-io';
import { exposeWorkerRemote, wrapWorkerRemote, releaseWorkerRemote, workerTransfer, workerProxy, workerCapability } from '@/utils/worker-transport';
import { MockFile, MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { NAIDAN_SYSFS_ROOT_PATH } from '@/features/wesh/naidan-sysfs/constants';
import type { NaidanSysfsRemoteReader } from '@/features/wesh/naidan-sysfs/types';
import type { WorkerBlobReadHost } from '@/utils/worker-blob-context';
import type { IWeshWorker, WeshWorkerInitRequest, WeshWorkerRemoteExecutionEvent } from './types';
import { createWeshWorker } from './impl';

const nativeRead = io.readNativeBlobRange;
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  try {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
  } finally {
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  }
});
function createHost() {
  const release = vi.fn();
  const read = vi.fn(async ({ blob, offset, length }: { blob: Blob, offset: number, length: number }) => {
    if (release.mock.calls.length) throw new Error('Read after host released');
    const bytes = await nativeRead({ blob, offset, length });
    return workerTransfer({ value: bytes, transferables: [bytes.buffer] });
  });
  return { host: Object.assign({ read }, { [Comlink.releaseProxy]: release }), read, release };
}
function blockWorkerBlobReads() {
  vi.spyOn(io, 'readNativeBlobRange').mockRejectedValue(new DOMException('Opaque Worker', 'NotReadableError'));
  vi.spyOn(MockFile.prototype, 'text').mockRejectedValue(new Error('Unsafe text'));
  vi.spyOn(MockFile.prototype, 'stream').mockImplementation(() => {
    throw new Error('Unsafe stream');
  });
}
function initRequest({ root, mounts }: { root: WeshWorkerInitRequest['rootHandle'], mounts: WeshWorkerInitRequest['mounts'] }): WeshWorkerInitRequest {
  return { rootHandle: root, mounts, user: 'user', initialEnv: {}, initialCwd: undefined };
}
function sysfsMount({ storageType, binaryObjectAccess }: { storageType: 'opfs' | 'memory', binaryObjectAccess: 'none' | 'metadata_only' | 'data' }): WeshWorkerInitRequest['mounts'] {
  return [{ type: 'naidan_sysfs', path: NAIDAN_SYSFS_ROOT_PATH, readOnly: true, storageType,
    visibility: 'current_chat_only', binaryObjectAccess, currentChatId: 'chat-1', currentChatGroupId: undefined }];
}
function sysfsReader({ blob }: { blob: Blob }): NaidanSysfsRemoteReader {
  const object = { id: 'blob-a1', name: 'data.bin', size: blob.size, mimeType: 'application/octet-stream', createdAt: 1 };
  return {
    storageType: 'memory', getSidebarStructure: async () => [], listChats: async () => [], listChatGroups: async () => [],
    loadChatMeta: async () => undefined, loadChatContent: async () => undefined, loadChat: async () => undefined, loadChatGroup: async () => undefined,
    listBinaryObjects: async () => [object], getBinaryObject: async () => object, getBinaryObjectBlob: async () => blob,
  };
}
async function capture({ worker, script }: { worker: ReturnType<typeof createWeshWorker>, script: string }) {
  const stdout: Uint8Array[] = []; const stderr: Uint8Array[] = [];
  const { executionId } = await worker.startExecution({ script }, event => {
    switch (event.type) {
    case 'stdout': stdout.push(new Uint8Array(event.buffer)); break;
    case 'stderr': stderr.push(new Uint8Array(event.buffer)); break;
    case 'started': case 'exit': case 'error': break;
    default: { const _ex: never = event; throw new Error(`Unexpected event ${String(_ex)}`); }
    }
  });
  try {
    const result = await worker.awaitExecution({ request: { executionId } });
    return { ...result, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') };
  } finally {
    await worker.disposeExecution({ request: { executionId } });
  }
}

describe('Wesh Worker owning a BlobContext', () => {
  it('executes binary cat, native cp and symlink scripts through the host with one probe', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const bytes = Uint8Array.from({ length: io.BLOB_VIEW_CHUNK_SIZE + 17 }, (_, i) => i % 256);
    (await root.getFileHandle('input.bin', { create: true })).content = bytes;
    const { host, read, release } = createHost();
    const worker = createWeshWorker(); cleanup.push(() => worker.dispose());
    blockWorkerBlobReads();
    const direct = vi.mocked(io.readNativeBlobRange);
    await worker.init(initRequest({ root: root as unknown as FileSystemDirectoryHandle, mounts: [] }), undefined, host);
    const result = await capture({ worker, script: 'cp /input.bin /copy.bin; ln -s /copy.bin /linked; cat /linked' });
    expect(result.stderr).toBe(''); expect(result.exitCode).toBe(0);
    expect(Buffer.compare(result.stdout, Buffer.from(bytes))).toBe(0);
    expect(read.mock.calls.every(([request]) => request.length <= io.BLOB_VIEW_CHUNK_SIZE)).toBe(true);
    expect(direct).toHaveBeenCalledOnce();
    await worker.dispose(); await worker.dispose(); expect(release).toHaveBeenCalledOnce();
  });

  it('uses context-backed handles for cat and cmp even when getFile returns real native Files', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const bytes = new Uint8Array([0, 255, 128, 195, 40, 1]);
    for (const name of ['a.bin', 'b.bin']) {
      const handle = await root.getFileHandle(name, { create: true });
      handle.content = bytes.slice();
      // Only the fixture converts MockFile into the native File that exposes the
      // optional Blob fast path. Production never needs this whole-file copy.
      vi.spyOn(handle as unknown as FileSystemFileHandle, 'getFile').mockImplementation(async () => new File([handle.content.slice()], name));
    }
    const { host, read } = createHost(); const worker = createWeshWorker(); cleanup.push(() => worker.dispose());
    blockWorkerBlobReads();
    const unsafeStream = vi.spyOn(Blob.prototype, 'stream').mockImplementation(() => {
      throw new Error('Unsafe native Blob stream');
    });
    const unsafeText = vi.spyOn(Blob.prototype, 'text').mockRejectedValue(new Error('Unsafe native Blob text'));
    await worker.init(initRequest({ root: root as unknown as FileSystemDirectoryHandle, mounts: [] }), undefined, host);
    const result = await capture({ worker, script: 'cmp /a.bin /b.bin && cat /a.bin' });
    expect(result.exitCode).toBe(0); expect(result.stderr).toBe('');
    expect(result.stdout).toEqual(Buffer.from(bytes)); expect(read).toHaveBeenCalled();
    expect(unsafeStream).not.toHaveBeenCalled(); expect(unsafeText).not.toHaveBeenCalled();
  });

  it('does not call the host when native reads succeed', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    (await root.getFileHandle('input.txt', { create: true })).content = new TextEncoder().encode('native 日本語');
    const { host, read } = createHost(); const worker = createWeshWorker(); cleanup.push(() => worker.dispose());
    await worker.init(initRequest({ root: root as unknown as FileSystemDirectoryHandle, mounts: [] }), undefined, host);
    expect((await capture({ worker, script: 'cat /input.txt' })).stdout.toString()).toBe('native 日本語');
    expect(read).not.toHaveBeenCalled();
  });

  it('uses the owning context for OPFS sysfs metadata before executing generated text', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const storage = await root.getDirectoryHandle('naidan-storage', { create: true });
    const metas = await storage.getDirectoryHandle('chat-metas', { create: true });
    (await metas.getFileHandle('chat-1.json', { create: true })).content = new TextEncoder().encode(JSON.stringify({ id: 'chat-1', title: 'メタデータ 😀', createdAt: 1, updatedAt: 2, debugEnabled: false }));
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
    const { host, read } = createHost(); const worker = createWeshWorker(); cleanup.push(() => worker.dispose());
    blockWorkerBlobReads();
    await worker.init(initRequest({ root: 'readonly', mounts: sysfsMount({ storageType: 'opfs', binaryObjectAccess: 'data' }) }), undefined, host);
    const result = await capture({ worker, script: `cat ${NAIDAN_SYSFS_ROOT_PATH}/current-chat/metadata.json` });
    expect(result.exitCode).toBe(0); expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout.toString()).title).toBe('メタデータ 😀'); expect(read).toHaveBeenCalled();
  });

  it.each(['none', 'metadata_only'] as const)('preserves sysfs binary permissions for %s mounts', async binaryObjectAccess => {
    const sysfs = sysfsReader({ blob: new Blob(['secret']) });
    const blobRead = vi.spyOn(sysfs, 'getBinaryObjectBlob');
    const { host, read } = createHost(); const worker = createWeshWorker(); cleanup.push(() => worker.dispose()); blockWorkerBlobReads();
    await worker.init(initRequest({ root: 'readonly', mounts: sysfsMount({ storageType: 'memory', binaryObjectAccess }) }), sysfs, host);
    const result = await capture({ worker, script: `cat ${NAIDAN_SYSFS_ROOT_PATH}/binary-objects/by-id/blob-a1/data` });
    expect(result.exitCode).not.toBe(0); expect(result.stdout).toHaveLength(0);
    expect(blobRead).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  });

  it('does not expose a shell when read-only OPFS sysfs cannot access the storage root', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const storage = await root.getDirectoryHandle('naidan-storage', { create: true });
    const state = await storage.getFileHandle('migration-state.json', { create: true });
    state.content = new TextEncoder().encode(JSON.stringify({ completedMigrations: [] }));
    const snapshot = state.content.slice();
    const write = vi.spyOn(state, 'createWritable');
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
    const { host, read, release } = createHost(); const worker = createWeshWorker(); cleanup.push(() => worker.dispose());
    blockWorkerBlobReads();
    const failure = new DOMException('Storage root denied', 'NotAllowedError');
    vi.spyOn(root, 'getDirectoryHandle').mockRejectedValue(failure);
    await expect(worker.init(initRequest({ root: 'readonly', mounts: sysfsMount({ storageType: 'opfs', binaryObjectAccess: 'data' }) }), undefined, host)).rejects.toBe(failure);
    expect(read).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce(); expect(state.content).toEqual(snapshot); expect(write).not.toHaveBeenCalled();
    await expect(worker.getShellState()).rejects.toThrow('not initialized');
  });

  it('rejects reinitialization during execution without breaking the active host', async () => {
    const worker = createWeshWorker(); cleanup.push(() => worker.dispose());
    const first = createHost(); const second = createHost();
    await worker.init(initRequest({ root: 'readonly', mounts: [] }), undefined, first.host);
    const paused = Promise.withResolvers<void>();
    const { executionId } = await worker.startExecution({ script: 'echo ready' }, async event => {
      if (event.type === 'started') await paused.promise;
    });
    await expect(worker.init(initRequest({ root: 'readonly', mounts: [] }), undefined, second.host)).rejects.toThrow('busy');
    expect(first.release).not.toHaveBeenCalled(); expect(second.release).toHaveBeenCalledOnce();
    paused.resolve(); expect(await worker.awaitExecution({ request: { executionId } })).toEqual({ exitCode: 0 });
    expect((await worker.getShellState()).cwd).toBe('/');
  });

  it('releases borrowed proxies on invalid initialization and permits a later clean attempt', async () => {
    const { host, release } = createHost(); const sysfs = sysfsReader({ blob: new Blob([]) }); const releaseSysfs = vi.fn();
    Object.assign(sysfs, { [Comlink.releaseProxy]: releaseSysfs });
    const worker = createWeshWorker(); cleanup.push(() => worker.dispose());
    await expect(worker.init({ ...initRequest({ root: 'readonly', mounts: [] }), user: '' }, sysfs, host)).rejects.toThrow();
    expect(release).toHaveBeenCalledOnce(); expect(releaseSysfs).toHaveBeenCalledOnce();
    await expect(worker.getShellState()).rejects.toThrow('not initialized');
    const next = createHost();
    await worker.init(initRequest({ root: 'readonly', mounts: [] }), undefined, next.host);
    expect((await worker.getShellState()).cwd).toBe('/');
    await worker.dispose(); expect(next.release).toHaveBeenCalledOnce();
  });

  it('does not publish late initialization after dispose and cleans up duplicate init inputs', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const pending = Promise.withResolvers<FileSystemDirectoryHandle>();
    const getDirectory = vi.fn(() => pending.promise);
    vi.stubGlobal('navigator', { storage: { getDirectory } });
    const first = createHost(); const second = createHost();
    const worker = createWeshWorker(); cleanup.push(() => worker.dispose());
    const initializing = worker.init(initRequest({ root: { kind: 'opfs-directory', pathSegments: [] }, mounts: [] }), undefined, first.host);
    const rejected = expect(initializing).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(getDirectory).toHaveBeenCalledOnce());
    await expect(worker.init(initRequest({ root: 'readonly', mounts: [] }), undefined, second.host)).rejects.toThrow('busy');
    expect(second.release).toHaveBeenCalledOnce(); expect(first.release).not.toHaveBeenCalled();
    await worker.dispose(); expect(first.release).toHaveBeenCalledOnce();
    pending.resolve(root as unknown as FileSystemDirectoryHandle); await rejected;
    await expect(worker.getShellState()).rejects.toThrow('not initialized');
  });

  it('reinitializes an idle shell without reusing the previous host', async () => {
    const worker = createWeshWorker(); cleanup.push(() => worker.dispose());
    const first = createHost(); const second = createHost();
    await worker.init(initRequest({ root: 'readonly', mounts: [] }), undefined, first.host);
    await worker.init({ ...initRequest({ root: 'readonly', mounts: [] }), initialCwd: '/other' }, undefined, second.host);
    expect(first.release).toHaveBeenCalledOnce(); expect(second.release).not.toHaveBeenCalled();
    expect((await worker.getShellState()).cwd).toBe('/other');
    await worker.dispose(); expect(second.release).toHaveBeenCalledOnce();
  });

  it('captures the execution shell before a delayed started callback and never dereferences a disposed shell', async () => {
    const worker = createWeshWorker(); cleanup.push(() => worker.dispose());
    const { host } = createHost(); await worker.init(initRequest({ root: 'readonly', mounts: [] }), undefined, host);
    const late = Promise.withResolvers<void>();
    const events: WeshWorkerRemoteExecutionEvent[] = [];
    const { executionId } = await worker.startExecution({ script: 'echo must-not-run' }, async event => {
      events.push(event); if (event.type === 'started') await late.promise;
    });
    const completion = worker.awaitExecution({ request: { executionId } });
    const rejected = expect(completion).rejects.toMatchObject({ name: 'AbortError' });
    await worker.dispose(); late.resolve(); await rejected;
    expect(events.some(event => event.type === 'stdout')).toBe(false);
  });

  it('disposes a stalled Blob read without replaying an execution after a late response', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    (await root.getFileHandle('input.bin', { create: true })).content = new Uint8Array([0, 255, 128]);
    const { host, read, release } = createHost(); const worker = createWeshWorker(); cleanup.push(() => worker.dispose()); blockWorkerBlobReads();
    await worker.init(initRequest({ root: root as unknown as FileSystemDirectoryHandle, mounts: [] }), undefined, host);
    const late = Promise.withResolvers<Awaited<ReturnType<WorkerBlobReadHost['read']>>>();
    read.mockImplementation(async ({ blob, offset, length }) => {
      if (blob.size === 3) return late.promise;
      const bytes = await nativeRead({ blob, offset, length }); return workerTransfer({ value: bytes, transferables: [bytes.buffer] });
    });
    const output: WeshWorkerRemoteExecutionEvent[] = [];
    const { executionId } = await worker.startExecution({ script: 'cat /input.bin' }, event => {
      output.push(event);
    });
    await vi.waitFor(() => expect(read.mock.calls.some(([request]) => request.blob.size === 3)).toBe(true));
    await worker.dispose(); expect(release).toHaveBeenCalledOnce();
    const result = await worker.awaitExecution({ request: { executionId } });
    expect(result.exitCode).not.toBe(0); expect(output.some(event => event.type === 'stdout')).toBe(false);
    late.reject(new Error('Late host failure'));
  });

  it('passes real sysfs Blob and output bytes through Comlink and releases all reverse proxies', async () => {
    const worker = createWeshWorker();
    const channel = new MessageChannel();
    exposeWorkerRemote<IWeshWorker>({ api: worker, endpoint: channel.port1 as unknown as MessagePort });
    const remote = wrapWorkerRemote<IWeshWorker>({ endpoint: channel.port2 as unknown as MessagePort });
    const bytes = Uint8Array.from({ length: io.BLOB_VIEW_CHUNK_SIZE + 13 }, (_, i) => i % 256);
    const sysfs = sysfsReader({ blob: new Blob([bytes]) });
    const sysfsFinalized = vi.fn(); const hostFinalized = vi.fn(); const eventFinalized = vi.fn();
    Object.assign(sysfs, { [Comlink.finalizer]: sysfsFinalized });
    const transferred: ArrayBuffer[] = [];
    const host: WorkerBlobReadHost = { async read(request) {
      const result = await nativeRead(request); transferred.push(result.buffer);
      return workerTransfer({ value: result, transferables: [result.buffer] });
    } };
    Object.assign(host, { [Comlink.finalizer]: hostFinalized });
    const output: Uint8Array[] = [];
    const onEvent = Object.assign((event: WeshWorkerRemoteExecutionEvent) => {
      if (event.type === 'stdout') output.push(new Uint8Array(event.buffer));
    }, { [Comlink.finalizer]: eventFinalized });
    blockWorkerBlobReads();
    try {
      await remote.init(workerCapability({ value: initRequest({ root: 'readonly', mounts: sysfsMount({ storageType: 'memory', binaryObjectAccess: 'data' }) }), capability: 'file-system-handle-clone' }), workerProxy({ value: sysfs }), workerProxy({ value: host }));
      const { executionId } = await remote.startExecution({ script: `cat ${NAIDAN_SYSFS_ROOT_PATH}/binary-objects/by-id/blob-a1/data` }, workerProxy({ value: onEvent }));
      expect(await remote.awaitExecution({ request: { executionId } })).toEqual({ exitCode: 0 });
      expect(Buffer.compare(Buffer.concat(output), Buffer.from(bytes))).toBe(0);
      expect(transferred.length).toBeGreaterThan(2); expect(transferred.every(buffer => buffer.byteLength === 0)).toBe(true);
      await Promise.all([remote.dispose(), remote.dispose()]);
      await vi.waitFor(() => {
        expect(sysfsFinalized).toHaveBeenCalledOnce(); expect(hostFinalized).toHaveBeenCalledOnce(); expect(eventFinalized).toHaveBeenCalledOnce();
      });
    } finally {
      await worker.dispose(); releaseWorkerRemote({ remote }); channel.port1.close(); channel.port2.close();
    }
  });
});
