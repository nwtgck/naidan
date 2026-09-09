// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { createMemoryFiles } from '@/features/transformers-js/download-verification/fixtures/raw-download-replay/memory-files';
import { writeToOpfsWithStaging } from '@/features/transformers-js/utils';
import type { ITransformersJsDownloadWorker } from '@/features/transformers-js/types';
import type { WorkerServerApi } from '@/utils/worker-transport';

const revision = 'a'.repeat(40);
const url = `https://huggingface.co/fixture/transfer/resolve/${revision}/onnx/model_q4.onnx_data`;
const path = `models/huggingface.co/fixture/transfer/resolve/${revision}/onnx/model_q4.onnx_data`;
const marker = `models/huggingface.co/fixture/transfer/resolve/${revision}/onnx/.model_q4.onnx_data.complete`;

async function fixture() {
  vi.resetModules();
  const fs = createMemoryFiles();
  fs.enter({ nextPhase: 'prefetch', mutationPolicy: 'read-write' });
  const transport = vi.fn<typeof fetch>(async () => {
    throw new Error('Unconfigured fixture response');
  });
  const network = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== url || request.method !== 'GET') throw new Error('Unexpected prefetch fixture request');
    return transport(input, init);
  });
  // This suite checks the real transfer entry and writer, not model selection.
  // The independent model tests exercise the actual Transformers.js bundle.
  const unexpectedMetadata = vi.fn(async () => {
    throw new Error('Prefetch must not initialize runtime metadata');
  });
  vi.doMock('@huggingface/transformers', () => ({
    env: { backends: { onnx: { wasm: {}, logLevel: 'error' } } },
    AutoConfig: { from_pretrained: unexpectedMetadata },
    AutoTokenizer: { from_pretrained: unexpectedMetadata },
    AutoProcessor: { from_pretrained: unexpectedMetadata },
  }));
  let exposed: WorkerServerApi<ITransformersJsDownloadWorker> | undefined;
  vi.doMock('@/utils/worker-transport', () => ({
    exposeWorkerRemote: ({ api }: { api: WorkerServerApi<ITransformersJsDownloadWorker> }) => {
      exposed = api;
    },
  }));
  const getDirectory = vi.fn(async () => fs.root);
  vi.stubGlobal('navigator', { storage: { getDirectory }, hardwareConcurrency: 2, userAgent: 'Vitest', vendor: '' });
  vi.stubGlobal('fetch', network);
  vi.stubGlobal('self', { fetch: network, location: new URL('http://localhost/assets/download-worker.js') });
  await import('./entry');
  if (!exposed) throw new Error('Missing Download Worker fixture API');
  return { fs, api: exposed, network, transport, getDirectory, unexpectedMetadata };
}

afterEach(() => {
  vi.doUnmock('@huggingface/transformers');
  vi.doUnmock('@/utils/worker-transport');
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('does not promote an unsolicited HTTP 206 model response to a complete file', async () => {
  const h = await fixture();
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    controller.enqueue(Uint8Array.of(1, 2));
    controller.close();
  });
  const cancel = vi.fn();
  h.transport.mockResolvedValueOnce(new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), {
    status: 206, headers: { 'Content-Length': '2', 'Content-Range': 'bytes 0-1/100' },
  }));
  const result = await h.api.prefetchUrls([url], () => undefined);
  expect(result).toMatchObject({ complete: false, downloadedCount: 0, failedCount: 1, files: [{
    status: 'failed', failureStage: 'response-status', httpStatus: 206,
  }] });
  expect(h.fs.files.has(marker)).toBe(false);
  expect(h.fs.files.has(path)).toBe(false);
  expect(h.fs.activity.filter(item => item.operation !== 'stat')).toEqual([]);
  expect(pull).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledOnce();
});

it('does not mark a fresh split artifact complete after its network stream is interrupted', async () => {
  const h = await fixture();
  let pulls = 0;
  h.transport.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulls++ === 0) controller.enqueue(Uint8Array.of(7));
      else controller.error(new Error('Fixture transfer interrupted'));
    },
  }, { highWaterMark: 0 }), { headers: { 'Content-Length': '2' } }));
  const progress = vi.fn();
  const result = await h.api.prefetchUrls([url], progress);

  expect(result).toMatchObject({ complete: false, downloadedCount: 0, failedCount: 1, files: [{
    status: 'failed', path, failureStage: 'write', error: { message: 'Fixture transfer interrupted' },
  }] });
  expect(progress).toHaveBeenCalledWith(expect.objectContaining({ status: 'progress', loaded: 1, total: 2 }));
  expect(h.fs.files.has(marker)).toBe(false);
  expect(h.fs.files.has(path)).toBe(false);
  expect([...h.fs.files.keys()].some(key => key.includes('.staging-'))).toBe(false);
  expect(h.network).toHaveBeenCalledTimes(1);
  expect(h.unexpectedMetadata).not.toHaveBeenCalled();
});

it('does not publish completion when the final promotion writable fails to close', async () => {
  const h = await fixture();
  h.fs.writerCloseErrors.set(path, new DOMException('Fixture promotion failed', 'QuotaExceededError'));
  h.transport.mockResolvedValueOnce(new Response(Uint8Array.of(1, 2), { headers: { 'Content-Length': '2' } }));
  const result = await h.api.prefetchUrls([url], () => undefined);

  expect(result).toMatchObject({ complete: false, downloadedCount: 0, failedCount: 1, files: [{
    status: 'failed', path, failureStage: 'write', error: { name: 'QuotaExceededError' },
  }] });
  expect(h.fs.files.has(marker)).toBe(false);
  expect(h.fs.files.has(path)).toBe(false);
  expect([...h.fs.files.keys()].some(key => key.includes('.staging-'))).toBe(false);
  expect(h.network).toHaveBeenCalledTimes(1);
});

it('retries an interrupted artifact explicitly instead of treating the partial write as cached', async () => {
  const h = await fixture();
  h.transport.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new DOMException('Fixture interrupted', 'AbortError'));
    },
  }, { highWaterMark: 0 })));
  expect(await h.api.prefetchUrls([url], () => undefined)).toMatchObject({ complete: false, failedCount: 1 });
  expect(h.fs.files.has(marker)).toBe(false);

  h.transport.mockResolvedValueOnce(new Response(Uint8Array.of(3, 4), { headers: { 'Content-Length': '2' } }));
  expect(await h.api.prefetchUrls([url], () => undefined)).toMatchObject({ complete: true, cachedCount: 0, downloadedCount: 1, failedCount: 0 });
  expect(h.fs.files.get(path)).toEqual(Uint8Array.of(3, 4));
  expect(h.fs.files.has(marker)).toBe(true);
  expect(h.network).toHaveBeenCalledTimes(2);
  expect(h.fs.activity.filter(item => item.path === marker && item.operation === 'create-file')).toHaveLength(1);
  expect([...h.fs.files.keys()].some(key => key.includes('.staging-'))).toBe(false);
});

it('reuses a committed artifact without fetching or rewriting it', async () => {
  const h = await fixture();
  await writeToOpfsWithStaging({ path, response: new Response(Uint8Array.of(8, 9)) });
  h.fs.enter({ nextPhase: 'reuse', mutationPolicy: 'read-only' });
  h.fs.activity.length = 0;

  expect(await h.api.prefetchUrls([url], () => undefined)).toMatchObject({ complete: true, cachedCount: 1, downloadedCount: 0, failedCount: 0 });
  expect(h.network).not.toHaveBeenCalled();
  expect(h.fs.files.get(path)).toEqual(Uint8Array.of(8, 9));
  expect(h.fs.files.has(marker)).toBe(true);
  expect(h.fs.activity.every(item => item.operation === 'stat')).toBe(true);
});

it('reports a cache access failure without downloading a replacement artifact', async () => {
  const h = await fixture();
  h.getDirectory.mockRejectedValue(new DOMException('Fixture permission denied', 'NotAllowedError'));
  expect(await h.api.prefetchUrls([url], () => undefined)).toMatchObject({
    complete: false, failedCount: 1, files: [{ status: 'failed', failureStage: 'cache-check', error: { name: 'NotAllowedError' } }],
  });
  expect(h.network).not.toHaveBeenCalled();
  expect(h.fs.files.size).toBe(0);
});
