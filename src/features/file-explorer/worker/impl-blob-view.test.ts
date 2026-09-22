// @vitest-environment node
import * as Comlink from 'comlink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { TEXT_PREVIEW_SIZE_LIMIT } from '@/features/file-explorer/logic/constants';
import * as io from '@/utils/blob-view-io';
import { workerTransfer } from '@/utils/worker-transport';
import { createFileExplorerWorker } from './impl';

const nativeRead = io.readNativeBlobRange;
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function fixture() {
  const root = new MockFileSystemDirectoryHandle({ name: 'root' });
  const contents = '{"title":"日本😀"}';
  const handle = await root.getFileHandle('chat.json', { create: true });
  const writable = await handle.createWritable();
  await writable.write(contents);
  await writable.close();
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
  const host = { read: vi.fn(async ({ blob, offset, length }: { blob: Blob, offset: number, length: number }) => {
    const bytes = await nativeRead({ blob, offset, length });
    return workerTransfer({ value: bytes, transferables: [bytes.buffer] });
  }) };
  const released = vi.fn();
  Object.assign(host, { [Comlink.releaseProxy]: released });
  const worker = createFileExplorerWorker();
  const { sessionId } = await worker.prepareSession({ request: { root: { kind: 'opfs-root', rootName: 'OPFS root' } } }, undefined, host);
  cleanup.push(() => worker.disposeSession({ request: { sessionId } }));
  return { root, worker, sessionId, host, released, contents };
}

describe('File Explorer native preview with BlobView', () => {
  it('lists OPFS metadata without probing and displays JSON through the fallback context', async () => {
    const direct = vi.spyOn(io, 'readNativeBlobRange').mockRejectedValue(new DOMException('Opaque Worker', 'NotReadableError'));
    const { worker, sessionId, host, contents } = await fixture();
    const listing = await worker.readDirectory({ request: { sessionId, path: '/' } });
    expect(listing.entries[0]?.size).toBe(new TextEncoder().encode(contents).length);
    expect(direct).not.toHaveBeenCalled();
    expect(host.read).not.toHaveBeenCalled();
    expect(await worker.readPreview({ request: { sessionId, path: '/chat.json', mode: 'bounded' } })).toMatchObject({
      kind: 'text', rawText: contents, displayText: JSON.stringify(JSON.parse(contents), null, 2), oversized: false,
    });
    expect(direct).toHaveBeenCalledOnce();
    expect(host.read).toHaveBeenCalledTimes(2);
    await worker.readPreview({ request: { sessionId, path: '/chat.json', mode: 'force' } });
    expect(direct).toHaveBeenCalledOnce();
    expect(host.read).toHaveBeenCalledTimes(3);
  });

  it('does not consume file bytes just to return a native download or an oversized preview', async () => {
    const direct = vi.spyOn(io, 'readNativeBlobRange').mockRejectedValue(new Error('Must not consume Blob'));
    const { root, worker, sessionId, host, contents } = await fixture();
    expect((await worker.readFile({ request: { sessionId, path: '/chat.json' } })).blob.size).toBe(new TextEncoder().encode(contents).length);
    const handle = await root.getFileHandle('large.txt', { create: true });
    const writable = await handle.createWritable();
    await writable.write('x'.repeat(TEXT_PREVIEW_SIZE_LIMIT + 1));
    await writable.close();
    expect(await worker.readPreview({ request: { sessionId, path: '/large.txt', mode: 'bounded' } })).toMatchObject({ kind: 'text', oversized: true, rawText: '' });
    expect(host.read).not.toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
  });

  it('returns the original native media Blob and type without consuming its bytes', async () => {
    const { root, worker, sessionId, host } = await fixture();
    const file = await root.getFileHandle('image.png', { create: true });
    const snapshot = new File([new Uint8Array([0, 255, 128])], 'image.png', { type: 'image/png' });
    vi.spyOn(file as unknown as FileSystemFileHandle, 'getFile').mockResolvedValue(snapshot);
    const response = await worker.readPreview({ request: { sessionId, path: '/image.png', mode: 'bounded' } });
    if (response.kind !== 'media') throw new Error('Expected media preview');
    expect(response.mimeType).toBe('image/png');
    expect(response.blob).toBe(snapshot);
    expect(host.read).not.toHaveBeenCalled();
  });

  it('does not obtain a native binary snapshot just to show a placeholder', async () => {
    const { root, worker, sessionId, host } = await fixture();
    const file = await root.getFileHandle('payload.bin', { create: true });
    const snapshot = vi.spyOn(file, 'getFile').mockRejectedValue(new Error('Must not get the payload'));
    expect(await worker.readPreview({ request: { sessionId, path: '/payload.bin', mode: 'bounded' } })).toEqual({ kind: 'binary', oversized: false });
    expect(snapshot).not.toHaveBeenCalled();
    expect(host.read).not.toHaveBeenCalled();
  });

  it.each(['readPreview', 'readFile'] as const)('rejects a late native snapshot from %s after disposal', async operation => {
    const { root, worker, sessionId, host } = await fixture();
    const file = await root.getFileHandle('image.png', { create: true });
    const pending = Promise.withResolvers<File>();
    const snapshot = vi.spyOn(file as unknown as FileSystemFileHandle, 'getFile').mockReturnValue(pending.promise);
    const request = worker[operation]({ request: { sessionId, path: '/image.png', mode: 'bounded' } });
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledOnce());
    await worker.disposeSession({ request: { sessionId } });
    pending.resolve(new File([new Uint8Array([1])], 'image.png', { type: 'image/png' }));
    await rejected;
    expect(host.read).not.toHaveBeenCalled();
  });

  it('fails instead of returning empty JSON when both reading paths fail', async () => {
    vi.spyOn(io, 'readNativeBlobRange').mockRejectedValue(new DOMException('Worker failed', 'NotReadableError'));
    const { worker, sessionId, host } = await fixture();
    host.read.mockRejectedValue(new Error('Host failed'));
    await expect(worker.readPreview({ request: { sessionId, path: '/chat.json', mode: 'bounded' } })).rejects.toThrow('both Worker and host');
  });

  it('aborts a pending preview and releases the shared reverse proxy only once', async () => {
    const direct = vi.spyOn(io, 'readNativeBlobRange').mockReturnValue(new Promise(() => {}));
    const { worker, sessionId, released, host } = await fixture();
    const preview = worker.readPreview({ request: { sessionId, path: '/chat.json', mode: 'bounded' } });
    const rejected = expect(preview).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(direct).toHaveBeenCalledOnce());
    await worker.disposeSession({ request: { sessionId } });
    await rejected;
    await worker.disposeSession({ request: { sessionId } });
    expect(released).toHaveBeenCalledOnce();
    expect(host.read).not.toHaveBeenCalled();
  });

  it('releases a host even when root preparation fails before a session is registered', async () => {
    const released = vi.fn();
    const host = Object.assign({ read: vi.fn() }, { [Comlink.releaseProxy]: released });
    const worker = createFileExplorerWorker();
    await expect(worker.prepareSession({ request: { root: { kind: 'opfs-root', rootName: '' } } }, undefined, host)).rejects.toThrow();
    expect(released).toHaveBeenCalledOnce();
  });
});
