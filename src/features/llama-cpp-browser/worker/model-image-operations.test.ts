import type { GenerationEvent } from '@/features/llama-cpp-browser/types';
// @vitest-environment node
import { MessageChannel } from 'node:worker_threads';
import * as Comlink from 'comlink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as imageIO from '@/utils/blob-image';
import { createWorkerBlobImageHost, type WorkerBlobImageHost } from '@/utils/worker-blob-image';
import { exposeWorkerRemote, releaseWorkerRemote, workerProxy, workerTransfer, wrapWorkerRemote } from '@/utils/worker-transport';
import { decodeImage, IMAGE_DECODE_LIMITS } from '@/features/llama-cpp-browser/runtime/image-input';
import { createModelBlobFixture } from '@/features/llama-cpp-browser/test-utils/model-blob-view';
import { createWorkerApi } from './api';
import type { LlamaCppWorkerApi, WorkerGenerateCall } from './types';
import type { generate } from './generation';

const calls = vi.hoisted(() => ({ generate: vi.fn<typeof generate>(), release: vi.fn(), invalidate: vi.fn() }));
vi.mock('./generation', () => ({ generate: calls.generate }));
vi.mock('./session', () => ({ releaseSession: calls.release, invalidateStoredModel: calls.invalidate }));
const result = () => ({ content: 'ok', reasoningContent: '', toolCalls: [], finishReason: 'stop' as const });
const image = () => new Blob(['encoded'], { type: 'image/png' });
function pixels({ blob }: { blob: Blob }) {
  return blob.size === 70
    ? { width: 1, height: 1, rgba: new Uint8Array([255, 0, 0, 255]) }
    : { width: 2, height: 1, rgba: new Uint8Array([10, 20, 30, 255, 200, 100, 0, 128]) };
}
const request = ({ generationId }: { generationId: number }): WorkerGenerateCall => ({
  generationId, model: 'user/model-GGUF', messages: [{ role: 'user', content: [{ type: 'image', blob: image() }] }],
  options: { profile: 'cpu-wasm32' }, temperature: 0, topP: 1, maxTokens: 1, presencePenalty: 0, frequencyPenalty: 0, stop: [],
});
function imageHost() {
  const release = vi.fn();
  const decode = vi.fn(async ({ blob }: { blob: Blob }) => {
    const value = pixels({ blob }); return workerTransfer({ value, transferables: [value.rgba.buffer] });
  });
  return { host: Object.assign({ decode }, { [Comlink.releaseProxy]: release }), release, decode };
}
let storage: ReturnType<typeof createModelBlobFixture>;
beforeEach(() => {
  storage = createModelBlobFixture({ releaseProxy: Comlink.releaseProxy });
  calls.generate.mockReset(); calls.generate.mockImplementation(async () => result());
  calls.release.mockClear(); calls.invalidate.mockClear();
});
afterEach(() => {
  storage.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('generation image capability ownership', () => {
  it('uses the image decoder instead of the byte host and keeps white-background RGB composition', async () => {
    const api = createWorkerApi(); const bytes = storage.host(); const images = imageHost();
    vi.spyOn(imageIO, 'decodeNativeBlobImage').mockRejectedValue(new DOMException('Opaque worker', 'InvalidStateError'));
    calls.generate.mockImplementation(async ({ imageDecoder, signal }) => {
      expect(imageDecoder).toBeDefined();
      const decoded = await decodeImage({ blob: image(), decoder: imageDecoder, signal });
      expect(decoded).toEqual({ width: 2, height: 1, rgb: new Uint8Array([10, 20, 30, 227, 177, 127]) });
      return result();
    });
    expect(await api.generate(request({ generationId: 1 }), async () => {}, () => {}, undefined, bytes.host, images.host)).toEqual(result());
    expect(images.decode).toHaveBeenCalledTimes(2); expect(bytes.read).not.toHaveBeenCalled();
    expect(bytes.released).toHaveBeenCalledOnce(); expect(images.release).toHaveBeenCalledOnce();
    expect(calls.release).not.toHaveBeenCalled();
  });

  it('does not decode or probe an unused image host and releases it after the RPC', async () => {
    const api = createWorkerApi(); const images = imageHost();
    const direct = vi.spyOn(imageIO, 'decodeNativeBlobImage');
    await api.generate(request({ generationId: 1 }), async () => {}, () => {}, undefined, undefined, images.host);
    expect(images.decode).not.toHaveBeenCalled(); expect(direct).not.toHaveBeenCalled(); expect(images.release).toHaveBeenCalledOnce();
  });

  it('does not release the image host while already-issued progress acknowledgements are pending', async () => {
    const api = createWorkerApi(); const images = imageHost();
    const pending = Promise.withResolvers<void>();
    const progress = vi.fn(() => pending.promise);
    calls.generate.mockImplementation(async ({ onProgress }) => {
      onProgress({ progress: { phase: 'prefill', completed: 0, total: 1 } }); return result();
    });
    const generation = api.generate(request({ generationId: 1 }), async () => {}, progress, undefined, undefined, images.host);
    await vi.waitFor(() => expect(progress).toHaveBeenCalledOnce());
    expect(images.release).not.toHaveBeenCalled();
    await expect(api.release()).rejects.toThrow('busy');
    pending.resolve(); await generation;
    expect(images.release).toHaveBeenCalledOnce();
  });

  it('releases a rejected invalid/busy image host without affecting the active owner', async () => {
    const api = createWorkerApi(); const active = imageHost();
    const pending = Promise.withResolvers<ReturnType<typeof result>>(); calls.generate.mockReturnValue(pending.promise);
    const generation = api.generate(request({ generationId: 1 }), async () => {}, () => {}, undefined, undefined, active.host);
    await vi.waitFor(() => expect(calls.generate).toHaveBeenCalledOnce());
    const rejected = imageHost();
    await expect(api.generate(request({ generationId: 2 }), async () => {}, () => {}, undefined, undefined, rejected.host)).rejects.toThrow('busy');
    expect(rejected.release).toHaveBeenCalledOnce(); expect(active.release).not.toHaveBeenCalled();
    const invalid = imageHost();
    await expect(api.generate({ ...request({ generationId: 3 }), messages: [] }, async () => {}, () => {}, undefined, undefined, invalid.host)).rejects.toThrow();
    expect(invalid.release).toHaveBeenCalledOnce();
    pending.resolve(result()); await generation; expect(active.release).toHaveBeenCalledOnce();
  });

  it.each(['resolve', 'reject'] as const)('cancels an actual-image wait before its late host %s and permits another generation', async outcome => {
    const api = createWorkerApi(); const images = imageHost();
    vi.spyOn(imageIO, 'decodeNativeBlobImage').mockRejectedValue(new DOMException('Opaque worker', 'InvalidStateError'));
    const pending = Promise.withResolvers<Awaited<ReturnType<WorkerBlobImageHost['decode']>>>();
    const entered = Promise.withResolvers<void>();
    const original = images.decode.getMockImplementation()!;
    images.decode.mockImplementation(args => {
      if (args.blob.size === 70) return original(args);
      entered.resolve(); return pending.promise;
    });
    calls.generate.mockImplementation(async ({ imageDecoder, signal }) => {
      await decodeImage({ blob: image(), decoder: imageDecoder, signal }); return result();
    });
    const generation = api.generate(request({ generationId: 1 }), async () => {}, () => {}, undefined, undefined, images.host);
    const rejected = expect(generation).rejects.toThrow('aborted');
    await entered.promise;
    await api.cancelGeneration({ generationId: 2 }); expect(images.release).not.toHaveBeenCalled();
    await api.cancelGeneration({ generationId: 1 }); await rejected;
    expect(images.release).toHaveBeenCalledOnce();
    if (outcome === 'resolve') pending.resolve(workerTransfer({ value: pixels({ blob: image() }), transferables: [] }));
    else pending.reject(new Error('Late decode failed'));
    expect(await api.generate(request({ generationId: 3 }), async () => {}, () => {}, undefined, undefined, imageHost().host)).toEqual(result());
  });

  it('rejects malformed host pixels as unsupported input instead of passing them to native code', async () => {
    const api = createWorkerApi(); const images = imageHost();
    vi.spyOn(imageIO, 'decodeNativeBlobImage').mockRejectedValue(new DOMException('Opaque', 'InvalidStateError'));
    const original = images.decode.getMockImplementation()!;
    images.decode.mockImplementation(async args => args.blob.size === 70 ? original(args) : workerTransfer({ value: { width: 2, height: 1, rgba: new Uint8Array(1) }, transferables: [] }));
    calls.generate.mockImplementation(async ({ imageDecoder, signal }) => {
      await decodeImage({ blob: image(), decoder: imageDecoder, signal }); throw new Error('Must not reach native generation');
    });
    await expect(api.generate(request({ generationId: 1 }), async () => {}, () => {}, undefined, undefined, images.host)).rejects.toThrow('unsupported-input');
    expect(images.release).toHaveBeenCalledOnce();
  });

  it('passes a real image host through LlamaCppWorkerApi, transfers pixels, and releases all reverse proxies', async () => {
    const api = createWorkerApi(); const channel = new MessageChannel();
    exposeWorkerRemote<LlamaCppWorkerApi>({ api, endpoint: channel.port1 as unknown as MessagePort });
    const remote = wrapWorkerRemote<LlamaCppWorkerApi>({ endpoint: channel.port2 as unknown as MessagePort });
    const hostLifetime = new AbortController(); const buffers: ArrayBuffer[] = [];
    vi.spyOn(imageIO, 'decodeNativeBlobImage').mockImplementation(async ({ blob, signal }) => {
      if (signal !== hostLifetime.signal) throw new DOMException('Opaque worker', 'InvalidStateError');
      const value = pixels({ blob }); buffers.push(value.rgba.buffer); return value;
    });
    const imageHostFinalized = vi.fn();
    const images = Object.assign(createWorkerBlobImageHost({ limits: IMAGE_DECODE_LIMITS, signal: hostLifetime.signal }), { [Comlink.finalizer]: imageHostFinalized });
    const byteHost = storage.host(); const byteFinalized = vi.fn(); Object.assign(byteHost.host, { [Comlink.finalizer]: byteFinalized });
    const chunkFinalized = vi.fn(); const progressFinalized = vi.fn();
    const output: string[] = [];
    const onChunk = Object.assign(async ({ event }: { event: GenerationEvent }) => {
      if (event.type !== 'text') throw new Error('Expected text event');
      output.push(event.text);
    }, { [Comlink.finalizer]: chunkFinalized });
    const onProgress = Object.assign(() => {}, { [Comlink.finalizer]: progressFinalized });
    calls.generate.mockImplementation(async ({ request: input, imageDecoder, signal, onEvent: emitEvent }) => {
      const content = input.messages[0]!.content;
      if (typeof content === 'string' || content[0]?.type !== 'image') throw new Error('Expected image');
      const rgb = await decodeImage({ blob: content[0].blob, decoder: imageDecoder, signal });
      await emitEvent({ event: { type: 'text', text: [...rgb.rgb].join(',') } }); return result();
    });
    try {
      expect(await remote.generate(request({ generationId: 1 }), workerProxy({ value: onChunk }), workerProxy({ value: onProgress }), undefined, workerProxy({ value: byteHost.host }), workerProxy({ value: images }))).toEqual(result());
      expect(output).toEqual(['10,20,30,227,177,127']);
      expect(buffers).toHaveLength(2); expect(buffers.every(buffer => buffer.byteLength === 0)).toBe(true);
      expect(byteHost.read).not.toHaveBeenCalled();
      await vi.waitFor(() => {
        for (const finalizer of [imageHostFinalized, byteFinalized, chunkFinalized, progressFinalized]) expect(finalizer).toHaveBeenCalledOnce();
      });
    } finally {
      hostLifetime.abort(); releaseWorkerRemote({ remote }); channel.port1.close(); channel.port2.close();
    }
  });
});
