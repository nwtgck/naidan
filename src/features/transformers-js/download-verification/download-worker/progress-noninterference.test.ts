// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFiles } from '@/features/transformers-js/replay-models/support/download-memory-files';
import { createProviderReplayTestWorkerConstructor, type ProviderReplayTestWorker } from '@/features/transformers-js/replay-models/support/provider-replay-test-transport';
import type { ITransformersJsDownloadWorker, ProgressInfo } from '@/features/transformers-js/types';
import type { WorkerServerApi } from '@/utils/worker-transport';
import type { TransformersJsDownloadWorkerClient } from './client-hosted';
import { createDownloadProgressTracker } from '@/features/transformers-js/download-progress';

const revision = 'a'.repeat(40);
const baseUrl = `https://huggingface.co/fixture/progress/resolve/${revision}/`;
const basePath = `models/huggingface.co/fixture/progress/resolve/${revision}/`;
const urls = [`${baseUrl}onnx/model_q4.onnx`, `${baseUrl}onnx/model_q4.onnx_data`];
const modelPath = `${basePath}onnx/model_q4.onnx`;
const dataPath = `${basePath}onnx/model_q4.onnx_data`;
const modelMarker = `${basePath}onnx/.model_q4.onnx.complete`;
const dataMarker = `${basePath}onnx/.model_q4.onnx_data.complete`;
const committedFiles = [
  { path: modelMarker, bytes: [] },
  { path: dataMarker, bytes: [] },
  { path: modelPath, bytes: [1, 2, 3, 4] },
  { path: dataPath, bytes: [5, 6, 7, 8] },
].sort((a, b) => a.path.localeCompare(b.path));
const expectedResult = {
  complete: true, requestedCount: 2, cachedCount: 0, downloadedCount: 2, failedCount: 0,
  files: [
    { status: 'downloaded', url: urls[0], path: modelPath, byteLength: 4, expectedByteLength: 4 },
    { status: 'downloaded', url: urls[1], path: dataPath, byteLength: 4, expectedByteLength: 4 },
  ],
};
const ownedClients: TransformersJsDownloadWorkerClient[] = [];
const ownedWorkers: ProviderReplayTestWorker[] = [];

function fileSnapshot({ fs }: { fs: ReturnType<typeof createMemoryFiles> }) {
  return [...fs.files].map(([path, bytes]) => ({ path, bytes: Array.from(bytes) })).sort((a, b) => a.path.localeCompare(b.path));
}

async function createTransferFixture() {
  vi.resetModules();
  const fs = createMemoryFiles();
  fs.enter({ nextPhase: 'prefetch-progress', mutationPolicy: 'read-write' });
  const requests: Array<{ url: string; method: string }> = [];
  const responses: Response[] = [];
  const network = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    const index = urls.indexOf(request.url);
    if (index === -1 || request.method !== 'GET' || request.headers.has('Range')) throw new Error('Unprovided progress fixture request');
    requests.push({ url: request.url, method: request.method });
    const supplied = responses.shift();
    if (supplied !== undefined) return supplied;
    const bytes = index === 0 ? [1, 2, 3, 4] : [5, 6, 7, 8];
    let offset = 0;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) controller.close();
        else controller.enqueue(Uint8Array.of(bytes[offset++]!));
      },
    }, { highWaterMark: 0 }), { headers: { 'Content-Length': '4' } });
  });
  const unexpectedMetadata = vi.fn(async () => {
    throw new Error('Transfer controls must not invoke a model runtime');
  });
  vi.doMock('@huggingface/transformers', () => ({
    env: { backends: { onnx: { wasm: {}, logLevel: 'error' } } },
    AutoConfig: { from_pretrained: unexpectedMetadata },
    AutoTokenizer: { from_pretrained: unexpectedMetadata },
    AutoProcessor: { from_pretrained: unexpectedMetadata },
  }));
  let activeWorker: ProviderReplayTestWorker | undefined;
  const exposed = Promise.withResolvers<WorkerServerApi<ITransformersJsDownloadWorker>>();
  vi.doMock('@/utils/worker-transport', async () => {
    const actual = await vi.importActual<typeof import('@/utils/worker-transport')>('@/utils/worker-transport');
    return { ...actual, exposeWorkerRemote: ({ api, endpoint }: {
      api: WorkerServerApi<ITransformersJsDownloadWorker>, endpoint: Parameters<typeof actual.exposeWorkerRemote>[0]['endpoint'],
    }) => {
      if (endpoint !== undefined || activeWorker === undefined) throw new Error('Unexpected Download entry exposure');
      actual.exposeWorkerRemote<ITransformersJsDownloadWorker>({ api, endpoint: activeWorker.endpoint });
      exposed.resolve(api);
    } };
  });
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => fs.root }, hardwareConcurrency: 2, userAgent: 'Vitest', vendor: '' });
  vi.stubGlobal('fetch', network);
  vi.stubGlobal('self', { fetch: network, location: new URL('http://localhost/assets/download-worker.js') });
  vi.stubGlobal('Worker', createProviderReplayTestWorkerConstructor({
    scriptUrl: new URL('./entry.ts', import.meta.url),
    onConstructed: ({ worker }) => {
      activeWorker = worker;
      ownedWorkers.push(worker);
    },
    start: async () => {
      try {
        await import('./entry');
      } catch (error) {
        exposed.reject(error); throw error;
      }
    },
  }));
  const { createTransformersJsDownloadWorkerClient } = await import('./client-hosted');
  const client = createTransformersJsDownloadWorkerClient();
  ownedClients.push(client);
  const api = await exposed.promise;
  return { fs, client, api, requests, network, unexpectedMetadata, responses };
}

afterEach(async () => {
  try {
    await Promise.all(ownedClients.splice(0).map(client => client.dispose()));
    for (const worker of ownedWorkers.splice(0)) worker.terminate();
  } finally {
    vi.doUnmock('@huggingface/transformers');
    vi.doUnmock('@/utils/worker-transport');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  }
});

// Actual Download client/Comlink/native MessagePorts/entry/staging writer. The
// single Node Worker Realm, in-memory OPFS and exact tiny HTTP responses are
// platform controls, not captured model evidence or browser scheduling proof.
describe('Download progress observation does not control transfer', () => {
  it('preserves real bytes, markers and result when optional clock identity generation throws', async () => {
    const baseline = await createTransferFixture();
    const original = await baseline.client.prefetchUrls({ urls, progressCallback: () => undefined });
    const h = await createTransferFixture();
    const identity = vi.spyOn(crypto, 'randomUUID').mockImplementationOnce(() => {
      throw new Error('Synthetic unavailable timing identity');
    });
    const samples: ProgressInfo[] = [];
    const release = Promise.withResolvers<void>();
    h.responses.push(new Response(new ReadableStream<Uint8Array>({ async pull(controller) {
      await release.promise; controller.enqueue(Uint8Array.of(1, 2, 3, 4)); controller.close();
    } }, { highWaterMark: 0 }), { headers: { 'Content-Length': '4' } }));
    const running = h.client.prefetchUrls({ urls, progressCallback: ({ info }) => {
      samples.push(info);
    } });
    try {
      await vi.waitFor(() => expect(samples.some(info => info.downloadTiming === 'unavailable')).toBe(true));
    } finally {
      release.resolve();
    }
    const result = await running;
    expect(identity).toHaveBeenCalled();
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.some(info => info.downloadTiming === 'unavailable')).toBe(true);
    expect(samples.every(info => typeof info.downloadTiming !== 'object')).toBe(true);
    expect(result).toEqual(original);
    expect(result).toEqual(expectedResult);
    expect(h.requests).toEqual(baseline.requests);
    expect(fileSnapshot({ fs: h.fs })).toEqual(committedFiles);
    expect(h.unexpectedMetadata).not.toHaveBeenCalled();
  });

  it('carries coalesced source timing through real Comlink and invalidates ETA on a later sampling failure', async () => {
    const h = await createTransferFixture();
    let sourceTime = 20_000;
    let hostTime = 0;
    let inHost = false;
    let refuseSourceTime = false;
    const clockFailures: Error[] = [];
    vi.spyOn(performance, 'now').mockImplementation(() => {
      // Inject only at the real Worker's sampling boundary, not Vitest's own
      // performance clock or the deliberately separate host arrival clock.
      if (refuseSourceTime && /\bat timing\b/u.test(new Error().stack ?? '')) {
        const error = new Error('Synthetic source clock failure'); clockFailures.push(error); throw error;
      }
      return inHost ? hostTime : sourceTime;
    });
    const tracker = createDownloadProgressTracker();
    tracker.observe({ event: { kind: 'candidate', index: 0, count: 1, candidate: { device: 'wasm', dtype: 'q4' } } });
    tracker.observe({ event: { kind: 'plan', index: 0, paths: ['onnx/model_q4.onnx'] } });
    tracker.observe({ event: { kind: 'sizes', index: 0, sizes: [{ path: 'onnx/model_q4.onnx', bytes: 1000 }] } });
    const firstObserved = Promise.withResolvers<void>();
    const acknowledgement = Promise.withResolvers<void>();
    const produce = Promise.withResolvers<void>();
    const firstChunk = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const failSampling = Promise.withResolvers<void>();
    const failedChunk = Promise.withResolvers<void>();
    const samples: ProgressInfo[] = [];
    let stage = 0;
    h.responses.push(new Response(new ReadableStream<Uint8Array>({ async pull(controller) {
      const currentStage = stage++;
      if (currentStage === 0) {
        await produce.promise; sourceTime = 24_000;
        controller.enqueue(new Uint8Array(400));
      } else if (currentStage === 1) {
        firstChunk.resolve(); await failSampling.promise;
        controller.enqueue(Uint8Array.of(0));
      } else {
        failedChunk.resolve(); await finish.promise;
        controller.enqueue(new Uint8Array(599)); controller.close();
      }
    } }, { highWaterMark: 0 }), { headers: { 'Content-Length': '1000' } }));
    const running = h.client.prefetchUrls({ urls: [urls[0]!], progressCallback: ({ info }) => {
      samples.push(info);
      inHost = true;
      try {
        tracker.observe({ event: { kind: 'file', index: 0, info } });
      } finally {
        inHost = false;
      }
      if (info.status === 'download') {
        firstObserved.resolve(); return acknowledgement.promise;
      }
      return undefined;
    } });
    try {
      await Promise.race([firstObserved.promise, running.then(() => {
        throw new Error('Missing source start sample');
      })]);
      produce.resolve(); await firstChunk.promise;
      expect(samples.filter(info => info.downloadTiming !== undefined)).toHaveLength(1);
      hostTime = 150; acknowledgement.resolve();
      await vi.waitFor(() => expect(tracker.snapshot().files[0]?.loaded).toBe(400));
      const timed = samples.filter(info => info.downloadTiming !== undefined);
      expect(timed[0]?.downloadTiming).toMatchObject({ observedAtMs: 20_000 });
      const firstTiming = timed[0]?.downloadTiming;
      expect(timed[1]?.downloadTiming).toMatchObject({ clockId: typeof firstTiming === 'object' ? firstTiming.clockId : undefined, requestId: 1, observedAtMs: 24_000 });
      inHost = true;
      expect(tracker.snapshot().downloadEta).toEqual({ status: 'estimating', remainingSeconds: 6, bytesPerSecond: 100 });
      inHost = false;
      expect(h.fs.files.has(modelMarker)).toBe(false);
      refuseSourceTime = true; failSampling.resolve(); await failedChunk.promise;
      await vi.waitFor(() => expect(tracker.snapshot().files[0]?.loaded).toBe(401));
      expect(clockFailures).toHaveLength(1);
      expect(samples.at(-1)?.downloadTiming).toBe('unavailable');
      expect(tracker.snapshot().downloadEta).toEqual({ status: 'unavailable' });
      expect(h.fs.files.has(modelMarker)).toBe(false);
    } finally {
      inHost = false; acknowledgement.resolve(); produce.resolve(); failSampling.resolve(); finish.resolve(); await running;
      refuseSourceTime = false;
    }
    expect(h.requests).toEqual([{ url: urls[0], method: 'GET' }]);
    expect(h.fs.files.get(modelPath)?.byteLength).toBe(1000);
    expect(h.fs.files.has(modelMarker)).toBe(true);
    expect(clockFailures).toHaveLength(1);
    expect(tracker.snapshot().downloadEta).toEqual({ status: 'unavailable' });
  });

  it('shows a verified first file as complete while a later resource body is still transferring', async () => {
    const h = await createTransferFixture();
    const tracker = createDownloadProgressTracker();
    tracker.observe({ event: { kind: 'candidate', index: 0, count: 1, candidate: { device: 'wasm', dtype: 'q4' } } });
    tracker.observe({ event: { kind: 'plan', index: 0, paths: ['onnx/model_q4.onnx', 'onnx/model_q4.onnx_data'] } });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    h.responses.push(new Response(Uint8Array.of(1, 2, 3, 4), { headers: { 'Content-Length': '4' } }));
    h.responses.push(new Response(new ReadableStream<Uint8Array>({ async pull(controller) {
      entered.resolve(); await release.promise; controller.enqueue(Uint8Array.of(5, 6, 7, 8)); controller.close();
    } }, { highWaterMark: 0 }), { headers: { 'Content-Length': '4' } }));
    let settled = false;
    const running = h.client.prefetchUrls({ urls, progressCallback: ({ info }) => tracker.observe({ event: { kind: 'file', index: 0, info } }) }).finally(() => {
      settled = true;
    });
    try {
      await entered.promise;
      await vi.waitFor(() => expect(tracker.snapshot().files[0]).toMatchObject({ status: 'complete', loaded: 4, total: 4 }));
      expect(settled).toBe(false);
      expect(h.fs.files.has(modelMarker)).toBe(true);
      expect(h.fs.files.has(dataMarker)).toBe(false);
      expect(h.requests).toEqual(urls.map(url => ({ url, method: 'GET' })));
    } finally {
      release.resolve();
      expect(await running).toEqual(expectedResult);
    }
    expect(tracker.snapshot().files.map(file => file.status)).toEqual(['complete', 'complete']);
  });

  it('shows reused bytes from an earlier cached file while a later uncached resource is held', async () => {
    const h = await createTransferFixture();
    await h.client.prefetchUrls({ urls: [urls[0]!], progressCallback: () => undefined });
    h.requests.length = 0;
    const tracker = createDownloadProgressTracker();
    tracker.observe({ event: { kind: 'candidate', index: 0, count: 1, candidate: { device: 'wasm', dtype: 'q4' } } });
    tracker.observe({ event: { kind: 'plan', index: 0, paths: ['onnx/model_q4.onnx', 'onnx/model_q4.onnx_data'] } });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    h.responses.push(new Response(new ReadableStream<Uint8Array>({ async pull(controller) {
      entered.resolve(); await release.promise; controller.enqueue(Uint8Array.of(5, 6, 7, 8)); controller.close();
    } }, { highWaterMark: 0 }), { headers: { 'Content-Length': '4' } }));
    let settled = false;
    const running = h.client.prefetchUrls({ urls, progressCallback: ({ info }) => tracker.observe({ event: { kind: 'file', index: 0, info } }) }).finally(() => {
      settled = true;
    });
    try {
      await entered.promise;
      await vi.waitFor(() => expect(tracker.snapshot()).toMatchObject({ cachedBytes: 4, files: [{ status: 'cached', loaded: 4, total: 4 }, {}] }));
      expect(settled).toBe(false);
      expect(h.fs.files.has(dataMarker)).toBe(false);
      expect(h.requests).toEqual([{ url: urls[1], method: 'GET' }]);
    } finally {
      release.resolve();
      expect(await running).toMatchObject({ complete: true, cachedCount: 1, downloadedCount: 1, failedCount: 0 });
    }
    expect(tracker.snapshot().files.map(file => file.status)).toEqual(['cached', 'complete']);
  });

  it('shows an earlier file failure before a later resource finishes without changing the transfer result', async () => {
    const h = await createTransferFixture();
    const tracker = createDownloadProgressTracker();
    tracker.observe({ event: { kind: 'candidate', index: 0, count: 1, candidate: { device: 'wasm', dtype: 'q4' } } });
    tracker.observe({ event: { kind: 'plan', index: 0, paths: ['onnx/model_q4.onnx', 'onnx/model_q4.onnx_data'] } });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    h.responses.push(new Response('Unavailable', { status: 404 }));
    h.responses.push(new Response(new ReadableStream<Uint8Array>({ async pull(controller) {
      entered.resolve(); await release.promise; controller.enqueue(Uint8Array.of(5, 6, 7, 8)); controller.close();
    } }, { highWaterMark: 0 }), { headers: { 'Content-Length': '4' } }));
    let settled = false;
    const running = h.client.prefetchUrls({ urls, progressCallback: ({ info }) => tracker.observe({ event: { kind: 'file', index: 0, info } }) }).finally(() => {
      settled = true;
    });
    try {
      await entered.promise;
      await vi.waitFor(() => expect(tracker.snapshot().files[0]?.status).toBe('failed'));
      expect(settled).toBe(false);
      expect(h.fs.files.has(modelMarker)).toBe(false);
      expect(h.fs.files.has(dataMarker)).toBe(false);
      expect(h.requests).toEqual(urls.map(url => ({ url, method: 'GET' })));
    } finally {
      release.resolve();
      expect(await running).toMatchObject({ complete: false, downloadedCount: 1, failedCount: 1, files: [{ status: 'failed', failureStage: 'response-status', httpStatus: 404 }, { status: 'downloaded' }] });
    }
    expect(tracker.snapshot().files.map(file => file.status)).toEqual(['failed', 'complete']);
  });

  it('commits the fixed bytes and markers in URL order without an observing callback', async () => {
    const h = await createTransferFixture();
    const result = await h.client.prefetchUrls({ urls, progressCallback: () => undefined });
    expect(result).toEqual(expectedResult);
    expect(fileSnapshot({ fs: h.fs })).toEqual(committedFiles);
    expect(h.requests).toEqual(urls.map(url => ({ url, method: 'GET' })));
    expect(h.unexpectedMetadata).not.toHaveBeenCalled();
  });

  it('does not turn a synchronous direct-entry observer throw into an OPFS write failure', async () => {
    const h = await createTransferFixture();
    let notifications = 0;
    // Explicit direct-entry counterpart: a normal Comlink callback returns a
    // Promise, so it cannot represent this synchronous callback failure shape.
    const result = await h.api.prefetchUrls(urls, () => {
      notifications++;
      throw new Error('Synthetic synchronous progress observer failure');
    });
    expect(notifications).toBeGreaterThan(0);
    expect(result).toEqual(expectedResult);
    expect(fileSnapshot({ fs: h.fs })).toEqual(committedFiles);
    expect(h.requests).toEqual(urls.map(url => ({ url, method: 'GET' })));
  });

  it('isolates a throwing host observer across the real Comlink boundary', async () => {
    const h = await createTransferFixture();
    let notifications = 0;
    const result = await h.client.prefetchUrls({ urls, progressCallback: () => {
      notifications++;
      throw new Error('Synthetic host progress observer throw');
    } });
    expect(notifications).toBeGreaterThan(0);
    expect(result).toEqual(expectedResult);
    expect(fileSnapshot({ fs: h.fs })).toEqual(committedFiles);
    expect(h.requests).toEqual(urls.map(url => ({ url, method: 'GET' })));
  });

  it('preserves committed files and URL order with a rejecting host observer', async () => {
    const h = await createTransferFixture();
    let notifications = 0;
    const result = await h.client.prefetchUrls({ urls, progressCallback: async () => {
      notifications++;
      throw new Error('Synthetic host progress observer rejection');
    } });
    expect(notifications).toBeGreaterThan(0);
    expect(result).toEqual(expectedResult);
    expect(fileSnapshot({ fs: h.fs })).toEqual(committedFiles);
    expect(h.requests).toEqual(urls.map(url => ({ url, method: 'GET' })));
  });

  it('finishes writing while an asynchronous progress observer remains pending', async () => {
    const h = await createTransferFixture();
    const releaseObserver = Promise.withResolvers<void>();
    let notifications = 0;
    const result = h.client.prefetchUrls({ urls, progressCallback: () => {
      notifications++;
      return releaseObserver.promise;
    } });
    try {
      expect(await result).toEqual(expectedResult);
      expect(notifications).toBeGreaterThan(0);
      // At most one ordinary callback may remain awaiting its remote ACK;
      // final result reconciliation can additionally publish one per-file
      // terminal value without waiting for that unresponsive observer.
      expect(notifications).toBeLessThanOrEqual(urls.length + 1);
      expect(fileSnapshot({ fs: h.fs })).toEqual(committedFiles);
      expect(h.requests).toEqual(urls.map(url => ({ url, method: 'GET' })));
    } finally {
      releaseObserver.resolve();
      await result;
    }
  });

  it('preserves a genuine storage failure beside a completed second file when the observer throws', async () => {
    const h = await createTransferFixture();
    h.fs.writerCloseErrors.set(modelPath, new DOMException('Synthetic destination quota failure', 'QuotaExceededError'));
    const result = await h.client.prefetchUrls({ urls, progressCallback: () => {
      throw new Error('Synthetic irrelevant observer failure');
    } });
    expect(result).toMatchObject({ complete: false, requestedCount: 2, downloadedCount: 1, failedCount: 1, files: [
      { status: 'failed', url: urls[0], path: modelPath, failureStage: 'write', error: { name: 'QuotaExceededError', message: 'Synthetic destination quota failure' } },
      { status: 'downloaded', url: urls[1], path: dataPath, byteLength: 4, expectedByteLength: 4 },
    ] });
    expect(fileSnapshot({ fs: h.fs })).toEqual(committedFiles.filter(file => file.path === dataPath || file.path === dataMarker));
    expect(h.requests).toEqual(urls.map(url => ({ url, method: 'GET' })));
  });

  it('delivers committed terminal byte totals before returning the RPC result', async () => {
    const h = await createTransferFixture();
    const observations: ProgressInfo[] = [];
    const result = await h.client.prefetchUrls({ urls, progressCallback: ({ info }) => {
      observations.push(structuredClone(info));
    } });
    expect(result).toEqual(expectedResult);
    expect(observations.filter(info => info.status === 'done')).toMatchObject([
      { file: 'onnx/model_q4.onnx', loaded: 4, total: 4 },
      { file: 'onnx/model_q4.onnx_data', loaded: 4, total: 4 },
    ]);
    expect(fileSnapshot({ fs: h.fs })).toEqual(committedFiles);
  });

  it('preserves unknown-length response bytes and result semantics with a rejecting observer', async () => {
    const baseline = await createTransferFixture();
    baseline.responses.push(new Response(Uint8Array.of(1, 2, 3, 4)));
    const baselineResult = await baseline.client.prefetchUrls({ urls, progressCallback: () => undefined });
    expect(baselineResult).toEqual({ ...expectedResult, files: [
      { status: 'downloaded', url: urls[0], path: modelPath, byteLength: 4, expectedByteLength: undefined },
      expectedResult.files[1],
    ] });
    expect(fileSnapshot({ fs: baseline.fs })).toEqual(committedFiles);
    await baseline.client.dispose();

    const observed = await createTransferFixture();
    observed.responses.push(new Response(Uint8Array.of(1, 2, 3, 4)));
    const notifications: ProgressInfo[] = [];
    const result = await observed.client.prefetchUrls({ urls, progressCallback: async ({ info }) => {
      notifications.push(structuredClone(info));
      throw new Error('Synthetic unknown-length observer rejection');
    } });
    expect(result).toEqual(baselineResult);
    expect(fileSnapshot({ fs: observed.fs })).toEqual(committedFiles);
    expect(baseline.requests).toEqual(urls.map(url => ({ url, method: 'GET' })));
    expect(observed.requests).toEqual(baseline.requests);
    expect(notifications.filter(info => info.status === 'done')).toMatchObject([
      { file: 'onnx/model_q4.onnx', loaded: 4, total: 4 },
      { file: 'onnx/model_q4.onnx_data', loaded: 4, total: 4 },
    ]);
  });

  it('keeps a zero Content-Length with nonempty bytes a write failure even when the observer throws', async () => {
    const baseline = await createTransferFixture();
    baseline.responses.push(new Response(Uint8Array.of(1, 2, 3, 4), { headers: { 'Content-Length': '0' } }));
    const baselineResult = await baseline.client.prefetchUrls({ urls, progressCallback: () => undefined });
    expect(baselineResult).toMatchObject({ complete: false, downloadedCount: 1, failedCount: 1, files: [
      { status: 'failed', path: modelPath, failureStage: 'write', transferObservation: { receivedBytes: 4, expectedBytes: 0 } },
      expectedResult.files[1],
    ] });
    expect(fileSnapshot({ fs: baseline.fs })).toEqual(committedFiles.filter(file => file.path === dataPath || file.path === dataMarker));
    await baseline.client.dispose();

    const observed = await createTransferFixture();
    observed.responses.push(new Response(Uint8Array.of(1, 2, 3, 4), { headers: { 'Content-Length': '0' } }));
    const notifications: ProgressInfo[] = [];
    const result = await observed.client.prefetchUrls({ urls, progressCallback: ({ info }) => {
      notifications.push(structuredClone(info));
      throw new Error('Synthetic zero-length observer failure');
    } });
    expect(result).toEqual(baselineResult);
    expect(fileSnapshot({ fs: observed.fs })).toEqual(committedFiles.filter(file => file.path === dataPath || file.path === dataMarker));
    expect(baseline.requests).toEqual(urls.map(url => ({ url, method: 'GET' })));
    expect(observed.requests).toEqual(baseline.requests);
    expect(notifications.filter(info => info.status === 'error')).toEqual([
      { status: 'error', file: 'onnx/model_q4.onnx', loaded: 4, total: 0 },
    ]);
  });

  it('preserves a short-body failure and its received bytes while the observer remains pending', async () => {
    const baseline = await createTransferFixture();
    baseline.responses.push(new Response(Uint8Array.of(1, 2, 3, 4), { headers: { 'Content-Length': '8' } }));
    const baselineResult = await baseline.client.prefetchUrls({ urls, progressCallback: () => undefined });
    expect(baselineResult).toMatchObject({ complete: false, downloadedCount: 1, failedCount: 1, files: [
      { status: 'failed', path: modelPath, failureStage: 'write', transferObservation: { receivedBytes: 4, expectedBytes: 8 } },
      expectedResult.files[1],
    ] });
    expect(fileSnapshot({ fs: baseline.fs })).toEqual(committedFiles.filter(file => file.path === dataPath || file.path === dataMarker));
    await baseline.client.dispose();

    const observed = await createTransferFixture();
    observed.responses.push(new Response(Uint8Array.of(1, 2, 3, 4), { headers: { 'Content-Length': '8' } }));
    const held = Promise.withResolvers<void>();
    const notifications: ProgressInfo[] = [];
    const running = observed.client.prefetchUrls({ urls, progressCallback: ({ info }) => {
      notifications.push(structuredClone(info));
      return held.promise;
    } });
    try {
      expect(await running).toEqual(baselineResult);
      expect(fileSnapshot({ fs: observed.fs })).toEqual(committedFiles.filter(file => file.path === dataPath || file.path === dataMarker));
      expect(baseline.requests).toEqual(urls.map(url => ({ url, method: 'GET' })));
      expect(observed.requests).toEqual(baseline.requests);
      expect(notifications.filter(info => info.status === 'error')).toEqual([
        { status: 'error', file: 'onnx/model_q4.onnx', loaded: 4, total: 8 },
      ]);
      expect(notifications.length).toBeLessThanOrEqual(urls.length + 1);
    } finally {
      held.resolve();
      await running;
    }
  });

  it('reconciles the bytes received before a stream error without awaiting a held observer', async () => {
    const h = await createTransferFixture();
    let sent = false;
    h.responses.push(new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) controller.error(new Error('Synthetic response interruption'));
        else {
          sent = true;
          controller.enqueue(Uint8Array.of(1, 2));
        }
      },
    }, { highWaterMark: 0 }), { headers: { 'Content-Length': '4' } }));
    const held = Promise.withResolvers<void>();
    const notifications: ProgressInfo[] = [];
    const running = h.client.prefetchUrls({ urls, progressCallback: ({ info }) => {
      notifications.push(structuredClone(info));
      return held.promise;
    } });
    try {
      expect(await running).toMatchObject({ complete: false, downloadedCount: 1, failedCount: 1, files: [
        { status: 'failed', path: modelPath, failureStage: 'write', error: { message: 'Synthetic response interruption' }, transferObservation: { receivedBytes: 2, expectedBytes: 4 } },
        expectedResult.files[1],
      ] });
      expect(fileSnapshot({ fs: h.fs })).toEqual(committedFiles.filter(file => file.path === dataPath || file.path === dataMarker));
      expect(h.requests).toEqual(urls.map(url => ({ url, method: 'GET' })));
      expect(notifications.filter(info => info.status === 'error')).toEqual([
        { status: 'error', file: 'onnx/model_q4.onnx', loaded: 2, total: 4 },
      ]);
      expect(notifications.length).toBeLessThanOrEqual(urls.length + 1);
    } finally {
      held.resolve();
      await running;
    }
  });

  it('reuses a complete artifact but restarts an unmarked partial artifact from byte zero with or without observation', async () => {
    const baseline = await createTransferFixture();
    expect(await baseline.client.prefetchUrls({ urls, progressCallback: () => undefined })).toEqual(expectedResult);
    // Explicit OPFS interrupted-run control: directory structure is real, but
    // this fixture removes the completion marker and replaces one saved body.
    baseline.fs.files.delete(dataMarker);
    baseline.fs.files.set(dataPath, Uint8Array.of(99));
    baseline.requests.length = 0;
    const baselineResult = await baseline.client.prefetchUrls({ urls, progressCallback: () => undefined });
    expect(baselineResult).toEqual({ ...expectedResult, cachedCount: 1, downloadedCount: 1, files: [
      { status: 'cached', url: urls[0], path: modelPath, byteLength: 4, expectedByteLength: undefined },
      expectedResult.files[1],
    ] });
    expect(fileSnapshot({ fs: baseline.fs })).toEqual(committedFiles);
    await baseline.client.dispose();

    const observed = await createTransferFixture();
    expect(await observed.client.prefetchUrls({ urls, progressCallback: () => undefined })).toEqual(expectedResult);
    observed.fs.files.delete(dataMarker);
    observed.fs.files.set(dataPath, Uint8Array.of(99));
    observed.requests.length = 0;
    const notifications: ProgressInfo[] = [];
    const result = await observed.client.prefetchUrls({ urls, progressCallback: async ({ info }) => {
      notifications.push(structuredClone(info));
      throw new Error('Synthetic mixed-cache observer rejection');
    } });
    expect(result).toEqual(baselineResult);
    expect(fileSnapshot({ fs: observed.fs })).toEqual(committedFiles);
    // The exact fetch guard rejects any Range header; bytes cannot be appended
    // to the sentinel partial file or fetched for the already complete model.
    expect(baseline.requests).toEqual([{ url: urls[1], method: 'GET' }]);
    expect(observed.requests).toEqual(baseline.requests);
    expect(notifications.filter(info => info.status === 'cached')).toMatchObject([
      { file: 'onnx/model_q4.onnx', loaded: 4, total: 4 },
    ]);
    expect(notifications.filter(info => info.status === 'done')).toMatchObject([
      { file: 'onnx/model_q4.onnx_data', loaded: 4, total: 4 },
    ]);
  });

  it('reports cached terminal bytes without refetching or rewriting committed artifacts', async () => {
    const h = await createTransferFixture();
    expect(await h.client.prefetchUrls({ urls, progressCallback: () => undefined })).toEqual(expectedResult);
    h.fs.activity.length = 0;
    h.fs.enter({ nextPhase: 'progress-cached-reuse', mutationPolicy: 'read-only' });
    const observations: ProgressInfo[] = [];
    const result = await h.client.prefetchUrls({ urls, progressCallback: ({ info }) => {
      observations.push(structuredClone(info));
    } });
    expect(result).toEqual({
      complete: true, requestedCount: 2, cachedCount: 2, downloadedCount: 0, failedCount: 0,
      files: [
        { status: 'cached', url: urls[0], path: modelPath, byteLength: 4, expectedByteLength: undefined },
        { status: 'cached', url: urls[1], path: dataPath, byteLength: 4, expectedByteLength: undefined },
      ],
    });
    expect(observations.filter(info => info.status === 'cached')).toMatchObject([
      { file: 'onnx/model_q4.onnx', loaded: 4, total: 4 },
      { file: 'onnx/model_q4.onnx_data', loaded: 4, total: 4 },
    ]);
    expect(h.requests).toEqual(urls.map(url => ({ url, method: 'GET' })));
    expect(h.fs.activity.every(item => item.operation === 'stat')).toBe(true);
    expect(fileSnapshot({ fs: h.fs })).toEqual(committedFiles);
  });
});
