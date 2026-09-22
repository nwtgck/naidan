// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryDirectory } from '@/features/llama-cpp-browser/hugging-face/test-opfs';
import { verifyStorage, type verifySharedStorage } from '@/features/llama-cpp-browser/runtime/shared-storage-probe';
import type { WorkerBlobReadHost } from '@/utils/worker-blob-context';
import type { WorkerServerApi } from '@/utils/worker-transport';
import { createLlamaCppWorkerClient } from './client-standalone';
import type { LlamaCppWorkerApi, LlamaCppWorkerClient } from './types';

const calls = vi.hoisted(() => ({
  createWorker: vi.fn(), release: vi.fn(),
  verify: vi.fn<typeof verifySharedStorage>(),
  remote: {
    verifyStorage: vi.fn<WorkerServerApi<LlamaCppWorkerApi>['verifyStorage']>(),
    listModels: vi.fn(), generate: vi.fn(), release: vi.fn(),
  },
}));
vi.mock('virtual:file-protocol-standalone/worker/llama-cpp-browser', () => ({ createStandaloneWorker: calls.createWorker }));
vi.mock('@/utils/worker-transport', async importOriginal => ({
  ...await importOriginal<typeof import('@/utils/worker-transport')>(),
  wrapWorkerRemote: () => calls.remote,
  releaseWorkerRemote: calls.release,
}));
vi.mock('../runtime/shared-storage-probe', async importOriginal => {
  const original = await importOriginal<typeof import('@/features/llama-cpp-browser/runtime/shared-storage-probe')>();
  return { ...original, verifySharedStorage: calls.verify.mockImplementation(original.verifySharedStorage) };
});

class TestWorker extends EventTarget {
  terminate = vi.fn();
}
let worker: TestWorker;
let root: ReturnType<typeof memoryDirectory>;
let client: LlamaCppWorkerClient;

function hostFromCall(): WorkerBlobReadHost {
  const host = calls.remote.verifyStorage.mock.calls[0]?.[1];
  if (host === undefined) throw new Error('Expected a top-level Blob host');
  return host;
}
async function assertHostClosed(): Promise<void> {
  await expect(hostFromCall().read({ blob: new Blob(['x']), offset: 0, length: 1 })).rejects.toMatchObject({ name: 'AbortError' });
}

beforeEach(() => {
  vi.clearAllMocks();
  worker = new TestWorker(); root = memoryDirectory({ name: '' });
  vi.stubGlobal('Worker', TestWorker);
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
  calls.createWorker.mockResolvedValue(worker);
  calls.release.mockResolvedValue(undefined);
  calls.remote.release.mockResolvedValue(undefined);
  calls.remote.listModels.mockResolvedValue([]);
  calls.remote.verifyStorage.mockImplementation(verifyStorage);
  client = createLlamaCppWorkerClient();
});
afterEach(async () => {
  client.dispose();
  await vi.waitFor(() => expect(worker.terminate).toHaveBeenCalledOnce());
  vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks();
});

describe('standalone llama shared-storage Blob host lifetime', () => {
  it('creates a startup-only host, closes it before model calls, and does not reprobe on reuse', async () => {
    expect(calls.createWorker).not.toHaveBeenCalled();
    await client.listModels({ signal: undefined });
    expect(calls.verify).toHaveBeenCalledOnce(); expect(calls.remote.verifyStorage).toHaveBeenCalledOnce();
    expect(calls.remote.verifyStorage.mock.calls[0]?.[0]).toEqual({ probeId: expect.any(String) });
    await assertHostClosed();
    expect(root.children.size).toBe(0); expect(client.canReuse()).toBe(true);
    await client.listModels({ signal: undefined });
    expect(calls.remote.listModels).toHaveBeenCalledTimes(2);
    expect(calls.remote.verifyStorage).toHaveBeenCalledOnce();
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it('keeps the host usable while verification is pending and closes it before exposing success', async () => {
    const entered = Promise.withResolvers<void>(); const finish = Promise.withResolvers<boolean>();
    calls.remote.verifyStorage.mockImplementationOnce(async () => {
      entered.resolve(); return finish.promise;
    });
    const pending = client.listModels({ signal: undefined });
    await entered.promise;
    expect(await hostFromCall().read({ blob: new Blob(['test']), offset: 1, length: 2 })).toEqual(new Uint8Array([101, 115]));
    expect(calls.remote.listModels).not.toHaveBeenCalled();
    finish.resolve(true); await pending;
    await assertHostClosed(); expect(root.children.size).toBe(0);
  });

  it.each(['mismatch', 'read-error'] as const)('does not expose a model client after %s and closes the host', async outcome => {
    switch (outcome) {
    case 'mismatch': calls.remote.verifyStorage.mockResolvedValueOnce(false); break;
    case 'read-error': calls.remote.verifyStorage.mockRejectedValueOnce(new Error('Worker could not read the nonce')); break;
    default: { const _ex: never = outcome; throw new Error(String(_ex)); }
    }
    await expect(client.listModels({ signal: undefined })).rejects.toThrow('unavailable');
    await assertHostClosed();
    await vi.waitFor(() => expect(worker.terminate).toHaveBeenCalledOnce());
    expect(root.children.size).toBe(0); expect(calls.remote.listModels).not.toHaveBeenCalled();
    expect(client.canReuse()).toBe(false);
  });

  it.each(['dispose', 'abort'] as const)('ends host requests on %s without adopting a late verification result', async action => {
    const entered = Promise.withResolvers<void>(); const finish = Promise.withResolvers<boolean>();
    calls.remote.verifyStorage.mockImplementationOnce(async () => {
      entered.resolve(); return finish.promise;
    });
    const controller = new AbortController();
    const pending = client.listModels({ signal: controller.signal });
    const rejection = expect(pending).rejects.toThrow(action === 'abort' ? 'aborted' : 'worker-failed');
    await entered.promise;
    switch (action) {
    case 'dispose': client.dispose(); break;
    case 'abort': controller.abort(); break;
    default: { const _ex: never = action; throw new Error(String(_ex)); }
    }
    await rejection; await assertHostClosed();
    finish.resolve(true);
    await vi.waitFor(() => expect(root.children.size).toBe(0));
    await expect(client.listModels({ signal: undefined })).rejects.toThrow('worker-failed');
    expect(calls.remote.listModels).not.toHaveBeenCalled(); expect(calls.createWorker).toHaveBeenCalledOnce();
  });

  it('times out a stalled verification, closes its host, and observes a late rejection', async () => {
    vi.useFakeTimers();
    const entered = Promise.withResolvers<void>(); const finish = Promise.withResolvers<boolean>();
    calls.remote.verifyStorage.mockImplementationOnce(async () => {
      entered.resolve(); return finish.promise;
    });
    const pending = client.listModels({ signal: undefined });
    const rejection = expect(pending).rejects.toThrow('worker-failed');
    await entered.promise;
    await vi.advanceTimersByTimeAsync(10_000); await rejection;
    await assertHostClosed();
    finish.reject(new Error('Late verification rejection'));
    await vi.advanceTimersByTimeAsync(0);
    expect(root.children.size).toBe(0); expect(calls.remote.listModels).not.toHaveBeenCalled();
    expect(client.canReuse()).toBe(false);
  });
});
