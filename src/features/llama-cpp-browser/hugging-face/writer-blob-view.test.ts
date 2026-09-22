// @vitest-environment node
import { MessageChannel } from 'node:worker_threads';
import * as Comlink from 'comlink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as blobIO from '@/utils/blob-view-io';
import type { WorkerBlobReadHost } from '@/utils/worker-blob-context';
import { exposeWorkerRemote, releaseWorkerRemote, workerCapability, workerProxy, workerTransfer, wrapWorkerRemote } from '@/utils/worker-transport';
import { DownloadJournalReadError, repositoryFolder, selectedFile, writeJournal } from './storage';
import { pendingName, sharedProjectorConflictMessage, existingModelConflictMessage, type DownloadJournal, type DownloadSelection } from './types';
import { createDownloadWriter, type DownloadWriterApi } from './writer';
import { ggufBytes, memoryDirectory } from './test-opfs';
import { openSyncAccess, type DownloadAccess } from './sync-access';

// The memory filesystem implements the dedicated-Worker sync method. DOM's
// FileSystemFileHandle type intentionally does not include that Worker-only API.
type SyncFileFixture = FileSystemFileHandle & { createSyncAccessHandle(): Promise<DownloadAccess> };
const nativeSlice = Blob.prototype.slice;
const nativeBuffer = Blob.prototype.arrayBuffer;
async function hostRead({ blob, offset, length }: { blob: Blob, offset: number, length: number }): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await nativeBuffer.call(nativeSlice.call(blob, offset, offset + length)));
}
function createHost() {
  const released = vi.fn();
  const read = vi.fn(async (request: Parameters<WorkerBlobReadHost['read']>[0]) => {
    if (released.mock.calls.length) throw new Error('Host already released');
    const bytes = await hostRead(request);
    return workerTransfer({ value: bytes, transferables: [bytes.buffer] });
  });
  return { host: Object.assign({ read }, { [Comlink.releaseProxy]: released }), read, released };
}
const selection: DownloadSelection = { repository: 'owner/model', revision: 'a'.repeat(40), files: [{ path: 'model.gguf', size: 128 }] };
let root: ReturnType<typeof memoryDirectory>;
const writers: ReturnType<typeof createDownloadWriter>[] = [];
function writer() {
  const api = createDownloadWriter(); writers.push(api); return api;
}
async function rawBytes({ file }: { file: Blob }): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await nativeBuffer.call(file));
}
async function expectFileBytes({ file, expected }: { file: Blob, expected: Uint8Array }): Promise<void> {
  const actual = await rawBytes({ file });
  // Compare every byte, without a generic deep-object walk over megabyte arrays.
  expect(actual.byteLength).toBe(expected.byteLength);
  expect(actual.findIndex((byte, index) => byte !== expected[index])).toBe(-1);
}
async function rawJournal({ folder }: { folder: FileSystemDirectoryHandle }): Promise<DownloadJournal> {
  return JSON.parse(new TextDecoder().decode(await rawBytes({ file: await (await folder.getFileHandle(pendingName)).getFile() })));
}
async function fill({ handle, bytes }: { handle: FileSystemFileHandle, bytes: Uint8Array<ArrayBuffer> }): Promise<void> {
  const access = await openSyncAccess({ handle });
  try {
    access.truncate(0); access.write(bytes, { at: 0 }); access.flush();
  } finally {
    access.close();
  }
}
async function shared() {
  const bytes = new Uint8Array(blobIO.BLOB_VIEW_CHUNK_SIZE * 3 + 17).map((_, index) => index % 251);
  bytes.set(ggufBytes().subarray(0, 8));
  const folder = await repositoryFolder({ repository: selection.repository, create: true });
  const projector = await folder.getFileHandle('mmproj.gguf', { create: true }) as SyncFileFixture;
  await fill({ handle: projector, bytes });
  const selected = { ...selection, files: [...selection.files, { path: 'mmproj.gguf', size: bytes.length }] };
  return { bytes, folder, projector, selected };
}
async function installedMain() {
  const bytes = new Uint8Array(blobIO.BLOB_VIEW_CHUNK_SIZE * 2 + 17).map((_, index) => index % 251);
  bytes.set(ggufBytes().subarray(0, 8));
  const folder = await repositoryFolder({ repository: selection.repository, create: true });
  const model = await folder.getFileHandle('model.gguf', { create: true }) as SyncFileFixture;
  await fill({ handle: model, bytes });
  const selected: DownloadSelection = { ...selection, files: [
    { path: 'model.gguf', size: bytes.length }, { path: 'mmproj.gguf', size: 128 },
  ] };
  return { bytes, folder, model, selected };
}
async function finishBase({ api }: { api: ReturnType<typeof createDownloadWriter> }): Promise<void> {
  await api.open({ fileIndex: 0, start: 0 });
  await api.append({ bytes: ggufBytes() });
  await api.finishFile();
}
beforeEach(() => {
  root = memoryDirectory({ name: '' });
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
  vi.spyOn(blobIO, 'readNativeBlobRange').mockRejectedValue(new DOMException('Opaque Worker', 'NotReadableError'));
  vi.spyOn(Blob.prototype, 'arrayBuffer').mockRejectedValue(new Error('Raw Worker arrayBuffer is forbidden'));
  vi.spyOn(Blob.prototype, 'text').mockRejectedValue(new Error('Raw Worker text is forbidden'));
  vi.spyOn(Blob.prototype, 'stream').mockImplementation(() => {
    throw new Error('Raw Worker stream is forbidden');
  });
});
afterEach(async () => {
  for (const api of writers.splice(0)) await api.pause().catch(() => {});
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('download BlobView ownership and data', () => {
  it('keeps supported Worker reads local and never sends the model body to the host', async () => {
    vi.mocked(blobIO.readNativeBlobRange).mockImplementation(hostRead);
    const nativeBytes = vi.spyOn(Blob.prototype, 'bytes');
    const { host, read, released } = createHost(); const api = writer();
    await api.begin({ selection }, host); await finishBase({ api }); await api.finish();
    expect(read).not.toHaveBeenCalled(); expect(released).toHaveBeenCalledOnce();
    expect(vi.mocked(blobIO.readNativeBlobRange).mock.calls.map(([request]) => request.length)).toEqual([3]);
    expect(nativeBytes).toHaveBeenCalledOnce();
    expect((await nativeBytes.mock.results[0]!.value).byteLength).toBe(8);
  });

  it('pauses a verified prefix and resumes the same journal with a fresh context', async () => {
    const first = writer(); const a = createHost();
    await first.begin({ selection }, a.host); await first.open({ fileIndex: 0, start: 0 });
    await first.append({ bytes: ggufBytes().slice(0, 48) }); await first.pause();
    const folder = await repositoryFolder({ repository: selection.repository, create: false });
    expect((await rawJournal({ folder })).bytes).toEqual([48]); expect(a.released).toHaveBeenCalledOnce();
    const second = writer(); const b = createHost();
    expect(await second.begin({ selection }, b.host)).toMatchObject({ status: 'ready', journal: { bytes: [48], complete: [false] } });
    expect(b.read.mock.calls[0]?.[0].length).toBe(3);
    await second.open({ fileIndex: 0, start: 48 }); await second.append({ bytes: ggufBytes().slice(48) });
    await second.finishFile(); await second.finish(); await second.pause();
    const stored = await (await folder.getFileHandle('model.gguf')).getFile();
    expect(await rawBytes({ file: stored })).toEqual(ggufBytes());
    await expect(folder.getFileHandle(pendingName)).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(b.read.mock.calls.at(-1)?.[0].length).toBe(8); expect(b.released).toHaveBeenCalledOnce();
    expect(b.read.mock.calls.every(([request]) => request.length <= blobIO.BLOB_VIEW_CHUNK_SIZE)).toBe(true);
  });

  it('compares every shared-projector byte in bounded chunks without opening a write handle', async () => {
    const { bytes, folder, projector, selected } = await shared();
    const openForWrite = vi.spyOn(projector, 'createSyncAccessHandle');
    const { host, read, released } = createHost(); const api = writer();
    expect(await api.begin({ selection: selected }, host)).toMatchObject({ status: 'ready', journal: { reused: [false, true] } });
    await finishBase({ api }); await api.open({ fileIndex: 1, start: 0 }); await api.append({ bytes });
    expect(read.mock.calls.map(([request]) => request.length)).toEqual([3, blobIO.BLOB_VIEW_CHUNK_SIZE, blobIO.BLOB_VIEW_CHUNK_SIZE, blobIO.BLOB_VIEW_CHUNK_SIZE, 17]);
    await api.finishFile(); await api.finish();
    expect(read.mock.calls.slice(-2).map(([request]) => request.length)).toEqual([8, 8]);
    expect(openForWrite).not.toHaveBeenCalled(); await expectFileBytes({ file: await projector.getFile(), expected: bytes });
    expect(released).toHaveBeenCalledOnce(); await expect(folder.getFileHandle(pendingName)).rejects.toThrow();
  });

  it('does not count a mismatched shared chunk or overwrite the existing projector', async () => {
    const { bytes, folder, projector, selected } = await shared(); const { host } = createHost(); const api = writer();
    await api.begin({ selection: selected }, host); await api.open({ fileIndex: 1, start: 0 });
    const wrong = bytes.slice(); wrong[blobIO.BLOB_VIEW_CHUNK_SIZE + 9] = wrong[blobIO.BLOB_VIEW_CHUNK_SIZE + 9]! ^ 255;
    await expect(api.append({ bytes: wrong })).rejects.toThrow(sharedProjectorConflictMessage);
    await api.pause();
    await expectFileBytes({ file: await projector.getFile(), expected: bytes });
    expect(await rawJournal({ folder })).toMatchObject({ bytes: [0, 0], complete: [false, false], reused: [false, true] });
  });

  it('reverifies a completed shared projector from zero on each new attempt', async () => {
    const { bytes, folder, selected } = await shared(); const first = writer();
    await first.begin({ selection: selected }, createHost().host);
    await first.open({ fileIndex: 1, start: 0 }); await first.append({ bytes }); await first.finishFile(); await first.pause();
    expect((await rawJournal({ folder })).complete[1]).toBe(true);
    const second = writer(); const host = createHost();
    expect(await second.begin({ selection: selected }, host.host)).toMatchObject({ status: 'ready', journal: { bytes: [0, 0], complete: [false, false] } });
    await expect(second.open({ fileIndex: 1, start: bytes.length })).rejects.toThrow('offset');
    await second.open({ fileIndex: 1, start: 0 }); await second.append({ bytes }); await second.finishFile();
    expect(host.read.mock.calls.some(([request]) => request.length === blobIO.BLOB_VIEW_CHUNK_SIZE)).toBe(true);
  });

  it('leaves the journal present when the downloaded header is invalid', async () => {
    const api = writer(); const { host, read, released } = createHost(); await api.begin({ selection }, host);
    await api.open({ fileIndex: 0, start: 0 }); await api.append({ bytes: new Uint8Array(128) }); await api.finishFile();
    await expect(api.finish()).rejects.toThrow('Invalid downloaded GGUF');
    const folder = await repositoryFolder({ repository: selection.repository, create: false });
    expect((await rawJournal({ folder })).complete).toEqual([true]);
    expect(read.mock.calls.map(([request]) => request.length)).toEqual([3, 8]);
    expect(released).not.toHaveBeenCalled(); await api.pause(); expect(released).toHaveBeenCalledOnce();
  });

  it.each(['invalid-request', 'different-download', 'existing-files'] as const)('releases the new host on %s without retaining a reader', async kind => {
    const { host, released } = createHost(); const api = writer();
    switch (kind) {
    case 'invalid-request':
      await expect(api.begin({ selection: { ...selection, repository: '../wrong' } }, host)).rejects.toThrow(); break;
    case 'different-download': {
      const first = writer(); await first.begin({ selection }, createHost().host); await first.pause();
      expect(await api.begin({ selection: { ...selection, revision: 'b'.repeat(40) } }, host)).toEqual({ status: 'conflict', reason: 'different-download' }); break;
    }
    case 'existing-files': {
      const folder = await repositoryFolder({ repository: selection.repository, create: true });
      await folder.getFileHandle('model.gguf', { create: true });
      expect(await api.begin({ selection }, host)).toEqual({ status: 'conflict', reason: 'existing-files' }); break;
    }
    default: { const exhaustive: never = kind; throw new Error(String(exhaustive)); }
    }
    expect(released).toHaveBeenCalledOnce(); await api.pause(); expect(released).toHaveBeenCalledOnce();
    await expect(api.open({ fileIndex: 0, start: 0 })).rejects.toThrow();
  });

  it('rejects reinitialization without releasing the active download host', async () => {
    const api = writer(); const first = createHost(); const next = createHost();
    await api.begin({ selection }, first.host);
    await expect(api.begin({ selection }, next.host)).rejects.toThrow('busy or closed');
    expect(next.released).toHaveBeenCalledOnce(); expect(first.released).not.toHaveBeenCalled();
    await finishBase({ api }); await api.finish(); expect(first.released).toHaveBeenCalledOnce();
  });
});

describe('existing journal read failures', () => {
  async function setup() {
    const folder = await repositoryFolder({ repository: selection.repository, create: true });
    const journal: DownloadJournal = { version: 1, selection, bytes: [32], complete: [false] };
    await writeJournal({ folder, journal });
    const model = await selectedFile({ folder, path: 'model.gguf', create: true }) as SyncFileFixture;
    await fill({ handle: model, bytes: ggufBytes().slice(0, 64) });
    const marker = await folder.getFileHandle(pendingName);
    return { folder, journal, model, marker, writes: vi.spyOn(marker, 'createWritable'), opens: vi.spyOn(model, 'createSyncAccessHandle') };
  }

  it.each(['NotFoundError', 'NotReadableError', 'NotAllowedError'])('does not treat snapshot %s as an absent journal', async name => {
    const { marker, writes, opens, model } = await setup();
    vi.spyOn(marker, 'getFile').mockRejectedValue(new DOMException('Snapshot failed', name));
    const { host, released, read } = createHost(); const api = writer();
    await expect(api.begin({ selection }, host)).rejects.toBeInstanceOf(DownloadJournalReadError);
    expect(writes).not.toHaveBeenCalled(); expect(opens).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
    expect((await model.getFile()).size).toBe(64); expect(released).toHaveBeenCalledOnce();
  });

  it('keeps unreadable journal contents instead of truncating a pending model or creating a new journal', async () => {
    const { marker, writes, opens, model } = await setup();
    const before = await rawBytes({ file: await marker.getFile() }); const api = writer(); const { host, read, released } = createHost();
    read.mockImplementation(async request => {
      if (request.length !== 3) throw new DOMException('Journal unreadable', 'NotReadableError');
      const bytes = await hostRead(request); return workerTransfer({ value: bytes, transferables: [bytes.buffer] });
    });
    await expect(api.begin({ selection }, host)).rejects.toBeInstanceOf(DownloadJournalReadError);
    expect(await rawBytes({ file: await marker.getFile() })).toEqual(before);
    expect((await model.getFile()).size).toBe(64); expect(writes).not.toHaveBeenCalled(); expect(opens).not.toHaveBeenCalled();
    expect(released).toHaveBeenCalledOnce();
  });

  it('cancels a stalled journal read without overwriting it or truncating an unrecorded suffix', async () => {
    const { folder, marker, model, writes, opens } = await setup();
    const before = await rawBytes({ file: await marker.getFile() });
    const api = writer(); const { host, read, released } = createHost();
    const original = read.getMockImplementation()!;
    const entered = Promise.withResolvers<void>(); const late = Promise.withResolvers<Awaited<ReturnType<WorkerBlobReadHost['read']>>>();
    read.mockImplementation(request => {
      if (request.length === 3) return original(request);
      entered.resolve(); return late.promise;
    });
    const starting = api.begin({ selection }, host); const rejected = expect(starting).rejects.toMatchObject({ name: 'AbortError' });
    await entered.promise; await api.pause(); await rejected;
    expect(await rawBytes({ file: await marker.getFile() })).toEqual(before);
    expect((await rawJournal({ folder })).bytes).toEqual([32]); expect((await model.getFile()).size).toBe(64);
    expect(writes).not.toHaveBeenCalled(); expect(opens).not.toHaveBeenCalled(); expect(released).toHaveBeenCalledOnce();
    late.reject(new Error('Late journal rejection'));
  });

  it.each(['malformed', 'oversized'] as const)('does not overwrite an existing %s journal', async kind => {
    const { marker, writes, opens } = await setup();
    const writable = await marker.createWritable();
    await writable.write(kind === 'malformed' ? '{bad json' : 'x'.repeat(4 * 1024 * 1024 + 1)); await writable.close(); writes.mockClear();
    const { host, read, released } = createHost();
    await expect(writer().begin({ selection }, host)).rejects.toThrow();
    expect(writes).not.toHaveBeenCalled(); expect(opens).not.toHaveBeenCalled(); expect(released).toHaveBeenCalledOnce();
    if (kind === 'oversized') expect(read).not.toHaveBeenCalled();
  });
});

describe('download cancellation and physical resources', () => {
  it.each(['resolve', 'reject'] as const)('pauses a stalled comparison before its late %s, without recording unverified bytes', async outcome => {
    const { bytes, folder, selected } = await shared(); const { host, read, released } = createHost(); const api = writer();
    await api.begin({ selection: selected }, host); await api.open({ fileIndex: 1, start: 0 });
    const entered = Promise.withResolvers<void>(); const pending = Promise.withResolvers<Awaited<ReturnType<WorkerBlobReadHost['read']>>>();
    const original = read.getMockImplementation()!;
    read.mockImplementation(request => {
      if (request.length === 3) return original(request);
      entered.resolve(); return pending.promise;
    });
    const append = api.append({ bytes }); const rejected = expect(append).rejects.toMatchObject({ name: 'AbortError' });
    await entered.promise;
    const pause = api.pause(); expect(api.pause()).toBe(pause); await pause; await rejected;
    expect((await rawJournal({ folder })).bytes).toEqual([0, 0]); expect(released).toHaveBeenCalledOnce();
    const count = read.mock.calls.length;
    if (outcome === 'resolve') pending.resolve(workerTransfer({ value: new Uint8Array(blobIO.BLOB_VIEW_CHUNK_SIZE), transferables: [] }));
    else pending.reject(new Error('Late physical rejection'));
    await Promise.resolve(); expect(read).toHaveBeenCalledTimes(count);
  });

  it('rejects overlapping writes without double-advancing a shared-file cursor', async () => {
    const { bytes, selected } = await shared(); const { host, read } = createHost(); const api = writer();
    await api.begin({ selection: selected }, host); await api.open({ fileIndex: 1, start: 0 });
    const gate = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>();
    const original = read.getMockImplementation()!;
    read.mockImplementation(async request => {
      if (request.length !== 3) {
        entered.resolve(); await gate.promise;
      }
      return original(request);
    });
    const first = api.append({ bytes }); await entered.promise;
    await expect(api.append({ bytes })).rejects.toThrow('busy');
    await expect(api.open({ fileIndex: 0, start: 0 })).rejects.toThrow('busy');
    gate.resolve(); expect(await first).toBe(bytes.length); await api.finishFile();
  });

  it('waits for a late sync access handle, closes it, and never truncates it after pause', async () => {
    const api = writer(); const { host, released } = createHost(); await api.begin({ selection }, host);
    const folder = await repositoryFolder({ repository: selection.repository, create: false });
    const handle = await folder.getFileHandle('model.gguf') as SyncFileFixture; const getAccess = handle.createSyncAccessHandle.bind(handle);
    const gate = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>();
    const access = await getAccess(); const close = vi.spyOn(access, 'close'); const truncate = vi.spyOn(access, 'truncate');
    vi.spyOn(handle, 'createSyncAccessHandle').mockImplementationOnce(async () => {
      entered.resolve(); await gate.promise; return access;
    });
    const opening = api.open({ fileIndex: 0, start: 0 }); const rejected = expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    await entered.promise; let done = false; const paused = api.pause().then(() => {
      done = true;
    });
    await Promise.resolve(); expect(done).toBe(false); expect(released).not.toHaveBeenCalled();
    gate.resolve(); await rejected; await paused;
    expect(close).toHaveBeenCalledOnce(); expect(truncate).not.toHaveBeenCalled(); expect(released).toHaveBeenCalledOnce();
    (await getAccess()).close();
  });

  it('does not publish or retain the host after cancelling a stalled final header read', async () => {
    const api = writer(); const { host, read, released } = createHost(); await api.begin({ selection }, host); await finishBase({ api });
    const original = read.getMockImplementation()!; const entered = Promise.withResolvers<void>();
    const late = Promise.withResolvers<Awaited<ReturnType<WorkerBlobReadHost['read']>>>();
    read.mockImplementation(request => {
      if (request.length === 3) return original(request); entered.resolve(); return late.promise;
    });
    const finishing = api.finish(); const rejected = expect(finishing).rejects.toMatchObject({ name: 'AbortError' });
    await entered.promise; await api.pause(); await rejected;
    const folder = await repositoryFolder({ repository: selection.repository, create: false });
    expect((await rawJournal({ folder })).complete).toEqual([true]); expect(released).toHaveBeenCalledOnce();
    late.reject(new Error('Late header failure'));
  });

  it('propagates a final header read failure without classifying it as invalid GGUF or removing the journal', async () => {
    const api = writer(); const { host, read } = createHost();
    await api.begin({ selection }, host); await finishBase({ api });
    const original = read.getMockImplementation()!;
    const failure = new Error('Header storage unavailable');
    read.mockImplementation(async request => {
      if (request.length === 8) throw failure;
      return original(request);
    });
    await expect(api.finish()).rejects.toBe(failure);
    const folder = await repositoryFolder({ repository: selection.repository, create: false });
    expect((await rawJournal({ folder })).complete).toEqual([true]);
    read.mockImplementation(original);
    await api.finish(); await expect(folder.getFileHandle(pendingName)).rejects.toThrow();
  });

  it('cancels a stopped stream before accepting EOF and keeps an incomplete file resumable', async () => {
    const api = writer(); const { host } = createHost(); await api.begin({ selection }, host); await api.open({ fileIndex: 0, start: 0 });
    const waiting = Promise.withResolvers<void>(); let sent = false;
    const cancelled = vi.fn(); const callbackReleased = vi.fn();
    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull(controller) {
        if (!sent) {
          sent = true; controller.enqueue(ggufBytes().slice(0, 43));
        } else waiting.resolve();
      },
      cancel: cancelled,
    }, { highWaterMark: 0 });
    const consume = api.consume({ stream }, Object.assign(async () => {}, { [Comlink.releaseProxy]: callbackReleased }));
    const rejected = expect(consume).rejects.toMatchObject({ name: 'AbortError' });
    await waiting.promise; await api.stop(); await rejected; await api.pause();
    const folder = await repositoryFolder({ repository: selection.repository, create: false });
    expect(await rawJournal({ folder })).toMatchObject({ bytes: [43], complete: [false] });
    expect(cancelled).toHaveBeenCalledOnce(); expect(callbackReleased).toHaveBeenCalledOnce(); expect(stream.locked).toBe(false);
  });

  it('keeps publication complete when stop arrives after journal removal has begun', async () => {
    const api = writer(); const { host, released } = createHost(); await api.begin({ selection }, host); await finishBase({ api });
    const folder = await repositoryFolder({ repository: selection.repository, create: false }); const remove = folder.removeEntry.bind(folder);
    const entered = Promise.withResolvers<void>(); const gate = Promise.withResolvers<void>();
    vi.spyOn(folder, 'removeEntry').mockImplementation(async (...args) => {
      entered.resolve(); await gate.promise; return remove(...args);
    });
    const finishing = api.finish(); await entered.promise; const pause = api.pause(); gate.resolve(); await finishing; await pause;
    await expect(folder.getFileHandle(pendingName)).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(released).toHaveBeenCalledOnce();
  });

  it('closes sync handles and releases the host even when the pause checkpoint fails', async () => {
    const api = writer(); const { host, released } = createHost(); await api.begin({ selection }, host);
    await api.open({ fileIndex: 0, start: 0 }); await api.append({ bytes: ggufBytes().slice(0, 31) });
    const folder = await repositoryFolder({ repository: selection.repository, create: false }); const marker = await folder.getFileHandle(pendingName);
    const failure = new Error('Checkpoint failed'); vi.spyOn(marker, 'createWritable').mockRejectedValue(failure);
    const pause = api.pause(); await expect(pause).rejects.toBe(failure); await expect(api.pause()).rejects.toBe(failure);
    expect(released).toHaveBeenCalledOnce(); (await openSyncAccess({ handle: await folder.getFileHandle('model.gguf') })).close();
  });

  it('releases a rejected consume callback and cancels its input without changing the writer', async () => {
    const cancelled = vi.fn(); const released = vi.fn(); const api = writer();
    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({ cancel: cancelled });
    await expect(api.consume({ stream }, Object.assign(async () => {}, { [Comlink.releaseProxy]: released }))).rejects.toThrow('not ready');
    expect(cancelled).toHaveBeenCalledOnce(); expect(released).toHaveBeenCalledOnce();
    await api.begin({ selection }, createHost().host); await finishBase({ api }); await api.finish();
  });
});

describe('adding a projector through BlobView without rewriting installed weights', () => {
  it.each(['direct', 'host'] as const)('compares installed main bytes using %s reads and writes only the new projector', async mode => {
    const { bytes, folder, model, selected } = await installedMain();
    switch (mode) {
    case 'direct': vi.mocked(blobIO.readNativeBlobRange).mockImplementation(hostRead); break;
    case 'host': break;
    default: { const exhaustive: never = mode; throw new Error(String(exhaustive)); }
    }
    const writing = vi.spyOn(model, 'createSyncAccessHandle');
    const writable = vi.spyOn(model, 'createWritable');
    const { host, read, released } = createHost(); const api = writer();
    expect(await api.begin({ selection: selected }, host)).toMatchObject({ status: 'ready', journal: { reused: [true, false] } });
    await api.open({ fileIndex: 0, start: 0 }); await api.append({ bytes }); await api.finishFile();
    await api.open({ fileIndex: 1, start: 0 }); await api.append({ bytes: ggufBytes() }); await api.finishFile();
    await api.finish();
    expect(writing).not.toHaveBeenCalled(); expect(writable).not.toHaveBeenCalled();
    await expectFileBytes({ file: await model.getFile(), expected: bytes });
    expect(await rawBytes({ file: await (await folder.getFileHandle('mmproj.gguf')).getFile() })).toEqual(ggufBytes());
    await expect(folder.getFileHandle(pendingName)).rejects.toThrow();
    expect(released).toHaveBeenCalledOnce();
    switch (mode) {
    case 'direct': expect(read).not.toHaveBeenCalled(); break;
    case 'host':
      expect(read.mock.calls.map(([request]) => request.length)).toEqual([3, blobIO.BLOB_VIEW_CHUNK_SIZE, blobIO.BLOB_VIEW_CHUNK_SIZE, 17, 8, 8]);
      break;
    default: { const exhaustive: never = mode; throw new Error(String(exhaustive)); }
    }
  });

  it('classifies a same-size installed main mismatch without counting or truncating the compared chunk', async () => {
    const { bytes, folder, model, selected } = await installedMain();
    const writing = vi.spyOn(model, 'createSyncAccessHandle');
    const { host, released } = createHost(); const api = writer();
    await api.begin({ selection: selected }, host); await api.open({ fileIndex: 0, start: 0 });
    const different = bytes.slice(); different[blobIO.BLOB_VIEW_CHUNK_SIZE + 7]! ^= 255;
    await expect(api.append({ bytes: different })).rejects.toThrow(existingModelConflictMessage);
    await api.pause();
    expect(writing).not.toHaveBeenCalled(); await expectFileBytes({ file: await model.getFile(), expected: bytes });
    expect(await rawJournal({ folder })).toMatchObject({ bytes: [0, 0], complete: [false, false], reused: [true, false] });
    expect(released).toHaveBeenCalledOnce();
  });

  it('does not acknowledge an installed main comparison when its host read fails', async () => {
    const { bytes, folder, model, selected } = await installedMain();
    const writing = vi.spyOn(model, 'createSyncAccessHandle'); const { host, read, released } = createHost();
    const api = writer(); await api.begin({ selection: selected }, host); await api.open({ fileIndex: 0, start: 0 });
    const failure = new DOMException('Stored main unavailable', 'NotReadableError');
    read.mockImplementation(async request => {
      if (request.blob.size === bytes.length) throw failure;
      const data = await hostRead(request); return workerTransfer({ value: data, transferables: [data.buffer] });
    });
    await expect(api.append({ bytes })).rejects.toBe(failure);
    await api.pause();
    expect(writing).not.toHaveBeenCalled(); await expectFileBytes({ file: await model.getFile(), expected: bytes });
    expect(await rawJournal({ folder })).toMatchObject({ bytes: [0, 0], complete: [false, false] });
    expect(released).toHaveBeenCalledOnce();
  });

  it('restarts installed main verification at zero with a new host after a paused upgrade', async () => {
    const { bytes, folder, model, selected } = await installedMain();
    const writing = vi.spyOn(model, 'createSyncAccessHandle');
    const first = writer(); const firstHost = createHost();
    await first.begin({ selection: selected }, firstHost.host); await first.open({ fileIndex: 0, start: 0 });
    await first.append({ bytes: bytes.slice(0, blobIO.BLOB_VIEW_CHUNK_SIZE) }); await first.pause();
    expect((await rawJournal({ folder })).bytes).toEqual([blobIO.BLOB_VIEW_CHUNK_SIZE, 0]);
    const second = writer(); const secondHost = createHost();
    expect(await second.begin({ selection: selected }, secondHost.host)).toMatchObject({ status: 'ready', journal: { bytes: [0, 0], complete: [false, false], reused: [true, false] } });
    await expect(second.open({ fileIndex: 0, start: blobIO.BLOB_VIEW_CHUNK_SIZE })).rejects.toThrow('offset');
    await second.open({ fileIndex: 0, start: 0 }); await second.append({ bytes }); await second.finishFile();
    await second.open({ fileIndex: 1, start: 0 }); await second.append({ bytes: ggufBytes() }); await second.finishFile();
    await second.finish();
    expect(writing).not.toHaveBeenCalled(); await expectFileBytes({ file: await model.getFile(), expected: bytes });
    expect(firstHost.released).toHaveBeenCalledOnce(); expect(secondHost.released).toHaveBeenCalledOnce();
  });

  it('transfers installed main comparison bytes over Comlink without opening it for writing', async () => {
    const { bytes, folder, model, selected } = await installedMain();
    const writing = vi.spyOn(model, 'createSyncAccessHandle'); const api = writer();
    const channel = new MessageChannel(); const released = vi.fn(); const sent: ArrayBuffer[] = [];
    const host: WorkerBlobReadHost = Object.assign({ async read(request: Parameters<WorkerBlobReadHost['read']>[0]) {
      const data = await hostRead(request); sent.push(data.buffer);
      return workerTransfer({ value: data, transferables: [data.buffer] });
    } }, { [Comlink.finalizer]: released });
    exposeWorkerRemote<DownloadWriterApi>({ api, endpoint: channel.port1 as unknown as MessagePort });
    const remote = wrapWorkerRemote<DownloadWriterApi>({ endpoint: channel.port2 as unknown as MessagePort });
    try {
      expect(await remote.begin({ selection: selected }, workerProxy({ value: host }))).toMatchObject({ status: 'ready', journal: { reused: [true, false] } });
      await remote.open({ fileIndex: 0, start: 0 });
      const main = bytes.slice(); await remote.append(workerTransfer({ value: { bytes: main }, transferables: [main.buffer] }));
      expect(main.byteLength).toBe(0); await remote.finishFile();
      await remote.open({ fileIndex: 1, start: 0 });
      const projector = ggufBytes(); await remote.append(workerTransfer({ value: { bytes: projector }, transferables: [projector.buffer] }));
      expect(projector.byteLength).toBe(0); await remote.finishFile(); await remote.finish();
      expect(writing).not.toHaveBeenCalled(); expect(sent.length).toBeGreaterThan(3);
      expect(sent.every(buffer => buffer.byteLength === 0)).toBe(true);
      await expectFileBytes({ file: await model.getFile(), expected: bytes });
      await expect(folder.getFileHandle(pendingName)).rejects.toThrow();
      await vi.waitFor(() => expect(released).toHaveBeenCalledOnce());
    } finally {
      await api.pause().catch(() => {}); releaseWorkerRemote({ remote }); channel.port1.close(); channel.port2.close();
    }
  });
});

describe('download writer real Comlink boundary', () => {
  it('clones native snapshots, transfers range bytes and releases separate probe/download/progress proxies', async () => {
    const { bytes, folder, selected } = await shared();
    const api = writer(); const channel = new MessageChannel();
    exposeWorkerRemote<DownloadWriterApi>({ api, endpoint: channel.port1 as unknown as MessagePort });
    const remote = wrapWorkerRemote<DownloadWriterApi>({ endpoint: channel.port2 as unknown as MessagePort });
    const probeReleased = vi.fn(); const hostReleased = vi.fn(); const progressReleased = vi.fn(); const sent: ArrayBuffer[] = [];
    function host({ finalizer }: { finalizer: () => void }): WorkerBlobReadHost {
      return Object.assign({ async read(request: Parameters<WorkerBlobReadHost['read']>[0]) {
        const data = await hostRead(request); sent.push(data.buffer);
        return workerTransfer({ value: data, transferables: [data.buffer] });
      } }, { [Comlink.finalizer]: finalizer });
    }
    try {
      const probeId = crypto.randomUUID(); const marker = await root.getFileHandle(`.naidan-llama-shared-probe-${probeId}`, { create: true });
      const writer = await marker.createWritable(); await writer.write(probeId); await writer.close();
      expect(await remote.verifyStorage({ probeId }, workerProxy({ value: host({ finalizer: probeReleased }) }))).toBe(true);
      await vi.waitFor(() => expect(probeReleased).toHaveBeenCalledOnce());
      await remote.begin({ selection: selected }, workerProxy({ value: host({ finalizer: hostReleased }) }));
      await remote.open({ fileIndex: 0, start: 0 });
      const base = ggufBytes(); await remote.append(workerTransfer({ value: { bytes: base }, transferables: [base.buffer] }));
      expect(base.buffer.byteLength).toBe(0); await remote.finishFile();
      await remote.open({ fileIndex: 1, start: 0 });
      const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) {
        controller.enqueue(bytes.slice()); controller.close();
      } });
      const progress = Object.assign(vi.fn(async () => {}), { [Comlink.finalizer]: progressReleased });
      await remote.consume(workerTransfer({
        value: workerCapability({ value: { stream }, capability: 'readable-stream-transfer' }), transferables: [stream],
      }), workerProxy({ value: progress }));
      expect(progress).toHaveBeenCalledWith({ position: bytes.length });
      await vi.waitFor(() => expect(progressReleased).toHaveBeenCalledOnce());
      await remote.finish();
      expect(sent.every(buffer => buffer.byteLength === 0)).toBe(true);
      await expectFileBytes({ file: await (await folder.getFileHandle('mmproj.gguf')).getFile(), expected: bytes });
      await vi.waitFor(() => expect(hostReleased).toHaveBeenCalledOnce());
      const rejectedCallbackReleased = vi.fn(); const inputCancelled = vi.fn();
      const invalidStream = new ReadableStream<Uint8Array<ArrayBuffer>>({ cancel: inputCancelled });
      const rejectedCallback = Object.assign(async () => {}, { [Comlink.finalizer]: rejectedCallbackReleased });
      await expect(remote.consume(workerTransfer({
        value: workerCapability({ value: { stream: invalidStream }, capability: 'readable-stream-transfer' }), transferables: [invalidStream],
      }), workerProxy({ value: rejectedCallback }))).rejects.toThrow('not ready');
      await vi.waitFor(() => {
        expect(inputCancelled).toHaveBeenCalledOnce(); expect(rejectedCallbackReleased).toHaveBeenCalledOnce();
      });
      await remote.pause();
    } finally {
      await api.pause().catch(() => {}); releaseWorkerRemote({ remote }); channel.port1.close(); channel.port2.close();
    }
  });
});
