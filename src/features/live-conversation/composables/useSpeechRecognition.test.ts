// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { useSpeechRecognition } from './useSpeechRecognition';
import { createSpeechRecognitionClient } from '@/features/speech-cpp-browser/recognition/worker/client';
import { recognitionClientFixture, recognitionInfo } from '@/features/speech-cpp-browser/recognition/recognition.test-support';
import { openLiveCapture, type LiveCapture } from '@/features/live-conversation/logic/audio-capture';
import { decodeLiveAudioFile } from '@/features/live-conversation/logic/audio-file';

vi.mock('@/features/speech-cpp-browser/recognition/worker/client', () => ({ createSpeechRecognitionClient: vi.fn() }));
vi.mock('@/features/live-conversation/logic/audio-capture', () => ({ openLiveCapture: vi.fn() }));
vi.mock('@/features/live-conversation/logic/audio-file', () => ({ decodeLiveAudioFile: vi.fn(), liveAudioSecondsLimit: 180 }));

function fixture() {
  const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:microphone');
  const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  let engine: ReturnType<typeof recognitionClientFixture> | undefined;
  vi.mocked(createSpeechRecognitionClient).mockImplementation(({ observers }) => {
    engine = recognitionClientFixture({ observers });
    return engine.client;
  });
  const finish = vi.fn<LiveCapture['finish']>(async () => {});
  vi.mocked(openLiveCapture).mockReset().mockResolvedValue({ finish });
  vi.mocked(decodeLiveAudioFile).mockClear();
  const scope = effectScope(), api = scope.run(() => useSpeechRecognition())!;
  return {
    api,
    engine: engine!,
    finish,
    revokeUrl,
    pcm(): void {
 vi.mocked(openLiveCapture).mock.calls.at(-1)![0].onPcm({ pcm: new Float32Array([0.25, -0.5]) });
    },
    async [Symbol.asyncDispose]() {
      await api.controller.dispose();
      scope.stop();
      createUrl.mockRestore();
      revokeUrl.mockRestore();
    },
  };
}

it('records a reusable source without a loaded model and never starts recognition or WAV decoding', async () => {
  await using value = fixture();
  await value.api.recording.start({ language: undefined });
  value.pcm();
  await value.api.recording.stop();
  expect(value.api.recordingState.value).toMatchObject({ phase: 'ready', clip: { sampleRate: 16000, status: 'complete' } });
  expect(value.api.recordingState.value.clip?.file).toBeInstanceOf(File);
  expect(value.engine.transcribe).not.toHaveBeenCalled();
  expect(decodeLiveAudioFile).not.toHaveBeenCalled();
});

it.each(['discard', 'clearRun', 'stop_before_ready', 'stop_after_ready'] as const)('prepares microphone input during model loading, then %s without cancelling the load', async action => {
  await using value = fixture();
  const loaded = Promise.withResolvers<void>();
  using loading = {
    spy: vi.spyOn(value.engine.client, 'loadModel').mockImplementation(async () => {
      value.engine.change({ state: { phase: 'loading_model', model: undefined } });
      await loaded.promise;
      value.engine.change({ state: { phase: 'ready', model: recognitionInfo } });
    }),
    [Symbol.dispose]() {
      this.spy.mockRestore();
    },
  };
  const task = value.api.controller.load({ file: new File([], 'model.gguf') });
  await vi.waitFor(() => expect(value.api.state.value.runtime.phase).toBe('loading_model'));
  value.engine.cancel.mockClear();
  await value.api.recording.start({ language: 'ja' });
  value.pcm();
  expect(value.api.recordingState.value.phase).toBe('recording');
  expect(value.engine.cancel).not.toHaveBeenCalled();
  let file: File | undefined;
  switch (action) {
  case 'discard': await value.api.recording.discard();
    break;
  case 'clearRun': await value.api.controller.clearRun();
    break;
  case 'stop_before_ready':
    await value.api.recording.stop();
    file = value.api.recordingState.value.clip!.file;
    expect(value.engine.transcribe).not.toHaveBeenCalled();
    break;
  case 'stop_after_ready': break;
  default: {
    const exhaustive: never = action;
    throw new Error(String(exhaustive));
  }
  }
  expect(value.api.state.value.runtime.phase).toBe('loading_model');
  expect(value.engine.cancel).not.toHaveBeenCalled();
  loaded.resolve();
  await task;
  switch (action) {
  case 'discard': case 'clearRun':
    expect(value.api.recordingState.value).toMatchObject({ phase: 'idle', clip: undefined });
    expect(value.engine.transcribe).not.toHaveBeenCalled();
    break;
  case 'stop_before_ready':
    expect(value.api.recordingState.value.clip!.file).toBe(file);
    expect(value.revokeUrl).not.toHaveBeenCalled();
    expect(value.engine.transcribe).not.toHaveBeenCalled();
    break;
  case 'stop_after_ready':
    expect(value.api.recordingState.value.phase).toBe('recording');
    expect(vi.mocked(openLiveCapture).mock.calls[0]![0].signal.aborted).toBe(false);
    await value.api.recording.stop();
    expect(value.engine.transcribe).toHaveBeenCalledOnce();
    break;
  default: {
    const exhaustive: never = action;
    throw new Error(String(exhaustive));
  }
  }
  expect(value.api.state.value.runtime.phase).toBe('ready');
  void loading;
});

it('recognizes captured PCM directly after stop and keeps its source across resident model changes', async () => {
  await using value = fixture();
  await value.api.controller.load({ file: new File([], 'model.gguf') });
  await value.api.recording.start({ language: 'ja' });
  value.pcm();
  await value.api.recording.stop();
  const clip = value.api.recordingState.value.clip!;
  expect(value.engine.transcribe).toHaveBeenCalledWith({ samples: new Float32Array([0.25, -0.5]), sampleRate: 16000, language: 'ja' });
  expect(value.api.state.value.run).toMatchObject({ inputName: clip.file.name, status: 'complete', inputSeconds: 2 / 16000 });
  expect(decodeLiveAudioFile).not.toHaveBeenCalled();
  await value.api.controller.load({ file: new File([], 'replacement.gguf') });
  expect(vi.mocked(openLiveCapture).mock.calls[0]![0].signal.aborted).toBe(true);
  expect(value.api.recordingState.value.clip).toBe(clip);
  expect(value.revokeUrl).not.toHaveBeenCalled();
  expect(value.engine.transcribe).toHaveBeenCalledOnce();
  expect((await clip.file.arrayBuffer()).byteLength).toBe(52);
  await value.api.controller.release();
  expect(value.api.recordingState.value.clip).toBeUndefined();
  expect(value.revokeUrl).toHaveBeenCalledWith('blob:microphone');
});

it.each(['opening', 'recording'] as const)('keeps %s capture across a later model load without reusing its old investigation binding', async phase => {
  await using value = fixture();
  await value.api.controller.load({ file: new File([], 'first.gguf') });
  const permission = Promise.withResolvers<LiveCapture>();
  switch (phase) {
  case 'opening': vi.mocked(openLiveCapture).mockReturnValueOnce(permission.promise);
    break;
  case 'recording': break;
  default: {
    const exhaustive: never = phase;
    throw new Error(String(exhaustive));
  }
  }
  const context = { operationId: 'old-model', source: 'investigation' as const }, observer = vi.fn();
  const opening = value.api.recording.start({ language: 'ja', investigation: { context, observer } });
  await vi.waitFor(() => expect(value.api.recordingState.value.phase).toBe(phase));
  const signal = vi.mocked(openLiveCapture).mock.calls[0]![0].signal;
  await value.api.controller.load({ file: new File([], 'replacement.gguf') });
  expect(value.api.recordingState.value.phase).toBe(phase);
  expect(signal.aborted).toBe(false);
  expect(value.finish).not.toHaveBeenCalled();
  permission.resolve({ finish: value.finish });
  await opening;
  value.pcm();
  await value.api.recording.stop();
  expect(value.api.recordingState.value.clip).toBeDefined();
  expect(value.engine.transcribe).toHaveBeenCalledOnce();
  expect(value.engine.transcribe.mock.calls[0]![0]).not.toHaveProperty('investigation');
  expect(observer).not.toHaveBeenCalled();
});

it('keeps a finalizing source while a new load invalidates its delayed automatic recognition', async () => {
  await using value = fixture();
  await value.api.controller.load({ file: new File([], 'first.gguf') });
  await value.api.recording.start({ language: undefined });
  value.pcm();
  const flushed = Promise.withResolvers<void>();
  value.finish.mockImplementation(async ({ action }) => {
    if (action === 'send') {
      await flushed.promise;
    }
  });
  const stopped = value.api.recording.stop();
  await vi.waitFor(() => expect(value.api.recordingState.value.phase).toBe('stopping'));
  await value.api.controller.load({ file: new File([], 'replacement.gguf') });
  expect(value.api.recordingState.value.phase).toBe('stopping');
  flushed.resolve();
  await stopped;
  expect(value.api.recordingState.value).toMatchObject({ phase: 'ready', clip: { status: 'complete' } });
  expect(value.engine.transcribe).not.toHaveBeenCalled();
  expect(value.revokeUrl).not.toHaveBeenCalled();
});

it('forwards an explicit recording binding to the automatic PCM recognition and drops late events', async () => {
  await using value = fixture();
  await value.api.controller.load({ file: new File([], 'model.gguf') });
  const context = { operationId: 'recorded-attempt', source: 'investigation' as const }, observer = vi.fn();
  const event = { kind: 'wasm_heap' as const, capacityBytes: 65536 };
  value.engine.transcribe.mockImplementation(async () => {
    value.engine.observe({ context, event });
    return { text: 'result', languages: ['ja'], status: 'complete' };
  });
  await value.api.recording.start({ language: 'ja', investigation: { context, observer } });
  value.pcm();
  await value.api.recording.stop();
  expect(value.engine.transcribe).toHaveBeenCalledWith(expect.objectContaining({ investigation: context }));
  expect(observer).toHaveBeenCalledWith({ event });
  value.engine.observe({ context, event });
  expect(observer).toHaveBeenCalledOnce();
});

it('releases a pending microphone permission before model teardown and closes its late handle', async () => {
  await using value = fixture();
  const permission = Promise.withResolvers<LiveCapture>();
  vi.mocked(openLiveCapture).mockReturnValueOnce(permission.promise);
  const opening = value.api.recording.start({ language: undefined });
  await value.api.controller.release();
  await opening;
  expect(vi.mocked(openLiveCapture).mock.calls[0]![0].signal.aborted).toBe(true);
  expect(value.engine.releaseModel).toHaveBeenCalledOnce();
  permission.resolve({ finish: value.finish });
  await Promise.resolve();
  expect(value.finish).toHaveBeenCalledWith({ action: 'discard' });
  expect(value.api.recordingState.value.phase).toBe('idle');
});

it.each(['recognize', 'discard', 'replace', 'load'] as const)('waits for prior recognition cancellation before the new clip, then %s', async action => {
  await using value = fixture();
  await value.api.controller.load({ file: new File([], 'model.gguf') });
  const previousResult = Promise.withResolvers<{ text: string, languages: string[], status: 'cancelled' }>();
  value.engine.transcribe.mockReturnValueOnce(previousResult.promise);
  const previousRun = value.api.controller.runAudio({ samples: new Float32Array(2), sampleRate: 16000, inputName: 'previous.wav', language: undefined });
  await vi.waitFor(() => expect(value.engine.transcribe).toHaveBeenCalledOnce());
  const cancelled = Promise.withResolvers<void>();
  value.engine.cancel.mockImplementation(async () => {
    value.engine.change({ state: { phase: 'cancelling' } });
    await cancelled.promise;
    previousResult.resolve({ text: '', languages: [], status: 'cancelled' });
    value.engine.change({ state: { phase: 'ready' } });
  });
  const opening = value.api.recording.start({ language: 'ja' });
  await vi.waitFor(() => expect(value.api.recordingState.value.phase).toBe('recording'));
  value.pcm();
  const stopped = value.api.recording.stop();
  await vi.waitFor(() => expect(value.api.recordingState.value.phase).toBe('ready'));
  expect(value.engine.transcribe).toHaveBeenCalledOnce();
  let changed: Promise<void> | undefined;
  switch (action) {
  case 'recognize': break;
  case 'discard': changed = value.api.recording.discard();
    break;
  case 'replace': changed = value.api.recording.start({ language: undefined });
    break;
  case 'load': changed = value.api.controller.load({ file: new File([], 'replacement.gguf') });
    break;
  default: {
    const exhaustive: never = action;
    throw new Error(String(exhaustive));
  }
  }
  cancelled.resolve();
  await opening;
  await stopped;
  await changed;
  await previousRun;
  switch (action) {
  case 'recognize': expect(value.engine.transcribe).toHaveBeenCalledTimes(2);
    break;
  case 'discard': case 'replace': case 'load': expect(value.engine.transcribe).toHaveBeenCalledOnce();
    break;
  default: {
    const exhaustive: never = action;
    throw new Error(String(exhaustive));
  }
  }
});
