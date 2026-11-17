import { computed, onScopeDispose, readonly, ref, shallowRef, watch, type Ref } from 'vue';
import { awaitInspection } from '@/logic/model-file-inspection/abort';
import { SpeechRuntimeError, speechError, speechFailure, type SpeechFailure } from '@/features/speech-cpp-browser/types';
import { useAudioTranscription } from './useAudioTranscription';
import type { useAudioTranscriptionModels } from './useAudioTranscriptionModels';

type InputSource = 'microphone' | 'file';
type ModelSelection = {
  openSelected: ReturnType<typeof useAudioTranscriptionModels>['openSelected'],
  selectedId: Readonly<Ref<string | undefined>>,
  selectedQuantizationId: Readonly<Ref<string | undefined>>,
};

/** Connect recognition to the editable document without making that document
 * a mirror of the backend's replaceable and resettable recognition state. */
export function useAudioTranscriptionWorkflow({ source, text, autoCopy, models, language }: {
  source: Readonly<Ref<InputSource>>,
  text: Ref<string>,
  autoCopy: Readonly<Ref<'enabled' | 'disabled'>>,
  models: ModelSelection,
  language: Readonly<Ref<string | undefined>>,
}) {
  const { state, controller } = useAudioTranscription();
  type Preparation = { generation: number, controller: AbortController, source: InputSource, stage: 'opening_model' | 'loading_model' };
  const preparing = shallowRef<Preparation>();
  const activeSource = ref<InputSource>();
  const cleaning = ref(false);
  const localFailure = shallowRef<SpeechFailure>();
  const clipboardError = ref<string>();
  let disposed = false, generation = 0, clipboardGeneration = 0;
  let cleanup: Promise<void> | undefined;
  let resident: { modelId: string, quantizationId: string | undefined, name: string, bytes: number, modified: number } | undefined;
  let lastConfirmed = state.value.confirmedText;
  let lastRevision = state.value.confirmedRevision;
  let clipboardWriting = false;
  let clipboardQueued: { generation: number, text: string } | undefined;
  let copiedText: string | undefined;

  const phase = computed<'idle' | 'preparing' | 'recording' | 'paused' | 'finishing'>(() => {
    if (preparing.value !== undefined) {
      return 'preparing';
    }
    if (cleaning.value) {
      return 'finishing';
    }
    if (activeSource.value === undefined) {
      return 'idle';
    }
    const value = state.value.phase;
    switch (value) {
    case 'opening': return 'preparing';
    case 'recording': return 'recording';
    case 'paused': return 'paused';
    case 'finishing': return 'finishing';
    case 'idle': case 'complete': case 'failed': return 'idle';
    default: {
      const exhaustive: never = value;
      throw new Error(String(exhaustive));
    }
    }
  });
  const pending = computed(() => phase.value === 'preparing' || phase.value === 'finishing');
  const runtimeState = computed(() => state.value.runtime);
  const provisionalText = computed(() => state.value.provisionalText);
  const failureDetails = computed(() => {
    const failure = localFailure.value ?? state.value.failure ?? state.value.runtime.failure;
    if (failure === undefined) {
      return undefined;
    }
    return [failure.message, failure.nativeStatus === undefined ? undefined : `nativeStatus=${failure.nativeStatus}`, failure.nativeInput === undefined ? undefined : `nativeInput=${failure.nativeInput}`].filter(value => value !== undefined).join('\n');
  });

  function invalidateClipboard(): void {
    clipboardGeneration++;
    clipboardQueued = undefined;
    copiedText = undefined;
  }
  function canAutoCopy(): boolean {
    return !disposed && source.value === 'microphone' && activeSource.value === 'microphone' && autoCopy.value === 'enabled';
  }
  function combineText({ confirmed, provisional }: { confirmed: string, provisional: string }): string {
    return confirmed === '' ? provisional : provisional === '' ? confirmed : `${confirmed}${confirmed.endsWith('\n') || provisional.startsWith('\n') ? '' : '\n'}${provisional}`;
  }
  async function drainClipboard(): Promise<void> {
    if (clipboardWriting) {
      return;
    }
    clipboardWriting = true;
    try {
      while (clipboardQueued !== undefined) {
        const next = clipboardQueued;
        clipboardQueued = undefined;
        if (!canAutoCopy() || next.generation !== clipboardGeneration || next.text === copiedText) {
          continue;
        }
        try {
          // Keep one native clipboard promise and one latest pending value.
          // No focus wait, permission prompt, timer or promise chain accumulates.
          await navigator.clipboard.writeText(next.text);
          if (!disposed && next.generation === clipboardGeneration) {
            copiedText = next.text;
            clipboardError.value = undefined;
          }
        } catch (error) {
          if (!disposed && next.generation === clipboardGeneration) {
            clipboardError.value = error instanceof Error || error instanceof DOMException ? error.message : String(error);
          }
        }
      }
    } finally {
      clipboardWriting = false;
    }
  }
  watch(() => [state.value.confirmedText, state.value.confirmedRevision, state.value.provisionalText] as const, ([confirmed, revision, provisional], previous) => {
    const delta = revision >= lastRevision && confirmed.startsWith(lastConfirmed) ? confirmed.slice(lastConfirmed.length) : confirmed;
    lastConfirmed = confirmed;
    lastRevision = revision;
    if (delta !== '') {
      text.value = combineText({ confirmed: text.value, provisional: delta });
    }
    if (canAutoCopy() && (delta !== '' || provisional !== '' && provisional !== previous[2])) {
      const value = combineText({ confirmed: text.value, provisional });
      if (value !== '') {
        clipboardQueued = { generation: clipboardGeneration, text: value };
        void drainClipboard();
      }
    }
  }, { flush: 'sync' });
  watch(autoCopy, invalidateClipboard, { flush: 'sync' });

  function isCurrent({ preparation }: { preparation: Preparation }): boolean {
    return !disposed && preparing.value === preparation && generation === preparation.generation && !preparation.controller.signal.aborted && source.value === preparation.source;
  }
  function beginCleanup({ task }: { task: Promise<void> }): Promise<void> {
    const attempt = generation;
    const current = task.catch(error => {
      if (!disposed && generation === attempt) {
        localFailure.value = speechFailure({ error });
      }
    }).finally(() => {
      if (cleanup === current) {
        cleanup = undefined;
        cleaning.value = false;
      }
    });
    cleanup = current;
    cleaning.value = true;
    return current;
  }
  async function cancelPreparation(): Promise<void> {
    const previous = preparing.value;
    if (previous === undefined) {
      const value = state.value.phase;
      switch (value) {
      case 'opening': await stop();
        break;
      case 'finishing':
        {
          const attempt = ++generation;
          invalidateClipboard();
          await beginCleanup({ task: controller.discard() });
          if (!disposed && generation === attempt) {
            activeSource.value = undefined;
          }
        }
        break;
      case 'idle': case 'recording': case 'paused': case 'complete': case 'failed': break;
      default: {
        const exhaustive: never = value;
        throw new Error(String(exhaustive));
      }
      }
      return;
    }
    generation++;
    previous.controller.abort();
    preparing.value = undefined;
    invalidateClipboard();
    switch (previous.stage) {
    case 'loading_model':
      resident = undefined;
      await beginCleanup({ task: controller.release() });
      break;
    case 'opening_model': break;
    default: {
      const exhaustive: never = previous.stage;
      throw new Error(String(exhaustive));
    }
    }
  }
  async function run({ inputSource, file, resume }: { inputSource: InputSource, file: File | undefined, resume: 'resume' | 'start' }): Promise<void> {
    if (disposed || pending.value || phase.value === 'recording' || source.value !== inputSource) {
      return;
    }
    const capability = controller.capability;
    switch (capability.kind) {
    case 'available': break;
    case 'unavailable':
      localFailure.value = speechFailure({ error: speechError({ code: 'unavailable', message: `Audio transcription is unavailable: ${capability.reason}` }) });
      return;
    default: {
      const exhaustive: never = capability;
      throw new Error(String(exhaustive));
    }
    }
    const preparation: Preparation = { generation: ++generation, controller: new AbortController(), source: inputSource, stage: 'opening_model' };
    const selectedId = models.selectedId.value, quantizationId = models.selectedQuantizationId.value, requestedLanguage = language.value;
    preparing.value = preparation;
    localFailure.value = undefined;
    clipboardError.value = undefined;
    invalidateClipboard();
    try {
      const opened = await awaitInspection({ task: models.openSelected({ signal: preparation.controller.signal }), signal: preparation.controller.signal });
      if (!isCurrent({ preparation })) {
        return;
      }
      if (models.selectedId.value !== selectedId || quantizationId !== undefined && models.selectedQuantizationId.value !== quantizationId) {
        throw new Error('The selected recognition model changed while it was opening');
      }
      const selectedQuantizationId = models.selectedQuantizationId.value;
      const current = resident;
      if (current === undefined || current.modelId !== opened.modelId || current.quantizationId !== selectedQuantizationId || current.name !== opened.file.name || current.bytes !== opened.file.size || current.modified !== opened.file.lastModified || state.value.runtime.phase !== 'ready' || state.value.runtime.model === undefined) {
        preparation.stage = 'loading_model';
        await controller.load({ file: opened.file });
        if (!isCurrent({ preparation })) {
          return;
        }
        const failure = state.value.failure ?? state.value.runtime.failure;
        if (state.value.runtime.phase !== 'ready' || state.value.runtime.model === undefined) {
          throw failure === undefined ? new Error('The recognition model did not become ready') : new SpeechRuntimeError({ details: failure });
        }
        resident = { modelId: opened.modelId, quantizationId: selectedQuantizationId, name: opened.file.name, bytes: opened.file.size, modified: opened.file.lastModified };
      }
      preparing.value = undefined;
      activeSource.value = inputSource;
      switch (inputSource) {
      case 'microphone':
        switch (resume) {
        case 'resume': await controller.resume({ language: requestedLanguage });
          break;
        case 'start': await controller.start({ language: requestedLanguage });
          break;
        default: {
          const exhaustive: never = resume;
          throw new Error(String(exhaustive));
        }
        }
        break;
      case 'file':
        if (file === undefined) {
          throw new Error('Choose an audio or video file');
        }
        await controller.runFile({ file, language: requestedLanguage });
        break;
      default: {
        const exhaustive: never = inputSource;
        throw new Error(String(exhaustive));
      }
      }
    } catch (error) {
      if (!disposed && generation === preparation.generation && !preparation.controller.signal.aborted) {
        localFailure.value = speechFailure({ error });
      }
    } finally {
      if (preparing.value === preparation) {
        preparing.value = undefined;
      }
    }
  }
  async function stop(): Promise<void> {
    if (preparing.value !== undefined) {
      const attempt = generation;
      await cancelPreparation();
      if (!disposed && generation === attempt + 1) {
        activeSource.value = undefined;
      }
      return;
    }
    if (cleanup !== undefined) {
      await cleanup;
      return;
    }
    const attempt = ++generation;
    const task = (() => {
      const value = activeSource.value;
      switch (value) {
      case 'file': return controller.discard();
      case 'microphone': case undefined: return controller.stop();
      default: {
        const exhaustive: never = value;
        throw new Error(String(exhaustive));
      }
      }
    })();
    await beginCleanup({ task });
    if (!disposed && generation === attempt) {
      activeSource.value = undefined;
    }
  }
  watch(source, () => {
    invalidateClipboard();
    void stop();
  }, { flush: 'sync' });
  onScopeDispose(() => {
    disposed = true;
    generation++;
    preparing.value?.controller.abort();
    preparing.value = undefined;
    invalidateClipboard();
    // useAudioTranscription owns physical worker/capture disposal in this scope.
  });

  return {
    phase,
    pending,
    state,
    runtimeState,
    provisionalText,
    failureDetails,
    clipboardError: readonly(clipboardError),
    clearClipboardError() {
      clipboardError.value = undefined;
    },
    start: () => run({ inputSource: 'microphone', file: undefined, resume: 'start' }),
    stop,
    async pauseOrResume(): Promise<void> {
      switch (phase.value) {
      case 'recording': await controller.pause();
        break;
      case 'paused': await run({ inputSource: 'microphone', file: undefined, resume: 'resume' });
        break;
      case 'idle': case 'preparing': case 'finishing': break;
      default: {
        const exhaustive: never = phase.value;
        throw new Error(String(exhaustive));
      }
      }
    },
    transcribeFile: ({ file }: { file: File }) => run({ inputSource: 'file', file, resume: 'start' }),
    cancelPreparation,
    ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
  };
}

export const TEST_ONLY = {
};
