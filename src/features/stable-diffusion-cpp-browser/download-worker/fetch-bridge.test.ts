// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { getReadableStreamTransferSupport } from '@/utils/worker-transport';
import { createImageDownloadFetchBridge } from './fetch-bridge';
import { createImageDownloadWorker } from './impl';
import { qwenRecipeFixtureBytes } from '@/features/stable-diffusion-cpp-browser/test-utils/catalog-weights';
import { MemoryDirectory } from '@/features/stable-diffusion-cpp-browser/test-utils/storage';
import { imageModelRecipes } from '@/features/stable-diffusion-cpp-browser/model-recipes';
import { listImageRepositories } from '@/features/stable-diffusion-cpp-browser/logic/repository-store';
import type { PrivacyFetchStreamResponse } from '@/features/privacy-fetch';
const calls = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/features/privacy-fetch', () => ({ privacyFetchStream: calls.fetch }));
vi.mock('@/utils/worker-transport', async original => ({ ...await original<typeof import('@/utils/worker-transport')>(), getReadableStreamTransferSupport: vi.fn(async () => 'unsupported' as const) }));
const files = [...imageModelRecipes[1]!.files];
beforeEach(() => {
  calls.fetch.mockReset();
  const root = new MemoryDirectory('root');
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root }, locks: { request: async (_name: string, options: { signal?: AbortSignal }, run: () => Promise<void>) => {
    options.signal?.throwIfAborted(); return run();
  } } });
});
afterEach(() => {
  vi.unstubAllGlobals();
});
it.each(['supported', 'unsupported'] as const)('delivers the authorized broker stream to the writer over real MessagePorts (%s stream transfer)', async support => {
  vi.mocked(getReadableStreamTransferSupport).mockResolvedValue(support);
  const payloads = await Promise.all(files.map(file => qwenRecipeFixtureBytes({ file, layers: 36 })));
  calls.fetch.mockImplementation(async ({ request }: { request: { url: string, signal: AbortSignal } }): Promise<PrivacyFetchStreamResponse> => {
    expect(request.signal).toBeInstanceOf(AbortSignal);
    const index = files.findIndex(file => request.url.includes(file.repository + '/'));
    const file = files[index]!, payload = payloads[index]!;
    const bytes = request.url.includes('/api/') ? new TextEncoder().encode(JSON.stringify([{ type: 'file', path: file.path, size: payload.length, lfs: { size: payload.length, oid: createHash('sha256').update(payload).digest('hex') } }])) : payload;
    return { url: request.url, status: 200, statusText: '', ok: true, redirected: false, responseType: 'basic', policyName: 'test', headers: new Headers(),
      body: new ReadableStream({ start(controller) {
        controller.enqueue(bytes); controller.close();
      } }),
    };
  });
  const bridge = createImageDownloadFetchBridge({ signal: new AbortController().signal });
  try {
    const writer = createImageDownloadWorker();
    await writer.download({ files }, () => undefined, bridge.open);
    expect(calls.fetch).toHaveBeenCalledTimes(6);
    const saved = (await listImageRepositories({ signal: undefined })).flatMap(repo => repo.files);
    expect(saved).toHaveLength(3); expect(saved.every(file => file.receipt)).toBe(true);
  } finally {
    bridge.dispose();
  }
});
it('aborts a pending broker response when the owning download is paused', async () => {
  calls.fetch.mockImplementation(({ request }: { request: { signal: AbortSignal } }) => new Promise((_resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(new DOMException('cancel', 'AbortError')), { once: true });
  }));
  const controller = new AbortController(), bridge = createImageDownloadFetchBridge({ signal: controller.signal });
  try {
    const writer = createImageDownloadWorker();
    const pending = writer.download({ files }, () => undefined, bridge.open);
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(calls.fetch).toHaveBeenCalledOnce());
    controller.abort(); writer.cancel(); await rejected;
  } finally {
    bridge.dispose();
  }
});
