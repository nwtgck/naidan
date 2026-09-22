import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeBlobContext } from '@/utils/blob-view';
import { generate } from './generation';
import type { prepareSession } from './session';
import type { prepareMultimodal } from './multimodal';
import type { prepareChat } from './native-chat';

const prepare = vi.hoisted(() => vi.fn<typeof prepareSession>());
const multimodal = vi.hoisted(() => vi.fn<typeof prepareMultimodal>());
const chat = vi.hoisted(() => vi.fn<typeof prepareChat>());
vi.mock('./session', () => ({ prepareSession: prepare }));
vi.mock('./multimodal', () => ({ prepareMultimodal: multimodal }));
vi.mock('./native-chat', () => ({ prepareChat: chat }));
afterEach(() => vi.restoreAllMocks());

describe('generation session Blob context forwarding', () => {
  it('passes the caller-owned context and signal to preparation without owning or disposing them', async () => {
    const blobs = createNativeBlobContext(); const dispose = vi.spyOn(blobs, 'dispose');
    const signal = new AbortController(); const stoppedAtSession = new Error('Stop before native execution');
    prepare.mockRejectedValueOnce(stoppedAtSession);
    try {
      const input = { blobs, signal: signal.signal, request: { model: 'user/model-GGUF', messages: [], options: { profile: 'cpu-wasm32' as const }, temperature: 0, topP: 1, maxTokens: 1, presencePenalty: 0, frequencyPenalty: 0, stop: [] }, onProgress: () => {}, onEvent: () => {} };
      await expect(generate(input)).rejects.toBe(stoppedAtSession);
      expect(prepare).toHaveBeenCalledWith({ blobs, signal: signal.signal, request: input.request, onProgress: input.onProgress });
      expect(dispose).not.toHaveBeenCalled();
    } finally {
      blobs.dispose();
    }
  });
  it('forwards a request-owned image decoder only to multimodal preparation, not resident model state', async () => {
    const decoder = { decode: vi.fn(), dispose: vi.fn() };
    const signal = new AbortController().signal;
    const image = new Blob(['encoded'], { type: 'image/png' });
    const released = vi.fn();
    const session = {
      core: {
        api: {
          llama_get_memory: vi.fn(async () => 5n), llama_set_abort_callback: vi.fn(async () => {}),
          llama_model_get_vocab: vi.fn(async () => 6n), llama_n_ctx: vi.fn(async () => 128),
        },
        module: { addFunction: vi.fn(() => 1), removeFunction: vi.fn() }, pointerBytes: 4, free: vi.fn(),
      },
      model: 1n, context: 2n, projector: 3n, slidingWindow: 128, cache: { validity: 'valid', tokens: [1], checkpoint: { pointer: 999n, bytes: 64, tokens: [1], positionMin: 0, positionMax: 0 } },
    } as unknown as Awaited<ReturnType<typeof prepareSession>>;
    const preparedChat = { params: { prompt: '<image>after' }, images: [{ marker: '<image>', blob: image }], dispose: released } as unknown as ReturnType<typeof prepareChat>;
    prepare.mockResolvedValueOnce(session); chat.mockReturnValueOnce(preparedChat);
    const beforeNative = new Error('Stop at the real generation-to-multimodal boundary');
    multimodal.mockRejectedValueOnce(beforeNative);
    const input = { imageDecoder: decoder, signal, request: { model: 'user/model-GGUF', messages: [], options: { profile: 'cpu-wasm32' as const }, temperature: 0, topP: 1, maxTokens: 1, presencePenalty: 0, frequencyPenalty: 0, stop: [] }, onProgress: () => {}, onEvent: () => {} };
    await expect(generate(input)).rejects.toBe(beforeNative);
    expect(multimodal).toHaveBeenCalledWith({ core: session.core, projector: 3n, prompt: '<image>after', images: preparedChat.images, decoder, signal });
    expect(prepare.mock.calls.at(-1)?.[0]).not.toHaveProperty('imageDecoder');
    expect(decoder.dispose).not.toHaveBeenCalled();
    expect(released).toHaveBeenCalledOnce();
    expect(session.cache.validity).toBe('invalid');
    expect(session.cache.checkpoint).toBeUndefined();
    expect(session.core.free).toHaveBeenCalledExactlyOnceWith({ pointer: 999n });
    expect(vi.mocked(session.core.free).mock.invocationCallOrder[0]).toBeLessThan(multimodal.mock.invocationCallOrder.at(-1)!);
  });

});
