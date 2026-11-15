import { onScopeDispose, shallowRef } from 'vue';
import { createSpeechClient } from '@/features/speech-cpp-browser/worker/client';
import { createLiveSpeechController, initialLiveSpeechState } from '@/features/live-conversation/logic/speech-controller';
import { openLiveCapture } from '@/features/live-conversation/logic/audio-capture';
import { createLivePlayback } from '@/features/live-conversation/logic/audio-playback';

export function useLiveSpeechConversation() {
  const state = shallowRef(initialLiveSpeechState());
  const controller = createLiveSpeechController({
    createClient: createSpeechClient,
    capture: openLiveCapture,
    playback: createLivePlayback,
    onChange: ({ state: next }) => {
      state.value = next;
    },
  });
  state.value = controller.getState();
  onScopeDispose(() => {
    void controller.dispose().catch(() => {});
  });
  return { controller, state, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) };
}

export const TEST_ONLY = {
};
