import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { synthesizeAudio, generateAudio } from './audio-generation';
import { readAudioScalar } from './audio-memory';
import { audioNativeFixture } from '@/features/audio-generation/test-utils/native';
import { audioResult } from '@/features/audio-generation/test-utils/wav';
import { defaultAudioParameters } from '@/features/audio-generation/types';
import type { WorkerAudioInput } from './types';

const session = vi.hoisted(() => ({ prepare: vi.fn(), release: vi.fn(async () => {}) }));
vi.mock('./session', () => ({ prepareAudioSession: session.prepare, releaseSession: session.release }));
function request(): WorkerAudioInput {
  return { ...defaultAudioParameters(), model: 'user/voice', text: 'こんにちは', options: { profile: 'cpu-wasm32' }, debug: 'off' };
}
function reference(): Blob {
  const blob = new Blob(['RIFF']);
  // jsdom's Blob does not implement arrayBuffer; make the input capability explicit.
  Object.defineProperty(blob, 'arrayBuffer', { value: async () => new TextEncoder().encode('RIFF').buffer });
  return blob;
}
beforeEach(() => {
  vi.clearAllMocks(); vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe.each([4, 8] as const)('audio native orchestration with %i-byte pointers', pointerBytes => {
  it('copies valid output before freeing native state and uses UTF-8 byte lengths', async () => {
    const native = audioNativeFixture({ pointerBytes });
    const result = await synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: request(), signal: undefined, onProgress: () => {} });
    expect(result).toEqual(audioResult());
    expect(native.fields.get('mtmd_helper_gen_audio_inp.prompt_len')).toBe(15n);
    expect(native.api.mtmd_helper_gen_audio_free).toHaveBeenCalledOnce();
    expect(native.api.llama_sampler_free).toHaveBeenCalledExactlyOnceWith(81n);
    expect(native.owned.size).toBe(0);
    expect(native.core.bytes({ pointer: native.outputPointer, length: result.wav.length }).every(byte => byte === 0)).toBe(true);
    expect(native.api.llama_set_abort_callback).toHaveBeenLastCalledWith(20n, 0n, 0n);
    expect(native.module.removeFunction).toHaveBeenCalledExactlyOnceWith(9);
    expect(native.api.llama_sampler_chain_add).toHaveBeenCalledTimes(4);
  });
  it('reads out-parameters using refreshed heap views after memory growth', async () => {
    const native = audioNativeFixture({ pointerBytes }); native.controls.growDuringStep = true;
    await expect(synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: request(), signal: undefined, onProgress: () => {} })).resolves.toEqual(audioResult());
  });
  it('uses a null semantic token for Pocket, requiring reference but ignoring language and token sampling', async () => {
    const native = audioNativeFixture({ pointerBytes }); native.controls.nativeType = 2;
    const result = await synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: { ...request(), reference: reference(), language: 'ja' }, signal: undefined, onProgress: () => {} });
    expect(result.pipeline).toBe('pocket-tts');
    expect(native.fields.get('mtmd_helper_gen_audio_inp.lang')).toBe(0n);
    expect(native.api.llama_sampler_sample).not.toHaveBeenCalled();
    expect(native.api.llama_sampler_chain_init).not.toHaveBeenCalled();
    expect(native.api.mtmd_helper_gen_audio_step_gen.mock.calls.every(call => call[1] === -1)).toBe(true);
    expect(native.api.mtmd_bitmap_free).toHaveBeenCalledExactlyOnceWith(50n);
    expect(native.owned.size).toBe(0);
  });
  it('uses a greedy backbone sampler only when temperature is zero', async () => {
    const native = audioNativeFixture({ pointerBytes });
    await synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: { ...request(), temperature: 0 }, signal: undefined, onProgress: () => {} });
    expect(native.api.llama_sampler_chain_init).not.toHaveBeenCalled();
    expect(native.api.llama_sampler_free).toHaveBeenCalledExactlyOnceWith(80n);
  });
  it.each(['frame-limit', 'context-limit'] as const)('marks partial audio as %s instead of pretending speech is complete', async reason => {
    const native = audioNativeFixture({ pointerBytes });
    if (reason === 'context-limit') native.controls.capacity = 12;
    const result = await synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: { ...request(), maxFrames: reason === 'frame-limit' ? 1 : 100 }, signal: undefined, onProgress: () => {} });
    expect(result.finishReason).toBe(reason); expect(result.frames).toBe(1);
    expect(native.owned.size).toBe(0);
  });
  it('rejects an immediate end-of-speech with no frames', async () => {
    const native = audioNativeFixture({ pointerBytes }); native.controls.stopAfter = 0;
    await expect(synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: request(), signal: undefined, onProgress: () => {} })).rejects.toThrow('audio-output-empty');
    expect(native.owned.size).toBe(0);
  });
  it.each([0, 99])('rejects unsupported native pipeline %i before allocating the helper', async nativeType => {
    const native = audioNativeFixture({ pointerBytes }); native.controls.nativeType = nativeType;
    await expect(synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: request(), signal: undefined, onProgress: () => {} })).rejects.toThrow('audio-model-unsupported');
    expect(native.api.mtmd_helper_gen_audio_init).not.toHaveBeenCalled(); expect(native.owned.size).toBe(0);
  });
  it('requires a Pocket reference before entering the native generation helper', async () => {
    const native = audioNativeFixture({ pointerBytes }); native.controls.nativeType = 2;
    await expect(synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: request(), signal: undefined, onProgress: () => {} })).rejects.toThrow('audio-reference-required');
    expect(native.api.mtmd_helper_gen_audio_init).not.toHaveBeenCalled(); expect(native.owned.size).toBe(0);
  });
  it.each(['wrong-type', 'too-long'] as const)('frees an invalid reference: %s', async reason => {
    const native = audioNativeFixture({ pointerBytes });
    if (reason === 'wrong-type') native.controls.audio = false; else native.controls.referenceBytes = 24000 * 31 * 4;
    await expect(synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: { ...request(), reference: reference() }, signal: undefined, onProgress: () => {} })).rejects.toThrow('audio-reference-invalid');
    expect(native.api.mtmd_bitmap_free).toHaveBeenCalledOnce(); expect(native.owned.size).toBe(0);
  });
  it('yields to task-queued cancellation and never publishes accumulated output after Stop', async () => {
    const native = audioNativeFixture({ pointerBytes }); const controller = new AbortController();
    const promise = synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: request(), signal: controller.signal, onProgress: ({ progress }) => {
      if (progress.phase === 'generating') setTimeout(() => controller.abort(), 0);
    } });
    await expect(promise).rejects.toThrow('aborted');
    expect(native.api.mtmd_helper_gen_audio_get_output).not.toHaveBeenCalled(); expect(native.owned.size).toBe(0);
  });
  it.each(['input', 'prompt', 'frame', 'output'] as const)('cleans all allocations after native %s failure', async stage => {
    const native = audioNativeFixture({ pointerBytes });
    switch (stage) {
    case 'input': native.api.mtmd_helper_gen_audio_set_input.mockResolvedValueOnce(1); break;
    case 'prompt': native.api.mtmd_helper_gen_audio_step_prompt.mockResolvedValueOnce(-1); break;
    case 'frame': native.api.mtmd_helper_gen_audio_step_gen.mockResolvedValueOnce(1); break;
    case 'output': native.api.mtmd_helper_gen_audio_get_output.mockResolvedValueOnce(1); break;
    default: { const exhaustive: never = stage; throw new Error(String(exhaustive)); }
    }
    await expect(synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: { ...request(), reference: reference() }, signal: undefined, onProgress: () => {} })).rejects.toThrow();
    expect(native.api.mtmd_helper_gen_audio_free).toHaveBeenCalledOnce(); expect(native.api.mtmd_bitmap_free).toHaveBeenCalledOnce(); expect(native.owned.size).toBe(0);
  });
  it('releases a not-yet-owned sampler child when adding it to a chain fails', async () => {
    const native = audioNativeFixture({ pointerBytes }); native.api.llama_sampler_chain_add.mockRejectedValueOnce(new Error('native failure'));
    await expect(synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: request(), signal: undefined, onProgress: () => {} })).rejects.toThrow('native failure');
    expect(native.api.llama_sampler_free.mock.calls.map(call => call[0])).toEqual([82n, 81n]); expect(native.owned.size).toBe(0);
  });
  it('retains full-width pointers, size_t and signed 64-bit values', () => {
    const native = audioNativeFixture({ pointerBytes }); const pointer = native.core.alloc({ bytes: 8 });
    const value = pointerBytes === 8 ? 0x123456789n : 0xF1234567n;
    native.write({ pointer, value, size: pointerBytes, signed: false });
    expect(readAudioScalar({ core: native.core, pointer, kind: 'pointer' })).toBe(value);
    expect(readAudioScalar({ core: native.core, pointer, kind: 'size' })).toBe(value);
    native.write({ pointer, value: -1234567890123n, size: 8, signed: true });
    expect(readAudioScalar({ core: native.core, pointer, kind: 'i64' })).toBe(-1234567890123n);
    native.core.free({ pointer });
  });
});
it('releases session resources even when model preparation fails', async () => {
  session.prepare.mockRejectedValueOnce(new Error('load failed'));
  await expect(generateAudio({ request: request(), onProgress: () => {}, signal: undefined })).rejects.toThrow('load failed');
  expect(session.release).toHaveBeenCalledExactlyOnceWith({ releaseRuntime: false });
});
