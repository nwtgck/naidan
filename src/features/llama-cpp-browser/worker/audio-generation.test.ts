import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { synthesizeAudio, generateAudio, audioPreviewBoundary } from './audio-generation';
import { readAudioScalar } from './audio-memory';
import { audioNativeFixture } from '@/features/audio-generation/test-utils/native';
import { audioResult } from '@/features/audio-generation/test-utils/wav';
import { defaultAudioParameters, type AudioGenerationPreview } from '@/features/audio-generation/types';
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
    const result = await synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: request(), cancellationSignal: undefined, onProgress: () => {} });
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
    await expect(synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: request(), cancellationSignal: undefined, onProgress: () => {} })).resolves.toEqual(audioResult());
  });
  it('uses a null semantic token for Pocket, requiring reference but ignoring language and token sampling', async () => {
    const native = audioNativeFixture({ pointerBytes }); native.controls.nativeType = 2;
    const result = await synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: { ...request(), reference: reference(), language: 'ja' }, cancellationSignal: undefined, onProgress: () => {} });
    expect(result.pipeline).toBe('pocket-tts');
    expect(native.fields.get('mtmd_helper_gen_audio_inp.lang')).toBe(0n);
    expect(native.api.llama_sampler_sample).not.toHaveBeenCalled();
    expect(native.api.llama_sampler_chain_init).not.toHaveBeenCalled();
    expect(native.api.mtmd_helper_gen_audio_step_gen.mock.calls.every(call => call[1] === -1)).toBe(true);
    expect(native.api.mtmd_bitmap_free).toHaveBeenCalledExactlyOnceWith(50n);
    expect(native.owned.size).toBe(0);
  });
  it.each(['missing', 'legacy'] as const)('rejects a stale auto request before native work even on a %s artifact', async mode => {
    const native = audioNativeFixture({ pointerBytes }); const legacyQuery = vi.fn(async () => 1);
    if (mode === 'legacy') Reflect.set(native.api, 'mtmd_helper_gen_audio_supports_language_auto', legacyQuery);
    const stale = request(); Reflect.set(stale, 'language', 'auto');
    await expect(synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: stale, cancellationSignal: undefined, onProgress: () => {} })).rejects.toThrow();
    expect(legacyQuery).not.toHaveBeenCalled();
    expect(native.api.mtmd_helper_gen_audio_init).not.toHaveBeenCalled();
    expect(native.api.mtmd_helper_gen_audio_set_input).not.toHaveBeenCalled(); expect(native.owned.size).toBe(0);
  });
  it.each(['en', 'ja', 'default'] as const)('passes upstream %s without a downstream capability query', async language => {
    const native = audioNativeFixture({ pointerBytes }); const legacyQuery = vi.fn(async () => {
      throw new Error('Retired query must not be used');
    });
    Reflect.set(native.api, 'mtmd_helper_gen_audio_supports_language_auto', legacyQuery);
    let nativeLanguage: string | undefined;
    native.api.mtmd_helper_gen_audio_set_input.mockImplementation(async () => {
      const pointer = BigInt(native.fields.get('mtmd_helper_gen_audio_inp.lang')!);
      nativeLanguage = pointer === 0n ? undefined : new TextDecoder().decode(native.core.bytes({ pointer, length: 2 }));
      return 0;
    });
    const result = await synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: { ...request(), language }, cancellationSignal: undefined, onProgress: () => {} });
    expect(legacyQuery).not.toHaveBeenCalled();
    expect(nativeLanguage).toBe(language === 'default' ? undefined : language);
    expect(result).toEqual(audioResult()); expect(native.owned.size).toBe(0);
  });
  it('uses a greedy backbone sampler only when temperature is zero', async () => {
    const native = audioNativeFixture({ pointerBytes });
    await synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: { ...request(), temperature: 0 }, cancellationSignal: undefined, onProgress: () => {} });
    expect(native.api.llama_sampler_chain_init).not.toHaveBeenCalled();
    expect(native.api.llama_sampler_free).toHaveBeenCalledExactlyOnceWith(80n);
  });
  it.each(['frame-limit', 'context-limit'] as const)('marks partial audio as %s instead of pretending speech is complete', async reason => {
    const native = audioNativeFixture({ pointerBytes });
    if (reason === 'context-limit') native.controls.capacity = 12;
    const result = await synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: { ...request(), maxFrames: reason === 'frame-limit' ? 1 : 100 }, cancellationSignal: undefined, onProgress: () => {} });
    expect(result.finishReason).toBe(reason); expect(result.frames).toBe(1);
    expect(native.owned.size).toBe(0);
  });
  it('finishes between complete steps and flushes partial WAV through the normal output API', async () => {
    const native = audioNativeFixture({ pointerBytes }); native.controls.stopAfter = 100;
    let finish = false;
    const result = await synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: request(), cancellationSignal: undefined, shouldComplete: () => finish, onProgress: ({ progress }) => {
      if (progress.phase === 'generating' && progress.completed === 1) finish = true;
    } });
    expect(result).toMatchObject({ finishReason: 'user-stop', frames: 1 });
    expect(result.wav).toEqual(audioResult().wav);
    expect(native.api.mtmd_helper_gen_audio_step_gen).toHaveBeenCalledOnce();
    expect(native.api.mtmd_helper_gen_audio_get_output).toHaveBeenCalledOnce();
    expect(native.api.mtmd_helper_gen_audio_free).toHaveBeenCalledOnce(); expect(native.owned.size).toBe(0);
  });
  it('waits for the first complete frame when a finish request was queued during loading', async () => {
    const native = audioNativeFixture({ pointerBytes });
    const result = await synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: request(), cancellationSignal: undefined, shouldComplete: () => true, onProgress: () => {} });
    expect(result).toMatchObject({ finishReason: 'user-stop', frames: 1 });
    expect(native.api.mtmd_helper_gen_audio_step_gen).toHaveBeenCalledOnce(); expect(native.owned.size).toBe(0);
  });
  it('keeps cancellation stronger than a finish request and discards the partial output', async () => {
    const native = audioNativeFixture({ pointerBytes }); const controller = new AbortController();
    await expect(synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: request(), cancellationSignal: controller.signal, shouldComplete: () => true, onProgress: ({ progress }) => {
      if (progress.phase === 'generating' && progress.completed === 1) controller.abort();
    } })).rejects.toThrow('aborted');
    expect(native.api.mtmd_helper_gen_audio_get_output).not.toHaveBeenCalled(); expect(native.owned.size).toBe(0);
  });
  it('uses the same finish boundary for continuous Pocket generation without a token sampler', async () => {
    const native = audioNativeFixture({ pointerBytes }); native.controls.nativeType = 2;
    const result = await synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: { ...request(), reference: reference() }, cancellationSignal: undefined, shouldComplete: () => true, onProgress: () => {} });
    expect(result).toMatchObject({ finishReason: 'user-stop', frames: 1, pipeline: 'pocket-tts' });
    expect(native.api.llama_sampler_sample).not.toHaveBeenCalled(); expect(native.api.mtmd_bitmap_free).toHaveBeenCalledOnce(); expect(native.owned.size).toBe(0);
  });
  it('rejects an immediate end-of-speech with no frames', async () => {
    const native = audioNativeFixture({ pointerBytes }); native.controls.stopAfter = 0;
    await expect(synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: request(), cancellationSignal: undefined, onProgress: () => {} })).rejects.toThrow('audio-output-empty');
    expect(native.owned.size).toBe(0);
  });
  it.each([0, 99])('rejects unsupported native pipeline %i before allocating the helper', async nativeType => {
    const native = audioNativeFixture({ pointerBytes }); native.controls.nativeType = nativeType;
    await expect(synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: request(), cancellationSignal: undefined, onProgress: () => {} })).rejects.toThrow('audio-model-unsupported');
    expect(native.api.mtmd_helper_gen_audio_init).not.toHaveBeenCalled(); expect(native.owned.size).toBe(0);
  });
  it('requires a Pocket reference before entering the native generation helper', async () => {
    const native = audioNativeFixture({ pointerBytes }); native.controls.nativeType = 2;
    await expect(synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: request(), cancellationSignal: undefined, onProgress: () => {} })).rejects.toThrow('audio-reference-required');
    expect(native.api.mtmd_helper_gen_audio_init).not.toHaveBeenCalled(); expect(native.owned.size).toBe(0);
  });
  it.each(['wrong-type', 'too-long'] as const)('frees an invalid reference: %s', async reason => {
    const native = audioNativeFixture({ pointerBytes });
    if (reason === 'wrong-type') native.controls.audio = false; else native.controls.referenceBytes = 24000 * 31 * 4;
    await expect(synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: { ...request(), reference: reference() }, cancellationSignal: undefined, onProgress: () => {} })).rejects.toThrow('audio-reference-invalid');
    expect(native.api.mtmd_bitmap_free).toHaveBeenCalledOnce(); expect(native.owned.size).toBe(0);
  });
  it('yields to task-queued cancellation and never publishes accumulated output after Stop', async () => {
    const native = audioNativeFixture({ pointerBytes }); const controller = new AbortController();
    const promise = synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: request(), cancellationSignal: controller.signal, onProgress: ({ progress }) => {
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
    await expect(synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: { ...request(), reference: reference() }, cancellationSignal: undefined, onProgress: () => {} })).rejects.toThrow();
    expect(native.api.mtmd_helper_gen_audio_free).toHaveBeenCalledOnce(); expect(native.api.mtmd_bitmap_free).toHaveBeenCalledOnce(); expect(native.owned.size).toBe(0);
  });
  it('releases a not-yet-owned sampler child when adding it to a chain fails', async () => {
    const native = audioNativeFixture({ pointerBytes }); native.api.llama_sampler_chain_add.mockRejectedValueOnce(new Error('native failure'));
    await expect(synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: request(), cancellationSignal: undefined, onProgress: () => {} })).rejects.toThrow('native failure');
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
  await expect(generateAudio({ request: request(), onProgress: () => {}, cancellationSignal: undefined })).rejects.toThrow('load failed');
  expect(session.release).toHaveBeenCalledExactlyOnceWith({ releaseRuntime: false });
});


describe('reviewed preview boundaries', () => {
  it.each([0, 1, 71, 73, 143, 145])('does not flush an incomplete Qwen decoder block at step %i', frames => {
    expect(audioPreviewBoundary({ pipeline: 'qwen3-tts', frames })).toBe(false);
  });
  it.each([72, 144, 216])('permits a completed Qwen block at step %i', frames => {
    expect(audioPreviewBoundary({ pipeline: 'qwen3-tts', frames })).toBe(true);
  });
  it('allows exact-length Pocket chunks but not an empty accumulator', () => {
    expect(audioPreviewBoundary({ pipeline: 'pocket-tts', frames: 0 })).toBe(false);
    expect(audioPreviewBoundary({ pipeline: 'pocket-tts', frames: 1 })).toBe(true);
  });
});

describe.each([4, 8] as const)('continuing audio previews with %i-byte pointers', pointerBytes => {
  function growingOutput({ native }: { native: ReturnType<typeof audioNativeFixture> }) {
    const calls: number[] = [];
    native.api.mtmd_helper_gen_audio_get_output.mockImplementation(async (_helper, rate, data, length, samples) => {
      calls.push(native.controls.steps);
      const count = native.controls.steps * 4;
      const wav = new Uint8Array(44 + count * 2);
      wav.set(audioResult().wav.subarray(0, 44));
      const header = new DataView(wav.buffer); header.setUint32(4, wav.length - 8, true); header.setUint32(40, count * 2, true);
      wav.fill(native.controls.steps % 256, 44);
      native.core.bytes({ pointer: native.outputPointer, length: wav.length }).set(wav);
      native.write({ pointer: rate, value: 24000, size: 4, signed: true });
      native.write({ pointer: data, value: native.outputPointer, size: pointerBytes, signed: false });
      native.write({ pointer: length, value: wav.length, size: pointerBytes, signed: false });
      native.write({ pointer: samples, value: count, size: 8, signed: true });
      return 0;
    });
    return calls;
  }
  it('coalesces requests, copies only at safe boundaries and keeps generating to its natural end', async () => {
    const native = audioNativeFixture({ pointerBytes }); native.controls.stopAfter = 150;
    const outputs = growingOutput({ native }); let version = 0;
    const previews: AudioGenerationPreview[] = []; const versions: number[] = [];
    const result = await synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: request(), cancellationSignal: undefined,
      onProgress: ({ progress }) => {
        if (progress.phase !== 'generating') return;
        if (progress.completed === 1) version = 1;
        if (progress.completed === 71) version = 2;
        if (progress.completed === 73) version = 3;
      },
      preview: { requestedVersion: () => version, onPreview: async ({ result, requestVersion }) => {
        expect(native.api.mtmd_helper_gen_audio_free).not.toHaveBeenCalled();
        previews.push(result); versions.push(requestVersion);
        // Growing Wasm after a preview cannot invalidate the delivered copy.
        native.controls.growDuringStep = true;
      } },
    });
    expect(outputs).toEqual([72, 144, 150]);
    expect(versions).toEqual([2, 3]); expect(previews.map(p => p.frames)).toEqual([72, 144]);
    expect(previews.map(p => p.wav[44])).toEqual([72, 144]);
    expect(result).toMatchObject({ frames: 150, finishReason: 'stop' });
    expect(native.api.llama_sampler_sample).toHaveBeenCalledTimes(151);
    expect(native.owned.size).toBe(0);
  });
  it('does not emit an unsafe preview when the utterance ends before the next boundary', async () => {
    const native = audioNativeFixture({ pointerBytes }); native.controls.stopAfter = 71;
    const outputs = growingOutput({ native }); const onPreview = vi.fn(async () => {});
    const result = await synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: request(), cancellationSignal: undefined, onProgress: () => {}, preview: { requestedVersion: () => 1, onPreview } });
    expect(outputs).toEqual([71]); expect(onPreview).not.toHaveBeenCalled(); expect(result.frames).toBe(71);
  });
  it('does not call get_output during generation without an explicit preview request', async () => {
    const native = audioNativeFixture({ pointerBytes }); native.controls.stopAfter = 145;
    const outputs = growingOutput({ native }); const onPreview = vi.fn(async () => {});
    await synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: request(), cancellationSignal: undefined, onProgress: () => {}, preview: { requestedVersion: () => 0, onPreview } });
    expect(outputs).toEqual([145]); expect(onPreview).not.toHaveBeenCalled();
  });
  it('acknowledges a preview before resuming and cancellation prevents subsequent steps', async () => {
    const native = audioNativeFixture({ pointerBytes }); native.controls.stopAfter = 150;
    growingOutput({ native }); const cancellation = new AbortController();
    const entered = Promise.withResolvers<void>(); const ack = Promise.withResolvers<void>();
    const pending = synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: request(), cancellationSignal: cancellation.signal, onProgress: () => {}, preview: { requestedVersion: () => 1, onPreview: async () => {
      entered.resolve(); await ack.promise;
    } } });
    await entered.promise; expect(native.controls.steps).toBe(72);
    const rejected = expect(pending).rejects.toThrow('aborted'); cancellation.abort(); ack.resolve(); await rejected;
    expect(native.controls.steps).toBe(72); expect(native.owned.size).toBe(0);
  });
  it('finishes normally instead of taking another preview when completion was requested', async () => {
    const native = audioNativeFixture({ pointerBytes }); native.controls.stopAfter = 150;
    const outputs = growingOutput({ native }); const onPreview = vi.fn(async () => {});
    const result = await synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: request(), cancellationSignal: undefined, shouldComplete: () => native.controls.steps === 72, onProgress: () => {}, preview: { requestedVersion: () => 1, onPreview } });
    expect(outputs).toEqual([72]); expect(onPreview).not.toHaveBeenCalled(); expect(result.finishReason).toBe('user-stop');
  });
  it('supports Pocket exact-length previews without assuming Qwen block size', async () => {
    const native = audioNativeFixture({ pointerBytes }); native.controls.nativeType = 2; native.controls.stopAfter = 5;
    const outputs = growingOutput({ native }); const onPreview = vi.fn(async () => {});
    const result = await synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: { ...request(), reference: reference() }, cancellationSignal: undefined, onProgress: () => {}, preview: { requestedVersion: () => native.controls.steps > 1 ? 2 : 1, onPreview } });
    expect(outputs).toEqual([1, 2, 5]); expect(onPreview).toHaveBeenCalledTimes(2); expect(result.frames).toBe(5);
  });
  it('cleans resources on a failed preview delivery without reporting final success', async () => {
    const native = audioNativeFixture({ pointerBytes }); native.controls.stopAfter = 80;
    growingOutput({ native });
    await expect(synthesizeAudio({ core: native.core, context: 20n, projector: 30n, request: request(), cancellationSignal: undefined, onProgress: () => {}, preview: { requestedVersion: () => 1, onPreview: async () => {
      throw new Error('consumer gone');
    } } })).rejects.toThrow('consumer gone');
    expect(native.controls.steps).toBe(72); expect(native.owned.size).toBe(0);
  });
});
