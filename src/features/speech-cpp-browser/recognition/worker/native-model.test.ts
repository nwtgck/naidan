// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { openNativeSpeechRecognitionModel } from './native-model';
import { nativeRecognitionFixture } from './native-model.test-support';
import { recognitionFile } from '@/features/speech-cpp-browser/recognition/recognition.test-support';

it.each([4, 8] as const)('uses %s-byte C pointer slots and the matching progress callback signature', async pointerBytes => {
  const native = nativeRecognitionFixture({ pointerBytes });
  const file = await recognitionFile({ architecture: 'qwen3-asr', task: 'recognition', sampleRate: 16000 });
  const model = await openNativeSpeechRecognitionModel({ ...native, file, signal: new AbortController().signal, readBlob: () => new ArrayBuffer(0), onProgress() {} });
  await using cleanup = {
    async [Symbol.asyncDispose]() {
      await model.release();
    },
  };
  const onProgress = vi.fn();
  native.api.speech_transcribe = vi.fn(async request => {
    expect(request).toBe(40n);
    expect(native.addFunction.mock.calls[0]![1]).toBe(pointerBytes === 4 ? 'idi' : 'idj');
    native.addFunction.mock.calls[0]![0](0.5, pointerBytes === 4 ? 0 : 0n);
    return 0;
  });
  expect(await model.transcribe({ samples: new Float32Array(4), sampleRate: 16000, language: undefined, onProgress })).toMatchObject({ text: 'こんにちは', status: 'complete' });
  expect(onProgress).toHaveBeenCalledWith({ progress: 0.5 });
  expect(native.api.speech_request_free).toHaveBeenCalledWith(40n);
  void cleanup;
});

async function fixture() {
  const native = nativeRecognitionFixture({ pointerBytes: 8 });
  const file = await recognitionFile({ architecture: 'qwen3-asr', task: 'recognition', sampleRate: 16000 });
  const model = await openNativeSpeechRecognitionModel({ ...native, file, signal: new AbortController().signal, readBlob: () => new ArrayBuffer(0), onProgress() {} });
  return {
    ...native,
    model,
    async [Symbol.asyncDispose]() {
      await model.release();
    },
  };
}

it('copies PCM at its real rate, frees staging before inference, and copies borrowed text before request release', async () => {
  await using native = await fixture();
  expect(native.model.info).toMatchObject({ languages: ['ja'], languageSelection: 'supported', sampleRate: 16000 });
  expect(native.calls.indexOf('load_model')).toBeLessThan(native.calls.indexOf('get_info'));
  expect(vi.mocked(native.api.speech_model_get_info!).mock.calls[0]![0]).toBe(30n);
  expect(native.api.speech_model_info_free).toHaveBeenCalledExactlyOnceWith(10n);
  expect(native.api.speech_model_free).not.toHaveBeenCalled();
  const samples = new Float32Array([0, -0.25, 0.5]);
  native.api.speech_transcribe = vi.fn(async () => {
    const args = vi.mocked(native.api.speech_request_set_audio!).mock.calls[0]!;
    expect(args[2]).toBe(3n);
    expect(args[3]).toBe(24000);
    expect(Array.from(new Float32Array(native.heap.buffer, Number(args[1]), 3))).toEqual([0, -0.25, 0.5]);
    expect(native.freed).toContain(args[1]);
    native.addFunction.mock.calls[0]![0](0.5, 0n);
    return 0;
  });
  const progress = vi.fn();
  expect(await native.model.transcribe({ samples, sampleRate: 24000, language: 'ja', onProgress: progress })).toEqual({ text: 'こんにちは', languages: ['ja'], status: 'complete' });
  expect(native.strings.has(100n)).toBe(false);
  expect(native.api.speech_request_free).toHaveBeenCalledOnce();
  expect(native.removeFunction).toHaveBeenCalledWith(123n);
  expect(progress).toHaveBeenCalledWith({ progress: 0.5 });
});

it('uses the registered synchronous cancel leaf during a busy transcribe and preserves partial results', async () => {
  await using native = await fixture();
  native.api.speech_transcribe = vi.fn(async () => {
    native.model.cancel();
    return 1;
  });
  native.api.speech_result_stop = vi.fn(async () => 3);
  expect(await native.model.transcribe({ samples: new Float32Array(4), sampleRate: 16000, language: undefined, onProgress() {} })).toMatchObject({ text: 'こんにちは', status: 'cancelled' });
  expect(native.sync).toHaveBeenCalledWith({ name: 'speech_request_cancel', args: [40n] });
  expect(native.api.speech_request_free).toHaveBeenCalledOnce();
});

it('captures native status/input before cleanup and frees request/callback on failure', async () => {
  await using native = await fixture();
  native.api.speech_transcribe = vi.fn(async () => -5);
  await expect(native.model.transcribe({ samples: new Float32Array(4), sampleRate: 16000, language: undefined, onProgress() {} })).rejects.toMatchObject({ details: { nativeStatus: -5, nativeInput: 'audio', message: 'native error' } });
  expect(native.api.speech_request_free).toHaveBeenCalledOnce();
  expect(native.removeFunction).toHaveBeenCalledWith(123n);
});

it('rejects unsupported language and invalid PCM before allocating a native request', async () => {
  await using native = await fixture();
  await expect(native.model.transcribe({ samples: new Float32Array(4), sampleRate: 16000, language: 'de', onProgress() {} })).rejects.toThrow();
  await expect(native.model.transcribe({ samples: new Float32Array([NaN]), sampleRate: 16000, language: undefined, onProgress() {} })).rejects.toThrow();
  expect(native.api.speech_request_new).not.toHaveBeenCalled();
});

it.each(['task', 'sample_rate'] as const)('releases the loaded model, metadata snapshot and mount when native %s disagrees', async field => {
  const native = nativeRecognitionFixture({ pointerBytes: 8 });
  if (field === 'task') {
    native.api.speech_model_info_task = vi.fn(async () => 2);
  } else {
    native.api.speech_model_info_sample_rate = vi.fn(async () => 24000);
  }
  const file = await recognitionFile({ architecture: 'qwen3-asr', task: 'recognition', sampleRate: 16000 });
  await expect(openNativeSpeechRecognitionModel({ ...native, file, signal: new AbortController().signal, readBlob: () => new ArrayBuffer(0), onProgress() {} })).rejects.toMatchObject({ details: { code: 'invalid_model' } });
  expect(native.api.speech_model_free).toHaveBeenCalledExactlyOnceWith(30n);
  expect(native.api.speech_model_info_free).toHaveBeenCalledExactlyOnceWith(10n);
  expect(native.api.speech_load_params_free).toHaveBeenCalledExactlyOnceWith(20n);
  expect(native.remove).toHaveBeenCalledOnce();
});

it.each(['load', 'metadata'] as const)('preserves a native %s error before releasing owned handles', async phase => {
  const native = nativeRecognitionFixture({ pointerBytes: 8 });
  if (phase === 'load') {
    native.api.speech_model_load = vi.fn(async (_path, _params, output) => {
      native.writePointer({ output, value: 30n });
      return -5;
    });
  } else {
    native.api.speech_model_get_info = vi.fn(async (_model, output) => {
      native.writePointer({ output, value: 10n });
      return -5;
    });
  }
  native.api.speech_model_free = vi.fn(async () => {
    native.strings.set(300n, 'cleanup error');
    native.strings.set(400n, 'cleanup');
  });
  const file = await recognitionFile({ architecture: 'qwen3-asr', task: 'recognition', sampleRate: 16000 });
  await expect(openNativeSpeechRecognitionModel({ ...native, file, signal: new AbortController().signal, readBlob: () => new ArrayBuffer(0), onProgress() {} })).rejects.toMatchObject({ details: { nativeStatus: -5, nativeInput: 'audio', message: 'native error' } });
  expect(native.api.speech_model_free).toHaveBeenCalledExactlyOnceWith(30n);
  expect(native.api.speech_load_params_free).toHaveBeenCalledExactlyOnceWith(20n);
  expect(native.remove).toHaveBeenCalledOnce();
  if (phase === 'load') {
    expect(native.api.speech_model_get_info).not.toHaveBeenCalled();
    expect(native.api.speech_model_info_free).not.toHaveBeenCalled();
  } else {
    expect(native.api.speech_model_info_free).toHaveBeenCalledExactlyOnceWith(10n);
  }
});

it.each(['load', 'metadata', 'options'] as const)('releases owned load resources when cancellation occurs during %s', async phase => {
  const native = nativeRecognitionFixture({ pointerBytes: 8 }), controller = new AbortController();
  const reason = new Error('cancelled model load');
  if (phase === 'load') {
    native.api.speech_model_load = vi.fn(async (_path, _params, output) => {
      native.writePointer({ output, value: 30n });
      controller.abort(reason);
      return 0;
    });
  } else if (phase === 'metadata') {
    native.api.speech_model_get_info = vi.fn(async (_model, output) => {
      native.writePointer({ output, value: 10n });
      controller.abort(reason);
      return 0;
    });
  } else {
    native.api.speech_model_info_option_count = vi.fn(async () => {
      controller.abort(reason);
      return 0n;
    });
  }
  const file = await recognitionFile({ architecture: 'qwen3-asr', task: 'recognition', sampleRate: 16000 });
  await expect(openNativeSpeechRecognitionModel({ ...native, file, signal: controller.signal, readBlob: () => new ArrayBuffer(0), onProgress() {} })).rejects.toBe(reason);
  expect(native.api.speech_model_free).toHaveBeenCalledExactlyOnceWith(30n);
  expect(native.api.speech_load_params_free).toHaveBeenCalledExactlyOnceWith(20n);
  expect(native.remove).toHaveBeenCalledOnce();
  if (phase === 'load') {
    expect(native.api.speech_model_get_info).not.toHaveBeenCalled();
    expect(native.api.speech_model_info_free).not.toHaveBeenCalled();
  } else {
    expect(native.api.speech_model_info_free).toHaveBeenCalledExactlyOnceWith(10n);
  }
});
