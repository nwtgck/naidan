import { computed, readonly, ref, shallowRef, type ShallowRef } from 'vue';
import { useSettings } from '@/composables/useSettings';
import { useToast } from '@/composables/useToast';
import { ensureStrings } from '@/strings';
import type { Settings } from '@/01-models/types';
import { microphoneSegmentSeconds } from '@/features/audio-transcription/logic/continuous-transcription';

const saving = ref(false);
let saveTail = Promise.resolve();
type TranscriptionPreferences = NonNullable<NonNullable<Settings['experimental']>['audioTranscription']>;
type PendingPreference<T> = { value: T, isCurrent: () => boolean };

export function useAudioTranscriptionPreferences() {
  const { settings, captureExperimentalStorage, updateExperimentalForStorage } = useSettings();
  const { addToast } = useToast();
  const autoCopy = computed(() => settings.value.experimental?.audioTranscription?.microphoneAutoCopy ?? 'disabled');
  const modelId = computed(() => settings.value.experimental?.audioTranscription?.modelId);
  const modelAutoLoad = computed(() => settings.value.experimental?.audioTranscription?.modelAutoLoad ?? 'enabled');
  const pendingLanguage = shallowRef<PendingPreference<NonNullable<TranscriptionPreferences['recognitionLanguage']>>>();
  const pendingSegmentSeconds = shallowRef<PendingPreference<number>>();
  const recognitionLanguage = computed(() => {
    const saved = settings.value.experimental?.audioTranscription?.recognitionLanguage ?? 'auto';
    const pending = pendingLanguage.value;
    return pending?.isCurrent() ? pending.value : saved;
  });
  const microphoneSegmentMaxSeconds = computed(() => {
    const saved = settings.value.experimental?.audioTranscription?.microphoneSegmentMaxSeconds;
    const pending = pendingSegmentSeconds.value;
    return microphoneSegmentSeconds({ stored: pending?.isCurrent() ? pending.value : saved });
  });

  function savePreference({ patch, isCurrent, loadFailureMessage }: { patch: TranscriptionPreferences, isCurrent: () => boolean, loadFailureMessage: () => Promise<string> }): Promise<void> {
    const save = saveTail.then(async () => {
      try {
        await updateExperimentalForStorage({
          isCurrent,
          updater: ({ experimental }) => ({ ...experimental, audioTranscription: { ...experimental?.audioTranscription, ...patch } }),
        });
      } catch {
        const message = await loadFailureMessage();
        if (isCurrent()) {
          addToast({ message });
        }
      }
    });
    saveTail = save.catch(() => {});
    return save;
  }

  async function updateAutoCopy({ value }: { value: 'enabled' | 'disabled' }): Promise<void> {
    if (saving.value) {
      return;
    }
    saving.value = true;
    try {
      await savePreference({
        patch: { microphoneAutoCopy: value },
        isCurrent: captureExperimentalStorage(),
        loadFailureMessage: () => ensureStrings.useAudioTranscriptionPreferences__could_not_save_auto_copy(),
      });
    } finally {
      saving.value = false;
    }
  }

  async function saveImmediatePreference<T>({ pending, value, patch, loadFailureMessage }: {
    pending: ShallowRef<PendingPreference<T> | undefined>,
    value: T,
    patch: TranscriptionPreferences,
    loadFailureMessage: () => Promise<string>,
  }): Promise<void> {
    const change = { value, isCurrent: captureExperimentalStorage() };
    pending.value = change;
    try {
      await savePreference({ patch, isCurrent: change.isCurrent, loadFailureMessage });
    } finally {
      if (pending.value === change) {
        pending.value = undefined;
      }
    }
  }

  return {
    autoCopy,
    saving: readonly(saving),
    updateAutoCopy,
    modelId,
    modelAutoLoad,
    recognitionLanguage,
    microphoneSegmentMaxSeconds,
    rememberModel: ({ modelId }: { modelId: string | undefined }) => savePreference({
      patch: { modelId },
      isCurrent: captureExperimentalStorage(),
      loadFailureMessage: () => ensureStrings.useAudioTranscriptionPreferences__could_not_save_model_selection(),
    }),
    updateRecognitionLanguage: ({ value }: { value: NonNullable<TranscriptionPreferences['recognitionLanguage']> }) => saveImmediatePreference({
      pending: pendingLanguage,
      value,
      patch: { recognitionLanguage: value },
      loadFailureMessage: () => ensureStrings.useAudioTranscriptionPreferences__could_not_save_recognition_language(),
    }),
    updateMicrophoneSegmentMaxSeconds: ({ seconds }: { seconds: number }) => saveImmediatePreference({
      pending: pendingSegmentSeconds,
      value: seconds,
      patch: { microphoneSegmentMaxSeconds: microphoneSegmentSeconds({ stored: seconds }) },
      loadFailureMessage: () => ensureStrings.useAudioTranscriptionPreferences__could_not_save_microphone_segment_length(),
    }),
    updateModelAutoLoad: ({ value }: { value: NonNullable<TranscriptionPreferences['modelAutoLoad']> }) => savePreference({
      patch: { modelAutoLoad: value },
      isCurrent: captureExperimentalStorage(),
      loadFailureMessage: () => ensureStrings.useAudioTranscriptionPreferences__could_not_save_model_auto_load(),
    }),
    ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
  };
}

export const TEST_ONLY = {
};
