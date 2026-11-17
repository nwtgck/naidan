// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { transcriptionRegionSeconds } from './continuous-transcription';
import { createAudioTranscriptionController } from './transcription-controller';
import { recognitionClientFixture } from '@/features/speech-cpp-browser/recognition/recognition.test-support';
import type { SpeechRecognitionResult } from '@/features/speech-cpp-browser/recognition/types';
import { SpeechRuntimeError } from '@/features/speech-cpp-browser/types';
import type { LiveCapture } from '@/features/live-conversation/logic/audio-capture';

function fixture() {
  let engine: ReturnType<typeof recognitionClientFixture> | undefined;
  const finish = vi.fn<LiveCapture['finish']>(async () => {});
  const capture = vi.fn<Parameters<typeof createAudioTranscriptionController>[0]['capture']>(async () => ({ finish }));
  const decodeFile = vi.fn<Parameters<typeof createAudioTranscriptionController>[0]['decodeFile']>(async () => new Float32Array(16000));
  const controller = createAudioTranscriptionController({
    createClient({ observers }) {
      engine = recognitionClientFixture({ observers });
      return engine.client;
    },
    capture,
    decodeFile,
    now: () => 0,
    onChange() {},
  });
  return {
    controller,
    engine: engine!,
    capture,
    finish,
    decodeFile,
    pcm({ seconds }: { seconds: number }): void {
      capture.mock.calls.at(-1)![0].onPcm({ pcm: new Float32Array(seconds * 16000).fill(0.25) });
    },
    async load(): Promise<void> {
      await controller.load({ file: new File([], 'recognizer.gguf') });
    },
    async [Symbol.asyncDispose]() {
      await controller.dispose();
    },
  };
}

it('requires a loaded model before opening a microphone', async () => {
  await using value = fixture();
  await value.controller.start({ language: undefined, maxRegionSeconds: transcriptionRegionSeconds });
  expect(value.capture).not.toHaveBeenCalled();
  expect(value.controller.getState()).toMatchObject({ phase: 'failed', failure: { code: 'invalid_state' } });
});

it('recognizes during capture, replaces provisional text, and keeps the resident model across pause and resume', async () => {
  await using value = fixture();
  await value.load();
  const load = vi.spyOn(value.engine.client, 'loadModel');
  value.engine.transcribe.mockResolvedValueOnce({ text: 'first draft', languages: ['ja'], status: 'complete' }).mockResolvedValueOnce({ text: 'first sentence', languages: ['ja'], status: 'complete' }).mockResolvedValueOnce({ text: 'second sentence', languages: ['en'], status: 'complete' });
  await value.controller.start({ language: 'ja', maxRegionSeconds: transcriptionRegionSeconds });
  value.pcm({ seconds: 1 });
  await vi.waitFor(() => expect(value.controller.getState().provisionalText).toBe('first draft'));
  expect(value.controller.getState()).toMatchObject({ phase: 'recording', confirmedText: '' });
  value.pcm({ seconds: 1 });
  await value.controller.pause();
  expect(value.finish).toHaveBeenCalledWith({ action: 'send' });
  expect(value.controller.getState()).toMatchObject({ phase: 'paused', confirmedText: 'first sentence', provisionalText: '', confirmedRevision: 1 });
  await value.controller.resume({ language: 'en', maxRegionSeconds: transcriptionRegionSeconds });
  value.pcm({ seconds: 1 });
  await value.controller.stop();
  expect(value.controller.getState()).toMatchObject({
    phase: 'complete',
    confirmedText: `\
first sentence
second sentence`,
    confirmedRevision: 2,
    recordedSeconds: 3,
  });
  expect(value.engine.transcribe.mock.calls.map(([args]) => args.language)).toEqual(['ja', 'ja', 'en']);
  expect(value.engine.cancel).toHaveBeenCalledOnce();
  expect(load).not.toHaveBeenCalled();
  expect(value.decodeFile).not.toHaveBeenCalled();
  load.mockRestore();
});

it('includes capture flush PCM before final recognition and stop waits without cancelling the recognizer', async () => {
  await using value = fixture();
  await value.load();
  await value.controller.start({ language: undefined, maxRegionSeconds: transcriptionRegionSeconds });
  const result = Promise.withResolvers<SpeechRecognitionResult>();
  value.engine.transcribe.mockReturnValueOnce(result.promise);
  value.pcm({ seconds: 1 });
  await vi.waitFor(() => expect(value.engine.transcribe).toHaveBeenCalledOnce());
  value.finish.mockImplementation(async ({ action }) => {
    if (action === 'send') {
      value.pcm({ seconds: 0.25 });
    }
  });
  value.engine.cancel.mockClear();
  const stopping = value.controller.stop();
  await vi.waitFor(() => expect(value.controller.getState().phase).toBe('finishing'));
  result.resolve({ text: 'old prefix', languages: [], status: 'complete' });
  await stopping;
  expect(value.engine.transcribe.mock.calls.map(([args]) => args.samples.length)).toEqual([16000, 20000]);
  expect(value.controller.getState()).toMatchObject({ phase: 'complete', confirmedText: 'こんにちは', recordedSeconds: 1.25 });
  expect(value.engine.cancel).not.toHaveBeenCalled();
});

it('automatically stops and flushes when recognition cannot keep up', async () => {
  await using value = fixture();
  await value.load();
  await value.controller.start({ language: undefined, maxRegionSeconds: transcriptionRegionSeconds });
  const first = Promise.withResolvers<SpeechRecognitionResult>();
  value.engine.transcribe.mockReturnValueOnce(first.promise);
  value.pcm({ seconds: 8 });
  await vi.waitFor(() => expect(value.engine.transcribe).toHaveBeenCalledOnce());
  value.pcm({ seconds: 37 });
  await vi.waitFor(() => expect(value.finish).toHaveBeenCalledWith({ action: 'send' }));
  expect(value.controller.getState()).toMatchObject({ phase: 'finishing', stopReason: 'backpressure' });
  first.resolve({ text: 'first', languages: [], status: 'complete' });
  await vi.waitFor(() => expect(value.controller.getState().phase).toBe('complete'));
  expect(value.controller.getState()).toMatchObject({ bufferedSeconds: 0, confirmedRevision: Math.ceil(45 / transcriptionRegionSeconds), recordedSeconds: 45 });
});

it('stops capture and preserves native failure details without confirming its partial text', async () => {
  await using value = fixture();
  await value.load();
  await value.controller.start({ language: undefined, maxRegionSeconds: transcriptionRegionSeconds });
  const failure = { code: 'runtime_failed' as const, message: 'native failure', nativeStatus: -7, nativeInput: 'audio' };
  value.engine.transcribe.mockRejectedValueOnce(new SpeechRuntimeError({ details: failure }));
  value.pcm({ seconds: 1 });
  await vi.waitFor(() => expect(value.controller.getState().phase).toBe('failed'));
  expect(value.finish).toHaveBeenCalledWith({ action: 'discard' });
  expect(value.capture.mock.calls[0]![0].signal.aborted).toBe(true);
  expect(value.controller.getState()).toMatchObject({ confirmedText: '', failure, bufferedSeconds: 0, pendingRegionCount: 0 });
});

it('stops an invalid microphone source before it can be recognized', async () => {
  await using value = fixture();
  await value.load();
  await value.controller.start({ language: undefined, maxRegionSeconds: transcriptionRegionSeconds });
  value.capture.mock.calls[0]![0].onPcm({ pcm: new Float32Array([Number.POSITIVE_INFINITY]) });
  expect(value.controller.getState()).toMatchObject({ phase: 'failed', failure: { code: 'invalid_audio' } });
  expect(value.finish).toHaveBeenCalledWith({ action: 'discard' });
});

it('discards pending microphone permission promptly and closes a late handle', async () => {
  await using value = fixture();
  await value.load();
  const opened = Promise.withResolvers<LiveCapture>();
  value.capture.mockReturnValueOnce(opened.promise);
  const starting = value.controller.start({ language: undefined, maxRegionSeconds: transcriptionRegionSeconds });
  await vi.waitFor(() => expect(value.controller.getState().phase).toBe('opening'));
  await value.controller.discard();
  await starting;
  expect(value.controller.getState().phase).toBe('idle');
  opened.resolve({ finish: value.finish });
  await vi.waitFor(() => expect(value.finish).toHaveBeenCalledWith({ action: 'discard' }));
});

it('ignores old recognition results and PCM callbacks after discard and a new session', async () => {
  await using value = fixture();
  await value.load();
  await value.controller.start({ language: undefined, maxRegionSeconds: transcriptionRegionSeconds });
  const oldPcm = value.capture.mock.calls[0]![0].onPcm;
  const result = Promise.withResolvers<SpeechRecognitionResult>();
  value.engine.transcribe.mockReturnValueOnce(result.promise);
  value.pcm({ seconds: 1 });
  await vi.waitFor(() => expect(value.engine.transcribe).toHaveBeenCalledOnce());
  const discarded = value.controller.discard();
  result.resolve({ text: 'old session', languages: [], status: 'complete' });
  await discarded;
  await value.controller.start({ language: 'en', maxRegionSeconds: transcriptionRegionSeconds });
  oldPcm({ pcm: new Float32Array(16000) });
  value.pcm({ seconds: 1 });
  await value.controller.stop();
  expect(value.controller.getState()).toMatchObject({ confirmedText: 'こんにちは', recordedSeconds: 1, confirmedRevision: 1 });
});

it('keeps new microphone starts disabled until old capture cleanup has finished', async () => {
  await using value = fixture();
  await value.load();
  await value.controller.start({ language: undefined, maxRegionSeconds: transcriptionRegionSeconds });
  const cleaned = Promise.withResolvers<void>();
  value.finish.mockReturnValueOnce(cleaned.promise);
  const discarded = value.controller.discard();
  await value.controller.start({ language: 'en', maxRegionSeconds: transcriptionRegionSeconds });
  expect(value.capture).toHaveBeenCalledOnce();
  cleaned.resolve();
  await discarded;
  await value.controller.start({ language: 'en', maxRegionSeconds: transcriptionRegionSeconds });
  expect(value.capture).toHaveBeenCalledTimes(2);
});

it('does not let superseded capture cleanup cancel a subsequent file run', async () => {
  await using value = fixture();
  await value.load();
  await value.controller.start({ language: undefined, maxRegionSeconds: transcriptionRegionSeconds });
  const cleaned = Promise.withResolvers<void>();
  const recognized = Promise.withResolvers<SpeechRecognitionResult>();
  value.finish.mockReturnValueOnce(cleaned.promise);
  const discarded = value.controller.discard();
  value.engine.transcribe.mockReturnValueOnce(recognized.promise);
  const fileRun = value.controller.runFile({ file: new File(['data'], 'new.wav'), language: undefined });
  await vi.waitFor(() => expect(value.engine.transcribe).toHaveBeenCalledOnce());
  value.engine.cancel.mockClear();
  cleaned.resolve();
  await discarded;
  expect(value.engine.cancel).not.toHaveBeenCalled();
  recognized.resolve({ text: 'new file', languages: [], status: 'complete' });
  await fileRun;
  expect(value.controller.getState()).toMatchObject({ phase: 'complete', confirmedText: 'new file' });
});

it('reuses the audio/video decoder and resident recognizer for files', async () => {
  await using value = fixture();
  await value.load();
  const file = new File(['container'], 'clip.webm', { type: 'video/webm' });
  await value.controller.runFile({ file, language: 'ja' });
  expect(value.decodeFile).toHaveBeenCalledWith({ file, sampleRate: 16000, signal: expect.any(AbortSignal) });
  expect(value.capture).not.toHaveBeenCalled();
  expect(value.controller.getState()).toMatchObject({ phase: 'complete', confirmedText: 'こんにちは', provisionalText: '', confirmedRevision: 1, recordedSeconds: 1 });
});

it('keeps limited file output provisional and reports the incomplete run', async () => {
  await using value = fixture();
  await value.load();
  value.engine.transcribe.mockResolvedValueOnce({ text: 'partial file', languages: [], status: 'model_limit' });
  await value.controller.runFile({ file: new File(['data'], 'clip.wav'), language: undefined });
  expect(value.controller.getState()).toMatchObject({ phase: 'failed', confirmedText: '', provisionalText: 'partial file', confirmedRevision: 0, failure: { code: 'runtime_failed' } });
});

it('cancels file decode promptly on discard and ignores late decoded samples', async () => {
  await using value = fixture();
  await value.load();
  const decoded = Promise.withResolvers<Float32Array<ArrayBuffer>>();
  value.decodeFile.mockReturnValueOnce(decoded.promise);
  const task = value.controller.runFile({ file: new File(['data'], 'clip.wav'), language: undefined });
  await vi.waitFor(() => expect(value.decodeFile).toHaveBeenCalledOnce());
  await value.controller.discard();
  await task;
  decoded.resolve(new Float32Array(16000));
  await Promise.resolve();
  expect(value.engine.transcribe).not.toHaveBeenCalled();
  expect(value.controller.getState()).toMatchObject({ phase: 'idle', confirmedText: '', provisionalText: '' });
});
