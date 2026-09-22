// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as images from '@/utils/blob-image';
import type { WorkerRemote } from '@/utils/worker-transport';
import type { WorkerBlobImageHost } from '@/utils/worker-blob-image';
import { createLlamaCppWorkerSessionClient } from './client-session';
import type { LlamaCppWorkerApi } from './types';
import type { GenerateInput } from '@/features/llama-cpp-browser/types';

const completed = { content: 'ok', reasoningContent: '', toolCalls: [], finishReason: 'stop' as const };
const image = () => new Blob(['image'], { type: 'image/png' });
const imagePixels = () => ({ width: 1, height: 1, rgba: new Uint8Array([10, 20, 30, 255]) });
function request({ content }: { content: GenerateInput['messages'][number]['content'] }): GenerateInput {
  return { model: 'user/model-GGUF', options: { profile: 'cpu-wasm32' }, messages: [{ role: 'user', content }], temperature: 0, topP: 1, maxTokens: 1, presencePenalty: 0, frequencyPenalty: 0, stop: [] };
}
const clients: ReturnType<typeof createLlamaCppWorkerSessionClient>[] = [];
function fixture() {
  const remote = {
    generate: vi.fn(async () => completed), cancelGeneration: vi.fn(async () => {}),
    listModels: vi.fn(async () => []),
  } as unknown as WorkerRemote<LlamaCppWorkerApi>;
  const disposeTransport = vi.fn();
  const client = createLlamaCppWorkerSessionClient({ worker: new EventTarget() as Worker, remote, disposeTransport, getAssetBaseURL: () => undefined });
  clients.push(client);
  return { remote, client, disposeTransport };
}
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose(); vi.restoreAllMocks();
});

describe('model client image-host lifetime', () => {
  it.each(['hello', [{ type: 'text', text: 'hello' }]] as GenerateInput['messages'][number]['content'][])('does not create an image host for text-only input %j', async content => {
    const { client, remote } = fixture();
    const native = vi.spyOn(images, 'decodeNativeBlobImage');
    await client.generate({ request: request({ content }), onEvent: () => {}, onProgress: () => {}, signal: undefined });
    expect(vi.mocked(remote.generate).mock.calls[0]?.[5]).toBeUndefined();
    expect(vi.mocked(remote.generate).mock.calls[0]?.[4]).toBeDefined();
    expect(native).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)('supplies a live image host distinct from byte IO and closes it on RPC %s', async outcome => {
    const { client, remote, disposeTransport } = fixture();
    const native = vi.spyOn(images, 'decodeNativeBlobImage').mockImplementation(async () => imagePixels());
    const arrived = Promise.withResolvers<WorkerBlobImageHost>();
    const finish = Promise.withResolvers<void>();
    vi.mocked(remote.generate).mockImplementation(async (_request, _chunk, _progress, _diagnostic, blobHost, imageHost) => {
      expect(imageHost).toBeDefined(); expect(imageHost).not.toBe(blobHost);
      arrived.resolve(imageHost!); await finish.promise; return completed;
    });
    const pending = client.generate({ request: request({ content: [{ type: 'image', blob: image() }] }), onEvent: () => {}, onProgress: () => {}, signal: undefined });
    const result = pending.then(value => ({ status: 'completed' as const, value }), () => ({ status: 'failed' as const }));
    const host = await arrived.promise;
    expect(await host.decode({ blob: image() })).toEqual(imagePixels());
    expect(native).toHaveBeenCalledOnce();
    if (outcome === 'resolve') finish.resolve(); else finish.reject(new Error('generation failed'));
    expect((await result).status).toBe(outcome === 'resolve' ? 'completed' : 'failed');
    await expect(host.decode({ blob: image() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(disposeTransport).not.toHaveBeenCalled();
    vi.mocked(remote.generate).mockResolvedValue(completed);
    await client.generate({ request: request({ content: [{ type: 'image', blob: image() }] }), onEvent: () => {}, onProgress: () => {}, signal: undefined });
    expect(vi.mocked(remote.generate).mock.calls[1]?.[5]).not.toBe(host);
  });

  it('stops outstanding native decode waits on client disposal and observes their late result', async () => {
    const { client, remote, disposeTransport } = fixture();
    const bitmap = Promise.withResolvers<images.BlobImagePixels>();
    const native = vi.spyOn(images, 'decodeNativeBlobImage').mockReturnValue(bitmap.promise);
    const generation = Promise.withResolvers<typeof completed>();
    vi.mocked(remote.generate).mockReturnValue(generation.promise);
    const pending = client.generate({ request: request({ content: [{ type: 'image', blob: image() }] }), onEvent: () => {}, onProgress: () => {}, signal: undefined });
    const rejected = expect(pending).rejects.toThrow('worker-failed');
    const host = vi.mocked(remote.generate).mock.calls[0]?.[5];
    if (!host) throw new Error('Expected image host');
    const decoding = host.decode({ blob: image() });
    const failedRead = expect(decoding).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(native).toHaveBeenCalledOnce());
    client.dispose(); client.dispose();
    await rejected; await failedRead;
    expect(disposeTransport).toHaveBeenCalledOnce();
    expect(native.mock.calls[0]?.[0].signal.aborted).toBe(true);
    bitmap.resolve(imagePixels()); generation.resolve(completed);
  });

  it('keeps the image host available during cooperative cancellation until the RPC finishes cleanup', async () => {
    const { client, remote, disposeTransport } = fixture();
    vi.spyOn(images, 'decodeNativeBlobImage').mockImplementation(async () => imagePixels());
    const controller = new AbortController();
    const finished = Promise.withResolvers<typeof completed>();
    vi.mocked(remote.generate).mockReturnValue(finished.promise);
    const pending = client.generate({ request: request({ content: [{ type: 'image', blob: image() }] }), onEvent: () => {}, onProgress: () => {}, signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow('aborted');
    const host = vi.mocked(remote.generate).mock.calls[0]?.[5];
    if (!host) throw new Error('Expected image host');
    controller.abort();
    expect(remote.cancelGeneration).toHaveBeenCalledWith({ generationId: 1 });
    expect(await host.decode({ blob: image() })).toEqual(imagePixels());
    finished.resolve(completed); await rejected;
    await expect(host.decode({ blob: image() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(disposeTransport).not.toHaveBeenCalled();
  });

  it('does not issue any generation or allocate a host when the call was already aborted', async () => {
    const { client, remote } = fixture();
    const controller = new AbortController(); controller.abort();
    await expect(client.generate({ request: request({ content: [{ type: 'image', blob: image() }] }), onEvent: () => {}, onProgress: () => {}, signal: controller.signal })).rejects.toThrow('aborted');
    expect(remote.generate).not.toHaveBeenCalled();
  });
});
