// @vitest-environment node
import * as Comlink from 'comlink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockFileSystemFileHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { BLOB_VIEW_CHUNK_SIZE } from '@/utils/blob-view-io';
import { createModelBlobFixture, ggufFile } from '@/features/llama-cpp-browser/test-utils/model-blob-view';
import { DownloadJournalReadError, listPendingDownloads, writeJournal } from '@/features/llama-cpp-browser/hugging-face/storage';
import { pendingName, type DownloadSelection } from '@/features/llama-cpp-browser/hugging-face/types';
import { importModelDirectory, ModelBlobReadError } from './model-directory';
import { importStoredModel, listStoredModels, planStoredModelRemoval, removeStoredModel, storedModelDirectory } from './model-store';

let fixture: ReturnType<typeof createModelBlobFixture>;
beforeEach(() => {
  fixture = createModelBlobFixture({ releaseProxy: Comlink.releaseProxy });
});
afterEach(() => {
  fixture.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const progress = () => {};
const directoryName = 'model-GGUF';

describe('model directory import with BlobView', () => {
  it('imports split weights, a projector and sidecars using bounded host reads, then resolves only GGUFs', async () => {
    const { blobs, read } = fixture.context();
    const files = ['base-00001-of-00002.gguf', 'base-00002-of-00002.gguf', 'nested/mmproj.gguf'].map(path => ({ path, file: ggufFile({ name: path.split('/').at(-1)!, size: BLOB_VIEW_CHUNK_SIZE + 9 }) }));
    const sidecar = new File(['{"key":"日本語"}'], 'config.json');
    const expected = await fixture.bytes({ blob: files[0]!.file });
    fixture.blockWorkerReads();
    const events = vi.fn();
    const model = await importModelDirectory({ directory: { name: directoryName, files: [...files, { path: 'config.json', file: sidecar }] }, blobs, signal: undefined, onProgress: events });
    expect(model.id).toBe(`user/${directoryName}`);
    const resolved = await storedModelDirectory({ name: model.id, blobs });
    expect(resolved.files).toHaveLength(3);
    expect(resolved.projectorPath).toBe('nested/mmproj.gguf');
    expect(await fixture.bytes({ blob: resolved.files[0]!.file })).toEqual(expected);
    expect((await listStoredModels({ blobs })).map(item => item.id)).toEqual([model.id]);
    expect(read.mock.calls.every(([request]) => request.length <= BLOB_VIEW_CHUNK_SIZE)).toBe(true);
    expect(events.mock.calls.at(-1)?.[0].progress).toMatchObject({ phase: 'importing', completed: files.reduce((sum, entry) => sum + entry.file.size, sidecar.size) });
    const folder = await fixture.directory({ path: `models/user/${directoryName}` });
    await expect(folder.getFileHandle(pendingName)).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('keeps the directory hidden until committed destination headers have been checked', async () => {
    const { blobs, read } = fixture.context();
    const file = ggufFile({ name: 'model.gguf', size: 128 });
    const pending = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    const original = read.getMockImplementation()!;
    let headers = 0;
    read.mockImplementation(async request => {
      // BlobView slices are Blobs, not Files. The second header belongs to the committed destination.
      if (request.length === 8 && ++headers === 2) {
        reached.resolve(); await pending.promise;
      }
      return original(request);
    });
    fixture.blockWorkerReads();
    const importing = importStoredModel({ signal: undefined, file, blobs, onProgress: progress });
    await reached.promise;
    expect(await listStoredModels({ blobs })).toEqual([]);
    const folder = await fixture.directory({ path: `models/user/${directoryName}` });
    expect(await folder.getFileHandle(pendingName)).toBeDefined();
    pending.resolve();
    expect((await importing).id).toBe(`user/${directoryName}`);
    expect(await listStoredModels({ blobs })).toHaveLength(1);
  });

  it('rejects unreadable input headers before creating any model directory', async () => {
    const { blobs, read } = fixture.context();
    const original = read.getMockImplementation()!;
    read.mockImplementation(request => request.length === 8 ? Promise.reject(new Error('Header failed')) : original(request));
    fixture.blockWorkerReads();
    await expect(importStoredModel({ signal: undefined, file: ggufFile({ name: 'model.gguf', size: 128 }), blobs, onProgress: progress })).rejects.toBeInstanceOf(ModelBlobReadError);
    expect(await fixture.names({ folder: fixture.root })).toEqual([]);
  });

  it('fails an unreadable destination header without publishing or retaining a complete-looking directory', async () => {
    const { blobs, read } = fixture.context();
    const file = ggufFile({ name: 'model.gguf', size: 128 });
    const original = read.getMockImplementation()!;
    let headers = 0;
    read.mockImplementation(request => request.length === 8 && ++headers === 2 ? Promise.reject(new Error('Destination failed')) : original(request));
    fixture.blockWorkerReads();
    await expect(importStoredModel({ signal: undefined, file, blobs, onProgress: progress })).rejects.toBeInstanceOf(ModelBlobReadError);
    expect(await fixture.names({ folder: await fixture.directory({ path: 'models/user' }) })).toEqual([]);
  });

  it('cancels a stalled body read, aborts the writer, removes the partial directory and keeps the context usable', async () => {
    const { blobs, read } = fixture.context();
    const original = read.getMockImplementation()!;
    const late = Promise.withResolvers<Awaited<ReturnType<typeof read>>>();
    const waiting = Promise.withResolvers<void>();
    read.mockImplementation(request => {
      if (request.length > 8) {
        waiting.resolve(); return late.promise;
      }
      return original(request);
    });
    fixture.blockWorkerReads();
    const signal = new AbortController();
    const importing = importStoredModel({ file: ggufFile({ name: 'model.gguf', size: 128 }), blobs, signal: signal.signal, onProgress: progress });
    const rejected = expect(importing).rejects.toThrow();
    await waiting.promise;
    signal.abort(new DOMException('Cancelled', 'AbortError'));
    await rejected;
    expect(await fixture.names({ folder: await fixture.directory({ path: 'models/user' }) })).toEqual([]);
    late.reject(new Error('Late read failure'));
    read.mockImplementation(original);
    expect((await importStoredModel({ signal: undefined, file: ggufFile({ name: 'retry.gguf', size: 128 }), blobs, onProgress: progress })).id).toBe('user/retry-GGUF');
  });

  it('closes a late writer through abort without writing when open finishes after cancellation', async () => {
    const { blobs } = fixture.context();
    fixture.blockWorkerReads();
    const pending = Promise.withResolvers<void>(); const opening = Promise.withResolvers<void>();
    const original = MockFileSystemFileHandle.prototype.createWritable;
    let writer: Awaited<ReturnType<typeof original>> | undefined;
    vi.spyOn(MockFileSystemFileHandle.prototype, 'createWritable').mockImplementation(async function (this: MockFileSystemFileHandle, options) {
      const result = await original.call(this, options);
      if (this.name === 'model.gguf') {
        writer = result; vi.spyOn(writer, 'write'); vi.spyOn(writer, 'close'); vi.spyOn(writer, 'abort');
        opening.resolve(); await pending.promise;
      }
      return result;
    });
    const abort = new AbortController();
    const importing = importStoredModel({ file: ggufFile({ name: 'model.gguf', size: 128 }), blobs, signal: abort.signal, onProgress: progress });
    const rejected = expect(importing).rejects.toThrow();
    await opening.promise; abort.abort(); pending.resolve(); await rejected;
    expect(writer!.write).not.toHaveBeenCalled(); expect(writer!.close).not.toHaveBeenCalled(); expect(writer!.abort).toHaveBeenCalledOnce();
  });

  it('reports failed cleanup and leaves the pending marker instead of claiming rollback', async () => {
    const { blobs, read } = fixture.context();
    const parent = await fixture.directory({ path: 'models/user' });
    const cleanupError = new Error('Cleanup denied');
    vi.spyOn(parent, 'removeEntry').mockRejectedValue(cleanupError);
    const original = read.getMockImplementation()!;
    read.mockImplementation(request => request.length > 8 ? Promise.reject(new Error('Input lost')) : original(request));
    fixture.blockWorkerReads();
    await expect(importStoredModel({ signal: undefined, file: ggufFile({ name: 'model.gguf', size: 128 }), blobs, onProgress: progress })).rejects.toMatchObject({ message: `Model import cleanup failed: user/${directoryName}`, errors: [expect.any(Error), cleanupError] });
    expect(await (await parent.getDirectoryHandle(directoryName)).getFileHandle(pendingName)).toBeDefined();
    expect(await listStoredModels({ blobs })).toEqual([]);
  });

  it('does not delete a model after its publication marker removal has succeeded', async () => {
    const { blobs } = fixture.context();
    const abort = new AbortController();
    const parent = await fixture.directory({ path: 'models/user' });
    const getDirectory = parent.getDirectoryHandle.bind(parent);
    vi.spyOn(parent, 'getDirectoryHandle').mockImplementation(async (name, options) => {
      const folder = await getDirectory(name, options);
      const remove = folder.removeEntry.bind(folder);
      vi.spyOn(folder, 'removeEntry').mockImplementation(async (name, options) => {
        await remove(name, options);
        if (name === pendingName) abort.abort();
      });
      return folder;
    });
    fixture.blockWorkerReads();
    const result = await importStoredModel({ file: ggufFile({ name: 'model.gguf', size: 128 }), blobs, signal: abort.signal, onProgress: progress });
    expect(result.id).toBe(`user/${directoryName}`);
    expect(await listStoredModels({ blobs })).toHaveLength(1);
  });
});

describe('model discovery, journals and deletion with BlobView', () => {
  it.each(['NotReadableError', 'NotFoundError', 'NotAllowedError'])('does not hide a getFile %s as an absent model', async name => {
    const file = await fixture.put({ path: 'models/user/model-GGUF/model.gguf', bytes: await fixture.bytes({ blob: ggufFile({ name: 'model.gguf', size: 128 }) }) });
    vi.spyOn(file, 'getFile').mockRejectedValue(new DOMException('Snapshot unavailable', name));
    const { blobs } = fixture.context();
    await expect(listStoredModels({ blobs })).rejects.toBeInstanceOf(ModelBlobReadError);
    await expect(storedModelDirectory({ name: 'user/model-GGUF', blobs })).rejects.toBeInstanceOf(ModelBlobReadError);
  });

  it('continues to omit structurally invalid GGUF files and incomplete imports', async () => {
    await fixture.put({ path: 'models/user/bad-GGUF/model.gguf', bytes: new Uint8Array(128) });
    await fixture.put({ path: 'models/user/pending-GGUF/model.gguf', bytes: new Uint8Array(128) });
    await fixture.put({ path: 'models/user/pending-GGUF/.llama-cpp-import-pending', bytes: '' });
    const { blobs } = fixture.context(); fixture.blockWorkerReads();
    expect(await listStoredModels({ blobs })).toEqual([]);
  });

  it('reads HF headers and pending journals, keeping unfinished files hidden and shared projectors intact', async () => {
    const prefix = 'models/huggingface.co/owner/repo/resolve/main';
    const modelBytes = await fixture.bytes({ blob: ggufFile({ name: 'base.gguf', size: 128 }) });
    await fixture.put({ path: `${prefix}/base.gguf`, bytes: modelBytes });
    await fixture.put({ path: `${prefix}/mmproj.gguf`, bytes: modelBytes });
    await fixture.put({ path: `${prefix}/unfinished.gguf`, bytes: modelBytes });
    const selection: DownloadSelection = { repository: 'owner/repo', revision: 'a'.repeat(40), files: [{ path: 'unfinished.gguf', size: 128 }, { path: 'mmproj.gguf', size: 128 }] };
    const folder = await fixture.directory({ path: prefix });
    await writeJournal({ folder: folder as unknown as FileSystemDirectoryHandle, journal: { version: 1, selection, bytes: [64, 128], complete: [false, true], reused: [false, true] } });
    const { blobs, read } = fixture.context(); fixture.blockWorkerReads();
    const models = await listStoredModels({ blobs });
    expect(models).toHaveLength(1); expect(models[0]!.id).toBe('hf.co/owner/repo:base.gguf');
    expect(await listPendingDownloads({ blobs })).toHaveLength(1);
    const resolved = await storedModelDirectory({ name: models[0]!.id, blobs });
    expect(resolved.files.map(file => file.path)).toEqual(['base.gguf', 'mmproj.gguf']);
    const plan = await planStoredModelRemoval({ id: 'hf.co/owner/repo', blobs });
    expect(plan.files.map(file => file.path).sort()).toEqual([pendingName, 'unfinished.gguf'].sort());
    expect(await removeStoredModel({ plan, blobs })).toBe('deleted');
    expect(await fixture.names({ folder })).toEqual(['base.gguf', 'mmproj.gguf']);
    expect(read).toHaveBeenCalled();
  });

  it('does not list or delete around a present but unreadable HF journal', async () => {
    const prefix = 'models/huggingface.co/owner/repo/resolve/main';
    const payload = await fixture.put({ path: `${prefix}/base.gguf`, bytes: await fixture.bytes({ blob: ggufFile({ name: 'base.gguf', size: 128 }) }) });
    const journal = await fixture.put({ path: `${prefix}/${pendingName}`, bytes: '{}' });
    vi.spyOn(journal, 'getFile').mockRejectedValue(new DOMException('Journal vanished', 'NotFoundError'));
    const { blobs } = fixture.context(); fixture.blockWorkerReads();
    await expect(listStoredModels({ blobs })).rejects.toBeInstanceOf(DownloadJournalReadError);
    await expect(removeStoredModel({ plan: { id: 'hf.co/owner/repo', files: [] }, blobs })).rejects.toBeInstanceOf(DownloadJournalReadError);
    expect(payload.content.byteLength).toBe(128);
  });

  it('uses only eight-byte reads for model discovery and does not call the host when native reading works', async () => {
    await fixture.put({ path: 'models/user/model-GGUF/model.gguf', bytes: await fixture.bytes({ blob: ggufFile({ name: 'model.gguf', size: BLOB_VIEW_CHUNK_SIZE + 1 }) }) });
    const { blobs, read } = fixture.context();
    expect(await listStoredModels({ blobs })).toHaveLength(1);
    expect(read).not.toHaveBeenCalled();
    fixture.blockWorkerReads();
    // A new context must probe in its own consumption realm.
    const fallback = fixture.context();
    expect(await listStoredModels({ blobs: fallback.blobs })).toHaveLength(1);
    expect(fallback.read.mock.calls.filter(([request]) => request.length !== 3).map(([request]) => request.length)).toEqual([8]);
  });  it.each(['list', 'resolve', 'plan', 'remove'] as const)('rejects an already cancelled %s before accessing the store', async operation => {
    const signal = AbortSignal.abort(new DOMException('Cancelled', 'AbortError'));
    const { blobs, read } = fixture.context(); fixture.blockWorkerReads();
    let result: Promise<unknown>;
    switch (operation) {
    case 'list': result = listStoredModels({ blobs, signal }); break;
    case 'resolve': result = storedModelDirectory({ name: `user/${directoryName}`, blobs, signal }); break;
    case 'plan': result = planStoredModelRemoval({ id: `user/${directoryName}`, blobs, signal }); break;
    case 'remove': result = removeStoredModel({ plan: { id: `user/${directoryName}`, files: [] }, blobs, signal }); break;
    default: { const exhaustive: never = operation; throw new Error(String(exhaustive)); }
    }
    await expect(result).rejects.toBe(signal.reason);
    expect(read).not.toHaveBeenCalled(); expect(await fixture.names({ folder: fixture.root })).toEqual([]);
  });

});
