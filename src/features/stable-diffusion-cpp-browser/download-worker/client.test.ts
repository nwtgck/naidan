// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { downloadImageRecipeInWorker } from './client';
import { imageModelRecipes } from '@/features/stable-diffusion-cpp-browser/model-recipes';
const remote = vi.hoisted(() => ({ download: vi.fn(), cancel: vi.fn(), release: vi.fn(), wrap: vi.fn() }));
vi.mock('@/utils/worker-transport', () => ({ wrapWorkerRemote: remote.wrap, releaseWorkerRemote: remote.release, workerProxy: ({ value }: { value: unknown }) => value }));
let worker: EventTarget & { terminate: ReturnType<typeof vi.fn> };
const construct = vi.fn();
beforeEach(() => {
  vi.clearAllMocks(); remote.wrap.mockReturnValue(remote); remote.cancel.mockResolvedValue(undefined);
  vi.stubGlobal('Worker', class extends EventTarget {
    terminate = vi.fn();
    constructor() {
      super();
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- Retain the externally constructed Worker test instance.
      worker = this; construct();
    }
  });
});
afterEach(() => {
  vi.unstubAllGlobals(); vi.useRealTimers();
});
const files = imageModelRecipes[1]!.files;
it('does not create a Worker for an already cancelled action', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(downloadImageRecipeInWorker({ files, signal: controller.signal, onProgress() {} })).rejects.toThrow();
  expect(construct).not.toHaveBeenCalled();
});
it('releases the transport and worker after completion, rejecting invalid progress and isolating observer exceptions', async () => {
  const onProgress = vi.fn(() => {
    throw new Error('observer');
  });
  remote.download.mockImplementation(async (_input, report) => {
    report({ progress: {} });
    report({ progress: { phase: 'complete', index: 0, count: 1, path: 'model.gguf', repository: 'org/repo', total: 32, completed: 32, fileTotal: 32, fileCompleted: 32, processed: 32 } });
  });
  await downloadImageRecipeInWorker({ files, signal: new AbortController().signal, onProgress });
  expect(onProgress).toHaveBeenCalledOnce(); expect(worker.terminate).toHaveBeenCalledOnce(); expect(remote.release).toHaveBeenCalledOnce();
});
it('catches worker startup failures instead of leaking it', async () => {
  remote.wrap.mockImplementationOnce(() => {
    throw new Error('startup');
  });
  await expect(downloadImageRecipeInWorker({ files, signal: new AbortController().signal, onProgress() {} })).rejects.toThrow('startup');
  expect(worker.terminate).toHaveBeenCalledOnce();
});
it('terminates a crashed worker without waiting indefinitely for its RPC', async () => {
  remote.download.mockImplementation(() => new Promise(() => undefined));
  const running = downloadImageRecipeInWorker({ files, signal: new AbortController().signal, onProgress() {} });
  worker.dispatchEvent(new Event('error'));
  await expect(running).rejects.toThrow('Worker failed'); expect(worker.terminate).toHaveBeenCalledOnce();
});
it('allows graceful checkpointing on pause before applying the bounded termination fallback', async () => {
  vi.useFakeTimers(); remote.download.mockImplementation(() => new Promise(() => undefined));
  const controller = new AbortController();
  const running = downloadImageRecipeInWorker({ files, signal: controller.signal, onProgress() {} });
  const result = expect(running).rejects.toThrow('Download paused'); controller.abort();
  expect(remote.cancel).toHaveBeenCalledOnce(); expect(worker.terminate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5000); await result;
  expect(worker.terminate).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
