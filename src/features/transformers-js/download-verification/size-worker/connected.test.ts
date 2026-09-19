// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { createProviderReplayTestWorkerConstructor, type ProviderReplayTestWorker } from '@/features/transformers-js/replay-models/support/provider-replay-test-transport';
import { createDownloadProgressTracker } from '@/features/transformers-js/download-progress';
import type { WorkerServerApi } from '@/utils/worker-transport';
import type { DownloadSizeWorkerApi } from './types';
import type { TransformersJsProgressCallback } from '@/features/transformers-js/types';
import type { ITransformersJsDownloadWorker } from '@/features/transformers-js/types';
import { createMemoryFiles } from '@/features/transformers-js/replay-models/support/download-memory-files';

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), accept: vi.fn() }));
vi.mock('../logic/prepare-production-runtime-artifacts', () => ({ prepareProductionRuntimeArtifacts: async () => ({
  status: 'prepared', resourcePlansByCandidate: { 'wasm/q4': { status: 'ready', paths: ['onnx/a', 'onnx/b'] } },
}) }));
vi.mock('../logic/prepare-production-model-candidate', () => ({ prepareProductionModelCandidate: mocks.prepare }));
vi.mock('../logic/accept-downloaded-production-candidate', () => ({ acceptDownloadedProductionCandidate: mocks.accept }));
const workers: ProviderReplayTestWorker[] = [];

async function installSizeWorker({ network }: { network: typeof fetch }) {
  vi.resetModules();
  let active: ProviderReplayTestWorker | undefined;
  vi.doMock('@/utils/worker-transport', async () => {
    const actual = await vi.importActual<typeof import('@/utils/worker-transport')>('@/utils/worker-transport');
    return { ...actual, exposeWorkerRemote: ({ api }: { api: WorkerServerApi<DownloadSizeWorkerApi> }) => {
      if (active === undefined) throw new Error('No size Worker endpoint');
      actual.exposeWorkerRemote<DownloadSizeWorkerApi>({ api, endpoint: active.endpoint });
    } };
  });
  vi.stubGlobal('fetch', network);
  vi.stubGlobal('Worker', createProviderReplayTestWorkerConstructor({
    scriptUrl: new URL('./entry.ts', import.meta.url),
    onConstructed: ({ worker }) => {
      active = worker; workers.push(worker);
    },
    start: async () => {
      await import('./entry');
    },
  }));
}
afterEach(() => {
  for (const worker of workers.splice(0)) worker.terminate();
  vi.doUnmock('@/utils/worker-transport'); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetAllMocks();
  vi.doUnmock('@huggingface/transformers');
  vi.useRealTimers();
});

// Real orchestration + size client/Comlink/entry/HTTP parser + tracker. Resource
// acquisition and runtime acceptance are explicit synthetic held boundaries;
// writer noninterference is separately exercised with real tiny OPFS transfers.
it('connects successful exact-path size metadata without waiting to start acquisition', async () => {
  const headers = Promise.withResolvers<Response>();
  const requested = Promise.withResolvers<void>();
  const network = vi.fn<typeof fetch>(() => {
    requested.resolve(); return headers.promise;
  });
  await installSizeWorker({ network });
  const transfer = Promise.withResolvers<{ status: 'ready'; prefetch: { complete: true } }>();
  const started = Promise.withResolvers<void>();
  let progress: TransformersJsProgressCallback | undefined;
  mocks.prepare.mockImplementation(({ onPlan, progressCallback }: { onPlan: ({ paths }: { paths: string[] }) => void; progressCallback: TransformersJsProgressCallback }) => {
    onPlan({ paths: ['onnx/a', 'onnx/b'] }); progress = progressCallback; started.resolve(); return transfer.promise;
  });
  mocks.accept.mockResolvedValue({ status: 'accepted' });
  const tracker = createDownloadProgressTracker();
  const { runProductionDownloadPreparation } = await import('@/features/transformers-js/download-verification/logic/run-production-download-preparation');
  const running = runProductionDownloadPreparation({ modelId: 'hf.co/fixture/model', revision: 'a'.repeat(40), candidateOrder: [{ device: 'wasm', dtype: 'q4' }], onDownloadProgress: ({ event }) => tracker.observe({ event }) });
  await started.promise; await requested.promise;
  expect(tracker.snapshot().overallProgress).toBeUndefined();
  expect(mocks.prepare).toHaveBeenCalledOnce(); expect(mocks.accept).not.toHaveBeenCalled();
  expect(network.mock.calls[0]?.[0]).toBe('https://huggingface.co/api/models/fixture/model/paths-info/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  headers.resolve(Response.json([{ type: 'file', path: 'onnx/a', size: 100 }, { type: 'file', path: 'onnx/b', size: 100 }]));
  await vi.waitFor(() => expect(tracker.snapshot().knownTotalBytes).toBe(200));
  progress?.({ info: { status: 'done', file: 'onnx/a', loaded: 100, total: 100 } });
  progress?.({ info: { status: 'progress', file: 'onnx/b', loaded: 50 } });
  expect(tracker.snapshot().overallProgress).toBe(72);
  progress?.({ info: { status: 'done', file: 'onnx/b', loaded: 100, total: 100 } });
  expect(tracker.snapshot().overallProgress).toBe(94);
  expect(mocks.accept).not.toHaveBeenCalled();
  transfer.resolve({ status: 'ready', prefetch: { complete: true } });
  expect(await running).toMatchObject({ status: 'accepted' });
  expect(tracker.snapshot().overallProgress).toBe(95);
  expect(mocks.accept).toHaveBeenCalledOnce(); expect(network).toHaveBeenCalledOnce();
});

it('finishes acquisition while size HTTP is held and discards the retired owner result', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const response = Promise.withResolvers<Response>();
  const requested = Promise.withResolvers<void>();
  let probeAborted = false;
  const network = vi.fn<typeof fetch>((_input, init) => {
    init?.signal?.addEventListener('abort', () => {
      probeAborted = true;
    }, { once: true });
    requested.resolve(); return response.promise;
  });
  await installSizeWorker({ network });
  const transfer = Promise.withResolvers<{ status: 'ready'; prefetch: { complete: true } }>();
  mocks.prepare.mockImplementation(({ onPlan, progressCallback }: { onPlan: ({ paths }: { paths: string[] }) => void; progressCallback: TransformersJsProgressCallback }) => {
    onPlan({ paths: ['onnx/a', 'onnx/b'] });
    progressCallback({ info: { status: 'done', file: 'onnx/a', loaded: 4, total: 4 } });
    progressCallback({ info: { status: 'done', file: 'onnx/b', loaded: 4, total: 4 } });
    return transfer.promise;
  });
  mocks.accept.mockResolvedValue({ status: 'accepted' });
  const tracker = createDownloadProgressTracker();
  const { runProductionDownloadPreparation } = await import('@/features/transformers-js/download-verification/logic/run-production-download-preparation');
  const running = runProductionDownloadPreparation({ modelId: 'fixture/model', revision: 'a'.repeat(40), candidateOrder: [{ device: 'wasm', dtype: 'q4' }], onDownloadProgress: ({ event }) => tracker.observe({ event }) });
  await requested.promise;
  transfer.resolve({ status: 'ready', prefetch: { complete: true } });
  expect(await running).toMatchObject({ status: 'accepted' });
  const final = tracker.snapshot();
  expect(probeAborted).toBe(false);
  response.resolve(Response.json([{ type: 'file', path: 'onnx/a', size: 999 }]));
  expect(workers[0]?.terminated).toBe(true);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(tracker.snapshot()).toEqual(final);
  expect(network).toHaveBeenCalledOnce(); expect(mocks.accept).toHaveBeenCalledOnce();
});

it('commits real prefetch bytes and markers in original order while the independent size request is held', async () => {
  // The optional deadline cannot fire until after acquisition settles. An
  // accidental await of the probe would stall, rather than pass two seconds later.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.resetModules();
  const fs = createMemoryFiles(); fs.enter({ nextPhase: 'prefetch-progress', mutationPolicy: 'read-write' });
  const revision = 'a'.repeat(40);
  const urls = [`https://huggingface.co/fixture/model/resolve/${revision}/onnx/a`, `https://huggingface.co/fixture/model/resolve/${revision}/onnx/b`];
  const optionalResponse = Promise.withResolvers<Response>();
  const optionalStarted = Promise.withResolvers<void>();
  const lateCanceled = Promise.withResolvers<void>();
  const firstBodyStarted = Promise.withResolvers<void>();
  const releaseBody = Promise.withResolvers<void>();
  const artifactRequests: string[] = [];
  const sizeRequests: string[] = [];
  let probeAborted = false;
  const network = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    if (request.url === `https://huggingface.co/api/models/fixture/model/paths-info/${revision}` && request.method === 'POST') {
      init?.signal?.addEventListener('abort', () => {
        probeAborted = true;
      }, { once: true });
      sizeRequests.push(request.url); optionalStarted.resolve(); return optionalResponse.promise;
    }
    const index = urls.indexOf(request.url);
    if (index < 0 || request.method !== 'GET' || request.headers.has('Range')) throw new Error('Unexpected integration request');
    artifactRequests.push(request.url);
    return new Response(new ReadableStream<Uint8Array>({ async pull(controller) {
      if (index === 0) {
        firstBodyStarted.resolve(); await releaseBody.promise;
      }
      controller.enqueue(index === 0 ? Uint8Array.of(1, 2, 3, 4) : Uint8Array.of(5, 6, 7, 8)); controller.close();
    } }, { highWaterMark: 0 }), { headers: { 'Content-Length': '4' } });
  });
  const unexpectedRuntime = vi.fn(async () => {
    throw new Error('No runtime permitted in this writer control');
  });
  vi.doMock('@huggingface/transformers', () => ({ env: { backends: { onnx: { wasm: {}, logLevel: 'error' } } }, AutoConfig: { from_pretrained: unexpectedRuntime }, AutoTokenizer: { from_pretrained: unexpectedRuntime }, AutoProcessor: { from_pretrained: unexpectedRuntime } }));
  let sizeWorker: ProviderReplayTestWorker | undefined;
  let downloadWorker: ProviderReplayTestWorker | undefined;
  vi.doMock('@/utils/worker-transport', async () => {
    const actual = await vi.importActual<typeof import('@/utils/worker-transport')>('@/utils/worker-transport');
    return { ...actual, exposeWorkerRemote: ({ api }: { api: WorkerServerApi<DownloadSizeWorkerApi> | WorkerServerApi<ITransformersJsDownloadWorker> }) => {
      // Two exact entries have distinct native endpoints, not a mutable active
      // Realm selector. Unknown exposed APIs cannot borrow either endpoint.
      if ('prefetchUrls' in api && downloadWorker !== undefined) actual.exposeWorkerRemote<ITransformersJsDownloadWorker>({ api, endpoint: downloadWorker.endpoint });
      else if ('collect' in api && sizeWorker !== undefined) actual.exposeWorkerRemote<DownloadSizeWorkerApi>({ api, endpoint: sizeWorker.endpoint });
      else throw new Error('Unexpected integration exposure');
    } };
  });
  const sizeEntry = new URL('./entry.ts', import.meta.url);
  const downloadEntry = new URL('../download-worker/entry.ts', import.meta.url);
  const SizeWorker = createProviderReplayTestWorkerConstructor({ scriptUrl: sizeEntry, onConstructed: ({ worker }) => {
    sizeWorker = worker; workers.push(worker);
  }, start: async () => {
    await import('./entry');
  } });
  const DownloadWorker = createProviderReplayTestWorkerConstructor({ scriptUrl: downloadEntry, onConstructed: ({ worker }) => {
    downloadWorker = worker; workers.push(worker);
  }, start: async () => {
    await import('@/features/transformers-js/download-verification/download-worker/entry');
  } });
  vi.stubGlobal('Worker', function Worker(url: string | URL, options: WorkerOptions | undefined) {
    if (String(url) === sizeEntry.href) return new SizeWorker(url, options);
    if (String(url) === downloadEntry.href) return new DownloadWorker(url, options);
    throw new Error('Unexpected Worker entry');
  });
  vi.stubGlobal('fetch', network);
  vi.stubGlobal('self', { fetch: network, location: new URL('http://localhost/assets/download-worker.js') });
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => fs.root }, hardwareConcurrency: 2, userAgent: 'Vitest', vendor: '' });
  const { createTransformersJsDownloadWorkerClient } = await import('@/features/transformers-js/download-verification/download-worker/client-hosted');
  const client = createTransformersJsDownloadWorkerClient();
  mocks.prepare.mockImplementation(async ({ onPlan, progressCallback }: { onPlan: ({ paths }: { paths: string[] }) => void; progressCallback: TransformersJsProgressCallback }) => {
    onPlan({ paths: ['onnx/a', 'onnx/b'] });
    const prefetch = await client.prefetchUrls({ urls, progressCallback });
    return { status: 'ready', prefetch };
  });
  mocks.accept.mockResolvedValue({ status: 'accepted' });
  const tracker = createDownloadProgressTracker();
  const { runProductionDownloadPreparation } = await import('@/features/transformers-js/download-verification/logic/run-production-download-preparation');
  const running = runProductionDownloadPreparation({ modelId: 'fixture/model', revision, candidateOrder: [{ device: 'wasm', dtype: 'q4' }], onDownloadProgress: ({ event }) => tracker.observe({ event }) });
  try {
    await Promise.race([Promise.all([optionalStarted.promise, firstBodyStarted.promise]), running.then(() => {
      throw new Error('Premature orchestration settlement');
    })]);
    expect(tracker.snapshot().overallProgress).toBeUndefined();
    expect(sizeRequests).toHaveLength(1);
    expect(artifactRequests).toEqual([urls[0]]);
    expect(mocks.accept).not.toHaveBeenCalled();
    releaseBody.resolve();
    expect(await running).toMatchObject({ status: 'accepted' });
    expect(artifactRequests).toEqual(urls);
    expect(probeAborted).toBe(false);
    const root = `models/huggingface.co/fixture/model/resolve/${revision}/onnx/`;
    expect([...fs.files].map(([path, bytes]) => ({ path, bytes: [...bytes] })).sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: `${root}.a.complete`, bytes: [] }, { path: `${root}.b.complete`, bytes: [] },
      { path: `${root}a`, bytes: [1, 2, 3, 4] }, { path: `${root}b`, bytes: [5, 6, 7, 8] },
    ]);
    expect(tracker.snapshot()).toMatchObject({ overallProgress: 95, receivedBytes: 8, completedFileCount: 2 });
    expect(mocks.accept).toHaveBeenCalledOnce();
    expect(unexpectedRuntime).not.toHaveBeenCalled();
    const final = tracker.snapshot();
    await vi.advanceTimersByTimeAsync(2_000);
    optionalResponse.resolve(new Response(new ReadableStream({ cancel() {
      lateCanceled.resolve();
    } })));
    await lateCanceled.promise;
    expect(tracker.snapshot()).toEqual(final);
    expect(sizeWorker?.terminated).toBe(true);
  } finally {
    releaseBody.resolve(); optionalResponse.resolve(Response.json([]));
    await running; await client.dispose();
  }
});
