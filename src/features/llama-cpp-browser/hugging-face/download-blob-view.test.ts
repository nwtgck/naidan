// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as blobIO from '@/utils/blob-view-io';
import type { WorkerBlobReadHost } from '@/utils/worker-blob-context';
import { privacyFetchStream } from '@/features/privacy-fetch';
import { createDownloadWriter } from './writer';
import { createDownloadWriterClient, type DownloadWriterClient } from './writer-client';
import { downloadRepository } from './download';
import { memoryDirectory, ggufBytes } from './test-opfs';
import { pendingName, type DownloadSelection, type DownloadJournal } from './types';
import { repositoryFolder } from './storage';
import { openSyncAccess } from './sync-access';

const calls = vi.hoisted(() => ({
  mode: 'hosted' as 'hosted' | 'standalone', factory: vi.fn(), release: vi.fn(),
  apis: [] as ReturnType<typeof createDownloadWriter>[],
  clients: [] as DownloadWriterClient[],
  hosts: [] as { host: WorkerBlobReadHost, signal: AbortSignal }[],
  verifyOverride: undefined as ((request: { probeId: string }, host?: WorkerBlobReadHost) => Promise<boolean>) | undefined,
}));
vi.mock('@/features/privacy-fetch', () => ({ privacyFetchStream: vi.fn() }));
vi.mock('virtual:file-protocol-standalone/worker/llama-cpp-browser-download', () => ({ createStandaloneWorker: calls.factory }));
vi.mock('./writer-client', async importOriginal => {
  const hosted = await importOriginal<typeof import('./writer-client')>();
  const standalone = await import('./writer-client-standalone');
  return { ...hosted, async createDownloadWriterClient(args: { signal: AbortSignal }) {
    const client = await (calls.mode === 'hosted' ? hosted : standalone).createDownloadWriterClient(args);
    calls.clients.push(client); return client;
  } };
});
vi.mock('@/utils/worker-blob-context', async importOriginal => {
  const original = await importOriginal<typeof import('@/utils/worker-blob-context')>();
  return { ...original, createWorkerBlobReadHost(args: { signal: AbortSignal }) {
    const host = original.createWorkerBlobReadHost(args);
    vi.spyOn(host, 'read'); calls.hosts.push({ host, signal: args.signal }); return host;
  } };
});
vi.mock('@/utils/worker-transport', async importOriginal => ({
  ...await importOriginal<typeof import('@/utils/worker-transport')>(),
  wrapWorkerRemote() {
    const api = createDownloadWriter();
    if (calls.verifyOverride) api.verifyStorage = calls.verifyOverride;
    vi.spyOn(api, 'begin'); vi.spyOn(api, 'verifyStorage'); vi.spyOn(api, 'pause');
    calls.apis.push(api); return api;
  },
  releaseWorkerRemote: calls.release,
  workerProxy: ({ value }: { value: object }) => value,
  workerTransfer: ({ value }: { value: object }) => value,
  getReadableStreamTransferSupport: async () => 'unsupported',
}));

class TestWorker extends EventTarget {
  terminate = vi.fn();
  constructor() {
    super(); workers.push(this);
  }
}
const workers: TestWorker[] = [];
const selection: DownloadSelection = { repository: 'owner/model', revision: 'a'.repeat(40), files: [{ path: 'model.gguf', size: 128 }] };
let root: ReturnType<typeof memoryDirectory>;
const nativeRead = blobIO.readNativeBlobRange;
function response({ bytes, offset }: { bytes: Uint8Array<ArrayBuffer>, offset: number }) {
  return {
    status: offset === 0 ? 200 : 206, statusText: '', ok: true, url: '', redirected: false, responseType: 'basic' as const, policyName: 'test',
    headers: new Headers(offset === 0 ? {} : { 'content-range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}` }),
    body: new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) {
      for (let i = offset; i < bytes.length; i += 64) controller.enqueue(bytes.slice(i, i + 64));
      controller.close();
    } }),
  };
}
async function journal(): Promise<DownloadJournal> {
  const folder = await repositoryFolder({ repository: selection.repository, create: false });
  return JSON.parse(await (await (await folder.getFileHandle(pendingName)).getFile()).text());
}
async function assertHostsClosed(): Promise<void> {
  for (const { host, signal } of calls.hosts) {
    expect(signal.aborted).toBe(true);
    await expect(host.read({ blob: new Blob(['abc']), offset: 0, length: 1 })).rejects.toMatchObject({ name: 'AbortError' });
  }
}
beforeEach(() => {
  vi.clearAllMocks(); calls.apis.length = 0; calls.clients.length = 0; calls.hosts.length = 0; workers.length = 0;
  calls.verifyOverride = undefined; calls.release.mockResolvedValue(undefined);
  calls.factory.mockImplementation(async () => new TestWorker());
  root = memoryDirectory({ name: '' });
  vi.stubGlobal('Worker', TestWorker);
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root }, locks: {
    request: async (_name: string, _options: object, operation: (lock: object) => Promise<unknown>) => operation({}),
  } });
  const failedProbes = new WeakSet<Blob>();
  // In-process Worker mocks share a realm. Fail each Worker's controlled probe
  // once; the actual host then uses the unchanged native range implementation.
  vi.spyOn(blobIO, 'readNativeBlobRange').mockImplementation(async request => {
    if (request.blob.size === 5 && request.offset === 1 && request.length === 3 && !failedProbes.has(request.blob)) {
      failedProbes.add(request.blob); throw new DOMException('Worker read unavailable', 'NotReadableError');
    }
    return nativeRead(request);
  });
  vi.mocked(privacyFetchStream).mockImplementation(async () => response({ bytes: ggufBytes(), offset: 0 }));
});
afterEach(async () => {
  for (const client of calls.clients) await client.dispose({ beforeRelease: undefined }).catch(() => {});
  for (const api of calls.apis) await api.pause().catch(() => {});
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe.each(['hosted', 'standalone'] as const)('download Blob host lifetime: %s', mode => {
  beforeEach(() => {
    calls.mode = mode;
  });

  it('uses a separate download reader, closes all hosts, and publishes validated bytes', async () => {
    const onProgress = vi.fn();
    vi.mocked(privacyFetchStream).mockImplementation(async () => {
      const probe = calls.hosts.find(({ signal }) => signal.aborted);
      if (mode === 'standalone') expect(probe).toBeDefined();
      const operational = calls.hosts.at(-1)!;
      expect(operational.signal.aborted).toBe(false);
      expect(vi.mocked(calls.apis[0]!.begin).mock.calls[0]?.[1]).toBe(operational.host);
      return response({ bytes: ggufBytes(), offset: 0 });
    });
    await downloadRepository({ selection, signal: new AbortController().signal, onProgress });
    expect(calls.hosts).toHaveLength(mode === 'hosted' ? 1 : 2);
    const reads = vi.mocked(calls.hosts.at(-1)!.host.read).mock.calls;
    expect(reads.map(([request]) => request.length)).toEqual([3, 8]);
    expect(onProgress).toHaveBeenCalled();
    const folder = await repositoryFolder({ repository: selection.repository, create: false });
    expect(new Uint8Array(await (await (await folder.getFileHandle('model.gguf')).getFile()).arrayBuffer())).toEqual(ggufBytes());
    await expect(folder.getFileHandle(pendingName)).rejects.toThrow();
    await assertHostsClosed(); expect(workers[0]!.terminate).toHaveBeenCalledOnce(); expect(calls.release).toHaveBeenCalledOnce();
  });

  it('checkpoints a callback failure and resumes with new hosts instead of reusing closed ones', async () => {
    const failure = new Error('Progress consumer failed');
    await expect(downloadRepository({ selection, signal: new AbortController().signal, onProgress: ({ progress }) => {
      if (progress.completed === 64) throw failure;
    } })).rejects.toBe(failure);
    expect((await journal()).bytes).toEqual([64]); await assertHostsClosed();
    const oldHostCount = calls.hosts.length;
    vi.mocked(privacyFetchStream).mockImplementation(async ({ request }) => {
      expect(request.headers).toEqual([['Range', 'bytes=64-']]);
      return response({ bytes: ggufBytes(), offset: 64 });
    });
    await downloadRepository({ selection, signal: new AbortController().signal, onProgress: () => {} });
    expect(calls.hosts.length).toBe(oldHostCount * 2); await assertHostsClosed();
    expect(workers).toHaveLength(2); expect(workers.every(worker => worker.terminate.mock.calls.length === 1)).toBe(true);
    await expect(journal()).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('stops a pending shared-projector comparison and keeps only verified progress', async () => {
    const folder = await repositoryFolder({ repository: selection.repository, create: true });
    const file = await folder.getFileHandle('mmproj.gguf', { create: true });
    const access = await openSyncAccess({ handle: file }); access.write(ggufBytes(), { at: 0 }); access.close();
    const selected = { ...selection, files: [...selection.files, { path: 'mmproj.gguf', size: 128 }] };
    const entered = Promise.withResolvers<void>(); const late = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
    const previous = vi.mocked(blobIO.readNativeBlobRange).getMockImplementation()!;
    vi.mocked(blobIO.readNativeBlobRange).mockImplementation(request => {
      if (request.length === 64) {
        entered.resolve(); return late.promise;
      }
      return previous(request);
    });
    const abort = new AbortController();
    const operation = downloadRepository({ selection: selected, signal: abort.signal, onProgress: () => {} });
    const rejected = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    await entered.promise; abort.abort(); await rejected;
    expect(await journal()).toMatchObject({ bytes: [128, 0], complete: [true, false], reused: [false, true] });
    await assertHostsClosed(); expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    late.reject(new Error('Late physical IO error'));
  });

  it('does not publish after final header reading is cancelled', async () => {
    const previous = vi.mocked(blobIO.readNativeBlobRange).getMockImplementation()!;
    const entered = Promise.withResolvers<void>(); const late = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
    vi.mocked(blobIO.readNativeBlobRange).mockImplementation(request => {
      if (request.length === 8) {
        entered.resolve(); return late.promise;
      }
      return previous(request);
    });
    const abort = new AbortController();
    const operation = downloadRepository({ selection, signal: abort.signal, onProgress: () => {} });
    const rejected = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    await entered.promise; abort.abort(); await rejected;
    expect((await journal()).complete).toEqual([true]); await assertHostsClosed();
    late.resolve(new Uint8Array([71, 71, 85, 70, 3, 0, 0, 0]));
    await Promise.resolve(); expect(await journal()).toBeDefined();
  });

  it('rejects a pre-aborted request before allocating a Worker or host', async () => {
    await expect(downloadRepository({ selection, signal: AbortSignal.abort(), onProgress: () => {} })).rejects.toThrow('aborted');
    expect(workers).toHaveLength(0); expect(calls.hosts).toHaveLength(0); expect(privacyFetchStream).not.toHaveBeenCalled();
  });

  it('does not terminate early when dispose is requested twice during checkpoint cleanup', async () => {
    const client = await createDownloadWriterClient({ signal: new AbortController().signal });
    const gate = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>();
    const beforeRelease = vi.fn(async () => {
      entered.resolve(); await gate.promise;
    });
    const first = client.dispose({ beforeRelease }); await entered.promise;
    const second = client.dispose({ beforeRelease: async () => {
      throw new Error('Duplicate cleanup');
    } });
    expect(workers[0]!.terminate).not.toHaveBeenCalled(); expect(calls.release).not.toHaveBeenCalled();
    gate.resolve(); await first; await second;
    expect(beforeRelease).toHaveBeenCalledOnce(); expect(workers[0]!.terminate).toHaveBeenCalledOnce(); expect(calls.release).toHaveBeenCalledOnce();
  });
});

describe('standalone download probe boundary', () => {
  beforeEach(() => {
    calls.mode = 'standalone';
  });

  it.each(['mismatch', 'rejection'] as const)('does not start downloads after a probe %s', async outcome => {
    calls.verifyOverride = async () => {
      if (outcome === 'rejection') throw new Error('Probe failed');
      return false;
    };
    await expect(downloadRepository({ selection, signal: new AbortController().signal, onProgress: () => {} })).rejects.toThrow('unavailable');
    expect(calls.hosts).toHaveLength(1); await assertHostsClosed();
    expect(privacyFetchStream).not.toHaveBeenCalled(); expect(calls.apis[0]!.begin).not.toHaveBeenCalled();
    expect(root.children.size).toBe(0); expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  });

  it('closes the pending probe host on cancellation and retires a late result', async () => {
    const entered = Promise.withResolvers<void>(); const late = Promise.withResolvers<boolean>();
    calls.verifyOverride = async () => {
      entered.resolve(); return late.promise;
    };
    const abort = new AbortController();
    const operation = downloadRepository({ selection, signal: abort.signal, onProgress: () => {} });
    const rejected = expect(operation).rejects.toThrow('aborted');
    await entered.promise;
    expect(await calls.hosts[0]!.host.read({ blob: new Blob(['abc']), offset: 1, length: 1 })).toEqual(new Uint8Array([98]));
    abort.abort(); await rejected;
    await assertHostsClosed(); late.resolve(true);
    await vi.waitFor(() => expect(workers[0]!.terminate).toHaveBeenCalledOnce());
    expect(privacyFetchStream).not.toHaveBeenCalled(); expect(root.children.size).toBe(0);
  });

  it('ends a stalled storage probe at the existing timeout without creating the download host', async () => {
    vi.useFakeTimers(); const entered = Promise.withResolvers<void>(); const late = Promise.withResolvers<boolean>();
    calls.verifyOverride = async () => {
      entered.resolve(); return late.promise;
    };
    const operation = downloadRepository({ selection, signal: new AbortController().signal, onProgress: () => {} });
    const rejected = expect(operation).rejects.toThrow('worker-failed');
    await entered.promise; await vi.advanceTimersByTimeAsync(10_000); await rejected;
    expect(calls.hosts).toHaveLength(1); await assertHostsClosed(); late.reject(new Error('Late failed probe'));
    expect(calls.apis[0]!.begin).not.toHaveBeenCalled(); expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  });
});
