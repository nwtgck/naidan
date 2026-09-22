// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { createProviderReplayTestWorkerConstructor, type ProviderReplayTestWorker } from '@/features/transformers-js/replay-models/support/provider-replay-test-transport';
import { createDownloadSizeClient } from './client-hosted';

const request = { modelId: 'fixture/model', revision: 'a'.repeat(40), paths: ['onnx/a'] };
const workers: ProviderReplayTestWorker[] = [];

function installSilentWorker() {
  vi.stubGlobal('Worker', createProviderReplayTestWorkerConstructor({
    scriptUrl: new URL('./entry.ts', import.meta.url),
    onConstructed: ({ worker }) => {
      workers.push(worker);
    },
    start: async () => { /* An entry which never exposes its RPC. */ },
  }));
}
afterEach(() => {
  for (const worker of workers.splice(0)) worker.terminate();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

it('returns unknown when the optional Worker constructor throws', async () => {
  const constructor = vi.fn(function () {
    throw new Error('Synthetic CSP failure');
  });
  vi.stubGlobal('Worker', constructor);
  const client = createDownloadSizeClient();
  expect(await client.collect({ request })).toEqual({ sizes: [], quotaLimited: false });
  expect(constructor).toHaveBeenCalledOnce();
  expect(await client.collect({ request })).toEqual({ sizes: [], quotaLimited: false });
  expect(constructor).toHaveBeenCalledOnce();
});

it('bounds an unexposed Worker by the owner deadline without waiting for RPC cleanup', async () => {
  vi.useFakeTimers(); installSilentWorker();
  const client = createDownloadSizeClient();
  const result = client.collect({ request });
  expect(workers).toHaveLength(1);
  expect(workers[0]?.terminated).toBe(false);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(await result).toEqual({ sizes: [], quotaLimited: false });
  expect(workers[0]?.terminated).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('rejects reuse while the first observation is pending and retires the original owner', async () => {
  installSilentWorker();
  const client = createDownloadSizeClient();
  const first = client.collect({ request });
  expect(await client.collect({ request })).toEqual({ sizes: [], quotaLimited: false });
  expect(workers).toHaveLength(1);
  expect(workers[0]?.terminated).toBe(false);
  client.dispose();
  expect(await first).toEqual({ sizes: [], quotaLimited: false });
  expect(workers[0]?.terminated).toBe(true);
});

it('keeps optional retirement failure separate from its unknown observation result', async () => {
  installSilentWorker();
  const client = createDownloadSizeClient();
  const result = client.collect({ request });
  const worker = workers[0]!;
  const original = worker.terminate.bind(worker);
  const terminate = vi.spyOn(worker, 'terminate').mockImplementation(() => {
    original(); throw new Error('Synthetic cleanup failure');
  });
  expect(() => client.dispose()).not.toThrow();
  expect(await result).toEqual({ sizes: [], quotaLimited: false });
  expect(terminate).toHaveBeenCalledOnce();
  expect(worker.terminated).toBe(true);
  terminate.mockRestore();
});
