import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { privacyFetchStream } from '@/features/privacy-fetch';
import { scanDeletionTree } from '@/features/llama-cpp-browser/runtime/deletion-plan';
import { createDownloadWriter } from './writer';
import { listHuggingFaceModels, repositoryFolder } from './storage';
import { memoryDirectory, ggufBytes } from './test-opfs';
import { cancelDownload, downloadRepository } from './download-standalone';

const calls = vi.hoisted(() => ({ factory: vi.fn(), release: vi.fn(), pause: undefined as (() => Promise<void>) | undefined, append: undefined as (() => Promise<number>) | undefined }));
vi.mock('virtual:file-protocol-standalone/worker/llama-cpp-browser-download', () => ({ createStandaloneWorker: calls.factory }));
vi.mock('./writer-client', async () => import('./writer-client-standalone'));
vi.mock('@/features/privacy-fetch', () => ({ privacyFetchStream: vi.fn() }));
vi.mock('@/utils/worker-transport', async importOriginal => {
  const original = await importOriginal<typeof import('@/utils/worker-transport')>();
  return { ...original, wrapWorkerRemote: () => {
    const writer = createDownloadWriter();
    if (calls.pause) writer.pause = calls.pause;
    if (calls.append) writer.append = calls.append;
    return writer;
  }, releaseWorkerRemote: calls.release, workerTransfer: ({ value }: { value: object }) => value,
  workerProxy: ({ value }: { value: object }) => value, getReadableStreamTransferSupport: async () => 'unsupported' };
});
class TestWorker extends EventTarget {
  terminate = vi.fn();
}
let worker: TestWorker;
const selection = { repository: 'example/model', revision: 'a'.repeat(40), files: [{ path: 'model-Q4_K_M.gguf', size: 128 }] };
beforeEach(() => {
  vi.clearAllMocks(); calls.pause = undefined; calls.append = undefined; worker = new TestWorker(); calls.factory.mockResolvedValue(worker); calls.release.mockResolvedValue(undefined);
  const root = memoryDirectory({ name: '' });
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root }, locks: { request: async (_name: string, _options: object, operation: (lock: object) => Promise<unknown>) => operation({}) } });
  vi.stubGlobal('Worker', class {
    constructor() {
      throw new Error('Raw Worker is forbidden in standalone');
    }
  });
  vi.mocked(privacyFetchStream).mockImplementation(async () => ({ status: 200, statusText: '', ok: true, url: '', redirected: false, responseType: 'basic', policyName: 'standalone-fixture', headers: new Headers(),
    body: new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) {
      controller.enqueue(ggufBytes()); controller.close();
    } }) }));
});
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllGlobals();
});
describe('standalone browser model downloads', () => {
  it('allows cooperative cancellation a grace period before abandoning a stuck append', async () => {
    vi.useFakeTimers();
    const entered = Promise.withResolvers<void>();
    calls.append = () => {
      entered.resolve(); return new Promise(() => {});
    };
    const controller = new AbortController();
    const operation = downloadRepository({ selection, signal: controller.signal, onProgress: () => {} });
    const rejected = expect(operation).rejects.toThrow('Download paused');
    await entered.promise; controller.abort();
    await vi.advanceTimersByTimeAsync(4999);
    expect(worker.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(await listHuggingFaceModels()).toEqual([]);
  });
  it('downloads through the shared fetch boundary and the standalone writer factory', async () => {
    const onProgress = vi.fn();
    await downloadRepository({ selection, signal: new AbortController().signal, onProgress });
    expect(calls.factory).toHaveBeenCalledOnce(); expect(privacyFetchStream).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenCalled();
    expect((await listHuggingFaceModels())[0]?.name).toBe('hf.co/example/model:Q4_K_M');
    expect(worker.terminate).toHaveBeenCalledOnce(); expect(calls.release).toHaveBeenCalledOnce();
  });
  it('allows explicit deletion of a verified standalone download', async () => {
    await downloadRepository({ selection, signal: new AbortController().signal, onProgress: () => {} });
    const folder = await repositoryFolder({ repository: selection.repository, create: false });
    const files = (await scanDeletionTree({ folder })).files;
    await expect(cancelDownload({ repository: selection.repository, plan: { id: 'hf.co/example/model', files } })).resolves.toBe('deleted');
    expect(await listHuggingFaceModels()).toEqual([]);
  });
  it('rejects cancellation before startup settles and cleans up a late writer without fetching', async () => {
    const startup = Promise.withResolvers<Worker>(); const entered = Promise.withResolvers<void>();
    calls.factory.mockImplementation(() => {
      entered.resolve(); return startup.promise;
    });
    const controller = new AbortController();
    const operation = downloadRepository({ selection, signal: controller.signal, onProgress: () => {} });
    const rejected = vi.fn();
    const result = operation.catch(error => {
      rejected(error); return error;
    });
    await entered.promise; controller.abort();
    try {
      await vi.waitFor(() => expect(rejected).toHaveBeenCalledOnce(), { timeout: 200 });
      expect(await result).toMatchObject({ message: 'llama.cpp browser: aborted' });
      expect(privacyFetchStream).not.toHaveBeenCalled();
      expect(worker.terminate).not.toHaveBeenCalled();
    } finally {
      startup.resolve(worker as unknown as Worker);
      await result;
      await vi.waitFor(() => expect(worker.terminate).toHaveBeenCalledOnce());
    }
    expect(privacyFetchStream).not.toHaveBeenCalled();
  });
  it('does not create a writer for an already cancelled download', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(downloadRepository({ selection, signal: controller.signal, onProgress: () => {} })).rejects.toThrow('aborted');
    expect(calls.factory).not.toHaveBeenCalled();
    expect(privacyFetchStream).not.toHaveBeenCalled();
  });
  it('handles a late bootstrap rejection after cancellation without downloading', async () => {
    const startup = Promise.withResolvers<Worker>(); const entered = Promise.withResolvers<void>();
    calls.factory.mockImplementation(() => {
      entered.resolve(); return startup.promise;
    });
    const controller = new AbortController();
    const operation = downloadRepository({ selection, signal: controller.signal, onProgress: () => {} });
    const rejection = expect(operation).rejects.toThrow('aborted');
    await entered.promise; controller.abort(); await rejection;
    startup.reject(new Error('Bootstrap failed after cancellation'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(privacyFetchStream).not.toHaveBeenCalled();
    expect(calls.release).not.toHaveBeenCalled();
  });
  it('preserves storage unavailability and retires the writer before any fetch', async () => {
    vi.stubGlobal('navigator', {
      storage: { getDirectory: async () => {
        throw new DOMException('Denied', 'SecurityError');
      } },
      locks: { request: async (_name: string, _options: object, operation: (lock: object) => Promise<unknown>) => operation({}) },
    });
    await expect(downloadRepository({ selection, signal: new AbortController().signal, onProgress: () => {} })).rejects.toThrow('unavailable');
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(privacyFetchStream).not.toHaveBeenCalled();
  });
  it('terminates after bounded pause cleanup even when a writer becomes unresponsive', async () => {
    vi.useFakeTimers();
    const entered = Promise.withResolvers<void>();
    calls.pause = () => {
      entered.resolve(); return new Promise(() => {});
    };
    const operation = downloadRepository({ selection, signal: new AbortController().signal, onProgress: () => {} });
    const rejection = expect(operation).rejects.toThrow('cleanup timed out');
    await entered.promise; await vi.advanceTimersByTimeAsync(3000); await rejection;
    expect(worker.terminate).toHaveBeenCalledOnce(); expect(calls.release).toHaveBeenCalledOnce();
  });
});
