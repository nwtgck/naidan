// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryDirectory } from '@/features/stable-diffusion-cpp-browser/test-utils/storage.test-support';
import { verifyStorage } from '@/features/llama-cpp-browser/runtime/shared-storage-probe';
import { privacyFetchStream } from '@/features/privacy-fetch';
import { downloadRepository, cancelDownload } from './download-standalone';
import { cancelDownload as sharedCancel } from './download';

const calls = vi.hoisted(() => ({ factory: vi.fn(), release: vi.fn(), download: vi.fn(), cancel: vi.fn() }));
vi.mock('virtual:file-protocol-standalone/worker/file-download', () => ({ createStandaloneWorker: calls.factory }));
vi.mock('@/logic/hugging-face-download/worker/factory', async () => import('@/logic/hugging-face-download/worker/factory-standalone'));
vi.mock('@/features/privacy-fetch', () => ({ privacyFetchStream: vi.fn() }));
vi.mock('@/utils/worker-transport', async importOriginal => ({
  ...await importOriginal<typeof import('@/utils/worker-transport')>(),
  wrapWorkerRemote: () => ({ download: calls.download, cancel: calls.cancel, verifyStorage }),
  releaseWorkerRemote: calls.release,
  workerProxy: ({ value }: { value: object }) => value,
}));
class TestWorker extends EventTarget {
  terminate = vi.fn();
}
let worker: TestWorker;
const selection = { repository: 'example/model', revision: 'a'.repeat(40), files: [{ path: 'model-Q4_K_M.gguf', size: 128 }] };

const run = ({ signal }: { signal: AbortSignal }) => downloadRepository({ selection, signal, onProgress() {} });

beforeEach(() => {
  vi.clearAllMocks();
  calls.download.mockReset().mockResolvedValue(undefined);
  calls.cancel.mockReset().mockResolvedValue(undefined);
  calls.release.mockReset().mockResolvedValue(undefined);
  worker = new TestWorker();
  calls.factory.mockReset().mockResolvedValue(worker);
  const root = new MemoryDirectory('root');
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
  vi.stubGlobal('Worker', class {
    constructor() {
      throw new Error('Raw Worker is forbidden in standalone');
    }
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('standalone shared file-download Worker', () => {
  it('uses the registered standalone factory and passes the complete pinned selection', async () => {
    await run({ signal: new AbortController().signal });
    expect(calls.factory).toHaveBeenCalledOnce();
    expect(calls.download).toHaveBeenCalledWith(expect.objectContaining({ files: [{ repository: selection.repository, revision: selection.revision, path: 'model-Q4_K_M.gguf', expectedSize: 128 }], validation: 'model-weight' }), expect.any(Function), expect.any(Function));
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(calls.release).toHaveBeenCalledOnce();
  });

  it('keeps explicit deletion on the same shared storage implementation', () => {
    expect(cancelDownload).toBe(sharedCancel);
  });

  it('does not create a Worker for an already aborted intent', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(run({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls.factory).not.toHaveBeenCalled();
    expect(privacyFetchStream).not.toHaveBeenCalled();
  });

  it('cancels pending bootstrap immediately and cleans up a late physical Worker', async () => {
    const starting = Promise.withResolvers<Worker>();
    calls.factory.mockReturnValueOnce(starting.promise);
    await using _cleanup = {
      async [Symbol.asyncDispose]() {
        starting.resolve(worker as unknown as Worker);
        await vi.waitFor(() => expect(worker.terminate).toHaveBeenCalledOnce());
      },
    };
    const controller = new AbortController();
    const task = run({ signal: controller.signal });
    const rejected = expect(task).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(calls.factory).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    expect(calls.download).not.toHaveBeenCalled();
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it('handles a late bootstrap rejection after the user has cancelled', async () => {
    const starting = Promise.withResolvers<Worker>();
    calls.factory.mockReturnValueOnce(starting.promise);
    const controller = new AbortController();
    const task = run({ signal: controller.signal });
    const rejected = expect(task).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(calls.factory).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    starting.reject(new Error('Late bootstrap failure'));
    await new Promise(resolve => setImmediate(resolve));
    expect(calls.download).not.toHaveBeenCalled();
    expect(calls.release).not.toHaveBeenCalled();
  });

  it('does not transfer when the window and Worker cannot verify shared storage', async () => {
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: async () => {
          throw new DOMException('Denied', 'SecurityError');
        },
      },
    });
    await expect(run({ signal: new AbortController().signal })).rejects.toThrow('unavailable');
    await vi.waitFor(() => expect(worker.terminate).toHaveBeenCalledOnce());
    expect(calls.download).not.toHaveBeenCalled();
    expect(privacyFetchStream).not.toHaveBeenCalled();
  });

  it('allows a bounded checkpoint grace period before terminating an unresponsive transfer', async () => {
    const entered = Promise.withResolvers<void>();
    calls.download.mockImplementation(() => {
      entered.resolve();
      return new Promise(() => {});
    });
    const controller = new AbortController();
    const task = run({ signal: controller.signal });
    const rejected = expect(task).rejects.toThrow('Download paused');
    await entered.promise;
    vi.useFakeTimers();
    controller.abort();
    expect(calls.cancel).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4999);
    expect(worker.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('terminates even when transport release never acknowledges', async () => {
    const releasing = Promise.withResolvers<void>();
    calls.release.mockImplementation(() => {
      releasing.resolve();
      return new Promise(() => {});
    });
    vi.useFakeTimers();
    const task = run({ signal: new AbortController().signal });
    const rejected = expect(task).rejects.toThrow('timed out');
    await releasing.promise;
    await vi.advanceTimersByTimeAsync(3000);
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
