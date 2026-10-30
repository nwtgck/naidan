import { onScopeDispose, shallowRef } from 'vue';
import { llamaCppBrowserService } from '@/features/llama-cpp-browser';
import { createLiveController, type LiveViewState } from '@/features/live-conversation/logic/controller';
import { openLiveCapture } from '@/features/live-conversation/logic/audio-capture';
import { createLivePlayback } from '@/features/live-conversation/logic/audio-playback';
import { openLiveWesh } from '@/features/live-conversation/logic/wesh';

export function useLiveConversation() {
  const state = shallowRef<LiveViewState>({ phase: 'idle', info: undefined, entries: [], pendingTools: [], failure: undefined, playing: false });
  const controller = createLiveController({
    engine: llamaCppBrowserService,
    capture: openLiveCapture,
    playback: createLivePlayback,
    wesh: openLiveWesh,
    onChange: ({ state: next }) => {
      state.value = next;
    },
  });
  onScopeDispose(() => {
    void controller.dispose().catch(() => {});
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
