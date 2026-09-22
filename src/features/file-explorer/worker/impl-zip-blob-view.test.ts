// @vitest-environment node
import { MessageChannel } from 'node:worker_threads';
import JSZip from 'jszip';
import * as Comlink from 'comlink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockFile, MockFileSystemDirectoryHandle, MockFileSystemFileHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import * as io from '@/utils/blob-view-io';
import { exposeWorkerRemote, releaseWorkerRemote, workerCapability, workerProxy, workerTransfer, wrapWorkerRemote } from '@/utils/worker-transport';
import type { WorkerBlobReadHost } from '@/utils/worker-blob-context';
import { BlobViewZipReadError } from '@/utils/blob-view-zip-source';
import { ZipUploadRecoveryError } from './zip-upload';
import { createFileExplorerWorker } from './impl';
import type { FileExplorerZipUploadPlacement, IFileExplorerWorker } from './types';

const nativeRead = io.readNativeBlobRange;
const nativeFileStream = MockFile.prototype.stream;
const nativeBlobStream = Blob.prototype.stream;
const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.spyOn(io, 'readNativeBlobRange').mockRejectedValue(new DOMException('Opaque Worker', 'NotReadableError'));
  for (const prototype of [Blob.prototype, MockFile.prototype]) {
    vi.spyOn(prototype, 'stream').mockImplementation(() => {
      throw new Error('ZIP must not bypass BlobView');
    });
  }
});
afterEach(async () => {
  try {
    for (const dispose of cleanup.splice(0)) await dispose();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

async function fixture() {
  const root = new MockFileSystemDirectoryHandle({ name: 'root' });
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
  const worker = createFileExplorerWorker();
  const released = vi.fn();
  const host = { read: vi.fn(async ({ blob, offset, length }: { blob: Blob, offset: number, length: number }) => {
    if (released.mock.calls.length > 0) throw new Error('Host released before ZIP cleanup');
    const bytes = await nativeRead({ blob, offset, length });
    return workerTransfer({ value: bytes, transferables: [bytes.buffer] });
  }) };
  Object.assign(host, { [Comlink.releaseProxy]: released });
  const { sessionId } = await worker.prepareSession({ request: { root: { kind: 'opfs-root', rootName: 'OPFS' } } }, undefined, host);
  cleanup.push(() => worker.disposeSession({ request: { sessionId } }));
  return { root, worker, sessionId, host, released };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function writeFile({ directory, name, bytes }: {
  directory: MockFileSystemDirectoryHandle,
  name: string,
  bytes: Uint8Array<ArrayBuffer>,
}) {
  const file = await directory.getFileHandle(name, { create: true });
  const writable = await file.createWritable();
  await writable.write(bytes);
  await writable.close();
  return file;
}
async function fileBytes({ file }: { file: MockFileSystemFileHandle }) {
  return new Uint8Array(await (await file.getFile()).arrayBuffer());
}
async function makeZip({ length }: { length: number }) {
  let seed = 137;
  const bytes = Uint8Array.from({ length }, () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return seed & 255;
  });
  const zip = new JSZip();
  zip.file('bundle/a.txt', 'new text');
  zip.file('bundle/sub/data.bin', bytes);
  zip.file('bundle/empty', new Uint8Array(0));
  return { blob: new Blob([Uint8Array.from(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })).buffer]), bytes };
}
async function prepareZip({ runtime, blob, placement, analysisId }: {
  runtime: Fixture, blob: Blob, placement: FileExplorerZipUploadPlacement, analysisId: string,
}) {
  const { worker, sessionId } = runtime;
  expect(await worker.analyzeZipUpload({ request: { sessionId, analysisId, blob, fileName: 'upload.zip', targetDirectoryPath: '/' } }))
    .toMatchObject({ status: 'extractable' });
  await worker.readZipUploadPreviewDirectory({ request: { sessionId, analysisId, placement, relativePath: '' } });
}
async function warmContext({ runtime }: { runtime: Fixture }) {
  await writeFile({ directory: runtime.root, name: 'warm.txt', bytes: new TextEncoder().encode('warm') });
  await runtime.worker.readPreview({ request: { sessionId: runtime.sessionId, path: '/warm.txt', mode: 'bounded' } });
}

const strip: FileExplorerZipUploadPlacement = { kind: 'extract', rootHandling: 'strip' };
const keep: FileExplorerZipUploadPlacement = { kind: 'keep_archive' };

describe('ZIP operations using session BlobViews', () => {
  it('parses, extracts and commits binary files and backups through bounded host reads', async () => {
    const runtime = await fixture();
    const { blob, bytes } = await makeZip({ length: io.BLOB_VIEW_CHUNK_SIZE * 2 + 17 });
    await writeFile({ directory: runtime.root, name: 'a.txt', bytes: new TextEncoder().encode('old text') });
    await prepareZip({ runtime, blob, placement: strip, analysisId: 'large' });
    expect(await runtime.worker.executeZipUpload({ request: { sessionId: runtime.sessionId, analysisId: 'large', jobId: 'extract', placement: strip } }))
      .toEqual({ status: 'completed' });
    const stored = await fileBytes({ file: await (await runtime.root.getDirectoryHandle('sub')).getFileHandle('data.bin') });
    expect(stored.byteLength).toBe(bytes.byteLength);
    expect(stored.every((value, index) => value === bytes[index])).toBe(true);
    expect(new TextDecoder().decode(await fileBytes({ file: await runtime.root.getFileHandle('a.txt') }))).toBe('new text');
    expect(await fileBytes({ file: await runtime.root.getFileHandle('empty') })).toHaveLength(0);
    expect(runtime.host.read.mock.calls.every(([request]) => request.length <= io.BLOB_VIEW_CHUNK_SIZE)).toBe(true);
    expect(io.readNativeBlobRange).toHaveBeenCalledOnce();
    await expect(runtime.root.getDirectoryHandle('.__naidan_zip_upload_extract')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('keeps an uploaded archive byte-for-byte without native Blob.stream', async () => {
    const runtime = await fixture();
    const { blob } = await makeZip({ length: 25 });
    await prepareZip({ runtime, blob, placement: keep, analysisId: 'keep' });
    expect(await runtime.worker.executeZipUpload({ request: { sessionId: runtime.sessionId, analysisId: 'keep', jobId: 'keep', placement: keep } }))
      .toEqual({ status: 'completed' });
    expect(await fileBytes({ file: await runtime.root.getFileHandle('upload.zip') })).toEqual(new Uint8Array(await blob.arrayBuffer()));
  });

  it('archives native files, applies exclusions and returns the ZIP without consuming it again', async () => {
    const runtime = await fixture();
    const bytes = new Uint8Array([255, 0, 195, 40, 128]);
    await writeFile({ directory: runtime.root, name: 'data.bin', bytes });
    await writeFile({ directory: runtime.root, name: 'excluded.txt', bytes: new Uint8Array([7]) });
    const result = await runtime.worker.createDirectoryArchive({ request: {
      sessionId: runtime.sessionId, jobId: 'download', directoryPath: '/', excludedRelativePaths: ['excluded.txt'],
    } });
    if (result.status !== 'completed') throw new Error('Expected archive');
    const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
    expect(await archive.file('OPFS/data.bin')?.async('uint8array')).toEqual(bytes);
    expect(archive.file('OPFS/excluded.txt')).toBeNull();
    expect(io.readNativeBlobRange).toHaveBeenCalledOnce();
  });

  it('returns invalid/unsupported for malformed bytes but propagates a byte-source failure', async () => {
    const runtime = await fixture();
    const request = { sessionId: runtime.sessionId, analysisId: 'invalid', fileName: 'bad.zip', targetDirectoryPath: '/', blob: new Blob([new Uint8Array(300)]) };
    expect(await runtime.worker.analyzeZipUpload({ request })).toMatchObject({ status: 'not_extractable' });
    runtime.host.read.mockRejectedValue(new DOMException('Lost file', 'NotReadableError'));
    await expect(runtime.worker.analyzeZipUpload({ request })).rejects.toBeInstanceOf(BlobViewZipReadError);
  });

  it('does not retry a failed ZIP copy as an unrelated operation or delete the target', async () => {
    const runtime = await fixture();
    const old = new TextEncoder().encode('original');
    const target = await writeFile({ directory: runtime.root, name: 'upload.zip', bytes: old });
    const { blob } = await makeZip({ length: 8 });
    await prepareZip({ runtime, blob, placement: keep, analysisId: 'failure' });
    const original = target.createWritable.bind(target);
    const error = new Error('Disk full');
    vi.spyOn(target, 'createWritable').mockImplementationOnce(async options => {
      const writable = await original(options);
      vi.spyOn(writable, 'write').mockRejectedValueOnce(error);
      return writable;
    });
    await expect(runtime.worker.executeZipUpload({ request: { sessionId: runtime.sessionId, analysisId: 'failure', jobId: 'failure', placement: keep } })).rejects.toBe(error);
    expect(await fileBytes({ file: target })).toEqual(old);
    await expect(runtime.root.getDirectoryHandle('.__naidan_zip_upload_failure')).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(runtime.released).not.toHaveBeenCalled();
    // Restoration can change lastModified. Refresh the preview instead of weakening its fingerprint check.
    await runtime.worker.readZipUploadPreviewDirectory({ request: { sessionId: runtime.sessionId, analysisId: 'failure', placement: keep, relativePath: '' } });
    // A failed job does not invalidate unrelated views or the owning session.
    expect(await runtime.worker.executeZipUpload({ request: { sessionId: runtime.sessionId, analysisId: 'failure', jobId: 'retry', placement: keep } })).toEqual({ status: 'completed' });
  });

  it('restores a committed overwrite on cancellation while leaving the session usable', async () => {
    const runtime = await fixture();
    const old = new TextEncoder().encode('previous archive');
    const target = await writeFile({ directory: runtime.root, name: 'upload.zip', bytes: old });
    const { blob } = await makeZip({ length: 8 });
    await prepareZip({ runtime, blob, placement: keep, analysisId: 'cancel' });
    const original = target.createWritable.bind(target);
    vi.spyOn(target, 'createWritable').mockImplementationOnce(async options => {
      const writable = await original(options);
      const close = writable.close.bind(writable);
      vi.spyOn(writable, 'close').mockImplementationOnce(async () => {
        await close();
        await runtime.worker.cancelZipUpload({ request: { sessionId: runtime.sessionId, jobId: 'cancel' } });
      });
      return writable;
    });
    expect(await runtime.worker.executeZipUpload({ request: { sessionId: runtime.sessionId, analysisId: 'cancel', jobId: 'cancel', placement: keep } })).toEqual({ status: 'cancelled' });
    expect(await fileBytes({ file: target })).toEqual(old);
    expect(runtime.released).not.toHaveBeenCalled();
  });

  it('drains rollback before either concurrent session disposal releases the host', async () => {
    const runtime = await fixture();
    const old = new TextEncoder().encode('restore me');
    const target = await writeFile({ directory: runtime.root, name: 'upload.zip', bytes: old });
    const { blob } = await makeZip({ length: 8 });
    await prepareZip({ runtime, blob, placement: keep, analysisId: 'dispose' });
    const original = target.createWritable.bind(target);
    const closing = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    vi.spyOn(target, 'createWritable').mockImplementationOnce(async options => {
      const writable = await original(options);
      const close = writable.close.bind(writable);
      vi.spyOn(writable, 'close').mockImplementationOnce(async () => {
        await close(); closing.resolve(); await resume.promise;
      });
      return writable;
    });
    const running = runtime.worker.executeZipUpload({ request: { sessionId: runtime.sessionId, analysisId: 'dispose', jobId: 'dispose', placement: keep } });
    await closing.promise;
    const reads = runtime.host.read.mock.calls.length;
    let finished = 0;
    const first = runtime.worker.disposeSession({ request: { sessionId: runtime.sessionId } }).then(() => {
      finished += 1;
    });
    const second = runtime.worker.disposeSession({ request: { sessionId: runtime.sessionId } }).then(() => {
      finished += 1;
    });
    try {
      await Promise.resolve();
      expect(finished).toBe(0);
      expect(runtime.released).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
    }
    expect(await running).toEqual({ status: 'cancelled' });
    await Promise.all([first, second]);
    expect(finished).toBe(2);
    expect(runtime.released).toHaveBeenCalledOnce();
    expect(runtime.host.read.mock.calls.length).toBeGreaterThan(reads);
    expect(await fileBytes({ file: target })).toEqual(old);
    await expect(runtime.root.getDirectoryHandle('.__naidan_zip_upload_dispose')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('cancels a preview immediately even while the shared context is kept for ZIP rollback', async () => {
    const runtime = await fixture();
    await warmContext({ runtime });
    const target = await writeFile({ directory: runtime.root, name: 'upload.zip', bytes: new TextEncoder().encode('old') });
    const { blob } = await makeZip({ length: 5 });
    await prepareZip({ runtime, blob, placement: keep, analysisId: 'preview' });
    const original = target.createWritable.bind(target);
    const closing = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    vi.spyOn(target, 'createWritable').mockImplementationOnce(async options => {
      const writable = await original(options);
      const close = writable.close.bind(writable);
      vi.spyOn(writable, 'close').mockImplementationOnce(async () => {
        await close();
        closing.resolve();
        await resume.promise;
      });
      return writable;
    });
    const running = runtime.worker.executeZipUpload({ request: { sessionId: runtime.sessionId, analysisId: 'preview', jobId: 'preview', placement: keep } });
    await closing.promise;
    const late = Promise.withResolvers<Awaited<ReturnType<WorkerBlobReadHost['read']>>>();
    runtime.host.read.mockReturnValueOnce(late.promise);
    const count = runtime.host.read.mock.calls.length;
    const preview = runtime.worker.readPreview({ request: { sessionId: runtime.sessionId, path: '/warm.txt', mode: 'force' } });
    const rejected = expect(preview).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(runtime.host.read).toHaveBeenCalledTimes(count + 1));
    const disposing = runtime.worker.disposeSession({ request: { sessionId: runtime.sessionId } });
    try {
      await rejected;
      expect(runtime.released).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
      late.reject(new Error('Late preview result'));
    }
    expect(await running).toEqual({ status: 'cancelled' });
    await disposing;
    expect(runtime.released).toHaveBeenCalledOnce();
  });

  it('does not hide failed restoration as cancelled and keeps the remaining backup', async () => {
    const runtime = await fixture();
    const old = new TextEncoder().encode('recoverable original');
    const target = await writeFile({ directory: runtime.root, name: 'upload.zip', bytes: old });
    const { blob } = await makeZip({ length: 8 });
    await prepareZip({ runtime, blob, placement: keep, analysisId: 'restore-fail' });
    const original = target.createWritable.bind(target);
    vi.spyOn(target, 'createWritable').mockImplementationOnce(async options => {
      const writable = await original(options);
      const close = writable.close.bind(writable);
      vi.spyOn(writable, 'close').mockImplementationOnce(async () => {
        await close();
        await runtime.worker.cancelZipUpload({ request: { sessionId: runtime.sessionId, jobId: 'restore-fail' } });
      });
      return writable;
    }).mockRejectedValueOnce(new Error('Restoration denied'));
    await expect(runtime.worker.executeZipUpload({ request: { sessionId: runtime.sessionId, analysisId: 'restore-fail', jobId: 'restore-fail', placement: keep } })).rejects.toBeInstanceOf(ZipUploadRecoveryError);
    const backup = await (await runtime.root.getDirectoryHandle('.__naidan_zip_upload_restore-fail')).getDirectoryHandle('backup');
    expect(await fileBytes({ file: await backup.getFileHandle('upload.zip') })).toEqual(old);
  });

  it.each(['replace', 'dispose'] as const)('does not publish late analysis bytes after %s', async action => {
    const runtime = await fixture();
    await warmContext({ runtime });
    const { blob } = await makeZip({ length: 8 });
    const late = Promise.withResolvers<Awaited<ReturnType<WorkerBlobReadHost['read']>>>();
    const before = runtime.host.read.mock.calls.length;
    runtime.host.read.mockReturnValueOnce(late.promise);
    const request = { sessionId: runtime.sessionId, analysisId: 'same', fileName: 'upload.zip', targetDirectoryPath: '/', blob };
    const first = runtime.worker.analyzeZipUpload({ request });
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(runtime.host.read).toHaveBeenCalledTimes(before + 1));
    switch (action) {
    case 'replace':
      expect(await runtime.worker.analyzeZipUpload({ request })).toMatchObject({ status: 'extractable' });
      break;
    case 'dispose':
      await runtime.worker.disposeZipUploadAnalysis({ request: { sessionId: runtime.sessionId, analysisId: 'same' } });
      break;
    default: {
      const _ex: never = action;
      throw new Error(`Unhandled action: ${String(_ex)}`);
    }
    }
    await rejected;
    late.reject(new Error('Late physical read failure'));
    const preview = runtime.worker.readZipUploadPreviewDirectory({ request: { sessionId: runtime.sessionId, analysisId: 'same', placement: keep, relativePath: '' } });
    switch (action) {
    case 'replace':
      expect(await preview).toMatchObject({ relativePath: '' });
      break;
    case 'dispose':
      await expect(preview).rejects.toThrow('Unknown ZIP upload analysis');
      break;
    default: {
      const _ex: never = action;
      throw new Error(`Unhandled action: ${String(_ex)}`);
    }
    }
  });

  it.each(['keep', 'extract', 'archive', 'analysis'] as const)('cancels stalled %s IO without consuming late bytes', async operation => {
    const runtime = await fixture();
    await warmContext({ runtime });
    const { blob } = await makeZip({ length: 8 });
    const placement = operation === 'keep' ? keep : strip;
    await prepareZip({ runtime, blob, placement, analysisId: 'stalled' });
    const late = Promise.withResolvers<Awaited<ReturnType<WorkerBlobReadHost['read']>>>();
    const before = runtime.host.read.mock.calls.length;
    runtime.host.read.mockReturnValueOnce(late.promise);
    const running = (() => {
      switch (operation) {
      case 'keep':
      case 'extract':
        return runtime.worker.executeZipUpload({ request: { sessionId: runtime.sessionId, analysisId: 'stalled', jobId: 'stalled', placement } });
      case 'archive':
        return runtime.worker.createDirectoryArchive({ request: { sessionId: runtime.sessionId, directoryPath: '/', jobId: 'stalled', excludedRelativePaths: [] } });
      case 'analysis':
        return runtime.worker.analyzeZipUpload({ request: { sessionId: runtime.sessionId, targetDirectoryPath: '/', analysisId: 'other', fileName: 'upload.zip', blob } });
      default: {
        const _ex: never = operation;
        throw new Error(`Unhandled operation: ${String(_ex)}`);
      }
      }
    })();
    // Attach rejection handling before cancelling.
    const result = running.then(value => ({ value }), error => ({ error }));
    await vi.waitFor(() => expect(runtime.host.read).toHaveBeenCalledTimes(before + 1));
    await runtime.worker.disposeSession({ request: { sessionId: runtime.sessionId } });
    switch (operation) {
    case 'analysis':
      expect(await result).toMatchObject({ error: { name: 'AbortError' } });
      break;
    case 'keep':
    case 'extract':
    case 'archive':
      expect(await result).toEqual({ value: { status: 'cancelled' } });
      break;
    default: {
      const _ex: never = operation;
      throw new Error(`Unhandled operation: ${String(_ex)}`);
    }
    }
    expect(runtime.released).toHaveBeenCalledOnce();
    late.reject(new Error('Late host failure'));
    await expect(runtime.root.getDirectoryHandle('.__naidan_zip_upload_stalled')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('keeps using the direct read path when the actual Worker probe succeeds', async () => {
    vi.mocked(io.readNativeBlobRange).mockImplementation(nativeRead);
    // A healthy realm delegates to native streams; the other cases keep those
    // methods forbidden to detect any bypass of the host fallback.
    vi.mocked(MockFile.prototype.stream).mockImplementation(nativeFileStream);
    vi.mocked(Blob.prototype.stream).mockImplementation(nativeBlobStream);
    const runtime = await fixture();
    const { blob } = await makeZip({ length: 23 });
    await prepareZip({ runtime, blob, placement: strip, analysisId: 'direct' });
    expect(await runtime.worker.executeZipUpload({ request: { sessionId: runtime.sessionId, analysisId: 'direct', jobId: 'direct', placement: strip } })).toEqual({ status: 'completed' });
    expect(runtime.host.read).not.toHaveBeenCalled();
    expect(MockFile.prototype.stream).toHaveBeenCalled();
    expect(io.readNativeBlobRange).toHaveBeenCalledOnce();
  });

  it('does not classify a read-only target as an invalid archive', async () => {
    const runtime = await fixture();
    const { sessionId } = await runtime.worker.prepareSession({ request: { root: {
      kind: 'native-directory', rootName: 'Read only', handle: runtime.root as FileSystemDirectoryHandle, readOnly: true,
    } } });
    cleanup.push(() => runtime.worker.disposeSession({ request: { sessionId } }));
    const { blob } = await makeZip({ length: 5 });
    await expect(runtime.worker.analyzeZipUpload({ request: { sessionId, analysisId: 'read-only', targetDirectoryPath: '/', fileName: 'upload.zip', blob } })).rejects.toThrow();
    expect(runtime.host.read).not.toHaveBeenCalled();
    expect(io.readNativeBlobRange).not.toHaveBeenCalled();
  });

  it('reports cleanup failure even when cancellation also arrives, rather than claiming cancellation succeeded', async () => {
    const runtime = await fixture();
    const old = new TextEncoder().encode('before');
    const target = await writeFile({ directory: runtime.root, name: 'upload.zip', bytes: old });
    const { blob } = await makeZip({ length: 7 });
    await prepareZip({ runtime, blob, placement: keep, analysisId: 'cleanup' });
    const remove = runtime.root.removeEntry.bind(runtime.root);
    vi.spyOn(runtime.root, 'removeEntry').mockImplementation(async (name, options) => {
      if (name === '.__naidan_zip_upload_cleanup') {
        await runtime.worker.cancelZipUpload({ request: { sessionId: runtime.sessionId, jobId: 'cleanup' } });
        throw new Error('Temporary directory cleanup denied');
      }
      return remove(name, options);
    });
    await expect(runtime.worker.executeZipUpload({ request: { sessionId: runtime.sessionId, analysisId: 'cleanup', jobId: 'cleanup', placement: keep } })).rejects.toBeInstanceOf(ZipUploadRecoveryError);
    expect(await fileBytes({ file: target })).toEqual(old);
    expect(await runtime.root.getDirectoryHandle('.__naidan_zip_upload_cleanup')).toBeDefined();
  });

  it('does not attempt rollback after successful commit cleanup has already removed the backup', async () => {
    const runtime = await fixture();
    const { blob } = await makeZip({ length: 7 });
    await prepareZip({ runtime, blob, placement: keep, analysisId: 'committed' });
    const remove = runtime.root.removeEntry.bind(runtime.root);
    vi.spyOn(runtime.root, 'removeEntry').mockImplementation(async (name, options) => {
      await remove(name, options);
      if (name === '.__naidan_zip_upload_committed') {
        await runtime.worker.cancelZipUpload({ request: { sessionId: runtime.sessionId, jobId: 'committed' } });
      }
    });
    expect(await runtime.worker.executeZipUpload({ request: { sessionId: runtime.sessionId, analysisId: 'committed', jobId: 'committed', placement: keep } })).toEqual({ status: 'completed' });
    expect(await fileBytes({ file: await runtime.root.getFileHandle('upload.zip') })).toEqual(new Uint8Array(await blob.arrayBuffer()));
  });

  it('uses real Comlink Blob clone and reverse byte transfer for ZIP upload, copies and archive download', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
    // Real File objects at the transport boundary; the backing store is still a mock.
    const getFile = MockFileSystemFileHandle.prototype.getFile;
    vi.spyOn(MockFileSystemFileHandle.prototype, 'getFile').mockImplementation(async function (this: MockFileSystemFileHandle) {
      const file = await getFile.call(this);
      return new File([await file.arrayBuffer()], file.name, { type: file.type, lastModified: file.lastModified }) as unknown as MockFile;
    });
    const worker = createFileExplorerWorker();
    const channel = new MessageChannel();
    exposeWorkerRemote<IFileExplorerWorker>({ api: worker, endpoint: channel.port1 as unknown as MessagePort });
    const remote = wrapWorkerRemote<IFileExplorerWorker>({ endpoint: channel.port2 as unknown as MessagePort });
    const sent: ArrayBuffer[] = [];
    const finalized = vi.fn();
    const host: WorkerBlobReadHost = {
      async read({ blob, offset, length }) {
        const bytes = await nativeRead({ blob, offset, length });
        sent.push(bytes.buffer);
        return workerTransfer({ value: bytes, transferables: [bytes.buffer] });
      },
    };
    Object.assign(host, { [Comlink.finalizer]: finalized });
    let sessionId: string | undefined;
    try {
      ({ sessionId } = await remote.prepareSession(workerCapability({ value: { request: { root: { kind: 'opfs-root', rootName: 'OPFS' } } }, capability: 'file-system-handle-clone' }), undefined, workerProxy({ value: host })));
      const { blob, bytes } = await makeZip({ length: 79 });
      expect(await remote.analyzeZipUpload({ request: { sessionId, analysisId: 'wire', targetDirectoryPath: '/', fileName: 'upload.zip', blob } })).toMatchObject({ status: 'extractable' });
      await remote.readZipUploadPreviewDirectory({ request: { sessionId, analysisId: 'wire', placement: strip, relativePath: '' } });
      expect(await remote.executeZipUpload({ request: { sessionId, analysisId: 'wire', jobId: 'wire', placement: strip } })).toEqual({ status: 'completed' });
      const result = await remote.createDirectoryArchive({ request: { sessionId, jobId: 'download', directoryPath: '/', excludedRelativePaths: [] } });
      if (result.status !== 'completed') throw new Error('Expected ZIP');
      const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
      expect(await zip.file('OPFS/sub/data.bin')?.async('uint8array')).toEqual(bytes);
      expect(sent.length).toBeGreaterThan(3);
      expect(sent.every(buffer => buffer.byteLength === 0)).toBe(true);
      await remote.disposeSession({ request: { sessionId } });
      await vi.waitFor(() => expect(finalized).toHaveBeenCalledOnce());
    } finally {
      if (sessionId !== undefined) await worker.disposeSession({ request: { sessionId } });
      releaseWorkerRemote({ remote });
      channel.port1.close(); channel.port2.close();
    }
  });
});
