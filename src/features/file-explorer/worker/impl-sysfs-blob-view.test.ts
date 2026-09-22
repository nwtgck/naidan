// @vitest-environment node
import { MessageChannel } from 'node:worker_threads';
import * as Comlink from 'comlink';
import JSZip from 'jszip';
import { TEST_ONLY as utf8 } from '@/utils/utf8-text-source';
import { TEXT_PREVIEW_SIZE_LIMIT } from '@/features/file-explorer/logic/constants';
import { GeneratedTextFileHandle } from '@/features/wesh/naidan-sysfs/generated-text-file-handle';
import { WeshVFS } from '@/features/wesh/vfs';
import { BlobFileHandle } from '@/features/wesh/naidan-sysfs/blob-file-handle';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockFile, MockFileSystemDirectoryHandle, MockFileSystemFileHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { OPFSStorageProvider, OpfsBlobReadError } from '@/00-storage/service/opfs-storage';
import { toBinaryObjectId } from '@/01-models/ids';
import type { NaidanSysfsRemoteReader } from '@/features/wesh/naidan-sysfs/types';
import { NAIDAN_SYSFS_ROOT_PATH } from '@/features/wesh/naidan-sysfs/constants';
import type { NaidanSysfsBinaryObjectAccess } from '@/features/wesh/types';
import * as io from '@/utils/blob-view-io';
import { exposeWorkerRemote, releaseWorkerRemote, workerProxy, workerCapability, workerTransfer, wrapWorkerRemote } from '@/utils/worker-transport';
import type { WorkerBlobReadHost } from '@/utils/worker-blob-context';
import { createFileExplorerWorker } from './impl';
import type { FileExplorerRootDescriptor, IFileExplorerWorker } from './types';

const nativeRead = io.readNativeBlobRange;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  try {
    for (const dispose of cleanup.splice(0)) await dispose();
  } finally {
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  }
});
async function write({ root, path, text }: { root: MockFileSystemDirectoryHandle, path: string, text: string }) {
  const parts = path.split('/'); const name = parts.pop()!;
  let dir = root;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
  const file = await dir.getFileHandle(name, { create: true });
  const writer = await file.createWritable(); await writer.write(text); await writer.close();
  return file;
}
function sysfsRoot({ storageType, access }: { storageType: 'opfs' | 'memory', access: NaidanSysfsBinaryObjectAccess }): FileExplorerRootDescriptor {
  return { kind: 'wesh-mounts', rootName: 'Virtual', mounts: [{
    type: 'naidan_sysfs', path: NAIDAN_SYSFS_ROOT_PATH, readOnly: true, storageType,
    visibility: 'current_chat_only', binaryObjectAccess: access,
    currentChatId: 'chat-1', currentChatGroupId: undefined,
  }] };
}
async function fixture() {
  const root = new MockFileSystemDirectoryHandle({ name: 'root' });
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
  const provider = new OPFSStorageProvider();
  await provider.init();
  const storage = await root.getDirectoryHandle('naidan-storage');
  const metadata = await write({ root: storage, path: 'chat-metas/chat-1.json', text: JSON.stringify({ id: 'chat-1', title: '日本語 😀', createdAt: 1, updatedAt: 2, debugEnabled: false }) });
  await write({ root: storage, path: 'chat-contents/chat-1.json', text: JSON.stringify({ root: { items: [] } }) });
  await write({ root: storage, path: 'hierarchy.json', text: JSON.stringify({ items: [{ type: 'chat', id: 'chat-1' }] }) });
  const bytes = Uint8Array.from({ length: io.BLOB_VIEW_CHUNK_SIZE + 17 }, (_, i) => i % 256);
  await provider.saveFile({ blob: new Blob([bytes]), binaryObjectId: toBinaryObjectId({ raw: 'blob-a1' }), name: 'data.bin' });
  const worker = createFileExplorerWorker();
  const release = vi.fn();
  const read = vi.fn(async ({ blob, offset, length }: { blob: Blob, offset: number, length: number }) => {
    if (release.mock.calls.length > 0) throw new Error('Read after host release');
    const result = await nativeRead({ blob, offset, length });
    return workerTransfer({ value: result, transferables: [result.buffer] });
  });
  const host = Object.assign({ read }, { [Comlink.releaseProxy]: release });
  vi.spyOn(io, 'readNativeBlobRange').mockRejectedValue(new DOMException('Opaque Worker', 'NotReadableError'));
  vi.spyOn(MockFile.prototype, 'text').mockRejectedValue(new Error('Unsafe text read'));
  vi.spyOn(MockFile.prototype, 'stream').mockImplementation(() => {
    throw new Error('Unsafe stream read');
  });
  async function prepare({ access }: { access: NaidanSysfsBinaryObjectAccess }) {
    const { sessionId } = await worker.prepareSession({ request: { root: sysfsRoot({ storageType: 'opfs', access }) } }, undefined, host);
    cleanup.push(() => worker.disposeSession({ request: { sessionId } }));
    return sessionId;
  }
  return { root, storage, provider, worker, host, read, release, metadata, bytes, prepare };
}
const dataPath = `${NAIDAN_SYSFS_ROOT_PATH}/binary-objects/by-id/blob-a1/data`;

describe('File Explorer sysfs with session BlobViews', () => {
  it('opens OPFS sysfs, reads stored metadata and retrieves arbitrary attachment bytes through the host', async () => {
    const { prepare, worker, read, bytes } = await fixture();
    const sessionId = await prepare({ access: 'data' });
    const listing = await worker.readDirectory({ request: { sessionId, path: `${NAIDAN_SYSFS_ROOT_PATH}/current-chat` } });
    expect(listing.entries.map(entry => entry.name)).toContain('metadata.json');
    const preview = await worker.readPreview({ request: { sessionId, path: `${NAIDAN_SYSFS_ROOT_PATH}/current-chat/metadata.json`, mode: 'bounded' } });
    if (preview.kind !== 'text') throw new Error('Expected metadata text');
    expect(JSON.parse(preview.rawText).title).toBe('日本語 😀');
    const file = await worker.readFile({ request: { sessionId, path: dataPath } });
    expect(new Uint8Array(await file.blob.arrayBuffer())).toEqual(bytes);
    expect(read.mock.calls.every(([request]) => request.length <= io.BLOB_VIEW_CHUNK_SIZE)).toBe(true);
  });

  it('stops actual generated-text consumption at the production limit plus one and supports force', async () => {
    const { prepare, worker, metadata } = await fixture();
    const title = 'x'.repeat(TEXT_PREVIEW_SIZE_LIMIT + 17);
    const writer = await metadata.createWritable();
    await writer.write(JSON.stringify({ id: 'chat-1', title, createdAt: 1, updatedAt: 2, debugEnabled: false }));
    await writer.close();
    const sessionId = await prepare({ access: 'data' });
    const read = vi.spyOn(GeneratedTextFileHandle.prototype, 'read');
    const close = vi.spyOn(GeneratedTextFileHandle.prototype, 'close');
    const path = `${NAIDAN_SYSFS_ROOT_PATH}/current-chat/metadata.json`;
    expect(await worker.readPreview({ request: { sessionId, path, mode: 'bounded' } })).toMatchObject({
      kind: 'text', rawText: '', displayText: '', oversized: true,
    });
    const results = await Promise.all(read.mock.results.map(result => result.value));
    expect(results.reduce((total, result) => total + result.bytesRead, 0)).toBe(TEXT_PREVIEW_SIZE_LIMIT + 1);
    expect(close).toHaveBeenCalledOnce();
    const result = await worker.readPreview({ request: { sessionId, path, mode: 'force' } });
    if (result.kind !== 'text') throw new Error('Expected text');
    expect(result.oversized).toBe(false);
    expect(JSON.parse(result.rawText).title).toBe(title);
    expect(result.displayText).toBe(JSON.stringify(JSON.parse(result.rawText), null, 2));
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('encodes only bounded blocks of oversized generated metadata and does not encode its unread tail', async () => {
    const { prepare, worker, metadata } = await fixture();
    const title = 'x'.repeat(2 * TEXT_PREVIEW_SIZE_LIMIT + 17);
    const writer = await metadata.createWritable();
    await writer.write(JSON.stringify({ id: 'chat-1', title, createdAt: 1, updatedAt: 2, debugEnabled: false }));
    await writer.close();
    const sessionId = await prepare({ access: 'data' });
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    const result = await worker.readPreview({ request: {
      sessionId, path: `${NAIDAN_SYSFS_ROOT_PATH}/current-chat/metadata.json`, mode: 'bounded',
    } });
    expect(result).toMatchObject({ kind: 'text', oversized: true, rawText: '' });
    expect(encode).toHaveBeenCalled();
    expect(encode.mock.calls.every(([input]) => input!.length <= utf8.TEXT_BLOCK_CODE_UNITS)).toBe(true);
    const encodedCharacters = encode.mock.calls.reduce((total, [input]) => total + input!.length, 0);
    expect(encodedCharacters).toBeGreaterThan(TEXT_PREVIEW_SIZE_LIMIT);
    expect(encodedCharacters).toBeLessThanOrEqual(TEXT_PREVIEW_SIZE_LIMIT + utf8.TEXT_BLOCK_CODE_UNITS);
    expect(encodedCharacters).toBeLessThan(title.length);
  });

  it('preserves complete large generated metadata in file and ZIP results, not the estimated prefix', async () => {
    const { prepare, worker, metadata } = await fixture();
    const title = '日本語😀'.repeat(20_000);
    const writer = await metadata.createWritable();
    await writer.write(JSON.stringify({ id: 'chat-1', title, createdAt: 1, updatedAt: 2, debugEnabled: false }));
    await writer.close();
    const sessionId = await prepare({ access: 'data' });
    const path = `${NAIDAN_SYSFS_ROOT_PATH}/current-chat`;
    const file = await worker.readFile({ request: { sessionId, path: `${path}/metadata.json` } });
    const expected = await file.blob.text();
    expect(JSON.parse(expected).title).toBe(title);
    const archive = await worker.createDirectoryArchive({ request: {
      sessionId, jobId: 'text-zip', directoryPath: path, excludedRelativePaths: [],
    } });
    if (archive.status !== 'completed') throw new Error('Expected archive');
    const zip = await JSZip.loadAsync(new Uint8Array(await archive.blob.arrayBuffer()));
    const entry = Object.values(zip.files).find(value => value.name.endsWith('/metadata.json'));
    expect(entry).toBeDefined();
    expect(await entry!.async('string')).toBe(expected);
  });

  it('does not open or consume attachment data to produce a binary preview placeholder', async () => {
    const { prepare, worker } = await fixture();
    const sessionId = await prepare({ access: 'data' });
    const read = vi.spyOn(BlobFileHandle.prototype, 'read');
    const open = vi.spyOn(WeshVFS.prototype, 'open');
    expect(await worker.readPreview({ request: { sessionId, path: dataPath, mode: 'bounded' } })).toEqual({ kind: 'binary', oversized: false });
    expect(read).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('archives virtual binary content without returning to native Worker Blob consumption', async () => {
    const { prepare, worker, bytes } = await fixture();
    const sessionId = await prepare({ access: 'data' });
    const archive = await worker.createDirectoryArchive({ request: { sessionId, jobId: 'virtual-zip', directoryPath: dataPath.slice(0, -5), excludedRelativePaths: [] } });
    if (archive.status !== 'completed') throw new Error('Expected an archive');
    const zip = await JSZip.loadAsync(new Uint8Array(await archive.blob.arrayBuffer()));
    const entry = Object.values(zip.files).find(file => file.name.endsWith('/data'));
    expect(entry).toBeDefined();
    expect(await entry!.async('uint8array')).toEqual(bytes);
  });

  it.each(['metadata_only', 'none'] as const)('does not widen binary access for %s mounts', async access => {
    const { prepare, worker, read } = await fixture();
    const sessionId = await prepare({ access });
    await expect(worker.readFile({ request: { sessionId, path: dataPath } })).rejects.toThrow();
    expect(read.mock.calls.some(([{ blob }]) => 'name' in blob && blob.name === 'blob-a1.bin')).toBe(false);
  });

  it('propagates metadata read failures through directory and preview lookup instead of treating them as missing', async () => {
    const { prepare, worker, read } = await fixture();
    const sessionId = await prepare({ access: 'data' });
    const path = `${NAIDAN_SYSFS_ROOT_PATH}/current-chat/metadata.json`;
    const before = read.mock.calls.length;
    read.mockRejectedValue(new Error('Host bytes unavailable'));
    await expect(worker.readPreview({ request: { sessionId, path, mode: 'bounded' } })).rejects.toBeInstanceOf(OpfsBlobReadError);
    expect(read.mock.calls.length).toBe(before + 1);
    await expect(worker.readDirectory({ request: { sessionId, path: `${NAIDAN_SYSFS_ROOT_PATH}/binary-objects/by-id/blob-a1` } })).rejects.toBeInstanceOf(OpfsBlobReadError);
  });

  it('fails session preparation without writing when the read-only storage root is inaccessible, then releases the host', async () => {
    const { root, prepare, read, release } = await fixture();
    const writes = vi.spyOn(MockFileSystemFileHandle.prototype, 'createWritable');
    const failure = new DOMException('Storage root denied', 'NotAllowedError');
    vi.spyOn(root, 'getDirectoryHandle').mockRejectedValue(failure);
    await expect(prepare({ access: 'data' })).rejects.toBe(failure);
    expect(read).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('does not turn a malformed stored JSON into a byte transport error', async () => {
    const { prepare, worker, metadata } = await fixture();
    const writer = await metadata.createWritable(); await writer.write('{invalid'); await writer.close();
    const sessionId = await prepare({ access: 'data' });
    await expect(worker.readFile({ request: { sessionId, path: `${NAIDAN_SYSFS_ROOT_PATH}/current-chat/metadata.json` } })).rejects.not.toBeInstanceOf(OpfsBlobReadError);
  });
});

function remoteReader({ blob }: { blob: Blob }): NaidanSysfsRemoteReader {
  const metadata = { id: 'blob-a1', name: 'payload.bin', mimeType: 'application/octet-stream', size: blob.size, createdAt: 1 };
  return {
    storageType: 'memory',
    getSidebarStructure: async () => [], listChats: async () => [], listChatGroups: async () => [],
    loadChatMeta: async () => undefined, loadChatContent: async () => undefined,
    loadChat: async () => undefined, loadChatGroup: async () => undefined,
    listBinaryObjects: async () => [metadata], getBinaryObject: async () => metadata, getBinaryObjectBlob: async () => blob,
  };
}

describe('sysfs reverse proxy ownership', () => {
  it('passes a real remote attachment through Blob clone and range transfers, and releases both proxies once', async () => {
    const worker = createFileExplorerWorker();
    const channel = new MessageChannel();
    exposeWorkerRemote<IFileExplorerWorker>({ api: worker, endpoint: channel.port1 as unknown as MessagePort });
    const remote = wrapWorkerRemote<IFileExplorerWorker>({ endpoint: channel.port2 as unknown as MessagePort });
    const bytes = Uint8Array.from({ length: 65_537 }, (_, i) => i % 256);
    const sysfs = remoteReader({ blob: new Blob([bytes]) });
    const sysfsRelease = vi.fn(); const hostRelease = vi.fn();
    Object.assign(sysfs, { [Comlink.finalizer]: sysfsRelease });
    const sent: ArrayBuffer[] = [];
    const host: WorkerBlobReadHost = {
      async read({ blob, offset, length }) {
        const result = await nativeRead({ blob, offset, length }); sent.push(result.buffer);
        return workerTransfer({ value: result, transferables: [result.buffer] });
      },
    };
    Object.assign(host, { [Comlink.finalizer]: hostRelease });
    vi.spyOn(io, 'readNativeBlobRange').mockRejectedValue(new DOMException('Opaque Worker', 'NotReadableError'));
    let sessionId: string | undefined;
    try {
      ({ sessionId } = await remote.prepareSession(workerCapability({ value: { request: { root: sysfsRoot({ storageType: 'memory', access: 'data' }) } }, capability: 'file-system-handle-clone' }), workerProxy({ value: sysfs }), workerProxy({ value: host })));
      const result = await remote.readFile({ request: { sessionId, path: dataPath } });
      expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(bytes);
      expect(sent.length).toBeGreaterThan(1);
      expect(sent.every(buffer => buffer.byteLength === 0)).toBe(true);
      await Promise.all([remote.disposeSession({ request: { sessionId } }), remote.disposeSession({ request: { sessionId } })]);
      await vi.waitFor(() => {
        expect(sysfsRelease).toHaveBeenCalledOnce(); expect(hostRelease).toHaveBeenCalledOnce();
      });
    } finally {
      if (sessionId !== undefined) await worker.disposeSession({ request: { sessionId } });
      releaseWorkerRemote({ remote }); channel.port1.close(); channel.port2.close();
    }
  });

  it('releases both borrowed proxies if preparation fails', async () => {
    const worker = createFileExplorerWorker();
    const sysfsRelease = vi.fn(); const hostRelease = vi.fn();
    const sysfs = Object.assign(remoteReader({ blob: new Blob([]) }), { [Comlink.releaseProxy]: sysfsRelease });
    const host = Object.assign({ read: vi.fn() }, { [Comlink.releaseProxy]: hostRelease });
    await expect(worker.prepareSession({ request: { root: { kind: 'opfs-root', rootName: '' } } }, sysfs, host)).rejects.toThrow();
    expect(sysfsRelease).toHaveBeenCalledOnce(); expect(hostRelease).toHaveBeenCalledOnce();
  });
});
