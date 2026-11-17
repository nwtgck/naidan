import { expect, it, vi } from 'vitest';
import { effectScope, onScopeDispose, ref, shallowRef } from 'vue';
import { useAudioTranscriptionWorkflow } from './useAudioTranscriptionWorkflow';
import { useAudioTranscription } from './useAudioTranscription';
import { initialAudioTranscriptionState, type AudioTranscriptionState } from '@/features/audio-transcription/logic/transcription-controller';
import { initialContinuousAudioTranscriptionState, transcriptionRegionSeconds } from '@/features/audio-transcription/logic/continuous-transcription';
import { recognitionInfo } from '@/features/speech-cpp-browser/recognition/recognition.test-support';
import { initialSpeechRecognitionState } from '@/features/speech-cpp-browser/recognition/types';
import type { SpeechCapability } from '@/features/speech-cpp-browser/types';

vi.mock('./useAudioTranscription', () => ({ useAudioTranscription: vi.fn() }));

function fixture() {
  const state = shallowRef(initialAudioTranscriptionState());
  const capability = shallowRef<SpeechCapability>({ kind: 'available' });
  function change({ value }: { value: Partial<AudioTranscriptionState> }): void {
    state.value = { ...state.value, ...value };
  }
  const controller = {
    get capability() {
      return capability.value;
    },
    getState: () => state.value,
    load: vi.fn<ReturnType<typeof useAudioTranscription>['controller']['load']>(async () => {
      change({ value: { ...initialContinuousAudioTranscriptionState(), phase: 'idle', runtime: { ...initialSpeechRecognitionState(), phase: 'ready', model: recognitionInfo } } });
    }),
    start: vi.fn<ReturnType<typeof useAudioTranscription>['controller']['start']>(async () => change({ value: { phase: 'recording', failure: undefined } })),
    resume: vi.fn<ReturnType<typeof useAudioTranscription>['controller']['resume']>(async () => change({ value: { phase: 'recording', failure: undefined } })),
    stop: vi.fn(async () => change({ value: { phase: 'complete' } })),
    pause: vi.fn(async () => change({ value: { phase: 'paused' } })),
    clearText: vi.fn(() => change({ value: { confirmedText: '', confirmedRevision: 0, provisionalText: '' } })),
    discard: vi.fn(async () => change({ value: { ...initialContinuousAudioTranscriptionState(), phase: 'idle' } })),
    release: vi.fn(async () => change({ value: { ...initialAudioTranscriptionState() } })),
    runFile: vi.fn<ReturnType<typeof useAudioTranscription>['controller']['runFile']>(async () => {
      change({ value: { ...initialContinuousAudioTranscriptionState(), phase: 'finishing' } });
      change({ value: { phase: 'complete', confirmedText: 'file result', confirmedRevision: 1 } });
    }),
    dispose: vi.fn(async () => {}),
  };
  vi.mocked(useAudioTranscription).mockImplementation(() => {
    onScopeDispose(() => {
      void controller.dispose();
    });
    return { state, controller, TEST_ONLY: {} };
  });
  const source = ref<'microphone' | 'file'>('microphone');
  const text = ref(''), autoCopy = ref<'enabled' | 'disabled'>('disabled'), language = ref<string | undefined>('ja');
  const file = new File(['model'], 'recognizer.gguf', { lastModified: 1 });
  const openSelected = vi.fn<Parameters<typeof useAudioTranscriptionWorkflow>[0]['models']['openSelected']>(async () => ({ modelId: 'recognizer:Q8_0', file }));
  const openSelectedLocal = vi.fn<Parameters<typeof useAudioTranscriptionWorkflow>[0]['models']['openSelectedLocal']>(async () => ({ modelId: 'recognizer:Q8_0', file }));
  const models = { openSelected, openSelectedLocal, selectedId: ref<string | undefined>('recognizer'), selectedQuantizationId: ref<string | undefined>('Q8_0') };
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const scope = effectScope();
  const microphoneSegmentMaxSeconds = ref(transcriptionRegionSeconds);
  const api = scope.run(() => useAudioTranscriptionWorkflow({ source, text, autoCopy, models, language, microphoneSegmentMaxSeconds, getClipboardWindow: () => window }))!;
  return {
    api,
    controller,
    state,
    capability,
    change,
    source,
    text,
    autoCopy,
    language,
    microphoneSegmentMaxSeconds,
    models,
    file,
    writeText,
    [Symbol.dispose]() {
      scope.stop();
      if (clipboardDescriptor === undefined) {
        Reflect.deleteProperty(navigator, 'clipboard');
      } else {
        Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
      }
    },
  };
}

it('opens the selected model, loads it, and snapshots the requested language before preparation awaits', async () => {
  using value = fixture();
  const opened = Promise.withResolvers<{ modelId: string, file: File }>();
  value.models.openSelected.mockReturnValueOnce(opened.promise);
  const starting = value.api.start();
  expect(value.api.phase.value).toBe('preparing');
  expect(value.api.pending.value).toBe(true);
  value.language.value = 'en';
  opened.resolve({ modelId: 'recognizer:Q8_0', file: value.file });
  await starting;
  expect(value.controller.load).toHaveBeenCalledExactlyOnceWith({ file: value.file });
  expect(value.controller.start).toHaveBeenCalledExactlyOnceWith({ language: 'ja', maxRegionSeconds: transcriptionRegionSeconds });
  expect(value.api.phase.value).toBe('recording');
});

it('reports an unavailable runtime before opening or downloading a model for microphone or file input', async () => {
  using value = fixture();
  value.capability.value = { kind: 'unavailable', reason: 'standalone' };
  await value.api.start();
  expect(value.api.failureDetails.value).toBe('Audio transcription is unavailable: standalone');
  expect(value.api.phase.value).toBe('idle');
  value.source.value = 'file';
  await vi.waitFor(() => expect(value.api.pending.value).toBe(false));
  await value.api.transcribeFile({ file: new File(['audio'], 'input.wav') });
  expect(value.models.openSelected).not.toHaveBeenCalled();
  expect(value.controller.load).not.toHaveBeenCalled();
  expect(value.controller.start).not.toHaveBeenCalled();
  expect(value.controller.runFile).not.toHaveBeenCalled();
});

it('reuses one resident model for new input, pause/resume and file recognition', async () => {
  using value = fixture();
  await value.api.start();
  await value.api.pauseOrResume();
  expect(value.api.phase.value).toBe('paused');
  await value.api.pauseOrResume();
  expect(value.controller.resume).toHaveBeenCalledExactlyOnceWith({ language: 'ja', maxRegionSeconds: transcriptionRegionSeconds });
  await value.api.stop();
  await value.api.start();
  await value.api.stop();
  value.source.value = 'file';
  await vi.waitFor(() => expect(value.api.pending.value).toBe(false));
  const file = new File(['container'], 'recording.webm', { type: 'video/webm' });
  await value.api.transcribeFile({ file });
  expect(value.controller.load).toHaveBeenCalledOnce();
  expect(value.controller.start).toHaveBeenCalledTimes(2);
  expect(value.controller.runFile).toHaveBeenCalledExactlyOnceWith({ file, language: 'ja' });
});

it('reloads when the quantization changes even if the selector entry and returned model ID stay the same', async () => {
  using value = fixture();
  await value.api.start();
  await value.api.stop();
  value.models.selectedQuantizationId.value = 'Q4_K_M';
  await value.api.start();
  expect(value.controller.load).toHaveBeenCalledTimes(2);
});

it('reloads changed model file snapshots instead of trusting a selector entry alone', async () => {
  using value = fixture();
  await value.api.start();
  await value.api.stop();
  value.models.openSelected.mockResolvedValueOnce({ modelId: 'recognizer:Q8_0', file: new File(['updated'], 'recognizer.gguf', { lastModified: 2 }) });
  await value.api.start();
  expect(value.controller.load).toHaveBeenCalledTimes(2);
});

it('appends only new confirmed regions, protects manual edits and keeps provisional revisions separate', async () => {
  using value = fixture();
  await value.api.start();
  value.change({ value: { provisionalText: 'draft' } });
  expect(value.text.value).toBe('');
  expect(value.api.provisionalText.value).toBe('draft');
  value.change({ value: { confirmedText: 'first', confirmedRevision: 1, provisionalText: '' } });
  value.text.value = 'edited first';
  value.change({ value: { provisionalText: 'second draft' } });
  value.change({
    value: {
      confirmedText: `\
first
second`,
      confirmedRevision: 2,
      provisionalText: '',
    },
  });
  expect(value.text.value).toBe(`\
edited first
second`);
  value.change({ value: { provisionalText: 'next draft' } });
  expect(value.text.value).toBe(`\
edited first
second`);
});

it('keeps the editor when backend text resets for a reload or file run', async () => {
  using value = fixture();
  await value.api.start();
  value.change({ value: { confirmedText: 'first', confirmedRevision: 1 } });
  value.text.value = 'edited document';
  await value.api.stop();
  value.models.selectedQuantizationId.value = 'Q4_K_M';
  await value.api.start();
  expect(value.text.value).toBe('edited document');
  value.change({ value: { confirmedText: 'new recognition', confirmedRevision: 1 } });
  expect(value.text.value).toBe(`\
edited document
new recognition`);
});

it('copies microphone recognition updates only, and never reacts to manual editor input or enabling alone', async () => {
  using value = fixture();
  await value.api.start();
  value.change({ value: { provisionalText: 'not copied' } });
  expect(value.writeText).not.toHaveBeenCalled();
  value.autoCopy.value = 'enabled';
  value.text.value = 'manual editor text';
  expect(value.writeText).not.toHaveBeenCalled();
  value.change({ value: { provisionalText: 'recognized words' } });
  await vi.waitFor(() => expect(value.writeText).toHaveBeenCalledExactlyOnceWith(`\
manual editor text
recognized words`));
  value.text.value = 'manual change';
  expect(value.writeText).toHaveBeenCalledOnce();
});

it('does not copy file recognition or updates after automatic copy is disabled', async () => {
  using value = fixture();
  value.autoCopy.value = 'enabled';
  await value.api.start();
  value.autoCopy.value = 'disabled';
  value.change({ value: { confirmedText: 'first', confirmedRevision: 1 } });
  expect(value.writeText).not.toHaveBeenCalled();
  await value.api.stop();
  value.source.value = 'file';
  await vi.waitFor(() => expect(value.api.pending.value).toBe(false));
  value.autoCopy.value = 'enabled';
  await value.api.transcribeFile({ file: new File(['audio'], 'input.wav') });
  expect(value.writeText).not.toHaveBeenCalled();
});

it('reports clipboard rejection while keeping recognition and edited text available', async () => {
  using value = fixture();
  value.autoCopy.value = 'enabled';
  value.writeText.mockRejectedValueOnce(new DOMException('Document is not focused', 'NotAllowedError'));
  await value.api.start();
  value.change({ value: { confirmedText: 'recognized', confirmedRevision: 1 } });
  await vi.waitFor(() => expect(value.api.clipboardError.value).toBe('interaction'));
  expect(value.text.value).toBe('recognized');
  expect(value.api.phase.value).toBe('recording');
  expect(value.controller.stop).not.toHaveBeenCalled();
  window.dispatchEvent(new MouseEvent('click'));
  await vi.waitFor(() => expect(value.api.clipboardError.value).toBeUndefined());
  expect(value.api.autoCopyCurrent.value).toBe(true);
  expect(value.writeText).toHaveBeenCalledTimes(2);
});

it('copies the visible transcript immediately when auto-copy is enabled from a gesture', async () => {
  using value = fixture();
  value.text.value = 'Edited words';
  value.change({ value: { provisionalText: 'Current draft' } });
  value.api.copyOnEnable();
  expect(value.writeText).toHaveBeenCalledExactlyOnceWith(['Edited words', 'Current draft'].join('\n'));
  value.autoCopy.value = 'enabled';
  await vi.waitFor(() => expect(value.api.autoCopyCurrent.value).toBe(true));
  value.api.clearText();
  expect(value.api.visibleText.value).toBe('');
  expect(value.writeText).toHaveBeenCalledOnce();
});

it('preloads a saved model without opening the microphone or requesting a download', async () => {
  using value = fixture();
  await value.api.preload();
  expect(value.controller.load).toHaveBeenCalledExactlyOnceWith({ file: value.file });
  expect(value.controller.start).not.toHaveBeenCalled();
  expect(value.models.openSelected).not.toHaveBeenCalled();
  await value.api.start();
  expect(value.controller.load).toHaveBeenCalledOnce();
  expect(value.controller.start).toHaveBeenCalledOnce();
});

it('uses the same local preload for file transcription and accepts a file while it is loading', async () => {
  using value = fixture();
  value.source.value = 'file';
  await vi.waitFor(() => expect(value.api.pending.value).toBe(false));
  const local = Promise.withResolvers<{ modelId: string, file: File }>();
  value.models.openSelectedLocal.mockReturnValueOnce(local.promise);
  const preload = value.api.preload();
  const file = new File(['audio'], 'speech.wav');
  const transcription = value.api.transcribeFile({ file });
  local.resolve({ modelId: 'recognizer:Q8_0', file: value.file });
  await preload;
  await transcription;
  expect(value.models.openSelected).not.toHaveBeenCalled();
  expect(value.controller.load).toHaveBeenCalledOnce();
  expect(value.controller.start).not.toHaveBeenCalled();
  expect(value.controller.runFile).toHaveBeenCalledExactlyOnceWith({ file, language: 'ja' });
});

it('starts voice input after the same preload finishes when Start is pressed during loading', async () => {
  using value = fixture();
  const local = Promise.withResolvers<{ modelId: string, file: File }>();
  value.models.openSelectedLocal.mockReturnValueOnce(local.promise);
  const preload = value.api.preload();
  expect(value.api.preloading.value).toBe(true);
  value.language.value = 'en';
  value.microphoneSegmentMaxSeconds.value = 20;
  const start = value.api.start();
  expect(value.api.preloading.value).toBe(false);
  local.resolve({ modelId: 'recognizer:Q8_0', file: value.file });
  await preload;
  await start;
  expect(value.models.openSelected).not.toHaveBeenCalled();
  expect(value.controller.load).toHaveBeenCalledOnce();
  expect(value.controller.start).toHaveBeenCalledExactlyOnceWith({ language: 'en', maxRegionSeconds: 20 });
});

it('does not start the microphone with an outdated model when selection changes during native loading', async () => {
  using value = fixture();
  const loading = Promise.withResolvers<void>();
  const finishLoading = value.controller.load.getMockImplementation();
  value.controller.load.mockImplementationOnce(async ({ file }) => {
    await loading.promise;
    await finishLoading?.({ file });
  });
  const preload = value.api.preload();
  await vi.waitFor(() => expect(value.controller.load).toHaveBeenCalledOnce());
  const start = value.api.start();
  value.models.selectedId.value = 'new-model';
  loading.resolve();
  await preload;
  await start;
  expect(value.controller.start).not.toHaveBeenCalled();
  expect(value.api.failureDetails.value).toContain('changed while it was loading');
});

it('bounds clipboard work to one native request and the latest pending text', async () => {
  using value = fixture();
  value.autoCopy.value = 'enabled';
  const copied = Promise.withResolvers<void>();
  value.writeText.mockReturnValueOnce(copied.promise);
  await value.api.start();
  value.change({ value: { provisionalText: 'first draft' } });
  value.change({ value: { provisionalText: 'second draft' } });
  value.change({ value: { provisionalText: 'latest draft' } });
  expect(value.writeText).toHaveBeenCalledExactlyOnceWith('first draft');
  copied.resolve();
  await vi.waitFor(() => expect(value.writeText).toHaveBeenCalledTimes(2));
  expect(value.writeText.mock.calls[1]).toEqual(['latest draft']);
});

it('copies the final transcript after recording stops even if a draft write is still pending', async () => {
  using value = fixture();
  value.autoCopy.value = 'enabled';
  const draftWrite = Promise.withResolvers<void>();
  value.writeText.mockReturnValueOnce(draftWrite.promise);
  await value.api.start();
  value.change({ value: { provisionalText: 'Draft' } });
  value.controller.stop.mockImplementationOnce(async () => {
    value.change({ value: { phase: 'complete', confirmedText: 'Final transcript', confirmedRevision: 1, provisionalText: '' } });
  });
  await value.api.stop();
  expect(value.api.phase.value).toBe('idle');
  expect(value.writeText).toHaveBeenCalledExactlyOnceWith('Draft');
  draftWrite.resolve();
  await vi.waitFor(() => expect(value.api.autoCopyCurrent.value).toBe(true));
  expect(value.writeText).toHaveBeenLastCalledWith('Final transcript');
});

it('aborts a download wait promptly and prevents late model load or capture', async () => {
  using value = fixture();
  const opened = Promise.withResolvers<{ modelId: string, file: File }>();
  value.models.openSelected.mockReturnValueOnce(opened.promise);
  const starting = value.api.start();
  await value.api.cancelPreparation();
  await starting;
  expect(value.models.openSelected.mock.calls[0]![0].signal.aborted).toBe(true);
  opened.resolve({ modelId: 'recognizer:Q8_0', file: value.file });
  await Promise.resolve();
  expect(value.controller.load).not.toHaveBeenCalled();
  expect(value.controller.start).not.toHaveBeenCalled();
  expect(value.api.phase.value).toBe('idle');
});

it('cancels an in-progress native load and never starts its late capture', async () => {
  using value = fixture();
  const loaded = Promise.withResolvers<void>();
  value.controller.load.mockImplementationOnce(async () => {
    value.change({ value: { runtime: { ...initialSpeechRecognitionState(), phase: 'loading_model' } } });
    await loaded.promise;
  });
  const starting = value.api.start();
  await vi.waitFor(() => expect(value.controller.load).toHaveBeenCalledOnce());
  await value.api.cancelPreparation();
  expect(value.controller.release).toHaveBeenCalledOnce();
  loaded.resolve();
  await starting;
  expect(value.controller.start).not.toHaveBeenCalled();
});

it('stops microphone input on source change, preserves final text and suppresses late automatic copy', async () => {
  using value = fixture();
  value.autoCopy.value = 'enabled';
  await value.api.start();
  value.controller.stop.mockImplementationOnce(async () => {
    value.change({ value: { phase: 'complete', confirmedText: 'last words', confirmedRevision: 1 } });
  });
  value.source.value = 'file';
  await vi.waitFor(() => expect(value.controller.stop).toHaveBeenCalledOnce());
  expect(value.text.value).toBe('last words');
  expect(value.writeText).not.toHaveBeenCalled();
});

it('invalidates pending preparation when switching input sources', async () => {
  using value = fixture();
  const opened = Promise.withResolvers<{ modelId: string, file: File }>();
  value.models.openSelected.mockReturnValueOnce(opened.promise);
  const starting = value.api.start();
  value.source.value = 'file';
  await starting;
  opened.resolve({ modelId: 'recognizer:Q8_0', file: value.file });
  await Promise.resolve();
  expect(value.controller.load).not.toHaveBeenCalled();
  expect(value.controller.start).not.toHaveBeenCalled();
});

it('leaves a paused microphone workflow when a pending resume is cancelled by a source change', async () => {
  using value = fixture();
  await value.api.start();
  await value.api.pauseOrResume();
  const opened = Promise.withResolvers<{ modelId: string, file: File }>();
  value.models.openSelected.mockReturnValueOnce(opened.promise);
  const resuming = value.api.pauseOrResume();
  value.source.value = 'file';
  await resuming;
  await vi.waitFor(() => expect(value.api.phase.value).toBe('idle'));
  opened.resolve({ modelId: 'recognizer:Q8_0', file: value.file });
  await Promise.resolve();
  expect(value.controller.resume).not.toHaveBeenCalled();
});

it('drops queued clipboard writes and late errors after switching sources', async () => {
  using value = fixture();
  value.autoCopy.value = 'enabled';
  await value.api.start();
  const copied = Promise.withResolvers<void>();
  value.writeText.mockReturnValueOnce(copied.promise);
  value.change({ value: { provisionalText: 'first draft' } });
  value.change({ value: { provisionalText: 'queued draft' } });
  value.source.value = 'file';
  copied.reject(new Error('late clipboard rejection'));
  await vi.waitFor(() => expect(value.api.pending.value).toBe(false));
  await Promise.resolve();
  expect(value.writeText).toHaveBeenCalledOnce();
  expect(value.api.clipboardError.value).toBeUndefined();
});

it('keeps a new run separate from a superseded finishing cleanup and its late failure', async () => {
  using value = fixture();
  await value.api.start();
  const stopped = Promise.withResolvers<void>();
  value.controller.stop.mockImplementationOnce(async () => {
    value.change({ value: { phase: 'finishing' } });
    await stopped.promise;
  });
  const stopping = value.api.stop();
  await value.api.cancelPreparation();
  await value.api.start();
  stopped.reject(new Error('superseded cleanup failed'));
  await stopping;
  expect(value.api.phase.value).toBe('recording');
  expect(value.api.failureDetails.value).toBeUndefined();
});

it('preserves native failure details when model loading fails', async () => {
  using value = fixture();
  const failure = { code: 'runtime_failed' as const, message: 'native model failed', nativeStatus: -5, nativeInput: 'weights' };
  value.controller.load.mockImplementationOnce(async () => {
    value.change({ value: { phase: 'failed', failure, runtime: { ...initialSpeechRecognitionState(), phase: 'failed', failure } } });
  });
  await value.api.start();
  expect(value.api.failureDetails.value).toBe(`\
native model failed
nativeStatus=-5
nativeInput=weights`);
  expect(value.controller.start).not.toHaveBeenCalled();
});

it('cancels a finishing file request explicitly without removing the edited document', async () => {
  using value = fixture();
  value.source.value = 'file';
  await vi.waitFor(() => expect(value.api.pending.value).toBe(false));
  value.text.value = 'existing document';
  const done = Promise.withResolvers<void>();
  value.controller.runFile.mockImplementationOnce(async () => {
    value.change({ value: { phase: 'finishing' } });
    await done.promise;
  });
  const running = value.api.transcribeFile({ file: new File(['data'], 'input.wav') });
  await vi.waitFor(() => expect(value.api.phase.value).toBe('finishing'));
  await value.api.cancelPreparation();
  expect(value.controller.discard).toHaveBeenCalledOnce();
  expect(value.text.value).toBe('existing document');
  done.resolve();
  await running;
});

it('aborts pending preparation on scope disposal and ignores its late completion', async () => {
  const value = fixture();
  const opened = Promise.withResolvers<{ modelId: string, file: File }>();
  value.models.openSelected.mockReturnValueOnce(opened.promise);
  const starting = value.api.start();
  value[Symbol.dispose]();
  await starting;
  opened.resolve({ modelId: 'recognizer:Q8_0', file: value.file });
  await Promise.resolve();
  expect(value.controller.dispose).toHaveBeenCalledOnce();
  expect(value.controller.load).not.toHaveBeenCalled();
  expect(value.controller.start).not.toHaveBeenCalled();
});
