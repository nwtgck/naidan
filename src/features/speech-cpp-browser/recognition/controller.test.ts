import { expect, it, vi } from 'vitest';
import { createSpeechRecognitionController } from './controller';
import { recognitionClientFixture, recognitionInfo } from './recognition.test-support';
import { SpeechRuntimeError } from '@/features/speech-cpp-browser/types';
import type { SpeechRecognitionClient } from './types';

function fixture() {
  let engine: ReturnType<typeof recognitionClientFixture> | undefined;
  let time = 0;
  const samples = new Float32Array([0, -0.25, 0.5]);
  const decodeFile = vi.fn<Parameters<typeof createSpeechRecognitionController>[0]['decodeFile']>(async () => {
    time = 50;
    return samples;
  });
  const controller = createSpeechRecognitionController({
    createClient({ observers }) {
      engine = recognitionClientFixture({ observers });
      return engine.client;
    },
    decodeFile,
    now: () => time,
    onChange() {},
  });
  return {
    controller,
    engine: engine!,
    decodeFile,
    samples,
    advance({ milliseconds }: { milliseconds: number }) {
      time += milliseconds;
    },
    async [Symbol.asyncDispose]() {
      await controller.dispose();
    },
  };
}

it('uses the model sample rate without modifying PCM, measures separate stages and preserves snapshots after model release', async () => {
  await using value = fixture();
  const file = new File(['source'], 'same-input.wav');
  await value.controller.load({ file: new File([], 'recognizer.gguf') });
  value.engine.transcribe.mockImplementation(async () => {
    value.advance({ milliseconds: 250 });
    return { text: 'こんにちは', languages: ['ja'], status: 'complete' };
  });
  await value.controller.runFile({ file, language: 'ja' });
  expect(value.decodeFile).toHaveBeenCalledWith({ file, sampleRate: 16000, signal: expect.any(AbortSignal) });
  expect(value.engine.transcribe).toHaveBeenCalledWith({ samples: value.samples, sampleRate: 16000, language: 'ja' });
  expect(value.controller.getState().run).toMatchObject({ modelName: 'recognizer.gguf', inputName: 'same-input.wav', status: 'complete', text: 'こんにちは', languages: ['ja'], inputSeconds: 3 / 16000, preparationSeconds: 0.05, recognitionSeconds: 0.25 });
  const run = value.controller.getState().run;
  await value.controller.release();
  expect(value.controller.getState().runtime.model).toBeUndefined();
  expect(value.controller.getState().run).toBe(run);
  await value.controller.clearRun();
  expect(value.controller.getState().run).toBeUndefined();
});

it.each(['clearRun', 'cancelRun'] as const)('%s preserves a pending model load without calling native cancel', async operation => {
  await using value = fixture();
  await value.controller.load({ file: new File([], 'first.gguf') });
  await value.controller.runFile({ file: new File([], 'input.wav'), language: undefined });
  const previous = value.controller.getState().run;
  const loaded = Promise.withResolvers<void>();
  using loading = {
    spy: vi.spyOn(value.engine.client, 'loadModel').mockImplementation(async () => {
      value.engine.change({ state: { phase: 'loading_model', model: undefined, loadProgress: { stage: 'checking_model' } } });
      await loaded.promise;
      value.engine.change({ state: { phase: 'ready', model: recognitionInfo, loadProgress: undefined } });
    }),
    [Symbol.dispose]() {
      this.spy.mockRestore();
    },
  };
  const task = value.controller.load({ file: new File([], 'replacement.gguf') });
  await vi.waitFor(() => expect(value.controller.getState().runtime.phase).toBe('loading_model'));
  value.engine.cancel.mockClear();
  await value.controller[operation]();
  expect(value.engine.cancel).not.toHaveBeenCalled();
  expect(value.controller.getState().runtime).toMatchObject({ phase: 'loading_model', model: undefined, loadProgress: { stage: 'checking_model' } });
  expect(value.controller.getState().run).toBe(operation === 'clearRun' ? undefined : previous);
  loaded.resolve();
  await task;
  expect(value.controller.getState().runtime).toMatchObject({ phase: 'ready', model: recognitionInfo });
  void loading;
});

it.each(['cancel', 'release', 'dispose'] as const)('explicit %s still cancels a pending model load', async operation => {
  await using value = fixture();
  const loaded = Promise.withResolvers<void>();
  using loading = {
    spy: vi.spyOn(value.engine.client, 'loadModel').mockImplementation(async () => {
      value.engine.change({ state: { phase: 'loading_model', model: undefined } });
      await loaded.promise;
    }),
    [Symbol.dispose]() {
      this.spy.mockRestore();
    },
  };
  const task = value.controller.load({ file: new File([], 'model.gguf') });
  await vi.waitFor(() => expect(value.controller.getState().runtime.phase).toBe('loading_model'));
  value.engine.cancel.mockClear().mockImplementation(async () => {
    value.engine.change({ state: { phase: 'unloaded' } });
    loaded.resolve();
  });
  await value.controller[operation]();
  await task;
  expect(value.engine.cancel).toHaveBeenCalledOnce();
  expect(value.controller.getState().runtime.phase).not.toBe('loading_model');
  void loading;
});

it('keeps an actual runtime failure when clearing an unrelated result', async () => {
  await using value = fixture();
  const failure = { code: 'runtime_failed' as const, message: 'model load failed', nativeStatus: -5, nativeInput: undefined };
  value.engine.change({ state: { phase: 'failed', failure } });
  await value.controller.clearRun();
  expect(value.engine.cancel).not.toHaveBeenCalled();
  expect(value.controller.getState()).toMatchObject({ run: undefined, failure, runtime: { phase: 'failed', failure } });
});

it('accepts microphone PCM without a WAV decode roundtrip and preserves its actual sample rate', async () => {
  await using value = fixture();
  await value.controller.load({ file: new File([], 'recognizer.gguf') });
  const samples = new Float32Array([0.25, -0.5]);
  await value.controller.runAudio({ samples, sampleRate: 24000, inputName: 'microphone.wav', language: undefined });
  expect(value.decodeFile).not.toHaveBeenCalled();
  expect(value.engine.transcribe).toHaveBeenCalledWith({ samples, sampleRate: 24000, language: undefined });
  expect(value.controller.getState().run).toMatchObject({ inputName: 'microphone.wav', inputSeconds: 2 / 24000, status: 'complete' });
});

it('reuses a load attempt binding for the first run while keeping observer callbacks out of native arguments', async () => {
  await using value = fixture();
  const observer = vi.fn(), context = { operationId: 'attempt', source: 'investigation' as const };
  const investigation = { context, observer }, event = { kind: 'wasm_heap' as const, capacityBytes: 65536 };
  using loading = {
    spy: vi.spyOn(value.engine.client, 'loadModel').mockImplementation(async () => {
      value.engine.change({ state: { phase: 'ready', model: { name: 'recognizer.gguf', bytes: 1, architecture: 'qwen3-asr', task: 'recognition', sampleRate: 16000, requiredVersion: 'test', languages: ['ja'], languageSelection: 'supported' } } });
      value.engine.observe({ context, event });
    }),
    [Symbol.dispose]() {
      this.spy.mockRestore();
    },
  };
  await value.controller.load({ file: new File([], 'model.gguf'), investigation });
  expect(loading.spy).toHaveBeenCalledWith(expect.objectContaining({ investigation: context }));
  value.engine.transcribe.mockImplementation(async () => {
    value.engine.observe({ context, event });
    return { text: 'result', languages: ['ja'], status: 'complete' };
  });
  await value.controller.runAudio({ samples: new Float32Array(4), sampleRate: 16000, inputName: 'microphone.wav', language: undefined, investigation });
  expect(value.engine.transcribe).toHaveBeenCalledWith(expect.objectContaining({ investigation: context }));
  expect(observer).toHaveBeenCalledTimes(2);
  value.engine.observe({ context, event });
  expect(observer).toHaveBeenCalledTimes(2);
  value.engine.transcribe.mockImplementation(async () => {
    value.engine.observe({ context, event });
    return { text: 'normal', languages: [], status: 'complete' };
  });
  await value.controller.runFile({ file: new File([], 'normal.wav'), language: undefined });
  const args = vi.mocked(value.engine.client.transcribe).mock.calls.at(-1)![0] satisfies Parameters<SpeechRecognitionClient['transcribe']>[0];
  expect(args).not.toHaveProperty('investigation');
  expect(observer).toHaveBeenCalledTimes(2);
});

it.each(['cancel', 'cancelRun', 'clearRun', 'release', 'dispose'] as const)('%s finishes without waiting for an uninterruptible decoder and ignores late decoded samples', async operation => {
  await using value = fixture();
  const decoded = Promise.withResolvers<Float32Array<ArrayBuffer>>();
  value.decodeFile.mockReturnValue(decoded.promise);
  await value.controller.load({ file: new File([], 'recognizer.gguf') });
  const running = value.controller.runFile({ file: new File([], 'input.wav'), language: undefined });
  await vi.waitFor(() => expect(value.decodeFile).toHaveBeenCalledOnce());
  await value.controller[operation]();
  expect(value.decodeFile.mock.calls[0]?.[0]).toMatchObject({ signal: { aborted: true } });
  await running;
  expect(value.engine.transcribe).not.toHaveBeenCalled();
  if (operation === 'clearRun' || operation === 'dispose') {
    expect(value.controller.getState().run).toBeUndefined();
  } else {
    expect(value.controller.getState().run?.status).toBe('cancelled');
  }
  decoded.resolve(new Float32Array(16000));
  await Promise.resolve();
  expect(value.engine.transcribe).not.toHaveBeenCalled();
});

it('retains partial cancelled text, distinguishes model limits and preserves native failure details', async () => {
  await using value = fixture();
  await value.controller.load({ file: new File([], 'recognizer.gguf') });
  const result = Promise.withResolvers<{ text: string, languages: string[], status: 'cancelled' }>();
  value.engine.transcribe.mockReturnValueOnce(result.promise);
  const running = value.controller.runFile({ file: new File([], 'input.wav'), language: undefined });
  await vi.waitFor(() => expect(value.engine.transcribe).toHaveBeenCalledOnce());
  const cancelling = value.controller.cancel();
  result.resolve({ text: 'こん', languages: ['ja'], status: 'cancelled' });
  await cancelling;
  await running;
  expect(value.controller.getState().run).toMatchObject({ text: 'こん', status: 'cancelled' });
  value.engine.complete({ result: { text: '途中', languages: ['ja'], status: 'model_limit' } });
  await value.controller.runFile({ file: new File([], 'next.wav'), language: undefined });
  expect(value.controller.getState().run).toMatchObject({ text: '途中', status: 'model_limit' });
  value.engine.transcribe.mockRejectedValueOnce(new Error('native failure'));
  await value.controller.runFile({ file: new File([], 'failed.wav'), language: undefined });
  expect(value.controller.getState().run).toMatchObject({ status: 'failed', failure: { message: 'native failure' } });
});

it('preserves a native failure arriving after cancellation instead of presenting a successful cancellation', async () => {
  await using value = fixture();
  await value.controller.load({ file: new File([], 'recognizer.gguf') });
  const result = Promise.withResolvers<never>();
  value.engine.transcribe.mockReturnValueOnce(result.promise);
  const running = value.controller.runFile({ file: new File([], 'input.wav'), language: undefined });
  await vi.waitFor(() => expect(value.engine.transcribe).toHaveBeenCalledOnce());
  const cancelling = value.controller.cancel();
  result.reject(new SpeechRuntimeError({ details: { code: 'runtime_failed', message: 'native error', nativeStatus: -5, nativeInput: 'audio' } }));
  await cancelling;
  await running;
  expect(value.controller.getState().run).toMatchObject({ status: 'failed', failure: { nativeStatus: -5, nativeInput: 'audio' } });
});

it.each(['model_limit', 'max_seconds'] as const)('preserves native %s when cancellation races with the result', async status => {
  await using value = fixture();
  await value.controller.load({ file: new File([], 'recognizer.gguf') });
  const result = Promise.withResolvers<{ text: string, languages: string[], status: typeof status }>();
  value.engine.transcribe.mockReturnValueOnce(result.promise);
  const running = value.controller.runFile({ file: new File([], 'input.wav'), language: undefined });
  await vi.waitFor(() => expect(value.engine.transcribe).toHaveBeenCalledOnce());
  const cancelling = value.controller.cancel();
  result.resolve({ text: '途中', languages: ['ja'], status });
  await cancelling;
  await running;
  expect(value.controller.getState().run).toMatchObject({ text: '途中', status });
});
