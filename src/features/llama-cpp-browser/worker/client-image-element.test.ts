// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createImageElementPlatform } from '@/utils/blob-image-element.test-helpers';
import type { WorkerRemote } from '@/utils/worker-transport';
import type { WorkerBlobImageHost } from '@/utils/worker-blob-image';
import { decodeImage } from '@/features/llama-cpp-browser/runtime/image-input';
import type { GenerateInput } from '@/features/llama-cpp-browser/types';
import { createLlamaCppWorkerSessionClient } from './client-session';
import type { LlamaCppWorkerApi } from './types';

const completed = { content: 'ok', reasoningContent: '', toolCalls: [], finishReason: 'stop' as const };
const image = () => new Blob(['encoded'], { type: 'image/png' });
function request(): GenerateInput {
  return { model: 'user/model-GGUF', options: { profile: 'cpu-wasm32' }, messages: [{ role: 'user', content: [{ type: 'image', blob: image() }] }], temperature: 0, topP: 1, maxTokens: 1, presencePenalty: 0, frequencyPenalty: 0, stop: [] };
}
const cleanup: Array<() => void> = [];
function fixture() {
  const platform = createImageElementPlatform({ completion: 'decode' });
  const remote = { generate: vi.fn(async () => completed), cancelGeneration: vi.fn(async () => {}) } as unknown as WorkerRemote<LlamaCppWorkerApi>;
  const disposeTransport = vi.fn();
  const client = createLlamaCppWorkerSessionClient({ worker: new EventTarget() as Worker, remote, disposeTransport, getAssetBaseURL: () => undefined });
  cleanup.push(() => {
    client.dispose(); platform.dispose();
  });
  return { platform, remote, client, disposeTransport };
}
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('model client host uses the image operation adapter', () => {
  it('decodes via the actual host DOM path and retains white-background RGB composition', async () => {
    const env = fixture();
    let usedHost: WorkerBlobImageHost | undefined;
    vi.mocked(env.remote.generate).mockImplementation(async (_request, _chunk, _progress, _diagnostic, _bytes, host) => {
      usedHost = host;
      if (host === undefined) throw new Error('Expected image host');
      // This model transport is local and inference is not executed. The host
      // and RGB conversion are real; only the DOM decoder/canvas are controlled.
      const blob = image();
      const result = await decodeImage({ blob, decoder: {
        decode: async () => host.decode({ blob }), dispose() {},
      } });
      expect(result).toEqual({ width: 2, height: 1, rgb: new Uint8Array([10, 20, 30, 255, 255, 255]) });
      return completed;
    });
    expect(await env.client.generate({ request: request(), onEvent() {}, onProgress() {}, signal: undefined })).toEqual(completed);
    expect(env.platform.live.size).toBe(0); expect(env.platform.revokeObjectURL).toHaveBeenCalledOnce();
    await expect(usedHost!.decode({ blob: image() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(env.disposeTransport).not.toHaveBeenCalled();
  });

  it('keeps a local image load owned until RPC cleanup completes after cooperative cancellation', async () => {
    const env = fixture();
    const controller = new AbortController();
    const pending = Promise.withResolvers<void>(); env.platform.decoded.mockReturnValueOnce(pending.promise);
    vi.mocked(env.remote.generate).mockImplementation(async (_request, _chunk, _progress, _diagnostic, _bytes, host) => {
      if (host === undefined) throw new Error('Expected image host');
      await host.decode({ blob: image() }); return completed;
    });
    const generating = env.client.generate({ request: request(), onEvent() {}, onProgress() {}, signal: controller.signal });
    const rejected = expect(generating).rejects.toThrow('aborted');
    await vi.waitFor(() => expect(env.platform.live.size).toBe(1));
    controller.abort();
    expect(env.remote.cancelGeneration).toHaveBeenCalledOnce();
    expect(env.platform.live.size).toBe(1);
    pending.resolve(); await rejected;
    expect(env.platform.live.size).toBe(0); expect(env.disposeTransport).not.toHaveBeenCalled();
  });

  it('reclaims the active image URL on client disposal even if decode never completes', async () => {
    const env = fixture();
    const pending = Promise.withResolvers<void>(); env.platform.decoded.mockReturnValue(pending.promise);
    vi.mocked(env.remote.generate).mockImplementation(async (_request, _chunk, _progress, _diagnostic, _bytes, host) => {
      if (host === undefined) throw new Error('Expected image host');
      await host.decode({ blob: image() }); return completed;
    });
    const generating = env.client.generate({ request: request(), onEvent() {}, onProgress() {}, signal: undefined });
    const rejected = expect(generating).rejects.toThrow('worker-failed');
    await vi.waitFor(() => expect(env.platform.live.size).toBe(1));
    env.client.dispose(); await rejected;
    await vi.waitFor(() => expect(env.platform.live.size).toBe(0));
    expect(env.platform.elements[0]!.src).toBe(''); expect(env.platform.drawImage).not.toHaveBeenCalled();
    expect(env.disposeTransport).toHaveBeenCalledOnce();
    pending.reject(new Error('Late native decode failure')); await Promise.resolve();
    expect(env.platform.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it('rejects failed image loading and can start a later generation without a leaked host or URL', async () => {
    const env = fixture();
    env.platform.decoded.mockRejectedValueOnce(new DOMException('Malformed image', 'EncodingError'));
    const hosts: WorkerBlobImageHost[] = [];
    vi.mocked(env.remote.generate).mockImplementation(async (_request, _chunk, _progress, _diagnostic, _bytes, host) => {
      if (host === undefined) throw new Error('Expected image host');
      hosts.push(host); await host.decode({ blob: image() }); return completed;
    });
    await expect(env.client.generate({ request: request(), onEvent() {}, onProgress() {}, signal: undefined })).rejects.toThrow();
    expect(env.platform.live.size).toBe(0);
    await expect(hosts[0]!.decode({ blob: image() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(await env.client.generate({ request: request(), onEvent() {}, onProgress() {}, signal: undefined })).toEqual(completed);
    expect(hosts[1]).not.toBe(hosts[0]); expect(env.platform.live.size).toBe(0);
    expect(env.platform.revokeObjectURL).toHaveBeenCalledTimes(2);
  });
});
