import { onScopeDispose, shallowRef } from 'vue';
import { createSpeechRecognitionClient } from '@/features/speech-cpp-browser/recognition/worker/client';
import { decodeLiveAudioFile } from '@/features/live-conversation/logic/audio-file';
import { openLiveCapture } from '@/features/live-conversation/logic/audio-capture';
import { createAudioTranscriptionController, initialAudioTranscriptionState } from '@/features/audio-transcription/logic/transcription-controller';

export function useAudioTranscription() {
  const state = shallowRef(initialAudioTranscriptionState());
  const controller = createAudioTranscriptionController({
    createClient: createSpeechRecognitionClient,
    decodeFile: decodeLiveAudioFile,
    capture: openLiveCapture,
    now: () => performance.now(),
    onChange({ state: next }) {
      state.value = next;
    },
  });
  onScopeDispose(() => {
    void controller.dispose();
  });
  return {
    state,
    controller,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
        // ESLint-required for useXxx return objects.
      },
    }) || {}),
  };
}

export const TEST_ONLY = {
};
