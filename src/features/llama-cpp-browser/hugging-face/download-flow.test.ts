import { scanDeletionTree } from '@/features/llama-cpp-browser/runtime/deletion-plan';
import { workerCapability } from '@/utils/worker-transport';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { privacyFetchStream } from '@/features/privacy-fetch';
import { createDownloadWriter } from './writer';
import { downloadRepository, cancelDownload } from './download';
import { listHuggingFaceModels, listPendingDownloads, repositoryFolder } from './storage';
import { memoryDirectory, ggufBytes } from './test-opfs';
import type { DownloadSelection } from './types';
const state = vi.hoisted(() => ({ support: 'unsupported' as 'supported' | 'unsupported', worker: undefined as EventTarget | undefined, appendGate: undefined as Promise<void> | undefined }));
vi.mock('@/features/privacy-fetch', () => ({ privacyFetchStream: vi.fn() }));
vi.mock('@/utils/worker-transport', async importOriginal => {
  const original = await importOriginal<typeof import('@/utils/worker-transport')>();
  return { ...original, wrapWorkerRemote: () => {
    const writer = createDownloadWriter(); const begin = writer.begin; writer.begin = async ({ selection }) => structuredClone(await begin({ selection })); const append = writer.append; writer.append = async ({ bytes }) => {
      await state.appendGate; return append({ bytes });
    }; return writer;
  }, releaseWorkerRemote: () => {}, workerTransfer: ({ value }: { value: object }) => value,
  workerProxy: ({ value }: { value: object }) => value, workerCapability: vi.fn(({ value }: { value: object }) => value), getReadableStreamTransferSupport: async () => state.support };
});
const selection: DownloadSelection = { repository: 'owner/repo', revision: 'a'.repeat(40), files: [{ path: 'model.gguf', size: 128 }] };
function response({ status, offset, bytes }: { status: number, offset: number, bytes: Uint8Array<ArrayBuffer>[] }): Awaited<ReturnType<typeof privacyFetchStream>> {
  return { status, statusText: '', ok: status < 400, url: '', redirected: false, responseType: 'basic', policyName: 'test', headers: new Headers(status === 206 ? { 'content-range': `bytes ${offset}-127/128` } : {}),
    body: new ReadableStream<Uint8Array<ArrayBuffer>>({ pull(controller) {
      const next = bytes.shift(); if (next) controller.enqueue(next); else controller.close();
    } }, { highWaterMark: 0 }) };
}
beforeEach(() => {
  vi.clearAllMocks(); state.support = 'unsupported'; state.appendGate = undefined; const root = memoryDirectory({ name: '' });
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root }, locks: { request: async (_name: string, _options: object, operation: (lock: object) => Promise<unknown>) => operation({}) } });
  vi.stubGlobal('Worker', class extends EventTarget {
    constructor() {
      super(); state.worker = this;
    } terminate() {}
  });
});
afterEach(() => vi.unstubAllGlobals());
describe.each(['unsupported', 'supported'] as const)('download transport: %s', support => {
  it('publishes validated streamed bytes', async () => {
    state.support = support; vi.mocked(privacyFetchStream).mockResolvedValueOnce(response({ status: 200, offset: 0, bytes: [ggufBytes().slice(0, 64), ggufBytes().slice(64)] }));
    await downloadRepository({ selection, signal: new AbortController().signal, onProgress: () => {} });
    expect((await listHuggingFaceModels()).map(model => model.name)).toEqual(['hf.co/owner/repo']);
    switch (support) {
    case 'supported': expect(workerCapability).toHaveBeenCalledWith({ value: { stream: expect.any(ReadableStream) }, capability: 'readable-stream-transfer' }); break;
    case 'unsupported': expect(workerCapability).not.toHaveBeenCalled(); break;
    default: { const exhaustive: never = support; throw new Error(String(exhaustive)); }
    }
    expect(vi.mocked(privacyFetchStream).mock.calls[0]?.[0].request.url).toContain(`/resolve/${selection.revision}/model.gguf`);
  });
  it('keeps short and oversized responses unpublished', async () => {
    state.support = support; vi.mocked(privacyFetchStream).mockResolvedValueOnce(response({ status: 200, offset: 0, bytes: [ggufBytes().slice(0, 64)] }));
    await expect(downloadRepository({ selection, signal: new AbortController().signal, onProgress: () => {} })).rejects.toThrow();
    expect(await listHuggingFaceModels()).toEqual([]); expect((await listPendingDownloads())[0]?.bytes).toEqual([64]);
    vi.mocked(privacyFetchStream).mockResolvedValueOnce(response({ status: 200, offset: 0, bytes: [ggufBytes(), new Uint8Array([0])] }));
    await expect(downloadRepository({ selection, signal: new AbortController().signal, onProgress: () => {} })).rejects.toThrow();
    expect(await listHuggingFaceModels()).toEqual([]);
  });
});
describe('download orchestration', () => {
  it('pauses after acknowledged bytes and resumes a pinned SHA through validated 206', async () => {
    const controller = new AbortController();
    vi.mocked(privacyFetchStream).mockResolvedValueOnce(response({ status: 200, offset: 0, bytes: [ggufBytes().slice(0, 64), ggufBytes().slice(64)] }));
    await expect(downloadRepository({ selection, signal: controller.signal, onProgress: ({ progress }) => {
      if (progress.completed === 64) controller.abort();
    } })).rejects.toThrow();
    expect((await listPendingDownloads())[0]?.bytes).toEqual([64]);
    vi.mocked(privacyFetchStream).mockResolvedValueOnce(response({ status: 206, offset: 64, bytes: [ggufBytes().slice(64)] }));
    await downloadRepository({ selection, signal: new AbortController().signal, onProgress: () => {} });
    expect(vi.mocked(privacyFetchStream).mock.calls[1]?.[0].request.headers).toEqual([['Range', 'bytes=64-']]); expect(await listPendingDownloads()).toEqual([]);
  });
  it('restarts a 200 response and allows explicit cancel-delete of a paused job', async () => {
    vi.mocked(privacyFetchStream).mockResolvedValueOnce(response({ status: 200, offset: 0, bytes: [ggufBytes().slice(0, 48)] }));
    await expect(downloadRepository({ selection, signal: new AbortController().signal, onProgress: () => {} })).rejects.toThrow();
    vi.mocked(privacyFetchStream).mockResolvedValueOnce(response({ status: 200, offset: 0, bytes: [ggufBytes()] }));
    await downloadRepository({ selection, signal: new AbortController().signal, onProgress: () => {} });
    expect((await listHuggingFaceModels())[0]?.size).toBe(128);
    await cancelDownload({ repository: selection.repository, plan: { id: 'hf.co/owner/repo', files: (await scanDeletionTree({ folder: await repositoryFolder({ repository: selection.repository, create: false }) })).files } }); expect(await listHuggingFaceModels()).toEqual([]);
  });
  it('preserves typed conflicts from the worker without starting another network request', async () => {
    vi.mocked(privacyFetchStream).mockResolvedValueOnce(response({ status: 200, offset: 0, bytes: [ggufBytes().slice(0, 64)] }));
    await expect(downloadRepository({ selection, signal: new AbortController().signal, onProgress: () => {} })).rejects.toThrow();
    await expect(downloadRepository({ selection: { ...selection, revision: 'b'.repeat(40) }, signal: new AbortController().signal, onProgress: () => {} })).rejects.toMatchObject({ name: 'DownloadConflictError', reason: 'different-download' });
    expect(privacyFetchStream).toHaveBeenCalledTimes(1);
    vi.mocked(privacyFetchStream).mockResolvedValueOnce(response({ status: 206, offset: 64, bytes: [ggufBytes().slice(64)] }));
    await downloadRepository({ selection, signal: new AbortController().signal, onProgress: () => {} });
    await expect(downloadRepository({ selection, signal: new AbortController().signal, onProgress: () => {} })).rejects.toMatchObject({ name: 'DownloadConflictError', reason: 'existing-files' });
    expect(privacyFetchStream).toHaveBeenCalledTimes(2);
  });
  it('does not read the next fallback chunk until the writer acknowledges the current chunk', async () => {
    const gate = Promise.withResolvers<void>(); state.appendGate = gate.promise;
    const entered = Promise.withResolvers<void>(); let pulls = 0;
    const source = response({ status: 200, offset: 0, bytes: [] });
    source.body = new ReadableStream<Uint8Array<ArrayBuffer>>({ pull(controller) {
      pulls++; if (pulls === 1) {
        controller.enqueue(ggufBytes().slice(0, 64)); entered.resolve();
      } else if (pulls === 2) controller.enqueue(ggufBytes().slice(64)); else controller.close();
    } }, { highWaterMark: 0 });
    vi.mocked(privacyFetchStream).mockResolvedValueOnce(source);
    const download = downloadRepository({ selection, signal: new AbortController().signal, onProgress: () => {} });
    await entered.promise; await Promise.resolve(); expect(pulls).toBe(1);
    gate.resolve(); await download; expect(pulls).toBe(3);
  });
  it('aborts a pending network request when the storage worker fails', async () => {
    vi.mocked(privacyFetchStream).mockImplementation(({ request }) => new Promise((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      queueMicrotask(() => state.worker?.dispatchEvent(new Event('error')));
    }));
    await expect(downloadRepository({ selection, signal: new AbortController().signal, onProgress: () => {} })).rejects.toThrow();
    expect(vi.mocked(privacyFetchStream).mock.calls[0]?.[0].request.signal?.aborted).toBe(true);
  });
});
