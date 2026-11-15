// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { openNativeSpeechModel } from './native-model';
import { observedNativeFixture } from './native-observation.test-support';
import { speechModelFile } from './model-file.test-support';
import type { SpeechInvestigationEvent } from '@/features/speech-cpp-browser/investigation/types';

it('starts diagnostic observation on an already resident ordinary dialogue model and releases it with the dialogue', async () => {
  const native = observedNativeFixture();
  native.api.speech_request_set_float = vi.fn(async () => 0);
  native.api.speech_dialogue_start = vi.fn(async (_request, _rate, _callback, _user, output) => {
    native.writePointer({ output, value: 60n });
    return 0;
  });
  native.api.speech_dialogue_push = vi.fn(async () => 1);
  native.api.speech_dialogue_free = vi.fn(async () => {});
  const file = await speechModelFile({ architecture: 'haru', name: 'dialogue.gguf', frameSamples: 3200 });
  const model = await openNativeSpeechModel({ ...native, file, signal: new AbortController().signal, readBlob: () => new ArrayBuffer(0), onProgress() {} });
  await using cleanup = {
    async [Symbol.asyncDispose]() {
      await model.release();
    },
  };
  expect(native.api.speech_log_set).not.toHaveBeenCalled();
  expect(native.api.speech_model_get_info).not.toHaveBeenCalled();
  const events: SpeechInvestigationEvent[] = [];
  const dialogue = await model.start({ options: { inputSampleRate: 24000, maxSeconds: 10, language: 'ja', persona: undefined, name: undefined, seed: undefined }, onFrame: () => 'continue', investigation: ({ event }) => events.push(event) });
  expect(native.api.speech_model_get_info).toHaveBeenCalledOnce();
  expect(await dialogue.push({ samples: new Float32Array(3200) })).toEqual({ kind: 'completed', reason: 'cancelled' });
  await dialogue.release();
  expect(events).toContainEqual(expect.objectContaining({ kind: 'model_info' }));
  expect(events).toContainEqual(expect.objectContaining({ kind: 'result', nativeStatus: 1, stop: { status: 'observed', value: 'cancelled', source: expect.any(String) }, seed: { status: 'unavailable', reason: expect.any(String) } }));
  expect(native.api.speech_log_set).toHaveBeenCalledOnce();
  expect(native.removeFunction).toHaveBeenCalledOnce();
  void cleanup;
});

it('preserves a native end failure as failed with its original status through dialogue teardown', async () => {
  const native = observedNativeFixture();
  native.api.speech_request_set_float = vi.fn(async () => 0);
  native.api.speech_dialogue_start = vi.fn(async (_request, _rate, _callback, _user, output) => {
    native.writePointer({ output, value: 60n });
    return 0;
  });
  native.api.speech_dialogue_end = vi.fn(async () => -5);
  native.api.speech_dialogue_free = vi.fn(async () => {});
  const file = await speechModelFile({ architecture: 'haru', name: 'dialogue.gguf', frameSamples: 3200 });
  const model = await openNativeSpeechModel({ ...native, file, signal: new AbortController().signal, readBlob: () => new ArrayBuffer(0), onProgress() {} });
  await using cleanup = {
    async [Symbol.asyncDispose]() {
      await model.release();
    },
  };
  const events: SpeechInvestigationEvent[] = [];
  const dialogue = await model.start({ options: { inputSampleRate: 24000, maxSeconds: 10, language: 'ja', persona: undefined, name: undefined, seed: undefined }, onFrame: () => 'continue', investigation: ({ event }) => events.push(event) });
  model.cancel();
  await expect(dialogue.end()).rejects.toMatchObject({ details: { nativeStatus: -5, nativeInput: 'audio', message: 'native error' } });
  await dialogue.release();
  expect(events).toContainEqual({ kind: 'failure', stage: 'speech_dialogue_end', failure: { code: 'runtime_failed', message: 'native error', nativeStatus: -5, nativeInput: 'audio' } });
  expect(events).toContainEqual(expect.objectContaining({ kind: 'stage', stage: 'speech_dialogue_lifetime', state: 'failed' }));
  expect(events.filter(event => event.kind === 'result')).toHaveLength(1);
  expect(events).toContainEqual(expect.objectContaining({ kind: 'result', nativeStatus: -5 }));
  void cleanup;
});
