import { onScopeDispose, shallowRef } from 'vue';
import { openLiveCapture } from '@/features/live-conversation/logic/audio-capture';
import { createSpeechRecognitionRecording, initialSpeechRecordingState } from '@/features/live-conversation/logic/speech-recognition-recording';

/** A model-free source for the file-response pipeline. Stopping only readies
 * the existing WAV File; generation remains an explicit user action. */
export function useSpeechResponseRecording() {
  const recordingState = shallowRef(initialSpeechRecordingState());
  const recorder = createSpeechRecognitionRecording({
    capture: openLiveCapture,
    now: () => performance.now(),
    onChange({ state }) {
      recordingState.value = state;
    },
    onRecorded: async () => undefined,
  });
  const recording = {
    start: () => recorder.start({ language: undefined }),
    stop: recorder.stop,
    discard: recorder.discard,
  };
  onScopeDispose(() => {
    void recorder.dispose().catch(() => {});
  });
  return { recordingState, recording, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) };
}

export const TEST_ONLY = {
};
